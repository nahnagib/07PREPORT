from __future__ import annotations

from typing import Any

import pandas as pd

from sales_pipeline.odoo.base_repository import OdooRepositoryBase, flatten_many2one_columns
from sales_pipeline.odoo.client import OdooClient


PRODUCT_COST_FIELDS = [
    "id",
    "product_tmpl_id",
    "name",
    "display_name",
    "default_code",
    "company_id",
    "standard_price",
    "active",
]


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
            return pd.DataFrame(columns=fields + ["cost_company", "cost_company_id"])
        return pd.concat(frames, ignore_index=True)

    def _accessible_companies(self) -> list[tuple[int, str]]:
        uid = self.client.uid or self.client.authenticate()
        user = self.client.search_read("res.users", [["id", "=", uid]], ["company_ids"], limit=1)
        company_ids = user[0]["company_ids"] if user else []
        if not company_ids:
            return []
        companies = self.client.search_read("res.company", [["id", "in", company_ids]], ["id", "name"], limit=0)
        return [(int(c["id"]), str(c["name"])) for c in sorted(companies, key=lambda c: c["id"])]
