"""sale.report rebuilt from the base models (Phase B, docs/etl-phase-b-sales-incremental.md).

Odoo's sale.report is an SQL view, so its write_date says nothing about changes. The incremental sales load mirrors
sale.order + sale.order.line (by write_date) and rebuilds the rows sale.report would return, with Odoo 17's rules
(sale/report/sale_report.py), verified against production for 2021-01..2026-10 (175,527 rows, every column, 0
differences; data/etl/scripts/sales/compare_sale_report_rebuild.py):

  rows      one per (order, product, product template UoM, discount) group of non-display lines -- NOT split by the
            line's invoice status; sale.report's id = MIN(line id) (kept as SaleReportLineID, informational only)
  qty       SUM(line qty / line UoM factor x template UoM factor); 0 when the line has no product
  amounts   SUM(line amount / order currency_rate); 0 when the line has no product. Odoo also multiplies by the company ->
            main company currency rate of TODAY; every in-scope company is in LYD, so that factor is 1, and the
            currency guard (check_currencies) refuses to load otherwise instead of silently using 1
  header    order name, date, customer, salesperson, team, company, state, invoice status (the ORDER's) from sale.order;
            UoM = the product template's UoM

``rebuild_sale_report`` returns the same frame SalesReportRepository.fetch_sale_report returns (same column names,
same flattening of empty values, Order Date in the business zone), plus the stable row key ``SalesLineGroupKey`` and
``Discount`` / ``LineIDs``. Inputs are flat frames (one column per value; many2one as <field> id + <field>_name), the
shape of the raw mirror tables; ``flatten_records`` turns Odoo search_read results into it.
"""

from __future__ import annotations

import hashlib
from typing import Any, Iterable, Mapping, Sequence

import pandas as pd

from sales_pipeline.odoo.sales_report_repository import safe_datetime_to_local

ALLOWED_COMPANY_CURRENCIES = ("LYD",)
QTY_FIELDS = ("product_uom_qty", "qty_delivered", "qty_invoiced")
AMOUNT_FIELDS = ("price_subtotal", "price_total")

ORDER_FIELDS = ("id", "name", "date_order", "partner_id", "user_id", "team_id", "company_id", "state", "invoice_status",
                "currency_id", "currency_rate")
ORDER_M2O = ("partner_id", "user_id", "team_id", "company_id", "currency_id")
LINE_FIELDS = ("id", "order_id", "product_id", "product_uom", "discount", "display_type", *QTY_FIELDS, *AMOUNT_FIELDS)
LINE_M2O = ("order_id", "product_id", "product_uom")
PRODUCT_FIELDS = ("id", "uom_id")
PRODUCT_M2O = ("uom_id",)

# fetch_sale_report's frame, in its column order
REPORT_COLUMNS = ["SaleReportLineID", "Order Date", "Related Order", "Customer", "Product", "Salesperson", "Sales Team", "Company",
                  "Untaxed Total", "Total", "Qty Invoiced", "Qty Ordered", "Qty Delivered", "UoM", "Status", "Invoice Status",
                  "OdooProductID", "OdooPartnerID", "UoMID", "OdooCompanyID", "OdooOrderID"]
EXTRA_COLUMNS = ["SalesLineGroupKey", "Discount", "LineIDs"]


class SalesCurrencyError(RuntimeError):
    """A company or an order whose amounts this rebuild cannot convert exactly like sale.report."""


# -- inputs ----------------------------------------------------------------------------------------------------------
def flatten_records(records: Iterable[Mapping[str, Any]], fields: Sequence[str], m2o: Sequence[str] = ()) -> pd.DataFrame:
    """Odoo search_read records -> flat frame: a many2one ``f`` becomes ``f`` (id or <NA>) and ``f_name`` (display name or
    <NA>); False / None become <NA> for every other field."""
    rows = []
    for rec in records:
        row: dict[str, Any] = {}
        for f in fields:
            v = rec.get(f)
            if f in m2o:
                row[f] = int(v[0]) if isinstance(v, (list, tuple)) and v else pd.NA
                row[f"{f}_name"] = str(v[1]) if isinstance(v, (list, tuple)) and len(v) > 1 else pd.NA
            else:
                row[f] = pd.NA if v is None or v is False else v
        rows.append(row)
    cols = [c for f in fields for c in ((f, f"{f}_name") if f in m2o else (f,))]
    return pd.DataFrame(rows, columns=cols)


