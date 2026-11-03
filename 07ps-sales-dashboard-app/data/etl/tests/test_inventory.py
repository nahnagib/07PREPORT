from pathlib import Path

import pandas as pd

from sales_pipeline import odoo_products
from sales_pipeline.inventory import (
    FACT_INVENTORY_COLUMNS,
    InventoryModelBuilder,
    QA_INVENTORY_COLUMNS,
)
from sales_pipeline.legacy_transform import WorkbookExporter


def _inventory_inputs() -> dict[str, pd.DataFrame]:
    stock_quants = pd.DataFrame(
        [
            {
                "product_id_id": 10,
                "product_id": "Official Odoo",
                "company_id": "Majaal",
                "company_id_id": 1,
                "location_id_id": 1,
                "quantity": 10,
                "reserved_quantity": 2,
                "value": 123.45,
            },
            {
                "product_id_id": 10,
                "product_id": "Official Odoo",
                "company_id": "Majaal",
                "company_id_id": 1,
                "location_id_id": 1,
                "quantity": 0,
                "reserved_quantity": 3,
                "value": 0,
            },
            {
                "product_id_id": 20,
                "product_id": "Inventory Only Product",
                "company_id": "NewCo",
                "company_id_id": 2,
                "location_id_id": 1,
                "quantity": 5,
                "reserved_quantity": 1,
                "value": 77,
            },
            {
                "product_id_id": 30,
                "product_id": "Customer Stock",
                "company_id": "Majaal",
                "company_id_id": 1,
                "location_id_id": 2,
                "quantity": 99,
                "reserved_quantity": 0,
                "value": 99,
            },
            {
                "product_id_id": 40,
                "product_id": "Transit Stock",
                "company_id": "Majaal",
                "company_id_id": 1,
                "location_id_id": 3,
                "quantity": 99,
                "reserved_quantity": 0,
                "value": 99,
            },
            {
                "product_id_id": 50,
                "product_id": "Scrap Stock",
                "company_id": "Majaal",
                "company_id_id": 1,
                "location_id_id": 4,
                "quantity": 99,
                "reserved_quantity": 0,
                "value": 99,
            },
        ]
    )
    locations = pd.DataFrame(
        [
            {"id": 1, "name": "Stock", "complete_name": "WH/Stock", "usage": "internal", "scrap_location": False, "active": True},
            {"id": 2, "name": "Customers", "complete_name": "Partners/Customers", "usage": "customer", "scrap_location": False, "active": True},
            {"id": 3, "name": "Transit", "complete_name": "Transit", "usage": "transit", "scrap_location": False, "active": True},
            {"id": 4, "name": "Scrap", "complete_name": "WH/Scrap", "usage": "internal", "scrap_location": True, "active": True},
        ]
    )
    product_raw = pd.DataFrame(
        [
            {"id": 10, "display_name": "Official Odoo", "default_code": "SKU-10", "standard_price": 4.0, "company_id": "Majaal"},
            {"id": 20, "display_name": "Inventory Only Product", "default_code": "SKU-20", "standard_price": pd.NA, "company_id": "NewCo"},
        ]
    )
    # Dim_Product = the Odoo catalog by id (product 20 is in it too: every product.product is)
    dim_product = odoo_products.dim_product(odoo_products.catalog(pd.DataFrame([
        {"id": 10, "name": "Official Product", "display_name": "Official Odoo", "default_code": "SKU-10", "active": True},
        {"id": 20, "name": "Inventory Only Product", "display_name": "Inventory Only Product", "default_code": False, "active": True},
    ])))
    dim_company = pd.DataFrame([{"CompanyKey": 1, "Company": "Majaal"}])
    return {
        "stock_quants": stock_quants,
        "locations": locations,
        "product_raw": product_raw,
        "dim_product": dim_product,
        "dim_company": dim_company,
    }


def test_inventory_builder_filters_internal_locations_and_calculates_values() -> None:
    inputs = _inventory_inputs()

    result = InventoryModelBuilder().build(
        stock_quants=inputs["stock_quants"],
        locations=inputs["locations"],
        product_raw=inputs["product_raw"],
        dim_product=inputs["dim_product"],
        dim_company=inputs["dim_company"],
        snapshot_date="2026-06-22",
    )
    fact = result.fact_inventory

    assert fact.columns.tolist() == FACT_INVENTORY_COLUMNS
    assert set(fact["LocationID"].astype(int)) == {1}
    assert len(fact) == 3
    assert (fact["AvailableQty"] == fact["OnHandQty"] - fact["ReservedQty"]).all()
    official = fact[fact["OdooProductID"].eq(10) & fact["OnHandQty"].eq(10)].iloc[0]
    assert official["ProductKey"] == "10"                     # the Odoo product id, never a name key
    assert official["ProductName"] == "Official Product"      # product.product.name as stored
    assert official["ProductCompanyKey"] == "Majaal|10"
    assert official["ProductCost"] == 4.0
    assert official["InventoryValue"] == 123.45
    reserved_only = fact[fact["ReservedQty"].eq(3)].iloc[0]
    assert reserved_only["InventoryStatus"] == "Reserved Only"
    assert "DOH_Category" not in fact.columns
    assert "Stock_Category" not in fact.columns


