"""On-hand stock at period ends (migration 0079, product_stock_period_end): the SKU Trend's stock per past period.

The periods are the trend's (backend lib/periods.ts): weeks Saturday..Friday (so a week ends on a Friday), calendar
months and calendar years, in the business time zone (Africa/Tripoli).

* ``period_ends_on(d)``      which periods end on ``d`` ('week' / 'month' / 'year'; empty = not a period end)
* ``needed_period_ends(t)``  the closed period ends the trend shows on ``t``: 12 week ends, 12 month ends, 5 year ends
                             (each window's closed periods plus the one before it, for the first column's change)
* ``snapshot_period_end(conn)``  the ETL step: when the loaded inventory snapshot's date is a period end, upsert its on
                             hand per product + company (one INSERT ... SELECT, source 'snapshot'). Cheap, and a no-op
                             on any other day or before migration 0079 is applied.
The one-time history comes from scripts/backfill_stock_period_end.py (source 'backfill'; never run by the ETL).
"""

from __future__ import annotations

import datetime as _dt
import logging
from typing import Any

from sqlalchemy import inspect, text

log = logging.getLogger(__name__)

TABLE = "product_stock_period_end"
SNAPSHOT_TABLE = "fact_sales_inventory_snapshot"
# The trend's windows (backend lib/periods.ts PERIOD_COUNT): the closed periods of each, plus the one before it.
WINDOW = {"week": 12, "month": 12, "year": 5}


def period_ends_on(d: _dt.date) -> tuple[str, ...]:
    """The periods that end on ``d``: a Friday ends a week (weeks run Saturday..Friday), the last day of a month ends
    the month, 31 December ends the year."""
    out = []
    if d.weekday() == 4:
        out.append("week")
    if (d + _dt.timedelta(days=1)).day == 1:
        out.append("month")
        if d.month == 12:
            out.append("year")
    return tuple(out)


def _week_start(d: _dt.date) -> _dt.date:
    """The Saturday of the week holding ``d`` (backend lib/businessWeek.ts weekStartIso)."""
    return d - _dt.timedelta(days=(d.weekday() + 2) % 7)


def needed_period_ends(today: _dt.date) -> list[_dt.date]:
    """Every closed period end the trend shows on ``today``: for each granularity, the ends of the closed periods of its
    window (the current, in-progress period uses the live on hand) plus the end of the period just before the window."""
    ends: set[_dt.date] = set()
    week_start = _week_start(today)
    for i in range(1, WINDOW["week"] + 1):
        ends.add(week_start - _dt.timedelta(days=7 * (i - 1) + 1))
    month_start = today.replace(day=1)
    for _ in range(WINDOW["month"]):
        month_end = month_start - _dt.timedelta(days=1)
        ends.add(month_end)
        month_start = month_end.replace(day=1)
    for i in range(1, WINDOW["year"] + 1):
        ends.add(_dt.date(today.year - i, 12, 31))
    return sorted(ends)


# The snapshot's own CompanyKey / ProductKey are not the Odoo ids (CompanyKey is 3 on every row, ProductKey -1 on some):
# the product + company come from its ProductCompanyKey ('Majaal|2163') through dim_sales_product_dashboard, exactly how
# the Product Status cards' On Hand is summed (product_dashboard.py _stock, grouped by ProductCompanyKey).
SNAPSHOT_SELECT = f"""
SELECT p.ProductKey AS product_id, p.CompanyKey AS company_id, SUM(COALESCE(s.OnHandQty, 0)) AS qty_on_hand
FROM {SNAPSHOT_TABLE} s
JOIN dim_sales_product_dashboard p ON p.ProductCompanyKey = s.ProductCompanyKey
WHERE s.SnapshotDate = :d AND p.ProductKey > 0 AND p.CompanyKey > 0
GROUP BY p.ProductKey, p.CompanyKey
"""
SNAPSHOT_UPSERT = f"""
INSERT INTO {TABLE} (product_id, company_id, period_end_date, qty_on_hand, source, loaded_at)
SELECT x.product_id, x.company_id, :d, x.qty_on_hand, 'snapshot', UTC_TIMESTAMP() FROM ({SNAPSHOT_SELECT}) x
ON DUPLICATE KEY UPDATE qty_on_hand = VALUES(qty_on_hand), source = 'snapshot', loaded_at = VALUES(loaded_at)
"""


def snapshot_period_end(conn: Any) -> dict[str, Any]:
    """The ETL step: if the inventory snapshot just loaded is dated on a period end, store its on hand for that date.
    Re-runs the same day overwrite the rows, so the day's last refresh wins. Never fails the load."""
    if not inspect(conn).has_table(TABLE):
        return {"skipped": f"{TABLE} not found (apply migration 0079)"}
    raw = conn.execute(text(f"SELECT MAX(SnapshotDate) FROM {SNAPSHOT_TABLE}")).scalar()
    if raw is None:
        return {"skipped": "no inventory snapshot"}
    day = raw if isinstance(raw, _dt.date) and not isinstance(raw, _dt.datetime) else _dt.date.fromisoformat(str(raw)[:10])
    periods = period_ends_on(day)
    if not periods:
        return {"snapshot_date": day.isoformat(), "period_end": False}
    try:
        rows = conn.execute(text(SNAPSHOT_UPSERT), {"d": day}).rowcount
    except Exception as exc:  # noqa: BLE001 - the trend's history must never fail the sales load
        log.warning("%s: on hand of %s not stored: %s", TABLE, day, exc)
        return {"snapshot_date": day.isoformat(), "period_end": list(periods), "error": str(exc)}
    log.info("%s: on hand of %s stored (%s; %s row(s) written)", TABLE, day, "/".join(periods), rows)
    return {"snapshot_date": day.isoformat(), "period_end": list(periods), "rows": int(rows or 0)}
