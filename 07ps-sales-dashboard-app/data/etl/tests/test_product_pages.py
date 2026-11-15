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


def test_intercompany_flag_marks_lines_and_never_drops_rows() -> None:
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
    # 5 is archived in Odoo: left out of every Product page (2026-11-11), so only "no sale in 365 days" is Discontinued
    assert "5" not in p.index
    assert p.loc[["1", "2", "3", "4", "6", "7"], "LifecycleSegment"].tolist() == [
        "New", "Growing", "Declining", "Mature", "Discontinued", "Never sold"]


def test_bcg_zero_cost_is_unclassified_and_logged() -> None:
    dim = _dim({"id": 1, "name": "A"}, {"id": 2, "name": "B"})
    out = _build([_line("Tika", 1, "2026-03-01", 30000, 300000), _line("Tika", 2, "2026-03-01", 10, 100)], dim, costs=[5.0, 0.0])
    p = out["Dim_ProductDashboard"].set_index("ProductKey")
    assert p.loc["1", "BcgClassYTD"] == "Stars"          # HV (>= 25,000 for Tika) and GP 50% >= 35%
    assert p.loc["2", "BcgClassYTD"] == "Unclassified (no cost)"
    assert out["QA_ProductDataQuality"].query("Check == 'NoCost'")["ProductCompanyKey"].tolist() == ["Tika|2"]


def test_bcg_uses_the_company_volume_threshold_and_the_profit_threshold() -> None:
    # Majaal 3,500 units / Tika 25,000 units, GP 35%; a volume equal to the threshold is High (>=)
    shipped = ProductDashboardConfig.load(CONFIG).section("bcg")
    assert shipped["volume_threshold"] == {"Majaal": 3500, "Tika": 25000, "Athena": 3500} and shipped["profit_threshold_pct"] == 35
    dim = _dim(*({"id": i, "name": f"P{i}"} for i in range(1, 6)))
    lines = [_line("Majaal", 1, "2026-03-01", 3500, 7000),          # exactly 3,500 = HV, GP 50% -> Stars
             _line("Majaal", 2, "2026-03-01", 3499, 3499 * 2),      # LV, GP 50%          -> Strategic
             _line("Majaal", 3, "2026-03-01", 4000, 4400),          # HV, GP ~9%          -> Cash Cows
             _line("Majaal", 4, "2026-03-01", 10, 11),              # LV, GP ~9%          -> Dogs
             _line("Tika", 5, "2026-03-01", 24999, 24999 * 2)]      # under the Tika 25,000 -> Strategic
    p = _build(lines, dim)["Dim_ProductDashboard"].set_index("ProductCompanyKey")
    assert p.loc[["Majaal|1", "Majaal|2", "Majaal|3", "Majaal|4", "Tika|5"], "BcgClassYTD"].tolist() == [
        "Stars", "Strategic", "Cash Cows", "Dogs", "Strategic"]


def test_without_the_exclusions_file_the_json_category_ids_are_the_fallback() -> None:
    shipped = ProductDashboardConfig.load(CONFIG)
    assert "excluded_category_ids" not in shipped.section("bcg") and "product_pages_excluded_category_ids" not in shipped.raw
    dim = _dim({"id": 1, "name": "Bags", "categ_id": 77, "categ": "All / Paper Bags"}, {"id": 2, "name": "Tile", "categ_id": 5})
    lines = [_line("Majaal", 1, "2026-03-01", 1, 1), _line("Majaal", 2, "2026-03-01", 1, 1)]
    assert set(_build(lines, dim)["Dim_ProductDashboard"]["ProductKey"]) == {"1", "2"}
    for raw in ({**shipped.raw, "product_pages_excluded_category_ids": [77]}, {**shipped.raw, "bcg": {**shipped.section("bcg"), "excluded_category_ids": [77]}}):
        out = _build(lines, dim, config=ProductDashboardConfig(raw))
        assert set(out["Dim_ProductDashboard"]["ProductKey"]) == {"2"}           # left out of every table, not only BCG
        assert out["Fact_ProductSalesDaily"]["Lines"].sum() == 1
        assert not out["Dim_ProductDashboard"]["BcgExcludedCategory"].any()


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


