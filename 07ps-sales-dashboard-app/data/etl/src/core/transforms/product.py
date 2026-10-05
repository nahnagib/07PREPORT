"""Products.

  dim_product         one row per Odoo product.product (the variant that was sold); ProductKey = its id
  dim_product_master  the PRODUCTS.xlsx catalogue, incl. products never sold; ProductMasterKey = frozen sheet code
  map_product_master  (ProductKey, CompanyKey) -> ProductMasterKey, many-to-one, using the existing company-aware
                      matching (sales_pipeline.product_matching): an OdooProductID in the sheet wins, otherwise
                      Company + normalized Odoo name. No match -> '-1'.

Why the old dim_product had 1,134 products twice per company: an unmatched product got one "ODOO|<id>" row from
the Odoo catalogue AND one "RAW_FROM_ODOO|<hash>" row from its sales lines. Keying on the Odoo id removes that.
"""

from __future__ import annotations

import hashlib
from typing import Mapping

import pandas as pd

from core.keys import UNKNOWN, UNKNOWN_TEXT
from sales_pipeline.legacy_transform import TextUtils
from sales_pipeline.product_matching import match_key, match_key_series

STATUS_ID = "MatchedByOdooProductID"
STATUS_NAME = "MatchedByCompanyAndName"
STATUS_NONE = "Unmatched"


class ProductMasterError(ValueError):
    def __init__(self, problems: list[str]) -> None:
        self.problems = problems
        super().__init__("PRODUCTS.xlsx is inconsistent:\n  - " + "\n  - ".join(problems[:50]))


def generated_master_key(sheet_key, product_match_key: str) -> str:
    """Key for a sheet row whose ProductMasterKey cell is blank: '<sheet code or PRODUCT>|<hash>'. Always
    suffixed, so it depends on that row alone (the legacy rule only suffixed duplicated codes, so adding a row
    could change another row's key)."""
    base = str(sheet_key).strip() if isinstance(sheet_key, str) and sheet_key.strip() else "PRODUCT"
    return f"{base}|{hashlib.sha1(product_match_key.encode('utf-8')).hexdigest()[:10].upper()}"


def complete_master_keys(raw_products: pd.DataFrame) -> pd.DataFrame:
    """Fills blank ProductMasterKey cells (before the rows are stored in raw_excel_products)."""
    df = raw_products.copy()
    mk = match_key_series(df["Company"], df["OdooProductName"])
    blank = df["ProductMasterKey"].isna() | (df["ProductMasterKey"].astype(str).str.strip() == "")
    df.loc[blank, "ProductMasterKey"] = [generated_master_key(s, m) for s, m in zip(df.loc[blank, "SheetProductKey"], mk[blank])]
    return df


def build_product_master(raw_products: pd.DataFrame, company_keys: Mapping[str, int]) -> pd.DataFrame:
    df = raw_products.copy()
    df["ProductMatchKey"] = match_key_series(df["Company"], df["OdooProductName"])
    problems = []
    for col in ("ProductMasterKey", "ProductMatchKey"):
        dup = df[col].duplicated(keep=False)
        for value, group in df[dup].groupby(col):
            problems.append(f"{col} {value!r} appears on several rows: {', '.join(str(r) for r in group['_excel_row'])}")
    if (df["ProductMasterKey"] == UNKNOWN_TEXT).any():
        problems.append("ProductMasterKey '-1' is reserved for unmatched products")
    if problems:
        raise ProductMasterError(problems)
    name = df["ProductName"].where(df["ProductName"].notna() & (df["ProductName"].astype(str).str.strip() != ""),
                                   df["OdooProductName"].astype(str).str.replace(r"^\s*\[[^\]]*\]\s*", "", regex=True).str.strip())
    return pd.DataFrame({
        "ProductMasterKey": df["ProductMasterKey"],
        "SheetProductKey": df["SheetProductKey"],
        "CompanyKey": df["Company"].map(lambda c: company_keys.get(c, UNKNOWN)),
        "Company": df["Company"],
        "ProductName": name,
        "ProductNameClean": TextUtils.product_name_frame(name)["ProductNameClean"],
        "OdooProductName": df["OdooProductName"],
        "ProductMatchKey": df["ProductMatchKey"],
        "Category": df["Category"], "Brand": df["Brand"], "SubBrand": df["SubBrand"], "Family": df["Family"],
        "ProductLevel": df["ProductLevel"], "SKU": df["SKU"], "Size": df["Size"],
        "IsActive": df["IsActive"].map(lambda v: None if v is None or pd.isna(v) else int(bool(v))),
    }).reset_index(drop=True)


