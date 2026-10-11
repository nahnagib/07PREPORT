"""Unit tests of the pure core transforms (no database, no Odoo)."""

from __future__ import annotations

import datetime as dt

import pandas as pd
import pytest

from core.keys import UNKNOWN, lookup_keys
from core.transforms import calendar as cal
from core.transforms import customer as cust
from core.transforms import org
from core.transforms import product as prod
from core.transforms import reference as ref
from core_fixtures import CHANNEL, ODOO_USERS, SALESPERSON, SEGMENT, TEAMS


# -- org ---------------------------------------------------------------------------------------------------------
def test_effective_team_and_channel_follow_the_legacy_active_rule():
    people = org.build_salespeople(SALESPERSON)
    by_name = people.set_index("salesperson")
    assert by_name.loc["Moftah Test", ["SalesTeamKey", "ChannelKey"]].tolist() == ["TK-BEN-BC-03", 3]
    assert by_name.loc["Sara Seller", ["SalesTeamKey", "ChannelKey", "assigned_team_key"]].tolist() == ["-1", -1, "MJ-EST-BB"]
    assert by_name.loc["Placeholder One", "ChannelKey"] == -1  # active, but no channel on the sheet


def test_no_team_means_inactive_whatever_the_status_says():
    by_name = org.build_salespeople(SALESPERSON).set_index("salesperson")
    assert by_name.loc["Stale Active", ["status", "SalesTeamKey", "ChannelKey", "DistributionChannel"]].tolist() == ["Inactive", "-1", -1, "Unknown"]
    assert by_name.loc["New Odoo Seller", "status"] == "Inactive"
    assert by_name.loc["Sara Seller", "status"] is None  # has a team, blank Status: kept as is (not counted as active)
    assert org.effective_status("Active", "  ") == "Inactive"
    assert org.active_without_team(SALESPERSON)["SalespersonKey"].tolist() == [63]


def test_org_validation_reports_every_problem():
    bad_people = SALESPERSON.copy()
    bad_people.loc[0, "TeamKey"] = "NOPE"
    bad_people.loc[1, "ChannelKey"] = 99
    bad_users = pd.concat([ODOO_USERS, pd.DataFrame([{"odoo_user_id": 50, "SalespersonKey": 12345}])], ignore_index=True)
    with pytest.raises(org.OrgFileError) as exc:
        org.validate_org(bad_people, TEAMS, bad_users, CHANNEL, SEGMENT, {1, 3})
    text = "\n".join(exc.value.problems)
    assert "TeamKey 'NOPE' is not in sheet salesteam" in text
    assert "ChannelKey 99 is not in sheet channel" in text
    assert "points to unknown SalespersonKey 12345" in text


def test_reserved_minus_one_codes_are_rejected():
    ch = pd.concat([CHANNEL, pd.DataFrame([{"ChannelKey": -1, "DistributionChannel": "Other"}])], ignore_index=True)
    with pytest.raises(org.OrgFileError, match="ChannelKey -1 is reserved"):
        org.validate_org(SALESPERSON, TEAMS, ODOO_USERS, ch, SEGMENT, {1, 3})


# -- customers -----------------------------------------------------------------------------------------------------
PARTNERS = pd.DataFrame([
    {"id": 100, "name": "ACME", "display_name": "ACME", "commercial_partner_id": 100, "is_company": True, "customer_rank": 2, "user_id": 10, "ref": None, "active": True, "_deleted_at": None},
    {"id": 101, "name": "Omar", "display_name": "ACME, Omar", "commercial_partner_id": 100, "is_company": False, "customer_rank": 1, "user_id": None, "ref": None, "active": True, "_deleted_at": None},
    {"id": 102, "name": None, "display_name": "Only Display", "commercial_partner_id": None, "is_company": False, "customer_rank": 0, "user_id": 77, "ref": None, "active": False, "_deleted_at": "2026-09-01"},
])


def test_contacts_roll_up_to_their_commercial_partner():
    pmap = cust.build_partner_map(PARTNERS)
    assert dict(zip(pmap["partner_id"], pmap["CustomerKey"])) == {100: 100, 101: 100, 102: 102}
    assert pmap.set_index("partner_id").loc[101, "is_commercial"] == 0


