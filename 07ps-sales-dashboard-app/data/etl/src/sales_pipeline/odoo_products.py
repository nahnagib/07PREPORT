"""Products come from Odoo and nowhere else (2026-11-03; PRODUCTS.xlsx and every product-name rule are retired).

Identity is the Odoo product.product id (ProductKey), with its product_tmpl_id and company. Nothing is ever matched,
grouped or joined on a product name, and no name is rewritten: ProductName is product.product.name byte-for-byte as
Odoo returns it (no [code] stripping, case, whitespace or Arabic changes); the internal reference is its own column (SKU).

Attributes, straight from product.product (the template's fields):
  Category  categ_id, full path as Odoo stores it ("الكل / بورسلين Tier 1- 30x90")
  Brand     the main vendor (Purchase tab, seller_ids -> product.supplierinfo): the lowest sequence, then the lowest
            minimum quantity, then the oldest line -- Odoo's own order for the vendor it buys from first
  SubBrand  sub_brand_id           Family  product_family_id
  Size      size_dimensions_id     SKU       default_code        IsActive  active
An empty attribute is 'Unassigned' (never a fallback to anything else); SKU stays empty. Discount lines are the product
ids listed in config/product_dashboard.json (discount_product_ids) -- flagged, never renamed.
"""

from __future__ import annotations

from typing import Any, Iterable

import pandas as pd

from sales_pipeline.product_matching import normalize_match_company

UNASSIGNED = "Unassigned"
UNKNOWN_PRODUCT_KEY = "-1"
# column on the product table -> Odoo field
ATTRIBUTE_FIELDS = {
    "Category": "categ_id",
    "Brand": "vendor",  # main vendor's name, added to the product rows by main_vendors() / with_main_vendor()
    "SubBrand": "sub_brand_id",
    "Family": "product_family_id",
    "Size": "size_dimensions_id",
}
# product.product fields the ETL reads for the product layer (in addition to id / cost fields)
ODOO_PRODUCT_FIELDS = ["categ_id", "sub_brand_id", "product_family_id", "size_dimensions_id"]
# product.supplierinfo fields read for the Brand (the main vendor)
SUPPLIERINFO_FIELDS = ["id", "partner_id", "product_tmpl_id", "sequence", "min_qty"]
CATALOG_COLUMNS = [
    "OdooProductID", "ProductTemplateID", "ProductName", "OdooProductName", "SKU",
    *ATTRIBUTE_FIELDS, "CategoryID", "IsActive", "ProductCompanyID", "ProductCompany",
]
# what attach() puts on each sales line
LINE_COLUMNS = ["ProductKey", "OdooProductID", "ProductTemplateID", "ProductName", "OdooProductName", "SKU", *ATTRIBUTE_FIELDS,
                "ProductIsActive", "is_discount"]


def _present(value: Any) -> bool:
    """Odoo's 'no value' is False / None / ''; anything else is a value, kept exactly as given."""
    if value is None or value is False:
        return False
    if isinstance(value, float) and pd.isna(value):
        return False
    if value is pd.NA:
        return False
    return not (isinstance(value, str) and value == "")


def _value(value: Any) -> Any:
    return value if _present(value) else pd.NA


def _int(value: Any) -> Any:
    try:
        return int(value) if _present(value) else pd.NA
    except (TypeError, ValueError):
        return pd.NA


def catalog(product_raw: pd.DataFrame | None) -> pd.DataFrame:
    """One row per Odoo product id from the product.product extract (ProductCostRepository / the mirror). The extract
    has one row per (product, company whose cost it is); the attributes are the same on every row of a product."""
    if product_raw is None or product_raw.empty or "id" not in product_raw.columns:
        return pd.DataFrame(columns=CATALOG_COLUMNS)
    raw = product_raw.drop_duplicates("id", keep="first")

    def col(name: str) -> pd.Series:
        return raw[name] if name in raw.columns else pd.Series(pd.NA, index=raw.index, dtype=object)

    tmpl = col("product_tmpl_id_id") if "product_tmpl_id_id" in raw.columns else col("product_tmpl_id")
    company = col("company_id_id")
    out = pd.DataFrame({
        "OdooProductID": raw["id"].map(_int).astype("Int64"),
        "ProductTemplateID": tmpl.map(_int).astype("Int64"),
        "ProductName": col("name").map(_value).astype(object),
        "OdooProductName": col("display_name").map(_value).astype(object),
        "SKU": col("default_code").map(_value).astype(object),
        "IsActive": col("active").map(lambda v: bool(v) if _present(v) else False),
        "ProductCompanyID": company.map(_int).astype("Int64"),
        "ProductCompany": col("company_id").map(_value).astype(object),
        "CategoryID": col("categ_id_id").map(_int).astype("Int64"),
    })
    for column, field in ATTRIBUTE_FIELDS.items():
        out[column] = col(field).map(lambda v: v if _present(v) else UNASSIGNED).astype(object)
    out = out.dropna(subset=["OdooProductID"]).reset_index(drop=True)
    return out[CATALOG_COLUMNS]


def _m2o(value: Any) -> tuple[Any, Any]:
    """(id, display name) of an Odoo many2one as read over XML-RPC ([id, name]) or flattened (id / name)."""
    if isinstance(value, (list, tuple)) and len(value) == 2:
        return value[0], value[1]
    return value, None


