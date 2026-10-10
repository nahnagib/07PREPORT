"""departments.sales.conform: keys from document ids, team as transacted, parity with the legacy keys."""

from __future__ import annotations

import pandas as pd
import pytest

from core.keys import UNKNOWN, UNKNOWN_TEXT
from departments.sales import conform as cf
from test_core_resolve import MAPS


def test_org_keys_follow_the_document():
    legacy = pd.DataFrame({
        "SalespersonKey": [49, 49, 0], "SalesTeamKey": ["MJ-EST-BB", "TK-BEN-BC-03", "MJ-TIK-00"], "sales_team_key": ["x", "y", "z"],
        "ChannelKey": [3, 3, 1], "SegmentKey": [1, 2, 5], "CompanyKey": [1, 2, 2], "CustomerKey": [7, 8, 9],
    })
    out = cf.Conformed()
    df = cf.apply_org_keys(legacy, MAPS, out, "fact_x", partner_ids=[101, 100, None], user_ids=[10, 11, None],
                           team_ids=[9, 27, None], company_ids=[1, 3, 3])
    assert df["CustomerKey"].tolist() == [100, 100, UNKNOWN]  # contact 101 rolls up to its commercial partner
    assert df["SalespersonKey"].tolist() == [49, 49, UNKNOWN]  # one person, two Odoo users
    assert df["SalesTeamKey"].tolist() == ["MJ-EST-BB", "TK-BEN-BC-03", UNKNOWN_TEXT]  # Odoo team / EXPORT -> salesperson / none
    assert df["sales_team_key"].tolist() == df["SalesTeamKey"].tolist()  # legacy mirror column kept in step
    assert df["SegmentKey"].tolist() == [1, 2, UNKNOWN]  # follows the team
    assert df["ChannelKey"].tolist() == [3, 3, UNKNOWN]  # follows the salesperson
    assert df["CompanyKey"].tolist() == [1, 3, 3]
    # every key equals the legacy one after the agreed translations (0 -> -1, MJ-TIK-00 -> '-1', 1/5 -> -1, Tika 2 -> 3)
    assert out.parity["fact_x"] == {"SalespersonKey": 0, "SalesTeamKey": 0, "ChannelKey": 0, "SegmentKey": 0, "CompanyKey": 0}


def test_parity_counts_real_differences():
    legacy = {"SalesTeamKey": pd.Series(["MJ-EST-BB", "MJ-EST-BB"]), "CompanyKey": pd.Series([2, 1])}
    new = pd.DataFrame({"SalesTeamKey": ["MJ-EST-BB", "TK-EST-BB"], "CompanyKey": [3, 3]})
    assert cf.legacy_key_parity(legacy, new) == {"SalesTeamKey": 1, "CompanyKey": 1}


def test_fallbacks_are_collected_per_key():
    out = cf.Conformed()
    cf.apply_org_keys(pd.DataFrame({"SalesTeamKey": ["a"], "CompanyKey": [1]}), MAPS, out, "fact_y", partner_ids=[555],
                      user_ids=[77], team_ids=[2], company_ids=[1])
    assert out.fallbacks == {"fact_y.CustomerKey (partner id)": [555], "fact_y.SalespersonKey (Odoo user id)": [77],
                             "fact_y.SalesTeamKey (Odoo team id not in OdooTeams)": [2]}


def test_growth_rows_keep_only_conformed_customers():
    legacy_dim = pd.DataFrame({"CustomerID": ["100", "102", "CUST-ABC"], "company": ["Majaal", "Tika", "x"],
                               "First_Purchase_Date": ["2025-01-02", None, None], "LY_Value": [10.0, 0.0, 1.0]})
    rows = cf.growth_rows(legacy_dim)
    assert rows["CustomerKey"].tolist() == [100, 102]
    assert str(rows.loc[0, "First_Purchase_Date"]) == "2025-01-02" and rows.loc[0, "LY_Value"] == 10.0
    assert set(cf.GROWTH_COLUMNS) <= set(rows.columns)


def test_missing_spellings_count_as_empty():
    # the legacy targets sheet writes a missing team as the string '<NA>'; it must match an empty cell in the workbook
    assert [cf._ident_text(v) for v in (None, float("nan"), pd.NA, "<NA>", " nan ", "MJ-EST-BB ")] == ["", "", "", "", "", "MJ-EST-BB"]
    assert [cf._team_key(v) for v in ("<NA>", "MJ-TIK-00", None, "TK-EST-BB")] == [UNKNOWN_TEXT, UNKNOWN_TEXT, UNKNOWN_TEXT, "TK-EST-BB"]


