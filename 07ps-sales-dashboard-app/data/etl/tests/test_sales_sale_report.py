"""sale.report rebuilt from the base models: Odoo 17's grouping / conversion rules, the currency guard, the row key.
Verified against production in data/etl/scripts/sales/compare_sale_report_rebuild.py; these pin each rule."""

from __future__ import annotations

import pandas as pd
import pytest

from departments.sales import sale_report as sr
from sales_pipeline.odoo.sales_report_repository import OLD_EXPORT_COLUMN_MAP, EXTRA_ID_COLUMNS

UNITS, DOZEN, BOX6 = 1, 2, 3
UOM_ROWS = [{"id": UNITS, "factor": 1.0}, {"id": DOZEN, "factor": 1 / 12}, {"id": BOX6, "factor": 1 / 6}]


def _order(i, **kw):
    rec = {"id": i, "name": f"S{i:05d}", "date_order": "2026-10-19 22:30:00", "partner_id": [100, "ACME"], "user_id": [7, "Sara"],
           "team_id": [9, "Main Showroom"], "company_id": [1, "Majaal"], "state": "sale", "invoice_status": "to invoice",
           "currency_id": [102, "LYD"], "currency_rate": 1.0}
    rec.update(kw)
    return rec


def _line(i, order, product=(500, "[GR-1] Grout"), uom=UNITS, qty=1.0, price=10.0, **kw):
    rec = {"id": i, "order_id": [order, f"S{order:05d}"], "product_id": list(product) if product else False,
           "product_uom": [uom, "u"], "discount": 0.0, "display_type": False, "product_uom_qty": qty, "qty_delivered": qty,
           "qty_invoiced": 0.0, "price_subtotal": price, "price_total": price * 1.0}
    rec.update(kw)
    return rec


def _rebuild(orders, lines, products=None):
    o = sr.flatten_records(orders, sr.ORDER_FIELDS, sr.ORDER_M2O)
    li = sr.flatten_records(lines, sr.LINE_FIELDS, sr.LINE_M2O)
    p = sr.flatten_records(products or [{"id": 500, "uom_id": [UNITS, "Units"]}, {"id": 501, "uom_id": [UNITS, "Units"]}],
                           sr.PRODUCT_FIELDS, sr.PRODUCT_M2O)
    return sr.rebuild_sale_report(o, li, p, pd.DataFrame(UOM_ROWS), timezone="Africa/Tripoli", assume_utc_for_naive=True)


def test_columns_are_the_pipelines_sale_report_frame_plus_the_key():
    expected = [c for c in OLD_EXPORT_COLUMN_MAP.values() if c != "OdooOrderRef"] + EXTRA_ID_COLUMNS + ["OdooOrderID"]
    out = _rebuild([_order(1)], [_line(11, 1)])
    assert list(out.columns) == sr.REPORT_COLUMNS + sr.EXTRA_COLUMNS
    assert sorted(sr.REPORT_COLUMNS) == sorted(expected)


def test_lines_of_one_product_unit_and_discount_merge_whatever_their_invoice_status():
    out = _rebuild([_order(1)], [_line(12, 1, qty=6, price=492), _line(11, 1, qty=4, price=328, invoice_status="upselling"),
                                 _line(13, 1, qty=1, price=90, discount=10.0)])
    assert len(out) == 2
    merged = out[out["Discount"] == 0].iloc[0]
    assert (merged["SaleReportLineID"], merged["Qty Ordered"], merged["Untaxed Total"], merged["LineIDs"]) == (11, 10, 820, "11,12")
    assert out[out["Discount"] == 10]["SaleReportLineID"].tolist() == [13]


def test_quantities_are_converted_to_the_product_template_unit():
    out = _rebuild([_order(1)], [_line(11, 1, uom=DOZEN, qty=2), _line(12, 1, uom=BOX6, qty=1, product=(501, "Cem"))])
    assert out.set_index("SaleReportLineID")["Qty Ordered"].to_dict() == {11: pytest.approx(24.0), 12: pytest.approx(6.0)}
    assert set(out["UoM"]) == {"Units"} and set(out["UoMID"]) == {UNITS}


