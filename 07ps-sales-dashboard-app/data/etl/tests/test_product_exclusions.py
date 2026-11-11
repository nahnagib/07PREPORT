"""ProductExclusions.xlsx: the loader and how ProductDashboardBuilder applies its rules (priority, sub-categories, company)."""

from pathlib import Path

import pandas as pd
import pytest

from sales_pipeline.product_dashboard import ProductDashboardBuilder, ProductDashboardConfig
from sales_pipeline.product_exclusions import LAST_VALID_NAME, ExclusionsFileInvalid, ProductExclusions, ProductExclusionsLoader
from test_product_pages import CONFIG, _dim, _inv, _line

HEADERS = {
    "Customers": ["Company", "Odoo Partner ID", "Customer Name (reference)", "Action", "Active", "Reason"],
    "Categories": ["Company", "Odoo Category ID", "Category Name (reference)", "Action", "Active", "Reason"],
    "Products": ["Company", "Odoo Product ID", "Product Name (reference)", "Internal Reference (reference)", "Action", "Active", "Reason"],
}


def _write(path: Path, customers=(), categories=(), products=()) -> Path:
    with pd.ExcelWriter(path) as xl:
        pd.DataFrame([["Read me"]], columns=["Product pages – exclusions list"]).to_excel(xl, sheet_name="Instructions", index=False)
        for name, rows in (("Customers", customers), ("Categories", categories), ("Products", products)):
            pd.DataFrame(list(rows), columns=HEADERS[name]).to_excel(xl, sheet_name=name, index=False)
        pd.DataFrame({"Company": ["All", "Majaal", "Tika"]}).to_excel(xl, sheet_name="Lists", index=False)
    return path


def _rules(customers=(), categories=(), products=()) -> ProductExclusions:
    def frame(rows):
        return pd.DataFrame(list(rows), columns=["Company", "OdooID", "Action"]).astype({"OdooID": "int64"})
    return ProductExclusions(customers=frame(customers), categories=frame(categories), products=frame(products), source="test")


def _build(lines, dim, exclusions):
    sales = pd.DataFrame(lines)
    cost = pd.Series([1.0] * len(sales), index=sales.index)
    inv = pd.DataFrame(columns=["ProductCompanyKey", "ProductKey", "Company", "OdooProductName", "OnHandQty", "InventoryValue",
                                "StockClass", "LocationName", "ProductName"])
    return ProductDashboardBuilder(ProductDashboardConfig.load(CONFIG), "2026-09-29", exclusions).build(sales, dim, inv, line_costs=cost)


def _cust(line: dict, partner: int, **extra) -> dict:
    return {**line, "OdooPartnerID": partner, "CustomerKey": partner, **extra}


def _recs(rules: pd.DataFrame) -> list[dict]:
    """The rules without their sheet row number."""
    return rules[["Company", "OdooID", "Action"]].to_dict("records")


# ---------------------------------------------------------------- loader
def test_loader_reads_active_rows_by_id_with_stripped_headers(tmp_path) -> None:
    path = _write(
        tmp_path / "ProductExclusions.xlsx",
        customers=[["Tika", 9709, "name", "Keep", "Yes", ""], ["all", "18449", "x", "exclude", "yes", ""]],
        categories=[[" All", 39.0, "Packaging", "Exclude", "Yes", ""]],
    )
    # header with stray spaces, as typed by hand
    with pd.ExcelWriter(path, mode="a", engine="openpyxl", if_sheet_exists="replace") as xl:
        pd.DataFrame([["Tika", 4157, "Milocell", "", "Exclude", "Yes", ""]],
                     columns=[" Company ", "Odoo Product ID ", "Product Name (reference)", "Internal Reference (reference)", "Action", " Active", "Reason"]
                     ).to_excel(xl, sheet_name="Products", index=False)
    ex = ProductExclusionsLoader().load(path)
    assert ex.issues == []
    assert _recs(ex.customers) == [{"Company": "Tika", "OdooID": 9709, "Action": "Keep"}, {"Company": "All", "OdooID": 18449, "Action": "Exclude"}]
    assert _recs(ex.categories) == [{"Company": "All", "OdooID": 39, "Action": "Exclude"}]
    assert _recs(ex.products) == [{"Company": "Tika", "OdooID": 4157, "Action": "Exclude"}]


