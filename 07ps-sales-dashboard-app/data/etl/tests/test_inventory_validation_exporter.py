from pathlib import Path

import pandas as pd

from sales_pipeline.export.inventory_validation_exporter import (
    FLAG_COLUMNS,
    InventoryValidationExporter,
)


def _fact_inventory() -> pd.DataFrame:
    return pd.DataFrame(
        [
            {"ProductKey": "P1", "WarehouseName": "RM Warehouse", "OnHandQty": 10, "ProductCost": 5.0, "InventoryValue": 50.0},
            {"ProductKey": "P2", "WarehouseName": "Vessel", "OnHandQty": 3, "ProductCost": 2.0, "InventoryValue": 6.0},
            {"ProductKey": "P3", "WarehouseName": "Majaal", "OnHandQty": -4, "ProductCost": 1.0, "InventoryValue": -4.0},
            {"ProductKey": "P4", "WarehouseName": "Majaal", "OnHandQty": 8, "ProductCost": 0.0, "InventoryValue": 0.0},
            {"ProductKey": "P5", "WarehouseName": "Majaal", "OnHandQty": 6, "ProductCost": None, "InventoryValue": 0.0},
            {"ProductKey": "P_MISSING", "WarehouseName": "Majaal", "OnHandQty": 2, "ProductCost": 4.0, "InventoryValue": 8.0},
            {"ProductKey": "P6", "WarehouseName": "Majaal", "OnHandQty": 7, "ProductCost": 3.0, "InventoryValue": 21.0},
        ]
    )


def _dim_product() -> pd.DataFrame:
    return pd.DataFrame(
        [
            {"ProductKey": "P1", "ProductMappingStatus": "OfficialProductMaster"},
            {"ProductKey": "P2", "ProductMappingStatus": "OfficialProductMaster"},
            {"ProductKey": "P3", "ProductMappingStatus": "OfficialProductMaster"},
            {"ProductKey": "P4", "ProductMappingStatus": "OfficialProductMaster"},
            {"ProductKey": "P5", "ProductMappingStatus": "OfficialProductMaster"},
            {"ProductKey": "P6", "ProductMappingStatus": "RawFromOdoo"},
        ]
    )


def test_build_validation_frame_flags_each_condition():
    frame = InventoryValidationExporter.build_validation_frame(_fact_inventory(), _dim_product())

    assert len(frame) == len(_fact_inventory())
    by_key = frame.set_index("ProductKey")

    assert bool(by_key.loc["P1", "Flag_RM_Warehouse"])
    assert not bool(by_key.loc["P1", "Flag_Not_Official_Master"])

    assert bool(by_key.loc["P2", "Flag_Vessel_InTransit"])

    assert bool(by_key.loc["P3", "Flag_Negative_Stock"])

    assert bool(by_key.loc["P4", "Flag_Missing_Cost"])
    assert bool(by_key.loc["P5", "Flag_Missing_Cost"])

    assert bool(by_key.loc["P_MISSING", "Flag_No_DimProduct_Match"])
    assert bool(by_key.loc["P_MISSING", "Flag_Not_Official_Master"])

    assert bool(by_key.loc["P6", "Flag_Not_Official_Master"])

    # A row with no matching flags should not need review.
    clean_row = by_key.loc["P1"]
    # P1 is RM Warehouse so it does need review; verify a genuinely clean row instead.
    clean_fact = pd.DataFrame(
        [{"ProductKey": "CLEAN", "WarehouseName": "Majaal", "OnHandQty": 5, "ProductCost": 9.0, "InventoryValue": 45.0}]
    )
    clean_dim = pd.DataFrame([{"ProductKey": "CLEAN", "ProductMappingStatus": "OfficialProductMaster"}])
    clean_frame = InventoryValidationExporter.build_validation_frame(clean_fact, clean_dim)
    assert not bool(clean_frame.loc[0, "Needs_Review"])

    for flag in FLAG_COLUMNS:
        assert frame[flag].dtype == bool

    assert bool(by_key.loc["P3", "Needs_Review"])
    assert bool(by_key.loc["P_MISSING", "Needs_Review"])


def test_export_writes_two_sheets(tmp_path: Path):
    out_path = tmp_path / "Inventory_Validation.xlsx"
    InventoryValidationExporter().export(_fact_inventory(), _dim_product(), out_path)

    assert out_path.exists()
    sheet_names = pd.ExcelFile(out_path).sheet_names
    assert sheet_names == ["Inventory_Validation", "Summary"]

    data_sheet = pd.read_excel(out_path, sheet_name="Inventory_Validation")
    assert len(data_sheet) == len(_fact_inventory())
    for flag in [*FLAG_COLUMNS, "Needs_Review"]:
        assert flag in data_sheet.columns


def test_export_unmapped_products_only_includes_no_match_rows(tmp_path: Path):
    out_path = tmp_path / "Unmapped_Products.xlsx"
    InventoryValidationExporter().export_unmapped_products(_fact_inventory(), _dim_product(), out_path)

    assert out_path.exists()
    unmapped = pd.read_excel(out_path, sheet_name="Unmapped_Products")
    assert unmapped["ProductKey"].tolist() == ["P_MISSING"]
    assert bool(unmapped.loc[0, "Flag_No_DimProduct_Match"])
