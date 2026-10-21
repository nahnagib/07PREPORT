"""Which sales rows a 30-minute cycle must recompute (Phase B, docs/etl-phase-b-sales-incremental.md sections 4-5).

Inputs:
* ``SourceChanges`` -- Odoo records the raw mirrors upserted / deleted in this cycle (by write_date, 5-minute overlap;
  deletions from the id checks);
* ``DimChanges`` -- shared-list records that really changed (core_dims writes only changed rows and stamps
  updated_at_utc; deleted map keys come from etl_task_log details);
* ``SalesIndex`` -- the current state: the raw mirrors (NEW values: which order has which customer / salesperson /
  team, which line which product) and the live sales facts (OLD values: which keys a row carries now).

Rule: a row is recomputed when its OLD or its NEW values touch a change (a line moved to another product, an order to
another customer: both the old and the new aggregates are refreshed). Every unit is then recomputed with the full
refresh's own builders (option b): orders -> their sale.report rows, order/document facts and invoice summary;
customers -> First_Purchase_Date / CustomerStatus on all their rows; (company, product, date) -> product daily;
(salesperson, month) -> target ASPs; companies -> BCG / product dashboard (or nightly); pickings -> deliveries; leads ->
leads / opportunities / journeys; (company, product) -> inventory snapshot incl. Avg_Daily_Sales / DOH (they mix the
calendar with quants AND sales lines, so they are recomputed in the same cycle for those products).

``Affected.full_rebuild_reason`` is set when the cycle would recompute more than ``max_rows`` sales lines (e.g. a team
re-mapped in SalesTeam.xlsx): the caller then queues a full sales rebuild instead (the other modules keep running).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

import pandas as pd

DEFAULT_MAX_ROWS = 50_000


def _ids(values: Iterable) -> set[int]:
    return {int(v) for v in values if v is not None and not (isinstance(v, float) and pd.isna(v)) and v is not pd.NA}


@dataclass
class SourceChanges:
    orders: set[int] = field(default_factory=set)                 # sale.order upserted
    lines: set[int] = field(default_factory=set)                  # sale.order.line upserted
    deleted_orders: set[int] = field(default_factory=set)
    deleted_lines: dict[int, int] = field(default_factory=dict)   # line id -> its order id (from the mirror, before delete)
    pickings: set[int] = field(default_factory=set)
    moves: set[int] = field(default_factory=set)
    deleted_pickings: set[int] = field(default_factory=set)
    leads: set[int] = field(default_factory=set)                  # crm.lead upserted or deleted
    quants: set[tuple[int, int]] = field(default_factory=set)     # (company id, product id) of upserted / deleted quants
    product_costs: set[tuple[int, int]] = field(default_factory=set)  # (company id, product id) whose standard price changed


@dataclass
class DimChanges:
    customers: set[int] = field(default_factory=set)       # dim_customer.CustomerKey
    partners: set[int] = field(default_factory=set)        # map_partner_customer.partner_id (re-pointed partners)
    products: set[int] = field(default_factory=set)        # dim_product (Odoo product id)
    product_masters: set[int] = field(default_factory=set)  # dim_product_master.ProductMasterKey (PRODUCTS.xlsx)
    mapped_products: set[int] = field(default_factory=set)  # map_product_master.product id (re-mapped)
    odoo_users: set[int] = field(default_factory=set)       # map_odoo_user_salesperson.odoo_user_id
    odoo_teams: set[int] = field(default_factory=set)       # map_odoo_team_sales_team.odoo_team_id
    salespeople: set[int] = field(default_factory=set)      # dim_salesperson.SalespersonKey
    teams: set = field(default_factory=set)                 # dim_sales_team.SalesTeamKey
    channels: set[int] = field(default_factory=set)
    segments: set[int] = field(default_factory=set)
    companies: set[int] = field(default_factory=set)

    @property
    def empty(self) -> bool:
        return not any(getattr(self, f) for f in self.__dataclass_fields__)


@dataclass
class SalesIndex:
    """Current state, only the key columns. Mirrors = NEW values, facts = OLD values."""

    orders: pd.DataFrame        # raw mirror: order_id, partner_id, user_id, team_id, company_id, opportunity_id
    lines: pd.DataFrame         # raw mirror: line_id, order_id, product_id
    partner_customer: pd.DataFrame   # partner_id, CustomerKey
    product_master: pd.DataFrame     # product_id, ProductMasterKey
    user_salesperson: pd.DataFrame   # odoo_user_id, SalespersonKey
    team_map: pd.DataFrame           # odoo_team_id, SalesTeamKey
    fact_lines: pd.DataFrame    # live fact_sales_lines: OdooOrderID, CustomerKey, SalespersonKey, SalesTeamKey, ChannelKey, SegmentKey,
                                #   CompanyKey, OdooProductID, ProductMasterKey, ProductMatchKey, DateKey
    pickings: pd.DataFrame      # raw mirror: picking_id, sale_order_id
    moves: pd.DataFrame         # raw mirror: move_id, picking_id


@dataclass
class Affected:
    orders: set[int] = field(default_factory=set)
    customers: set[int] = field(default_factory=set)                     # CustomerKey
    product_days: set[tuple] = field(default_factory=set)                # (CompanyKey, ProductMatchKey, DateKey)
    salesperson_months: set[tuple[int, int]] = field(default_factory=set)  # (SalespersonKey, YYYYMM)
    companies: set[int] = field(default_factory=set)                     # CompanyKey: BCG / product dashboard
    pickings: set[int] = field(default_factory=set)
    leads: set[int] = field(default_factory=set)
    inventory_products: set[tuple[int, int]] = field(default_factory=set)  # (company id, product id)
    line_rows: int = 0                                                   # fact_sales_lines rows these orders carry (old + new)
    full_rebuild_reason: str | None = None

    def summary(self) -> dict:
        return {"orders": len(self.orders), "customers": len(self.customers), "product_days": len(self.product_days),
                "salesperson_months": len(self.salesperson_months), "companies": sorted(self.companies), "pickings": len(self.pickings),
                "leads": len(self.leads), "inventory_products": len(self.inventory_products), "line_rows": self.line_rows,
                "full_rebuild_reason": self.full_rebuild_reason}


def _where(df: pd.DataFrame, col: str, values: set) -> pd.DataFrame:
    return df[df[col].isin(values)] if values and len(df) else df.iloc[0:0]


def compute_affected(src: SourceChanges, dims: DimChanges, idx: SalesIndex, *, max_rows: int = DEFAULT_MAX_ROWS) -> Affected:
    out = Affected()
    o, li, f = idx.orders, idx.lines, idx.fact_lines

    # -- orders --------------------------------------------------------------------------------------------------------
    orders = set(src.orders) | set(src.deleted_orders) | set(src.deleted_lines.values())
    orders |= _ids(_where(li, "line_id", src.lines)["order_id"])
    # shared lists, NEW side (mirrors + current maps) ...
    partners = set(dims.partners) | _ids(_where(idx.partner_customer, "CustomerKey", dims.customers)["partner_id"])
    orders |= _ids(_where(o, "partner_id", partners)["order_id"])
    users = set(dims.odoo_users) | _ids(_where(idx.user_salesperson, "SalespersonKey", dims.salespeople)["odoo_user_id"])
    orders |= _ids(_where(o, "user_id", users)["order_id"])
    teams = set(dims.odoo_teams) | _ids(_where(idx.team_map, "SalesTeamKey", dims.teams)["odoo_team_id"])
    orders |= _ids(_where(o, "team_id", teams)["order_id"])
    orders |= _ids(_where(o, "company_id", dims.companies)["order_id"])
    products = set(dims.products) | set(dims.mapped_products) | _ids(_where(idx.product_master, "ProductMasterKey", dims.product_masters)["product_id"])
    orders |= _ids(_where(li, "product_id", products)["order_id"])
    # ... and OLD side (what the live rows carry now)
    for col, values in (("CustomerKey", dims.customers), ("SalespersonKey", dims.salespeople), ("SalesTeamKey", dims.teams),
                        ("ChannelKey", dims.channels), ("SegmentKey", dims.segments), ("CompanyKey", dims.companies),
                        ("ProductMasterKey", dims.product_masters), ("OdooProductID", products)):
        if col in f.columns:
            orders |= _ids(_where(f, col, values)["OdooOrderID"])
    out.orders = orders

    # -- what those orders' rows touch, old and new --------------------------------------------------------------------
    old_rows = _where(f, "OdooOrderID", orders)
    out.line_rows = len(old_rows) + int(_where(li, "order_id", orders)["line_id"].nunique() if len(li) else 0)
    new_customers = _ids(_where(idx.partner_customer, "partner_id", _ids(_where(o, "order_id", orders)["partner_id"]))["CustomerKey"])
    out.customers = _ids(old_rows["CustomerKey"]) | new_customers | set(dims.customers)
    out.companies = _ids(old_rows["CompanyKey"]) | _ids(_where(o, "order_id", orders)["company_id"])
    # product days / salesperson months: OLD rows here; the caller adds the NEW rows' keys after rebuilding the orders
    out.product_days = {tuple(r) for r in old_rows[["CompanyKey", "ProductMatchKey", "DateKey"]].itertuples(index=False, name=None)}
    out.salesperson_months = {(int(s), int(d) // 100) for s, d in old_rows[["SalespersonKey", "DateKey"]].itertuples(index=False, name=None)
                              if pd.notna(s) and pd.notna(d)}

    # -- deliveries, leads, inventory ----------------------------------------------------------------------------------
    pickings = set(src.pickings) | set(src.deleted_pickings) | _ids(_where(idx.moves, "move_id", src.moves)["picking_id"])
    pickings |= _ids(_where(idx.pickings, "sale_order_id", orders)["picking_id"])
    out.pickings = pickings
    out.leads = set(src.leads) | _ids(_where(o, "order_id", orders)["opportunity_id"]) if "opportunity_id" in o.columns else set(src.leads)
    sold = {(int(c), int(p)) for c, p in _where(o, "order_id", orders)[["order_id", "company_id"]].merge(
        _where(li, "order_id", orders)[["order_id", "product_id"]], on="order_id")[["company_id", "product_id"]].dropna().itertuples(index=False, name=None)}
    out.inventory_products = set(src.quants) | set(src.product_costs) | sold  # DOH = on hand / average daily sales

    if out.line_rows > max_rows:
        out.full_rebuild_reason = (f"{out.line_rows:,} sales line rows affected (> ETL_SALES_MAX_INCREMENTAL_ROWS {max_rows:,}); "
                                   f"shared-list changes: {', '.join(f'{k}={len(v)}' for k, v in vars(dims).items() if v) or 'none'}")
    return out
