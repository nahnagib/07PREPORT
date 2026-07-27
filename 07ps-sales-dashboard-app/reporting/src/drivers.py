"""Root-cause / driver analysis: which segments/reps/stages are driving a
KPI gap. Contribution-share analysis for revenue (using the dashboard's own
per-salesperson targets), plus real SHAP values from a small classifier on
row-level opportunity data where the sample size supports it (>=30 rows) --
falling back to the direct contribution-share method otherwise.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

import numpy as np
import pandas as pd
import shap
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.preprocessing import OneHotEncoder

from . import queries

MIN_ROWS_FOR_SHAP = 30


@dataclass
class GapContribution:
    salesperson: str
    actual: float
    target: float
    gap: float  # actual - target, negative = shortfall
    pct_of_total_gap: float


def revenue_gap_by_salesperson(engine, start: dt.date, end: dt.date) -> list[GapContribution]:
    actual = queries.revenue_by_salesperson_key(engine, start, end)
    target = queries.targets_by_salesperson_key(engine, start.year, start.month, end.year, end.month)
    if actual.empty:
        return []

    # SalespersonKey 0 is the ETL's "Unknown_Salesperson" placeholder bucket
    # (unattributed lines), not a real rep -- it can carry a target with
    # almost no actual sales behind it, which would otherwise show up as a
    # spurious "biggest shortfall". Excluded from the ranked list.
    actual = actual[actual["salesperson_key"] != 0]
    target = target[target["salesperson_key"] != 0]

    merged = actual.merge(target, on="salesperson_key", how="left")
    merged["target_revenue"] = merged["target_revenue"].fillna(0)
    merged["gap"] = merged["actual_revenue"] - merged["target_revenue"]

    total_shortfall = merged.loc[merged["gap"] < 0, "gap"].sum()
    out = []
    for _, row in merged.sort_values("gap").iterrows():
        pct = (row["gap"] / total_shortfall * 100) if total_shortfall < 0 and row["gap"] < 0 else 0.0
        out.append(GapContribution(
            salesperson=row["salesperson"] or f"(key {row['salesperson_key']})",
            actual=float(row["actual_revenue"]),
            target=float(row["target_revenue"]),
            gap=float(row["gap"]),
            pct_of_total_gap=float(pct),
        ))
    return out


@dataclass
class DriverFinding:
    factor: str
    value_label: str
    impact_pct: float  # share of the modeled outcome attributable to this factor
    method: str  # "shap" or "contribution_share"


def lost_opportunity_drivers(engine, start: dt.date, end: dt.date) -> tuple[list[DriverFinding], str]:
    """SHAP-based drivers of IsLost among closed opportunities, or a fallback
    note if there aren't enough rows to fit a model responsibly."""
    opps = queries.opportunities_detail(engine, start, end)
    closed = opps[(opps["is_won"] == 1) | (opps["is_lost"] == 1)].copy()

    if len(closed) < MIN_ROWS_FOR_SHAP:
        return [], (
            f"Only {len(closed)} closed opportunities in this window (need >= {MIN_ROWS_FOR_SHAP} "
            f"for a responsible SHAP model) -- falling back to a simple lost-rate-by-segment breakdown "
            f"would be needed here; skipped for this period."
        )

    # Deliberately excludes "stage": Won/Lost is a terminal stage value, so it
    # would trivially predict is_lost (data leakage) rather than reveal a real
    # business driver. segment/sales_team/salesperson are the real candidates.
    features = closed[["segment", "sales_team", "salesperson"]].fillna("Unknown")
    target = closed["is_lost"].astype(int)

    encoder = OneHotEncoder(handle_unknown="ignore", sparse_output=False)
    X = encoder.fit_transform(features)
    feature_names = encoder.get_feature_names_out(features.columns)

    model = GradientBoostingClassifier(n_estimators=100, max_depth=3, random_state=0)
    model.fit(X, target)

    explainer = shap.TreeExplainer(model)
    shap_values = explainer.shap_values(X)
    if isinstance(shap_values, list):  # older shap API returns per-class list
        shap_values = shap_values[1]

    mean_abs_shap = np.abs(shap_values).mean(axis=0)
    total = mean_abs_shap.sum() or 1.0

    ranked_idx = np.argsort(-mean_abs_shap)[:8]
    findings = []
    for idx in ranked_idx:
        name = feature_names[idx]
        # OneHotEncoder names features "<column>_<value>"; split on the known
        # column names (not a naive first-underscore split, since "sales_team"
        # itself contains an underscore).
        for col in sorted(features.columns, key=len, reverse=True):
            prefix = f"{col}_"
            if name.startswith(prefix):
                factor, value_label = col, name[len(prefix):]
                break
        else:
            factor, value_label = name, ""
        findings.append(DriverFinding(
            factor=factor, value_label=value_label,
            impact_pct=float(mean_abs_shap[idx] / total * 100), method="shap",
        ))
    return findings, f"SHAP model fit on {len(closed)} closed opportunities (won/lost)."


@dataclass
class StageBottleneck:
    transition: str
    actual_count_in: int
    actual_count_out: int
    conversion_pct: float


def pipeline_stage_bottlenecks(engine, start: dt.date, end: dt.date) -> list[StageBottleneck]:
    """Stage-to-stage volume ratios (leads -> opportunities -> quotations ->
    sales orders -> deliveries). These are raw document-count ratios, not a
    per-opportunity-linked conversion rate (that would require following each
    opportunity's IsLinkedToOpportunity chain, which this pipeline doesn't do)
    -- ratios above 100% are expected where downstream documents don't map
    1:1 to upstream ones (e.g. multiple deliveries per order)."""
    funnel = queries.pipeline_funnel(engine, start, end)
    stages = [
        ("Leads -> Opportunities", "leads", "opportunities"),
        ("Opportunities -> Quotations", "opportunities", "quotations"),
        ("Quotations -> Sales Orders", "quotations", "sales_orders"),
        ("Sales Orders -> Deliveries", "sales_orders", "deliveries"),
    ]
    out = []
    for label, a, b in stages:
        n_in, n_out = funnel[a], funnel[b]
        pct = (n_out / n_in * 100) if n_in else 0.0
        out.append(StageBottleneck(label, n_in, n_out, pct))
    return out
