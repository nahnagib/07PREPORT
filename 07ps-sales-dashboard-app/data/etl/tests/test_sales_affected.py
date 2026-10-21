"""Affected-key logic of the incremental sales load: old AND new values, shared-list changes, the full-rebuild limit."""

from __future__ import annotations

import pandas as pd

from departments.sales.affected import DimChanges, SalesIndex, SourceChanges, compute_affected


def _index(**over):
    base = dict(
        orders=pd.DataFrame({"order_id": [1, 2, 3, 4], "partner_id": [101, 200, 300, 300], "user_id": [7, 8, 7, 9],
                             "team_id": [90, 91, 90, 92], "company_id": [1, 1, 3, 3], "opportunity_id": [None, 55, None, None]}),
        lines=pd.DataFrame({"line_id": [11, 12, 21, 31, 41], "order_id": [1, 1, 2, 3, 4], "product_id": [500, 501, 500, 600, 601]}),
        partner_customer=pd.DataFrame({"partner_id": [100, 101, 200, 300], "CustomerKey": [100, 100, 200, 300]}),
        product_master=pd.DataFrame({"product_id": [500, 501, 600, 601], "ProductMasterKey": [5, 5, 6, 7]}),
        user_salesperson=pd.DataFrame({"odoo_user_id": [7, 8, 9], "SalespersonKey": [70, 80, 90]}),
        team_map=pd.DataFrame({"odoo_team_id": [90, 91, 92], "SalesTeamKey": ["T-A", "T-B", "T-C"]}),
        fact_lines=pd.DataFrame({"OdooOrderID": [1, 1, 2, 3, 4], "CustomerKey": [100, 100, 200, 300, 300],
                                 "SalespersonKey": [70, 70, 80, 70, 90], "SalesTeamKey": ["T-A", "T-A", "T-B", "T-A", "T-C"],
                                 "ChannelKey": [1, 1, 2, 1, 2], "SegmentKey": [1, 1, 1, 2, 2], "CompanyKey": [1, 1, 1, 3, 3],
                                 "OdooProductID": [500, 501, 500, 600, 601], "ProductMasterKey": [5, 5, 5, 6, 7],
                                 "ProductMatchKey": ["M5", "M5", "M5", "M6", "M7"], "DateKey": [20261001, 20261001, 20261002, 20260915, 20261003]}),
        pickings=pd.DataFrame({"picking_id": [801, 802, 803], "sale_order_id": [1, 2, 4]}),
        moves=pd.DataFrame({"move_id": [9001, 9002], "picking_id": [802, 803]}),
    )
    base.update(over)
    return SalesIndex(**base)


def test_nothing_changed_nothing_affected():
    a = compute_affected(SourceChanges(), DimChanges(), _index())
    assert (a.orders, a.customers, a.product_days, a.pickings, a.leads, a.inventory_products, a.line_rows) == (set(), set(), set(), set(), set(), set(), 0)
    assert a.full_rebuild_reason is None


def test_a_changed_line_affects_its_order_customer_days_and_stock():
    a = compute_affected(SourceChanges(lines={21}), DimChanges(), _index())
    assert a.orders == {2}
    assert a.customers == {200}
    assert a.product_days == {(1, "M5", 20261002)}
    assert a.salesperson_months == {(80, 202610)}
    assert a.pickings == {802}
    assert a.leads == {55}  # the order's opportunity: its quotation journey is recomputed
    assert a.inventory_products == {(1, 500)}  # DOH mixes the calendar with sales: same cycle


def test_a_deleted_line_still_affects_its_order():
    assert compute_affected(SourceChanges(deleted_lines={12: 1}), DimChanges(), _index()).orders == {1}


def test_a_customer_moved_to_another_order_refreshes_both_customers():
    # order 2 now belongs to partner 300 (mirror, NEW) but its fact rows still say customer 200 (OLD)
    idx = _index()
    idx.orders.loc[idx.orders["order_id"] == 2, "partner_id"] = 300
    a = compute_affected(SourceChanges(orders={2}), DimChanges(), idx)
    assert a.customers == {200, 300}


def test_a_renamed_customer_affects_every_order_of_every_partner_of_it():
    a = compute_affected(SourceChanges(), DimChanges(customers={100}), _index())
    assert a.orders == {1}  # partner 101 is a contact of customer 100
    assert a.customers == {100}


def test_a_salesperson_change_affects_orders_by_old_key_and_by_odoo_user():
    a = compute_affected(SourceChanges(), DimChanges(salespeople={70}), _index())
    assert a.orders == {1, 3}
    a = compute_affected(SourceChanges(), DimChanges(odoo_users={9}), _index())  # user 9 re-mapped in SalesTeam.xlsx
    assert a.orders == {4}


def test_a_team_change_affects_old_team_rows_and_mapped_odoo_team_orders():
    idx = _index()
    idx.fact_lines.loc[idx.fact_lines["OdooOrderID"] == 4, "SalesTeamKey"] = "T-B"  # row still carries the old team
    a = compute_affected(SourceChanges(), DimChanges(teams={"T-B"}), idx)
    assert a.orders == {2, 4}


def test_a_product_master_change_affects_lines_of_all_its_products():
    a = compute_affected(SourceChanges(), DimChanges(product_masters={5}), _index())
    assert a.orders == {1, 2}
    assert a.product_days == {(1, "M5", 20261001), (1, "M5", 20261002)}
    assert a.companies == {1}


def test_quants_and_costs_affect_inventory_without_touching_orders():
    a = compute_affected(SourceChanges(quants={(3, 600)}, product_costs={(1, 501)}), DimChanges(), _index())
    assert a.orders == set() and a.inventory_products == {(3, 600), (1, 501)}


def test_a_changed_move_affects_its_picking():
    assert compute_affected(SourceChanges(moves={9002}), DimChanges(), _index()).pickings == {803}


def test_too_many_rows_asks_for_a_full_rebuild_and_says_why():
    a = compute_affected(SourceChanges(), DimChanges(segments={1}), _index(), max_rows=3)
    assert a.orders == {1, 2}
    assert a.full_rebuild_reason.startswith("6 sales line rows affected (> ETL_SALES_MAX_INCREMENTAL_ROWS 3)")
    assert "segments=1" in a.full_rebuild_reason