def test_missing_or_empty_file_means_no_extra_exclusions(tmp_path) -> None:
    missing = ProductExclusionsLoader().load(tmp_path / "ProductExclusions.xlsx")
    assert missing.source is None and missing.customers.empty and missing.categories.empty and missing.products.empty
    empty = ProductExclusionsLoader().load(_write(tmp_path / "ProductExclusions.xlsx"))
    assert empty.source and empty.issues == [] and empty.customers.empty and empty.categories.empty and empty.products.empty


def test_active_no_rows_are_ignored_and_counted_even_without_an_id(tmp_path) -> None:
    ex = ProductExclusionsLoader().load(_write(
        tmp_path / "ProductExclusions.xlsx",
        customers=[["Tika", None, "E.GRECH CRISTAL BATH LTD", "Keep", "No", ""]],
        categories=[["All", 59, "Scrap", "Exclude", "No", ""], ["Tika", 1, "root", "Exclude", "No", ""]],
    ))
    assert ex.issues == [] and ex.customers.empty and ex.categories.empty
    assert ex.ignored == {"Customers": 1, "Categories": 2, "Products": 0}


def test_bad_rows_are_skipped_with_sheet_and_row_and_the_rest_applies(tmp_path) -> None:
    ex = ProductExclusionsLoader().load(_write(
        tmp_path / "ProductExclusions.xlsx",
        customers=[["Tika", "abc", "x", "Keep", "Yes", ""], ["Tika", 12.5, "x", "Keep", "Yes", ""], ["Benghazi", 5, "x", "Keep", "Yes", ""]],
        categories=[["All", 39, "Packaging", "Keep", "Yes", ""], ["All", 3, "Expenses", "Exclude", "maybe", ""]],
        products=[["Majaal", -4, "x", "", "Exclude", "Yes", ""], ["Tika", 4157, "Milocell", "", "Exclude", "Yes", ""]],
    ))
    assert ex.customers.empty and ex.categories.empty
    assert _recs(ex.products) == [{"Company": "Tika", "OdooID": 4157, "Action": "Exclude"}]  # the good row still applies
    text = "\n".join(ex.issues)
    assert len(ex.issues) == 6 and len(ex.skipped) == 6
    assert ex.skipped[0] == {"sheet": "Customers", "row": 2, "name": "x", "reason": "Odoo Partner ID must be a whole positive number (got abc)"}
    assert "Customers row 2: Odoo Partner ID must be a whole positive number (got abc)" in text
    assert "Customers row 3" in text and "Customers row 4: Company must be All, Majaal or Tika (got Benghazi)" in text
    assert "Categories row 2: Action must be Exclude (got Keep)" in text and "Categories row 3: Active must be Yes or No (got maybe)" in text
    assert "Products row 2" in text and all(i.endswith("-- row skipped") for i in ex.issues)


def test_a_customer_keep_row_without_partner_id_is_skipped_with_a_warning(tmp_path) -> None:
    ex = ProductExclusionsLoader().load(_write(
        tmp_path / "ProductExclusions.xlsx",
        customers=[["Tika", None, "E.GRECH CRISTAL BATH LTD", "Keep", "Yes", ""], ["Tika", 9709, "x", "Keep", "Yes", ""]],
    ))
    assert ex.customers["OdooID"].tolist() == [9709]
    assert ex.skipped == [{"sheet": "Customers", "row": 2, "name": "E.GRECH CRISTAL BATH LTD",
                           "reason": "Odoo Partner ID must be a whole positive number (got blank)"}]
    assert ex.summary()["skipped_rows"] == 1 and ex.summary()["active_rows"]["Customers"] == {"Keep": 1}


def _broken(path):
    with pd.ExcelWriter(path) as xl:
        pd.DataFrame(columns=["Company", "Odoo Partner ID", "Action"]).to_excel(xl, sheet_name="Customers", index=False)
        pd.DataFrame(columns=HEADERS["Categories"]).to_excel(xl, sheet_name="Categories", index=False)
    return path


def test_missing_sheet_or_column_makes_the_file_invalid(tmp_path) -> None:
    with pytest.raises(ExclusionsFileInvalid) as err:
        ProductExclusionsLoader().load(_broken(tmp_path / "ProductExclusions.xlsx"))
    assert err.value.problems == ["sheet 'Customers' is missing column(s) Active", "sheet 'Products' is missing"]


