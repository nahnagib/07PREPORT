"""Tachometer page metric definitions.

Every metric in the manual's KPI table, mapped to its exact warehouse source:

    Metric                  | Source table(s)                        | How
    ------------------------|-----------------------------------------|---------------------------
    YTD/MTD Value           | fact_order (order_value)                 | SUM over the date window,
    YTD/MTD Volume          | fact_order (order_volume)                | joined to dim_date on
                            |                                           | date_key, filtered by the
                            |                                           | five filter columns
    ASP (YTD/MTD)           | derived                                  | Value / Volume (Python,
                            |                                           | not SQL -- avoids a
                            |                                           | divide-by-zero in SQL)
    LYTD/LMTD               | fact_order                                | same query, prior-year
                            |                                           | date window
                            |                                           | (filters.lytd_window /
                            |                                           | lmtd_window)
    FLY/FLM                 | fact_order                                | same query, full prior
                            |                                           | calendar year/month window
    FY/FM Target            | fact_target_plan (target_revenue,         | SUM grouped by
                            | target_volume)                            | target_year/target_month
                            |                                           | (NOT date_key -- see
                            |                                           | KNOWN_ISSUES.md; date_key
                            |                                           | is broken for 12 rows)
    Target-to-date          | fact_target_plan, prorated in Python      | see filters.py's
    (grey needle reference) | (filters.prorate_mtd_target /             | prorate_mtd_target /
                            | prorate_ytd_target)                       | prorate_ytd_target

fact_order vs. fact_order_line for Value/Volume
--------------------------------------------------
Value/Volume use fact_order, not fact_order_line. fact_order is the order-HEADER revenue fact (one
row per confirmed order, order_value/order_volume already at the order grain the manual's "Total
sales revenue"/"Total quantity sold per unit" describes). fact_order_line is invoice-LINE grain
(one row per invoice line item, with its own invoice_value/invoice_class/discount fields) built for
the Invoices Engine page's per-invoice efficiency metrics, a different page with a different
question ("how many lines/how much per invoice"), not "how much did we sell." Using fact_order_line
here would double-count orders with multiple lines.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Optional

from classify import TargetStatus, classify_vs_target, variance_pct
from filters import (
    DateWindow,
    Filters,
    build_where_clause,
    flm_window,
    fly_window,
    lmtd_window,
    lytd_window,
    mtd_window,
    prorate_mtd_target,
    prorate_ytd_target,
    ytd_window,
)


@dataclass(frozen=True)
class ValueVolume:
    value: float
    volume: float

    @property
    def asp(self) -> Optional[float]:
        if self.volume in (0, None):
            return None
        return self.value / self.volume


@dataclass(frozen=True)
class TargetFigures:
    target_revenue: float
    target_volume: float


def fetch_value_volume(conn, window: DateWindow, filters: Filters) -> ValueVolume:
    """Value/Volume summed from fact_order for a date window + filter selection."""
    where_filters, params = build_where_clause(filters, table_alias="fo")
    sql = f"""
        SELECT
            COALESCE(SUM(fo.order_value), 0)  AS value,
            COALESCE(SUM(fo.order_volume), 0) AS volume
        FROM fact_order fo
        JOIN dim_date dd ON fo.date_key = dd.date_key
        WHERE dd.calendar_date BETWEEN %s AND %s
          AND {where_filters}
    """
    with conn.cursor() as cur:
        cur.execute(sql, [window.start, window.end, *params])
        row = cur.fetchone()
    return ValueVolume(value=float(row["value"]), volume=float(row["volume"]))


def fetch_target_for_months(
    conn, year: int, filters: Filters, month: Optional[int] = None,
    month_lt: Optional[int] = None,
) -> TargetFigures:
    """Sum fact_target_plan.target_revenue/target_volume for a given target_year, optionally
    narrowed to one target_month (month=) or "months strictly before" (month_lt=), used by the
    YTD proration helper to sum already-completed months. Filters by target_year/target_month,
    NOT date_key -- see module docstring and KNOWN_ISSUES.md for why."""
    where_filters, params = build_where_clause(filters, table_alias="ftp")
    conditions = ["ftp.target_year = %s"]
    query_params = [year, *params]
    if month is not None:
        conditions.append("ftp.target_month = %s")
        query_params.insert(1, month)
    elif month_lt is not None:
        conditions.append("ftp.target_month < %s")
        query_params.insert(1, month_lt)

    sql = f"""
        SELECT
            COALESCE(SUM(ftp.target_revenue), 0) AS target_revenue,
            COALESCE(SUM(ftp.target_volume), 0)  AS target_volume
        FROM fact_target_plan ftp
        WHERE {' AND '.join(conditions)} AND {where_filters}
    """
    with conn.cursor() as cur:
        cur.execute(sql, query_params)
        row = cur.fetchone()
    return TargetFigures(
        target_revenue=float(row["target_revenue"]), target_volume=float(row["target_volume"])
    )


@dataclass(frozen=True)
class TachometerCard:
    """Everything one tachometer/ASP card needs to render, for one metric family (Value or
    Volume) at one granularity (MTD or YTD)."""

    actual: float
    target_to_date: Optional[float]
    status: TargetStatus
    variance_pct: Optional[float]
    last_year_same_period: float          # LYTD or LMTD
    full_last_period_actual: float        # FLY or FLM
    full_period_target: float             # FY Target or FM Target


def compute_mtd_card(conn, anchor: date, filters: Filters, metric: str) -> TachometerCard:
    """metric: 'value' or 'volume'."""
    return _compute_card(
        conn, anchor, filters, metric,
        current_window=mtd_window(anchor),
        last_year_window=lmtd_window(anchor),
        full_last_period_window=flm_window(anchor),
        target_to_date_fn=_mtd_target_to_date,
        full_period_target_fn=lambda c, a, f: fetch_target_for_months(
            c, a.year, f, month=a.month
        ),
    )


def compute_ytd_card(conn, anchor: date, filters: Filters, metric: str) -> TachometerCard:
    return _compute_card(
        conn, anchor, filters, metric,
        current_window=ytd_window(anchor),
        last_year_window=lytd_window(anchor),
        full_last_period_window=fly_window(anchor),
        target_to_date_fn=_ytd_target_to_date,
        full_period_target_fn=lambda c, a, f: fetch_target_for_months(c, a.year, f),
    )


def _mtd_target_to_date(conn, anchor: date, filters: Filters) -> TargetFigures:
    fm = fetch_target_for_months(conn, anchor.year, filters, month=anchor.month)
    return TargetFigures(
        target_revenue=prorate_mtd_target(fm.target_revenue, anchor) or 0,
        target_volume=prorate_mtd_target(fm.target_volume, anchor) or 0,
    )


def _ytd_target_to_date(conn, anchor: date, filters: Filters) -> TargetFigures:
    completed = fetch_target_for_months(conn, anchor.year, filters, month_lt=anchor.month)
    current_month = fetch_target_for_months(conn, anchor.year, filters, month=anchor.month)
    return TargetFigures(
        target_revenue=prorate_ytd_target(
            completed.target_revenue, current_month.target_revenue, anchor
        )
        or 0,
        target_volume=prorate_ytd_target(
            completed.target_volume, current_month.target_volume, anchor
        )
        or 0,
    )


def _compute_card(
    conn, anchor, filters, metric, current_window, last_year_window, full_last_period_window,
    target_to_date_fn, full_period_target_fn,
) -> TachometerCard:
    current = fetch_value_volume(conn, current_window, filters)
    last_year = fetch_value_volume(conn, last_year_window, filters)
    full_last_period = fetch_value_volume(conn, full_last_period_window, filters)
    target_to_date = target_to_date_fn(conn, anchor, filters)
    full_period_target = full_period_target_fn(conn, anchor, filters)

    if metric == "value":
        actual = current.value
        target_to_date_value = target_to_date.target_revenue
        full_target_value = full_period_target.target_revenue
        last_year_value = last_year.value
        full_last_value = full_last_period.value
    elif metric == "volume":
        actual = current.volume
        target_to_date_value = target_to_date.target_volume
        full_target_value = full_period_target.target_volume
        last_year_value = last_year.volume
        full_last_value = full_last_period.volume
    else:
        raise ValueError(f"metric must be 'value' or 'volume', got {metric!r}")

    return TachometerCard(
        actual=actual,
        target_to_date=target_to_date_value,
        status=classify_vs_target(actual, target_to_date_value),
        variance_pct=variance_pct(actual, target_to_date_value),
        last_year_same_period=last_year_value,
        full_last_period_actual=full_last_value,
        full_period_target=full_target_value,
    )


@dataclass(frozen=True)
class AspCard:
    actual_asp: float | None
    target_asp: float | None
    status: TargetStatus


def compute_asp_card(value_volume: ValueVolume, target_figures: TargetFigures) -> AspCard:
    """ASP cards use the same classify_vs_target logic as the tachometers (manual: 'ASP cards use
    the same color logic as the tachometers'). Target ASP = Full Year/Month Target's own
    Target_Revenue/Target_Volume ratio, i.e. the target's implied ASP, not the actual period's
    volume mixed with the target's revenue."""
    actual_asp = value_volume.asp
    target_asp = (
        target_figures.target_revenue / target_figures.target_volume
        if target_figures.target_volume
        else None
    )
    return AspCard(
        actual_asp=actual_asp,
        target_asp=target_asp,
        status=classify_vs_target(actual_asp, target_asp),
    )
