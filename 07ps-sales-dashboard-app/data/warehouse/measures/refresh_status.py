"""Last Update / Last Refresh Time -- required at the bottom of the Tachometer page.

Manual definitions:
    Last Update       - "the latest Odoo sales invoice date included in the page" /
                        "the latest sales order date included in the page"
    Last Refresh Time - "the time when the page last read and loaded the data"

Same definitions as the backend (backend/src/measures/refreshStatus.ts):

    Last Update       -> MAX(v_sales_orders.OrderDateTime): the latest loaded sales order (business-timezone
                          wall clock), "the latest sales order date included in the page"
    Last Refresh Time -> etl_run_log.finished_at_utc of the most recent SUCCESSFUL SALES run (UTC). Runs of other
                          departments (core_dims, finance) do not count; a failed run is not "when the page last
                          loaded the data". (pipeline_run_log, the legacy log, is retired.)
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional


@dataclass(frozen=True)
class RefreshStatus:
    last_update: Optional[datetime]         # latest loaded sales order datetime
    last_refresh_time: Optional[datetime]   # most recent successful sales run's end time (UTC)


def fetch_last_update(conn) -> Optional[datetime]:
    with conn.cursor() as cur:
        cur.execute("SELECT MAX(OrderDateTime) AS last_update FROM v_sales_orders")
        row = cur.fetchone()
    return row["last_update"] if row else None


def fetch_last_refresh_time(conn) -> Optional[datetime]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT finished_at_utc
            FROM etl_run_log
            WHERE status = 'success'
              AND (department = 'sales' OR (department IS NULL AND mode IN ('full', 'incremental')))
            ORDER BY finished_at_utc DESC
            LIMIT 1
            """
        )
        row = cur.fetchone()
    return row["finished_at_utc"] if row else None


def fetch_refresh_status(conn) -> RefreshStatus:
    return RefreshStatus(
        last_update=fetch_last_update(conn),
        last_refresh_time=fetch_last_refresh_time(conn),
    )