def test_only_the_three_rule_sheets_are_read(tmp_path) -> None:
    path = _write(tmp_path / "ProductExclusions.xlsx", products=[["Tika", 4157, "Milocell", "", "Exclude", "Yes", ""]])
    with pd.ExcelWriter(path, mode="a", engine="openpyxl") as xl:  # an info sheet with ids and Exclude words is never read
        pd.DataFrame([["Majaal", 6023, "Greek Thassos", "Exclude", "Yes"]], columns=["Company", "Odoo Product ID", "Product Name", "Action", "Active"]
                     ).to_excel(xl, sheet_name="Price Fix (Odoo)", index=False)
        pd.DataFrame([["Products", "Exclude", 99]], columns=["Sheet", "Rule", "Active = Yes"]).to_excel(xl, sheet_name="Summary", index=False)
    ex = ProductExclusionsLoader().load(path)
    assert ex.products["OdooID"].tolist() == [4157] and ex.skipped == []


def test_an_invalid_file_falls_back_to_the_last_valid_one(tmp_path) -> None:
    backups = tmp_path / "backups"
    path = _write(tmp_path / "ProductExclusions.xlsx", categories=[["All", 39, "Packaging", "Exclude", "Yes", ""]])
    good = ProductExclusionsLoader().load_with_fallback(path, backups)
    assert good.fallback_reason is None and (backups / LAST_VALID_NAME).is_file()
    _broken(path)                                                       # the file is replaced by a broken one
    used = ProductExclusionsLoader().load_with_fallback(path, backups)
    assert used.categories["OdooID"].tolist() == [39]                   # the last valid rules stay in force
    assert "is invalid" in used.fallback_reason and "last valid file is used" in used.fallback_reason
    none = ProductExclusionsLoader().load_with_fallback(path, tmp_path / "no-backups")
    assert none.source is None and none.categories.empty and "no last valid copy" in none.fallback_reason


# ---------------------------------------------------------------- applying the rules
def test_customers_keep_overrides_the_backoffice_inter_company_rule_and_exclude_drops_a_real_customer() -> None:
    dim = _dim({"id": 1, "name": "A", "company": "Tika"})
    export_buyer = _cust({**_line("Tika", 1, "2026-09-01", 10, 100), "SegmentKey": 4}, 9709)
    transfer = _cust({**_line("Tika", 1, "2026-09-02", 50, 500), "SegmentKey": 4}, 9641, IsIntercompany=True)
    showroom = _cust(_line("Tika", 1, "2026-09-03", 3, 30), 555)      # B2B, but a transfer account
    real = _cust(_line("Tika", 1, "2026-09-04", 1, 10), 777)
    ex = _rules(customers=[["Tika", 9709, "Keep"], ["All", 555, "Exclude"]])
    daily = _build([export_buyer, transfer, showroom, real], dim, ex)["Fact_ProductSalesDaily"]
    assert daily["Value"].sum() == 110 and daily["Lines"].sum() == 2


def test_customer_rules_are_company_scoped_and_match_the_commercial_partner_too() -> None:
    dim = _dim({"id": 1, "name": "A", "company": "Majaal"}, {"id": 2, "name": "B", "company": "Tika"})
    majaal = {**_line("Majaal", 1, "2026-09-01", 1, 10), "SegmentKey": 3, "OdooPartnerID": 42, "CustomerKey": 9709}  # contact of 9709
    tika = {**_line("Tika", 2, "2026-09-01", 1, 20), "SegmentKey": 4, "OdooPartnerID": 9709, "CustomerKey": 9709}
    daily = _build([majaal, tika], dim, _rules(customers=[["Tika", 9709, "Keep"]]))["Fact_ProductSalesDaily"]
    assert daily["Company"].tolist() == ["Tika"]                       # the Tika Keep row does not keep Majaal's Backoffice line
    daily = _build([majaal, tika], dim, _rules(customers=[["All", 9709, "Keep"]]))["Fact_ProductSalesDaily"]
    assert sorted(daily["Company"]) == ["Majaal", "Tika"]               # matched through CustomerKey (commercial partner)


