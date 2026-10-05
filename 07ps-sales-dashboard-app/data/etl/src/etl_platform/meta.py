"""SQLAlchemy definitions of the ``etl_*`` meta tables.

The authoritative DDL is data/warehouse/migrations/0028_etl_platform_meta.sql (and 0022 for etl_run_log);
these definitions mirror it so the code can build statements without reflection and so tests can create the
same tables in SQLite. The platform never creates meta tables in MySQL itself: ``require_meta_tables``
fails the run with "apply migration 0028" instead.
"""

from __future__ import annotations

from sqlalchemy import JSON, BigInteger, Column, DateTime, Float, Integer, MetaData, String, Table, Text, inspect
from sqlalchemy.engine import Engine

metadata = MetaData()

_BIGINT_PK = BigInteger().with_variant(Integer, "sqlite")

# Columns 0022 created, plus job_name / department / parent_run_uid added by 0028.
etl_run_log = Table(
    "etl_run_log",
    metadata,
    Column("run_id", _BIGINT_PK, primary_key=True, autoincrement=True),
    Column("run_uid", String(36), nullable=False, unique=True),
    Column("mode", String(20), nullable=False),
    Column("output_mode", String(10), nullable=True),
    Column("trigger_source", String(64), nullable=False, default="unknown"),
    Column("status", String(20), nullable=False),
    Column("started_at_utc", DateTime, nullable=False),
    Column("finished_at_utc", DateTime, nullable=True),
    Column("duration_seconds", Float, nullable=True),
    Column("watermark_order_date_utc", DateTime, nullable=True),
    Column("watermark_order_created_utc", DateTime, nullable=True),
    Column("watermark_order_number", String(64), nullable=True),
    Column("business_timezone", String(64), nullable=False),
    Column("rows_processed", BigInteger, nullable=True),
    Column("odoo_extract_count", BigInteger, nullable=True),
    Column("qa_issues_count", BigInteger, nullable=True),
    Column("error_message", Text, nullable=True),
    Column("legacy_backfill", Integer, nullable=False, default=0),
    Column("pipeline_run_log_id", BigInteger, nullable=True),
    Column("host", String(128), nullable=True),
    Column("created_at_utc", DateTime, nullable=False),
    Column("job_name", String(64), nullable=True),
    Column("department", String(32), nullable=True),
    Column("parent_run_uid", String(36), nullable=True),
)

etl_task_log = Table(
    "etl_task_log",
    metadata,
    Column("task_log_id", _BIGINT_PK, primary_key=True, autoincrement=True),
    Column("run_uid", String(36), nullable=False, index=True),
    Column("job_name", String(64), nullable=False),
    Column("task_name", String(128), nullable=False),
    Column("status", String(20), nullable=False),
    Column("started_at_utc", DateTime, nullable=False),
    Column("finished_at_utc", DateTime, nullable=True),
    Column("duration_seconds", Float, nullable=True),
    Column("rows_extracted", BigInteger, nullable=True),
    Column("rows_loaded", BigInteger, nullable=True),
    Column("unknown_key_fallbacks", BigInteger, nullable=True),
    Column("fallback_detail", JSON, nullable=True),
    Column("watermark_before", JSON, nullable=True),
    Column("watermark_after", JSON, nullable=True),
    Column("details", JSON, nullable=True),
    Column("error_message", Text, nullable=True),
)

etl_dq_result = Table(
    "etl_dq_result",
    metadata,
    Column("dq_result_id", _BIGINT_PK, primary_key=True, autoincrement=True),
    Column("run_uid", String(36), nullable=False, index=True),
    Column("job_name", String(64), nullable=False),
    Column("task_name", String(128), nullable=True),
    Column("check_name", String(160), nullable=False),
    Column("check_type", String(32), nullable=False),
    Column("severity", String(8), nullable=False),
    Column("target_table", String(128), nullable=True),
    Column("status", String(8), nullable=False),
    Column("observed_value", Float, nullable=True),
    Column("threshold", Float, nullable=True),
    Column("failing_rows", BigInteger, nullable=True),
    Column("sample", JSON, nullable=True),
    Column("message", Text, nullable=True),
    Column("checked_at_utc", DateTime, nullable=False),
)

etl_watermark = Table(
    "etl_watermark",
    metadata,
    Column("dataset", String(128), primary_key=True),
    Column("last_write_date_utc", DateTime, nullable=True),
    Column("last_id", BigInteger, nullable=True),
    Column("last_full_refresh_utc", DateTime, nullable=True),
    Column("last_reconciled_utc", DateTime, nullable=True),
    Column("updated_at_utc", DateTime, nullable=False),
    Column("updated_by_run_uid", String(36), nullable=True),
)

etl_dataset_registry = Table(
    "etl_dataset_registry",
    metadata,
    Column("dataset", String(128), primary_key=True),
    Column("department", String(32), nullable=False),
    Column("layer", String(16), nullable=False),
    Column("source", String(16), nullable=False),
    Column("source_object", String(255), nullable=True),
    Column("target_table", String(128), nullable=False),
    Column("load_pattern", String(32), nullable=False),
    Column("natural_key", JSON, nullable=False),
    Column("incremental_field", String(64), nullable=True),
    Column("definition_hash", String(64), nullable=False),
    Column("first_registered_utc", DateTime, nullable=False),
    Column("updated_at_utc", DateTime, nullable=False),
)

META_TABLES = (etl_run_log, etl_task_log, etl_dq_result, etl_watermark, etl_dataset_registry)
REQUIRED_RUN_LOG_COLUMNS = ("job_name", "department", "parent_run_uid")


class MetaSchemaError(RuntimeError):
    """The database is missing the meta tables/columns this platform needs."""


def create_meta_tables(engine: Engine) -> None:
    """Tests and local SQLite only. Production/staging schema comes from the migrations."""
    metadata.create_all(engine, tables=list(META_TABLES), checkfirst=True)


def require_meta_tables(engine: Engine) -> None:
    insp = inspect(engine)
    existing = {name.lower() for name in insp.get_table_names()}
    missing = [t.name for t in META_TABLES if t.name not in existing]
    if missing:
        raise MetaSchemaError(
            f"Missing ETL meta table(s): {', '.join(missing)}. Apply migrations 0022 and 0028 "
            "(python data/warehouse/apply_migrations.py 0028_etl_platform_meta.sql)."
        )
    run_log_cols = {c["name"].lower() for c in insp.get_columns("etl_run_log")}
    missing_cols = [c for c in REQUIRED_RUN_LOG_COLUMNS if c not in run_log_cols]
    if missing_cols:
        raise MetaSchemaError(
            f"etl_run_log lacks column(s) {', '.join(missing_cols)}. Apply migration 0028_etl_platform_meta.sql."
        )
