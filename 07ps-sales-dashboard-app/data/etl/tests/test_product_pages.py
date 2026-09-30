"""Product pages: master import contract, matching rules, and the pre-aggregated product tables."""

from pathlib import Path

import pandas as pd
import pytest

from sales_pipeline.inventory import InventoryModelBuilder
from sales_pipeline.legacy_transform import Logger, ProductMasterLoader, ProductMasterValidationError
from sales_pipeline.product_dashboard import IntercompanyFlagger, ProductDashboardBuilder, ProductDashboardConfig
from sales_pipeline.product_matching import match_key, normalize_match_name

COLUMNS = ["ProductKey", "Company", "Category", "Brand", "SubBrand", "Family", "ProductName",
           "OdooProductName", "ProductLevel", "SKU", "Size", "IsActive"]
CONFIG = Path(__file__).resolve().parents[1] / "config" / "product_dashboard.json"


def _write(tmp_path: Path, rows: list[dict], columns: list[str] = COLUMNS, sheet: str = "Products") -> Path:
    path = tmp_path / "PRODUCTS.xlsx"
    with pd.ExcelWriter(path) as writer:
        pd.DataFrame([{"x": 1}]).to_excel(writer, sheet_name="Notes", index=False)
        pd.DataFrame(rows, columns=columns).to_excel(writer, sheet_name=sheet, index=False)
    return path


def _row(company: str, odoo: str, **extra) -> dict:
    base = {c: None for c in COLUMNS}
    base.update({"ProductKey": "K|1", "Company": company, "Category": "Cat", "ProductName": odoo.title(),
                 "OdooProductName": odoo, "SKU": "S", "IsActive": 1})
    base.update(extra)
    return base


def _loader() -> ProductMasterLoader:
    return ProductMasterLoader(Logger(enabled=False), export_conflicts=False, base_dir=Path("."))


# ---------------------------------------------------------------- normalization
def test_normalize_match_name_rules() -> None:
    assert normalize_match_name("  [GRVS-010] GROUT  CREMA\t- C02 ") == "GROUT CREMA - C02"
    assert normalize_match_name("Cem Air") == "CEM AIR"
    assert normalize_match_name("Cem Air") != normalize_match_name("Cemair")
    assert normalize_match_name(None) == ""
    assert match_key("TIKA", "Cem Air") == match_key("Tika", " cem  air ")
    assert match_key("Majaal", "Cemair") != match_key("Tika", "Cemair")


# ---------------------------------------------------------------- import contract
def test_import_reads_products_sheet_and_summarises(tmp_path: Path) -> None:
    path = _write(tmp_path, [_row("Majaal", "Cemair"), _row("Tika", "Cem Air", Category=None, ProductName=None, SKU=None)])
    df = _loader().load(path)
    summary = ProductMasterLoader.summary(df)
    assert summary["rows"] == 2
    assert summary["rows_per_company"] == {"Majaal": 1, "Tika": 1}
    assert summary["blank_category"] == 1 and summary["blank_product_name"] == 1 and summary["blank_sku"] == 1
    assert df["ProductKey"].is_unique  # shared sheet key K|1 gets a deterministic per-product suffix
    assert set(df["ProductMatchKey"]) == {"MAJAAL|CEMAIR", "TIKA|CEM AIR"}
    assert df.loc[df["Company"].eq("Tika"), "ProductName"].iloc[0] == "Cem Air"  # blank name -> Odoo name, not dropped


def test_import_rejects_duplicate_company_and_normalized_name(tmp_path: Path) -> None:
    path = _write(tmp_path, [_row("Majaal", "GROUT CREMA - C02"), _row("Majaal", "[GRVS-010] GROUT CREMA - C02"),
                             _row("Tika", "GROUT CREMA - C02")])
    with pytest.raises(ProductMasterValidationError) as exc:
        _loader().load(path)
    assert "duplicate Company + OdooProductName MAJAAL|GROUT CREMA - C02" in str(exc.value)
    assert "row 2" in str(exc.value) and "row 3" in str(exc.value)
    assert "row 4" not in str(exc.value)  # same name in the other company is fine


def test_import_rejects_missing_required_column(tmp_path: Path) -> None:
    columns = [c for c in COLUMNS if c != "SKU"]
    path = _write(tmp_path, [{c: v for c, v in _row("Majaal", "A").items() if c != "SKU"}], columns=columns)
    with pytest.raises(ProductMasterValidationError, match="missing required column"):
        _loader().load(path)