def test_backoffice_inter_company_and_intercompany_lines_are_left_out_of_every_product_table() -> None:
    dim = _dim({"id": 1, "name": "A", "company": "Majaal"}, {"id": 2, "name": "B", "company": "Majaal"})
    real = _line("Majaal", 1, "2026-09-01", 2, 20)
    backoffice = {**_line("Majaal", 1, "2026-09-02", 100, 1000), "SegmentKey": 3}
    inter_company = {**_line("Majaal", 1, "2026-01-05", 50, 500), "SegmentKey": 4}
    flagged = {**_line("Majaal", 1, "2026-09-03", 7, 70), "IsIntercompany": True}
    only_transfer = {**_line("Majaal", 2, "2026-03-01", 9, 90), "SegmentKey": 3}   # product 2: transfers only
    out = _build([real, backoffice, inter_company, flagged, only_transfer], dim)
    daily = out["Fact_ProductSalesDaily"]
    assert daily["Value"].sum() == 20 and daily["Qty"].sum() == 2 and daily["Lines"].sum() == 1
    assert set(daily["SegmentKey"]) == {1} and not daily["IsIntercompany"].any()
    p = out["Dim_ProductDashboard"].set_index("ProductCompanyKey")
    assert p.loc["Majaal|1", "QtyYTD"] == 2 and p.loc["Majaal|1", "ValueYTD"] == 20
    assert str(p.loc["Majaal|1", "FirstSaleDate"].date()) == "2026-09-01"       # the January transfer is not a first sale
    assert p.loc["Majaal|2", "QtyYTD"] == 0 and p.loc["Majaal|2", "LifecycleSegment"] == "Never sold"
    assert out["ProductDashboard_Meta"]["SalesLinesValue"].iloc[0] == 20


def test_non_sales_exclusion_follows_the_config() -> None:
    raw = ProductDashboardConfig.load(CONFIG).raw
    assert raw["product_pages_excluded_segment_keys"] == [3, 4] and raw["product_pages_exclude_intercompany"] is True
    keep_flagged = ProductDashboardConfig({**raw, "product_pages_excluded_segment_keys": [], "product_pages_exclude_intercompany": False})
    dim = _dim({"id": 1, "name": "A", "company": "Majaal"})
    lines = [_line("Majaal", 1, "2026-09-01", 2, 20), {**_line("Majaal", 1, "2026-09-02", 1, 10), "SegmentKey": 3, "IsIntercompany": True}]
    assert _build(lines, dim, config=keep_flagged)["Fact_ProductSalesDaily"]["Value"].sum() == 30


def test_product_movement_is_on_volume_ytd_vs_lytd_with_the_configured_band() -> None:
    cases = {  # id: (active, [(date, qty)], expected movement)
        1: (True, [("2025-03-01", 100), ("2026-03-01", 111)], "Improved"),      # +11%
        2: (True, [("2025-03-01", 100), ("2026-03-01", 110)], "Stable"),        # +10% exactly: inside the band
        3: (True, [("2025-03-01", 100), ("2026-03-01", 90)], "Stable"),         # -10% exactly: inside the band
        4: (True, [("2025-03-01", 100), ("2026-03-01", 89)], "Drop"),           # -11%
        5: (True, [("2025-03-01", 100)], "Drop"),                               # sold last year, nothing this year, still active
        6: (True, [("2024-05-01", 40), ("2026-03-01", 50)], "New"),             # zero LYTD (old product back on sale)
        7: (True, [("2026-06-01", 5)], "New"),                                  # first sale within 180 days
        8: (False, [("2025-03-01", 100), ("2026-03-01", 300)], "excluded"),     # archived in Odoo: off every Product page
        9: (False, [("2026-06-01", 5)], "excluded"),
        10: (True, [("2024-05-01", 40)], None),                                 # not sold in either period
        11: (True, [("2025-03-01", 100), ("2026-03-01", 110.01)], "Improved"),  # just over +10%
        12: (True, [("2025-03-01", 100), ("2026-03-01", 89.99)], "Drop"),       # just under -10%
        13: (True, [("2025-03-01", 100), ("2025-12-01", 900), ("2026-03-01", 100)], "Stable"),  # after the LYTD end date: not LYTD
    }
    dim = _dim(*({"id": i, "name": f"P{i}", "company": "Majaal", "active": active} for i, (active, _, _) in cases.items()))
    lines = [_line("Majaal", i, d, q, q * 10) for i, (_, sales, _) in cases.items() for d, q in sales]
    p = _build(lines, dim)["Dim_ProductDashboard"].set_index("ProductKey")
    for i, (_, _, expected) in cases.items():
        if expected == "excluded":
            assert str(i) not in p.index, i
            continue
        got = p.loc[str(i), "BcgMovement"]
        assert (got if isinstance(got, str) else None) == expected, (i, got)


def test_movement_band_comes_from_the_config() -> None:
    raw = ProductDashboardConfig.load(CONFIG).raw
    assert raw["bcg"]["movement_stable_band_pct"] == 10
    wide = ProductDashboardConfig({**raw, "bcg": {**raw["bcg"], "movement_stable_band_pct": 20}})
    dim = _dim({"id": 1, "name": "A", "company": "Majaal"})
    lines = [_line("Majaal", 1, "2025-03-01", 100, 1000), _line("Majaal", 1, "2026-03-01", 115, 1150)]
    assert _build(lines, dim)["Dim_ProductDashboard"]["BcgMovement"].iloc[0] == "Improved"
    assert _build(lines, dim, config=wide)["Dim_ProductDashboard"]["BcgMovement"].iloc[0] == "Stable"


