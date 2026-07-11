"""Last Update / Last Refresh Time -- required at the bottom of the Tachometer page.

Manual definitions:
    Last Update       - "the latest Odoo sales invoice date included in the page" /
                        "the latest sales order date included in the page"
    Last Refresh Time - "the time when the page last read and loaded the data"

Both are queryable from the existing audit schema (data/warehouse/migrations/0007_etl_and_audit_
log.sql), no new tables needed:

    Last Update       -> MAX(fact_order.order_datetime)
                          (fact_order is the confirmed-order fact; order_datetime is the real
                          Odoo order timestamp the pipeline loads -- this is "the latest sales
                          order date included in the page" exactly as the manual defines it)
    Last Refresh Time -> pipeline_run_log.pipeline_end_time for the most recent row with
                          status = 'SUCCESS', not simply the most recent row regardless of status
                          -- a failed run's timestamp is not "when the page last loaded the data"
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional


@dataclass(frozen=True)
class RefreshStatus:
    last_update: Optional[datetime]         # latest loaded sales order datetime
    last_refresh_time: Optional[datetime]   # most recent successful pipeline run's end time


def fetch_last_update(conn) -> Optional[datetime]:
    with conn.cursor() as cur:
        cur.execute("SELECT MAX(order_datetime) AS last_update FROM fact_order")
        row = cur.fetchone()
    return row["last_update"] if row else None


def fetch_last_refresh_time(conn) -> Optional[datetime]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT pipeline_end_time
            FROM pipeline_run_log
            WHERE status = 'SUCCESS'
            ORDER BY pipeline_end_time DESC
            LIMIT 1
            """
        )
        row = cur.fetchone()
    return row["pipeline_end_time"] if row else None


def fetch_refresh_status(conn) -> RefreshStatus:
    return RefreshStatus(
        last_update=fetch_last_update(conn),
        last_refresh_time=fetch_last_refresh_time(conn),
    )
