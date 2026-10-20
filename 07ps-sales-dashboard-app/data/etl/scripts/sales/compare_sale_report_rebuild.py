"""Phase B gate: rebuild sale.report from the base models and compare it with sale.report itself (read-only).

  python scripts/sales/compare_sale_report_rebuild.py --from 2026-07-01 [--to 2026-10-21] [--env-file .env] [--csv out.csv]

What it does (nothing is written to Odoo or to the warehouse):
1. Reads sale.report rows whose order date is in the window, exactly as the sales pipeline does (same fields, no
   context -> every company of the ETL user, amounts in the user's main company currency).
2. Reads the same orders' sale.order + sale.order.line + product/UoM/company currency, and rebuilds every sale.report
   column with Odoo 17's own rules (sale/report/sale_report.py):
     rows      one per (order, product, template UoM, discount) group of non-display
               lines; id = MIN(line id)   [checked: --line-level shows whether any group has more than one line]
     qty       SUM(line qty / line_uom.factor * template_uom.factor)   (product_uom_qty, qty_delivered, qty_invoiced)
     amounts   SUM(line amount / order.currency_rate (0 -> 1) * company->main-currency rate today)
     header    order name, date_order, partner, salesperson, team, company, state from sale.order
3. Prints, per company x order currency x month (Africa/Tripoli) x salesperson: row count and the five measures from
   both sides, the difference, and MATCH / DIFF; then the line-level mismatches (first 30), if any.

The window is by order date (sale.order.date_order in UTC, the field sale.report.date is). Keep it short on a laptop;
run the full history on the server.
"""

from __future__ import annotations

import argparse
import functools
import datetime as _dt
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "src"), str(ROOT)]

from etl_platform.config import PlatformConfig  # noqa: E402
from etl_platform.sources.odoo import OdooSource, m2o_id, m2o_name  # noqa: E402

MEASURES = ["product_uom_qty", "qty_delivered", "qty_invoiced", "price_subtotal", "price_total"]
REPORT_FIELDS = ["id", "order_reference", "date", "name", "partner_id", "product_id", "user_id", "team_id", "company_id",
                 *MEASURES, "product_uom", "state", "invoice_status"]
LINE_FIELDS = ["id", "order_id", "product_id", "product_uom", "discount", "display_type", "invoice_status", *MEASURES]
ORDER_FIELDS = ["id", "name", "date_order", "partner_id", "user_id", "team_id", "company_id", "state", "invoice_status",
                "currency_id", "currency_rate"]
TZ = ZoneInfo("Africa/Tripoli")
TOL = 0.005  # half a cent / half a unit: the report rounds nothing, so real differences are far larger


def read_all(client, model, domain, fields, page=2000):
    out, offset = [], 0
    while True:
        chunk = client.search_read(model, domain, fields, offset=offset, limit=page, order="id")
        out.extend(chunk)
        if len(chunk) < page:
            return out
        offset += page


def read_ids(client, model, ids, fields, chunk=500):
    ids = sorted({int(i) for i in ids if i})
    out = []
    for i in range(0, len(ids), chunk):
        part = ids[i:i + chunk]
        out.extend(client.search_read(model, [("id", "in", part)], fields, limit=len(part), order="id",
                                      context={"active_test": False}))
    return out


def month_of(utc_text: pd.Series) -> pd.Series:
    ts = pd.to_datetime(utc_text, utc=True)
    return ts.dt.tz_convert(TZ).dt.strftime("%Y-%m")