# -- currency guard ----------------------------------------------------------------------------------------------------
def check_currencies(companies: pd.DataFrame, orders: pd.DataFrame, allowed: Sequence[str] = ALLOWED_COMPANY_CURRENCIES) -> None:
    """Fails loudly instead of loading wrong amounts.

    ``companies``: id, name, currency_id_name (the company currency code) for every company the orders belong to.
    ``orders``: id, name, company_id, currency_rate."""
    used = set(pd.to_numeric(orders["company_id"], errors="coerce").dropna().astype(int)) if len(orders) else set()
    known = companies.assign(id=pd.to_numeric(companies["id"]).astype(int)).set_index("id")
    problems = []
    for cid in sorted(used):
        if cid not in known.index:
            problems.append(f"company {cid} of the orders is not in res.company (cannot check its currency)")
            continue
        code = known.at[cid, "currency_id_name"]
        if pd.isna(code) or str(code) not in allowed:
            problems.append(f"company {cid} {known.at[cid, 'name']} has currency {code}: sale.report converts its amounts to the "
                            f"main company currency at TODAY's rate, which this rebuild does not implement (allowed: {', '.join(allowed)})")
    rate = pd.to_numeric(orders["currency_rate"], errors="coerce") if len(orders) else pd.Series(dtype=float)
    bad = orders.loc[rate.isna() | (rate == 0)] if len(orders) else orders
    if len(bad):
        sample = ", ".join(f"{n} (id {i})" for n, i in zip(bad["name"].head(10), bad["id"].head(10)))
        problems.append(f"{len(bad)} order(s) have no currency_rate (Odoo would silently use 1): {sample}")
    if problems:
        raise SalesCurrencyError("Sales rebuild refused -- " + "; ".join(problems)
                                 + ". See docs/etl-phase-b-sales-incremental.md section 2.")


# -- row key -----------------------------------------------------------------------------------------------------------
def group_key(order_id: Any, product_id: Any, uom_id: Any, discount: Any) -> str:
    """Stable key of a sale.report row: SHA-1 of order|product|template UoM|discount (missing product / UoM = -1,
    discount with 6 decimals). Never the row id (MIN(line id) changes when that line is deleted)."""
    def _i(v: Any) -> int:
        return -1 if v is None or (not isinstance(v, str) and pd.isna(v)) else int(v)

    d = 0.0 if discount is None or pd.isna(discount) else float(discount)
    return hashlib.sha1(f"{_i(order_id)}|{_i(product_id)}|{_i(uom_id)}|{d:.6f}".encode("ascii")).hexdigest()


# -- rebuild -----------------------------------------------------------------------------------------------------------
def _text(series: pd.Series) -> pd.Series:
    """fetch_sale_report flattening: a missing value is "" (many2one names and plain fields alike)."""
    return series.astype(object).where(series.notna(), "")


