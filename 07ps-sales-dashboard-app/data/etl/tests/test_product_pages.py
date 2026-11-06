"""Product pages: Odoo products by id (sales_pipeline.odoo_products) and the pre-aggregated product tables."""

from pathlib import Path

import pandas as pd
import pytest

from sales_pipeline import odoo_products
from sales_pipeline.inventory import InventoryModelBuilder
from sales_pipeline.product_dashboard import IntercompanyFlagger, ProductDashboardBuilder, ProductDashboardConfig

CONFIG = Path(__file__).resolve().parents[1] / "config" / "product_dashboard.json"


# ---------------------------------------------------------------- Odoo catalog + sales lines
def _raw(*rows: dict) -> pd.DataFrame:
    """product.product rows as ProductCostRepository returns them (m2o flattened to name + _id)."""
    out = []
    for r in rows:
        out.append({
            "id": r["id"], "product_tmpl_id": f"tmpl {r.get('tmpl', r['id'])}", "product_tmpl_id_id": r.get("tmpl", r["id"]),
            "name": r["name"], "display_name": r.get("display", r["name"]), "default_code": r.get("code", False),
            "company_id": r.get("company", False), "company_id_id": r.get("company_id", False), "active": r.get("active", True),
            "categ_id": r.get("categ", "All"), "categ_id_id": r.get("categ_id", 1),
            "vendor": r.get("brand", None), "sub_brand_id": False, "product_family_id": r.get("family", False),
            "size_dimensions_id": r.get("size", False), "standard_price": 1.0, "cost_company": "Majaal",
        })
    return pd.DataFrame(out)


def test_catalog_keeps_odoo_values_byte_for_byte_and_marks_empty_attributes_unassigned() -> None:
    raw = _raw(
        {"id": 7, "name": "  CemAir  ٱلْعَرَبِيَّة", "display": "[GRV-1]   CemAir", "code": "GRV-1", "brand": "APE", "categ": "All / Tiles / 60x60"},
        {"id": 8, "name": "Plain", "brand": False, "family": ""},
    )
    cat = odoo_products.catalog(raw).set_index("OdooProductID")
    assert cat.loc[7, "ProductName"] == "  CemAir  ٱلْعَرَبِيَّة"      # no trimming, case or diacritic changes
    assert cat.loc[7, "OdooProductName"] == "[GRV-1]   CemAir"           # display name as Odoo gives it
    assert cat.loc[7, "SKU"] == "GRV-1"                                    # internal reference in its own column
    assert cat.loc[7, "Category"] == "All / Tiles / 60x60"                 # full path
    assert cat.loc[7, "Brand"] == "APE"
    assert cat.loc[8, "Brand"] == cat.loc[8, "Family"] == cat.loc[8, "Size"] == "Unassigned"
    assert pd.isna(cat.loc[8, "SKU"])


def test_attach_is_by_odoo_id_never_by_name_and_never_changes_the_row_count() -> None:
    cat = odoo_products.catalog(_raw({"id": 1, "name": "Same name"}, {"id": 2, "name": "Same name", "brand": "B"}))
    sales = pd.DataFrame([
        {"OdooProductID": 2, "product_name": "Same name"},
        {"OdooProductID": 1, "product_name": "Same name"},
        {"OdooProductID": 1068, "product_name": "Discount - تخفيض"},   # not in the catalog
        {"OdooProductID": None, "product_name": "no product"},
    ])
    out = odoo_products.attach(sales, cat, discount_product_ids=[1068])
    assert len(out) == 4
    assert out["ProductKey"].tolist() == ["2", "1", "1068", "-1"]
    assert out["Brand"].tolist() == ["B", "Unassigned", "Unassigned", "Unassigned"]
    assert out["ProductName"].tolist()[2] == "Discount - تخفيض"            # discount lines keep their name ...
    assert out["is_discount"].tolist() == [False, False, True, False]     # ... and are only flagged


def test_shipped_config_lists_the_discount_products() -> None:
    cfg = ProductDashboardConfig.load(CONFIG)
    assert odoo_products.discount_ids(cfg.section("discounts")) == {1068, 2881, 4691, 6009}