def test_import_rejects_unknown_company_and_blank_name(tmp_path: Path) -> None:
    path = _write(tmp_path, [_row("NewCo", "A"), _row("Tika", "")])
    with pytest.raises(ProductMasterValidationError) as exc:
        _loader().load(path)
    assert "not Majaal or Tika" in str(exc.value) and "OdooProductName is blank" in str(exc.value)


def test_product_keys_are_deterministic_across_reimports(tmp_path: Path) -> None:
    rows = [_row("Majaal", "A"), _row("Majaal", "B")]
    first = _loader().load(_write(tmp_path, rows)).set_index("ProductMatchKey")["ProductKey"]
    second = _loader().load(_write(tmp_path, list(reversed(rows)) + [_row("Tika", "C")])).set_index("ProductMatchKey")["ProductKey"]
    assert first.to_dict() == second.loc[first.index].to_dict()


# ---------------------------------------------------------------- intercompany flag
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


# ---------------------------------------------------------------- product tables
def _dim(*rows: dict) -> pd.DataFrame:
    base = []
    for r in rows:
        base.append({"ProductSource": "Input Master", "ProductKey": r["key"], "SheetProductKey": r["key"],
                     "ProductMatchKey": match_key(r["company"], r.get("odoo", r["name"])), "Company": r["company"],
                     "ProductName": r["name"], "OdooProductName": r.get("odoo", r["name"]), "Category": r.get("category", "Cat"),
                     "Brand": None, "SubBrand": None, "Family": None, "Size": None, "SKU": None, "ProductLevel": "SKU",
                     "IsActive": r.get("active", 1)})
    return pd.DataFrame(base)


def _line(company: str, name: str, date: str, qty: float, value: float, mapped: bool = True, uom: str = "UNIT") -> dict:
    return {"company_final": company, "CompanyKey": 1 if company == "Majaal" else 2, "ProductMatchKey": match_key(company, name),
            "ProductKey": "k", "OdooProductName": name, "order_date_date": date, "DateKey": int(date.replace("-", "")),
            "SalespersonKey": 1, "SegmentKey": 1, "ChannelKey": 1, "SalesTeamKey": "T", "IsIntercompany": False,
            "IsMappedProduct": mapped, "uom": uom, "untaxed_total": value, "quantity": qty}


def _build(lines: list[dict], dim: pd.DataFrame, inventory: pd.DataFrame | None = None, costs=None, as_of="2026-09-29"):
    sales = pd.DataFrame(lines)
    cost = pd.Series(costs if costs is not None else [1.0] * len(sales), index=sales.index)
    inv = inventory if inventory is not None else pd.DataFrame(columns=["ProductMatchKey", "Company", "OdooProductName", "OnHandQty", "InventoryValue", "StockClass", "LocationName", "ProductName"])
    return ProductDashboardBuilder(ProductDashboardConfig.load(CONFIG), as_of).build(sales, dim, inv, line_costs=cost)


def test_daily_table_preserves_totals_and_keeps_unmapped() -> None:
    dim = _dim({"key": "A", "company": "Majaal", "name": "A"})
    lines = [_line("Majaal", "A", "2026-09-01", 2, 20), _line("Majaal", "A", "2026-09-01", 3, 30),
             _line("Tika", "Mystery", "2026-09-02", 1, 5, mapped=False)]
    out = _build(lines, dim)
    daily = out["Fact_ProductSalesDaily"]
    assert daily["Value"].sum() == 55 and daily["Qty"].sum() == 6 and daily["Lines"].sum() == 3
    assert out["ProductDashboard_Meta"]["UnmappedValue"].iloc[0] == 5
    unmapped = out["QA_ProductUnmapped"]
    assert unmapped.loc[unmapped["Source"].eq("Sales"), "OdooProductName"].tolist() == ["Mystery"]


def test_zero_sales_product_is_listed_with_zeros() -> None:
    dim = _dim({"key": "A", "company": "Majaal", "name": "A"}, {"key": "B", "company": "Majaal", "name": "B"})
    products = _build([_line("Majaal", "A", "2026-09-01", 1, 10)], dim)["Dim_ProductDashboard"].set_index("ProductMatchKey")
    assert "MAJAAL|B" in products.index
    assert products.loc["MAJAAL|B", "ValueYTD"] == 0 and products.loc["MAJAAL|B", "QtyYTD"] == 0