def test_category_exclusion_includes_sub_categories_and_products_keep_wins() -> None:
    dim = _dim(
        {"id": 1, "name": "Carton", "company": "Tika", "categ_id": 39, "categ": "All / Packaging"},
        {"id": 2, "name": "Film", "company": "Tika", "categ_id": 90, "categ": "All / Packaging / Films"},
        {"id": 3, "name": "Bucket kept", "company": "Tika", "categ_id": 90, "categ": "All / Packaging / Films"},
        {"id": 4, "name": "Similar name", "company": "Tika", "categ_id": 91, "categ": "All / Packaging2"},
        {"id": 5, "name": "Adhesive", "company": "Tika", "categ_id": 64, "categ": "All / Xtreme Tile Adhesive"},
    )
    lines = [_line("Tika", i, "2026-09-01", 1, 10) for i in (1, 2, 3, 4, 5)]
    ex = _rules(categories=[["All", 39, "Exclude"]], products=[["Tika", 3, "Keep"], ["All", 5, "Exclude"]])
    out = _build(lines, dim, ex)
    assert set(out["Dim_ProductDashboard"]["ProductKey"]) == {"3", "4"}
    assert out["Fact_ProductSalesDaily"]["Value"].sum() == 20


def test_category_and_product_rules_are_company_scoped() -> None:
    dim = _dim(
        {"id": 1, "name": "Marble", "company": "Majaal", "categ_id": 1, "categ": "All"},
        {"id": 2, "name": "Silica sand", "company": "Tika", "categ_id": 1, "categ": "All"},
        {"id": 3, "name": "Never sold raw material", "company": "Tika", "categ_id": 1, "categ": "All"},
        {"id": 4, "name": "Tile", "company": "Majaal", "categ_id": 52, "categ": "All / Tier 2"},
    )
    lines = [_line("Majaal", 1, "2026-09-01", 1, 10), _line("Tika", 2, "2026-09-01", 1, 20), _line("Majaal", 4, "2026-09-01", 1, 5)]
    out = _build(lines, dim, _rules(categories=[["Tika", 1, "Exclude"]]))
    keys = set(out["Dim_ProductDashboard"]["ProductCompanyKey"])
    assert keys == {"Majaal|1", "Majaal|4"}                             # the Tika root row leaves Majaal's root products alone
    assert out["Fact_ProductSalesDaily"]["Value"].sum() == 15
    out = _build(lines, dim, _rules(products=[["Majaal", 2, "Exclude"]]))
    assert "Tika|2" in set(out["Dim_ProductDashboard"]["ProductCompanyKey"])  # a Majaal product row never touches Tika


def test_excluded_product_stock_is_left_out_too() -> None:
    dim = _dim({"id": 1, "name": "Carton", "company": "Tika", "categ_id": 39, "categ": "All / Packaging"})
    sales = pd.DataFrame([_line("Tika", 1, "2026-09-01", 1, 10)])
    inv = pd.DataFrame([{"ProductCompanyKey": "Tika|1", "ProductKey": "1", "Company": "Tika", "OdooProductName": "P1", "ProductName": "P1",
                         "LocationName": "WH", "OnHandQty": 500, "InventoryValue": 50, "StockClass": "FinishedGoods"}])
    out = ProductDashboardBuilder(ProductDashboardConfig.load(CONFIG), "2026-09-29", _rules(categories=[["Tika", 39, "Exclude"]])).build(
        sales, dim, inv, line_costs=pd.Series([1.0]))
    assert out["Dim_ProductDashboard"].empty and out["Fact_ProductSalesDaily"].empty


# ---------------------------------------------------------------- automatic exclusions (2026-11-11)
CATEGORIES = pd.DataFrame([
    {"id": 1, "name": "All", "complete_name": "All", "parent_path": "1/"},
    {"id": 39, "name": "Packaging", "complete_name": "All / Packaging", "parent_path": "1/39/"},
    {"id": 90, "name": "Films", "complete_name": "All / Packaging / Films", "parent_path": "1/39/90/"},
    {"id": 70, "name": "Raw Materials", "complete_name": "All / Raw Materials", "parent_path": "1/70/"},
    {"id": 71, "name": "Sand", "complete_name": "All / Raw Materials / Sand", "parent_path": "1/70/71/"},
    {"id": 64, "name": "Adhesive", "complete_name": "All / Adhesive", "parent_path": "1/64/"},
])


def _builder(ex=None):
    return ProductDashboardBuilder(ProductDashboardConfig.load(CONFIG), "2026-09-29", ex or _rules())