def main_vendors(supplierinfo: Iterable[dict[str, Any]]) -> dict[int, str]:
    """product_tmpl_id -> the name of its main vendor: the vendor line with the lowest sequence, then the lowest minimum
    quantity, then the lowest id (the order Odoo lists the Purchase tab in and buys from first)."""
    best: dict[int, tuple] = {}
    for row in supplierinfo:
        tmpl, _ = _m2o(row.get("product_tmpl_id"))
        _, partner = _m2o(row.get("partner_id"))
        if partner is None and _present(row.get("partner_name")):
            partner = row.get("partner_name")
        tid = _int(tmpl)
        if tid is pd.NA or not _present(partner):
            continue
        rank = (row.get("sequence") or 0, row.get("min_qty") or 0, row.get("id") or 0)
        if tid not in best or rank < best[tid][0]:
            best[tid] = (rank, partner)
    return {t: name for t, (_, name) in best.items()}


def with_main_vendor(product_raw: pd.DataFrame, supplierinfo: Iterable[dict[str, Any]]) -> pd.DataFrame:
    """The product.product rows with a `vendor` column (the main vendor of their template; empty when none)."""
    out = product_raw.copy()
    vendors = main_vendors(supplierinfo)
    tmpl = out["product_tmpl_id_id"] if "product_tmpl_id_id" in out.columns else out.get("product_tmpl_id", pd.Series(pd.NA, index=out.index))
    out["vendor"] = tmpl.map(lambda t: vendors.get(_int(t)) if _int(t) is not pd.NA else None).astype(object)
    return out


def discount_ids(config_section: dict[str, Any] | None) -> set[int]:
    return {int(v) for v in (config_section or {}).get("discount_product_ids", [])}


def product_company_key(company: Any, product_key: Any) -> str:
    """Grain of the Product pages: one product (Odoo id) in one company ('Majaal|2163')."""
    return f"{normalize_match_company(company)}|{product_key}"


def product_company_keys(company: pd.Series, product_key: pd.Series) -> pd.Series:
    companies = company.astype("object").where(company.notna(), "")
    names = {v: normalize_match_company(v) for v in pd.unique(companies)}
    return (companies.map(names).astype(str) + "|" + product_key.astype(str)).astype("string")


def template_group_key(template_id: Any, product_company: str) -> str:
    """Cross-company (BMH) group of the Product pages: the Odoo template; a product without one stays on its own."""
    tid = _int(template_id)
    return f"T|{tid}" if tid is not pd.NA else str(product_company)


def attach(sales: pd.DataFrame, products: pd.DataFrame, discount_product_ids: Iterable[int] = ()) -> pd.DataFrame:
    """Puts the Odoo product on every sales line by its Odoo product id. Never adds or drops a line. A line whose id is
    not in the catalog (or has none) keeps the product name the line itself carries from Odoo, ProductKey '-1' when it
    has no id, and 'Unassigned' attributes."""
    out = sales.copy()
    rows_in = len(out)
    pid = pd.to_numeric(out["OdooProductID"] if "OdooProductID" in out.columns else pd.Series(pd.NA, index=out.index),
                        errors="coerce").astype("Int64")
    out["OdooProductID"] = pid
    line_name = out["product_name"] if "product_name" in out.columns else pd.Series(pd.NA, index=out.index, dtype=object)
    by_id = products.drop_duplicates("OdooProductID").set_index("OdooProductID") if len(products) else products
    found = pid.isin(by_id.index) if len(products) else pd.Series(False, index=out.index)

    def pick(column: str, default: Any) -> pd.Series:
        if not len(products):
            return pd.Series(default, index=out.index, dtype=object)
        mapped = pid.map(by_id[column]) if column in by_id.columns else pd.Series(pd.NA, index=out.index)
        return mapped.where(found, default).astype(object)

    out["ProductKey"] = pid.astype("string").fillna(UNKNOWN_PRODUCT_KEY)
    out["ProductTemplateID"] = pick("ProductTemplateID", pd.NA)
    out["ProductName"] = pick("ProductName", pd.NA).where(found, line_name)
    out["OdooProductName"] = pick("OdooProductName", pd.NA).where(found, line_name)
    out["SKU"] = pick("SKU", pd.NA)
    for column in ATTRIBUTE_FIELDS:
        out[column] = pick(column, UNASSIGNED).fillna(UNASSIGNED)
    out["ProductIsActive"] = pick("IsActive", pd.NA)
    ids = {int(v) for v in discount_product_ids}
    out["is_discount"] = pid.isin(list(ids)).fillna(False).astype(bool) if ids else False
    out["product_name"] = out["ProductName"]
    if len(out) != rows_in:
        raise AssertionError(f"odoo_products.attach changed the row count ({rows_in} -> {len(out)})")
    return out


def dim_product(products: pd.DataFrame) -> pd.DataFrame:
    """The legacy Dim_Product sheet, now the Odoo catalog keyed by ProductKey = str(Odoo id)."""
    out = products.copy()
    out.insert(0, "ProductKey", out["OdooProductID"].astype("string"))
    return out.reset_index(drop=True)
