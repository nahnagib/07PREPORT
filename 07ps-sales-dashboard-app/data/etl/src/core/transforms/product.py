"""Products: dim_product = one row per Odoo product.product (the variant that was sold); ProductKey = its id.

Odoo is the only source (2026-11-03): PRODUCTS.xlsx, dim_product_master and map_product_master are retired, and no
product is ever matched, grouped or renamed by its name. Every column is Odoo's value as stored; an empty category,
brand, sub brand, family or size is 'Unassigned' (sales_pipeline.odoo_products.UNASSIGNED), never a fallback.
"""

from __future__ import annotations

import pandas as pd

from core.keys import UNKNOWN
from sales_pipeline.odoo_products import UNASSIGNED

# dim_product column -> raw_odoo_product_product column (an m2o display name; categ_name = the full category path)
ATTRIBUTES = {"category": "categ_name", "brand": "brand", "sub_brand": "sub_brand", "family": "family", "size": "size"}


def _attr(raw: pd.DataFrame, col: str) -> pd.Series:
    values = raw[col] if col in raw.columns else pd.Series(None, index=raw.index, dtype=object)
    return values.map(lambda v: UNASSIGNED if v is None or (isinstance(v, float) and pd.isna(v)) or v is pd.NA or v == "" else v)


def build_products(raw_product: pd.DataFrame) -> pd.DataFrame:
    out = pd.DataFrame({
        "ProductKey": raw_product["id"].astype("int64"),
        "product_tmpl_id": raw_product["product_tmpl_id"],
        "OdooProductName": raw_product["display_name"],
        "product_name": raw_product["name"],
        "default_code": raw_product["default_code"],
        "CompanyKey": raw_product["company_id"].map(lambda v: UNKNOWN if pd.isna(v) else int(v)),
        "categ_id": raw_product["categ_id"] if "categ_id" in raw_product.columns else None,
    })
    for column, source in ATTRIBUTES.items():
        out[column] = _attr(raw_product, source)
    out["uom"] = raw_product["uom_name"]
    out["product_type"] = raw_product["detailed_type"]
    out["active"] = raw_product["active"].fillna(True).astype(int)
    out["is_deleted"] = raw_product["_deleted_at"].notna().astype(int) if "_deleted_at" in raw_product else 0
    return out.reset_index(drop=True)
