"""Product dimension, product cost and BCG builders: products are Odoo ids (sales_pipeline.odoo_products), never names."""

from pathlib import Path

import pandas as pd

from sales_pipeline.legacy_transform import (
    BCGMatrixBuilder,
    BlockedCustomersLoader,
    Logger,
    PipelineSettings,
    ProductCostDimensionBuilder,
    ProductCostMatcher,
    ProductDimensionBuilder,
    SegmentDimensionBuilder,
    SalesLinesFactBuilder,
    WorkbookExporter,
)
from sales_pipeline.validation import ModelValidator


def _raw_products() -> pd.DataFrame:
    return pd.DataFrame([
        {"id": 10, "product_tmpl_id": "T", "product_tmpl_id_id": 100, "name": "  Xtreme-SuperCol S1 ", "display_name": "[S1] Xtreme-SuperCol S1",
         "default_code": "S1", "company_id": "Majaal", "company_id_id": 1, "active": True, "categ_id": "All / Adhesives", "categ_id_id": 4,
         "vendor": "Xtreme", "sub_brand_id": False, "product_family_id": False, "size_dimensions_id": False,
         "standard_price": 5.5, "cost_company": "Majaal"},
        {"id": 11, "product_tmpl_id": "U", "product_tmpl_id_id": 101, "name": "متين GERMA-C2TE", "display_name": "متين GERMA-C2TE",
         "default_code": False, "company_id": False, "company_id_id": False, "active": False, "categ_id": "All", "categ_id_id": 1,
         "vendor": None, "sub_brand_id": False, "product_family_id": False, "size_dimensions_id": False,
         "standard_price": 0.0, "cost_company": "Tika"},
    ])


def test_dim_product_is_the_odoo_catalog_by_id_with_names_as_stored() -> None:
    dim = ProductDimensionBuilder().build(_raw_products()).set_index("ProductKey")
    assert dim.index.tolist() == ["10", "11"]
    assert dim.loc["10", "ProductName"] == "  Xtreme-SuperCol S1 "      # never cleaned or re-cased
    assert dim.loc["11", "ProductName"] == "متين GERMA-C2TE"
    assert dim.loc["10", "SKU"] == "S1" and pd.isna(dim.loc["11", "SKU"])
    assert dim.loc["10", "Brand"] == "Xtreme" and dim.loc["11", "Brand"] == "Unassigned"
    assert dim.loc["10", "Category"] == "All / Adhesives"
    assert not {"ProductLevel", "ProductNameClean", "ProductMatchKey", "SheetProductKey", "IsMappedProduct"}.intersection(dim.columns)


def test_sales_lines_carry_only_odoo_product_columns() -> None:
    old = {"ProductNameClean": "X", "product_name_clean": "X", "ProductMatchKey": "M|X", "ProductMappingStatus": "Unmapped",
           "ProductLevel": "SKU", "ProductJoinKey": "J", "IsMappedProduct": False}
    lines = SalesLinesFactBuilder().build(pd.DataFrame([{"order_number": "SO1", "ProductKey": "10", "OdooProductID": 10, "ProductTemplateID": 100,
                                                         "ProductName": "X", "SKU": None, "Category": "Unassigned", "Brand": "Unassigned",
                                                         "is_discount": False, **old}]))
    assert {"ProductKey", "OdooProductID", "ProductTemplateID", "ProductName", "SKU", "Category", "Brand", "is_discount"}.issubset(lines.columns)
    assert not {"ProductNameClean", "product_name_clean", "ProductMatchKey", "ProductMappingStatus", "ProductLevel",
                "ProductJoinKey", "IsMappedProduct"}.intersection(lines.columns)


def test_blocked_customer_dates_are_dayfirst(tmp_path: Path) -> None:
    path = tmp_path / "blocked.xlsx"
    pd.DataFrame([{
        "CustomerID": "C1",
        "CustomerName": "Customer",
        "IsBlocked": "yes",
        "BlockedDate": "08/10/2026",
        "UnblockedDate": "09/10/2026",
        "BlockedReason": "",
        "Notes": "",
    }]).to_excel(path, index=False)

    out = BlockedCustomersLoader(Logger(enabled=False)).load(path)

    assert out.loc[0, "BlockedDate"] == pd.Timestamp("2026-10-08")
    assert out.loc[0, "UnblockedDate"] == pd.Timestamp("2026-10-09")


def _line(key: str, date: str, volume: float, value: float, **extra) -> dict:
    return {"company_final": "Majaal", "ProductKey": key, "ProductName": f"Product {key}", "order_date_date": date,
            "Volume": volume, "Value": value, **extra}


