"""Persistent, UTC-only ETL run log (``etl_run_log`` table in the main database).

What "Last Refresh" means: the ``finished_at_utc`` of the most recent row with ``status = 'success'``.
That row is only flipped to ``success`` AFTER the data load and its validation passed, and the same
transaction that flips it also records the data watermark read back from the target tables -- so the
log can never claim a refresh that did not load data, and a failed run can never advance it.

Timestamp rules (see docs/ETL.md section 8):
  * every ``*_utc`` column holds a UTC wall-clock value (naive DATETIME by MySQL's nature, but always
    written explicitly from a tz-aware UTC datetime -- never CURRENT_TIMESTAMP, so the DB session
    time_zone cannot skew it);
  * business fact columns (Fact_Orders.OrderDateTime / QuotationDate) are naive wall-clock in the
    business timezone (``TIMEZONE`` env, default Africa/Tripoli); they are converted to UTC here.
"""

from __future__ import annotations

import logging
import socket
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import BigInteger, Column, DateTime, Float, Integer, MetaData, String, Table, Text, text
from sqlalchemy.engine import Engine

logger = logging.getLogger(__name__)

TABLE_NAME = "etl_run_log"
STATUS_RUNNING = "running"
STATUS_SUCCESS = "success"
STATUS_FAILED = "failed"

# A `running` row older than this belongs to a process that died without reaching its finally block
# (SIGKILL/OOM). Longer than the 2h MySQL wait_timeout cap on the load-lock connection, so it can
# never reap a run that is genuinely still loading.
STALE_RUNNING_AFTER = timedelta(hours=6)

_metadata = MetaData()
# Authoritative DDL is data/warehouse/migrations/0022_etl_run_log.sql; this definition lets the
# pipeline self-heal on a database where the migration has not been applied yet (same convention as
# DatabaseExporter._ensure_run_log_table) and lets tests run against SQLite.
etl_run_log = Table(
    TABLE_NAME,
    _metadata,
    Column("run_id", BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True),
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
)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def to_utc(value: datetime, business_timezone: str) -> datetime:
    """Tz-aware UTC instant for ``value``.

    A naive value is interpreted as wall-clock in ``business_timezone`` (the convention of every
    business fact column); an aware value is simply converted. DST: an ambiguous wall-clock time
    (clocks going back) resolves to its first occurrence (fold=0) and a non-existent one (clocks
    going forward) is read with the offset in force before the transition -- Africa/Tripoli has no
    DST today, this only matters if TIMEZONE is set to a DST zone.
    """
    if value.tzinfo is None:
        value = value.replace(tzinfo=ZoneInfo(business_timezone))
    return value.astimezone(timezone.utc)


def to_naive_utc(value: datetime, business_timezone: str = "UTC") -> datetime:
    """UTC wall-clock without tzinfo, the form stored in ``*_utc`` DATETIME columns."""
    return to_utc(value, business_timezone).replace(tzinfo=None)


def to_business_naive(value: datetime, business_timezone: str) -> datetime:
    """Naive wall-clock in the business timezone -- what the legacy pipeline_run_* tables hold."""
    return to_utc(value, "UTC").astimezone(ZoneInfo(business_timezone)).replace(tzinfo=None)


@dataclass(frozen=True)
class Watermark:
    """What the target tables actually contain after a load (all UTC, tz-aware, or None if empty)."""

    order_date_utc: datetime | None = None
    order_created_utc: datetime | None = None
    order_number: str | None = None


def _scalar_or_none(conn: Any, sql: str) -> Any:
    """First column of the first row, or None if the statement fails (missing column/table)."""
    try:
        return conn.execute(text(sql)).scalar()
    except Exception as exc:  # noqa: BLE001 - DB-specific "unknown column" errors differ per driver
        logger.warning("Watermark query skipped (%s): %s", sql, exc)
        return None


def read_target_watermark(conn: Any, fact_orders_table: str, business_timezone: str) -> Watermark:
    """MAX(OrderDateTime) / MAX(QuotationDate) of the loaded Fact_Orders, normalised to UTC.

    ``fact_orders_table`` is the already-quoted table name. QuotationDate holds Odoo's
    sale.order.create_date (record creation time), see facts/fact_sales.py.
    """
    order_dt = _scalar_or_none(conn, f"SELECT MAX(OrderDateTime) FROM {fact_orders_table}")
    # Fact_Orders only carries QuotationDate when Fact_Sales had rows to align it with
    # (PowerBISalesPipeline._align_fact_orders_with_fact_sales); on a database whose Fact_Sales is empty the
    # column does not exist, and the created-at watermark is simply unknown (NULL) -- never an error.
    created_dt = _scalar_or_none(conn, f"SELECT MAX(QuotationDate) FROM {fact_orders_table}")
    number_row = conn.execute(
        text(
            f"SELECT order_number FROM {fact_orders_table} WHERE OrderDateTime IS NOT NULL "
            "ORDER BY OrderDateTime DESC, order_number DESC LIMIT 1"
        )
    ).first()

    def _norm(value: Any) -> datetime | None:
        if value is None:
            return None
        if isinstance(value, str):
            value = datetime.fromisoformat(value)
        return to_utc(value, business_timezone)

    return Watermark(
        order_date_utc=_norm(order_dt),
        order_created_utc=_norm(created_dt),
        order_number=str(number_row[0]) if number_row and number_row[0] is not None else None,
    )