def test_intercompany_flag_is_information_only() -> None:
    flagger = IntercompanyFlagger({9641}, {"اصول المجموعة"})
    sales = pd.DataFrame([
        {"OdooPartnerID": 9641, "customer": "x"},
        {"OdooPartnerID": 1, "customer": " اصول  المجموعة "},
        {"OdooPartnerID": 2, "customer": "Real customer"},
    ])
    out = flagger.flag(sales)
    assert out["IsIntercompany"].tolist() == [True, True, False]
    assert len(out) == len(sales)
    IntercompanyFlagger.from_config(CONFIG)  # the shipped config parses


def test_brand_is_the_main_vendor_by_sequence_then_min_qty_then_id() -> None:
    lines = [
        {"id": 5, "partner_id": [70, "Saquer Gulf"], "product_tmpl_id": [100, "T"], "sequence": 2, "min_qty": 0},
        {"id": 4, "partner_id": [71, "APE Group"], "product_tmpl_id": [100, "T"], "sequence": 1, "min_qty": 10},
        {"id": 3, "partner_id": [72, "Cifre Ceramica"], "product_tmpl_id": [100, "T"], "sequence": 1, "min_qty": 0},
        {"id": 9, "partner_id": [73, "Onix"], "product_tmpl_id": [200, "U"], "sequence": 1, "min_qty": 0},
        {"id": 8, "partner_id": [74, "QUA"], "product_tmpl_id": [200, "U"], "sequence": 1, "min_qty": 0},
        {"id": 6, "partner_id": False, "product_tmpl_id": [300, "V"], "sequence": 1, "min_qty": 0},
    ]
    assert odoo_products.main_vendors(lines) == {100: "Cifre Ceramica", 200: "QUA"}
    raw = pd.DataFrame([{"id": 1, "product_tmpl_id_id": 100, "name": "A"}, {"id": 2, "product_tmpl_id_id": 300, "name": "B"}])
    out = odoo_products.catalog(odoo_products.with_main_vendor(raw, lines)).set_index("OdooProductID")
    assert out.loc[1, "Brand"] == "Cifre Ceramica" and out.loc[2, "Brand"] == "Unassigned"


# ---------------------------------------------------------------- product tables
def _dim(*rows: dict) -> pd.DataFrame:
    return odoo_products.dim_product(odoo_products.catalog(_raw(*rows)))


def _line(company: str, pid: int, date: str, qty: float, value: float, uom: str = "UNIT", name: str | None = None) -> dict:
    return {"company_final": company, "CompanyKey": 1 if company == "Majaal" else 2, "ProductKey": str(pid), "OdooProductID": pid,
            "ProductName": name or f"P{pid}", "OdooProductName": name or f"P{pid}", "order_date_date": date,
            "DateKey": int(date.replace("-", "")), "SalespersonKey": 1, "SegmentKey": 1, "ChannelKey": 1, "SalesTeamKey": "T",
            "IsIntercompany": False, "uom": uom, "untaxed_total": value, "quantity": qty}


def _inv(company: str, pid: int, qty: float, value: float, stock_class: str = "FinishedGoods", location: str = "WH") -> dict:
    return {"ProductCompanyKey": f"{company}|{pid}", "ProductKey": str(pid), "Company": company, "OdooProductName": f"P{pid}",
            "ProductName": f"P{pid}", "LocationName": location, "OnHandQty": qty, "InventoryValue": value, "StockClass": stock_class}


def _build(lines: list[dict], dim: pd.DataFrame, inventory: pd.DataFrame | None = None, costs=None, as_of="2026-09-29", config=None):
    sales = pd.DataFrame(lines)
    cost = pd.Series(costs if costs is not None else [1.0] * len(sales), index=sales.index)
    inv = inventory if inventory is not None else pd.DataFrame(columns=["ProductCompanyKey", "ProductKey", "Company", "OdooProductName", "OnHandQty",
                                                                       "InventoryValue", "StockClass", "LocationName", "ProductName"])
    return ProductDashboardBuilder(config or ProductDashboardConfig.load(CONFIG), as_of).build(sales, dim, inv, line_costs=cost)


