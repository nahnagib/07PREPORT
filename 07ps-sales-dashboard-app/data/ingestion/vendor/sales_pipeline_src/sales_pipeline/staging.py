from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

import pandas as pd
from sqlalchemy import Boolean, DateTime, Float, Text, create_engine, inspect, text
from sqlalchemy.sql.sqltypes import BigInteger, TypeEngine

from config.settings import Settings
from sales_pipeline.export.database_exporter import DatabaseExporter


@dataclass(frozen=True)
class StagingSyncResult:
    full_refresh: bool
    since_datetime: datetime | None
    changed_counts: dict[str, int]

    @property
    def total_changed(self) -> int:
        return sum(self.changed_counts.values())


class StagingStore:
    RAW_TABLES = [
        "raw_sale_report_api",
        "raw_sale_order",
        "raw_sale_order_line",
        "raw_crm_lead",
        "raw_crm_stage",
        "raw_crm_lost_reason",
        "raw_stock_picking",
        "raw_stock_move",
    ]

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.logger = logging.getLogger(__name__)
        helper = DatabaseExporter(settings)
        helper._prepare_schema(helper.engine)
        self.engine = helper.engine
        self.schema = helper._effective_schema()

    def should_full_refresh(self, requested_full_refresh: bool) -> bool:
        if requested_full_refresh:
            return True
        inspector = inspect(self.engine)
        return any(not inspector.has_table(table, schema=self.schema) for table in self.RAW_TABLES)

    def last_success_start_time(self) -> datetime | None:
        inspector = inspect(self.engine)
        if not inspector.has_table("pipeline_run_log", schema=self.schema):
            return None
        full_name = self._quoted_table_name("pipeline_run_log")
        with self.engine.connect() as conn:
            value = conn.execute(
                text(
                    f"""
                    SELECT MAX(pipeline_start_time)
                    FROM {full_name}
                    WHERE status = 'SUCCESS'
                    """
                )
            ).scalar_one_or_none()
        return value

    def incremental_since(self) -> datetime | None:
        last_success = self.last_success_start_time()
        if last_success is None:
            return None
        return last_success - timedelta(days=self.settings.incremental_overlap_days)

    def replace_table(self, table_name: str, df: pd.DataFrame) -> None:
        clean = self._clean_for_sql(df)
        self._drop_table_if_exists(table_name)
        clean.to_sql(
            table_name,
            self.engine,
            schema=self.schema,
            if_exists="replace",
            index=False,
            chunksize=self.settings.db_chunksize,
            method="multi",
            dtype=self._dtype_map(clean),
        )
        self._ensure_mysql_table_charset(table_name)
        if "id" in clean.columns:
            self.ensure_key_constraint(table_name, "id")

    def upsert_table(self, table_name: str, df: pd.DataFrame, key: str = "id") -> None:
        if df.empty:
            self._ensure_table(table_name, df)
            self.ensure_key_constraint(table_name, key)
            return
        if key not in df.columns:
            raise KeyError(f"Cannot upsert {table_name}; missing key column {key}")
        self._ensure_table(table_name, df)
        self.ensure_key_constraint(table_name, key)
        temp_name = f"tmp_{table_name}"
        clean = self._clean_for_sql(df)
        clean.to_sql(
            temp_name,
            self.engine,
            schema=self.schema,
            if_exists="replace",
            index=False,
            chunksize=self.settings.db_chunksize,
            method="multi",
            dtype=self._dtype_map(clean),
        )
        self._ensure_mysql_table_charset(temp_name)
        full_table = self._quoted_table_name(table_name)
        full_temp = self._quoted_table_name(temp_name)
        cols = list(clean.columns)
        upsert_sql = self._build_upsert_sql(full_table, full_temp, cols, key)
        with self.engine.begin() as conn:
            conn.execute(text(upsert_sql))
            conn.execute(text(f"DROP TABLE {full_temp}"))

    def _build_upsert_sql(self, full_table: str, full_temp: str, cols: list[str], key: str) -> str:
        preparer = self.engine.dialect.identifier_preparer
        quote = preparer.quote_identifier
        quoted_cols = [quote(c) for c in cols]
        update_cols = [c for c in cols if c != key]
        if self.engine.dialect.name == "postgresql":
            assignments = ", ".join(f"{quote(c)} = EXCLUDED.{quote(c)}" for c in update_cols)
            if not assignments:
                assignments = f"{quote(key)} = EXCLUDED.{quote(key)}"
            upsert_sql = f"""
                INSERT INTO {full_table} ({", ".join(quoted_cols)})
                SELECT {", ".join(quoted_cols)} FROM {full_temp}
                ON CONFLICT ({quote(key)}) DO UPDATE SET {assignments}
            """
        elif self.engine.dialect.name == "mysql":
            assignments = ", ".join(f"{quote(c)} = VALUES({quote(c)})" for c in update_cols)
            if not assignments:
                assignments = f"{quote(key)} = VALUES({quote(key)})"
            upsert_sql = f"""
                INSERT INTO {full_table} ({", ".join(quoted_cols)})
                SELECT {", ".join(quoted_cols)} FROM {full_temp}
                ON DUPLICATE KEY UPDATE {assignments}
            """
        else:
            raise ValueError(f"Unsupported staging upsert dialect: {self.engine.dialect.name}")
        return upsert_sql

    def read_table(self, table_name: str) -> pd.DataFrame:
        return pd.read_sql_table(self._database_table_name(table_name) or table_name, self.engine, schema=self.schema)

    def replace_date_window(self, table_name: str, df: pd.DataFrame, date_col: str, cutoff: datetime) -> None:
        """Replace a complete date window without reading/rebuilding the unchanged cache."""
        if not self.has_table(table_name):
            self.replace_table(table_name, df)
            self.ensure_index(table_name, date_col)
            return
        clean = self._clean_for_sql(df)
        full_table = self._quoted_table_name(table_name)
        quoted_date = self.engine.dialect.identifier_preparer.quote(date_col)
        self.ensure_index(table_name, date_col)
        with self.engine.begin() as conn:
            deleted = conn.execute(
                text(f"DELETE FROM {full_table} WHERE {quoted_date} >= :cutoff"),
                {"cutoff": cutoff},
            ).rowcount or 0
        if not clean.empty:
            clean.to_sql(
                table_name,
                self.engine,
                schema=self.schema,
                if_exists="append",
                index=False,
                chunksize=self.settings.db_chunksize,
                method="multi",
                dtype=self._dtype_map(clean),
            )
        self.logger.info("Staging date-window replace %s deleted=%s inserted=%s cutoff=%s", table_name, deleted, len(clean), cutoff)

    def ensure_index(self, table_name: str, column_name: str) -> None:
        if not self._table_has_column(table_name, column_name):
            return
        db_table_name = self._database_table_name(table_name) or table_name
        indexes = inspect(self.engine).get_indexes(db_table_name, schema=self.schema)
        if any(column_name in (idx.get("column_names") or []) for idx in indexes):
            return
        preparer = self.engine.dialect.identifier_preparer
        index_name = f"ix_{table_name}_{column_name}"[:60]
        with self.engine.begin() as conn:
            conn.execute(
                text(
                    f"CREATE INDEX {preparer.quote(index_name)} "
                    f"ON {self._quoted_table_name(table_name)} ({preparer.quote(column_name)})"
                )
            )

    def has_table(self, table_name: str) -> bool:
        return self._database_table_name(table_name) is not None

    def add_primary_key_if_missing(self, table_name: str, key: str = "id") -> None:
        if self.engine.dialect.name != "mysql":
            return
        constraint_name = f"{table_name}_pk"
        full_table = self._quoted_table_name(table_name)
        preparer = self.engine.dialect.identifier_preparer
        with self.engine.begin() as conn:
            exists = conn.execute(
                text(
                    """
                    SELECT 1
                    FROM information_schema.table_constraints
                    WHERE constraint_schema = DATABASE()
                      AND table_name = :table_name
                      AND constraint_type = 'PRIMARY KEY'
                    """
                ),
                {"constraint_name": constraint_name, "table_name": table_name},
            ).fetchone()
            if not exists:
                conn.execute(text(f"ALTER TABLE {full_table} ADD PRIMARY KEY ({preparer.quote(key)})"))

    def ensure_key_constraint(self, table_name: str, key: str = "id") -> None:
        if key is None or not self._table_has_column(table_name, key):
            return
        if self.engine.dialect.name == "mysql":
            self.add_primary_key_if_missing(table_name, key)
        elif self.engine.dialect.name == "postgresql":
            self._ensure_postgres_unique_index(table_name, key)

    def _ensure_postgres_unique_index(self, table_name: str, key: str = "id") -> None:
        full_table = self._quoted_table_name(table_name)
        preparer = self.engine.dialect.identifier_preparer
        index_name = f"ux_{table_name}_{key}"
        schema_clause = "AND schemaname = :schema" if self.schema else ""
        with self.engine.begin() as conn:
            exists = conn.execute(
                text(
                    f"""
                    SELECT 1
                    FROM pg_indexes
                    WHERE indexname = :index_name
                    {schema_clause}
                    """
                ),
                {"index_name": index_name, "schema": self.schema},
            ).fetchone()
            if not exists:
                conn.execute(text(f"CREATE UNIQUE INDEX {preparer.quote(index_name)} ON {full_table} ({preparer.quote(key)})"))

    def _table_has_column(self, table_name: str, column_name: str) -> bool:
        inspector = inspect(self.engine)
        db_table_name = self._database_table_name(table_name) or table_name
        if not inspector.has_table(db_table_name, schema=self.schema):
            return False
        return any(col["name"] == column_name for col in inspector.get_columns(db_table_name, schema=self.schema))

    def _ensure_table(self, table_name: str, df: pd.DataFrame) -> None:
        inspector = inspect(self.engine)
        if inspector.has_table(table_name, schema=self.schema):
            return
        self.replace_table(table_name, df.head(0) if not df.empty else pd.DataFrame({"id": pd.Series(dtype="Int64")}))
        self.add_primary_key_if_missing(table_name)

    def _quoted_table_name(self, table_name: str) -> str:
        preparer = self.engine.dialect.identifier_preparer
        quoted_table = preparer.quote(self._database_table_name(table_name) or table_name)
        if self.schema:
            return f"{preparer.quote_schema(self.schema)}.{quoted_table}"
        return quoted_table

    def _database_table_name(self, table_name: str) -> str | None:
        inspector = inspect(self.engine)
        table_names = inspector.get_table_names(schema=self.schema)
        if table_name in table_names:
            return table_name
        table_lookup = {name.lower(): name for name in table_names}
        return table_lookup.get(table_name.lower())

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

    def _drop_table_if_exists(self, table_name: str) -> None:
        db_table_name = self._database_table_name(table_name)
        if db_table_name is None:
            return
        preparer = self.engine.dialect.identifier_preparer
        with self.engine.begin() as conn:
            conn.execute(text(f"DROP TABLE IF EXISTS {preparer.quote(db_table_name)}"))

    @staticmethod
    def _clean_for_sql(df: pd.DataFrame) -> pd.DataFrame:
        return DatabaseExporter._clean_for_sql(df)

    @staticmethod
    def _dtype_map(df: pd.DataFrame) -> dict[str, TypeEngine[Any]]:
        return DatabaseExporter._dtype_map(df)


def odoo_incremental_domain(since: datetime | None) -> list[Any]:
    if since is None:
        return []
    value = since.strftime("%Y-%m-%d %H:%M:%S")
    return ["|", ["write_date", ">=", value], ["create_date", ">=", value]]


def crm_incremental_domain(since: datetime | None) -> list[Any]:
    if since is None:
        return [["type", "in", ["lead", "opportunity"]]]
    value = since.strftime("%Y-%m-%d %H:%M:%S")
    return ["&", ["type", "in", ["lead", "opportunity"]], "|", ["write_date", ">=", value], ["create_date", ">=", value]]
