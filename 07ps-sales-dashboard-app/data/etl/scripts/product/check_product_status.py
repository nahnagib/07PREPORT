"""READ-ONLY check (2026-11-15): the Product Status buckets the next refresh will produce from Input/ProductExclusions.xlsx.

Reads the local DB (SELECT only) and the exclusions file; writes nothing to the DB. It re-derives every SKU's bucket with
the rule of product_dashboard.py (Unclassified > Dormant > Active > Non Active) and compares it with today's buckets
(the stored ExcludedByProduct / ExcludedByCategory flags + today's sales), per company view (All / Majaal / Tika).

  Unclassified  an active Products Exclude row, or an active Categories Exclude row (sub-categories follow their parent),
                unless a Products Keep row; plus the automatic Raw Materials category rule (reported separately)
  Dormant       archived in Odoo (IsActive = 0)
  Active        sold (Qty > 0) in the last 12 months after the Customers rules (Exclude drops the customer's lines; Keep
                overrides the Backoffice / Inter Company / intercompany-flag exclusion) -- ProductDashboardBuilder.non_sales_mask
  Non Active    everything else (never sold included)
A SKU = one Odoo variant; its company rows combine as the BCG cards combine them (any Unclassified > any Active > all
Dormant > Non Active).

Usage (from data/etl):  .venv/Scripts/python.exe scripts/product/check_product_status.py [--file PATH] [--out DIR]
DB credentials: DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME (environment, else backend/.env).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date
from pathlib import Path

import pandas as pd
import pymysql

HERE = Path(__file__).resolve()
ETL = HERE.parents[2]
sys.path.insert(0, str(ETL / "src"))

from sales_pipeline.product_dashboard import ProductDashboardBuilder, ProductDashboardConfig  # noqa: E402
from sales_pipeline.product_exclusions import ProductExclusions, ProductExclusionsLoader, _empty_rules  # noqa: E402

COMPANIES = ("Majaal", "Tika")
STATUSES = ("Unclassified", "Dormant", "Active", "NonActive")


def db_settings() -> dict[str, object]:
    env = {}
    dotenv = ETL.parents[1] / "backend" / ".env"
    if dotenv.is_file():
        for line in dotenv.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    get = lambda k, d=None: os.getenv(k) or env.get(k, d)  # noqa: E731
    host = get("DB_HOST", "127.0.0.1")
    if host not in ("127.0.0.1", "localhost"):
        raise SystemExit(f"refusing to read a non-local database ({host})")
    return {"host": host, "port": int(get("DB_PORT", 3306)), "user": get("DB_USER"), "password": get("DB_PASSWORD"),
            "database": get("DB_NAME", "powerBI_Data"), "charset": "utf8mb4"}


def query(conn, sql: str, params: tuple = ()) -> pd.DataFrame:
    with conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()
        cols = [c[0] for c in cur.description]
    return pd.DataFrame(list(rows), columns=cols)


def category_members(rows: pd.DataFrame, root_ids: set[int]) -> pd.Series:
    """Rows in a root category or below it: the same id, or a category path that starts with the root's path."""
    cid = pd.to_numeric(rows["CategoryID"], errors="coerce")
    hit = cid.isin(list(root_ids))
    paths = rows.loc[hit, "Category"].dropna().astype(str).unique()
    path = rows["Category"].astype("string")
    for p in paths:
        hit |= path.eq(p).fillna(False) | path.str.startswith(p + " / ", na=False)
    return hit


def rule_of(ex: ProductExclusions, sheet: str, company: str, odoo_id: int) -> dict[str, object] | None:
    r = ex.rules(sheet)
    own = r[(r["Company"] == company) & (r["OdooID"] == odoo_id)]
    row = own if not own.empty else r[(r["Company"] == "All") & (r["OdooID"] == odoo_id)]
    if row.empty:
        return None
    x = row.iloc[0]
    return {"sheet": sheet, "company": x["Company"], "row": int(x["Row"]), "reason": x.get("Reason", None) if "Reason" in row.columns else None}


def classify(rows: pd.DataFrame, ex: ProductExclusions, sold: set[str], raw_names: set[str]) -> pd.DataFrame:
    out = rows.copy()
    out["Status"] = "NonActive"
    out["Rule"] = None
    pid = pd.to_numeric(out["ProductKey"], errors="coerce")
    leaf = out["Category"].astype("string").str.split(" / ").str[-1].str.strip().str.casefold()
    raw = leaf.isin(list(raw_names)).fillna(False)
    for company in COMPANIES:
        own = out["Company"].eq(company)
        keep = pid.isin(list(ex.ids("Products", "Keep", company)))
        prod = pid.isin(list(ex.ids("Products", "Exclude", company))) & ~keep
        cat_ids = ex.ids("Categories", "Exclude", company)
        cat = category_members(out, cat_ids) & ~keep
        rawhit = raw & ~keep & ~prod & ~cat
        for mask, kind in ((own & prod, "Products"), (own & cat & ~prod, "Categories"), (own & rawhit, "Raw Materials (automatic)")):
            out.loc[mask, "Status"] = "Unclassified"
            out.loc[mask, "Rule"] = kind
    unclassified = out["Status"].eq("Unclassified")
    archived = pd.to_numeric(out["IsActive"], errors="coerce").eq(0)
    out.loc[~unclassified & archived, "Status"] = "Dormant"
    active = out["ProductCompanyKey"].isin(sold) & ~unclassified & ~archived
    out.loc[active, "Status"] = "Active"
    out["ArchivedAndExcluded"] = unclassified & archived
    return out


