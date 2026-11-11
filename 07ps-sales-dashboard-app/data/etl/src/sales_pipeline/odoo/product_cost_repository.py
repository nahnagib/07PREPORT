from __future__ import annotations

from typing import Any

import pandas as pd

from sales_pipeline.odoo.base_repository import OdooRepositoryBase, flatten_many2one_columns
from sales_pipeline.odoo.client import OdooClient
from sales_pipeline.odoo_products import SUPPLIERINFO_FIELDS, with_main_vendor


PRODUCT_COST_FIELDS = [
    "id",
    "product_tmpl_id",
    "name",
    "display_name",
    "default_code",
    "company_id",
    "standard_price",
    "active",
    # the product layer (sales_pipeline.odoo_products): category, sub brand, family, size -- straight from Odoo; the brand
    # is the main vendor (product.supplierinfo, read below)
    "categ_id",
    "sub_brand_id",
    "product_family_id",
    "size_dimensions_id",
]
# Archived = product.product.active = False OR product.template.active = False (2026-11-11): the template's flag is read too
PRODUCT_TEMPLATE_FIELDS = ["id", "active"]
# product.category: the tree (parent_path "1/30/57/") for sub-categories, and the own name for a Raw Materials category
PRODUCT_CATEGORY_FIELDS = ["id", "name", "complete_name", "parent_path"]


def with_template_active(products: pd.DataFrame, template_active: dict[int, bool]) -> pd.DataFrame:
    """Adds `template_active` (the variant's product.template.active; True when the template is unknown)."""
    out = products.copy()
    tmpl = out["product_tmpl_id_id"] if "product_tmpl_id_id" in out.columns else out.get("product_tmpl_id", pd.Series(pd.NA, index=out.index))
    tmpl = tmpl.map(lambda v: v[0] if isinstance(v, (list, tuple)) and v else v)
    out["template_active"] = pd.to_numeric(tmpl, errors="coerce").map(lambda t: True if pd.isna(t) else template_active.get(int(t), True))
    return out


class ProductCostRepository(OdooRepositoryBase):
    """Extract standard product cost and matching identifiers from Odoo."""

    def __init__(self, client: OdooClient, batch_size: int = 500) -> None:
        super().__init__(client, batch_size)
        self.field_availability = pd.DataFrame()

    def fetch_product_costs(self) -> pd.DataFrame:
        """One row per (product, company whose cost it is).

        standard_price is company-dependent in Odoo 17: read without a company context it returns the
        user's default company's value (Majaal), which is 0 for every Tika-only product. So the catalog
        is read once per company the API user can access, with allowed_company_ids set, and each row is
        tagged with that company in `cost_company`."""
        fields, qa, meta = self.available_fields("product.product", PRODUCT_COST_FIELDS)
        self.field_availability = qa
        frames = []
        for company_id, company_name in self._accessible_companies():
            rows = self.search_read_all(
                "product.product",
                [],
                fields,
                order="id",
                context={"active_test": False, "allowed_company_ids": [company_id], "force_company": company_id},
            )
            rows = flatten_many2one_columns(rows, meta)
            rows["cost_company"] = company_name
            rows["cost_company_id"] = company_id
            frames.append(rows)
        if not frames:
            return pd.DataFrame(columns=fields + ["cost_company", "cost_company_id", "vendor", "template_active"])
        out = with_main_vendor(pd.concat(frames, ignore_index=True), self.fetch_vendor_lines())
        return with_template_active(out, self.fetch_template_active())

    def fetch_template_active(self) -> dict[int, bool]:
        """product.template id -> active (archived templates included)."""
        rows = self.search_read_all("product.template", [], PRODUCT_TEMPLATE_FIELDS, order="id", context={"active_test": False})
        records = rows.to_dict("records") if isinstance(rows, pd.DataFrame) else list(rows)
        return {int(r["id"]): bool(r.get("active")) for r in records}

    def fetch_categories(self) -> pd.DataFrame:
        """Every product.category with its parent_path (the tree) and own name."""
        rows = self.search_read_all("product.category", [], PRODUCT_CATEGORY_FIELDS, order="id")
        frame = rows if isinstance(rows, pd.DataFrame) else pd.DataFrame(list(rows))
        return frame.reindex(columns=PRODUCT_CATEGORY_FIELDS) if frame.empty else frame

    def fetch_vendor_lines(self) -> list[dict[str, Any]]:
        """Every vendor line (Purchase tab) of every product, read in each company the ETL user can access (a line can
        belong to one company), each line once: the Brand is the template's main vendor."""
        fields, _, _ = self.available_fields("product.supplierinfo", SUPPLIERINFO_FIELDS)
        if "partner_id" not in fields or "product_tmpl_id" not in fields:
            return []
        seen: dict[int, dict[str, Any]] = {}
        for company_id, _name in self._accessible_companies() or [(None, None)]:
            ctx = {"active_test": False} if company_id is None else {"active_test": False, "allowed_company_ids": [company_id], "force_company": company_id}
            rows = self.search_read_all("product.supplierinfo", [], fields, order="id", context=ctx)
            for r in (rows.to_dict("records") if isinstance(rows, pd.DataFrame) else list(rows)):
                seen.setdefault(int(r["id"]), r)
        return list(seen.values())

    def _accessible_companies(self) -> list[tuple[int, str]]:
        uid = self.client.uid or self.client.authenticate()
        user = self.client.search_read("res.users", [["id", "=", uid]], ["company_ids"], limit=1)
        company_ids = user[0]["company_ids"] if user else []
        if not company_ids:
            return []
        companies = self.client.search_read("res.company", [["id", "in", company_ids]], ["id", "name"], limit=0)
        return [(int(c["id"]), str(c["name"])) for c in sorted(companies, key=lambda c: c["id"])]