def test_bcg_matrix_aggregates_ytd_and_lytd_at_product_level() -> None:
    sales = pd.DataFrame([
        _line("P1", "2026-01-02", 2000, 4000, product_cost=1),
        _line("P1", "2026-02-02", 2000, 4000, product_cost=1),
        _line("P1", "2025-06-10", 100, 200, product_cost=1),
        _line("P1", "2025-06-11", 9999, 9999, product_cost=1),
    ])

    result = BCGMatrixBuilder.build(sales, as_of_date="2026-06-10")

    assert len(result) == 1
    assert "Period" not in result.columns and "ProductNameClean" not in result.columns
    row = result.iloc[0]
    assert row["total_quantity_YTD"] == 4000
    assert row["avg_unit_price_YTD"] == 2
    assert row["bcg_class_YTD"] == "Stars"
    assert row["total_quantity_LYTD"] == 100
    assert row["bcg_class_LYTD"] == "Strategic"
    assert row["quantity_growth_pct"] == 39
    assert row["gross_profit_change_pp"] == 0
    assert row["bcg_movement"] == "Improved"


def test_bcg_matrix_excludes_segment_columns_and_groups_by_company_product() -> None:
    sales = pd.DataFrame([
        _line("P1", "2026-01-02", 4000, 8000, SegmentKey=10, SalesSegment="B2B", DistributionChannel="Retail", ChannelKey=1, invoice_status="invoiced"),
        _line("P1", "2026-01-02", 100, 200, SegmentKey=20, SalesSegment="B2C", DistributionChannel="Online", ChannelKey=2, invoice_status="to invoice"),
        _line("SKIP", "2026-01-02", 100, 200, SegmentKey=10, SalesSegment="B2B", DistributionChannel="Retail", ChannelKey=1, invoice_status="cancelled"),
    ])

    result = BCGMatrixBuilder.build(sales, as_of_date="2026-06-10")

    assert not {"SegmentKey", "SalesSegment", "DistributionChannel", "ChannelKey"}.intersection(result.columns)
    assert result[["Company", "ProductKey"]].to_dict("records") == [{"Company": "Majaal", "ProductKey": "P1"}]
    assert result["total_quantity_YTD"].sum() == 4100
    assert result["total_value_YTD"].sum() == 8200


def test_bcg_matrix_is_one_row_per_odoo_product_even_when_the_line_names_differ() -> None:
    sales = pd.DataFrame([
        _line("P1", "2026-01-02", 100, 200, ProductName="One", invoice_status="invoiced"),
        _line("P1", "2026-02-02", 200, 400, ProductName="One (renamed in Odoo)", invoice_status="upselling"),
        _line("P2", "2026-02-02", 1, 1, ProductName="One", invoice_status="invoiced"),  # same name, another product: never merged
    ])
    result = BCGMatrixBuilder.build(sales, as_of_date="2026-06-10")
    assert not result.duplicated(["Company", "ProductKey"]).any()
    assert result.set_index("ProductKey").loc["P1", "total_quantity_YTD"] == 300
    assert len(result) == 2


def test_bcg_matrix_never_drops_a_line_without_a_name() -> None:
    sales = pd.DataFrame([_line("P1", "2026-01-02", 10, 20, ProductName=None)])
    result = BCGMatrixBuilder.build(sales, as_of_date="2026-06-10")
    assert result["total_value_YTD"].sum() == 20 and result.iloc[0]["ProductName"] == "P1"


def test_bcg_matrix_validation_does_not_create_dim_segment_relationship() -> None:
    issues = ModelValidator.validate(
        {
            "Fact_BCGMatrix": pd.DataFrame([{"Company": "Majaal", "ProductKey": "P1"}]),
            "Dim_Product": pd.DataFrame([{"ProductKey": "P1"}]),
            "Dim_Company": pd.DataFrame([{"CompanyKey": 1, "Company": "Majaal"}]),
            "Dim_Segment": pd.DataFrame([{"SegmentKey": 99, "Segment": "B2B"}]),
        }
    )
    assert [issue for issue in issues if issue.table == "Fact_BCGMatrix" and issue.check == "referential_integrity"] == []


def test_bcg_matrix_product_grain_preserves_ytd_and_lytd_totals() -> None:
    sales = pd.DataFrame([
        _line("P1", "2026-01-02", 10, 100, SegmentKey=10, SalesSegment="B2B", invoice_status="invoiced"),
        _line("P2", "2026-03-02", 20, 200, SegmentKey=20, SalesSegment="B2C", invoice_status="to invoice"),
        _line("P1", "2025-01-02", 30, 300, SegmentKey=10, SalesSegment="B2B", invoice_status="upselling"),
        _line("P2", "2025-02-02", 40, 400, SegmentKey=20, SalesSegment="B2C", invoice_status="no"),
    ])

    result = BCGMatrixBuilder.build(sales, as_of_date="2026-06-10")
    summary = BCGMatrixBuilder.quality_summary(sales, result, as_of_date="2026-06-10")

    assert result["total_value_YTD"].sum() == 300
    assert result["total_value_LYTD"].sum() == 300
    assert not result.duplicated(["Company", "ProductKey"]).any()
    assert summary["bcg_ytd_value"] == summary["fact_sales_valid_invoice_ytd_value"]
    assert summary["duplicate_company_product_count"] == 0
    assert summary["segment_columns_removed"] is True
    assert summary["ytd_lytd_columns_exist"] is True


