"""ProductExclusions.xlsx in its 2026-11-15 structure: a small synthetic copy of the real file's layout (every reference
column, the Instructions / Summary / Lists sheets, no "Price Fix (Odoo)" sheet) and the rules on the Product pages."""

from __future__ import annotations

from pathlib import Path

import pandas as pd
import pytest

from sales_pipeline.product_dashboard import PRODUCT_STATUSES, product_status
from sales_pipeline.product_exclusions import ExclusionsFileInvalid, ProductExclusionsLoader
from test_product_exclusions import CATEGORIES, _builder, _cust, on_pages
from test_product_pages import _dim, _line

CUSTOMERS = ["Company", "Odoo Partner ID", "Customer Name (reference)", "Action", "Active", "Reason", "Added By", "Added Date", "Notes"]
CATEGORY_COLS = ["Company", "Odoo Category ID", "Category Name (reference)", "Action", "Active", "Reason", "Added By", "Added Date", "Notes"]
PRODUCTS = ["Company", "Odoo Product ID", "Product Name (reference)", "Internal Reference (reference)", "Category (reference)",
            "Odoo Category ID (reference)", "Product Type (reference)", "Odoo Sales Price (reference)", "Action", "Active", "Reason",
            "LYD 2026 YTD (reference)", "LYD 2025 (reference)", "LYD before 2025 (reference)", "Archived in Odoo", "Added By",
            "Added Date", "Notes"]


def product_row(company, pid, action="Exclude", active="Yes", reason="test", archived=None, ptype="Storable"):
    return [company, pid, f"P{pid}", None, "All / Adhesive", 64, ptype, 1, action, active, reason, 0, 0, 0, archived, "QA", "2026-11-15", None]


def write_new_structure(path: Path, customers=(), categories=(), products=(), drop_sheet: str | None = None,
                        drop_column: tuple[str, str] | None = None) -> Path:
    sheets = {
        "Instructions": pd.DataFrame([["Active = No rows are ignored"]], columns=["How to use"]),
        "Summary": pd.DataFrame([["Products", 1]], columns=["Sheet", "Rows"]),
        "Customers": pd.DataFrame(list(customers), columns=CUSTOMERS),
        "Categories": pd.DataFrame(list(categories), columns=CATEGORY_COLS),
        "Products": pd.DataFrame(list(products), columns=PRODUCTS),
        "Lists": pd.DataFrame([["Exclude"], ["Keep"]], columns=["Action"]),
    }
    if drop_sheet:
        sheets.pop(drop_sheet)
    if drop_column:
        sheet, column = drop_column
        sheets[sheet] = sheets[sheet].drop(columns=[column])
    with pd.ExcelWriter(path) as xl:
        for name, df in sheets.items():
            df.to_excel(xl, sheet_name=name, index=False)
    return path


def test_the_new_structure_is_read_reference_columns_and_archived_flag_never_matter(tmp_path) -> None:
    f = write_new_structure(
        tmp_path / "ProductExclusions.xlsx",
        customers=[["Tika", 9709, "Al Madina", "Keep", "Yes", "Real buyer", None, None, None]],
        categories=[["All", 39, "Packaging", "Exclude", "Yes", "Packaging", None, None, None],
                    ["Tika", 1, "root", "Exclude", "No", "pending", None, None, None]],
        products=[product_row("Majaal", 3273, archived="Yes", ptype="Service"), product_row("Tika", 5, active="No")],
    )
    ex = ProductExclusionsLoader().load(f)
    assert ex.counts() == {"Customers": {"Keep": 1}, "Categories": {"Exclude": 1}, "Products": {"Exclude": 1}}
    assert ex.ignored == {"Customers": 0, "Categories": 1, "Products": 1}            # Active = No: ignored, counted
    assert ex.skipped == [] and ex.warnings == []
    assert ex.rule_for("Products", "Majaal", 3273) == {"sheet": "Products", "company": "Majaal", "row": 2, "action": "Exclude", "reason": "test"}
    assert ex.rule_for("Products", "Tika", 5) is None                                 # the Active = No row does nothing


@pytest.mark.parametrize("drop_sheet, drop_column, message", [
    ("Products", None, "sheet 'Products' is missing"),
    (None, ("Categories", "Odoo Category ID"), "sheet 'Categories' is missing column(s) Odoo Category ID"),
    (None, ("Customers", "Active"), "sheet 'Customers' is missing column(s) Active"),
])
def test_a_missing_sheet_or_required_column_rejects_the_file(tmp_path, drop_sheet, drop_column, message) -> None:
    f = write_new_structure(tmp_path / "ProductExclusions.xlsx", drop_sheet=drop_sheet, drop_column=drop_column)
    with pytest.raises(ExclusionsFileInvalid) as err:
        ProductExclusionsLoader().load(f)
    assert message in err.value.problems


def test_a_missing_reference_column_is_fine(tmp_path) -> None:
    f = write_new_structure(tmp_path / "ProductExclusions.xlsx", products=[product_row("Tika", 5)],
                            drop_column=("Products", "Archived in Odoo"))
    assert ProductExclusionsLoader().load(f).counts()["Products"] == {"Exclude": 1}