def test_amounts_are_divided_by_the_order_currency_rate():
    out = _rebuild([_order(1, currency_id=[2, "USD"], currency_rate=0.2)], [_line(11, 1, price=100.0)])
    assert out["Untaxed Total"].tolist() == [pytest.approx(500.0)]


def test_display_lines_are_left_out_and_a_line_without_product_counts_zero():
    out = _rebuild([_order(1)], [_line(11, 1), _line(12, 1, product=None, display_type="line_section", price=0),
                                 _line(13, 1, product=None, price=55.0, qty=3)])
    no_product = out[out["OdooProductID"].isna()].iloc[0]
    assert len(out) == 2
    assert (no_product["Product"], no_product["UoM"], no_product["Untaxed Total"], no_product["Qty Ordered"]) == ("", "", 0.0, 0.0)


def test_header_fields_come_from_the_order_and_empty_values_are_blank():
    out = _rebuild([_order(1, team_id=False, invoice_status="invoiced")], [_line(11, 1, invoice_status="to invoice")]).iloc[0]
    assert (out["Related Order"], out["Customer"], out["Salesperson"], out["Sales Team"], out["Company"], out["Invoice Status"]) == (
        "S00001", "ACME", "Sara", "", "Majaal", "invoiced")
    assert str(out["Order Date"]) == "2026-10-20 00:30:00"  # 22:30 UTC -> Tripoli (UTC+2), the next day
    assert (out["OdooOrderID"], out["OdooPartnerID"], out["OdooCompanyID"]) == (1, 100, 1)


def test_group_key_is_stable_when_the_lowest_line_goes():
    before = _rebuild([_order(1)], [_line(11, 1), _line(12, 1)]).iloc[0]
    after = _rebuild([_order(1)], [_line(12, 1)]).iloc[0]
    assert before["SaleReportLineID"] == 11 and after["SaleReportLineID"] == 12  # sale.report's id moves...
    assert before["SalesLineGroupKey"] == after["SalesLineGroupKey"]  # ...the key does not
    assert sr.group_key(1, 500, 1, 0) != sr.group_key(1, 500, 1, 10) != sr.group_key(1, None, None, 10)


def test_lines_of_an_order_that_was_not_passed_are_refused():
    with pytest.raises(ValueError, match="not passed in orders: \\[2\\]"):
        _rebuild([_order(1)], [_line(11, 1), _line(21, 2)])


# -- currency guard ----------------------------------------------------------------------------------------------------
def _companies(*rows):
    return sr.flatten_records([{"id": i, "name": n, "currency_id": [c, code]} for i, n, c, code in rows], ("id", "name", "currency_id"), ("currency_id",))


def test_guard_accepts_lyd_companies_with_rates():
    orders = sr.flatten_records([_order(1), _order(2, company_id=[3, "Tika"])], sr.ORDER_FIELDS, sr.ORDER_M2O)
    sr.check_currencies(_companies((1, "Majaal", 102, "LYD"), (3, "Tika", 102, "LYD"), (5, "Other", 2, "USD")), orders)  # 5 has no orders


def test_guard_refuses_a_non_lyd_company_and_a_missing_rate():
    orders = sr.flatten_records([_order(1, company_id=[5, "Other"]), _order(2, currency_rate=0), _order(3, currency_rate=False)],
                                sr.ORDER_FIELDS, sr.ORDER_M2O)
    with pytest.raises(sr.SalesCurrencyError) as err:
        sr.check_currencies(_companies((1, "Majaal", 102, "LYD"), (5, "Other", 2, "USD")), orders)
    msg = str(err.value)
    assert "company 5 Other has currency USD" in msg and "TODAY's rate" in msg
    assert "2 order(s) have no currency_rate" in msg and "S00002 (id 2)" in msg and "S00003 (id 3)" in msg
