from __future__ import annotations

from typing import Any

import pandas as pd

from sales_pipeline.odoo.base_repository import OdooRepositoryBase, flatten_many2one_columns
from sales_pipeline.odoo.client import OdooClient


STOCK_MOVE_FIELDS = [
    "id",
    "picking_id",
    "sale_line_id",
    "origin",
    "product_uom_qty",
    "product_qty",
    "quantity_done",
    "quantity",
    "state",
    "date",
    "create_date",
    "write_date",
]


class StockMoveRepository(OdooRepositoryBase):
    def __init__(self, client: OdooClient, batch_size: int = 500) -> None:
        super().__init__(client, batch_size)
        self.field_availability = pd.DataFrame()
        self.field_meta: dict[str, Any] = {}

    def fetch_moves(self, domain: list[Any] | None = None) -> pd.DataFrame:
        fields, qa, meta = self.available_fields("stock.move", STOCK_MOVE_FIELDS)
        self.field_meta = meta
        self.field_availability = qa
        return flatten_many2one_columns(self.search_read_all("stock.move", domain or [], fields, order="id"), meta)