def test_stock_rules_finished_goods_negative_and_no_movement() -> None:
    dim = _dim({"key": "A", "company": "Tika", "name": "A"}, {"key": "B", "company": "Tika", "name": "B"})
    inv = pd.DataFrame([
        {"ProductMatchKey": "TIKA|A", "Company": "Tika", "OdooProductName": "A", "ProductName": "A", "LocationName": "WH", "OnHandQty": 100, "InventoryValue": 1000, "StockClass": "FinishedGoods"},
        {"ProductMatchKey": "TIKA|A", "Company": "Tika", "OdooProductName": "A", "ProductName": "A", "LocationName": "RM", "OnHandQty": 900, "InventoryValue": 9000, "StockClass": "RawMaterials"},
        {"ProductMatchKey": "TIKA|A", "Company": "Tika", "OdooProductName": "A", "ProductName": "A", "LocationName": "VS", "OnHandQty": 50, "InventoryValue": 500, "StockClass": "InTransit"},
        {"ProductMatchKey": "TIKA|A", "Company": "Tika", "OdooProductName": "A", "ProductName": "A", "LocationName": "SH", "OnHandQty": -20, "InventoryValue": -200, "StockClass": "FinishedGoods"},
        {"ProductMatchKey": "TIKA|B", "Company": "Tika", "OdooProductName": "B", "ProductName": "B", "LocationName": "WH", "OnHandQty": 10, "InventoryValue": 10, "StockClass": "FinishedGoods"},
    ])
    # A sells 90 in the last 90 days -> 1/day -> DOH 100 (> Tika overstock 60)
    out = _build([_line("Tika", "A", "2026-09-01", 90, 900)], dim, inventory=inv)
    p = out["Dim_ProductDashboard"].set_index("ProductMatchKey")
    assert p.loc["TIKA|A", "StockQty"] == 100          # raw materials excluded, negative counted as 0
    assert p.loc["TIKA|A", "InTransitQty"] == 50       # shown separately, not on hand
    assert p.loc["TIKA|A", "DaysOfInventory"] == 100
    assert p.loc["TIKA|A", "StockBand"] == "Overstock"
    assert p.loc["TIKA|B", "StockBand"] == "NoMovement"  # stock, no sales in 90 days -> never stock-out risk
    dq = out["QA_ProductDataQuality"]
    assert dq.loc[dq["Check"].eq("NegativeStock"), "ProductMatchKey"].tolist() == ["TIKA|A"]


def test_lifecycle_rule() -> None:
    dim = _dim(
        {"key": "N", "company": "Majaal", "name": "New"},
        {"key": "G", "company": "Majaal", "name": "Grow"},
        {"key": "D", "company": "Majaal", "name": "Decl"},
        {"key": "M", "company": "Majaal", "name": "Mat"},
        {"key": "X", "company": "Majaal", "name": "Inactive", "active": 0},
        {"key": "O", "company": "Majaal", "name": "Old"},
        {"key": "Z", "company": "Majaal", "name": "Never"},
        {"key": "Y", "company": "Majaal", "name": "NeverInactive", "active": 0},
    )
    lines = [
        _line("Majaal", "New", "2026-08-01", 10, 10),
        _line("Majaal", "Grow", "2025-01-01", 1, 1), _line("Majaal", "Grow", "2026-06-01", 10, 10), _line("Majaal", "Grow", "2026-09-01", 13, 13),
        _line("Majaal", "Decl", "2025-01-01", 1, 1), _line("Majaal", "Decl", "2026-06-01", 10, 10), _line("Majaal", "Decl", "2026-09-01", 7, 7),
        _line("Majaal", "Mat", "2025-01-01", 1, 1), _line("Majaal", "Mat", "2026-06-01", 10, 10), _line("Majaal", "Mat", "2026-09-01", 11, 11),
        _line("Majaal", "Inactive", "2026-09-01", 5, 5),
        _line("Majaal", "Old", "2025-06-01", 5, 5),
    ]
    p = _build(lines, dim)["Dim_ProductDashboard"].set_index("ProductKey")
    assert p.loc[["N", "G", "D", "M", "X", "O", "Z", "Y"], "LifecycleSegment"].tolist() == [
        "New", "Growing", "Declining", "Mature", "Discontinued", "Discontinued", "Never sold", "Never sold"]


