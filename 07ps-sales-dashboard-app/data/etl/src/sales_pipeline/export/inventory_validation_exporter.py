from __future__ import annotations

import logging
from pathlib import Path

import pandas as pd

FLAG_COLUMNS = [
    "Flag_RM_Warehouse",
    "Flag_Vessel_InTransit",
    "Flag_No_DimProduct_Match",
    "Flag_Negative_Stock",
    "Flag_Missing_Cost",
    "Flag_Not_Official_Master",
]

DATA_SHEET_NAME = "Inventory_Validation"
SUMMARY_SHEET_NAME = "Summary"
UNMAPPED_SHEET_NAME = "Unmapped_Products"

_FLAG_HIGHLIGHT_FILL = "#FFF2CC"
_NEEDS_REVIEW_FILL = "#F8CBAD"


class InventoryValidationExporter:
    """Build the row-level inventory data-validation workbook.

    Merges Fact_Inventory with Dim_Product on ProductKey and flags rows that
    need manual review before being trusted in stock/velocity reporting.
    """

    def __init__(self) -> None:
        self.logger = logging.getLogger(__name__)

    @staticmethod
    def build_validation_frame(fact_inventory: pd.DataFrame, dim_product: pd.DataFrame) -> pd.DataFrame:
        fact = fact_inventory.copy()
        dim = dim_product[["ProductKey", "ProductMappingStatus"]].drop_duplicates("ProductKey", keep="first")

        merged = fact.merge(dim, on="ProductKey", how="left", validate="m:1", indicator=True)
        matched = merged["_merge"].eq("both")

        warehouse = merged["WarehouseName"].astype("string")
        on_hand = pd.to_numeric(merged["OnHandQty"], errors="coerce")
        cost = pd.to_numeric(merged["ProductCost"], errors="coerce")

        merged["Flag_RM_Warehouse"] = warehouse.eq("RM Warehouse").fillna(False).astype(bool)
        merged["Flag_Vessel_InTransit"] = warehouse.eq("Vessel").fillna(False).astype(bool)
        merged["Flag_No_DimProduct_Match"] = (~matched).astype(bool)
        merged["Flag_Negative_Stock"] = on_hand.lt(0).fillna(False).astype(bool)
        merged["Flag_Missing_Cost"] = (cost.isna() | cost.eq(0)).astype(bool)
        # Unmatched rows (no Dim_Product row at all) are treated as not an official
        # master product, since their mapping status can't be confirmed either way.
        merged["Flag_Not_Official_Master"] = (
            merged["ProductMappingStatus"].astype("string").ne("OfficialProductMaster").fillna(True).astype(bool)
        )
        merged["Needs_Review"] = merged[FLAG_COLUMNS].any(axis=1).astype(bool)

        return merged.drop(columns=["_merge"])

    def export(self, fact_inventory: pd.DataFrame, dim_product: pd.DataFrame, path: Path) -> Path:
        out = Path(path)
        out.parent.mkdir(parents=True, exist_ok=True)
        validation = self.build_validation_frame(fact_inventory, dim_product)

        with pd.ExcelWriter(out, engine="xlsxwriter") as writer:
            validation.to_excel(writer, sheet_name=DATA_SHEET_NAME, index=False)
            self._format_data_sheet(writer, validation)
            self._write_summary_sheet(writer, validation)

        self.logger.info(
            "Inventory validation workbook exported: %s rows=%s needs_review=%s",
            out,
            len(validation),
            int(validation["Needs_Review"].sum()),
        )
        return out

    def export_unmapped_products(self, fact_inventory: pd.DataFrame, dim_product: pd.DataFrame, path: Path) -> Path:
        """Write only the inventory rows with no matching product in Dim_Product at all."""
        out = Path(path)
        out.parent.mkdir(parents=True, exist_ok=True)
        validation = self.build_validation_frame(fact_inventory, dim_product)
        unmapped = validation[validation["Flag_No_DimProduct_Match"]].reset_index(drop=True)

        with pd.ExcelWriter(out, engine="xlsxwriter") as writer:
            unmapped.to_excel(writer, sheet_name=UNMAPPED_SHEET_NAME, index=False)
            sheet = writer.sheets[UNMAPPED_SHEET_NAME]
            sheet.autofilter(0, 0, len(unmapped), len(unmapped.columns) - 1)
            sheet.freeze_panes(1, 0)

        self.logger.info("Unmapped products workbook exported: %s rows=%s", out, len(unmapped))
        return out

    @staticmethod
    def _format_data_sheet(writer: pd.ExcelWriter, validation: pd.DataFrame) -> None:
        workbook = writer.book
        sheet = writer.sheets[DATA_SHEET_NAME]
        flag_format = workbook.add_format({"bg_color": _FLAG_HIGHLIGHT_FILL, "bold": True})
        needs_review_format = workbook.add_format({"bg_color": _NEEDS_REVIEW_FILL, "bold": True})
        row_count = len(validation)
        last_row = row_count + 1

        for column_name in FLAG_COLUMNS:
            column_index = validation.columns.get_loc(column_name)
            sheet.conditional_format(
                1, column_index, last_row, column_index,
                {"type": "cell", "criteria": "==", "value": True, "format": flag_format},
            )

        needs_review_index = validation.columns.get_loc("Needs_Review")
        sheet.conditional_format(
            1, needs_review_index, last_row, needs_review_index,
            {"type": "cell", "criteria": "==", "value": True, "format": needs_review_format},
        )
        sheet.autofilter(0, 0, last_row - 1, len(validation.columns) - 1)
        sheet.freeze_panes(1, 0)

    @staticmethod
    def _write_summary_sheet(writer: pd.ExcelWriter, validation: pd.DataFrame) -> None:
        workbook = writer.book
        sheet = workbook.add_worksheet(SUMMARY_SHEET_NAME)
        bold = workbook.add_format({"bold": True})

        row_count = len(validation)
        last_row = row_count + 1
        columns = validation.columns.tolist()

        def data_range(column_name: str) -> str:
            column_index = columns.index(column_name)
            column_letter = InventoryValidationExporter._excel_column_letter(column_index)
            return f"'{DATA_SHEET_NAME}'!${column_letter}$2:${column_letter}${last_row}"

        flag_range = {name: data_range(name) for name in [*FLAG_COLUMNS, "Needs_Review"]}
        on_hand_range = data_range("OnHandQty")
        inventory_value_range = data_range("InventoryValue")

        headers = ["Flag", "Row Count", "Total OnHandQty", "Total InventoryValue"]
        for col, header in enumerate(headers):
            sheet.write(0, col, header, bold)

        label_by_flag = {
            "Flag_RM_Warehouse": "RM Warehouse (raw materials)",
            "Flag_Vessel_InTransit": "Vessel (in transit)",
            "Flag_No_DimProduct_Match": "No Dim_Product match",
            "Flag_Negative_Stock": "Negative stock",
            "Flag_Missing_Cost": "Missing product cost",
            "Flag_Not_Official_Master": "Not official product master",
            "Needs_Review": "Needs review (any flag)",
        }

        for row, flag_name in enumerate(label_by_flag, start=1):
            criteria_range = flag_range[flag_name]
            sheet.write(row, 0, label_by_flag[flag_name])
            sheet.write_formula(row, 1, f"=COUNTIF({criteria_range},TRUE)")
            sheet.write_formula(row, 2, f"=SUMIF({criteria_range},TRUE,{on_hand_range})")
            sheet.write_formula(row, 3, f"=SUMIF({criteria_range},TRUE,{inventory_value_range})")

        total_row = len(label_by_flag) + 2
        sheet.write(total_row, 0, "Total inventory rows", bold)
        sheet.write_formula(total_row, 1, f"=ROWS({on_hand_range})")
        sheet.write_formula(total_row, 2, f"=SUM({on_hand_range})")
        sheet.write_formula(total_row, 3, f"=SUM({inventory_value_range})")

        sheet.set_column(0, 0, 32)
        sheet.set_column(1, 3, 20)

    @staticmethod
    def _excel_column_letter(column_index: int) -> str:
        result = ""
        column_number = column_index + 1
        while column_number:
            column_number, remainder = divmod(column_number - 1, 26)
            result = chr(65 + remainder) + result
        return result