def test_archived_products_are_excluded_everywhere_with_their_stock_and_listed_when_odoo_still_holds_stock() -> None:
    # 3 archived products (variant archived, template archived via IsActive False, archived never sold) + 1 active
    dim = _dim(
        {"id": 1, "name": "Pietra Grey MT 120x120", "company": "Majaal", "active": False},
        {"id": 2, "name": "Balkan White Slab 2cm", "company": "Majaal", "active": False},
        {"id": 3, "name": "Xtreme Mono Coat", "company": "Tika", "active": False},
        {"id": 4, "name": "Live tile", "company": "Majaal"},
    )
    lines = [_line("Majaal", 1, "2026-09-01", 5, 50), _line("Majaal", 4, "2026-09-01", 1, 10), _line("Tika", 3, "2026-09-02", 2, 20)]
    inv = pd.DataFrame([_inv("Majaal", 1, 259.2, 18940.74), _inv("Majaal", 2, 9.97, 3478.3), _inv("Tika", 3, -227, -1887.07),
                        _inv("Majaal", 4, 10, 100)])
    b = _builder()
    out = b.build(pd.DataFrame(lines), dim, inv, line_costs=pd.Series([1.0] * 3))
    assert set(out["Dim_ProductDashboard"]["ProductCompanyKey"]) == {"Majaal|4"}   # BCG / Detail / PIM / Stock visuals read this
    assert out["Fact_ProductSalesDaily"]["Value"].sum() == 10
    report = b.exclusion_report()
    assert report["products_excluded"]["archived"] == {"total": 3, "by_company": {"Majaal": 2, "Tika": 1}}
    assert [(r["product_id"], r["quantity_on_hand"]) for r in report["archived_with_stock"]] == [("1", 259.2), ("2", 9.97)]  # On Hand > 0 only


def test_template_archived_counts_as_archived() -> None:
    from sales_pipeline import odoo_products
    from sales_pipeline.odoo.product_cost_repository import with_template_active
    from test_product_pages import _raw

    raw = with_template_active(_raw({"id": 1, "name": "A", "company": "Majaal", "tmpl": 10}, {"id": 2, "name": "B", "company": "Majaal", "tmpl": 11}),
                               {10: False, 11: True})
    catalog = odoo_products.catalog(raw)
    assert catalog.set_index("OdooProductID")["IsActive"].to_dict() == {1: False, 2: True}


def test_sub_categories_follow_parent_path_even_when_the_parent_has_no_product_and_keep_wins() -> None:
    dim = _dim(
        {"id": 2, "name": "Film", "company": "Tika", "categ_id": 90, "categ": "All / Packaging / Films"},
        {"id": 3, "name": "Film kept", "company": "Tika", "categ_id": 90, "categ": "All / Packaging / Films"},
        {"id": 5, "name": "Adhesive", "company": "Tika", "categ_id": 64, "categ": "All / Adhesive"},
    )
    lines = [_line("Tika", i, "2026-09-01", 1, 10) for i in (2, 3, 5)]
    b = _builder(_rules(categories=[["All", 39, "Exclude"]], products=[["Tika", 3, "Keep"]]))
    out = b.build(pd.DataFrame(lines), dim, None, line_costs=pd.Series([1.0] * 3), categories=CATEGORIES)
    assert set(out["Dim_ProductDashboard"]["ProductKey"]) == {"3", "5"}
    assert b.exclusion_report()["products_excluded"] == {"file_category": {"total": 1, "by_company": {"Tika": 1}}}


def test_a_dedicated_raw_materials_category_is_excluded_automatically_with_its_sub_categories() -> None:
    dim = _dim(
        {"id": 1, "name": "Silica sand", "company": "Tika", "categ_id": 71, "categ": "All / Raw Materials / Sand"},
        {"id": 2, "name": "Milocell", "company": "Tika", "categ_id": 70, "categ": "All / Raw Materials"},
        {"id": 3, "name": "Kept on purpose", "company": "Tika", "categ_id": 70, "categ": "All / Raw Materials"},
        {"id": 5, "name": "Adhesive", "company": "Tika", "categ_id": 64, "categ": "All / Adhesive"},
    )
    lines = [_line("Tika", i, "2026-09-01", 1, 10) for i in (1, 2, 3, 5)]
    b = _builder(_rules(products=[["Tika", 3, "Keep"]]))
    out = b.build(pd.DataFrame(lines), dim, None, line_costs=pd.Series([1.0] * 4), categories=CATEGORIES)
    assert set(out["Dim_ProductDashboard"]["ProductKey"]) == {"3", "5"}
    assert b.exclusion_report()["products_excluded"]["raw_material"]["total"] == 2