def _layer(company: str, pid: int, qty: float, value: float, date: str) -> dict:
    return {"Company": company, "ProductKey": str(pid), "ProductCompanyKey": f"{company}|{pid}", "LayerDate": date,
            "RemainingQty": qty, "RemainingValue": value}


def _build_with_layers(lines, dim, inventory, layers, as_of="2026-09-29"):
    sales = pd.DataFrame(lines)
    cost = pd.Series([1.0] * len(sales), index=sales.index)
    return ProductDashboardBuilder(ProductDashboardConfig.load(CONFIG), as_of).build(
        sales, dim, inventory, line_costs=cost, valuation_layers=pd.DataFrame(layers))


def test_on_hand_is_every_internal_quant_of_the_company_negatives_included() -> None:
    dim = _dim({"id": 1, "name": "A"})
    inv = pd.DataFrame([
        _inv("Tika", 1, 100, 1000), _inv("Tika", 1, 900, 9000, "RawMaterials", "RM"), _inv("Tika", 1, 50, 500, "InTransit", "VS"),
        _inv("Tika", 1, -20, -200, location="SH"),
    ])
    p = _build([_line("Tika", 1, "2026-09-01", 90, 900)], dim, inventory=inv)["Dim_ProductDashboard"].set_index("ProductCompanyKey")
    assert p.loc["Tika|1", "OnHandQty"] == 1030 and p.loc["Tika|1", "OnHandValue"] == 10300   # = Odoo On Hand
    assert p.loc["Tika|1", "StockQty"] == 100                                                  # DOH stock unchanged


def test_stock_age_is_the_age_of_the_receipt_layers_still_in_stock_not_the_first_receipt() -> None:
    # Old product, fresh stock: the quant keeps the 2024 in_date (Odoo keeps the oldest), the open layer is 20 days old.
    dim = _dim({"id": 1, "name": "Old product"}, {"id": 2, "name": "Two layers"}, {"id": 3, "name": "No layer"}, {"id": 4, "name": "Sold out"})
    inv = pd.DataFrame([
        {**_inv("Majaal", 1, 40, 400), "InDate": "2024-05-01"},
        {**_inv("Majaal", 2, 40, 400), "InDate": "2024-05-01"},
        {**_inv("Majaal", 3, 5, 50), "InDate": "2026-08-30"},
        {**_inv("Majaal", 4, 0, 0), "InDate": "2026-01-01"},
    ])
    layers = [_layer("Majaal", 1, 40, 400, "2026-09-09"),
              _layer("Majaal", 2, 30, 330, "2026-09-19"), _layer("Majaal", 2, 10, 70, "2026-05-02"),
              _layer("Majaal", 4, 3, 3, "2025-01-01")]
    p = _build_with_layers([_line("Majaal", 1, "2026-09-01", 1, 1)], dim, inv, layers)["Dim_ProductDashboard"].set_index("ProductKey")
    assert p.loc["1", "StockAgeDays"] == 20 and p.loc["1", "StockAgeBucket"] == "0–30 days" and p.loc["1", "StockAgeSource"] == "layers"
    assert p.loc["2", "StockAgeDays"] == 45 and p.loc["2", "StockAgeOldestDays"] == 150   # (30x10 + 10x150) / 40
    # units and value split across buckets by layer, adding up to On Hand
    assert p.loc["2", "AgeQty_0_30"] == 30 and p.loc["2", "AgeQty_91_180"] == 10
    assert p.loc["2", "AgeValue_0_30"] == 300 and p.loc["2", "AgeValue_91_180"] == 100
    assert p.loc["3", "StockAgeDays"] == 30 and p.loc["3", "StockAgeSource"] == "quant_in_date"   # no open layer: fallback
    assert pd.isna(p.loc["4", "StockAgeDays"]) and p.loc["4", "AgeQty_365_plus"] == 0              # On Hand 0: no aging


def test_aging_bucket_boundaries() -> None:
    b = ProductDashboardBuilder(ProductDashboardConfig.load(CONFIG), "2026-09-29")
    ages = pd.Series([0, 30, 31, 60, 61, 90, 91, 180, 181, 365, 366, None])
    assert b.aging_bucket(ages).tolist() == ["0–30 days", "0–30 days", "31–60 days", "31–60 days", "61–90 days", "61–90 days",
                                             "91–180 days", "91–180 days", "181–365 days", "181–365 days", "365+ days", pd.NA]


def test_shipped_stock_and_frequency_config() -> None:
    raw = ProductDashboardConfig.load(CONFIG).raw
    assert raw["stock"]["isr_target_pct"] == 15 and raw["stock"]["isr_red_pct"] == 25
    assert [b["max_days"] for b in raw["stock"]["aging_buckets"]] == [30, 60, 90, 180, 365, None]
    assert [(b["key"], b["max_gap_days"]) for b in raw["sales_frequency"]["buckets"]] == [
        ("Daily", 2), ("Weekly", 7), ("Monthly", 30), ("Quarterly", 90), ("Rarely", None)]
