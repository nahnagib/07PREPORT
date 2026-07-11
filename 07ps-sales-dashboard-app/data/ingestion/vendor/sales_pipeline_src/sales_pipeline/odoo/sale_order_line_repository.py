from __future__ import annotations

from typing import Any

import pandas as pd

from sales_pipeline.odoo.base_repository import OdooRepositoryBase, flatten_many2one_columns
from sales_pipeline.odoo.client import OdooClient


SALE_ORDER_LINE_FIELDS = [
    "id",
    "order_id",
    "name",
    "product_id",
    "salesman_id",
    "order_partner_id",
    "company_id",
    "price_subtotal",
    "price_total",
    "qty_invoiced",
    "product_uom_qty",
    "state",
    "invoice_status",
    "create_date",
    "write_date",
]


class SaleOrderLineRepository(OdooRepositoryBase):
    def __init__(self, client: OdooClient, batch_size: int = 500) -> None:
        super().__init__(client, batch_size)
        self.field_availability = pd.DataFrame()
        self.field_meta: dict[str, Any] = {}

    def fetch_lines(self, domain: list[Any] | None = None) -> pd.DataFrame:
        fields, qa, meta = self.available_fields("sale.order.line", SALE_ORDER_LINE_FIELDS)
        self.field_meta = meta
        self.field_availability = qa
        return flatten_many2one_columns(self.search_read_all("sale.order.line", domain or [], fields, order="id"), meta)
