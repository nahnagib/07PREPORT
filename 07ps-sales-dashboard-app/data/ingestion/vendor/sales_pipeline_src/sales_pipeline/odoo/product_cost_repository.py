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
        fields, qa, meta = self.available_fields("product.product", PRODUCT_COST_FIELDS)
        self.field_availability = qa
        rows = self.search_read_all(
            "product.product",
            [],
            fields,
            order="id",
            context={"active_test": False},
        )
        return flatten_many2one_columns(rows, meta)
