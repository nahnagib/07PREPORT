"""Compares a receivable snapshot with Odoo's Accounting -> Reporting -> Aged Receivable export (XLSX) for the same
date: per customer and per Odoo aging column, for one company.

  python scripts/finance/compare_aged_receivable.py EXPORT.xlsx --company 1 --date 2026-10-04 --out <dir>

Odoo's report groups open receivable journal items by partner and ages them by due date (date_maturity) into
"Not due" (or "At Date"), 1-30, 31-60, 61-90, 91-120, Older and Total. The snapshot is re-aged into the SAME columns
from days_past_due (due today = Not due), so the comparison does not depend on our own 8 buckets.
Customers are matched by name (the export has no ids): our CustomerKey is the commercial partner, Odoo prints the
line partner -- the same partner for receivable lines in practice; unmatched names are listed, never forced.
Inter-company rows are INCLUDED here (the report includes them; the v_finance_* views do not).
Writes <out>/aged_receivable_<company>_<date>.csv (every customer, both sides, deltas) and prints a summary. Read-only.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import pandas as pd
from sqlalchemy import create_engine, text

ROOT = Path(__file__).resolve().parents[2]
for p in (ROOT, ROOT / "src"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

from config.settings import Settings  # noqa: E402

COLUMNS = ["not_due", "d1_30", "d31_60", "d61_90", "d91_120", "older", "total"]
HEADER_PATTERNS = [("not_due", r"not\s*due|at\s*date|current"), ("d1_30", r"\b1\s*-\s*30\b"), ("d31_60", r"31\s*-\s*60"),
                   ("d61_90", r"61\s*-\s*90"), ("d91_120", r"91\s*-\s*120"), ("older", r"older|\+\s*120|120\s*\+"), ("total", r"^\s*total\s*$")]
TOLERANCE = 0.01


def _norm(name) -> str:
    return re.sub(r"\s+", " ", str(name or "")).strip().casefold()


def read_export(path: Path) -> pd.DataFrame:
    raw = pd.read_excel(path, header=None, dtype=object)
    header_row, mapping = None, {}
    for i, row in raw.iterrows():
        found = {}
        for j, cell in row.items():
            for key, pattern in HEADER_PATTERNS:
                if isinstance(cell, str) and re.search(pattern, cell.strip(), re.I) and key not in found:
                    found[key] = j
        if "total" in found and len(found) >= 4:
            header_row, mapping = i, found
            break
    if header_row is None:
        raise ValueError(f"{path}: no header row with the Aged Receivable columns (Not due / 1-30 / ... / Total)")
    rows = []
    for _, row in raw.iloc[header_row + 1:].iterrows():
        name = row.iloc[0]
        if not isinstance(name, str) or not name.strip():
            continue
        if _norm(name) == "total":
            break
        vals = {k: pd.to_numeric(row.iloc[j], errors="coerce") for k, j in mapping.items()}
        rows.append({"customer": name.strip(), **{k: float(vals.get(k) or 0.0) for k in COLUMNS}})
    df = pd.DataFrame(rows)
    return df.groupby("customer", as_index=False)[COLUMNS].sum()


def read_snapshot(engine, company: int, snapshot_key: int) -> pd.DataFrame:
    sql = text(f"""
        SELECT COALESCE(cu.customer, '(no partner)') AS customer, f.CustomerKey,
               SUM(CASE WHEN f.days_past_due <= 0 THEN f.residual_company_ccy ELSE 0 END) AS not_due,
               SUM(CASE WHEN f.days_past_due BETWEEN 1 AND 30 THEN f.residual_company_ccy ELSE 0 END) AS d1_30,
               SUM(CASE WHEN f.days_past_due BETWEEN 31 AND 60 THEN f.residual_company_ccy ELSE 0 END) AS d31_60,
               SUM(CASE WHEN f.days_past_due BETWEEN 61 AND 90 THEN f.residual_company_ccy ELSE 0 END) AS d61_90,
               SUM(CASE WHEN f.days_past_due BETWEEN 91 AND 120 THEN f.residual_company_ccy ELSE 0 END) AS d91_120,
               SUM(CASE WHEN f.days_past_due > 120 THEN f.residual_company_ccy ELSE 0 END) AS older,
               SUM(f.residual_company_ccy) AS total
        FROM fact_finance_receivable_snapshot f LEFT JOIN dim_customer cu ON cu.CustomerKey = f.CustomerKey
        WHERE f.SnapshotDateKey = :s AND f.CompanyKey = :c
        GROUP BY 1, 2""")
    with engine.connect() as conn:
        return pd.read_sql(sql, conn, params={"s": snapshot_key, "c": company})


def compare(odoo: pd.DataFrame, ours: pd.DataFrame) -> pd.DataFrame:
    o = odoo.assign(_k=odoo["customer"].map(_norm))
    w = ours.groupby(ours["customer"].map(_norm)).agg({**{c: "sum" for c in COLUMNS}, "customer": "first", "CustomerKey": "first"})
    w = w.rename_axis("_k").reset_index()
    m = o.merge(w, on="_k", how="outer", suffixes=("_odoo", "_ours"), indicator=True)
    for c in COLUMNS:
        m[f"{c}_delta"] = m[f"{c}_ours"].fillna(0) - m[f"{c}_odoo"].fillna(0)
    m["matched"] = m["_merge"].map({"both": "both", "left_only": "odoo_only", "right_only": "ours_only"})
    m["customer"] = m["customer_odoo"].fillna(m["customer_ours"])
    m["differs"] = m[[f"{c}_delta" for c in COLUMNS]].abs().max(axis=1) > TOLERANCE
    keep = ["customer", "CustomerKey", "matched", "differs", *[f"{c}_{s}" for c in COLUMNS for s in ("odoo", "ours", "delta")]]
    return m[keep].sort_values(["differs", "total_delta"], ascending=[False, True])


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("export", type=Path)
    ap.add_argument("--company", type=int, required=True)
    ap.add_argument("--date", required=True, help="snapshot date YYYY-MM-DD (the report's date)")
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args(argv)
    engine = create_engine(Settings.from_env(None).sqlalchemy_url, future=True)
    key = int(args.date.replace("-", ""))
    odoo, ours = read_export(args.export), read_snapshot(engine, args.company, key)
    result = compare(odoo, ours)
    args.out.mkdir(parents=True, exist_ok=True)
    out = args.out / f"aged_receivable_{args.company}_{args.date}.csv"
    result.to_csv(out, index=False, encoding="utf-8-sig")
    totals = {c: (round(float(odoo[c].sum()), 2), round(float(ours[c].sum()), 2)) for c in COLUMNS}
    print(f"company {args.company}, {args.date}: Odoo customers {len(odoo)}, snapshot customers {len(ours)}")
    for c, (a, b) in totals.items():
        print(f"  {c:8s} Odoo {a:>18,.2f}  snapshot {b:>18,.2f}  delta {b - a:>14,.2f}")
    print(f"  matched {int((result['matched'] == 'both').sum())}, Odoo only {int((result['matched'] == 'odoo_only').sum())}, "
          f"snapshot only {int((result['matched'] == 'ours_only').sum())}, differing {int(result['differs'].sum())}")
    print(f"written {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