def sku_counts(rows: pd.DataFrame, company: str | None) -> dict[str, int]:
    scoped = rows if company is None else rows[rows["Company"].eq(company)]
    scoped = scoped[pd.to_numeric(scoped["OdooProductID"], errors="coerce").gt(0)]
    out = {s: 0 for s in STATUSES}
    for _, parts in scoped.groupby("OdooProductID"):
        st = set(parts["Status"])
        s = "Unclassified" if "Unclassified" in st else "Active" if "Active" in st else "Dormant" if st == {"Dormant"} else "NonActive"
        out[s] += 1
    out["Total"] = sum(out[s] for s in STATUSES)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--file", default=str(ETL.parents[2] / "Input" / "ProductExclusions.xlsx"))
    ap.add_argument("--out", default=None, help="folder for the CSV / JSON results (default: print only)")
    args = ap.parse_args()

    config = ProductDashboardConfig.load(ETL / "config" / "product_dashboard.json")
    ex = ProductExclusionsLoader().load(args.file)
    conn = pymysql.connect(**db_settings())
    try:
        rows = query(conn, """SELECT ProductCompanyKey, Company, CAST(ProductKey AS CHAR) AS ProductKey, OdooProductID, CategoryID, Category,
                                     IsActive, ProductStatus, OnProductPages, ExcludedByProduct, ExcludedByCategory, ProductName,
                                     LifecycleSegment, LastSaleDate
                              FROM v_sales_product_dashboard WHERE Company IN ('Majaal', 'Tika')""")
        today = date.today()
        frm = today.replace(year=today.year - 1)
        sold_today = set(query(conn, """SELECT DISTINCT ProductCompanyKey FROM v_sales_product_daily
                                        WHERE OrderDate BETWEEN %s AND %s AND `Lines` > 0 AND Qty > 0 AND Company IN ('Majaal', 'Tika')""",
                                   (frm, today))["ProductCompanyKey"])
        lines = query(conn, """SELECT company_final AS Company, COALESCE(OdooProductID, ProductKey) AS ProductKey, OdooPartnerID, CustomerKey,
                                      SegmentKey, IsIntercompany, quantity AS Qty
                               FROM v_sales_lines WHERE order_date_date BETWEEN %s AND %s AND company_final IN ('Majaal', 'Tika')""",
                        (frm, today))
    finally:
        conn.close()

    for c in ("OdooPartnerID", "CustomerKey", "SegmentKey"):
        lines[c] = pd.to_numeric(lines[c], errors="coerce").astype("Int64")
    lines["IsIntercompany"] = lines["IsIntercompany"].fillna(0).astype(int).astype(bool)
    lines["Qty"] = pd.to_numeric(lines["Qty"], errors="coerce").fillna(0.0)
    lines["ProductCompanyKey"] = lines["Company"].astype(str) + "|" + lines["ProductKey"].astype(str).str.replace(r"\.0$", "", regex=True)
    builder = ProductDashboardBuilder(config, pd.Timestamp(today), ex)
    real = lines.loc[~builder.non_sales_mask(lines) & lines["Qty"].gt(0)]
    sold_next = set(real["ProductCompanyKey"])

    raw_names = builder.raw_material_category_names

    # today: the stored flags (the rules the last build applied) + today's sales
    before = rows.copy()
    before["Status"] = "NonActive"
    flagged = pd.to_numeric(before["ExcludedByProduct"], errors="coerce").eq(1) | pd.to_numeric(before["ExcludedByCategory"], errors="coerce").eq(1)
    arch = pd.to_numeric(before["IsActive"], errors="coerce").eq(0)
    stored = before["ProductStatus"].astype(str)
    before.loc[flagged | stored.eq("Unclassified"), "Status"] = "Unclassified"
    before.loc[~before["Status"].eq("Unclassified") & (arch | stored.eq("Dormant")), "Status"] = "Dormant"
    before.loc[before["Status"].eq("NonActive") & before["ProductCompanyKey"].isin(sold_today), "Status"] = "Active"

    after = classify(rows, ex, sold_next, raw_names)

    # what-if: the pending (Active = No) Exclude rows applied as well -- products, the Scrap category, the Tika root category
    def with_pending(sheet: str, keep_row=lambda df: True) -> ProductExclusions:
        ex_x = ProductExclusionsLoader().load(args.file)
        df = pd.read_excel(args.file, sheet_name=sheet, dtype=object)
        df.columns = [str(c).strip() for c in df.columns]
        idc = "Odoo Product ID" if sheet == "Products" else "Odoo Category ID"
        pend = df[df["Active"].astype(str).str.strip().str.lower().eq("no") & df["Action"].astype(str).str.strip().str.lower().eq("exclude")]
        pend = pend[pend.apply(keep_row, axis=1)]
        add = pd.DataFrame({"Company": pend["Company"].astype(str).str.strip(), "OdooID": pd.to_numeric(pend[idc], errors="coerce"),
                            "Action": "Exclude", "Row": pend.index + 2, "Name": ""}).dropna(subset=["OdooID"])
        add["OdooID"] = add["OdooID"].astype("int64")
        setattr(ex_x, sheet.lower(), pd.concat([ex_x.rules(sheet), add], ignore_index=True))
        return ex_x

    what_ifs = {
        "+194 pending products": classify(rows, with_pending("Products"), sold_next, raw_names),
        "+pending Scrap categ.": classify(rows, with_pending("Categories", lambda r: str(r["Odoo Category ID"]) != "1"), sold_next, raw_names),
        "+pending Tika root": classify(rows, with_pending("Categories", lambda r: str(r["Odoo Category ID"]) == "1"), sold_next, raw_names),
    }

    views = {"All": None, "Majaal": "Majaal", "Tika": "Tika"}
    report = {v: {"today": sku_counts(before, c), "next_refresh": sku_counts(after, c), **{k: sku_counts(w, c) for k, w in what_ifs.items()}}
              for v, c in views.items()}
    archived_and_excluded = after.loc[after["ArchivedAndExcluded"], "OdooProductID"].nunique()
    raw = after.loc[after["Rule"].eq("Raw Materials (automatic)"), "OdooProductID"].nunique()
    leak = rows[rows["OnProductPages"].eq(0) & rows["ProductStatus"].eq("NonActive")]
    moved = before[["ProductCompanyKey", "Company", "ProductName", "Status"]].merge(
        after[["ProductCompanyKey", "Status", "Rule"]], on="ProductCompanyKey", suffixes=("Today", "Next"))
    moved = moved[moved["StatusToday"].ne(moved["StatusNext"])]

    print(f"File: {args.file}\nActive rules: {ex.counts()}  ignored (Active = No): {ex.ignored}  skipped: {len(ex.skipped)}")
    print(f"Period: {frm} .. {today}")
    print(f"{'view':8} {'state':24} " + " ".join(f"{s:>12}" for s in ("Total", *STATUSES)))
    for v, r in report.items():
        for state, c in r.items():
            print(f"{v:8} {state:24} " + " ".join(f"{c[s]:>12,}" for s in ("Total", *STATUSES)))
    # Product Lifecycle (page rows = the portfolio): today vs the next refresh, with Discontinued = no sale in 365 days only
    def segments(frame: pd.DataFrame) -> dict[str, int]:
        port = frame[frame["Status"].isin(["Active", "NonActive"])]
        seg = port["LifecycleSegment"].fillna("Never sold").astype(str)
        return {k: int(v) for k, v in seg.value_counts().sort_index().items()}
    print("Lifecycle segments (portfolio rows) today:       ", segments(before))
    print("Lifecycle segments (portfolio rows) next refresh:", segments(after))
    print(f"Archived AND excluded (counted Unclassified, not Dormant): {archived_and_excluded} SKUs")
    print(f"Unclassified by the automatic Raw Materials rule: {raw} SKUs")
    print(f"Company rows off the pages but counted Non Active today (OnProductPages = 0): {len(leak)}")
    print(f"Company rows whose bucket changes at the next refresh: {len(moved)}")
    print(moved.groupby(["StatusToday", "StatusNext"]).size().to_string())
    if args.out:
        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        moved.to_csv(out / "product_status_changes_next_refresh.csv", index=False, encoding="utf-8-sig")
        after[after["Status"].eq("Unclassified")][["ProductCompanyKey", "Company", "ProductName", "Rule"]].to_csv(
            out / "unclassified_next_refresh.csv", index=False, encoding="utf-8-sig")
        (out / "product_status_check.json").write_text(json.dumps({"report": report, "archived_and_excluded": int(archived_and_excluded),
                                                                    "raw_materials": int(raw), "off_page_non_active_rows": int(len(leak)),
                                                                    "changed_rows": int(len(moved))}, indent=2), encoding="utf-8")
        print(f"written to {out}")


if __name__ == "__main__":
    main()