def test_daily_table_preserves_totals_including_products_outside_the_catalog() -> None:
    dim = _dim({"id": 1, "name": "A"})
    lines = [_line("Majaal", 1, "2026-09-01", 2, 20), _line("Majaal", 1, "2026-09-01", 3, 30), _line("Tika", 99, "2026-09-02", 1, 5)]
    out = _build(lines, dim)
    daily = out["Fact_ProductSalesDaily"]
    assert daily["Value"].sum() == 55 and daily["Qty"].sum() == 6 and daily["Lines"].sum() == 3
    p = out["Dim_ProductDashboard"].set_index("ProductCompanyKey")
    assert p.loc["Tika|99", "ValueYTD"] == 5 and p.loc["Tika|99", "Brand"] == "Unassigned"  # in the totals, never dropped


def test_zero_sales_active_odoo_product_of_the_company_is_listed_with_zeros() -> None:
    dim = _dim({"id": 1, "name": "A", "company": "Majaal"}, {"id": 2, "name": "B", "company": "Majaal"},
               {"id": 3, "name": "Archived", "company": "Majaal", "active": False})
    products = _build([_line("Majaal", 1, "2026-09-01", 1, 10)], dim)["Dim_ProductDashboard"].set_index("ProductCompanyKey")
    assert "Majaal|2" in products.index
    assert products.loc["Majaal|2", "ValueYTD"] == 0 and products.loc["Majaal|2", "QtyYTD"] == 0
    assert products.loc["Majaal|2", "LifecycleSegment"] == "Never sold"
    assert "Majaal|3" not in products.index  # archived and never sold: not listed


def test_stock_rules_finished_goods_negative_and_no_movement() -> None:
    dim = _dim({"id": 1, "name": "A"}, {"id": 2, "name": "B"})
    inv = pd.DataFrame([
        _inv("Tika", 1, 100, 1000), _inv("Tika", 1, 900, 9000, "RawMaterials", "RM"), _inv("Tika", 1, 50, 500, "InTransit", "VS"),
        _inv("Tika", 1, -20, -200, location="SH"), _inv("Tika", 2, 10, 10),
    ])
    # 1 sells 90 in the last 90 days -> 1/day -> DOH 100 (> Tika overstock 60)
    out = _build([_line("Tika", 1, "2026-09-01", 90, 900)], dim, inventory=inv)
    p = out["Dim_ProductDashboard"].set_index("ProductCompanyKey")
    assert p.loc["Tika|1", "StockQty"] == 100          # raw materials excluded, negative counted as 0
    assert p.loc["Tika|1", "InTransitQty"] == 50       # shown separately, not on hand
    assert p.loc["Tika|1", "DaysOfInventory"] == 100
    assert p.loc["Tika|1", "StockBand"] == "Overstock"
    assert p.loc["Tika|2", "StockBand"] == "NoMovement"  # stock, no sales in 90 days -> never stock-out risk
    dq = out["QA_ProductDataQuality"]
    assert dq.loc[dq["Check"].eq("NegativeStock"), "ProductCompanyKey"].tolist() == ["Tika|1"]


def test_lifecycle_rule() -> None:
    dim = _dim(*({"id": i, "name": n, "company": "Majaal", "active": a} for i, n, a in [
        (1, "New", True), (2, "Grow", True), (3, "Decl", True), (4, "Mat", True), (5, "Inactive", False), (6, "Old", True),
        (7, "Never", True)]))
    lines = [
        _line("Majaal", 1, "2026-08-01", 10, 10),
        _line("Majaal", 2, "2025-01-01", 1, 1), _line("Majaal", 2, "2026-06-01", 10, 10), _line("Majaal", 2, "2026-09-01", 13, 13),
        _line("Majaal", 3, "2025-01-01", 1, 1), _line("Majaal", 3, "2026-06-01", 10, 10), _line("Majaal", 3, "2026-09-01", 7, 7),
        _line("Majaal", 4, "2025-01-01", 1, 1), _line("Majaal", 4, "2026-06-01", 10, 10), _line("Majaal", 4, "2026-09-01", 11, 11),
        _line("Majaal", 5, "2026-09-01", 5, 5),
        _line("Majaal", 6, "2025-06-01", 5, 5),
    ]
    p = _build(lines, dim)["Dim_ProductDashboard"].set_index("ProductKey")
    assert p.loc[["1", "2", "3", "4", "5", "6", "7"], "LifecycleSegment"].tolist() == [
        "New", "Growing", "Declining", "Mature", "Discontinued", "Discontinued", "Never sold"]


