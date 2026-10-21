"""5x-daily refresh scheduler - Standards Section 2.1.2/5.14: "A scheduled (non-real-time)
refresh five times per day: 9:00 AM, 12:00 PM, 3:00 PM, 6:00 PM, 9:00 PM, with tolerance of up
to 30 minutes."

Per this session's confirmed choice ("mirror mechanism (A): one persistent scheduler process"),
this reuses the same APScheduler-based design as the existing pipeline's own scheduler.py
(BlockingScheduler + CronTrigger, one process) rather than mechanism (B) (five separate OS-level
Task Scheduler entries) - simpler to run on a Linux VPS (a single systemd unit / supervisor
process / Docker container), where Windows Task Scheduler doesn't exist anyway.

Not the deprecated scheduler.py.deprecated (Task-A placeholder, wired to the wrong
odoo_connector.py/excel_ingest.py modules) - this one calls orchestrator.run_refresh(), which is
the real, validated extraction+transform+star-schema-load path.

RETIRED: the refresh now runs on the production server only (backend node-cron + BullMQ worker -> ETL platform:
30-minute refresh + 02:00 full refresh; docs/etl-refresh-schedule.md). This process refuses to start unless
LEGACY_INGESTION_SCHEDULER_ENABLED=true, so `docker compose --profile legacy up` or a stray `python scheduler.py`
cannot write to the warehouse by accident.
"""
from __future__ import annotations

import logging
import os
import sys

from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.cron import CronTrigger

from orchestrator import run_refresh

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

# Standards Section 2.1.2/5.14 - not configurable via env var deliberately; this is a documented
# business requirement, not an operational tuning knob.
REFRESH_TIMES = ("09:00", "12:00", "15:00", "18:00", "21:00")


def run_scheduled(scheduled_refresh_time: str) -> None:
    logger.info("Starting scheduled refresh for slot %s", scheduled_refresh_time)
    try:
        result = run_refresh(scheduled_refresh_time=scheduled_refresh_time)
        logger.info("Scheduled refresh %s finished: %s", scheduled_refresh_time, result)
    except Exception:
        # run_refresh() already wrote a FAILED row to pipeline_run_log/pipeline_run_audit before
        # re-raising - logging here is just so the failure is visible in this process's own
        # stdout/journal too, not a second attempt to handle it.
        logger.exception("Scheduled refresh %s FAILED - see pipeline_run_log for the recorded row.", scheduled_refresh_time)


def main() -> None:
    if os.getenv("LEGACY_INGESTION_SCHEDULER_ENABLED", "").strip().lower() not in {"1", "true", "yes", "on"}:
        logger.error("Legacy ingestion scheduler is retired and did not start: the refresh runs on the production "
                     "server (docs/etl-refresh-schedule.md). Set LEGACY_INGESTION_SCHEDULER_ENABLED=true to override.")
        sys.exit(0)
    scheduler = BlockingScheduler()
    for t in REFRESH_TIMES:
        hour, minute = t.split(":")
        scheduler.add_job(
            run_scheduled, CronTrigger(hour=hour, minute=minute), args=[t], name=f"refresh-{t}",
            misfire_grace_time=1800,  # 30-minute tolerance per Standards Section 2.1.2
        )
    logger.info("Scheduler started - refresh times: %s", REFRESH_TIMES)
    scheduler.start()


if __name__ == "__main__":
    main()