def test_sales_lines_are_counted_per_customer_rule() -> None:
    dim = _dim({"id": 1, "name": "A", "company": "Tika"})
    lines = [
        _cust({**_line("Tika", 1, "2026-09-01", 1, 10), "SegmentKey": 3}, 100),                      # Backoffice
        _cust({**_line("Tika", 1, "2026-09-01", 2, 20), "SegmentKey": 4}, 101),                      # Inter Company
        _cust({**_line("Tika", 1, "2026-09-01", 3, 30), "SegmentKey": 4}, 9709),                     # Inter Company, kept
        _cust(_line("Tika", 1, "2026-09-01", 4, 40), 102, IsIntercompany=True),                     # flagged partner
        _cust(_line("Tika", 1, "2026-09-01", 5, 50), 555),                                          # Customers Exclude
        _cust(_line("Tika", 1, "2026-09-01", 6, 60), 777),                                          # real sale
    ]
    b = _builder(_rules(customers=[["Tika", 9709, "Keep"], ["All", 555, "Exclude"]]))
    out = b.build(pd.DataFrame(lines), dim, None, line_costs=pd.Series([1.0] * 6))
    assert out["Fact_ProductSalesDaily"]["Value"].sum() == 90
    counts = {k: v["lines"] for k, v in b.exclusion_report()["sales_lines_excluded"].items()}
    assert counts == {"customers_exclude": 1, "backoffice": 1, "inter_company": 1, "intercompany_flag": 1, "customers_keep": 1}


# ---------------------------------------------------------------- Products sheet: error-free reading (2026-11-11)
REAL_FILE = Path(__file__).resolve().parents[4] / "Input" / "ProductExclusions.xlsx"


def _products_sheet(tmp_path, rows, headers=None, extra=None) -> Path:
    """A workbook whose Products sheet is written cell by cell with openpyxl (exact cell types: int, float, text, blank)."""
    import openpyxl

    path = _write(tmp_path / "ProductExclusions.xlsx")
    wb = openpyxl.load_workbook(path)
    del wb["Products"]
    ws = wb.create_sheet("Products")
    ws.append(headers or HEADERS["Products"])
    for row in rows:
        ws.append(list(row) if row is not None else [])
    if extra:
        extra(ws)
    wb.save(path)
    return path


def test_products_columns_are_read_by_header_name_in_any_order_and_case(tmp_path) -> None:
    headers = ["Notes", "action", "Product Name (reference)", " ODOO PRODUCT ID ", "Internal Reference (reference)", "ACTIVE", "company", "Reason"]
    # the grey reference columns hold an id-looking number and an Action word: never read
    path = _products_sheet(tmp_path, [["", "Exclude", "Keep", 4157, 9999, "Yes", "Tika", ""]], headers=headers)
    ex = ProductExclusionsLoader().load(path)
    assert _recs(ex.products) == [{"Company": "Tika", "OdooID": 4157, "Action": "Exclude"}] and ex.skipped == []


def test_product_id_123_123_0_and_text_123_read_as_123_everything_else_is_skipped_with_its_row(tmp_path) -> None:
    rows = [["Majaal", 123, "int", "", "Exclude", "Yes"], ["Majaal", 124.0, "float", "", "Exclude", "Yes"],
            ["Majaal", "125", "text", "", "Exclude", "Yes"], ["Majaal", " 126 ", "text spaces", "", "Exclude", "Yes"],
            ["Majaal", None, "blank", "", "Exclude", "Yes"], ["Majaal", 12.5, "decimal", "", "Exclude", "Yes"],
            ["Majaal", "12a", "text", "", "Exclude", "Yes"], ["Majaal", "abc", "text", "", "Exclude", "Yes"],
            ["Majaal", 0, "zero", "", "Exclude", "Yes"], ["Majaal", -3, "negative", "", "Exclude", "Yes"],
            ["Majaal", True, "boolean", "", "Exclude", "Yes"], ["Majaal", "1e3", "exponent", "", "Exclude", "Yes"]]
    ex = ProductExclusionsLoader().load(_products_sheet(tmp_path, rows))
    assert ex.products["OdooID"].tolist() == [123, 124, 125, 126]
    assert ex.products["Row"].tolist() == [2, 3, 4, 5]
    assert [(s["sheet"], s["row"], s["name"]) for s in ex.skipped] == [("Products", r, rows[r - 2][2]) for r in range(6, 14)]
    assert all("Odoo Product ID must be a whole positive number" in s["reason"] for s in ex.skipped)
    assert ex.skipped[0]["reason"].endswith("(got blank)") and ex.skipped[1]["reason"].endswith("(got 12.5)")