def test_bcg_zero_cost_is_unclassified_and_logged() -> None:
    dim = _dim({"id": 1, "name": "A"}, {"id": 2, "name": "B"})
    out = _build([_line("Tika", 1, "2026-03-01", 30000, 300000), _line("Tika", 2, "2026-03-01", 10, 100)], dim, costs=[5.0, 0.0])
    p = out["Dim_ProductDashboard"].set_index("ProductKey")
    assert p.loc["1", "BcgClassYTD"] == "Stars"          # HV (>= 25,000 for Tika) and GP 50% >= 35%
    assert p.loc["2", "BcgClassYTD"] == "Unclassified (no cost)"
    assert out["QA_ProductDataQuality"].query("Check == 'NoCost'")["ProductCompanyKey"].tolist() == ["Tika|2"]


def test_bcg_exclusion_is_by_odoo_category_id_and_the_shipped_list_is_empty(caplog) -> None:
    shipped = ProductDashboardConfig.load(CONFIG)
    assert shipped.section("bcg")["excluded_category_ids"] == []
    dim = _dim({"id": 1, "name": "Bags", "categ_id": 77, "categ": "All / Paper Bags"}, {"id": 2, "name": "Tile", "categ_id": 5})
    lines = [_line("Majaal", 1, "2026-03-01", 1, 1), _line("Majaal", 2, "2026-03-01", 1, 1)]
    with caplog.at_level("INFO"):
        none_excluded = _build(lines, dim)["Dim_ProductDashboard"].set_index("ProductKey")
    assert not none_excluded["BcgExcludedCategory"].any()
    assert "no Odoo category is excluded" in caplog.text
    raw = dict(shipped.raw)
    raw["bcg"] = {**raw["bcg"], "excluded_category_ids": [77]}
    p = _build(lines, dim, config=ProductDashboardConfig(raw))["Dim_ProductDashboard"].set_index("ProductKey")
    assert p.loc["1", "BcgExcludedCategory"] and not p.loc["2", "BcgExcludedCategory"]


def test_location_classification_from_config() -> None:
    cfg = ProductDashboardConfig.load(CONFIG).section("stock_locations")
    classes = InventoryModelBuilder.classify_locations(pd.Series(["Majaal", "RM Warehouse", " vessel ", "Tobruk"]), cfg)
    assert classes.tolist() == ["FinishedGoods", "RawMaterials", "InTransit", "FinishedGoods"]


def test_odoo_gap_report_lists_sold_products_missing_brand_family_size_or_sku_largest_first() -> None:
    dim = _dim({"id": 1, "name": "Complete", "brand": "APE", "family": "PORCELAIN", "size": "60x60", "code": "A-1"},
               {"id": 2, "name": "No brand", "family": "F", "size": "S", "code": "B-1"},
               {"id": 3, "name": "Nothing"}, {"id": 4, "name": "Never sold"})
    lines = [_line("Majaal", 1, "2026-09-01", 1, 50), _line("Majaal", 2, "2026-09-01", 1, 10), _line("Majaal", 3, "2026-09-01", 1, 30),
             _line("Majaal", 3, "2024-01-01", 1, 5)]
    gaps = _build(lines, dim)["QA_ProductOdooGaps"]
    assert gaps["OdooProductID"].tolist() == [3, 2]       # largest sales first; complete and unsold products are not listed
    assert gaps.iloc[0]["Missing"] == "Brand, Family, Size, SKU" and gaps.iloc[1]["Missing"] == "Brand"
    assert gaps.iloc[0]["SalesValue"] == 35 and gaps.iloc[0]["SalesValueLast12M"] == 30
    assert gaps.iloc[0]["ProductName"] == "Nothing" and gaps.iloc[0]["Company"] == "Majaal"


