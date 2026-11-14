"""Product Status (2026-11-14): every product of the pages' companies gets exactly one ProductStatus in Dim_ProductDashboard
(Unclassified > Dormant > Active > NonActive), the window is the last 12 months (periods.py), and a Categories row
matches by Odoo id OR by category name / full path."""

import pandas as pd

from sales_pipeline.periods import get_last_12m_range, get_prior_12m_range
from sales_pipeline.product_dashboard import ProductDashboardBuilder, ProductDashboardConfig
from sales_pipeline.product_exclusions import ProductExclusions
from test_product_pages import CONFIG, _dim, _inv, _line

AS_OF = "2026-11-14"


def _rules(categories=(), products=()) -> ProductExclusions:
    def frame(rows, cols=("Company", "OdooID", "Action")):
        return pd.DataFrame(list(rows), columns=list(cols)).astype({"OdooID": "int64"})
    return ProductExclusions(categories=frame(categories, ("Company", "OdooID", "Action", "Name")), products=frame(products), source="test")


def _build(lines, dim, exclusions, inventory=(), categories=None):
    sales = pd.DataFrame(lines)
    cost = pd.Series([1.0] * len(sales), index=sales.index)
    inv = pd.DataFrame(list(inventory), columns=["ProductCompanyKey", "ProductKey", "Company", "OdooProductName", "ProductName", "LocationName",
                                                 "OnHandQty", "InventoryValue", "StockClass"])
    return ProductDashboardBuilder(ProductDashboardConfig.load(CONFIG), AS_OF, exclusions).build(
        sales, dim, inv, line_costs=cost, categories=categories)


def test_last_12_months_is_the_same_day_a_year_back_to_today_and_the_prior_12_months_end_the_day_before() -> None:
    assert get_last_12m_range("2026-11-14") == (pd.Timestamp("2025-11-14"), pd.Timestamp("2026-11-14"))
    assert get_prior_12m_range("2026-11-14") == (pd.Timestamp("2024-11-14"), pd.Timestamp("2025-11-13"))
    assert get_last_12m_range("2028-02-29")[0] == pd.Timestamp("2027-02-28")


def test_every_product_gets_exactly_one_status_in_order_and_total_equals_the_sum() -> None:
    dim = _dim(
        {"id": 1, "name": "Sold tile", "company": "Majaal", "categ_id": 10, "categ": "All / Tiles"},
        {"id": 2, "name": "Stock, unsold", "company": "Majaal", "categ_id": 10, "categ": "All / Tiles"},
        {"id": 3, "name": "Never sold", "company": "Majaal", "categ_id": 10, "categ": "All / Tiles"},
        {"id": 4, "name": "Archived, sold", "company": "Majaal", "categ_id": 10, "categ": "All / Tiles", "active": False},
        {"id": 5, "name": "Carton", "company": "Majaal", "categ_id": 39, "categ": "All / Packaging"},
        {"id": 6, "name": "Archived carton", "company": "Majaal", "categ_id": 39, "categ": "All / Packaging", "active": False},
        {"id": 7, "name": "Sand", "company": "Tika", "categ_id": 70, "categ": "All / Raw Materials"},
        {"id": 8, "name": "Carton kept", "company": "Majaal", "categ_id": 39, "categ": "All / Packaging"},
        {"id": 9, "name": "Sold 13 months ago", "company": "Majaal", "categ_id": 10, "categ": "All / Tiles"},
        {"id": 10, "name": "Only a return", "company": "Majaal", "categ_id": 10, "categ": "All / Tiles"},
        {"id": 11, "name": "Archived, never sold", "company": "Majaal", "categ_id": 10, "categ": "All / Tiles", "active": False},
    )
    lines = [
        _line("Majaal", 1, "2026-06-01", 5, 50),
        _line("Majaal", 4, "2026-06-01", 5, 50),
        _line("Majaal", 5, "2026-06-01", 5, 50),
        _line("Tika", 7, "2026-06-01", 5, 50),
        _line("Majaal", 8, "2025-11-14", 1, 10),   # the first day of the window counts
        _line("Majaal", 9, "2025-11-13", 5, 50),   # the day before the window: not Active
        _line("Majaal", 10, "2026-06-01", -2, -20),  # quantity <= 0 is not a sale
    ]
    categories = pd.DataFrame({"id": [1, 10, 39, 70], "name": ["All", "Tiles", "Packaging", "Raw Materials"],
                               "complete_name": ["All", "All / Tiles", "All / Packaging", "All / Raw Materials"],
                               "parent_path": ["1/", "1/10/", "1/39/", "1/70/"]})
    ex = _rules(categories=[["All", 39, "Exclude", "Packaging"]], products=[["Majaal", 8, "Keep"]])
    dim_out = _build(lines, dim, ex, inventory=[_inv("Majaal", 2, 4, 40)], categories=categories)["Dim_ProductDashboard"]
    status = dim_out.set_index("ProductKey")["ProductStatus"].to_dict()
    assert status == {
        "1": "Active", "2": "NonActive", "3": "NonActive", "4": "Dormant", "5": "Unclassified", "6": "Unclassified",
        "7": "Unclassified", "8": "Active", "9": "NonActive", "10": "NonActive", "11": "Dormant",
    }
    assert len(dim_out) == dim_out["ProductCompanyKey"].nunique() == 11            # one row per product, every product
    counts = dim_out["ProductStatus"].value_counts()
    assert counts.sum() == len(dim_out) and set(counts.index) <= {"Unclassified", "Dormant", "Active", "NonActive"}
    pages = dim_out.set_index("ProductKey")["OnProductPages"].to_dict()
    assert {k for k, v in pages.items() if v == 0} == {"4", "5", "6", "7", "11"}    # excluded / archived: counted, not on the pages
    on_hand = dim_out.set_index("ProductKey")["OnHandQty"]
    assert on_hand["2"] == 4 and on_hand["3"] == 0                                   # Non Active: with stock / zero stock