def test_inventory_builder_keys_every_quant_by_its_odoo_product_and_adds_missing_companies() -> None:
    inputs = _inventory_inputs()

    result = InventoryModelBuilder().build(
        stock_quants=inputs["stock_quants"],
        locations=inputs["locations"],
        product_raw=inputs["product_raw"],
        dim_product=inputs["dim_product"],
        dim_company=inputs["dim_company"],
        snapshot_date="2026-06-22",
    )

    assert len(result.dim_product) == len(inputs["dim_product"])  # no placeholder products: every quant has its Odoo product
    other = result.fact_inventory[result.fact_inventory["OdooProductID"].eq(20)].iloc[0]
    assert other["ProductKey"] == "20" and other["ProductName"] == "Inventory Only Product" and pd.isna(other["SKU"])
    assert "NewCo" in set(result.dim_company["Company"])
    assert result.fact_inventory["ProductKey"].notna().all()
    assert result.qa_data_quality.columns.tolist() == QA_INVENTORY_COLUMNS
    checks = result.qa_data_quality.set_index("CheckName")
    assert "Placeholder unmapped rows added to Dim_Product from inventory" not in checks.index
    assert checks.loc["Rows with missing product cost", "MetricValue"] == 1


def test_inventory_builder_calculates_ads_doh_and_velocity_class() -> None:
    inputs = _inventory_inputs()
    sales = pd.DataFrame(
        [
            {"company_final": "Majaal", "ProductKey": "10", "order_date_date": "2025-10-01", "quantity": 500},  # outside 90 days
            {"company_final": "Majaal", "ProductKey": "10", "order_date_date": "2026-01-01", "quantity": 20},
            {"company_final": "Majaal", "ProductKey": "10", "order_date_date": "2026-01-10", "quantity": 10},
            {"company_final": "NewCo", "ProductKey": "20", "order_date_date": "2026-01-10", "quantity": 0},
        ]
    )
    summary = InventoryModelBuilder.build_product_sales_summary(sales, lookback_days=90, as_of="2026-01-10")

    result = InventoryModelBuilder().build(
        stock_quants=inputs["stock_quants"],
        locations=inputs["locations"],
        product_raw=inputs["product_raw"],
        dim_product=inputs["dim_product"],
        dim_company=inputs["dim_company"],
        snapshot_date="2026-06-22",
        product_sales_summary=summary,
    )

    fact = result.fact_inventory
    official = fact[fact["OdooProductID"].eq(10) & fact["OnHandQty"].eq(10)].iloc[0]
    # 90-day look-back: (20 + 10) / 90 days; the October sale is outside the window.
    assert official["Avg_Daily_Sales"] == 30 / 90
    assert official["DOH"] == official["OnHandQty"] / official["Avg_Daily_Sales"]
    assert official["Velocity_Class"] == "Low Stock"
    no_sales = fact[fact["OdooProductID"].eq(20)].iloc[0]
    assert no_sales["Avg_Daily_Sales"] == 0.0
    # Stock with no sales is "No Movement" (infinite DOH), never 0 days / stock-out risk.
    assert pd.isna(no_sales["DOH"])
    assert no_sales["Velocity_Class"] == "No Movement"


def test_inventory_workbook_sheets_exist_and_existing_sheets_are_preserved(tmp_path: Path) -> None:
    model_path = tmp_path / "SalesModel_OneOutput.xlsx"
    with pd.ExcelWriter(model_path) as writer:
        pd.DataFrame([{"Keep": "yes"}]).to_excel(writer, sheet_name="ExistingSheet", index=False)

    sheets = {
        "Fact_Inventory": pd.DataFrame([{column: None for column in FACT_INVENTORY_COLUMNS}]),
        "QA_Inventory_DataQuality": pd.DataFrame(
            [{"CheckName": "Total inventory rows", "MetricValue": 1, "Status": "PASS", "Notes": ""}]
        ),
    }
    WorkbookExporter(type("Logger", (), {"ok": lambda self, message: None, "warn": lambda self, message: None})()).export(
        sheets,
        model_path,
    )

    book = pd.ExcelFile(model_path)
    assert "ExistingSheet" in book.sheet_names
    assert "Fact_Inventory" in book.sheet_names
    assert "QA_Inventory_DataQuality" in book.sheet_names
    assert pd.read_excel(book, sheet_name="ExistingSheet").to_dict("records") == [{"Keep": "yes"}]
    assert set(FACT_INVENTORY_COLUMNS).issubset(pd.read_excel(book, sheet_name="Fact_Inventory").columns)