def test_a_bad_id_row_is_skipped_with_its_excel_row(tmp_path) -> None:
    f = write_new_structure(tmp_path / "ProductExclusions.xlsx",
                            products=[product_row("Tika", 5), product_row("Tika", "12.5"), product_row("Tika", "abc")])
    ex = ProductExclusionsLoader().load(f)
    assert ex.counts()["Products"] == {"Exclude": 1}
    assert [(s["sheet"], s["row"]) for s in ex.skipped] == [("Products", 3), ("Products", 4)]
    assert all("whole positive number" in s["reason"] for s in ex.skipped)


def _status(out: pd.DataFrame) -> dict[str, str]:
    dim = out["Dim_ProductDashboard"]
    return dict(zip(dim["ProductKey"].astype(str), dim["ProductStatus"]))


def test_exclude_keep_precedence_all_vs_company_and_category_with_a_product_keep(tmp_path) -> None:
    f = write_new_structure(
        tmp_path / "ProductExclusions.xlsx",
        categories=[["All", 39, "Packaging", "Exclude", "Yes", "Packaging, not sold", None, None, None]],
        products=[product_row("All", 5, reason="not a product"),          # All: both companies...
                  product_row("Tika", 5, action="Keep", reason="sold"),   # ...but Tika keeps it (the company row wins)
                  product_row("Tika", 2, action="Keep", reason="real")],  # a product Keep beats the category exclusion
    )
    ex = ProductExclusionsLoader().load(f)
    dim = _dim(
        {"id": 1, "name": "Film", "company": "Tika", "categ_id": 90, "categ": "All / Packaging / Films"},  # sub-category
        {"id": 2, "name": "Branded bag", "company": "Tika", "categ_id": 39, "categ": "All / Packaging"},
        {"id": 5, "name": "Shared", "categ_id": 64, "categ": "All / Adhesive"},
    )
    lines = [_line(c, i, "2026-09-01", 1, 10) for c, i in (("Tika", 1), ("Tika", 2), ("Tika", 5), ("Majaal", 5))]
    b = _builder(ex)
    out = b.build(pd.DataFrame(lines), dim, None, line_costs=pd.Series([1.0] * len(lines)), categories=CATEGORIES)
    dim_out = out["Dim_ProductDashboard"]
    status = dict(zip(dim_out["ProductCompanyKey"], dim_out["ProductStatus"]))
    assert status["Tika|1"] == "Unclassified"          # sub-category follows its parent
    assert status["Tika|2"] == "NonActive"             # Products Keep overrides the category (sold, no stock: Non Active)
    assert status["Tika|5"] == "NonActive"             # Tika's Keep wins over the All Exclude for Tika
    assert status["Majaal|5"] == "Unclassified"        # the All row applies to Majaal
    rule = dict(zip(dim_out["ProductCompanyKey"], dim_out["ExclusionRule"]))
    assert rule["Tika|1"] == "Categories sheet · All · Packaging · row 2 · Packaging, not sold"
    assert rule["Majaal|5"] == "Products sheet · All · row 2 · not a product"
    assert pd.isna(rule["Tika|2"])
    # Unclassified products are never on the pages
    assert set(on_pages(dim_out)["ProductCompanyKey"]) == {"Tika|2", "Tika|5"}


def test_a_customer_keep_overrides_inter_company_and_exclude_drops_lines(tmp_path) -> None:
    f = write_new_structure(
        tmp_path / "ProductExclusions.xlsx",
        customers=[["Tika", 9709, "Al Madina", "Keep", "Yes", "real buyer", None, None, None],
                   ["Tika", 555, "Samples", "Exclude", "Yes", "samples", None, None, None],
                   ["Tika", 101, "Group co", "Keep", "No", "pending", None, None, None]],
    )
    b = _builder(ProductExclusionsLoader().load(f))
    lines = pd.DataFrame([
        _cust({**_line("Tika", 1, "2026-09-01", 1, 10), "SegmentKey": 4}, 9709),   # Inter Company, kept
        _cust({**_line("Tika", 1, "2026-09-01", 2, 20), "SegmentKey": 4}, 101),    # Inter Company (Keep is Active = No)
        _cust(_line("Tika", 1, "2026-09-01", 3, 30), 555),                         # excluded customer
        _cust(_line("Tika", 1, "2026-09-01", 4, 40), 700),                         # a real sale
    ])
    lines = lines.rename(columns={"company_final": "Company"})
    removed = b.non_sales_mask(lines).tolist()
    assert removed == [False, True, True, False]


def test_one_status_rule_unclassified_beats_dormant_beats_active() -> None:
    idx = pd.RangeIndex(5)
    excluded = pd.Series([True, True, False, False, False], index=idx)
    archived = pd.Series([True, False, True, False, False], index=idx)
    sold = pd.Series([True, True, True, True, False], index=idx)
    assert product_status(excluded, archived, sold).tolist() == ["Unclassified", "Unclassified", "Dormant", "Active", "NonActive"]
    assert PRODUCT_STATUSES == ("Unclassified", "Dormant", "Active", "NonActive")


def test_status_rules_with_stock_2026_11_15() -> None:
    # sales + stock = Active; one of them = Non Active; neither = Dormant; archived = Dormant whatever the stock
    idx = pd.RangeIndex(5)
    no = pd.Series(False, index=idx)
    archived = pd.Series([False, False, False, False, True], index=idx)
    sold = pd.Series([True, True, False, False, True], index=idx)
    stock = pd.Series([True, False, True, False, True], index=idx)
    assert product_status(no, archived, sold, stock).tolist() == ["Active", "NonActive", "NonActive", "Dormant", "Dormant"]
