"""Volumes outside the comparison window, per fact: records created, modified or deleted in Odoo after the baseline.

  python scripts/regression/post_baseline.py --window-json <dir>/window.json --prefix zz_baseline_ --out <dir>

Reads window.json (window.py) for the record classes, the conformed serving views for "now" and the restored
baseline tables (<prefix>fact_*) for "baseline". Writes <out>/post_baseline.csv and prints it. Read-only.
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

# fact -> (new view, legacy table, id column, value measure, class source, id format)
FACTS = {
    "sales_lines": ("v_sales_lines", "fact_saleslines", "OdooOrderID", "Value", "orders", "{}"),
    "orders": ("v_sales_orders", "fact_orders", "SalesDocumentID", "OrderValue", "orders", "{}"),
    "sales_documents": ("v_sales_documents", "fact_sales", "SalesDocumentID", "OrderValue", "orders", "{}"),
    "deliveries": ("v_sales_deliveries", "fact_delivery", "DeliveryFactID", "OrderedQuantity", "pickings", "PICK-{}"),
    "leads": ("v_sales_leads", "fact_lead", "LeadID", "Count", "leads", "{}"),
    "opportunities": ("v_sales_opportunities", "fact_opportunity", "OpportunityID", "ExpectedRevenue", "leads", "{}"),
}


def _sum(conn, table: str, id_col: str, value: str, ids: list[str]) -> tuple[int, float]:
    if not ids:
        return 0, 0.0
    rows, total = 0, 0.0
    for i in range(0, len(ids), 2000):
        chunk = ids[i:i + 2000]
        marks = ", ".join(f":i{k}" for k in range(len(chunk)))
        r = conn.execute(text(f"SELECT COUNT(*), COALESCE(SUM(`{value}`), 0) FROM {table} WHERE CAST({id_col} AS CHAR) IN ({marks})"),
                         {f"i{k}": v for k, v in enumerate(chunk)}).one()
        rows, total = rows + int(r[0]), total + float(r[1])
    return rows, total


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--window-json", type=Path, required=True)
    ap.add_argument("--prefix", default="zz_baseline_")
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args(argv)
    classes = json.loads(args.window_json.read_text(encoding="utf-8"))["classes"]
    engine = create_engine(Settings.from_env(None).sqlalchemy_url, future=True)
    out = []
    with engine.connect() as conn:
        if engine.dialect.name == "mysql":
            conn.execute(text("SET SESSION TRANSACTION READ ONLY"))
        for fact, (view, legacy, id_col, value, source, fmt) in FACTS.items():
            ids = {k: [fmt.format(i) for i in v] for k, v in classes[source].items()}
            if fact == "leads":  # ETL-generated leads carry their opportunity's id
                ids = {k: v + [f"ETL-LEAD-{i}" for i in v] for k, v in ids.items()}
            for cls, side, table in (("new", "now", view), ("modified", "now", view), ("modified", "baseline", args.prefix + legacy),
                                     ("deleted", "baseline", args.prefix + legacy)):
                n, total = _sum(conn, table, id_col, value, ids.get(cls, []))
                out.append({"fact": fact, "class": cls, "side": side, "records": len(classes[source].get(cls, [])),
                            "fact_rows": n, "measure": value, "value": round(total, 3)})
    df = pd.DataFrame(out)
    args.out.mkdir(parents=True, exist_ok=True)
    df.to_csv(args.out / "post_baseline.csv", index=False)
    print(df.to_string(index=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