def test_segment_dimension_contains_only_business_segments_and_normalizes_blanks() -> None:
    dim = SegmentDimensionBuilder(PipelineSettings()).build(pd.DataFrame(), pd.DataFrame())

    assert dim["Segment"].tolist() == ["B2B", "B2C", "Backoffice", "Inter Company", "Unknown"]
    assert 0 not in dim["SegmentKey"].tolist()
    assert "All" not in dim["Segment"].tolist()
    assert SegmentDimensionBuilder.normalize_segment(None) == "Unknown"
    assert SegmentDimensionBuilder.normalize_segment(" ") == "Unknown"
    assert SegmentDimensionBuilder.normalize_segment("back office") == "Backoffice"


def test_bcg_matrix_marks_new_lost_and_null_zero_lytd_growth() -> None:
    sales = pd.DataFrame([
        _line("NEW", "2026-01-02", 10, 20),
        _line("LOST", "2025-01-02", 10, 20),
        _line("ZERO", "2026-01-02", 10, 20),
        _line("ZERO", "2025-01-02", 0, 0),
    ])

    result = BCGMatrixBuilder.build(sales, as_of_date="2026-06-10").set_index("ProductKey")

    assert result.loc["NEW", "bcg_movement"] == "New"
    assert result.loc["LOST", "bcg_movement"] == "Lost"
    assert pd.isna(result.loc["NEW", "quantity_growth_pct"])
    assert pd.isna(result.loc["ZERO", "quantity_growth_pct"])


def test_product_cost_is_matched_by_odoo_id_and_company_never_by_sku_or_name() -> None:
    costs = pd.DataFrame([
        {"OdooProductID": 10, "Company": "Majaal", "ProductName": "ID Product", "SKU": "ID-SKU", "ProductCost": 6},
        {"OdooProductID": 10, "Company": "TIKA", "ProductName": "ID Product", "SKU": "ID-SKU", "ProductCost": 9},
        {"OdooProductID": 20, "Company": "Majaal", "ProductName": "SKU Product", "SKU": "SKU-20", "ProductCost": 4},
    ])
    sales = pd.DataFrame([
        _line("10", "2026-01-01", 10, 100, OdooProductID=10),
        _line("10", "2026-01-01", 10, 100, OdooProductID=10, company_final="Tika"),
        _line("20", "2026-01-01", 10, 100, OdooProductID=20, company_final="Athena"),      # no Athena cost row: any company's
        _line("30", "2026-01-01", 10, 100, OdooProductID=30, SKU="SKU-20", ProductName="SKU Product"),  # same SKU / name: no match
    ])

    attached = ProductCostMatcher.attach(sales, costs)
    assert attached["product_cost"].tolist()[:3] == [6, 9, 4]
    assert pd.isna(attached["product_cost"].iloc[3])
    assert attached["ProductCostMatchKey"].tolist()[:3] == ["ID_COMPANY:10|Majaal", "ID_COMPANY:10|Tika", "ID:20"]

    bcg = BCGMatrixBuilder.build(sales.iloc[[0, 3]], costs, as_of_date="2026-06-10").set_index("ProductKey")
    assert bcg.loc["10", "perc_gross_profit_YTD"] == 0.4
    assert bcg.loc["30", "profit_class_YTD"] == "Unknown"
    assert bcg.loc["30", "bcg_class_YTD"] == "Unclassified"
    qa = ProductCostMatcher.missing_cost_qa(sales, costs, as_of_date="2026-06-10")
    assert qa["ProductKey"].tolist() == ["30"]


def test_product_cost_dimension_and_exact_bcg_columns() -> None:
    dim = ProductCostDimensionBuilder().build(_raw_products().iloc[[0]])
    assert dim.to_dict("records") == [{
        "OdooProductID": 10,
        "OdooProductTemplateID": 100,
        "Company": "Majaal",
        "ProductKey": "10",
        "ProductName": "  Xtreme-SuperCol S1 ",
        "OdooProductName": "[S1] Xtreme-SuperCol S1",
        "SKU": "S1",
        "ProductCost": 5.5,
        "IsActive": True,
    }]
    assert BCGMatrixBuilder.build(pd.DataFrame()).columns.tolist() == BCGMatrixBuilder.COLUMNS


def test_workbook_exporter_datetime_serial_preserves_local_clock_time() -> None:
    assert WorkbookExporter._excel_cell_value(pd.Timestamp("2026-06-16 13:09:37")) == (
        pd.Timestamp("2026-06-16 13:09:37") - WorkbookExporter.EXCEL_EPOCH
    ) / pd.Timedelta(days=1)


def test_workbook_exporter_datetime_detector_handles_string_dtype() -> None:
    assert WorkbookExporter._is_datetime_series(pd.Series(["B2B", "B2C"], dtype="string")) is False
