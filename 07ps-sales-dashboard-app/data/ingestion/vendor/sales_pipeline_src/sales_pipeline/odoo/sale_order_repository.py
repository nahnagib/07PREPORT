from __future__ import annotations

from typing import Any

import pandas as pd

from sales_pipeline.odoo.base_repository import OdooRepositoryBase, flatten_many2one_columns
from sales_pipeline.odoo.client import OdooClient


SALE_ORDER_FIELDS = [
    "id", "name", "opportunity_id", "partner_id", "user_id", "team_id", "company_id",
    "date_order", "create_date", "write_date", "amount_untaxed", "amount_total", "state",
    "invoice_status", "delivery_status", "validity_date", "origin", "client_order_ref",
]


class SaleOrderRepository(OdooRepositoryBase):
    def __init__(self, client: OdooClient, batch_size: int = 500) -> None:
        super().__init__(client, batch_size)
        self.field_availability = pd.DataFrame()
        self.field_meta: dict[str, Any] = {}

    def fetch_orders(self, domain: list[Any] | None = None) -> pd.DataFrame:
        fields, qa, meta = self.available_fields("sale.order", SALE_ORDER_FIELDS)
        self.field_meta = meta
        self.field_availability = qa
        return flatten_many2one_columns(self.search_read_all("sale.order", domain or [], fields, order="id"), meta)