def test_customers_are_commercial_partners_with_salesperson_of_record():
    customers, unmapped = cust.build_customers(PARTNERS, {10: 49})
    c = customers.set_index("CustomerKey")
    assert list(c.index) == [100, 102]
    assert c.loc[100, "SalespersonKey"] == 49 and c.loc[102, "SalespersonKey"] == UNKNOWN
    assert c.loc[102, "customer"] == "Only Display" and c.loc[102, "is_deleted"] == 1
    assert unmapped == [77]  # one entry per customer whose user is not mapped
    assert c.loc[100, "CustomerID"].startswith("CUST-")  # legacy name hash kept one release


def test_blocked_rows_apply_by_customer_key_and_latest_date_wins():
    customers, _ = cust.build_customers(PARTNERS, {})
    blocked = pd.DataFrame([
        {"_excel_row": 2, "CustomerKey": 100, "CustomerName": "ACME", "IsBlocked": True, "BlockedDate": dt.date(2026, 1, 1), "UnblockedDate": None, "BlockedReason": "old", "Notes": None},
        {"_excel_row": 3, "CustomerKey": 100, "CustomerName": "ACME", "IsBlocked": False, "BlockedDate": dt.date(2026, 5, 1), "UnblockedDate": dt.date(2026, 6, 1), "BlockedReason": "new", "Notes": None},
        {"_excel_row": 4, "CustomerKey": None, "CustomerName": "Nobody", "IsBlocked": True, "BlockedDate": None, "UnblockedDate": None, "BlockedReason": None, "Notes": None},
    ])
    out = cust.apply_blocked(customers, blocked).set_index("CustomerKey")
    assert (out.loc[100, "IsBlocked"], out.loc[100, "BlockedReason"]) == (0, "new")
    assert cust.blocked_without_customer(blocked, out.index)["_excel_row"].tolist() == [4]


def test_customer_company_rows_only_for_commercial_partners_and_known_terms():
    pmap = cust.build_partner_map(PARTNERS)
    raw = pd.DataFrame([
        {"partner_id": 100, "company_id": 1, "credit_limit": 5000.0, "property_payment_term_id": 8},
        {"partner_id": 101, "company_id": 1, "credit_limit": 1.0, "property_payment_term_id": 8},  # a contact: dropped
        {"partner_id": 100, "company_id": 3, "credit_limit": 0.0, "property_payment_term_id": 999},  # unknown term -> -1
    ])
    out = cust.build_customer_company(raw, pmap, [7, 8])
    assert out.values.tolist() == [[100, 1, 5000.0, 8], [100, 3, 0.0, -1]]


# -- reference -------------------------------------------------------------------------------------------------------
def test_company_display_names_and_scope():
    raw = pd.DataFrame([{"id": 1, "name": "Majaal", "currency_id": 102, "currency_name": "LYD"},
                        {"id": 3, "name": "TIKA", "currency_id": 102, "currency_name": "LYD"},
                        {"id": 4, "name": "ATHENA", "currency_id": 102, "currency_name": "LYD"}])
    out = ref.build_companies(raw, [1, 3, 4])
    assert out[["CompanyKey", "Company", "is_in_scope"]].values.tolist() == [[1, "Majaal", 1], [3, "Tika", 1], [4, "Athena", 1]]


def test_payment_term_instalment_flag_and_max_days():
    terms = pd.DataFrame([{"id": 7, "name": "30d", "company_id": None, "active": True}, {"id": 8, "name": "split", "company_id": 1, "active": True},
                          {"id": 9, "name": "immediate", "company_id": None, "active": True}])
    lines = pd.DataFrame([{"id": 1, "payment_id": 7, "nb_days": 30}, {"id": 2, "payment_id": 8, "nb_days": 30}, {"id": 3, "payment_id": 8, "nb_days": 90}])
    out = ref.build_payment_terms(terms, lines).set_index("PaymentTermKey")
    assert out.loc[8, ["max_days", "is_instalment", "line_count"]].tolist() == [90, 1, 2]
    assert out.loc[7, "is_instalment"] == 0 and out.loc[9, "line_count"] == 0


