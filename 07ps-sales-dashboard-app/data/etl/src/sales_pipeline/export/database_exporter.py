from __future__ import annotations

import logging
import hashlib
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Iterator
from decimal import Decimal, ROUND_HALF_UP

import numpy as np
import pandas as pd
from sqlalchemy import BigInteger, Boolean, Date, DateTime, Float, Integer, String, Text, create_engine, inspect, text
from sqlalchemy import bindparam
from sqlalchemy.dialects import mysql
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.sql.sqltypes import TypeEngine

from config.settings import Settings
from sales_pipeline.runtime import PipelineRunContext


@dataclass(frozen=True)
class SQLExportResult:
    table_counts: dict[str, int]
    validation: pd.DataFrame

    @property
    def mismatches(self) -> pd.DataFrame:
        if self.validation.empty:
            return self.validation
        return self.validation[~self.validation["Matches"]].copy()


class DatabaseExporter:
    RETIRED_FACT_TABLES = {"Fact_Pipeline", "Fact_PipelineFunnel", "Fact_PipelineEvents", "Fact_PipelineActivity"}
    STALE_CLEANUP_TABLES = {"Fact_Lead", "Fact_Opportunity"}
    WINDOW_DELETE_BATCH_SIZE = 5000
    WINDOW_DELETE_MAX_RETRIES = 3
    STRICT_INCREMENTAL_KEY_TABLES = {
        "Dim_Date",
        "Dim_Customer",
        "Dim_Salesperson",
        "Dim_SalesTeam",
        "Dim_Company",
        "Dim_Product",
        "Dim_DistributionChannel",
        "Dim_Segment",
        "Dim_Invoice",
        "Dim_CRMStage",
        "Dim_LostReason",
        "Fact_Lead",
        "Fact_Opportunity",
    }

    # Name of the MySQL advisory lock (GET_LOCK/RELEASE_LOCK) held for the duration of a SQL
    # table load. See _exclusive_run_lock for why this exists.
    PIPELINE_LOCK_NAME = "sales_pipeline_full_load"
    PIPELINE_LOCK_TIMEOUT_SECONDS = 30
    # Upper bound on how long the *holder's* connection may sit idle once GET_LOCK succeeds.
    # try/finally guarantees RELEASE_LOCK runs on any Python-level exception, but a hard process
    # kill (SIGKILL, OOM) skips Python entirely -- no finally runs, and the lock only goes away
    # once MySQL notices the TCP connection is gone, which can take far longer than this run ever
    # would (OS-level keepalive defaults are measured in hours). Capping this connection's own
    # wait_timeout means MySQL itself reaps it -- and releases the lock as a side effect -- well
    # before that, independent of the client-side crash ever being detected. 2h is generous headroom
    # over the ~30-60 minute runs this pipeline normally takes (see runPipelineJob.ts's comment).
    PIPELINE_LOCK_SESSION_MAX_SECONDS = 2 * 60 * 60

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.logger = logging.getLogger(__name__)
        self.engine = create_engine(settings.sqlalchemy_url, pool_pre_ping=True, future=True)

    @contextmanager
    def _exclusive_run_lock(self) -> Iterator[None]:
        """Serializes SQL table writes across every process that can start a pipeline run.

        Node's BullMQ queue (concurrency: 1, hasActiveEtlRun) and the Flask job_tracker
        (job_tracker.py's "only one job may be active" guard) each stop a *second run from that
        same entry point*, but neither guard is visible to the other, and neither is visible to a
        `python -m sales_pipeline.main` run started directly from a shell -- this pipeline has
        always been runnable standalone. None of those in-memory guards matter to MySQL: two
        overlapping full-mode exports racing their per-table TRUNCATE-then-INSERT sequences is
        exactly how a table ends up at 2x its row count (both runs' inserts land before either
        truncate) or short (one run's truncate fires while the other's chunked insert is still in
        flight when the count is read) -- the exact shapes of SQL row-count validation failures
        this closes off. A MySQL named lock is server-side and visible to every connection
        regardless of process/host, so it closes that gap completely instead of adding yet another
        in-memory guard.

        Non-MySQL engines (sqlite in tests) have no GET_LOCK/RELEASE_LOCK and don't need this --
        those callers are single-process already.
        """
        if self.engine.dialect.name != "mysql":
            yield
            return
        conn = self.engine.connect()
        try:
            conn.execute(
                text("SET SESSION wait_timeout = :t"),
                {"t": self.PIPELINE_LOCK_SESSION_MAX_SECONDS},
            )
            acquired = conn.execute(
                text("SELECT GET_LOCK(:name, :timeout)"),
                {"name": self.PIPELINE_LOCK_NAME, "timeout": self.PIPELINE_LOCK_TIMEOUT_SECONDS},
            ).scalar_one()
            if acquired != 1:
                raise RuntimeError(
                    f"Could not acquire SQL load lock '{self.PIPELINE_LOCK_NAME}' within "
                    f"{self.PIPELINE_LOCK_TIMEOUT_SECONDS}s. Another pipeline run appears to be "
                    "writing to this database right now; refusing to start a second, concurrent "
                    "SQL load, since that is what corrupts row counts (see "
                    "DatabaseExporter._exclusive_run_lock)."
                )
            try:
                yield
            finally:
                conn.execute(text("SELECT RELEASE_LOCK(:name)"), {"name": self.PIPELINE_LOCK_NAME})
        finally:
            conn.close()

    def export(self, tables: dict[str, pd.DataFrame]) -> SQLExportResult:
        self._prepare_schema(self.engine)
        self._ensure_run_log_table()
        self._ensure_run_audit_table()
        self._ensure_load_metadata_table()
        self._drop_retired_fact_tables()
        table_counts: dict[str, int] = {}

        with self._exclusive_run_lock():
            for table_name, df in tables.items():
                self.logger.info("Writing SQL table %s rows=%s", table_name, f"{len(df):,}")
                self._write_table(table_name, df)
                table_counts[table_name] = self._count_rows(table_name)

        validation = self.validate_counts(tables, table_counts)
        mismatch_count = int((~validation["Matches"]).sum()) if not validation.empty else 0
        if mismatch_count:
            self.logger.warning("SQL row-count validation found %s mismatch(es)", mismatch_count)
        else:
            self.logger.info("SQL row-count validation passed for %s table(s)", len(validation))
        return SQLExportResult(table_counts=table_counts, validation=validation)

    def export_incremental(self, tables: dict[str, pd.DataFrame], cutoff_local: datetime | pd.Timestamp | None) -> SQLExportResult:
        self._prepare_schema(self.engine)
        self._ensure_run_audit_table()
        self._ensure_load_metadata_table()
        self._drop_retired_fact_tables()
        if cutoff_local is None:
            self.logger.info("Incremental SQL requested without cutoff; falling back to full SQL export")
            return self.export(tables)

        cutoff = pd.Timestamp(cutoff_local).to_pydatetime()
        table_counts: dict[str, int] = {}
        validation_rows: list[dict[str, Any]] = []
        with self._exclusive_run_lock():
            for table_name, df in tables.items():
                table_started = time.perf_counter()
                if table_name == "Fact_SalesLines":
                    self._delete_insert_window(table_name, df, "order_date", cutoff)
                    validation_rows.append(self._window_validation_row(table_name, df, "order_date", cutoff))
                elif table_name == "Fact_Orders":
                    self._delete_insert_window(table_name, df, "OrderDateTime", cutoff, dedup_key="order_number")
                    self._delete_older_duplicate_rows_by_key(table_name, "order_number", "OrderDateTime")
                    validation_rows.append(self._window_validation_row(table_name, df, "OrderDateTime", cutoff))
                elif table_name == "Fact_Sales":
                    self._log_fact_sales_duplicate_key_diagnostics(df)
                    changed = self._write_table_if_changed(table_name, df)
                    scope = "full_table_replaced" if changed else "full_table_unchanged_skipped"
                    validation_rows.append(self._full_table_validation_row(table_name, df, load_mode="incremental", validation_scope=scope))
                elif table_name == "Fact_Delivery":
                    changed = self._write_table_if_changed(table_name, df)
                    scope = "full_table_replaced" if changed else "full_table_unchanged_skipped"
                    validation_rows.append(self._full_table_validation_row(table_name, df, load_mode="incremental", validation_scope=scope))
                elif table_name in {"Fact_Targets", "Fact_OffDays"} and self._table_exists(table_name):
                    self.logger.info("Skipping unchanged SQL table %s in incremental mode", table_name)
                    validation_rows.append(self._full_table_validation_row(table_name, df, load_mode="incremental", validation_scope="skipped_unchanged_full_table"))
                elif table_name in self.STRICT_INCREMENTAL_KEY_TABLES:
                    key = self._default_key_for_table(table_name)
                    table_existed = self._table_exists(table_name)
                    if key is not None and key in df.columns and df[key].isna().any():
                        self.logger.warning("Replacing SQL table %s in incremental mode; key %s contains nulls so stale rows cannot be pruned safely", table_name, key)
                        self._write_table(table_name, df)
                        validation_rows.append(self._full_table_validation_row(table_name, df, load_mode="incremental", validation_scope=f"full_table_replaced_null_key:{key}"))
                    else:
                        self._delete_insert_by_key(table_name, df, key)
                        if table_name in self.STALE_CLEANUP_TABLES and key is not None and key in df.columns:
                            self._delete_stale_rows_not_in_dataframe(table_name, df, key)
                        validation_rows.append(self._key_validation_row(table_name, df, key, table_existed))
                elif table_name in {"QA_CRM_MissingLinks", "QA_CRM_DataQuality", "QA_CRM_UnmappedKeys"}:
                    self.logger.info("Replacing QA table %s rows=%s in incremental mode", table_name, f"{len(df):,}")
                    self._write_table(table_name, df)
                    validation_rows.append(self._full_table_validation_row(table_name, df, load_mode="incremental", validation_scope="full_table_replaced"))
                else:
                    self.logger.info("Replacing SQL table %s rows=%s in incremental mode", table_name, f"{len(df):,}")
                    self._write_table(table_name, df)
                    validation_rows.append(self._full_table_validation_row(table_name, df, load_mode="incremental", validation_scope="full_table_replaced"))
                table_counts[table_name] = self._count_rows(table_name)
                latest_validation = validation_rows[-1] if validation_rows else {}
                self.logger.info(
                    "Incremental SQL table %s completed scope=%s export_rows=%s sql_rows=%s duration_seconds=%.2f",
                    table_name,
                    latest_validation.get("ValidationScope", "unknown"),
                    len(df),
                    table_counts[table_name],
                    time.perf_counter() - table_started,
                )

        validation = pd.DataFrame(validation_rows)
        mismatch_count = int((~validation["Matches"]).sum()) if not validation.empty else 0
        if mismatch_count:
            self.logger.warning("Incremental SQL row-count validation found %s mismatch(es)", mismatch_count)
            for _, row in validation[~validation["Matches"]].iterrows():
                self.logger.warning(
                    "Incremental SQL row-count mismatch: table=%s expected=%s sql=%s diff=%s load_mode=%s scope=%s",
                    row["TableName"],
                    row["ExpectedRows"],
                    row["SQLRows"],
                    row["Difference"],
                    row["LoadMode"],
                    row["ValidationScope"],
                )
        else:
            self.logger.info("Incremental SQL row-count validation passed for %s table(s)", len(validation))
        return SQLExportResult(table_counts=table_counts, validation=validation)

    def write_run_log(
        self,
        run_context: PipelineRunContext,
        odoo_extract_count: int = 0,
        db_loaded_count: int = 0,
        qa_issues_count: int = 0,
    ) -> None:
        self._prepare_schema(self.engine)
        self._ensure_run_log_table()
        full_name = self._quoted_table_name("pipeline_run_log")
        step_text = "\n".join(
            f"{s.step_name}: {s.status} {s.duration_seconds / 60:.2f} min"
            + (f" | {s.error_message}" if s.error_message else "")
            for s in run_context.step_timings
        )
        error_message = run_context.error_message or ""
        if step_text:
            error_message = (error_message + "\n" + step_text).strip()
        with self.engine.begin() as conn:
            conn.execute(
                text(
                    f"""
                    INSERT INTO {full_name} (
                        scheduled_refresh_time,
                        pipeline_start_time,
                        pipeline_end_time,
                        total_duration_minutes,
                        status,
                        error_message,
                        odoo_extract_count,
                        db_loaded_count,
                        qa_issues_count,
                        created_at
                    )
                    VALUES (
                        :scheduled_refresh_time,
                        :pipeline_start_time,
                        :pipeline_end_time,
                        :total_duration_minutes,
                        :status,
                        :error_message,
                        :odoo_extract_count,
                        :db_loaded_count,
                        :qa_issues_count,
                        CURRENT_TIMESTAMP
                    )
                    """
                ),
                {
                    "scheduled_refresh_time": run_context.scheduled_refresh_time,
                    "pipeline_start_time": run_context.start_time,
                    "pipeline_end_time": run_context.end_time,
                    "total_duration_minutes": round(run_context.total_duration_minutes, 4),
                    "status": run_context.status,
                    "error_message": error_message,
                    "odoo_extract_count": int(odoo_extract_count),
                    "db_loaded_count": int(db_loaded_count),
                    "qa_issues_count": int(qa_issues_count),
                },
            )

    def write_run_audit(
        self,
        *,
        run_context: PipelineRunContext,
        load_mode: str,
        output_mode: str,
        odoo_cutoff_utc: datetime | str | None,
        latest_order_before: tuple[Any, Any] | None,
        latest_order_after: tuple[Any, Any] | None,
        row_counts: dict[str, int] | None = None,
    ) -> None:
        self._prepare_schema(self.engine)
        self._ensure_run_audit_table()
        full_name = self._quoted_table_name("pipeline_run_audit")
        with self.engine.begin() as conn:
            conn.execute(
                text(
                    f"""
                    INSERT INTO {full_name} (
                        started_at,
                        finished_at,
                        load_mode,
                        output_mode,
                        odoo_cutoff_utc,
                        latest_order_number_before,
                        latest_order_datetime_before,
                        latest_order_number_after,
                        latest_order_datetime_after,
                        status,
                        error_message,
                        row_counts_json,
                        created_at
                    )
                    VALUES (
                        :started_at,
                        :finished_at,
                        :load_mode,
                        :output_mode,
                        :odoo_cutoff_utc,
                        :latest_order_number_before,
                        :latest_order_datetime_before,
                        :latest_order_number_after,
                        :latest_order_datetime_after,
                        :status,
                        :error_message,
                        :row_counts_json,
                        CURRENT_TIMESTAMP
                    )
                    """
                ),
                {
                    "started_at": run_context.start_time,
                    "finished_at": run_context.end_time,
                    "load_mode": load_mode,
                    "output_mode": output_mode,
                    "odoo_cutoff_utc": str(odoo_cutoff_utc) if odoo_cutoff_utc is not None else None,
                    "latest_order_number_before": latest_order_before[0] if latest_order_before else None,
                    "latest_order_datetime_before": latest_order_before[1] if latest_order_before else None,
                    "latest_order_number_after": latest_order_after[0] if latest_order_after else None,
                    "latest_order_datetime_after": latest_order_after[1] if latest_order_after else None,
                    "status": run_context.status,
                    "error_message": run_context.error_message or "",
                    "row_counts_json": str(row_counts or {}),
                },
            )

    def upsert_load_metadata(
        self,
        *,
        source_name: str,
        source_type: str,
        source_path: str,
        last_modified_time: datetime | None,
        file_size: int | None,
        checksum: str | None,
        load_mode: str,
        status: str,
    ) -> None:
        self._prepare_schema(self.engine)
        self._ensure_load_metadata_table()
        full_name = self._quoted_table_name("pipeline_load_metadata")
        with self.engine.begin() as conn:
            conn.execute(
                text(
                    f"""
                    INSERT INTO {full_name} (
                        source_name, source_type, source_path, last_modified_time,
                        file_size, checksum, last_successful_load_time,
                        load_mode, status, updated_at
                    )
                    VALUES (
                        :source_name, :source_type, :source_path, :last_modified_time,
                        :file_size, :checksum,
                        CASE WHEN :status = 'SUCCESS' THEN CURRENT_TIMESTAMP ELSE NULL END,
                        :load_mode, :status, CURRENT_TIMESTAMP
                    )
                    ON DUPLICATE KEY UPDATE
                        source_type = VALUES(source_type),
                        source_path = VALUES(source_path),
                        last_modified_time = VALUES(last_modified_time),
                        file_size = VALUES(file_size),
                        checksum = VALUES(checksum),
                        last_successful_load_time = CASE
                            WHEN VALUES(status) = 'SUCCESS' THEN CURRENT_TIMESTAMP
                            ELSE last_successful_load_time
                        END,
                        load_mode = VALUES(load_mode),
                        status = VALUES(status),
                        updated_at = CURRENT_TIMESTAMP
                    """
                ),
                {
                    "source_name": source_name,
                    "source_type": source_type,
                    "source_path": source_path,
                    "last_modified_time": last_modified_time,
                    "file_size": file_size,
                    "checksum": checksum,
                    "load_mode": load_mode,
                    "status": status,
                },
            )

    def get_load_metadata(self, source_name: str) -> dict[str, Any] | None:
        self._prepare_schema(self.engine)
        self._ensure_load_metadata_table()
        full_name = self._quoted_table_name("pipeline_load_metadata")
        with self.engine.connect() as conn:
            row = conn.execute(
                text(f"SELECT * FROM {full_name} WHERE source_name = :source_name"),
                {"source_name": source_name},
            ).mappings().one_or_none()
        return dict(row) if row else None

    def validate_counts(self, tables: dict[str, pd.DataFrame], table_counts: dict[str, int]) -> pd.DataFrame:
        rows = []
        for table_name, df in tables.items():
            export_rows = len(df)
            sql_rows = table_counts.get(table_name)
            rows.append(self._validation_row(
                table_name=table_name,
                expected_rows=export_rows,
                sql_rows=sql_rows,
                load_mode="full",
                validation_scope="full_table",
                export_rows=export_rows,
            )
            )
        return pd.DataFrame(rows)

    def _full_table_validation_row(
        self,
        table_name: str,
        df: pd.DataFrame,
        *,
        load_mode: str,
        validation_scope: str,
    ) -> dict[str, Any]:
        expected_rows = len(df)
        sql_rows = self._count_rows(table_name)
        return self._validation_row(
            table_name=table_name,
            expected_rows=expected_rows,
            sql_rows=sql_rows,
            load_mode=load_mode,
            validation_scope=validation_scope,
            export_rows=len(df),
        )

    def _window_validation_row(
        self,
        table_name: str,
        df: pd.DataFrame,
        date_col: str,
        cutoff: datetime,
    ) -> dict[str, Any]:
        if date_col not in df.columns:
            return self._full_table_validation_row(table_name, df, load_mode="incremental", validation_scope="full_table_replaced_missing_date")
        clean = self._clean_for_sql(df)
        window = clean[pd.to_datetime(clean[date_col], errors="coerce") >= pd.Timestamp(cutoff)].copy()
        sql_rows = self._count_window_rows(table_name, date_col, cutoff)
        return self._validation_row(
            table_name=table_name,
            expected_rows=len(window),
            sql_rows=sql_rows,
            load_mode="incremental",
            validation_scope=f"date_window:{date_col}",
            export_rows=len(df),
        )

    def _key_validation_row(
        self,
        table_name: str,
        df: pd.DataFrame,
        key: str | None,
        table_existed_before_load: bool,
    ) -> dict[str, Any]:
        if key is None or key not in df.columns:
            if table_existed_before_load:
                sql_rows = self._count_rows(table_name)
                return self._validation_row(
                    table_name=table_name,
                    expected_rows=sql_rows,
                    sql_rows=sql_rows,
                    load_mode="incremental",
                    validation_scope="skipped_no_stable_key",
                    export_rows=len(df),
                )
            return self._full_table_validation_row(table_name, df, load_mode="incremental", validation_scope="full_table_created_no_stable_key")
        if not table_existed_before_load:
            return self._full_table_validation_row(table_name, df, load_mode="incremental", validation_scope="full_table_created")
        clean = self._clean_for_sql(df)
        keys = clean[key].dropna().drop_duplicates().tolist()
        if not keys:
            sql_rows = self._count_rows(table_name)
            return self._validation_row(
                table_name=table_name,
                expected_rows=sql_rows,
                sql_rows=sql_rows,
                load_mode="incremental",
                validation_scope=f"skipped_no_keys:{key}",
                export_rows=len(df),
            )
        expected_rows = int(clean[key].isin(keys).sum())
        sql_rows = self._count_key_rows(table_name, key, keys)
        return self._validation_row(
            table_name=table_name,
            expected_rows=expected_rows,
            sql_rows=sql_rows,
            load_mode="incremental",
            validation_scope=f"key_set:{key}",
            export_rows=len(df),
        )

    @staticmethod
    def _validation_row(
        *,
        table_name: str,
        expected_rows: int | None,
        sql_rows: int | None,
        load_mode: str,
        validation_scope: str,
        export_rows: int | None,
    ) -> dict[str, Any]:
        difference = None if expected_rows is None or sql_rows is None else int(sql_rows - expected_rows)
        return {
            "TableName": table_name,
            "LoadMode": load_mode,
            "ValidationScope": validation_scope,
            "ExportRows": export_rows,
            "ExpectedRows": expected_rows,
            "SQLRows": sql_rows,
            "Matches": bool(sql_rows == expected_rows),
            "Difference": difference,
        }

    def _count_window_rows(self, table_name: str, date_col: str, cutoff: datetime) -> int:
        full_name = self._quoted_table_name(table_name)
        col = self.engine.dialect.identifier_preparer.quote(date_col)
        with self.engine.connect() as conn:
            return int(conn.execute(text(f"SELECT COUNT(*) FROM {full_name} WHERE {col} >= :cutoff"), {"cutoff": cutoff}).scalar_one())

    def _count_key_rows(self, table_name: str, key: str, keys: list[Any]) -> int:
        if not keys:
            return 0
        full_name = self._quoted_table_name(table_name)
        key_col = self.engine.dialect.identifier_preparer.quote(key)
        count_sql = text(f"SELECT COUNT(*) FROM {full_name} WHERE {key_col} IN :keys").bindparams(bindparam("keys", expanding=True))
        with self.engine.connect() as conn:
            return int(conn.execute(count_sql, {"keys": keys}).scalar_one())

    def _delete_stale_rows_not_in_dataframe(self, table_name: str, df: pd.DataFrame, key: str) -> int:
        if key not in df.columns or not self._table_exists(table_name):
            return 0
        started = time.perf_counter()
        clean = self._clean_for_sql(df)
        keys = clean[key].dropna().drop_duplicates().to_frame(name=key)
        full_name = self._quoted_table_name(table_name)
        self.logger.info(
            "Incremental SQL %s: starting stale cleanup key=%s current_keys=%s sql_rows=%s",
            table_name,
            key,
            len(keys),
            self._count_rows(table_name),
        )
        if keys.empty:
            with self.engine.begin() as conn:
                deleted = conn.execute(text(f"DELETE FROM {full_name}")).rowcount or 0
            duration = time.perf_counter() - started
            self.logger.info(
                "Incremental SQL %s: deleted stale rows=%s key=%s duration_seconds=%.2f",
                table_name,
                deleted,
                key,
                duration,
            )
            return int(deleted)

        if not self._ensure_index_on_column(table_name, key):
            self.logger.warning(
                "Incremental SQL %s: skipped stale cleanup key=%s because key index could not be created; final Excel/SQL validation may catch stale rows",
                table_name,
                key,
            )
            return 0

        temp_table = f"_tmp_keys_{uuid.uuid4().hex[:16]}"
        try:
            keys.to_sql(
                temp_table,
                self.engine,
                schema=self._effective_schema(),
                if_exists="replace",
                index=False,
                chunksize=self.settings.db_chunksize,
                method="multi",
                dtype=self._temp_key_dtype(keys[key]),
            )
            temp_name = self._quoted_table_name(temp_table)
            self._ensure_index_on_column(temp_table, key, unique=True)
            key_col = self.engine.dialect.identifier_preparer.quote(key)
            with self.engine.begin() as conn:
                if self.engine.dialect.name == "mysql":
                    deleted = conn.execute(
                        text(
                            f"""
                            DELETE target
                            FROM {full_name} AS target
                            LEFT JOIN {temp_name} AS current_keys
                                ON target.{key_col} = current_keys.{key_col}
                            WHERE current_keys.{key_col} IS NULL
                            """
                        )
                    ).rowcount or 0
                else:
                    deleted = conn.execute(
                        text(
                            f"""
                            DELETE FROM {full_name}
                            WHERE {key_col} IS NULL
                               OR {key_col} NOT IN (SELECT {key_col} FROM {temp_name})
                            """
                        )
                    ).rowcount or 0
            duration = time.perf_counter() - started
            self.logger.info(
                "Incremental SQL %s: deleted stale rows=%s key=%s duration_seconds=%.2f",
                table_name,
                deleted,
                key,
                duration,
            )
            return int(deleted)
        finally:
            self._drop_table_if_exists(temp_table)

    def _ensure_index_on_column(self, table_name: str, column_name: str, unique: bool = False) -> bool:
        if not self._table_exists(table_name):
            return False
        db_table_name = self._database_table_name(table_name) or table_name
        schema = self._effective_schema()
        index_name = self._index_name(db_table_name, column_name, unique=unique)
        try:
            inspector = inspect(self.engine)
            existing_indexes = inspector.get_indexes(db_table_name, schema=schema)
            existing_names = {idx.get("name") for idx in existing_indexes}
            if index_name in existing_names or any(column_name in (idx.get("column_names") or []) for idx in existing_indexes):
                return True
            full_name = self._quoted_table_name(table_name)
            preparer = self.engine.dialect.identifier_preparer
            column_expr = preparer.quote(column_name)
            if self.engine.dialect.name == "mysql" and self._mysql_column_needs_prefix_index(db_table_name, column_name, schema):
                column_expr = f"{column_expr}(191)"
            unique_sql = "UNIQUE " if unique else ""
            with self.engine.begin() as conn:
                conn.execute(text(f"CREATE {unique_sql}INDEX {preparer.quote(index_name)} ON {full_name} ({column_expr})"))
            self.logger.info("Ensured SQL index %s on %s.%s", index_name, table_name, column_name)
            return True
        except Exception as exc:  # noqa: BLE001
            self.logger.warning("Could not ensure SQL index on %s.%s: %s", table_name, column_name, exc)
            return False

    @staticmethod
    def _index_name(table_name: str, column_name: str, unique: bool = False) -> str:
        prefix = "ux" if unique else "ix"
        raw = f"{prefix}_{table_name}_{column_name}"
        safe = "".join(ch if ch.isalnum() or ch == "_" else "_" for ch in raw)
        if len(safe) <= 60:
            return safe
        return f"{safe[:43]}_{uuid.uuid5(uuid.NAMESPACE_DNS, safe).hex[:16]}"

    def _mysql_column_needs_prefix_index(self, table_name: str, column_name: str, schema: str | None) -> bool:
        if self.engine.dialect.name != "mysql":
            return False
        try:
            columns = inspect(self.engine).get_columns(table_name, schema=schema)
        except Exception:  # noqa: BLE001
            return False
        for column in columns:
            if column.get("name") != column_name:
                continue
            return "TEXT" in str(column.get("type", "")).upper() or "BLOB" in str(column.get("type", "")).upper()
        return False

    @staticmethod
    def _temp_key_dtype(series: pd.Series) -> dict[str, TypeEngine[Any]]:
        key_name = str(series.name)
        if pd.api.types.is_integer_dtype(series) or DatabaseExporter._series_is_integer_like(series):
            return {key_name: BigInteger()}
        if pd.api.types.is_float_dtype(series):
            return {key_name: Float()}
        if pd.api.types.is_datetime64_any_dtype(series):
            return {key_name: DateTime()}
        return {key_name: String(255)}

    @staticmethod
    def _stable_key_for_table(table_name: str, df: pd.DataFrame) -> str | None:
        candidates = {
            "Fact_Sales": ["SalesDocumentID", "SalesOrderID", "OrderNumber", "order_number", "sales_order_id", "order_id", "OrderID"],
        }.get(table_name, [])
        for candidate in candidates:
            if candidate not in df.columns:
                continue
            series = df[candidate]
            if series.isna().any() or series.duplicated().any():
                continue
            return candidate
        return None

    def _log_fact_sales_duplicate_key_diagnostics(self, df: pd.DataFrame) -> None:
        for key in ["SalesDocumentID", "SalesOrderID", "OrderNumber", "order_number", "sales_order_id", "order_id", "OrderID"]:
            if key not in df.columns:
                continue
            series = df[key]
            non_null = series.dropna()
            duplicate_rows = int(non_null.duplicated(keep=False).sum())
            duplicate_values = int(non_null[non_null.duplicated(keep=False)].nunique(dropna=True)) if duplicate_rows else 0
            null_rows = int(series.isna().sum())
            if duplicate_rows or null_rows:
                self.logger.warning(
                    "Fact_Sales key diagnostic: %s duplicate_rows=%s duplicate_values=%s null_rows=%s unique_values=%s total_rows=%s",
                    key,
                    duplicate_rows,
                    duplicate_values,
                    null_rows,
                    int(non_null.nunique(dropna=True)),
                    len(df),
                )
            else:
                self.logger.info("Fact_Sales key diagnostic: %s unique non-null rows=%s", key, len(df))

    def _write_table_if_changed(self, table_name: str, df: pd.DataFrame) -> bool:
        fingerprint = self._dataframe_fingerprint(df)
        metadata_name = f"sql_table:{table_name}"
        try:
            previous = self.get_load_metadata(metadata_name)
        except Exception as exc:  # noqa: BLE001
            self.logger.warning("Could not read SQL table fingerprint metadata for %s: %s", table_name, exc)
            previous = None
        current_rows = len(df)
        if (
            previous
            and previous.get("status") == "SUCCESS"
            and str(previous.get("checksum") or "") == fingerprint
            and int(previous.get("file_size") or -1) == current_rows
            and self._table_exists(table_name)
        ):
            sql_rows = self._count_rows(table_name)
            if sql_rows == current_rows:
                if self._sql_table_matches_dataframe(table_name, df):
                    self.logger.info("Skipping unchanged SQL table %s rows=%s in incremental mode", table_name, f"{current_rows:,}")
                    return False
                self.logger.info(
                    "SQL table %s fingerprint metadata is unchanged but stored rows differ; replacing table",
                    table_name,
                )
            else:
                self.logger.info(
                    "SQL table %s fingerprint unchanged but row count differs; replacing table expected=%s sql=%s",
                    table_name,
                    current_rows,
                    sql_rows,
                )
        self.logger.info("Replacing SQL table %s rows=%s in incremental mode", table_name, f"{current_rows:,}")
        self._write_table(table_name, df)
        try:
            self.upsert_load_metadata(
                source_name=metadata_name,
                source_type="sql_table",
                source_path=table_name,
                last_modified_time=datetime.now(),
                file_size=current_rows,
                checksum=fingerprint,
                load_mode="incremental",
                status="SUCCESS",
            )
        except Exception as exc:  # noqa: BLE001
            self.logger.warning("Could not write SQL table fingerprint metadata for %s: %s", table_name, exc)
        return True

    def _sql_table_matches_dataframe(self, table_name: str, df: pd.DataFrame) -> bool:
        try:
            actual = pd.read_sql_table(
                self._database_table_name(table_name) or table_name,
                self.engine,
                schema=self._effective_schema(),
            )
        except Exception as exc:  # noqa: BLE001
            self.logger.warning("Could not verify SQL table fingerprint for %s: %s", table_name, exc)
            return False
        if list(actual.columns) != list(df.columns):
            self.logger.info("SQL table %s fingerprint verification found column drift", table_name)
            return False
        return self._dataframes_equivalent_for_sql(df, actual)

    @staticmethod
    def _dataframes_equivalent_for_sql(left: pd.DataFrame, right: pd.DataFrame) -> bool:
        if list(left.columns) != list(right.columns) or len(left) != len(right):
            return False
        left_clean = DatabaseExporter._clean_for_sql(left)
        right_clean = DatabaseExporter._clean_for_sql(right)
        left_norm = pd.DataFrame(index=left_clean.index)
        right_norm = pd.DataFrame(index=right_clean.index)
        for col in left_clean.columns:
            left_norm[col] = DatabaseExporter._normalize_series_for_sql_compare(left_clean[col], col)
            right_norm[col] = DatabaseExporter._normalize_series_for_sql_compare(right_clean[col], col)
        left_order = left_norm.sort_values(list(left_norm.columns), kind="mergesort").index if not left_norm.empty else left_norm.index
        right_order = right_norm.sort_values(list(right_norm.columns), kind="mergesort").index if not right_norm.empty else right_norm.index
        return bool(left_norm.loc[left_order].reset_index(drop=True).equals(right_norm.loc[right_order].reset_index(drop=True)))

    @staticmethod
    def _normalize_series_for_sql_compare(series: pd.Series, column_name: str) -> pd.Series:
        null_mask = series.isna() | series.astype("string").str.strip().isin(["", "None", "none", "nan", "NaN", "NaT", "<NA>"])
        column_lower = column_name.lower()
        date_hint = any(token in column_lower for token in ["date", "time", "deadline", "created", "updated"])
        if date_hint or pd.api.types.is_datetime64_any_dtype(series):
            dates = pd.to_datetime(series, errors="coerce")
            if dates.notna().any():
                return dates.dt.strftime("%Y-%m-%d %H:%M:%S").astype("string").mask(null_mask, "<NA>").fillna("<NA>")
        numeric = pd.to_numeric(series, errors="coerce")
        non_null_count = int((~null_mask).sum())
        if non_null_count == int(numeric.notna().sum()) and numeric.notna().any():
            normalized = numeric.map(lambda value: "<NA>" if pd.isna(value) else f"{round(float(value), 6):.6f}".rstrip("0").rstrip(".")).astype("string")
            return normalized.mask(null_mask, "<NA>").fillna("<NA>").replace({"": "0"})
        text_values = series.astype("string").str.strip()
        text_values = text_values.replace({"": "<NA>", "None": "<NA>", "none": "<NA>", "nan": "<NA>", "NaN": "<NA>", "NaT": "<NA>", "<NA>": "<NA>"})
        text_values = text_values.replace({"True": "true", "TRUE": "true", "False": "false", "FALSE": "false"})
        return text_values.mask(null_mask, "<NA>").fillna("<NA>")

    @staticmethod
    def _dataframe_fingerprint(df: pd.DataFrame) -> str:
        clean = DatabaseExporter._clean_for_sql(df)
        digest = hashlib.blake2b(digest_size=16)
        digest.update("|".join(map(str, clean.columns)).encode("utf-8", errors="replace"))
        digest.update(str(len(clean)).encode("ascii"))
        if clean.empty:
            return digest.hexdigest()
        row_hashes = pd.util.hash_pandas_object(clean, index=False).astype("uint64").sort_values(kind="mergesort")
        digest.update(row_hashes.to_numpy().tobytes())
        return digest.hexdigest()

    def _write_table(self, table_name: str, df: pd.DataFrame) -> None:
        # Invalidate table-name cache so newly created tables are visible
        self._invalidate_table_name_cache()
        schema = self._effective_schema()
        clean = self._clean_for_sql(df, self.engine.dialect.name)
        dtype = self._dtype_map(clean, self.engine.dialect.name)
        self._log_mysql_tracked_dtype_map(table_name, dtype)
        if self.settings.db_reload_mode == "drop_recreate":
            self._drop_table_if_exists(table_name)
            clean.to_sql(
                table_name,
                self.engine,
                schema=schema,
                if_exists="replace",
                index=False,
                chunksize=self.settings.db_chunksize,
                method="multi",
                dtype=dtype,
            )
            self._ensure_mysql_table_charset(table_name)
            self._log_mysql_tracked_column_types(table_name)
            self._invalidate_table_name_cache()
            return

        self._ensure_table(table_name, clean, dtype)
        self._log_mysql_tracked_column_types(table_name)
        self._truncate_table(table_name)
        clean.to_sql(
            table_name,
            self.engine,
            schema=schema,
            if_exists="append",
            index=False,
            chunksize=self.settings.db_chunksize,
            method="multi",
            dtype=dtype,
        )
        self._ensure_mysql_table_charset(table_name)
        self._log_mysql_tracked_column_types(table_name)
        self._invalidate_table_name_cache()

    def _delete_insert_window(self, table_name: str, df: pd.DataFrame, date_col: str, cutoff: datetime, dedup_key: str | None = None) -> None:
        if date_col not in df.columns:
            self.logger.warning("%s has no %s column; replacing table instead", table_name, date_col)
            self._write_table(table_name, df)
            return
        if not self._table_exists(table_name):
            self.logger.info("%s missing; writing full table rows=%s", table_name, f"{len(df):,}")
            self._write_table(table_name, df)
            return
        clean = self._clean_for_sql(df, self.engine.dialect.name)
        dtype = self._dtype_map(clean, self.engine.dialect.name)
        self._log_mysql_tracked_dtype_map(table_name, dtype)
        self._ensure_table_columns(table_name, clean, dtype)
        self._log_mysql_tracked_column_types(table_name)
        window = clean[pd.to_datetime(clean[date_col], errors="coerce") >= pd.Timestamp(cutoff)].copy()
        self._ensure_index_on_column(table_name, date_col)
        deleted = self._delete_window_rows_batched(table_name, date_col, cutoff)
        if not window.empty and dedup_key is not None and dedup_key in window.columns:
            # Remove any pre-cutoff DB rows whose key matches the incoming window rows.
            # This handles orders whose date shifted across the cutoff boundary between runs,
            # which would otherwise leave a stale pre-cutoff copy alongside the new insert.
            stale_keys = window[dedup_key].dropna().drop_duplicates().tolist()
            if stale_keys:
                full_name = self._quoted_table_name(table_name)
                key_col_sql = self.engine.dialect.identifier_preparer.quote(dedup_key)
                stale_delete_sql = text(f"DELETE FROM {full_name} WHERE {key_col_sql} IN :keys").bindparams(bindparam("keys", expanding=True))
                with self.engine.begin() as conn:
                    stale_deleted = conn.execute(stale_delete_sql, {"keys": stale_keys}).rowcount
                self.logger.info("Incremental SQL %s: removed %s stale pre-cutoff rows by %s to prevent duplicates", table_name, stale_deleted, dedup_key)
        if not window.empty:
            window_dtype = self._dtype_map(window, self.engine.dialect.name)
            self._log_mysql_tracked_dtype_map(table_name, window_dtype)
            window.to_sql(
                table_name,
                self.engine,
                schema=self._effective_schema(),
                if_exists="append",
                index=False,
                chunksize=self.settings.db_chunksize,
                method="multi",
                dtype=window_dtype,
            )
        self._log_mysql_tracked_column_types(table_name)
        self.logger.info("Incremental SQL %s: inserted window rows=%s", table_name, len(window))

    def _delete_older_duplicate_rows_by_key(self, table_name: str, key_col: str, date_col: str) -> int:
        if not self._table_exists(table_name):
            return 0
        full_name = self._quoted_table_name(table_name)
        q = self.engine.dialect.identifier_preparer.quote
        key_sql = q(key_col)
        date_sql = q(date_col)
        if not self._ensure_index_on_column(table_name, key_col):
            self.logger.warning(
                "Incremental SQL %s: skipped duplicate cleanup key=%s because key index could not be created",
                table_name,
                key_col,
            )
            return 0

        with self.engine.begin() as conn:
            if self.engine.dialect.name == "mysql":
                deleted = conn.execute(
                    text(
                        f"""
                        DELETE target
                        FROM {full_name} AS target
                        JOIN (
                            SELECT {key_sql} AS dedupe_key, MAX({date_sql}) AS max_date
                            FROM {full_name}
                            WHERE {key_sql} IS NOT NULL
                            GROUP BY {key_sql}
                            HAVING COUNT(*) > 1
                        ) AS dupes
                            ON target.{key_sql} = dupes.dedupe_key
                        WHERE target.{date_sql} < dupes.max_date
                           OR (target.{date_sql} IS NULL AND dupes.max_date IS NOT NULL)
                        """
                    )
                ).rowcount or 0
            else:
                deleted = conn.execute(
                    text(
                        f"""
                        DELETE FROM {full_name}
                        WHERE rowid IN (
                            SELECT rowid
                            FROM (
                                SELECT rowid,
                                       ROW_NUMBER() OVER (
                                           PARTITION BY {key_sql}
                                           ORDER BY {date_sql} DESC, rowid DESC
                                       ) AS duplicate_rank
                                FROM {full_name}
                                WHERE {key_sql} IS NOT NULL
                            ) ranked
                            WHERE duplicate_rank > 1
                        )
                        """
                    )
                ).rowcount or 0
        deleted = int(deleted)
        if deleted:
            self.logger.info(
                "Incremental SQL %s: removed older duplicate rows=%s by %s keeping latest %s",
                table_name,
                deleted,
                key_col,
                date_col,
            )
        return deleted

    def _delete_window_rows_batched(self, table_name: str, date_col: str, cutoff: datetime) -> int:
        if self.engine.dialect.name != "mysql":
            full_name = self._quoted_table_name(table_name)
            with self.engine.begin() as conn:
                deleted = conn.execute(text(f"DELETE FROM {full_name} WHERE {self.engine.dialect.identifier_preparer.quote(date_col)} >= :cutoff"), {"cutoff": cutoff}).rowcount or 0
            self.logger.info("Incremental SQL %s delete completed rows=%s cutoff=%s", table_name, deleted, cutoff)
            return int(deleted)

        started = time.perf_counter()
        total_deleted = 0
        batch_index = 0
        full_name = self._quoted_table_name(table_name)
        date_col_sql = self.engine.dialect.identifier_preparer.quote(date_col)
        delete_sql = text(f"DELETE FROM {full_name} WHERE {date_col_sql} >= :cutoff LIMIT :batch_size")
        while True:
            batch_index += 1
            rows = self._execute_window_delete_batch_with_retry(
                delete_sql,
                {"cutoff": cutoff, "batch_size": self.WINDOW_DELETE_BATCH_SIZE},
                table_name,
                batch_index,
            )
            total_deleted += rows
            self.logger.info("Incremental SQL %s delete batch rows=%s batch=%s", table_name, rows, batch_index)
            if rows == 0:
                break
        duration = time.perf_counter() - started
        self.logger.info(
            "Incremental SQL %s delete completed rows=%s batches=%s cutoff=%s duration_seconds=%.2f",
            table_name,
            total_deleted,
            batch_index,
            cutoff,
            duration,
        )
        return total_deleted

    def _execute_window_delete_batch_with_retry(
        self,
        delete_sql: Any,
        params: dict[str, Any],
        table_name: str,
        batch_index: int,
    ) -> int:
        for attempt in range(self.WINDOW_DELETE_MAX_RETRIES + 1):
            try:
                with self.engine.begin() as conn:
                    return int(conn.execute(delete_sql, params).rowcount or 0)
            except OperationalError as exc:
                if not self._is_transient_lock_error(exc) or attempt >= self.WINDOW_DELETE_MAX_RETRIES:
                    raise
                sleep_seconds = 2 ** attempt
                self.logger.warning(
                    "Incremental SQL %s delete batch=%s hit transient lock error; retry=%s/%s sleep_seconds=%s",
                    table_name,
                    batch_index,
                    attempt + 1,
                    self.WINDOW_DELETE_MAX_RETRIES,
                    sleep_seconds,
                )
                time.sleep(sleep_seconds)
        return 0

    @staticmethod
    def _is_transient_lock_error(exc: BaseException) -> bool:
        text_value = str(exc).lower()
        return (
            "1205" in text_value
            or "1213" in text_value
            or "lock wait timeout" in text_value
            or "deadlock" in text_value
        )

    def _delete_insert_by_key(self, table_name: str, df: pd.DataFrame, key: str | None) -> None:
        if key is None or key not in df.columns:
            if self._table_exists(table_name):
                self.logger.info("Skipping SQL table %s in incremental mode; no stable key configured", table_name)
                return
            self._write_table(table_name, df)
            return
        if not self._table_exists(table_name):
            self._write_table(table_name, df)
            return
        clean = self._clean_for_sql(df, self.engine.dialect.name)
        dtype = self._dtype_map(clean, self.engine.dialect.name)
        self._log_mysql_tracked_dtype_map(table_name, dtype)
        self._ensure_table_columns(table_name, clean, dtype)
        self._log_mysql_tracked_column_types(table_name)
        keys = clean[key].dropna().drop_duplicates().tolist()
        if not keys:
            self.logger.info("Skipping SQL table %s in incremental mode; no keys to upsert", table_name)
            return
        full_name = self._quoted_table_name(table_name)
        preparer = self.engine.dialect.identifier_preparer
        key_col = preparer.quote(key)
        delete_sql = text(f"DELETE FROM {full_name} WHERE {key_col} IN :keys").bindparams(bindparam("keys", expanding=True))
        with self.engine.begin() as conn:
            deleted = conn.execute(delete_sql, {"keys": keys}).rowcount
        clean.to_sql(
            table_name,
            self.engine,
            schema=self._effective_schema(),
            if_exists="append",
            index=False,
            chunksize=self.settings.db_chunksize,
            method="multi",
            dtype=dtype,
        )
        self.logger.info("Incremental SQL %s: deleted key rows=%s inserted/upserted rows=%s key=%s", table_name, deleted, len(clean), key)

    def _table_exists(self, table_name: str) -> bool:
        return self._database_table_name(table_name) is not None

    def _invalidate_table_name_cache(self) -> None:
        """Clear the cached table-name list so next call re-inspects the database."""
        self.__dict__.pop("_cached_table_names", None)

    def _get_cached_table_names(self) -> list[str]:
        """PERF: Cache inspector.get_table_names() result within the exporter lifetime.
        This avoids an expensive SQL query (SHOW TABLES / information_schema) on every
        _table_exists() / _database_table_name() call during the export loop."""
        if "_cached_table_names" not in self.__dict__:
            self.__dict__["_cached_table_names"] = inspect(self.engine).get_table_names(schema=self._effective_schema())
        return self.__dict__["_cached_table_names"]  # type: ignore[return-value]

    def _database_table_name(self, table_name: str) -> str | None:
        table_names = self._get_cached_table_names()
        if table_name in table_names:
            return table_name
        table_lookup = {name.lower(): name for name in table_names}
        return table_lookup.get(table_name.lower())

    @staticmethod
    def _default_key_for_table(table_name: str) -> str | None:
        keys = {
            "Dim_Date": "DateKey",
            "Dim_Customer": "CustomerKey",
            "Dim_Salesperson": "SalespersonKey",
            "Dim_SalesTeam": "SalesTeamKey",
            "Dim_Company": "CompanyKey",
            "Dim_Product": "ProductKey",
            "Dim_DistributionChannel": "ChannelKey",
            "Dim_Segment": "SegmentKey",
            "Dim_Invoice": "InvoiceKey",
            "Dim_CRMStage": "StageID",
            "Dim_LostReason": "LostReasonID",
            "Fact_Lead": "LeadID",
            "Fact_Opportunity": "OpportunityID",
        }
        return keys.get(table_name)

    def _ensure_table(self, table_name: str, df: pd.DataFrame, dtype: dict[str, TypeEngine[Any]]) -> None:
        schema = self._effective_schema()
        if self._table_exists(table_name):
            self._ensure_table_columns(table_name, df, dtype)
            return
        df.head(0).to_sql(table_name, self.engine, schema=schema, if_exists="replace", index=False, dtype=dtype)
        self._ensure_mysql_table_charset(table_name)

    def _ensure_table_columns(self, table_name: str, df: pd.DataFrame, dtype: dict[str, TypeEngine[Any]]) -> None:
        inspector = inspect(self.engine)
        schema = self._effective_schema()
        db_table_name = self._database_table_name(table_name) or table_name
        existing_columns = {col["name"]: col for col in inspector.get_columns(db_table_name, schema=schema)}
        missing = [col for col in df.columns if col not in existing_columns]
        type_corrections = []
        if self.engine.dialect.name == "mysql":
            reflected_corrections = [
                (col, existing_columns[col].get("type"))
                for col in df.columns
                if col in existing_columns and self._mysql_column_needs_type_correction(existing_columns[col].get("type"), dtype.get(col))
            ]
            info_schema_corrections = self._mysql_type_corrections_from_information_schema(
                db_table_name,
                [col for col in df.columns if col in existing_columns],
                dtype,
            )
            type_corrections = list({col: current for col, current in [*reflected_corrections, *info_schema_corrections]}.items())
        if not missing and not type_corrections:
            return

        full_name = self._quoted_table_name(table_name)
        preparer = self.engine.dialect.identifier_preparer
        with self.engine.begin() as conn:
            for col in missing:
                sql_type = dtype[col].compile(dialect=self.engine.dialect)
                conn.execute(text(f"ALTER TABLE {full_name} ADD COLUMN {preparer.quote(col)} {sql_type}"))
                self.logger.info("Added SQL column %s.%s", table_name, col)
            for col, current_type in type_corrections:
                sql_type = dtype[col].compile(dialect=self.engine.dialect)
                conn.execute(text(f"ALTER TABLE {full_name} MODIFY COLUMN {preparer.quote(col)} {sql_type} NULL"))
                self.logger.info("Changed SQL column %s.%s from %s to %s", table_name, col, current_type, sql_type)

    def _truncate_table(self, table_name: str) -> None:
        full_name = self._quoted_table_name(table_name)
        with self.engine.begin() as conn:
            try:
                conn.execute(text(f"TRUNCATE TABLE {full_name}"))
            except Exception:  # noqa: BLE001
                self.logger.warning("TRUNCATE failed for %s; falling back to DELETE", table_name)
                conn.execute(text(f"DELETE FROM {full_name}"))

    def _drop_table_if_exists(self, table_name: str) -> None:
        db_table_name = self._database_table_name(table_name)
        if db_table_name is None:
            return
        preparer = self.engine.dialect.identifier_preparer
        with self.engine.begin() as conn:
            conn.execute(text(f"DROP TABLE IF EXISTS {preparer.quote(db_table_name)}"))

    def _drop_retired_fact_tables(self) -> None:
        for table_name in sorted(self.RETIRED_FACT_TABLES):
            if self._table_exists(table_name):
                self.logger.info("Dropping retired fact table %s", table_name)
                self._drop_table_if_exists(table_name)

    def _count_rows(self, table_name: str) -> int:
        full_name = self._quoted_table_name(table_name)
        with self.engine.connect() as conn:
            return int(conn.execute(text(f"SELECT COUNT(*) FROM {full_name}")).scalar_one())

    def _quoted_table_name(self, table_name: str) -> str:
        preparer = self.engine.dialect.identifier_preparer
        schema = self._effective_schema()
        quoted_table = preparer.quote(self._database_table_name(table_name) or table_name)
        if schema:
            return f"{preparer.quote_schema(schema)}.{quoted_table}"
        return quoted_table

    def _effective_schema(self) -> str | None:
        return None

    def _prepare_schema(self, engine: Engine) -> None:
        return

    def _ensure_run_log_table(self) -> None:
        full_name = self._quoted_table_name("pipeline_run_log")
        ddl = f"""
        CREATE TABLE IF NOT EXISTS {full_name} (
            run_id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
            scheduled_refresh_time TEXT NULL,
            pipeline_start_time DATETIME NULL,
            pipeline_end_time DATETIME NULL,
            total_duration_minutes DOUBLE NULL,
            status TEXT NOT NULL,
            error_message TEXT NULL,
            odoo_extract_count BIGINT NULL,
            db_loaded_count BIGINT NULL,
            qa_issues_count BIGINT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """
        with self.engine.begin() as conn:
            conn.execute(text(ddl))

    def _ensure_run_audit_table(self) -> None:
        full_name = self._quoted_table_name("pipeline_run_audit")
        ddl = f"""
        CREATE TABLE IF NOT EXISTS {full_name} (
            run_id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
            started_at DATETIME NULL,
            finished_at DATETIME NULL,
            load_mode TEXT NOT NULL,
            output_mode TEXT NOT NULL,
            odoo_cutoff_utc TEXT NULL,
            latest_order_number_before TEXT NULL,
            latest_order_datetime_before DATETIME NULL,
            latest_order_number_after TEXT NULL,
            latest_order_datetime_after DATETIME NULL,
            status TEXT NOT NULL,
            error_message TEXT NULL,
            row_counts_json TEXT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """
        with self.engine.begin() as conn:
            conn.execute(text(ddl))

    def _ensure_load_metadata_table(self) -> None:
        full_name = self._quoted_table_name("pipeline_load_metadata")
        ddl = f"""
        CREATE TABLE IF NOT EXISTS {full_name} (
            source_name VARCHAR(255) NOT NULL PRIMARY KEY,
            source_type TEXT NOT NULL,
            source_path TEXT NULL,
            last_modified_time DATETIME NULL,
            file_size BIGINT NULL,
            checksum TEXT NULL,
            last_successful_load_time DATETIME NULL,
            load_mode TEXT NULL,
            status TEXT NOT NULL,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """
        with self.engine.begin() as conn:
            conn.execute(text(ddl))

    def _ensure_mysql_table_charset(self, table_name: str) -> None:
        if self.engine.dialect.name != "mysql":
            return
        full_name = self._quoted_table_name(table_name)
        with self.engine.begin() as conn:
            conn.execute(
                text(
                    f"""
                    ALTER TABLE {full_name}
                    CONVERT TO CHARACTER SET utf8mb4
                    COLLATE utf8mb4_unicode_ci
                    """
                )
            )

    def _mysql_type_corrections_from_information_schema(
        self,
        db_table_name: str,
        columns: list[str],
        dtype: dict[str, TypeEngine[Any]],
    ) -> list[tuple[str, str]]:
        if not columns:
            return []

        schema = self._effective_schema()
        schema_predicate = "TABLE_SCHEMA = :schema" if schema else "TABLE_SCHEMA = DATABASE()"
        params: dict[str, Any] = {
            "table_name": db_table_name,
            "columns": columns,
        }
        if schema:
            params["schema"] = schema

        with self.engine.connect() as conn:
            rows = conn.execute(
                text(
                    f"""
                    SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE
                    FROM INFORMATION_SCHEMA.COLUMNS
                    WHERE {schema_predicate}
                      AND TABLE_NAME = :table_name
                      AND COLUMN_NAME IN :columns
                    """
                ).bindparams(bindparam("columns", expanding=True)),
                params,
            ).mappings().all()

        corrections: list[tuple[str, str]] = []
        for row in rows:
            column_name = row["COLUMN_NAME"]
            data_type = str(row["DATA_TYPE"]).lower()
            desired_type = dtype.get(column_name)
            if self._mysql_info_schema_type_needs_correction(data_type, desired_type):
                current_type = str(row["COLUMN_TYPE"])
                corrections.append((column_name, current_type))
                self.logger.info(
                    "MySQL INFORMATION_SCHEMA requires type correction for %s.%s: current=%s desired=%s",
                    db_table_name,
                    column_name,
                    current_type,
                    desired_type.compile(dialect=self.engine.dialect) if desired_type is not None else None,
                )
        return corrections

    def _log_mysql_tracked_dtype_map(self, table_name: str, dtype: dict[str, TypeEngine[Any]]) -> None:
        if self.engine.dialect.name != "mysql" or table_name not in {"Fact_SalesLines", "Fact_Targets"}:
            return
        tracked = self._mysql_tracked_columns()
        summary = {
            col: dtype[col].compile(dialect=self.engine.dialect)
            for col in tracked
            if col in dtype
        }
        self.logger.info("MySQL dtype_map for %s tracked columns: %s", table_name, summary)

    def _log_mysql_tracked_column_types(self, table_name: str) -> None:
        if self.engine.dialect.name != "mysql" or table_name not in {"Fact_SalesLines", "Fact_Targets"} or not self._table_exists(table_name):
            return
        tracked = self._mysql_tracked_columns()
        db_table_name = self._database_table_name(table_name) or table_name
        with self.engine.connect() as conn:
            rows = conn.execute(
                text(
                    """
                    SELECT COLUMN_NAME, COLUMN_TYPE
                    FROM INFORMATION_SCHEMA.COLUMNS
                    WHERE TABLE_SCHEMA = DATABASE()
                      AND TABLE_NAME = :table_name
                      AND COLUMN_NAME IN :columns
                    """
                ).bindparams(bindparam("columns", expanding=True)),
                {
                    "table_name": db_table_name,
                    "columns": tracked,
                },
            ).mappings().all()
        summary = {row["COLUMN_NAME"]: row["COLUMN_TYPE"] for row in rows}
        self.logger.info("MySQL INFORMATION_SCHEMA column types for %s tracked columns: %s", table_name, summary)

    @staticmethod
    def _mysql_tracked_columns() -> list[str]:
        return [
            "sales_team_key",
            "SalesTeamKey",
            "line_total",
            "Value",
            "untaxed_total",
            "InvoiceValue",
            "Target_Revenue",
            "Target_Volume",
            "TargetDate",
        ]

    @staticmethod
    def _clean_for_sql(df: pd.DataFrame, dialect_name: str | None = None) -> pd.DataFrame:
        out = df.copy()
        for col in out.columns:
            if pd.api.types.is_datetime64_any_dtype(out[col]):
                out[col] = pd.to_datetime(out[col], errors="coerce")
            elif pd.api.types.is_bool_dtype(out[col]):
                out[col] = out[col].astype("boolean")
            elif pd.api.types.is_integer_dtype(out[col]):
                out[col] = pd.to_numeric(out[col], errors="coerce").astype("Int64")
            elif pd.api.types.is_float_dtype(out[col]):
                out[col] = pd.to_numeric(out[col], errors="coerce")
                # MySQL analytical/financial values are stored as DECIMAL(20,6).
                # Send exact Decimal objects so binary float conversion cannot
                # land on the opposite side of a six-decimal boundary.
                if DatabaseExporter._is_decimal_column(col):
                    if dialect_name == "mysql":
                        # PERF: only process non-null rows (avoid Decimal overhead on NaN)
                        out[col] = DatabaseExporter._batch_quantize_decimal(out[col])
                    else:
                        out[col] = DatabaseExporter._batch_round_decimal_float(out[col])
            elif (
                DatabaseExporter._is_decimal_column(col)
                and DatabaseExporter._series_is_numeric_like(out[col])
            ):
                # Nullable calculated metrics often have object dtype because
                # they begin with pd.NA. Canonicalize them exactly like floats.
                numeric = pd.to_numeric(out[col], errors="coerce")
                if dialect_name == "mysql":
                    out[col] = numeric.map(DatabaseExporter._quantize_decimal_for_sql)
                else:
                    out[col] = numeric.map(DatabaseExporter._round_decimal_float_for_sql)
            else:
                # PERF: Replaced per-value .map(_normalize_sql_scalar) with vectorized null
                # normalization. For string columns (the dominant case), this is 10-50x faster.
                out[col] = DatabaseExporter._normalize_object_series_for_sql(out[col])
        return out

    _NULL_STRINGS: frozenset = frozenset({"", "<NA>", "nan", "NaN", "None", "NaT"})

    @staticmethod
    def _normalize_object_series_for_sql(series: pd.Series) -> pd.Series:
        """Vectorized null normalization for object dtype columns."""
        result = series.astype("object")
        # Step 1: replace Python None / pd.NA / float NaN
        null_mask = result.isna()
        # Step 2: replace null-like strings (common in Odoo exports)
        try:
            str_mask = ~null_mask & result.astype(str).str.strip().isin(DatabaseExporter._NULL_STRINGS)
        except Exception:  # noqa: BLE001
            str_mask = pd.Series(False, index=result.index)
        result = result.where(~(null_mask | str_mask), other=None)
        false_mask = result.map(lambda value: isinstance(value, bool) and value is False)
        if false_mask.any():
            result[false_mask] = None
        # Step 3: convert any Decimal objects to float (rare but safe)
        decimal_mask = result.apply(lambda x: isinstance(x, Decimal))
        if decimal_mask.any():
            result[decimal_mask] = result[decimal_mask].apply(float)
        return result

    @staticmethod
    def _normalize_sql_scalar(value: Any) -> Any:
        if value is None:
            return None
        if isinstance(value, bool):
            return None if value is False else value
        try:
            if pd.isna(value):
                return None
        except (TypeError, ValueError):
            pass
        if isinstance(value, str) and value.strip() in {"", "<NA>", "nan", "NaN", "None", "NaT"}:
            return None
        if isinstance(value, Decimal):
            return float(value)
        return value

    @staticmethod
    def _quantize_decimal_for_sql(value: Any) -> Decimal | None:
        if value is None or pd.isna(value):
            return None
        return Decimal(str(value)).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)

    @staticmethod
    def _round_decimal_float_for_sql(value: Any) -> float | None:
        quantized = DatabaseExporter._quantize_decimal_for_sql(value)
        return None if quantized is None else float(quantized)

    @staticmethod
    def _batch_quantize_decimal(series: pd.Series) -> pd.Series:
        """PERF: Batch Decimal quantize.

        Uses numpy integer positions (.nonzero()) instead of boolean Series
        indexing to avoid pandas 2.x / Python 3.13 putmask breakage on object arrays.
        """
        arr = series.to_numpy(dtype=object).copy()
        non_null_pos = (~series.isna()).to_numpy().nonzero()[0]
        if len(non_null_pos) > 0:
            arr[non_null_pos] = [
                Decimal(str(arr[i])).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)
                for i in non_null_pos
            ]
        return pd.Series(arr, index=series.index)

    @staticmethod
    def _batch_round_decimal_float(series: pd.Series) -> pd.Series:
        """PERF: Batch round-to-6dp.

        Uses numpy integer positions (.nonzero()) instead of boolean Series
        indexing to avoid pandas 2.x / Python 3.13 putmask breakage on object arrays.
        """
        arr = series.to_numpy(dtype=object).copy()
        non_null_pos = (~series.isna()).to_numpy().nonzero()[0]
        if len(non_null_pos) > 0:
            arr[non_null_pos] = [
                float(Decimal(str(arr[i])).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP))
                for i in non_null_pos
            ]
        return pd.to_numeric(pd.Series(arr, index=series.index), errors="coerce")

    @staticmethod
    def _dtype_map(df: pd.DataFrame, dialect_name: str | None = None) -> dict[str, TypeEngine[Any]]:
        dtype: dict[str, TypeEngine[Any]] = {}
        for col in df.columns:
            series = df[col]
            if dialect_name == "mysql":
                dtype[col] = DatabaseExporter._mysql_dtype_for_column(col, series)
                continue
            if pd.api.types.is_bool_dtype(series):
                dtype[col] = Boolean()
            elif pd.api.types.is_integer_dtype(series):
                dtype[col] = BigInteger()
            elif pd.api.types.is_float_dtype(series):
                dtype[col] = Float()
            elif pd.api.types.is_datetime64_any_dtype(series):
                dtype[col] = DateTime()
            else:
                dtype[col] = Text()
        return dtype

    @staticmethod
    def _mysql_dtype_for_column(column_name: str, series: pd.Series) -> TypeEngine[Any]:
        if DatabaseExporter._is_bool_column(column_name) or pd.api.types.is_bool_dtype(series):
            return mysql.TINYINT(display_width=1)
        if pd.api.types.is_datetime64_any_dtype(series):
            return Date() if DatabaseExporter._is_date_only_column(column_name, series) else mysql.DATETIME()
        if DatabaseExporter._is_date_only_column(column_name, series):
            return Date()
        if DatabaseExporter._is_decimal_column(column_name):
            if (pd.api.types.is_object_dtype(series) or pd.api.types.is_string_dtype(series)) and not DatabaseExporter._series_is_numeric_like(series):
                return mysql.TEXT()
            return mysql.DECIMAL(20, 6)
        if DatabaseExporter._is_mysql_always_text_column(column_name):
            return mysql.TEXT()
        if DatabaseExporter._is_mysql_business_text_column(column_name) and not DatabaseExporter._series_is_integer_like(series):
            return mysql.TEXT()
        if pd.api.types.is_integer_dtype(series) or DatabaseExporter._is_integer_column(column_name, series):
            return Integer() if column_name.lower() in {"year", "month", "quarter"} else mysql.BIGINT()
        if DatabaseExporter._is_indexable_key_column(column_name):
            return mysql.VARCHAR(255)
        if pd.api.types.is_float_dtype(series):
            return Float()
        if pd.api.types.is_object_dtype(series) or pd.api.types.is_string_dtype(series):
            return mysql.TEXT()
        return mysql.TEXT()

    @staticmethod
    def _is_decimal_column(column_name: str) -> bool:
        name = column_name.lower()
        if name in {"doh", "avg_daily_sales"}:
            return True
        if name in {"quotationtosalesorderhours", "quotationagehours"}:
            return True
        if "date" in name or "time" in name:
            return False
        text_tokens = ["key", "level", "name", "team", "city", "channel", "currency", "segment", "status", "state", "type"]
        if any(token in name for token in text_tokens):
            return False
        decimal_tokens = [
            "amount",
            "change",
            "cost",
            "growth",
            "percent",
            "price",
            "profit",
            "value",
            "revenue",
            "total",
            "subtotal",
            "untaxed",
            "target",
            "achieved",
            "prorated",
            "quantity",
            "volume",
            "qty",
            "asp",
        ]
        return any(token in name for token in decimal_tokens)

    @staticmethod
    def _is_integer_column(column_name: str, series: pd.Series) -> bool:
        name = column_name.lower()
        if DatabaseExporter._is_decimal_column(column_name) or DatabaseExporter._is_bool_column(column_name):
            return False
        if pd.api.types.is_integer_dtype(series):
            return True
        if not DatabaseExporter._series_is_integer_like(series):
            return False
        return (
            name in DatabaseExporter._known_numeric_surrogate_key_columns()
            or name == "id"
            or name.endswith("id")
            or name.endswith("_id")
            or name in {"year", "month", "quarter", "count", "opportunitycount"}
            or name.endswith("count")
        )

    @staticmethod
    def _known_numeric_surrogate_key_columns() -> set[str]:
        return {
            "activityid",
            "channelkey",
            "companykey",
            "count",
            "customerkey",
            "datekey",
            "eventid",
            "id",
            "invoicekey",
            "leadid",
            "lostreasonid",
            "month",
            "opportunityid",
            "opportunitycount",
            "productkey",
            "productjoinkey",
            "quarter",
            "salespersonkey",
            "salesteamkey",
            "segmentkey",
            "stageid",
            "year",
        }

    @staticmethod
    def _is_numeric_like_series(series: pd.Series) -> bool:
        return DatabaseExporter._series_is_integer_like(series)

    @staticmethod
    def _series_is_numeric_like(series: pd.Series) -> bool:
        non_null = series.dropna()
        if non_null.empty:
            return False
        numeric = pd.to_numeric(non_null, errors="coerce")
        return bool(numeric.notna().all())

    @staticmethod
    def _series_is_integer_like(series: pd.Series) -> bool:
        non_null = series.dropna()
        if non_null.empty:
            return False
        numeric = pd.to_numeric(non_null, errors="coerce")
        if numeric.isna().any():
            return False
        # PERF: replaced Decimal(str(v)) % 1 == 0 per-value map with vectorized numpy.
        # np.floor comparison is ~100x faster than Python Decimal construction per row.
        arr = numeric.to_numpy(dtype=float)
        return bool(np.all(arr % 1.0 == 0.0))

    @staticmethod
    def _is_bool_column(column_name: str) -> bool:
        return (
            (len(column_name) > 2 and column_name.startswith("Is") and column_name[2].isupper())
            or (len(column_name) > 3 and column_name.startswith("Has") and column_name[3].isupper())
            or column_name.startswith("is_")
        )

    @staticmethod
    def _is_date_only_column(column_name: str, series: pd.Series) -> bool:
        name = column_name.lower()
        if name.endswith("datetime") or name.endswith("_time") or "time" in name:
            return False
        if name.endswith("date") or name.endswith("_date") or name in {"targetdate", "order_date_date"}:
            non_null = series.dropna()
            if non_null.empty:
                return True
            values = pd.to_datetime(non_null, errors="coerce")
            return bool(values.notna().all() and values.dt.time.eq(datetime.min.time()).all())
        return False

    @staticmethod
    def _is_varchar_column(column_name: str, series: pd.Series) -> bool:
        name = column_name.lower()
        if any(token in name for token in ["name", "number", "code", "status", "state", "type", "bucket"]):
            return True
        non_null = series.dropna()
        if non_null.empty:
            return False
        text_lengths = non_null.astype(str).str.len()
        return bool(text_lengths.max() <= 255)

    @staticmethod
    def _is_indexable_key_column(column_name: str) -> bool:
        name = column_name.lower()
        if DatabaseExporter._is_mysql_always_text_column(column_name):
            return False
        return (
            name in DatabaseExporter._known_numeric_surrogate_key_columns()
            or name == "id"
            or name.endswith("id")
            or name.endswith("_id")
            or name.endswith("key")
        )

    @staticmethod
    def _mysql_column_needs_text_type(current_type: TypeEngine[Any] | None, desired_type: TypeEngine[Any] | None) -> bool:
        if current_type is None or desired_type is None:
            return False
        if not DatabaseExporter._is_mysql_text_type(desired_type):
            return False
        return isinstance(current_type, (BigInteger, Integer, mysql.BIGINT, mysql.INTEGER, mysql.TINYINT, mysql.SMALLINT, mysql.MEDIUMINT))

    @staticmethod
    def _mysql_column_needs_type_correction(current_type: TypeEngine[Any] | None, desired_type: TypeEngine[Any] | None) -> bool:
        if current_type is None or desired_type is None:
            return False
        if DatabaseExporter._is_mysql_text_type(desired_type):
            return not isinstance(current_type, (String, Text, mysql.VARCHAR, mysql.TEXT, mysql.MEDIUMTEXT, mysql.LONGTEXT))
        if DatabaseExporter._is_mysql_decimal_type(desired_type):
            return not (
                isinstance(current_type, mysql.DECIMAL)
                and getattr(current_type, "precision", None) == 20
                and getattr(current_type, "scale", None) == 6
            )
        if DatabaseExporter._is_mysql_bool_type(desired_type):
            return not isinstance(current_type, mysql.TINYINT)
        if DatabaseExporter._is_mysql_date_type(desired_type):
            return not isinstance(current_type, Date) or isinstance(current_type, DateTime)
        if DatabaseExporter._is_mysql_datetime_type(desired_type):
            return not isinstance(current_type, DateTime)
        return False

    @staticmethod
    def _mysql_info_schema_type_needs_correction(data_type: str, desired_type: TypeEngine[Any] | None) -> bool:
        if desired_type is None:
            return False
        normalized = data_type.lower()
        text_types = {"char", "varchar", "tinytext", "text", "mediumtext", "longtext"}
        decimal_types = {"decimal", "numeric"}
        bool_types = {"tinyint"}
        date_types = {"date"}
        datetime_types = {"datetime", "timestamp"}
        if DatabaseExporter._is_mysql_text_type(desired_type):
            return normalized not in text_types
        if DatabaseExporter._is_mysql_decimal_type(desired_type):
            return normalized not in decimal_types
        if DatabaseExporter._is_mysql_bool_type(desired_type):
            return normalized not in bool_types
        if DatabaseExporter._is_mysql_date_type(desired_type):
            return normalized not in date_types
        if DatabaseExporter._is_mysql_datetime_type(desired_type):
            return normalized not in datetime_types
        return False

    @staticmethod
    def _is_mysql_text_type(sql_type: TypeEngine[Any] | None) -> bool:
        return isinstance(sql_type, (String, Text, mysql.VARCHAR, mysql.TEXT, mysql.MEDIUMTEXT, mysql.LONGTEXT))

    @staticmethod
    def _is_mysql_decimal_type(sql_type: TypeEngine[Any] | None) -> bool:
        return isinstance(sql_type, mysql.DECIMAL)

    @staticmethod
    def _is_mysql_bool_type(sql_type: TypeEngine[Any] | None) -> bool:
        return isinstance(sql_type, mysql.TINYINT) and getattr(sql_type, "display_width", None) == 1

    @staticmethod
    def _is_mysql_date_type(sql_type: TypeEngine[Any] | None) -> bool:
        return isinstance(sql_type, Date) and not isinstance(sql_type, DateTime)

    @staticmethod
    def _is_mysql_datetime_type(sql_type: TypeEngine[Any] | None) -> bool:
        return isinstance(sql_type, DateTime)

    @staticmethod
    def _is_mysql_business_text_column(column_name: str) -> bool:
        return column_name.lower() in {"sales_team_key", "salesteamkey", "sales_team_segment", "sales_team_city"}

    @staticmethod
    def _is_mysql_always_text_column(column_name: str) -> bool:
        return column_name.lower() in {"sales_team_key", "sales_team_segment", "sales_team_city"}