# ---------------------------------------------------------------- one company per product; Athena left out; one "Unit"
def test_every_product_row_is_one_odoo_product_in_one_company_never_combined() -> None:
    # products 1 (Majaal) and 2 (Tika) share template 100: still two rows, never "Majaal + Tika"
    dim = _dim({"id": 1, "name": "Cemair", "tmpl": 100}, {"id": 2, "name": "Cem Air", "tmpl": 100})
    out = _build([_line("Majaal", 1, "2026-03-01", 100, 300), _line("Tika", 2, "2026-09-01", 90, 700)], dim)
    p = out["Dim_ProductDashboard"].set_index("ProductCompanyKey")
    assert sorted(p.index) == ["Majaal|1", "Tika|2"]
    assert set(p["Company"]) == {"Majaal", "Tika"} and not p["Company"].str.contains("+", regex=False).any()
    assert "Dim_ProductDashboardGroup" not in out and "ProductGroupKey" not in p.columns
    assert (p["ThresholdCompany"] == p["Company"]).all()


def test_athena_is_left_out_of_every_product_table() -> None:
    dim = _dim({"id": 1, "name": "A", "company": "Athena"}, {"id": 2, "name": "B", "company": "Majaal"})
    inv = pd.DataFrame([_inv("Athena", 1, 10, 10), _inv("Majaal", 2, 5, 5)])
    out = _build([_line("Athena", 1, "2026-09-01", 1, 1000), _line("Majaal", 2, "2026-09-01", 1, 10)], dim, inventory=inv)
    assert set(out["Fact_ProductSalesDaily"]["Company"]) == {"Majaal"}
    assert out["Fact_ProductSalesDaily"]["Value"].sum() == 10
    assert set(out["Dim_ProductDashboard"]["Company"]) == {"Majaal"}
    assert out["ProductDashboard_Meta"]["SalesLinesValue"].iloc[0] == 10
    assert "Athena" not in set(out["QA_ProductOdooGaps"]["Company"]) and "Athena" not in set(out["QA_ProductDataQuality"]["Company"])


def test_unit_type_uoms_are_one_unit_and_their_quantities_add_up() -> None:
    dim = _dim({"id": 1, "name": "Tile"})
    lines = [_line("Majaal", 1, "2026-09-01", 10, 10, uom="وحدة"), _line("Majaal", 1, "2026-09-02", 5, 5, uom="UNIT"),
             _line("Majaal", 1, "2026-09-03", 2, 2, uom="Units"), _line("Majaal", 1, "2026-09-03", 3, 3, uom="m²")]
    out = _build(lines, dim)
    daily = out["Fact_ProductSalesDaily"].groupby("UoM")["Qty"].sum().to_dict()
    assert daily == {"Unit": 17, "m²": 3}  # 10 + 5 + 2 in one unit; m² is not a unit-type UoM and keeps its name
    p = out["Dim_ProductDashboard"].set_index("ProductCompanyKey").loc["Majaal|1"]
    assert p["UoMList"] == "Unit | m²"


def test_product_ratio_columns_are_stored_as_decimal_not_float() -> None:
    """MySQL FLOAT keeps ~7 significant digits: DaysOfInventory 12857.142857 came back as 12857.1 and failed the
    SQL/DataFrame mirror validation of Dim_ProductDashboard in production."""
    from sqlalchemy.dialects import mysql

    from sales_pipeline.export.database_exporter import DatabaseExporter

    for name in ["AvgDailySales", "DaysOfInventory"]:
        dtype = DatabaseExporter._mysql_dtype_for_column(name, pd.Series([12857.142857, 1.077778]))
        assert isinstance(dtype, mysql.DECIMAL), name


def test_meta_built_at_has_whole_seconds() -> None:
    """MySQL DATETIME rounds fractional seconds; a .5s+ value read back one second later and failed the
    SQL/DataFrame mirror validation of ProductDashboard_Meta in production (run 218)."""
    built = _build([_line("Majaal", 1, "2026-09-01", 1, 1)], _dim({"id": 1, "name": "A"}))["ProductDashboard_Meta"]["BuiltAtUtc"].iloc[0]
    assert built == built.floor("s")
