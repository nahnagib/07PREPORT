from __future__ import annotations

from pathlib import Path
import subprocess
import sys

import pandas as pd


PROJECT_DIR = Path(__file__).resolve().parents[1]
SRC_DIR = PROJECT_DIR / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from sales_pipeline.legacy_transform import BCGMatrixBuilder, PipelineSettings, ProductCostDimensionBuilder, SegmentDimensionBuilder  # noqa: E402
from refresh_product_outputs import MODEL_PATH, _print_bcg_refresh_summary, _upsert_model_sheets  # noqa: E402


def _replace_sheets_in_open_excel(model_path: Path, frames: dict[str, pd.DataFrame]) -> None:
    """Replace worksheets through Excel when the workbook is already open."""
    import win32com.client

    excel = win32com.client.GetActiveObject("Excel.Application")
    workbook = next(
        (
            book
            for book in excel.Workbooks
            if Path(book.FullName).resolve() == model_path.resolve()
        ),
        None,
    )
    if workbook is None:
        raise RuntimeError(f"Open Excel workbook not found: {model_path}")

    for sheet_name, frame in frames.items():
        sheet = workbook.Worksheets(sheet_name)
        for index in range(sheet.ListObjects.Count, 0, -1):
            sheet.ListObjects(index).Delete()
        sheet.UsedRange.Clear()
        sheet.Cells.Clear()
        values = [frame.columns.tolist(), *frame.astype(object).where(pd.notna(frame), None).values.tolist()]
        values = [
            [value.item() if hasattr(value, "item") else value for value in row]
            for row in values
        ]
        destination = sheet.Range(
            sheet.Cells(1, 1),
            sheet.Cells(len(values), len(frame.columns)),
        )
        destination.Value = tuple(tuple(row) for row in values)
    workbook.Save()


def main() -> int:
    # Read only fields used by BCG and replace only Fact_BCGMatrix. The package
    # upsert preserves Dim_Product and every unrelated workbook worksheet.
    sales_lines = pd.read_excel(
        MODEL_PATH,
        sheet_name="Fact_SalesLines",
        usecols=lambda name: name in {
            "Company", "company_final", "company", "ProductKey", "OdooProductID", "SKU",
            "SegmentKey", "SalesSegment",
            "product_name_raw", "product_name_clean", "product_name",
            "ProductNameRaw", "ProductName", "ProductNameClean",
            "order_date_date", "date_order", "OrderDate", "order_date",
            "qty_invoiced", "quantity", "Volume", "Value", "line_total",
            "untaxed_total", "price_unit", "product_cost",
            "invoice_status", "order_state",
        },
    )
    dim_product_cost = ProductCostDimensionBuilder.normalize_existing(
        pd.read_excel(MODEL_PATH, sheet_name="Dim_ProductCost")
    )
    try:
        dim_product = pd.read_excel(MODEL_PATH, sheet_name="Dim_Product")
    except ValueError:
        dim_product = pd.DataFrame()
    dim_segment = SegmentDimensionBuilder(PipelineSettings()).build(pd.DataFrame(), pd.DataFrame())
    if "SalesSegment" in sales_lines.columns:
        sales_lines["SalesSegment"] = sales_lines["SalesSegment"].apply(SegmentDimensionBuilder.normalize_segment)
        sales_lines["SegmentKey"] = sales_lines["SalesSegment"].map(SegmentDimensionBuilder.segment_key_map()).astype("Int64")
    fact_bcg = BCGMatrixBuilder.build(sales_lines, dim_product_cost, dim_product=dim_product)
    updated_sheets = {"Fact_BCGMatrix": fact_bcg, "Dim_ProductCost": dim_product_cost, "Dim_Segment": dim_segment}
    try:
        _upsert_model_sheets(MODEL_PATH, updated_sheets)
    except (PermissionError, subprocess.CalledProcessError):
        # Excel locks an open workbook against package replacement. Use the
        # active Excel instance to replace only the requested worksheets.
        _replace_sheets_in_open_excel(MODEL_PATH, updated_sheets)

    _print_bcg_refresh_summary(fact_bcg, sales_lines, dim_segment)
    for column in ["bcg_class_YTD", "bcg_class_LYTD", "bcg_movement"]:
        print(f"Count by {column}:")
        print(fact_bcg[column].value_counts(dropna=False).to_string())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