# -- products ----------------------------------------------------------------------------------------------------------
RAW_PRODUCTS = pd.DataFrame([
    {"id": 500, "product_tmpl_id": 500, "name": "Grout", "display_name": "[GR-1] Grout", "default_code": "GR-1", "company_id": None, "categ_name": "G", "uom_name": "u", "detailed_type": "product", "active": True},
    {"id": 501, "product_tmpl_id": 501, "name": "Cem Air", "display_name": "Cem Air", "default_code": None, "company_id": 3, "categ_name": "C", "uom_name": "u", "detailed_type": "product", "active": True},
    {"id": 502, "product_tmpl_id": 502, "name": "Mystery", "display_name": "Mystery", "default_code": None, "company_id": None, "categ_name": "X", "uom_name": "u", "detailed_type": "consu", "active": False},
])
MASTER_RAW = pd.DataFrame([
    {"ProductMasterKey": "M-GR", "SheetProductKey": "GR", "Company": "Majaal", "Category": "Adhesive", "Brand": "Weber", "SubBrand": None, "Family": "Grout",
     "ProductName": "Grout", "OdooProductName": "[GR-1]  grout", "ProductLevel": "SKU", "SKU": "GR-1", "Size": None, "IsActive": True, "OdooProductID": None, "_excel_row": 2},
    {"ProductMasterKey": None, "SheetProductKey": "CEM", "Company": "Tika", "Category": "Cement", "Brand": "CemAir", "SubBrand": None, "Family": None,
     "ProductName": None, "OdooProductName": "[OLD] Cem Air", "ProductLevel": "SKU", "SKU": None, "Size": None, "IsActive": True, "OdooProductID": None, "_excel_row": 3},
    {"ProductMasterKey": "M-MYS", "SheetProductKey": "MYS", "Company": "Tika", "Category": "Misc", "Brand": "B", "SubBrand": None, "Family": None,
     "ProductName": "Mystery", "OdooProductName": "Renamed In Odoo", "ProductLevel": "SKU", "SKU": None, "Size": None, "IsActive": True, "OdooProductID": 502, "_excel_row": 4},
])
COMPANIES = {1: "Majaal", 3: "Tika"}


def _map():
    master_raw = prod.complete_master_keys(MASTER_RAW)
    master = prod.build_product_master(master_raw, {"Majaal": 1, "Tika": 3}).merge(master_raw[["ProductMasterKey", "OdooProductID"]], on="ProductMasterKey")
    return prod.build_product_master_map(prod.build_products(RAW_PRODUCTS), master, COMPANIES), master


def test_generated_master_key_depends_only_on_its_own_row():
    a = prod.generated_master_key("CEM", "TIKA|CEM AIR")
    assert a == prod.generated_master_key("CEM", "TIKA|CEM AIR") and a.startswith("CEM|") and len(a) == 14
    assert prod.generated_master_key(None, "TIKA|X").startswith("PRODUCT|")
    keys_alone = prod.complete_master_keys(MASTER_RAW.iloc[[1]])["ProductMasterKey"].tolist()
    keys_with_others = prod.complete_master_keys(MASTER_RAW)["ProductMasterKey"].tolist()
    assert keys_alone[0] == keys_with_others[1]


def test_product_master_map_is_company_aware_and_an_odoo_id_wins():
    pm, master = _map()
    rows = pm.set_index(["ProductKey", "CompanyKey"])
    assert rows.loc[(500, 1)].tolist() == ["M-GR", prod.STATUS_NAME]  # code prefix, spacing and case ignored
    assert rows.loc[(500, 3)].tolist() == ["-1", prod.STATUS_NONE]  # never matched across companies
    assert rows.loc[(501, 3), "match_status"] == prod.STATUS_NAME  # "[OLD] Cem Air" -> "CEM AIR"
    assert (501, 1) not in rows.index  # restricted to Tika in Odoo
    assert rows.loc[(502, 3)].tolist() == ["M-MYS", prod.STATUS_ID]  # name differs, id in the sheet wins
    assert master.set_index("SheetProductKey").loc["CEM", "ProductName"] == "Cem Air"  # blank name -> Odoo name w/o code


def test_duplicate_company_and_name_in_the_catalogue_is_rejected():
    dup = pd.concat([MASTER_RAW, MASTER_RAW.iloc[[0]].assign(ProductMasterKey="M-GR-2", _excel_row=9)], ignore_index=True)
    with pytest.raises(prod.ProductMasterError, match="ProductMatchKey 'MAJAAL\\|GROUT' appears on several rows: 2, 9"):
        prod.build_product_master(prod.complete_master_keys(dup), {"Majaal": 1, "Tika": 3})