def build_products(raw_product: pd.DataFrame) -> pd.DataFrame:
    return pd.DataFrame({
        "ProductKey": raw_product["id"].astype("int64"),
        "product_tmpl_id": raw_product["product_tmpl_id"],
        "OdooProductName": raw_product["display_name"].where(raw_product["display_name"].notna(), raw_product["name"]),
        "product_name": raw_product["name"],
        "default_code": raw_product["default_code"],
        "CompanyKey": raw_product["company_id"].map(lambda v: UNKNOWN if pd.isna(v) else int(v)),
        "category": raw_product["categ_name"],
        "uom": raw_product["uom_name"],
        "product_type": raw_product["detailed_type"],
        "active": raw_product["active"].fillna(True).astype(int),
        "is_deleted": raw_product["_deleted_at"].notna().astype(int) if "_deleted_at" in raw_product else 0,
    }).reset_index(drop=True)


def unmatched_report(products: pd.DataFrame, pm_map: pd.DataFrame, sales: pd.DataFrame | None,
                     company_names: Mapping[int, str]) -> pd.DataFrame:
    """The (product, company) pairs with no PRODUCTS.xlsx row, biggest sales first, so the catalogue owner fixes
    the ones that matter most first (docs/product_unmatched.csv). ``sales`` has ProductKey, CompanyKey,
    sales_value, sales_value_last_12m, line_count, last_sale_date; pairs never sold are listed last with 0."""
    un = pm_map[pm_map["match_status"] == STATUS_NONE][["ProductKey", "CompanyKey"]]
    un = un.merge(products[["ProductKey", "OdooProductName", "default_code", "category", "active"]], on="ProductKey", how="left")
    cols = ["sales_value", "sales_value_last_12m", "line_count", "last_sale_date"]
    if sales is not None and len(sales):
        un = un.merge(sales[["ProductKey", "CompanyKey", *cols]], on=["ProductKey", "CompanyKey"], how="left")
    else:
        for c in cols:
            un[c] = None
    for c in ("sales_value", "sales_value_last_12m", "line_count"):
        un[c] = pd.to_numeric(un[c], errors="coerce").fillna(0)
    un["company"] = un["CompanyKey"].map(company_names)
    un = un.sort_values(["sales_value", "sales_value_last_12m", "ProductKey"], ascending=[False, False, True])
    return un[["company", "ProductKey", "OdooProductName", "default_code", "category", "active", *cols]].reset_index(drop=True)


def build_product_master_map(products: pd.DataFrame, master: pd.DataFrame, companies: Mapping[int, str]) -> pd.DataFrame:
    """One row per (product, in-scope company the product can be sold in): products restricted to a company
    only get that company; shared products (CompanyKey -1) get every in-scope company."""
    by_id = {}
    if "OdooProductID" in master.columns:
        for pid, company_key, mkey in zip(master["OdooProductID"], master["CompanyKey"], master["ProductMasterKey"]):
            if pid is not None and not pd.isna(pid):
                by_id[(int(pid), int(company_key))] = mkey
    by_name = dict(zip(master["ProductMatchKey"], master["ProductMasterKey"]))
    rows = []
    for p in products[products["ProductKey"] != UNKNOWN].itertuples(index=False):
        targets = companies.items() if p.CompanyKey == UNKNOWN else [(p.CompanyKey, companies[p.CompanyKey])] if p.CompanyKey in companies else []
        for company_key, company_name in targets:
            key = by_id.get((int(p.ProductKey), int(company_key)))
            status = STATUS_ID
            if key is None:
                key = by_name.get(match_key(company_name, p.OdooProductName))
                status = STATUS_NAME
            if key is None:
                key, status = UNKNOWN_TEXT, STATUS_NONE
            rows.append((int(p.ProductKey), int(company_key), key, status))
    return pd.DataFrame(rows, columns=["ProductKey", "CompanyKey", "ProductMasterKey", "match_status"])