def test_a_categories_row_matches_by_name_or_full_path_when_the_id_is_not_an_odoo_category(caplog) -> None:
    dim = _dim(
        {"id": 1, "name": "Flyer", "company": "Majaal", "categ_id": 81, "categ": "All / Marketing"},
        {"id": 2, "name": "Banner", "company": "Majaal", "categ_id": 82, "categ": "All / Marketing / Print"},
        {"id": 3, "name": "Tile", "company": "Majaal", "categ_id": 10, "categ": "All / Tiles"},
    )
    lines = [_line("Majaal", i, "2026-06-01", 1, 10) for i in (1, 2, 3)]
    categories = pd.DataFrame({"id": [1, 10, 81, 82], "name": ["All", "Tiles", "Marketing", "Print"],
                               "complete_name": ["All", "All / Tiles", "All / Marketing", "All / Marketing / Print"],
                               "parent_path": ["1/", "1/10/", "1/81/", "1/81/82/"]})
    ex = _rules(categories=[["All", 9999, "Exclude", "  marketing "], ["All", 9998, "Exclude", "Nothing Like This"]])
    out = _build(lines, dim, ex, categories=categories)
    status = out["Dim_ProductDashboard"].set_index("ProductKey")["ProductStatus"].to_dict()
    assert status == {"1": "Unclassified", "2": "Unclassified", "3": "Active"}       # sub-category follows its parent
    assert set(out["Fact_ProductSalesDaily"]["ProductKey"]) == {"3"}                 # the same rule leaves them off the pages
    assert "matches no Odoo category" in caplog.text and "Nothing Like This" in caplog.text


def test_without_migration_0073_only_the_page_rows_are_loaded() -> None:
    from departments.sales.jobs import fit_to_table

    df = pd.DataFrame({"ProductCompanyKey": ["Majaal|1", "Majaal|2"], "OnProductPages": [1, 0], "ProductStatus": ["Active", "Dormant"]})
    old = fit_to_table("dim_sales_product_dashboard", df, ["ProductCompanyKey"])
    assert old["ProductCompanyKey"].tolist() == ["Majaal|1"] and list(old.columns) == ["ProductCompanyKey"]
    new = fit_to_table("dim_sales_product_dashboard", df, ["ProductCompanyKey", "OnProductPages", "ProductStatus"])
    assert len(new) == 2
