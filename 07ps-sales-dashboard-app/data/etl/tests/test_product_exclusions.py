"""ProductExclusions.xlsx: the loader and how ProductDashboardBuilder applies its rules (priority, sub-categories, company)."""

from pathlib import Path

import pandas as pd

from sales_pipeline.product_dashboard import ProductDashboardBuilder, ProductDashboardConfig
from sales_pipeline.product_exclusions import ProductExclusions, ProductExclusionsLoader
from test_product_pages import CONFIG, _dim, _line

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
    assert ex.customers.to_dict("records") == [{"Company": "Tika", "OdooID": 9709, "Action": "Keep"}, {"Company": "All", "OdooID": 18449, "Action": "Exclude"}]
    assert ex.categories.to_dict("records") == [{"Company": "All", "OdooID": 39, "Action": "Exclude"}]
    assert ex.products.to_dict("records") == [{"Company": "Tika", "OdooID": 4157, "Action": "Exclude"}]


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


def test_bad_rows_are_reported_never_silently_dropped(tmp_path) -> None:
    ex = ProductExclusionsLoader().load(_write(
        tmp_path / "ProductExclusions.xlsx",
        customers=[["Tika", "abc", "x", "Keep", "Yes", ""], ["Tika", 12.5, "x", "Keep", "Yes", ""], ["Benghazi", 5, "x", "Keep", "Yes", ""]],
        categories=[["All", 39, "Packaging", "Keep", "Yes", ""], ["All", 3, "Expenses", "Exclude", "maybe", ""]],
        products=[["Majaal", -4, "x", "", "Exclude", "Yes", ""]],
    ))
    assert ex.customers.empty and ex.categories.empty and ex.products.empty
    text = "\n".join(ex.issues)
    assert len(ex.issues) == 6
    assert "Customers row 2: Odoo Partner ID must be a whole positive number (got abc)" in text
    assert "Customers row 3" in text and "Customers row 4: Company must be All, Majaal or Tika (got Benghazi)" in text
    assert "Categories row 2: Action must be Exclude (got Keep)" in text and "Categories row 3: Active must be Yes or No (got maybe)" in text
    assert "Products row 2" in text and all(i.endswith("-- row not applied") for i in ex.issues)


def test_missing_sheet_or_column_is_reported(tmp_path) -> None:
    path = tmp_path / "ProductExclusions.xlsx"
    with pd.ExcelWriter(path) as xl:
        pd.DataFrame(columns=["Company", "Odoo Partner ID", "Action"]).to_excel(xl, sheet_name="Customers", index=False)
        pd.DataFrame(columns=HEADERS["Categories"]).to_excel(xl, sheet_name="Categories", index=False)
    ex = ProductExclusionsLoader().load(path)
    assert ex.issues == ["Customers: missing column(s) Active -- sheet ignored", "Products: sheet missing (no products rules read)"]


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