def test_company_action_active_are_trimmed_and_case_insensitive(tmp_path) -> None:
    rows = [[" MAJAAL ", 1, "", "", " eXclude ", " YES "], ["tika", 2, "", "", "KEEP", "yes"], ["  all", 3, "", "", "exclude ", "Yes"],
            ["Tika", 4, "", "", "Keep", " NO "]]
    ex = ProductExclusionsLoader().load(_products_sheet(tmp_path, rows))
    assert _recs(ex.products) == [{"Company": "Majaal", "OdooID": 1, "Action": "Exclude"}, {"Company": "Tika", "OdooID": 2, "Action": "Keep"},
                                  {"Company": "All", "OdooID": 3, "Action": "Exclude"}]
    assert ex.ignored["Products"] == 1 and ex.skipped == []


def test_blank_rows_and_rows_past_the_data_are_ignored_and_row_numbers_stay_right(tmp_path) -> None:
    from openpyxl.styles import PatternFill
    from openpyxl.worksheet.datavalidation import DataValidation

    def validation_down_to_2000(ws):
        dv = DataValidation(type="list", formula1='"Exclude,Keep"')
        ws.add_data_validation(dv)
        dv.add("E2:E2000")
        for col in range(1, 8):  # formatted, empty cells down to row 2000, as the template has
            ws.cell(row=2000, column=col).fill = PatternFill("solid", fgColor="DDDDDD")
        ws.cell(row=1500, column=1).value = "   "  # a stray space far below the data

    rows = [["Majaal", 10, "first", "", "Exclude", "Yes"], None, ["", None, "", "", "", ""], ["Tika", 11, "after blanks", "", "Exclude", "Yes"]]
    ex = ProductExclusionsLoader().load(_products_sheet(tmp_path, rows, extra=validation_down_to_2000))
    assert ex.products[["OdooID", "Row"]].values.tolist() == [[10, 2], [11, 5]]
    assert ex.skipped == [] and ex.warnings == [] and ex.ignored["Products"] == 0


def test_duplicate_rows_that_agree_apply_once_and_conflicting_rows_are_both_skipped(tmp_path) -> None:
    rows = [["Majaal", 7, "dup", "", "Exclude", "Yes"], ["Majaal", 7.0, "dup again", "", "exclude", "Yes"],
            ["Tika", 8, "conflict", "", "Exclude", "Yes"], ["Tika", 8, "conflict", "", "Keep", "Yes"],
            ["Majaal", 8, "other company: no conflict", "", "Keep", "Yes"]]
    ex = ProductExclusionsLoader().load(_products_sheet(tmp_path, rows))
    assert _recs(ex.products) == [{"Company": "Majaal", "OdooID": 7, "Action": "Exclude"}, {"Company": "Majaal", "OdooID": 8, "Action": "Keep"}]
    assert ex.warnings == [{"sheet": "Products", "row": 3, "name": "dup again",
                            "reason": "duplicate of row 2 (Majaal Odoo Product ID 7, Exclude): applied once"}]
    assert [(s["row"], s["reason"]) for s in ex.skipped] == [
        (4, "Tika Odoo Product ID 8 conflicts: Exclude (row 4) vs Keep (row 5) -- every row of it is skipped"),
        (5, "Tika Odoo Product ID 8 conflicts: Exclude (row 4) vs Keep (row 5) -- every row of it is skipped")]
    assert ex.summary()["warning_rows"] == 1 and ex.summary()["skipped_rows"] == 2


