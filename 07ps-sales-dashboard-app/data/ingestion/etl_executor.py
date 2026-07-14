"""Bridges the Flask ETL API (app.py) to the two real pipeline entry points. No business logic
lives here - it only adds job bookkeeping (job_id, timestamps) around orchestrator.run_refresh()
and load_real_export.load_export(), and turns their return values/exceptions into plain dicts the
routes can jsonify.

There is deliberately no "customers only" / "sales only" / "incremental" mode here: the vendored
pipeline always does a full delete-then-insert load per table (see orchestrator.py's docstring and
star_schema/loader.py) - there is no partial-refresh capability to expose.
"""
from __future__ import annotations

import datetime
import logging
import os
import uuid
from typing import Any

import pymysql

logger = logging.getLogger(__name__)


def _db_connect() -> pymysql.connections.Connection:
    return pymysql.connect(
        host=os.environ.get("DB_HOST", "localhost"),
        port=int(os.environ.get("DB_PORT", "3306")),
        user=os.environ.get("DB_USER", "root"),
        password=os.environ.get("DB_PASSWORD", ""),
        database=os.environ.get("DB_NAME", "ps_warehouse"),
        unix_socket=os.environ.get("DB_SOCKET") or None,
        connect_timeout=5,
    )


def check_db_connection() -> bool:
    """Used by GET /health - no auth required, so this must never touch anything beyond a
    connect/close."""
    try:
        conn = _db_connect()
        conn.close()
        return True
    except Exception:
        logger.exception("DB connection check failed")
        return False


def run_full_refresh() -> dict[str, Any]:
    """Runs orchestrator.run_refresh(): Odoo extract -> vendored transform/transform_crm -> star
    schema load -> pipeline_run_log/pipeline_run_audit rows. Imported lazily so a broken pipeline
    import doesn't prevent the Flask app (and its /health endpoint) from starting at all.
    """
    from orchestrator import run_refresh

    job_id = str(uuid.uuid4())
    started_at = datetime.datetime.utcnow()
    result = run_refresh()
    return {"job_id": job_id, "started_at": started_at.isoformat() + "Z", **result}


def load_export(xlsx_path: str) -> dict[str, Any]:
    """Runs load_real_export.load_export(): loads one already-produced SalesModel_OneOutput.xlsx
    workbook directly into the star schema, bypassing Odoo entirely. Raises ValueError (via the
    wrapped function) on a bad path or missing sheets - the route turns that into an HTTP 400.
    """
    from load_real_export import load_export as _load_export

    job_id = str(uuid.uuid4())
    started_at = datetime.datetime.utcnow()
    report = _load_export(xlsx_path)
    return {
        "job_id": job_id,
        "started_at": started_at.isoformat() + "Z",
        "clean": report.clean,
        "inserted": report.inserted,
        "skipped": report.skipped,
        "total_errors": report.total_errors,
        "errors": {table: [msg for _, msg in errs[:5]] for table, errs in report.errors.items()},
    }
