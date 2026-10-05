"""Page-level regression: the revenue-trend page's monthly value per scope, recomputed with the page's own filter
semantics (admin overrides + Unknown-channel inference, backend/src/measures/filters.ts) on the NEW serving views and
on the restored BASELINE tables (legacy codes), whole and inside the comparison window; plus the page as served.

  python scripts/regression/page_totals.py --pages <dir with revenue_trend_overview__<scope>.json> --out <dir>

Read-only. Writes <out>/page_totals.csv.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pandas as pd
from sqlalchemy import create_engine, text

ROOT = Path(__file__).resolve().parents[2]
for p in (ROOT, ROOT / "src"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

from config.settings import Settings  # noqa: E402

from baseline import WINDOW_TABLE  # noqa: E402

# scope -> (dimension, new value, legacy value)
SCOPES = {"all": None, "majaal": ("company", 1, 1), "tika": ("company", 3, 2), "team_mj_est_bb": ("team", "MJ-EST-BB", "MJ-EST-BB"),
          "team_tk_ben_bc_03": ("team", "TK-BEN-BC-03", "TK-BEN-BC-03"), "segment_b2b": ("segment", 1, 1), "channel_retail": ("channel", 3, 3)}
MODELS = {  # table, admin profile table, unknown channel code
    "new": ("v_sales_lines", "salesperson_admin_profile", -1),
    "baseline": ("zz_baseline_fact_saleslines", "zz_baseline_salesperson_admin_profile", 1),
}


def _expr(dim: str, sap: str, unknown_channel: int) -> str:
    seg = f"COALESCE((SELECT s.segment_key_override FROM {sap} s WHERE s.salesperson_key = f.SalespersonKey), f.SegmentKey)"
    if dim == "company":
        return "f.CompanyKey"
    if dim == "team":
        return f"COALESCE((SELECT s.sales_team_key_override FROM {sap} s WHERE s.salesperson_key = f.SalespersonKey), f.SalesTeamKey)"
    if dim == "segment":
        return seg
    return (f"COALESCE((SELECT s.channel_key_override FROM {sap} s WHERE s.salesperson_key = f.SalespersonKey), "
            f"CASE WHEN f.ChannelKey <> {unknown_channel} THEN f.ChannelKey WHEN {seg} IN (2, 3) THEN 3 "
            f"WHEN {seg} IN (1, 4) THEN 2 ELSE {unknown_channel} END)")


def monthly(conn, model: str, scope: str, window: bool) -> dict[str, float]:
    table, sap, unk = MODELS[model]
    conds = ["f.order_date_date BETWEEN '2026-01-01' AND '2026-09-30'"]
    params = {}
    if SCOPES[scope]:
        dim, new_v, legacy_v = SCOPES[scope]
        conds.append(f"{_expr(dim, sap, unk)} = :v")
        params["v"] = new_v if model == "new" else legacy_v
    if window:
        conds.append(f"CAST(f.OdooOrderID AS CHAR) COLLATE utf8mb4_unicode_ci IN (SELECT record_id FROM {WINDOW_TABLE} WHERE fact = 'sales_lines')")
    sql = f"SELECT DATE_FORMAT(f.order_date_date, '%Y-%m') AS m, SUM(f.Value) FROM {table} f WHERE {' AND '.join(conds)} GROUP BY 1"
    return {m: float(v or 0) for m, v in conn.execute(text(sql), params)}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args(argv)
    engine = create_engine(Settings.from_env(None).sqlalchemy_url, future=True)
    rows = []
    with engine.connect() as conn:
        for scope in SCOPES:
            page = json.loads((args.pages / f"revenue_trend_overview__{scope}.json").read_text(encoding="utf-8"))
            served = {f"{int(s['year'])}-{int(s['month']):02d}": float(s["value"] or 0) for s in page["series"]}
            calc = {(m, w): monthly(conn, m, scope, w) for m in MODELS for w in (False, True)}
            for month in sorted(served):
                r = {"scope": scope, "month": month, "page": round(served[month], 3)}
                for (m, w), vals in calc.items():
                    r[f"{m}{'_window' if w else ''}"] = round(vals.get(month, 0.0), 3)
                rows.append(r)
    df = pd.DataFrame(rows)
    df["page_minus_new"] = (df["page"] - df["new"]).round(3)
    df["new_minus_baseline_window"] = (df["new_window"] - df["baseline_window"]).round(3)
    df["new_minus_baseline_whole"] = (df["new"] - df["baseline"]).round(3)
    args.out.mkdir(parents=True, exist_ok=True)
    df.to_csv(args.out / "page_totals.csv", index=False)
    summary = df.groupby("scope")[["page_minus_new", "new_minus_baseline_window", "new_minus_baseline_whole"]].apply(lambda g: g.abs().max())
    print(summary.to_string())
    return 0


if __name__ == "__main__":
    sys.exit(main())