def test_a_company_row_wins_over_the_all_row_of_the_same_product_for_that_company() -> None:
    ex = _rules(products=[["All", 5, "Exclude"], ["Tika", 5, "Keep"], ["All", 6, "Keep"], ["Majaal", 6, "Exclude"]])
    assert ex.ids("Products", "Exclude", "Tika") == set() and ex.ids("Products", "Keep", "Tika") == {5, 6}  # Tika has no own row for 6: All Keep
    assert ex.ids("Products", "Exclude", "Majaal") == {5, 6} and ex.ids("Products", "Keep", "Majaal") == set()
    dim = _dim({"id": 5, "name": "Shared tile"}, {"id": 6, "name": "Other"})
    lines = [_line("Majaal", 5, "2026-09-01", 1, 10), _line("Tika", 5, "2026-09-01", 1, 20),
             _line("Majaal", 6, "2026-09-01", 1, 30), _line("Tika", 6, "2026-09-01", 1, 40)]
    out = _build(lines, dim, ex)
    assert set(out["Dim_ProductDashboard"]["ProductCompanyKey"]) == {"Tika|5", "Tika|6"}


def test_a_product_id_not_in_odoo_or_of_another_company_is_a_warning_with_its_row(tmp_path) -> None:
    rows = [["Tika", 1, "Majaal's product", "", "Exclude", "Yes"], ["All", 999, "not in Odoo", "", "Exclude", "Yes"],
            ["Majaal", 1, "right company", "", "Exclude", "Yes"], ["All", 2, "shared product", "", "Exclude", "Yes"]]
    ex = ProductExclusionsLoader().load(_products_sheet(tmp_path, rows))
    dim = _dim({"id": 1, "name": "A", "company": "Majaal"}, {"id": 2, "name": "B"})
    b = _builder(ex)
    b.build(pd.DataFrame([_line("Majaal", 1, "2026-09-01", 1, 10)]), dim, None, line_costs=pd.Series([1.0]))
    warnings = b.exclusion_report()["file"]["warnings"]
    assert [(w["sheet"], w["row"]) for w in warnings] == [("Products", 2), ("Products", 3)]
    assert "belongs to Majaal in Odoo, but the row says Tika" in warnings[0]["reason"]
    assert "999 is not a product in Odoo" in warnings[1]["reason"]
    assert b.exclusion_report()["file"]["skipped"] == []              # warnings only: the rows still apply
    b.build(pd.DataFrame([_line("Majaal", 1, "2026-09-01", 1, 10)]), dim, None, line_costs=pd.Series([1.0]))
    assert len(b.exclusion_report()["file"]["warnings"]) == 2         # a second build never repeats them


def test_active_no_keeps_nothing_only_keep_with_active_yes_keeps_an_archived_or_category_product(tmp_path) -> None:
    dim = _dim({"id": 1, "name": "Archived", "company": "Tika", "active": False},
               {"id": 2, "name": "Packaging", "company": "Tika", "categ_id": 39, "categ": "All / Packaging"},
               {"id": 3, "name": "Archived kept", "company": "Tika", "active": False},
               {"id": 4, "name": "Packaging kept", "company": "Tika", "categ_id": 39, "categ": "All / Packaging"})
    rows = [["Tika", 1, "", "", "Keep", "No"], ["Tika", 2, "", "", "Keep", "No"], ["Tika", 3, "", "", "Keep", "Yes"], ["Tika", 4, "", "", "Keep", "Yes"]]
    ex = ProductExclusionsLoader().load(_products_sheet(tmp_path, rows))
    ex.categories = pd.DataFrame([{"Company": "All", "OdooID": 39, "Action": "Exclude", "Row": 2}])
    b = _builder(ex)
    out = b.build(pd.DataFrame([_line("Tika", i, "2026-09-01", 1, 10) for i in (1, 2, 3, 4)]), dim, None, line_costs=pd.Series([1.0] * 4),
                  categories=CATEGORIES)
    assert set(out["Dim_ProductDashboard"]["ProductKey"]) == {"3", "4"}
    assert b.exclusion_report()["products_excluded"] == {"archived": {"total": 1, "by_company": {"Tika": 1}},
                                                         "file_category": {"total": 1, "by_company": {"Tika": 1}}}


@pytest.mark.skipif(not REAL_FILE.is_file(), reason="Input/ProductExclusions.xlsx is not in this checkout")
def test_the_real_product_exclusions_file_has_no_error_on_the_products_sheet() -> None:
    ex = ProductExclusionsLoader().load(REAL_FILE)
    assert [s for s in ex.skipped if s["sheet"] == "Products"] == []
    assert [w for w in ex.warnings if w["sheet"] == "Products"] == []
    assert len(ex.products) + ex.ignored["Products"] == 162          # every data row applied or Active = No
    assert ex.products["OdooID"].is_unique