def test_bcg_zero_cost_is_unclassified_and_logged() -> None:
    dim = _dim({"key": "A", "company": "Tika", "name": "A"}, {"key": "B", "company": "Tika", "name": "B"})
    lines = [_line("Tika", "A", "2026-03-01", 30000, 300000), _line("Tika", "B", "2026-03-01", 10, 100)]
    out = _build(lines, dim, costs=[5.0, 0.0])
    p = out["Dim_ProductDashboard"].set_index("ProductKey")
    assert p.loc["A", "BcgClassYTD"] == "Stars"          # HV (>= 25,000 for Tika) and GP 50% >= 35%
    assert p.loc["B", "BcgClassYTD"] == "Unclassified (no cost)"
    assert out["QA_ProductDataQuality"].query("Check == 'NoCost'")["ProductMatchKey"].tolist() == ["TIKA|B"]


def test_location_classification_from_config() -> None:
    cfg = ProductDashboardConfig.load(CONFIG).section("stock_locations")
    classes = InventoryModelBuilder.classify_locations(pd.Series(["Majaal", "RM Warehouse", " vessel ", "Tobruk"]), cfg)
    assert classes.tolist() == ["FinishedGoods", "RawMaterials", "InTransit", "FinishedGoods"]


# ---------------------------------------------------------------- BMH view: same product in both companies
def _shared_case():
    # Majaal "Cemair" and Tika "Cem Air" are one product (ProductName "Cemair" in both sheet rows).
    dim = _dim(
        {"key": "M", "company": "Majaal", "name": "Cemair"},
        {"key": "T", "company": "Tika", "name": "Cemair", "odoo": "Cem Air"},
        {"key": "O", "company": "Majaal", "name": "Other"},
    )
    lines = [
        _line("Majaal", "Cemair", "2026-03-01", 100, 300),
        _line("Tika", "Cem Air", "2026-09-01", 90, 700),
        _line("Majaal", "Other", "2026-09-01", 1, 5),
        _line("Tika", "Mystery", "2026-09-02", 1, 5, mapped=False),
    ]
    inv = pd.DataFrame([
        {"ProductMatchKey": "MAJAAL|CEMAIR", "Company": "Majaal", "OdooProductName": "Cemair", "ProductName": "Cemair", "LocationName": "WH", "OnHandQty": 60, "InventoryValue": 60, "StockClass": "FinishedGoods"},
        {"ProductMatchKey": "TIKA|CEM AIR", "Company": "Tika", "OdooProductName": "Cem Air", "ProductName": "Cemair", "LocationName": "WH", "OnHandQty": 120, "InventoryValue": 240, "StockClass": "FinishedGoods"},
    ])
    # standard cost per unit: Majaal Cemair 1, Tika Cem Air 2, Other 1, Mystery 1
    return _build(lines, dim, inventory=inv, costs=[1.0, 2.0, 1.0, 1.0])


def test_shared_product_bmh_total_equals_sum_of_companies() -> None:
    out = _shared_case()
    p = out["Dim_ProductDashboard"].set_index("ProductMatchKey")
    g = out["Dim_ProductDashboardGroup"].set_index("ProductGroupKey")
    # matching stays per company
    assert p.loc["MAJAAL|CEMAIR", "ValueYTD"] == 300 and p.loc["TIKA|CEM AIR", "ValueYTD"] == 700
    assert p.loc["MAJAAL|CEMAIR", "ProductGroupKey"] == p.loc["TIKA|CEM AIR", "ProductGroupKey"] == "G|CEMAIR"
    row = g.loc["G|CEMAIR"]
    assert row["Companies"] == "Majaal + Tika" and row["CompanyCount"] == 2
    assert row["ValueYTD"] == p.loc["MAJAAL|CEMAIR", "ValueYTD"] + p.loc["TIKA|CEM AIR", "ValueYTD"] == 1000
    assert row["QtyYTD"] == p.loc["MAJAAL|CEMAIR", "QtyYTD"] + p.loc["TIKA|CEM AIR", "QtyYTD"] == 190
    assert row["StockQty"] == 180 and row["StockValue"] == 300
    # a single-company product is its own group, unchanged; Unmapped is never grouped
    assert g.loc["G|OTHER", "ValueYTD"] == 5 and g.loc["G|OTHER", "Companies"] == "Majaal"
    assert "TIKA|MYSTERY" in g.index and g.loc["TIKA|MYSTERY", "IsMapped"] == False  # noqa: E712


