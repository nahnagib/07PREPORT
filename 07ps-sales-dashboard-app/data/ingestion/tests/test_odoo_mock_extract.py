"""Tests for the mocked Odoo extraction path. No network calls anywhere in this file or in
anything it imports - MockOdooClient is pure in-memory data (see odoo/fixtures.py).

Run with: PYTHONPATH=.:vendor:vendor/sales_pipeline_src python3 -m pytest tests/ -q
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from odoo.extract import extract_all
from odoo.fixtures import MOCK_ODOO_DATA
from odoo.mock_client import MockOdooClient


def test_mock_client_is_default():
    assert os.environ.get("ALLOW_LIVE_ODOO") != "1", (
        "ALLOW_LIVE_ODOO must not be set to 1 in test runs - this test suite must never touch "
        "a real Odoo instance."
    )


def test_mock_client_search_count_and_read_roundtrip():
    client = MockOdooClient(models=MOCK_ODOO_DATA)
    client.authenticate()
    assert client.uid == 1
    count = client.search_count("crm.lead", [])
    assert count == len(MOCK_ODOO_DATA["crm.lead"]["records"])
    rows = client.search_read("crm.lead", [], ["id", "name"], limit=500)
    assert len(rows) == count
    assert set(rows[0].keys()) == {"id", "name"}


def test_mock_client_domain_filter():
    client = MockOdooClient(models=MOCK_ODOO_DATA)
    client.authenticate()
    opp_count = client.search_count("crm.lead", [["type", "=", "opportunity"]])
    lead_count = client.search_count("crm.lead", [["type", "=", "lead"]])
    total = client.search_count("crm.lead", [])
    assert opp_count + lead_count == total
    assert lead_count == 1  # exactly one pure lead (id 9101) in the fixture


def test_extract_all_returns_nonempty_frames_for_every_model():
    data = extract_all()
    assert data.source == "mock"
    assert len(data.sales_raw) == 10
    assert len(data.leads_raw) == 8
    assert len(data.sale_orders_raw) == 9
    assert len(data.stock_pickings_raw) == 3
    assert len(data.stock_moves_raw) == 3
    assert len(data.product_cost_raw) == 4
    assert len(data.stock_quants_raw) == 4
    assert len(data.stock_locations_raw) == 2
    assert len(data.inventory_companies_raw) == 2


def test_sale_report_many2one_fields_flattened_to_display_names():
    data = extract_all()
    # sales_report_repository.py flattens partner_id/product_id/etc to display-name strings
    # directly (its own _normalize_records, not flatten_many2one_columns) - confirm the mock
    # produces the same shape the real Odoo XML-RPC response would.
    assert data.sales_raw["Customer"].iloc[0] == "Al Waha Trading Co."
    assert data.sales_raw["Product"].iloc[0] == "TIKA Olive Oil 1L"
    assert "OdooProductID" in data.sales_raw.columns


if __name__ == "__main__":
    test_mock_client_is_default()
    test_mock_client_search_count_and_read_roundtrip()
    test_mock_client_domain_filter()
    test_extract_all_returns_nonempty_frames_for_every_model()
    test_sale_report_many2one_fields_flattened_to_display_names()
    print("All odoo mock extraction tests passed.")
