"""Phase B gate: the sale.report rebuild library vs sale.report itself (read-only).

  python scripts/sales/compare_sale_report_rebuild.py --from 2026-07-01 [--to 2026-10-21] [--env-file .env] [--csv out.csv]

1. sale.report, read by the sales pipeline's own SalesReportRepository.fetch_sale_report (same fields, no context ->
   every company of the ETL user, Order Date in the business zone).
2. The same orders' sale.order + sale.order.line + product template UoM + UoM factors + company currencies, flattened
   like the raw mirror tables, then departments.sales.sale_report: check_currencies + rebuild_sale_report.
3. Totals per company x order currency x month (business zone) x salesperson: rows and the five measures from both
   sides, the difference, MATCH / DIFF.
4. Frame to frame on SaleReportLineID: rows only on one side, and every column (text exactly, numbers within 1e-6:
   floating-point sums only).

The window is by order date (sale.order.date_order, UTC). Run long windows on the server; on a laptop keep it short.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import functools
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "src"), str(ROOT)]

from config.settings import Settings  # noqa: E402
from departments.sales import sale_report as sr  # noqa: E402
from etl_platform.config import PlatformConfig  # noqa: E402
from etl_platform.sources.odoo import OdooSource  # noqa: E402
from sales_pipeline.odoo.sales_report_repository import SalesReportRepository  # noqa: E402

MEASURES = ["Qty Ordered", "Qty Delivered", "Qty Invoiced", "Untaxed Total", "Total"]
TOL = 1e-6
print = functools.partial(print, flush=True)  # noqa: A001 - progress shows in a redirected log


def read_all(client, model, domain, fields, page=2000):
    out, offset = [], 0
    while True:
        chunk = client.search_read(model, domain, list(fields), offset=offset, limit=page, order="id")
        out.extend(chunk)
        if len(chunk) < page:
            return out
        offset += page


def read_ids(client, model, ids, fields, chunk=500):
    ids = sorted({int(i) for i in ids if pd.notna(i)})
    out = []
    for i in range(0, len(ids), chunk):
        part = ids[i:i + chunk]
        out.extend(client.search_read(model, [("id", "in", part)], list(fields), limit=len(part), order="id", context={"active_test": False}))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="date_from", required=True)
    ap.add_argument("--to", dest="date_to", default=None)
    ap.add_argument("--env-file", default=str(ROOT / ".env"))
    ap.add_argument("--csv", default=None, help="also write the comparison table here")
    args = ap.parse_args()
    settings = Settings.from_env(args.env_file)
    tz = ZoneInfo(settings.timezone)
    lo = _dt.date.fromisoformat(args.date_from)
    hi = _dt.date.fromisoformat(args.date_to) if args.date_to else _dt.date.today() + _dt.timedelta(days=1)
    lo_utc = _dt.datetime.combine(lo, _dt.time(), tz).astimezone(_dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    hi_utc = _dt.datetime.combine(hi, _dt.time(), tz).astimezone(_dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    client = OdooSource.connect(PlatformConfig.from_env(args.env_file)).client

    # -- 1. sale.report through the pipeline's own reader ----------------------------------------------------------------
    rep = SalesReportRepository(client, batch_size=2000, timezone=settings.timezone,
                                assume_utc_for_naive=settings.assume_utc_for_naive).fetch_sale_report([["date", ">=", lo_utc], ["date", "<", hi_utc]])
    print(f"sale.report rows in window: {len(rep):,} ({rep['OdooOrderID'].nunique():,} orders)")

    # -- 2. the library on the base models -------------------------------------------------------------------------------
    orders = sr.flatten_records(read_all(client, "sale.order", [("date_order", ">=", lo_utc), ("date_order", "<", hi_utc)], sr.ORDER_FIELDS),
                                sr.ORDER_FIELDS, sr.ORDER_M2O)
    lines = sr.flatten_records(read_all(client, "sale.order.line", [("order_id.date_order", ">=", lo_utc), ("order_id.date_order", "<", hi_utc)],
                                        sr.LINE_FIELDS), sr.LINE_FIELDS, sr.LINE_M2O)
    products = sr.flatten_records(read_ids(client, "product.product", lines["product_id"].dropna(), sr.PRODUCT_FIELDS), sr.PRODUCT_FIELDS, sr.PRODUCT_M2O)
    uoms = pd.DataFrame(read_ids(client, "uom.uom", set(lines["product_uom"].dropna()) | set(products["uom_id"].dropna()), ["id", "factor"]))
    companies = sr.flatten_records(client.search_read("res.company", [], ["id", "name", "currency_id"], limit=0), ("id", "name", "currency_id"), ("currency_id",))
    sr.check_currencies(companies, orders)
    reb = sr.rebuild_sale_report(orders, lines, products, uoms, timezone=settings.timezone, assume_utc_for_naive=settings.assume_utc_for_naive)
    print(f"orders {len(orders):,}, lines {len(lines):,} -> rebuilt rows {len(reb):,}; groups merging more than one line: "
          f"{int(reb['LineIDs'].str.contains(',').sum()):,}")

    # -- 3. totals per company x order currency x month x salesperson ------------------------------------------------------
    ccy = dict(zip(orders["id"].astype(int), orders["currency_id_name"]))
    dims = ["Company", "Currency", "Month", "Salesperson"]

    def cut(df):
        return df.assign(Currency=df["OdooOrderID"].astype(int).map(ccy), Month=pd.to_datetime(df["Order Date"]).dt.strftime("%Y-%m"))

    a = cut(rep).groupby(dims).agg(rows=("SaleReportLineID", "size"), **{m: (m, "sum") for m in MEASURES})
    b = cut(reb).groupby(dims).agg(rows=("SaleReportLineID", "size"), **{m: (m, "sum") for m in MEASURES})
    t = a.join(b, how="outer", lsuffix=" (sale.report)", rsuffix=" (rebuild)").fillna(0)
    worst = pd.Series(0.0, index=t.index)
    for m in ["rows", *MEASURES]:
        t[f"{m} diff"] = t[f"{m} (rebuild)"] - t[f"{m} (sale.report)"]
        worst = worst.combine(t[f"{m} diff"].abs(), max)
    t["result"] = worst.map(lambda d: "MATCH" if d <= 0.005 else "DIFF")  # cell sums of many floats
    if args.csv:
        t.reset_index().to_csv(args.csv, index=False)
    pd.set_option("display.width", 250, "display.max_rows", 2000, "display.max_columns", 40)
    diff_cells = t[t["result"] == "DIFF"]
    if len(diff_cells):
        print(diff_cells.reset_index().to_string(index=False))

    # -- 4. frame to frame ------------------------------------------------------------------------------------------------
    r = rep.set_index("SaleReportLineID")
    q = reb.set_index("SaleReportLineID")
    only_r, only_q = r.index.difference(q.index), q.index.difference(r.index)
    common = r.index.intersection(q.index)
    col_diffs = {}
    for col in [c for c in rep.columns if c != "SaleReportLineID"]:
        x, y = r.loc[common, col], q.loc[common, col]
        if col in MEASURES:
            bad = (pd.to_numeric(x) - pd.to_numeric(y)).abs() > TOL
        elif col == "Order Date":
            bad = pd.to_datetime(x) != pd.to_datetime(y)
        else:
            bad = x.astype("string").fillna("<NA>") != y.astype("string").fillna("<NA>")
        col_diffs[col] = int(bad.sum())
        if bad.any():
            print(f"  {col}: e.g. " + "; ".join(f"id {i}: sale.report {x[i]!r} vs rebuild {y[i]!r}" for i in common[bad.values][:3]))
    print(f"rows only in sale.report: {len(only_r)}, only in the rebuild: {len(only_q)}")
    print(f"column differences on {len(common):,} common rows: {col_diffs}")
    n_diff = len(diff_cells) + len(only_r) + len(only_q) + sum(col_diffs.values())
    print(f"{len(t) - len(diff_cells)} MATCH / {len(diff_cells)} DIFF of {len(t)} company x currency x month x salesperson cells")
    print("RESULT:", "IDENTICAL" if n_diff == 0 else "DIFFERENT")
    return 0 if n_diff == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
