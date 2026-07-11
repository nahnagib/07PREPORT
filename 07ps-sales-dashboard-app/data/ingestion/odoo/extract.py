"""Odoo extraction, reusing the vendored pipeline's own repository classes unmodified.

This mirrors exactly what ``PowerBISalesPipeline.run()`` does in its full (non-incremental)
Odoo-extraction steps (``extract_product_cost_and_inventory`` + ``extract_sale_report`` +
``extract_crm_models`` in the vendored ``pipeline.py``, lines ~223-369) - same repository
classes, same models, same fields. The only thing this module changes is *which client* those
repositories talk to.

Two client modes:
  - mock (default, and the only mode this session is permitted to run): ``MockOdooClient``
    loaded from ``fixtures.py``, zero network calls.
  - live: the real vendored ``sales_pipeline.odoo.client.OdooClient``, gated behind the
    ``ALLOW_LIVE_ODOO=1`` environment variable. Per this session's explicit instruction, this
    path is wired but must not be exercised without separate confirmation - see README.md.

No business logic (product mastering, quotation classification, CRM status, etc.) lives here;
that all happens later, inside the unmodified ``pipeline.transform()`` / ``pipeline.transform_crm()``
calls in ``orchestrator.py``, exactly like the vendored ``pipeline.run()`` does internally.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any

import pandas as pd

from odoo.fixtures import MOCK_ODOO_DATA
from odoo.mock_client import MockOdooClient

from sales_pipeline.odoo import (
    CrmRepository,
    ProductCostRepository,
    SaleOrderRepository,
    SalesReportRepository,
    StockMoveRepository,
    StockPickingRepository,
)
from sales_pipeline.inventory import InventoryRepository

logger = logging.getLogger(__name__)


@dataclass
class ExtractedOdooData:
    sales_raw: pd.DataFrame
    leads_raw: pd.DataFrame
    stages_raw: pd.DataFrame
    lost_reasons_raw: pd.DataFrame
    sale_orders_raw: pd.DataFrame
    stock_pickings_raw: pd.DataFrame
    stock_moves_raw: pd.DataFrame
    product_cost_raw: pd.DataFrame
    stock_quants_raw: pd.DataFrame
    stock_locations_raw: pd.DataFrame
    inventory_companies_raw: pd.DataFrame
    field_availability: pd.DataFrame
    source: str  # "mock" | "live"


def build_client(batch_size: int = 500):
    """Returns an Odoo-client-shaped object. Defaults to MockOdooClient; only switches to the
    real vendored OdooClient if ALLOW_LIVE_ODOO=1 is explicitly set in the environment - and even
    then, this session's instruction was not to actually invoke a live extraction without a
    separate human confirmation, so callers (orchestrator.py) must not set this themselves.
    """
    if os.environ.get("ALLOW_LIVE_ODOO") == "1":
        from config.settings import Settings
        from sales_pipeline.odoo import OdooClient

        settings = Settings.from_env()
        settings.validate(require_database=False)
        client = OdooClient(
            url=settings.odoo_url,
            db=settings.odoo_db,
            username=settings.odoo_user,
            api_key=settings.odoo_api_key,
            timeout_seconds=settings.rpc_timeout_seconds,
            max_retries=settings.max_retries,
        )
        client.authenticate()
        logger.warning("LIVE Odoo client active (ALLOW_LIVE_ODOO=1) - this makes real network calls.")
        return client, "live"

    client = MockOdooClient(models=MOCK_ODOO_DATA)
    client.authenticate()
    return client, "mock"


def extract_all(batch_size: int = 500) -> ExtractedOdooData:
    """Runs the same repository calls pipeline.run() makes in full/non-incremental mode."""
    client, source = build_client(batch_size)

    def fresh_client():
        # The real pipeline gives each repository its own OdooClient instance for thread safety
        # (see pipeline.py::_make_odoo_client). MockOdooClient is a plain in-memory dataclass, so
        # instances can safely share the same object - one is used everywhere.
        return client

    product_cost_repo = ProductCostRepository(fresh_client(), batch_size)
    product_cost_raw = product_cost_repo.fetch_product_costs()

    inv_quants_repo = InventoryRepository(fresh_client(), batch_size)
    stock_quants_raw = inv_quants_repo.fetch_stock_quants()
    inv_locs_repo = InventoryRepository(fresh_client(), batch_size)
    stock_locations_raw = inv_locs_repo.fetch_locations()
    inv_comp_repo = InventoryRepository(fresh_client(), batch_size)
    inventory_companies_raw = inv_comp_repo.fetch_companies()

    sales_report_repo = SalesReportRepository(client=fresh_client(), batch_size=batch_size)
    sales_raw = sales_report_repo.fetch_sale_report()

    crm_leads_repo = CrmRepository(fresh_client(), batch_size)
    leads_raw = crm_leads_repo.fetch_leads()
    crm_stages_repo = CrmRepository(fresh_client(), batch_size)
    stages_raw = crm_stages_repo.fetch_stages()
    crm_lost_repo = CrmRepository(fresh_client(), batch_size)
    lost_reasons_raw = crm_lost_repo.fetch_lost_reasons()

    order_repo = SaleOrderRepository(fresh_client(), batch_size)
    sale_orders_raw = order_repo.fetch_orders()

    picking_repo = StockPickingRepository(fresh_client(), batch_size)
    stock_pickings_raw = picking_repo.fetch_pickings()

    move_repo = StockMoveRepository(fresh_client(), batch_size)
    stock_moves_raw = move_repo.fetch_moves()

    field_availability = pd.concat(
        [
            product_cost_repo.field_availability,
            crm_leads_repo.field_availability,
            crm_stages_repo.field_availability,
            crm_lost_repo.field_availability,
            order_repo.field_availability,
            picking_repo.field_availability,
            move_repo.field_availability,
        ],
        ignore_index=True,
    )

    logger.info(
        "Odoo extraction complete (source=%s): sale.report=%d crm.lead=%d sale.order=%d "
        "stock.picking=%d stock.move=%d product.product=%d stock.quant=%d",
        source, len(sales_raw), len(leads_raw), len(sale_orders_raw), len(stock_pickings_raw),
        len(stock_moves_raw), len(product_cost_raw), len(stock_quants_raw),
    )

    return ExtractedOdooData(
        sales_raw=sales_raw,
        leads_raw=leads_raw,
        stages_raw=stages_raw,
        lost_reasons_raw=lost_reasons_raw,
        sale_orders_raw=sale_orders_raw,
        stock_pickings_raw=stock_pickings_raw,
        stock_moves_raw=stock_moves_raw,
        product_cost_raw=product_cost_raw,
        stock_quants_raw=stock_quants_raw,
        stock_locations_raw=stock_locations_raw,
        inventory_companies_raw=inventory_companies_raw,
        field_availability=field_availability,
        source=source,
    )
