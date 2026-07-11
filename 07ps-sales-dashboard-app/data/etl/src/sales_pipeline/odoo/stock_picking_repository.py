from __future__ import annotations

from typing import Any

import pandas as pd

from sales_pipeline.odoo.base_repository import OdooRepositoryBase, flatten_many2one_columns
from sales_pipeline.odoo.client import OdooClient


STOCK_PICKING_FIELDS = [
    "id",
    "name",
    "sale_id",
    "origin",
    "partner_id",
    "user_id",
    "company_id",
    "picking_type_code",
    "scheduled_date",
    "date_done",
    "state",
    "create_date",
    "write_date",
]


class StockPickingRepository(OdooRepositoryBase):
    def __init__(self, client: OdooClient, batch_size: int = 500) -> None:
        super().__init__(client, batch_size)
        self.field_availability = pd.DataFrame()
        self.field_meta: dict[str, Any] = {}

    def fetch_pickings(self, domain: list[Any] | None = None) -> pd.DataFrame:
        fields, qa, meta = self.available_fields("stock.picking", STOCK_PICKING_FIELDS)
        self.field_meta = meta
        self.field_availability = qa
        return flatten_many2one_columns(self.search_read_all("stock.picking", domain or [], fields, order="id"), meta)