print = functools.partial(print, flush=True)  # noqa: A001 - progress shows in a redirected log


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="date_from", required=True)
    ap.add_argument("--to", dest="date_to", default=None)
    ap.add_argument("--env-file", default=str(ROOT / ".env"))
    ap.add_argument("--csv", default=None, help="also write the comparison table here")
    args = ap.parse_args()
    lo = _dt.date.fromisoformat(args.date_from)
    hi = _dt.date.fromisoformat(args.date_to) if args.date_to else _dt.date.today() + _dt.timedelta(days=1)
    # Tripoli midnight -> UTC bounds (Libya is UTC+2 all year)
    lo_utc = (_dt.datetime.combine(lo, _dt.time(), TZ)).astimezone(_dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    hi_utc = (_dt.datetime.combine(hi, _dt.time(), TZ)).astimezone(_dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

    cfg = PlatformConfig.from_env(args.env_file)
    client = OdooSource.connect(cfg).client
    window = [("date", ">=", lo_utc), ("date", "<", hi_utc)]

    # -- 1. sale.report, as the pipeline reads it (no context) ----------------------------------------------------------
    rep = pd.DataFrame(read_all(client, "sale.report", window, REPORT_FIELDS))
    rep["order_id"] = rep["order_reference"].str.extract(r"^sale\.order,(\d+)$", expand=False).astype(int)
    print(f"sale.report rows in window: {len(rep):,} ({rep['order_id'].nunique():,} orders)")

    # -- 2. base models ----------------------------------------------------------------------------------------------------
    orders = pd.DataFrame(read_all(client, "sale.order", [("date_order", ">=", lo_utc), ("date_order", "<", hi_utc)], ORDER_FIELDS))
    # by the order's date, not "order_id in [ids]": a long window has ~10^5 orders and the id list would be re-sent per page
    lines = pd.DataFrame(read_all(client, "sale.order.line", [("order_id.date_order", ">=", lo_utc), ("order_id.date_order", "<", hi_utc)],
                                  LINE_FIELDS))
    prods = pd.DataFrame(read_ids(client, "product.product", lines["product_id"].map(m2o_id).dropna(), ["id", "uom_id"]))
    uoms = pd.DataFrame(read_ids(client, "uom.uom", set(lines["product_uom"].map(m2o_id).dropna()) | set(prods["uom_id"].map(m2o_id).dropna()),
                                 ["id", "factor"]))
    companies = pd.DataFrame(client.search_read("res.company", [], ["id", "currency_id"], limit=0))
    user = client.search_read("res.users", [("id", "=", client.uid)], ["company_id"], limit=1)[0]
    main_company = m2o_id(user["company_id"])
    company_ccy = {int(r["id"]): m2o_id(r["currency_id"]) for r in companies.to_dict("records")}
    main_ccy = company_ccy[main_company]
    rates = {}
    for ccy in set(company_ccy.values()):  # currency_table.rate = company currency -> main currency, today
        rates[ccy] = 1.0 if ccy == main_ccy else None
    if any(v is None for v in rates.values()):
        cur = {r["id"]: r["rate"] for r in client.search_read("res.currency", [("id", "in", list(rates))], ["id", "rate"], limit=0,
                                                                context={"active_test": False})}
        for ccy in rates:
            if rates[ccy] is None:
                rates[ccy] = cur[main_ccy] / cur[ccy]
    print(f"orders {len(orders):,}, lines {len(lines):,}; ETL user main company {main_company}, company currencies "
          f"{sorted(set(company_ccy.values()))}, conversion rates to the main currency {rates}")

    # -- 3. rebuild --------------------------------------------------------------------------------------------------------
    o = orders.assign(order_id=orders["id"], h_name=orders["name"], h_date=orders["date_order"],
                      h_partner=orders["partner_id"].map(m2o_id), h_user=orders["user_id"].map(m2o_id),
                      h_team=orders["team_id"].map(m2o_id), h_state=orders["state"], h_invoice_status=orders["invoice_status"], company=orders["company_id"].map(m2o_id), currency=orders["currency_id"].map(m2o_name),
                      salesperson=orders["user_id"].map(m2o_name).fillna("(none)"),
                      rate=orders["currency_rate"].fillna(0).where(orders["currency_rate"].fillna(0) != 0, 1.0))
    o["month"] = month_of(o["date_order"])
    o["to_main"] = o["company"].map(lambda c: rates[company_ccy[c]])
    li = lines[lines["display_type"].isin([False, None]) | lines["display_type"].isna()].copy()
    li["order_id"] = li["order_id"].map(m2o_id)
    li["product"] = li["product_id"].map(m2o_id)
    li["line_uom"] = li["product_uom"].map(m2o_id)
    tmpl_uom = dict(zip(prods["id"], prods["uom_id"].map(m2o_id)))
    factor = dict(zip(uoms["id"], uoms["factor"]))
    li["tmpl_uom"] = li["product"].map(tmpl_uom)
    li = li.merge(o[["order_id", "company", "currency", "salesperson", "month", "rate", "to_main", "h_name", "h_date", "h_partner",
                     "h_user", "h_team", "h_state", "h_invoice_status"]], on="order_id", how="inner")
    conv = li["tmpl_uom"].map(factor) / li["line_uom"].map(factor)
    for q in ("product_uom_qty", "qty_delivered", "qty_invoiced"):
        li[q] = (li[q] * conv).where(li["product"].notna(), 0.0)
    for a in ("price_subtotal", "price_total"):
        li[a] = (li[a] / li["rate"] * li["to_main"]).where(li["product"].notna(), 0.0)
    keys = ["order_id", "product", "tmpl_uom", "discount"]  # the line invoice_status is NOT a key (checked: Odoo merges an
    # "invoiced" and an "upselling" line of the same product)
    grouped = (li.fillna({"product": -1, "tmpl_uom": -1}).groupby(keys, dropna=False)
                 .agg(id=("id", "min"), n=("id", "size"), company=("company", "first"), currency=("currency", "first"),
                      salesperson=("salesperson", "first"), month=("month", "first"),
                      **{h: (h, "first") for h in ("h_name", "h_date", "h_partner", "h_user", "h_team", "h_state", "h_invoice_status")},
                      **{m: (m, "sum") for m in MEASURES})
                 .reset_index())
    merged_groups = int((grouped["n"] > 1).sum())

    # -- 4. compare: totals per company x currency x month x salesperson ----------------------------------------------------
    rep = rep.merge(o[["order_id", "company", "currency", "salesperson", "month"]], on="order_id", how="left")
    dims = ["company", "currency", "month", "salesperson"]
    a = rep.groupby(dims).agg(rows=("id", "size"), **{m: (m, "sum") for m in MEASURES})
    b = grouped.groupby(dims).agg(rows=("id", "size"), **{m: (m, "sum") for m in MEASURES})
    t = a.join(b, how="outer", lsuffix="_report", rsuffix="_rebuild").fillna(0)
    worst = pd.Series(0.0, index=t.index)
    for m in ["rows", *MEASURES]:
        t[f"{m}_diff"] = t[f"{m}_rebuild"] - t[f"{m}_report"]
        worst = worst.combine(t[f"{m}_diff"].abs(), max)
    t["result"] = worst.map(lambda d: "MATCH" if d <= TOL else "DIFF")
    pd.set_option("display.width", 250, "display.max_rows", 500, "display.max_columns", 30)
    show = t.reset_index()[[*dims, "rows_report", "rows_rebuild", "price_subtotal_report", "price_subtotal_diff",
                            "price_total_diff", "product_uom_qty_report", "product_uom_qty_diff", "qty_delivered_diff",
                            "qty_invoiced_diff", "result"]]
    print("\nPer company x order currency x month x salesperson (diff = rebuild - sale.report):")
    print(show.to_string(index=False, float_format=lambda v: f"{v:,.2f}"))
    if args.csv:
        t.reset_index().to_csv(args.csv, index=False)

    # -- 5. line level ---------------------------------------------------------------------------------------------------
    lv = rep.set_index("id")[MEASURES].join(grouped.set_index("id")[MEASURES], how="outer", lsuffix="_r", rsuffix="_b")
    bad = lv[lv.isna().any(axis=1) | (pd.concat([(lv[f"{m}_b"] - lv[f"{m}_r"]).abs() for m in MEASURES], axis=1).max(axis=1) > TOL)]
    print(f"\nrows only in sale.report: {int(lv[[f'{m}_b' for m in MEASURES]].isna().all(axis=1).sum())}, "
          f"only in the rebuild: {int(lv[[f'{m}_r' for m in MEASURES]].isna().all(axis=1).sum())}, "
          f"value mismatches: {len(bad)}; groups merging more than one line: {merged_groups}")
    only_b = lv[lv[[f"{m}_r" for m in MEASURES]].isna().all(axis=1)].index
    if len(only_b):
        print("only in the rebuild:", grouped[grouped["id"].isin(only_b)][["id", "order_id", "product", *MEASURES]].to_string(index=False))
    if len(bad):
        print(bad.head(30).to_string(float_format=lambda v: f"{v:,.4f}"))
    # every other sale.report column, row by row
    r2 = rep.set_index("id")
    g2 = grouped.set_index("id")
    cols = {"name": ("h_name", lambda v: v), "date": ("h_date", lambda v: v), "partner_id": ("h_partner", m2o_id),
            "user_id": ("h_user", m2o_id), "team_id": ("h_team", m2o_id), "company_id": ("company", m2o_id),
            "product_id": ("product", m2o_id), "product_uom": ("tmpl_uom", m2o_id), "state": ("h_state", lambda v: v),
            "invoice_status": ("h_invoice_status", lambda v: v)}
    common = r2.index.intersection(g2.index)
    col_diffs = {}
    for rc, (gc, f) in cols.items():
        left = r2.loc[common, rc].map(f).map(lambda v: None if v is False or (isinstance(v, float) and pd.isna(v)) or v == -1 else v)
        right = g2.loc[common, gc].map(lambda v: None if v is False or (isinstance(v, float) and pd.isna(v)) or v == -1 else v)
        col_diffs[rc] = int((left.astype(str) != right.astype(str)).sum())
    print("row-level column differences (sale.report vs rebuild):", col_diffs)
    n_diff = int((t["result"] == "DIFF").sum()) + sum(col_diffs.values())
    print(f"\n{len(t) - n_diff} MATCH / {n_diff} DIFF of {len(t)} company x currency x month x salesperson cells")
    return 0 if n_diff == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
