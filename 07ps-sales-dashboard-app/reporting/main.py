#!/usr/bin/env python
"""Sales Predictive Report -- CLI entry point.

Pulls data straight from the warehouse (reusing backend/.env's DB
credentials), computes stats/forecasts/anomalies/drivers, writes a rule-based
narrative, and renders a management-ready .docx.

Usage:
    python main.py [--date YYYY-MM-DD] [--horizon-days 90] [--output-dir ./output]
"""
from __future__ import annotations

import argparse
import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from src import anomalies, db, dates, drivers, forecast, narrative, report, stats


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--date", type=str, default=None, help="Anchor date YYYY-MM-DD (default: today)")
    parser.add_argument("--horizon-days", type=int, default=90, help="Revenue forecast horizon in days (default: 90)")
    parser.add_argument("--output-dir", type=str, default="./output", help="Where to write the report (default: ./output)")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    anchor_date = dt.date.fromisoformat(args.date) if args.date else dt.date.today()
    output_dir = Path(__file__).resolve().parent / args.output_dir.lstrip("./").lstrip(".\\")
    if Path(args.output_dir).is_absolute():
        output_dir = Path(args.output_dir)

    print(f"=== Sales Predictive Report: anchor date {anchor_date.isoformat()} ===")

    print("\n[1/6] Connecting to warehouse...")
    engine = db.get_engine()

    print("[2/6] Building KPI scorecard (period-over-period, variance vs target)...")
    sc = stats.build_scorecard(engine, anchor_date)
    for section, msg in sc.unavailable.items():
        print(f"  [WARNING] {msg}")

    print("[3/6] Building monthly panel + forecasts...")
    panel = stats.monthly_panel(engine, dates.full_history_start(), anchor_date)
    revenue_forecast = forecast.forecast_daily_revenue(sc.daily_revenue, horizon_days=args.horizon_days)
    print(f"  Revenue forecast: {revenue_forecast.method} -- {revenue_forecast.note}")
    pipeline_forecast = forecast.forecast_monthly_series(panel, "opportunities", months_ahead=3)
    print(f"  Pipeline forecast: {pipeline_forecast.method} -- {pipeline_forecast.note}")
    trend_projections = []
    for col in ["invoice_count", "leads"]:
        if col in panel.columns:
            trend_projections.append(forecast.project_directional_trend(panel, col))

    print("[4/6] Running anomaly detection...")
    single_anomalies = anomalies.single_metric_anomalies(panel)
    multi_anomalies = anomalies.multivariate_anomalies(panel)
    print(f"  {len(single_anomalies)} single-metric flags, {len(multi_anomalies)} multivariate flags")

    print("[5/6] Running driver analysis...")
    ytd = dates.ytd(anchor_date)
    try:
        gap_contributions = drivers.revenue_gap_by_salesperson(engine, ytd.start, ytd.end)
    except Exception as exc:  # noqa: BLE001
        print(f"  [WARNING] Revenue gap analysis unavailable: {exc}")
        gap_contributions = []
    try:
        shap_findings, shap_note = drivers.lost_opportunity_drivers(engine, dates.full_history_start(), anchor_date)
    except Exception as exc:  # noqa: BLE001
        print(f"  [WARNING] Lost-opportunity driver analysis unavailable: {exc}")
        shap_findings, shap_note = [], f"Unavailable: {exc}"
    try:
        bottlenecks = drivers.pipeline_stage_bottlenecks(engine, ytd.start, ytd.end)
    except Exception as exc:  # noqa: BLE001
        print(f"  [WARNING] Pipeline bottleneck analysis unavailable: {exc}")
        bottlenecks = []

    print("[6/6] Generating narrative + building report...")
    top_gap = min(gap_contributions, key=lambda g: g.gap) if gap_contributions else None
    exec_summary = narrative.executive_summary(sc, revenue_forecast, top_gap)
    observations = narrative.key_observations(sc, single_anomalies, multi_anomalies)
    outlook_lines = narrative.forecast_outlook(revenue_forecast, pipeline_forecast, trend_projections)
    risks = narrative.risks_watchlist(sc, single_anomalies, bottlenecks)
    methodology = narrative.methodology_note(revenue_forecast)

    report_path = output_dir / f"Sales_Predictive_Report_{anchor_date.isoformat()}.docx"
    report.build_report(
        output_path=report_path,
        chart_dir=output_dir / "charts",
        anchor_date=anchor_date,
        sc=sc,
        revenue_forecast=revenue_forecast,
        pipeline_forecast=pipeline_forecast,
        monthly_panel=panel,
        exec_summary=exec_summary,
        observations=observations,
        outlook_lines=outlook_lines,
        risks=risks,
        gap_contributions=gap_contributions,
        shap_findings=shap_findings,
        shap_note=shap_note,
        bottlenecks=bottlenecks,
        methodology=methodology,
    )

    print(f"\nReport written to {report_path}")


if __name__ == "__main__":
    main()