# rewritten from the legacy QA_UnmappedProducts side-workbook tests (see test_product_dimension.py)
def test_unmatched_products_are_listed_biggest_sales_first():
    pm, _ = _map()
    sales = pd.DataFrame([
        {"ProductKey": 500, "CompanyKey": 3, "sales_value": 10.0, "sales_value_last_12m": 10.0, "line_count": 1, "last_sale_date": "2026-01-01"},
        {"ProductKey": 502, "CompanyKey": 1, "sales_value": 900.0, "sales_value_last_12m": 0.0, "line_count": 4, "last_sale_date": "2025-01-01"},
        {"ProductKey": 500, "CompanyKey": 1, "sales_value": 5000.0, "sales_value_last_12m": 50.0, "line_count": 9, "last_sale_date": "2026-09-01"},  # matched
    ])
    report = prod.unmatched_report(prod.build_products(RAW_PRODUCTS), pm, sales, COMPANIES)
    assert report[["ProductKey", "company", "sales_value"]].values.tolist() == [[502, "Majaal", 900.0], [500, "Tika", 10.0]]


def test_unmatched_products_without_sales_are_listed_with_zero():
    pm, _ = _map()
    report = prod.unmatched_report(prod.build_products(RAW_PRODUCTS), pm, None, COMPANIES)
    assert set(map(tuple, report[["ProductKey", "company"]].values.tolist())) == {(500, "Tika"), (502, "Majaal")}
    assert report["sales_value"].eq(0).all()


def test_every_sold_product_and_company_pair_has_a_map_row():
    pm, _ = _map()
    covered = set(zip(pm["ProductKey"], pm["CompanyKey"]))
    for product, company in [(500, 1), (500, 3), (501, 3), (502, 1), (502, 3)]:
        assert (product, company) in covered  # unmatched pairs map to '-1', so facts never lose a product row


# -- calendar ---------------------------------------------------------------------------------------------------------
def test_dates_are_a_pure_function_of_the_day():
    a = cal.build_dates(dt.date(2026, 1, 1), dt.date(2026, 1, 10))
    b = cal.build_dates(dt.date(2025, 12, 1), dt.date(2026, 2, 1))
    pd.testing.assert_frame_equal(a.reset_index(drop=True), b[b["DateKey"].between(20260101, 20260110)].reset_index(drop=True))
    assert a.set_index("DateKey").loc[20260102, ["WeekdayName", "IsWeeklyRestDay"]].tolist() == ["Friday", 1]


def test_default_range_runs_to_end_of_next_year():
    assert cal.default_range(dt.date(2026, 10, 1), dt.date(2018, 1, 1)) == (dt.date(2018, 1, 1), dt.date(2027, 12, 31))


def test_offdays_filter_country_and_inactive_and_key_company_and_branch():
    raw = pd.DataFrame([
        {"Date": dt.date(2026, 1, 18), "OffDayType": "Unexpected", "HolidayName": None, "Reason": "x", "Country": "Libya", "Company": "TIKA", "CompanyKey": None, "Branch": "TK-1", "IsActive": True},
        {"Date": dt.date(2026, 1, 18), "OffDayType": "Unexpected", "HolidayName": None, "Reason": "dup", "Country": "Libya", "Company": "TIKA", "CompanyKey": None, "Branch": "TK-1", "IsActive": True},
        {"Date": dt.date(2026, 2, 1), "OffDayType": "Holiday", "HolidayName": "h", "Reason": None, "Country": "Libya", "Company": None, "CompanyKey": None, "Branch": None, "IsActive": False},
        {"Date": dt.date(2026, 3, 1), "OffDayType": "Holiday", "HolidayName": "h", "Reason": None, "Country": "Tunisia", "Company": None, "CompanyKey": None, "Branch": None, "IsActive": True},
    ])
    out = cal.build_offdays(raw, {"Majaal": 1, "Tika": 3})
    assert out[["DateKey", "OffDayType", "CompanyKey", "SalesTeamKey", "Reason"]].values.tolist() == [[20260118, "unexpected", 3, "TK-1", "x"]]


def test_lookup_keys_reports_the_ids_that_fell_back():
    keys, missing = lookup_keys(pd.Series([10, 11, None, 12]), {10: 49, 11: 49})
    assert keys.tolist() == [49, 49, -1, -1] and missing == [12]