def test_grouping_does_not_change_grand_totals() -> None:
    out = _shared_case()
    p, g = out["Dim_ProductDashboard"], out["Dim_ProductDashboardGroup"]
    for col in ["ValueYTD", "QtyYTD", "ValueLYTD", "QtyLYTD", "StockQty", "StockValue"]:
        assert g[col].sum() == pytest.approx(p[col].sum()), col
    assert g["ValueYTD"].sum() == pytest.approx(out["Fact_ProductSalesDaily"]["Value"].sum()) == 1010


def test_shared_product_non_additive_metrics_are_recomputed_not_averaged() -> None:
    out = _shared_case()
    p = out["Dim_ProductDashboard"].set_index("ProductMatchKey")
    row = out["Dim_ProductDashboardGroup"].set_index("ProductGroupKey").loc["G|CEMAIR"]
    # Days of inventory = combined stock / combined daily sales: 180 / (90 sold in the last 90 days / 90) = 180
    assert row["AvgDailySales"] == pytest.approx(1.0)
    assert row["DaysOfInventory"] == pytest.approx(180.0)
    assert pd.isna(p.loc["MAJAAL|CEMAIR", "DaysOfInventory"]) and p.loc["TIKA|CEM AIR", "DaysOfInventory"] == pytest.approx(120.0)
    # Margin = combined (value - cost) / combined value = (1000 - 100 - 180) / 1000 = 72 % (the average would be 70.48 %)
    assert row["GrossProfitPctYTD"] == pytest.approx(72.0)
    assert p.loc["MAJAAL|CEMAIR", "GrossProfitPctYTD"] == pytest.approx(200 / 3)
    assert p.loc["TIKA|CEM AIR", "GrossProfitPctYTD"] == pytest.approx(520 / 7)
    # BCG on combined figures with the lead company's (Tika, larger YTD value) thresholds: 190 < 25,000 -> LV; 72 % -> HP
    assert row["ThresholdCompany"] == "Tika"
    assert row["BcgClassYTD"] == "Strategic"
    # Lifecycle on combined lines: 90 sold in the last 90 days, none in the previous 90 -> Growing
    assert row["LifecycleSegment"] == "Growing"
    # Tika's overstock threshold (60 days) applies to the combined DOH of 180
    assert row["StockBand"] == "Overstock"


def test_import_warns_on_shared_name_attribute_conflicts_and_near_duplicates(tmp_path: Path) -> None:
    path = _write(tmp_path, [
        _row("Majaal", "Cemair", ProductName="Cemair", Category="SURFACES"),
        _row("Tika", "Cem Air", ProductName="Cemair", Category="Adhesives"),
        _row("Majaal", "Cross Spacer 5mm", ProductName="Cross Spacer 5mm (500PCS/BAG)"),
        _row("Tika", "Cross Spacer 5 mm", ProductName="Cross Spacer 5 mm (500PCS/BAG)"),
    ])
    df = _loader().load(path)  # warnings never reject the file
    warnings = ProductMasterLoader.summary(df)["warnings"]
    assert any("'Cemair' has different Category" in w and "row 2 Majaal" in w and "row 3 Tika" in w for w in warnings)
    assert any("Probably the same product" in w and "Cross Spacer 5mm" in w and "Cross Spacer 5 mm" in w for w in warnings)
    assert len(warnings) == 2


def test_product_ratio_columns_are_stored_as_decimal_not_float() -> None:
    """MySQL FLOAT keeps ~7 significant digits: DaysOfInventory 12857.142857 came back as 12857.1 and failed the
    SQL/DataFrame mirror validation of Dim_ProductDashboard / Dim_ProductDashboardGroup in production."""
    from sqlalchemy.dialects import mysql

    from sales_pipeline.export.database_exporter import DatabaseExporter

    for name in ["AvgDailySales", "DaysOfInventory"]:
        dtype = DatabaseExporter._mysql_dtype_for_column(name, pd.Series([12857.142857, 1.077778]))
        assert isinstance(dtype, mysql.DECIMAL), name


def test_meta_built_at_has_whole_seconds() -> None:
    """MySQL DATETIME rounds fractional seconds; a .5s+ value read back one second later and failed the
    SQL/DataFrame mirror validation of ProductDashboard_Meta in production (run 218)."""
    built = _shared_case()["ProductDashboard_Meta"]["BuiltAtUtc"].iloc[0]
    assert built == built.floor("s")
