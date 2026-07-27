"""Rule-based narrative generation -- plain Python templates turning computed
numbers into business-friendly sentences. No external LLM call: every
sentence is built directly from the stats/forecast/anomaly/driver objects,
so nothing here can state a number that wasn't actually computed.
"""
from __future__ import annotations

from . import anomalies as anomalies_mod
from . import drivers as drivers_mod
from . import forecast as forecast_mod
from .stats import KpiCard, Scorecard


def _fmt_currency(v: float) -> str:
    return f"${v:,.0f}"


def _fmt_pct(v: float) -> str:
    return f"{v:+.1f}%"


def executive_summary(sc: Scorecard, revenue_forecast: forecast_mod.ForecastResult, top_gap) -> str:
    sentences = []
    rev = sc.cards.get("revenue_ytd")
    if rev:
        vs_target = (
            f"{_fmt_pct(rev.variance_vs_target_pct)} vs. target" if rev.variance_vs_target_pct is not None
            else "no target on file"
        )
        vs_ly = f", {_fmt_pct(rev.variance_vs_last_year_pct)} vs. the same period last year" if rev.variance_vs_last_year_pct is not None else ""
        sentences.append(
            f"Year-to-date revenue stands at {_fmt_currency(rev.actual)} ({vs_target}{vs_ly})."
        )

    win_rate = sc.cards.get("win_rate_ytd")
    if win_rate:
        sentences.append(f"The sales pipeline is converting opportunities to wins at a {win_rate.actual:.1f}% rate year-to-date.")

    if top_gap:
        sentences.append(
            f"The single largest shortfall against target is {top_gap.salesperson}, "
            f"short by {_fmt_currency(abs(top_gap.gap))} ({abs(top_gap.pct_of_total_gap):.0f}% of the total YTD shortfall)."
        )

    if revenue_forecast.method != "none" and revenue_forecast.point_forecast:
        total_next_30 = sum(revenue_forecast.point_forecast[:30])
        sentences.append(
            f"Based on recent trends, the next 30 days are projected to bring in roughly "
            f"{_fmt_currency(total_next_30)} in revenue ({revenue_forecast.method} model)."
        )

    if not sentences:
        sentences.append("Insufficient data was available to build a full executive summary this period.")

    return " ".join(sentences)


def key_observations(sc: Scorecard, single: list[anomalies_mod.SingleMetricAnomaly], multi: list[anomalies_mod.MultivariateAnomaly]) -> list[str]:
    obs = []
    for key, card in sc.cards.items():
        if card.status == "off_track":
            obs.append(
                f"{card.name} is off track: {_fmt_currency(card.actual) if card.unit == 'currency' else f'{card.actual:,.1f}'} "
                f"vs. a target of {_fmt_currency(card.target) if card.unit == 'currency' else f'{card.target:,.1f}'} "
                f"({_fmt_pct(card.variance_vs_target_pct)})."
            )

    for a in single[:5]:
        direction = "spiked" if a.zscore > 0 else "dropped"
        obs.append(
            f"{a.metric.replace('_', ' ').title()} {direction} unusually in {a.year_month} "
            f"(value {a.value:,.1f}, {abs(a.zscore):.1f} standard deviations from its typical level; {a.severity} severity)."
        )

    for a in multi[:3]:
        obs.append(
            f"{a.year_month} looked unusual across several metrics at once "
            f"(most notably {', '.join(m.replace('_', ' ') for m in a.contributing_metrics)}), "
            f"even though no single metric alone crossed its own threshold."
        )

    if not obs:
        obs.append("No KPI breaches or statistically notable anomalies were flagged this period.")
    return obs


def forecast_outlook(revenue_forecast: forecast_mod.ForecastResult, pipeline_forecast: forecast_mod.ForecastResult, trend_projections: list[forecast_mod.TrendProjection]) -> list[str]:
    lines = []
    if revenue_forecast.method != "none" and revenue_forecast.point_forecast:
        h = revenue_forecast.point_forecast
        lo, hi = revenue_forecast.lower_ci, revenue_forecast.upper_ci
        for label, n in [("30-day", 30), ("60-day", 60), ("90-day", 90)]:
            n = min(n, len(h))
            total = sum(h[:n])
            total_lo, total_hi = sum(lo[:n]), sum(hi[:n])
            lines.append(
                f"{label} revenue outlook: {_fmt_currency(total)}, with an 80% confidence range of "
                f"{_fmt_currency(total_lo)} to {_fmt_currency(total_hi)} ({revenue_forecast.method})."
            )
        lines.append(f"Forecast methodology note: {revenue_forecast.note}")
    else:
        lines.append(f"Revenue forecast unavailable: {revenue_forecast.note}")

    if pipeline_forecast.method != "none" and pipeline_forecast.point_forecast:
        next_val = pipeline_forecast.point_forecast[0]
        lines.append(
            f"New opportunities are projected to be around {next_val:,.0f} next month ({pipeline_forecast.method})."
        )
        lines.append(f"Pipeline forecast methodology note: {pipeline_forecast.note}")

    for proj in trend_projections:
        lines.append(proj.note)

    return lines


def risks_watchlist(sc: Scorecard, single: list[anomalies_mod.SingleMetricAnomaly], bottlenecks: list[drivers_mod.StageBottleneck]) -> list[str]:
    risks = []
    for key, card in sc.cards.items():
        if card.status == "at_risk":
            risks.append(f"{card.name} is at risk of missing target ({_fmt_pct(card.variance_vs_target_pct)}); worth monitoring closely.")

    high_severity = [a for a in single if a.severity == "high"]
    for a in high_severity[:5]:
        risks.append(f"{a.metric.replace('_', ' ').title()} in {a.year_month} was a high-severity statistical outlier -- worth a manual review.")

    for b in bottlenecks:
        if b.conversion_pct < 30:
            risks.append(
                f"The {b.transition} stage is converting at only {b.conversion_pct:.0f}% "
                f"({b.actual_count_out} of {b.actual_count_in}) -- a likely bottleneck."
            )

    for exclusion in sc.exclusions:
        if exclusion.pct_of_total >= 1.0:
            risks.append(
                f"{exclusion.label} accounted for {exclusion.pct_of_total:.1f}% of gross revenue in the "
                f"analysis window ({exclusion.excluded_rows} line items, {_fmt_currency(exclusion.excluded_value)}) "
                f"and was excluded from the baseline calculations above."
            )

    if not risks:
        risks.append("No significant risks flagged this period.")
    return risks


def methodology_note(revenue_forecast: forecast_mod.ForecastResult) -> str:
    return (
        "Methodology: figures are pulled directly from the warehouse (fact_saleslines, "
        "fact_targets, fact_opportunity, fact_sales, fact_lead, fact_delivery, dim_customer). "
        "Blocked customers and off-days are excluded from baseline calculations (impact quantified "
        "in Risks/Watch List below). Anomaly detection uses Z-score/IQR per metric plus IsolationForest "
        "across the monthly panel; with a limited number of historical months, flags are directional "
        "signals rather than statistically certain outliers. Forecasts backtest SARIMAX against Prophet "
        "and keep whichever scores lower on held-out history (see per-forecast notes for which won). "
        "Driver analysis uses either a direct contribution-to-gap ranking (against the dashboard's own "
        "per-salesperson targets) or real SHAP values from a small classifier when enough closed "
        "opportunities exist (>=30) to fit one responsibly. Narrative text below is generated by rule-based "
        "templates from these computed numbers -- no external LLM call is used."
    )
