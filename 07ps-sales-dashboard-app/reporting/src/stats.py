"""Descriptive & comparative statistics: period-over-period, variance vs.
target, moving averages. One KpiCard per measure, assembled into a scorecard
that anomalies.py, drivers.py, and narrative.py all consume.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field

import pandas as pd

from . import dates, queries

TOLERANCE_PCT = 5.0  # within +/-5% of target = on_track; used consistently below


@dataclass
class KpiCard:
    name: str
    actual: float
    target: float | None = None
    prior_period_actual: float | None = None
    last_year_actual: float | None = None
    unit: str = "value"

    @property
    def variance_vs_target_pct(self) -> float | None:
        if not self.target:
            return None
        return (self.actual - self.target) / self.target * 100

    @property
    def variance_vs_prior_pct(self) -> float | None:
        if not self.prior_period_actual:
            return None
        return (self.actual - self.prior_period_actual) / self.prior_period_actual * 100

    @property
    def variance_vs_last_year_pct(self) -> float | None:
        if not self.last_year_actual:
            return None
        return (self.actual - self.last_year_actual) / self.last_year_actual * 100

    @property
    def status(self) -> str:
        v = self.variance_vs_target_pct
        if v is None:
            return "no_target"
        if v >= -TOLERANCE_PCT:
            return "on_track"
        if v >= -2 * TOLERANCE_PCT:
            return "at_risk"
        return "off_track"


@dataclass
class Scorecard:
    anchor_date: dt.date
    cards: dict[str, KpiCard] = field(default_factory=dict)
    monthly_panel: pd.DataFrame = field(default_factory=pd.DataFrame)
    daily_revenue: pd.DataFrame = field(default_factory=pd.DataFrame)
    exclusions: list = field(default_factory=list)
    unavailable: dict[str, str] = field(default_factory=dict)  # section -> warning message


def _sum_target(engine, window: dates.Window) -> tuple[float, float]:
    t = queries.targets_monthly(engine, window.start.year, window.start.month, window.end.year, window.end.month)
    if t.empty:
        return 0.0, 0.0
    return float(t["target_revenue"].sum()), float(t["target_volume"].sum())


def build_scorecard(engine, anchor_date: dt.date) -> Scorecard:
    sc = Scorecard(anchor_date=anchor_date)

    # ---- Revenue (Tachometer / Revenue Trend / Critical Number) ----
    try:
        ytd_w, mtd_w, lytd_w, lmtd_w = dates.ytd(anchor_date), dates.mtd(anchor_date), dates.lytd(anchor_date), dates.lmtd(anchor_date)
        daily, exclusions = queries.revenue_daily(engine, dates.full_history_start(), anchor_date)
        sc.daily_revenue = daily
        sc.exclusions = exclusions

        def _window_actuals(w: dates.Window) -> tuple[float, float]:
            mask = (daily["date"] >= w.start) & (daily["date"] <= w.end)
            sub = daily[mask]
            return float(sub["value"].sum()), float(sub["volume"].sum())

        ytd_value, ytd_volume = _window_actuals(ytd_w)
        mtd_value, mtd_volume = _window_actuals(mtd_w)
        lytd_value, lytd_volume = _window_actuals(lytd_w)
        lmtd_value, lmtd_volume = _window_actuals(lmtd_w)
        ytd_target_rev, ytd_target_vol = _sum_target(engine, ytd_w)
        mtd_target_rev, mtd_target_vol = _sum_target(engine, mtd_w)

        sc.cards["revenue_ytd"] = KpiCard("YTD Revenue", ytd_value, ytd_target_rev, last_year_actual=lytd_value, unit="currency")
        sc.cards["revenue_mtd"] = KpiCard("MTD Revenue", mtd_value, mtd_target_rev, last_year_actual=lmtd_value, unit="currency")
        sc.cards["volume_ytd"] = KpiCard("YTD Volume", ytd_volume, ytd_target_vol, last_year_actual=lytd_volume, unit="volume")
        sc.cards["asp_ytd"] = KpiCard(
            "YTD ASP", ytd_value / ytd_volume if ytd_volume else 0.0,
            (ytd_target_rev / ytd_target_vol) if ytd_target_vol else None,
            last_year_actual=(lytd_value / lytd_volume) if lytd_volume else None, unit="currency",
        )

        # Critical number: simple daily-pace check -- YTD target / calendar days
        # elapsed vs. actual daily average. This is a simplification of
        # critical_number.ts's full working-day/off-day calendar; documented
        # as such in the report's methodology note.
        days_elapsed = (anchor_date - ytd_w.start).days + 1
        daily_target_pace = ytd_target_rev / days_elapsed if days_elapsed else None
        actual_daily_avg = ytd_value / days_elapsed if days_elapsed else 0.0
        sc.cards["daily_pace"] = KpiCard("Daily Revenue Pace", actual_daily_avg, daily_target_pace, unit="currency")
    except Exception as exc:  # noqa: BLE001
        sc.unavailable["revenue"] = f"Revenue/Tachometer/Critical Number section unavailable: {exc}"

    # ---- Invoices Engine ----
    try:
        ytd_w, lytd_w = dates.ytd(anchor_date), dates.lytd(anchor_date)
        inv_ytd = queries.invoices_summary(engine, ytd_w.start, ytd_w.end)
        inv_lytd = queries.invoices_summary(engine, lytd_w.start, lytd_w.end)
        avg_ytd = float(inv_ytd["invoice_value"].mean()) if not inv_ytd.empty else 0.0
        avg_lytd = float(inv_lytd["invoice_value"].mean()) if not inv_lytd.empty else None
        sc.cards["avg_sales_per_invoice"] = KpiCard("Avg Sales per Invoice", avg_ytd, last_year_actual=avg_lytd, unit="currency")
        sc.cards["invoice_count_ytd"] = KpiCard("YTD Invoice Count", float(len(inv_ytd)), last_year_actual=float(len(inv_lytd)), unit="count")
    except Exception as exc:  # noqa: BLE001
        sc.unavailable["invoices_engine"] = f"Invoices Engine section unavailable: {exc}"

    # ---- Customer Growth ----
    try:
        ytd_w, lytd_w = dates.ytd(anchor_date), dates.lytd(anchor_date)
        cust = queries.customer_dim(engine)
        active_ytd = queries.customers_active_in_period(engine, ytd_w.start, ytd_w.end)
        active_lytd = queries.customers_active_in_period(engine, lytd_w.start, lytd_w.end)
        new_ytd = cust[
            (cust["first_purchase_date"] >= ytd_w.start) & (cust["first_purchase_date"] <= ytd_w.end)
        ]
        sc.cards["total_active_customers_ytd"] = KpiCard(
            "Active Customers YTD", float(len(active_ytd)), last_year_actual=float(len(active_lytd)), unit="count",
        )
        sc.cards["new_customers_ytd"] = KpiCard("New Customers YTD", float(len(new_ytd)), unit="count")
        sc.cards["blocked_customers"] = KpiCard("Blocked Customers (current)", float(cust["is_blocked"].sum()), unit="count")
    except Exception as exc:  # noqa: BLE001
        sc.unavailable["customer_growth"] = f"Customer Growth section unavailable: {exc}"

    # ---- Pipeline Health / Pipeline Trend ----
    try:
        ytd_w, lytd_w = dates.ytd(anchor_date), dates.lytd(anchor_date)
        funnel_ytd = queries.pipeline_funnel(engine, ytd_w.start, ytd_w.end)
        funnel_lytd = queries.pipeline_funnel(engine, lytd_w.start, lytd_w.end)
        for stage in ["leads", "opportunities", "quotations", "sales_orders", "deliveries"]:
            sc.cards[f"pipeline_{stage}_ytd"] = KpiCard(
                f"YTD {stage.replace('_', ' ').title()}", float(funnel_ytd[stage]),
                last_year_actual=float(funnel_lytd[stage]), unit="count",
            )
        opps = queries.opportunities_detail(engine, ytd_w.start, ytd_w.end)
        closed = opps[(opps["is_won"] == 1) | (opps["is_lost"] == 1)]
        win_rate = (closed["is_won"].sum() / len(closed) * 100) if len(closed) else None
        if win_rate is not None:
            sc.cards["win_rate_ytd"] = KpiCard("YTD Win Rate (%)", win_rate, unit="percent")
    except Exception as exc:  # noqa: BLE001
        sc.unavailable["pipeline"] = f"Pipeline Health/Trend section unavailable: {exc}"

    return sc


def monthly_panel(engine, start: dt.date, end: dt.date) -> pd.DataFrame:
    """Merged monthly KPI panel for anomaly detection: revenue value/volume/asp,
    pipeline counts, invoice averages -- all keyed on year_month. Uses the bulk
    grouped-by-month queries (not one query per month) to stay fast over
    several years of history.
    """
    revenue = queries.revenue_monthly(engine, start, end)
    if revenue.empty:
        return revenue

    pipeline = queries.pipeline_funnel_by_month(engine, start, end)
    invoices = queries.invoices_by_month(engine, start, end)

    panel = revenue.merge(pipeline, on="year_month", how="left")
    panel = panel.merge(invoices, on="year_month", how="left")
    panel = panel.sort_values("year_month").reset_index(drop=True)

    for col in ["value", "volume", "asp"]:
        panel[f"{col}_ma3"] = panel[col].rolling(3, min_periods=1).mean()

    return panel