class EtlRunLog:
    """Writes one row per pipeline run. Failures here are logged loudly but never mask the run's result."""

    def __init__(self, engine: Engine, business_timezone: str, fact_orders_table: str = "Fact_Orders") -> None:
        self.engine = engine
        self.business_timezone = business_timezone
        self.fact_orders_table = fact_orders_table
        self.run_uid = str(uuid.uuid4())

    def ensure_table(self) -> None:
        _metadata.create_all(self.engine, tables=[etl_run_log], checkfirst=True)

    def start(self, mode: str, output_mode: str, trigger_source: str, started_at: datetime) -> None:
        """Inserts the ``running`` row and abandons rows left ``running`` by a dead process."""
        self.ensure_table()
        now = utc_now()
        with self.engine.begin() as conn:
            conn.execute(
                text(
                    f"UPDATE {TABLE_NAME} SET status = :failed, finished_at_utc = :now, "
                    "error_message = 'Abandoned: process ended without recording a result' "
                    "WHERE status = :running AND started_at_utc < :cutoff"
                ),
                {
                    "failed": STATUS_FAILED,
                    "running": STATUS_RUNNING,
                    "now": to_naive_utc(now),
                    "cutoff": to_naive_utc(now - STALE_RUNNING_AFTER),
                },
            )
            conn.execute(
                etl_run_log.insert().values(
                    run_uid=self.run_uid,
                    mode=mode,
                    output_mode=output_mode,
                    trigger_source=(trigger_source or "unknown")[:64],
                    status=STATUS_RUNNING,
                    started_at_utc=to_naive_utc(started_at),
                    business_timezone=self.business_timezone,
                    legacy_backfill=0,
                    host=socket.gethostname()[:128],
                    created_at_utc=to_naive_utc(now),
                )
            )

    def finish_success(
        self,
        finished_at: datetime,
        started_at: datetime,
        rows_processed: int,
        odoo_extract_count: int,
        qa_issues_count: int,
        pipeline_run_log_id: int | None = None,
    ) -> Watermark:
        """Flips the run to ``success`` and stores the watermark, in ONE transaction.

        The watermark is read back from the target tables inside that transaction, so it is what was
        actually loaded (not what the source said, not what the run intended to load).
        """
        with self.engine.begin() as conn:
            watermark = read_target_watermark(conn, self.fact_orders_table, self.business_timezone)
            conn.execute(
                etl_run_log.update()
                .where(etl_run_log.c.run_uid == self.run_uid)
                .values(
                    status=STATUS_SUCCESS,
                    finished_at_utc=to_naive_utc(finished_at),
                    duration_seconds=round((finished_at - started_at).total_seconds(), 3),
                    watermark_order_date_utc=_naive_or_none(watermark.order_date_utc),
                    watermark_order_created_utc=_naive_or_none(watermark.order_created_utc),
                    watermark_order_number=watermark.order_number,
                    rows_processed=int(rows_processed),
                    odoo_extract_count=int(odoo_extract_count),
                    qa_issues_count=int(qa_issues_count),
                    pipeline_run_log_id=pipeline_run_log_id,
                    error_message=None,
                )
            )
        return watermark

    def finish_failed(self, finished_at: datetime, started_at: datetime, error: str, data_loaded: bool = False) -> None:
        """Marks the run failed; never counts as a refresh ("Last Refresh" only follows ``success`` rows).

        ``data_loaded=True`` means the run failed AFTER its tables were written (e.g. a validation step):
        the watermark of what is now in the tables is recorded on the failed row, so the dashboard can
        tell "data newer than the last success, explained by this failed run" apart from data that no
        run accounts for. Otherwise the watermark columns stay empty.
        """
        values: dict[str, Any] = {
            "status": STATUS_FAILED,
            "finished_at_utc": to_naive_utc(finished_at),
            "duration_seconds": round((finished_at - started_at).total_seconds(), 3),
            "error_message": (error or "")[:60000],
        }
        with self.engine.begin() as conn:
            if data_loaded:
                try:
                    watermark = read_target_watermark(conn, self.fact_orders_table, self.business_timezone)
                    values.update(
                        watermark_order_date_utc=_naive_or_none(watermark.order_date_utc),
                        watermark_order_created_utc=_naive_or_none(watermark.order_created_utc),
                        watermark_order_number=watermark.order_number,
                    )
                except Exception as exc:  # noqa: BLE001 - the failure itself must still be recorded
                    logger.warning("Could not read the watermark for a failed-after-load run: %s", exc)
            conn.execute(etl_run_log.update().where(etl_run_log.c.run_uid == self.run_uid).values(**values))


def _naive_or_none(value: datetime | None) -> datetime | None:
    return value.astimezone(timezone.utc).replace(tzinfo=None) if value is not None else None
