"""One-off backfill: normalise the legacy ``pipeline_run_log`` rows into ``etl_run_log`` (UTC).

Why it is needed: legacy rows hold naive DATETIMEs written with the ETL process's own clock (UTC in the
Docker container, local time on a Windows host), and the dashboard used to read them as Libya time. There
is no per-row marker saying which. What IS reliable is ``created_at``: a ``CURRENT_TIMESTAMP`` taken by the
DB server when the row was inserted (~ the end of the run), in the DB server's own time zone -- observed
as UTC+2 (Africa/Tripoli) in production. So the finish instant is taken from ``created_at`` (converted
from ``--legacy-db-timezone``), and ``pipeline_end_time`` is used only for a sanity report.

Run it ONCE, before the first pipeline run that uses the new code (new runs write etl_run_log directly,
and from then on ``created_at`` is UTC because the pipeline pins its DB session to UTC). Safe to re-run:
rows are keyed by a deterministic run_uid derived from the legacy run_id.

    python scripts/backfill_etl_run_log.py --dry-run
    python scripts/backfill_etl_run_log.py

Connection settings come from the same DB_* / DB_URL environment variables as the pipeline.
"""

from __future__ import annotations

import argparse
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ETL_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ETL_ROOT))
sys.path.insert(0, str(ETL_ROOT / "src"))

from sqlalchemy import create_engine, text  # noqa: E402

from sales_pipeline.etl_run_log import etl_run_log, to_naive_utc, to_utc  # noqa: E402

NAMESPACE = uuid.UUID("6f0f1b0e-6d0a-4a3c-9a55-0e7c1f0b7a11")
AUDIT_MATCH_WINDOW = timedelta(minutes=15)


def legacy_status(value: str | None) -> str:
    return "success" if str(value or "").strip().upper() == "SUCCESS" else "failed"


def convert_legacy_row(
    row: dict[str, Any],
    audit_rows: list[dict[str, Any]],
    legacy_db_timezone: str,
    business_timezone: str,
) -> dict[str, Any]:
    """Pure conversion of one pipeline_run_log row (+ the nearest pipeline_run_audit row) to an etl_run_log row."""
    finished_utc = to_utc(row["created_at"], legacy_db_timezone)
    duration_min = row.get("total_duration_minutes")
    started_utc = finished_utc - timedelta(minutes=float(duration_min)) if duration_min is not None else finished_utc

    audit = _nearest_audit(audit_rows, row["created_at"])
    watermark_order = None
    load_mode = "unknown"
    if audit is not None:
        load_mode = str(audit.get("load_mode") or "unknown").lower()
        after = audit.get("latest_order_datetime_after")
        if after is not None:
            # pipeline_run_audit stores the Fact_Orders/Fact_SalesLines watermark as naive business time.
            watermark_order = to_utc(after, business_timezone)

    return {
        "run_uid": str(uuid.uuid5(NAMESPACE, f"pipeline_run_log:{row['run_id']}")),
        "mode": load_mode,
        "output_mode": str(audit.get("output_mode")) if audit else None,
        "trigger_source": "legacy-backfill",
        "status": legacy_status(row.get("status")),
        "started_at_utc": to_naive_utc(started_utc),
        "finished_at_utc": to_naive_utc(finished_utc),
        "duration_seconds": round(float(duration_min) * 60, 3) if duration_min is not None else None,
        # Only a successful run has a meaningful watermark; the created-at watermark was never recorded.
        "watermark_order_date_utc": to_naive_utc(watermark_order) if watermark_order and legacy_status(row.get("status")) == "success" else None,
        "watermark_order_created_utc": None,
        "watermark_order_number": None,
        "business_timezone": business_timezone,
        "rows_processed": row.get("db_loaded_count"),
        "odoo_extract_count": row.get("odoo_extract_count"),
        "qa_issues_count": row.get("qa_issues_count"),
        "error_message": (row.get("error_message") or None) if legacy_status(row.get("status")) == "failed" else None,
        "legacy_backfill": 1,
        "pipeline_run_log_id": row["run_id"],
        "host": None,
        "created_at_utc": to_naive_utc(datetime.now(timezone.utc)),
    }


def inferred_naive_zone_offset_hours(row: dict[str, Any]) -> float | None:
    """created_at - pipeline_end_time in half-hour steps: ~0 => the naive value was DB-local; ~+2 => it was UTC."""
    if row.get("created_at") is None or row.get("pipeline_end_time") is None:
        return None
    return round((row["created_at"] - row["pipeline_end_time"]).total_seconds() / 1800) / 2


def _nearest_audit(audit_rows: list[dict[str, Any]], created_at: datetime) -> dict[str, Any] | None:
    best, best_gap = None, AUDIT_MATCH_WINDOW
    for audit in audit_rows:
        if audit.get("created_at") is None:
            continue
        gap = abs(audit["created_at"] - created_at)
        if gap <= best_gap:
            best, best_gap = audit, gap
    return best


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--legacy-db-timezone", default="Africa/Tripoli", help="Zone the DB server's CURRENT_TIMESTAMP used when the legacy rows were written")
    parser.add_argument("--business-timezone", default=None, help="Zone of the business fact columns (default: TIMEZONE env or Africa/Tripoli)")
    parser.add_argument("--dry-run", action="store_true", help="Print what would be written; change nothing")
    args = parser.parse_args(argv)

    from config.settings import Settings

    settings = Settings.from_env()
    business_tz = args.business_timezone or settings.timezone
    engine = create_engine(settings.sqlalchemy_url, future=True)
    etl_run_log.metadata.create_all(engine, tables=[etl_run_log], checkfirst=True)

    with engine.connect() as conn:
        legacy = [dict(r) for r in conn.execute(text("SELECT * FROM pipeline_run_log ORDER BY run_id")).mappings()]
        try:
            audit = [dict(r) for r in conn.execute(text("SELECT * FROM pipeline_run_audit")).mappings()]
        except Exception:  # noqa: BLE001 - table may not exist on a very old database
            audit = []
        done = {r[0] for r in conn.execute(text("SELECT pipeline_run_log_id FROM etl_run_log WHERE legacy_backfill = 1"))}

    todo = [r for r in legacy if r["run_id"] not in done]
    print(f"{len(legacy)} legacy rows, {len(done)} already backfilled, {len(todo)} to convert (dry_run={args.dry_run})")
    converted = []
    for row in todo:
        out = convert_legacy_row(row, audit, args.legacy_db_timezone, business_tz)
        offset = inferred_naive_zone_offset_hours(row)
        print(
            f"  legacy run {row['run_id']}: {out['status']:<7} finished_at_utc={out['finished_at_utc']} "
            f"(naive pipeline_end_time was {'DB-local' if offset == 0 else f'{offset:+}h from DB-local' if offset is not None else 'unknown'})"
        )
        converted.append(out)

    if converted and not args.dry_run:
        with engine.begin() as conn:
            conn.execute(etl_run_log.insert(), converted)
        print(f"Inserted {len(converted)} rows into etl_run_log")
    return 0


if __name__ == "__main__":
    sys.exit(main())