def rebuild_sale_report(orders: pd.DataFrame, lines: pd.DataFrame, products: pd.DataFrame, uoms: pd.DataFrame, *,
                        timezone: str = "Africa/Tripoli", assume_utc_for_naive: bool = False) -> pd.DataFrame:
    """The sale.report rows of ``orders`` (frames as flatten_records gives them; ``uoms``: id, factor).

    Every order whose lines are passed must be in ``orders``; lines of other orders are an error (a partial order would
    give wrong group totals). Run check_currencies first."""
    if len(lines) and not set(lines["order_id"].dropna().astype(int)) <= set(orders["id"].astype(int)):
        missing = sorted(set(lines["order_id"].dropna().astype(int)) - set(orders["id"].astype(int)))[:10]
        raise ValueError(f"lines of order(s) not passed in orders: {missing}")
    li = lines[lines["display_type"].isna()].copy() if "display_type" in lines else lines.copy()
    tmpl_uom = dict(zip(products["id"].astype(int), products["uom_id"]))
    tmpl_uom_name = dict(zip(products["id"].astype(int), products["uom_id_name"]))
    factor = dict(zip(uoms["id"].astype(int), pd.to_numeric(uoms["factor"])))
    o = orders.set_index(orders["id"].astype(int))
    li["order_id"] = li["order_id"].astype(int)
    has_product = li["product_id"].notna()
    pid = li["product_id"].where(has_product)
    li["tmpl_uom"] = pid.map(lambda p: tmpl_uom.get(int(p)) if pd.notna(p) else pd.NA)
    li["tmpl_uom_name"] = pid.map(lambda p: tmpl_uom_name.get(int(p)) if pd.notna(p) else pd.NA)
    conv = li["tmpl_uom"].map(lambda u: factor.get(int(u)) if pd.notna(u) else pd.NA) / li["product_uom"].map(
        lambda u: factor.get(int(u)) if pd.notna(u) else pd.NA)
    rate = pd.to_numeric(li["order_id"].map(o["currency_rate"]), errors="coerce")
    rate = rate.where(rate.notna() & (rate != 0), 1.0)  # Odoo's CASE COALESCE(rate, 0) WHEN 0 THEN 1.0 (the guard refuses it)
    for q in QTY_FIELDS:
        li[q] = (pd.to_numeric(li[q]).astype(float) * pd.to_numeric(conv).astype(float)).where(has_product, 0.0)
    for a in AMOUNT_FIELDS:
        li[a] = (pd.to_numeric(li[a]).astype(float) / rate).where(has_product, 0.0)
    li["discount"] = pd.to_numeric(li["discount"]).fillna(0.0).astype(float)
    li["g_product"] = pd.to_numeric(pid).fillna(-1).astype(int)
    li["g_uom"] = pd.to_numeric(li["tmpl_uom"]).fillna(-1).astype(int)
    keys = ["order_id", "g_product", "g_uom", "discount"]
    g = (li.groupby(keys, sort=False)
           .agg(SaleReportLineID=("id", "min"), LineIDs=("id", lambda s: ",".join(str(int(v)) for v in sorted(s))),
                product_name=("product_id_name", "first"), tmpl_uom_name=("tmpl_uom_name", "first"),
                **{f: (f, "sum") for f in (*QTY_FIELDS, *AMOUNT_FIELDS)})
           .reset_index())
    h = o.loc[g["order_id"]].reset_index(drop=True)
    out = pd.DataFrame({
        "SaleReportLineID": g["SaleReportLineID"].astype(int),
        "Order Date": safe_datetime_to_local(h["date_order"].astype("string"), timezone, assume_utc_for_naive),
        "Related Order": _text(h["name"]),
        "Customer": _text(h["partner_id_name"]),
        "Product": _text(g["product_name"].where(g["g_product"] != -1)),
        "Salesperson": _text(h["user_id_name"]),
        "Sales Team": _text(h["team_id_name"]),
        "Company": _text(h["company_id_name"]),
        "Untaxed Total": g["price_subtotal"], "Total": g["price_total"],
        "Qty Invoiced": g["qty_invoiced"], "Qty Ordered": g["product_uom_qty"], "Qty Delivered": g["qty_delivered"],
        "UoM": _text(g["tmpl_uom_name"].where(g["g_uom"] != -1)),
        "Status": _text(h["state"]), "Invoice Status": _text(h["invoice_status"]),
        "OdooProductID": g["g_product"].where(g["g_product"] != -1).astype("Int64"),
        "OdooPartnerID": pd.to_numeric(h["partner_id"]).astype("Int64"),
        "UoMID": g["g_uom"].where(g["g_uom"] != -1).astype("Int64"),
        "OdooCompanyID": pd.to_numeric(h["company_id"]).astype("Int64"),
        "OdooOrderID": g["order_id"].astype("Int64"),
    })
    out["SalesLineGroupKey"] = [group_key(a, b, c, d) for a, b, c, d in zip(g["order_id"], g["g_product"], g["g_uom"], g["discount"])]
    out["Discount"] = g["discount"]
    out["LineIDs"] = g["LineIDs"]
    return out.sort_values("SaleReportLineID", kind="stable").reset_index(drop=True)[REPORT_COLUMNS + EXTRA_COLUMNS]