def test_targets_line_up_with_the_sheet_by_position():
    sheet = pd.DataFrame({"Year": [2025, None, 2025], "Month": [1, 1, 2], "YearMonth": ["2025-01", "x", "2025-02"],
                          "Salesperson": ["A", "B", "C"], "Target_Revenue": [10.0, 1.0, 20.0], "Target_Volume": [None, None, 3.0],
                          "SalespersonKey": [5, 6, 7], "CompanyKey": [1, 1, -1]})
    rows = cf.target_sheet_rows(sheet)
    assert rows["SalespersonKey"].tolist() == [5, 7]  # the row without a Year is dropped, as the legacy loader does
    fact = pd.DataFrame({"YearMonth": ["2025-01", "2025-02"], "Target_Revenue": [10.0, 20.0], "Target_Volume": [None, 3.0]})
    cf.check_target_alignment(fact, rows)  # team/company filled by the legacy code do not matter
    with pytest.raises(ValueError, match="does not line up"):
        cf.check_target_alignment(fact.assign(Target_Revenue=[10.0, 21.0]), rows)
    with pytest.raises(ValueError, match="usable rows"):
        cf.check_target_alignment(fact.iloc[:1], rows)


def test_team_fallback_is_set_per_fact():
    legacy = pd.DataFrame({"SalespersonKey": [49], "SalesTeamKey": ["MJ-TIK-00"], "SegmentKey": [5], "CompanyKey": [1]})
    for fact, team in (("fact_sales_orders", "TK-BEN-BC-03"), ("fact_sales_documents", UNKNOWN_TEXT)):
        out = cf.Conformed()
        df = cf.apply_org_keys(legacy, MAPS, out, fact, partner_ids=[None], user_ids=[10], team_ids=[None], company_ids=[1])
        assert df["SalesTeamKey"].tolist() == [team], fact
    assert out.parity["fact_sales_documents"]["SalesTeamKey"] == 0  # documents: legacy Unknown, kept


def test_order_id_is_corrected_when_the_name_exists_in_the_rows_company():
    orders = {34292: {"name": "S24144", "company_id_id": 1}, 74793: {"name": "S24144", "company_id_id": 3},
              5: {"name": "S00005", "company_id_id": 1}}
    df = pd.DataFrame({"SalesDocumentID": [34292, 5, 34292], "order_number": ["S24144", "S00005", "S24144"], "CompanyKey": [2, 1, 1]})
    ids, fixed = cf.correct_order_ids(df, orders, "SalesDocumentID", "order_number")
    assert ids == [74793, 5, 34292] and fixed == 1  # legacy Tika (2) row carrying Majaal's id -> Tika's order


def test_bcg_duplicate_unknown_key_rows_are_collapsed_before_load():
    df = pd.DataFrame({
        "Company": ["Majaal", "Majaal", "Majaal"],
        "ProductMasterKey": [UNKNOWN_TEXT, UNKNOWN_TEXT, "M-GR"],
        "ProductName": ["Unknown A", "Unknown B", "Grout"],
        "ProductNameClean": ["UNKNOWN A", "UNKNOWN B", "GROUT"],
        "total_quantity_YTD": [10.0, 20.0, 5.0],
        "total_quantity_LYTD": [5.0, 5.0, 1.0],
        "total_value_YTD": [100.0, 300.0, 50.0],
        "total_value_LYTD": [50.0, 100.0, 10.0],
        "avg_unit_price_YTD": [10.0, 15.0, 10.0],
        "avg_unit_price_LYTD": [10.0, 20.0, 10.0],
        "avg_product_cost_YTD": [5.0, 6.0, 2.0],
        "avg_product_cost_LYTD": [4.0, 8.0, 2.0],
        "perc_gross_profit_YTD": [0.5, 0.6, 0.8],
        "perc_gross_profit_LYTD": [0.6, 0.6, 0.8],
        "volume_class_YTD": ["LV", "LV", "LV"],
        "volume_class_LYTD": ["LV", "LV", "LV"],
        "profit_class_YTD": ["HP", "HP", "HP"],
        "profit_class_LYTD": ["HP", "HP", "HP"],
        "bcg_code_YTD": ["LV/HP", "LV/HP", "LV/HP"],
        "bcg_code_LYTD": ["LV/HP", "LV/HP", "LV/HP"],
        "bcg_class_YTD": ["Strategic", "Strategic", "Strategic"],
        "bcg_class_LYTD": ["Strategic", "Strategic", "Strategic"],
        "quantity_growth_pct": [1.0, 3.0, 4.0],
        "gross_profit_change_pp": [-0.1, 0.0, 0.0],
        "bcg_movement": ["Stable", "Stable", "Stable"],
        "CompanyKey": [UNKNOWN, UNKNOWN, 1],
        "ProductKey": [UNKNOWN, UNKNOWN, UNKNOWN],
    })

    out = cf.collapse_duplicate_bcg_keys(df)

    assert not out.duplicated(["CompanyKey", "ProductMasterKey", "ProductKey"]).any()
    unknown = out.set_index(["CompanyKey", "ProductMasterKey", "ProductKey"]).loc[(UNKNOWN, UNKNOWN_TEXT, UNKNOWN)]
    assert unknown["total_quantity_YTD"] == 30.0
    assert unknown["total_value_YTD"] == 400.0
    assert unknown["avg_unit_price_YTD"] == pytest.approx(400.0 / 30.0)
    assert unknown["avg_product_cost_YTD"] == pytest.approx((10.0 * 5.0 + 20.0 * 6.0) / 30.0)
    assert unknown["quantity_growth_pct"] == 2.0
    assert out.loc[out["ProductMasterKey"].eq("M-GR"), "ProductName"].tolist() == ["Grout"]
