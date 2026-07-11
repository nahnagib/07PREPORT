from __future__ import annotations

import os
from pathlib import Path
import re
import shutil
import sys
from xml.etree import ElementTree as ET
import zipfile

import pandas as pd


PROJECT_DIR = Path(__file__).resolve().parents[1]
SRC_DIR = PROJECT_DIR / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from sales_pipeline.legacy_transform import (  # noqa: E402
    BCGMatrixBuilder,
    Logger,
    ProductCostDimensionBuilder,
    ProductDimensionBuilder,
    ProductMapper,
    ProductMasterLoader,
    PipelineSettings,
    SegmentDimensionBuilder,
    TextUtils,
    WorkbookExporter,
)


BASE_DIR = PROJECT_DIR.parent
PRODUCTS_PATH = BASE_DIR / "Input" / "PRODUCTS.xlsx"
MODEL_PATH = BASE_DIR / "Exports" / "SalesModel_OneOutput.xlsx"
QA_PATH = BASE_DIR / "Exports" / "QA_UnmappedProducts.xlsx"
OLD_AMBIGUOUS_QA_PATH = BASE_DIR / "Exports" / "QA_AmbiguousProductMapping.xlsx"
SPREADSHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CONTENT_TYPE_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
XML_NS = "http://www.w3.org/XML/1998/namespace"


def _excel_column_name(column_number: int) -> str:
    result = ""
    while column_number:
        column_number, remainder = divmod(column_number - 1, 26)
        result = chr(65 + remainder) + result
    return result


def _worksheet_xml(frame: pd.DataFrame) -> bytes:
    """Create a compact worksheet using inline strings and no shared-string edits."""
    worksheet = ET.Element(f"{{{SPREADSHEET_NS}}}worksheet")
    last_cell = f"{_excel_column_name(len(frame.columns))}{len(frame) + 1}"
    ET.SubElement(worksheet, f"{{{SPREADSHEET_NS}}}dimension", ref=f"A1:{last_cell}")
    sheet_data = ET.SubElement(worksheet, f"{{{SPREADSHEET_NS}}}sheetData")

    rows = [frame.columns.tolist(), *frame.astype(object).where(pd.notna(frame), None).values.tolist()]
    for row_number, values in enumerate(rows, start=1):
        row = ET.SubElement(sheet_data, f"{{{SPREADSHEET_NS}}}row", r=str(row_number))
        for column_number, value in enumerate(values, start=1):
            if value is None:
                continue
            reference = f"{_excel_column_name(column_number)}{row_number}"
            if isinstance(value, bool):
                cell = ET.SubElement(row, f"{{{SPREADSHEET_NS}}}c", r=reference, t="b")
                ET.SubElement(cell, f"{{{SPREADSHEET_NS}}}v").text = "1" if value else "0"
            elif isinstance(value, (int, float)) and not isinstance(value, bool):
                cell = ET.SubElement(row, f"{{{SPREADSHEET_NS}}}c", r=reference)
                ET.SubElement(cell, f"{{{SPREADSHEET_NS}}}v").text = str(value)
            else:
                cell = ET.SubElement(row, f"{{{SPREADSHEET_NS}}}c", r=reference, t="inlineStr")
                inline = ET.SubElement(cell, f"{{{SPREADSHEET_NS}}}is")
                text = ET.SubElement(inline, f"{{{SPREADSHEET_NS}}}t")
                text.set(f"{{{XML_NS}}}space", "preserve")
                text.text = str(value)

    ET.SubElement(worksheet, f"{{{SPREADSHEET_NS}}}autoFilter", ref=f"A1:{last_cell}")
    return ET.tostring(worksheet, encoding="utf-8", xml_declaration=True)


def _upsert_model_sheets(model_path: Path, frames: dict[str, pd.DataFrame]) -> None:
    """Add or replace only requested worksheets without loading large fact sheets."""
    temp_path = model_path.with_name(f".{model_path.stem}.product-refresh.tmp.xlsx")
    with zipfile.ZipFile(model_path, "r") as source:
        workbook = ET.fromstring(source.read("xl/workbook.xml"))
        relationships = ET.fromstring(source.read("xl/_rels/workbook.xml.rels"))
        content_types = ET.fromstring(source.read("[Content_Types].xml"))

        relationship_by_id = {
            item.attrib["Id"]: item
            for item in relationships.findall(f"{{{PACKAGE_REL_NS}}}Relationship")
        }
        targets: dict[str, str] = {}
        sheets_node = workbook.find(f"{{{SPREADSHEET_NS}}}sheets")
        if sheets_node is None:
            raise KeyError("Workbook sheets collection not found")
        for sheet in list(sheets_node):
            name = sheet.attrib.get("name", "")
            if name not in frames:
                continue
            relationship_id = sheet.attrib[f"{{{REL_NS}}}id"]
            relationship = relationship_by_id[relationship_id]
            target = relationship.attrib["Target"].lstrip("/")
            targets[name] = target if target.startswith("xl/") else f"xl/{target}"

        # Allocate package parts for requested sheets that do not exist yet.
        existing_sheet_ids = [int(sheet.attrib["sheetId"]) for sheet in sheets_node]
        existing_rel_ids = [
            int(item.attrib["Id"][3:])
            for item in relationships
            if item.attrib.get("Id", "").startswith("rId") and item.attrib["Id"][3:].isdigit()
        ]
        existing_sheet_numbers = [
            int(match.group(1))
            for name in source.namelist()
            if (match := re.fullmatch(r"xl/worksheets/sheet(\d+)\.xml", name))
        ]
        next_sheet_id = max(existing_sheet_ids, default=0) + 1
        next_rel_id = max(existing_rel_ids, default=0) + 1
        next_sheet_number = max(existing_sheet_numbers, default=0) + 1
        for name in frames:
            if name in targets:
                continue
            target = f"xl/worksheets/sheet{next_sheet_number}.xml"
            relationship_id = f"rId{next_rel_id}"
            ET.SubElement(
                sheets_node,
                f"{{{SPREADSHEET_NS}}}sheet",
                {
                    "name": name,
                    "sheetId": str(next_sheet_id),
                    f"{{{REL_NS}}}id": relationship_id,
                },
            )
            ET.SubElement(
                relationships,
                f"{{{PACKAGE_REL_NS}}}Relationship",
                {
                    "Id": relationship_id,
                    "Type": f"{REL_NS}/worksheet",
                    "Target": f"worksheets/sheet{next_sheet_number}.xml",
                },
            )
            ET.SubElement(
                content_types,
                f"{{{CONTENT_TYPE_NS}}}Override",
                {
                    "PartName": f"/{target}",
                    "ContentType": "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
                },
            )
            targets[name] = target
            next_sheet_id += 1
            next_rel_id += 1
            next_sheet_number += 1

        replacements = {
            "xl/workbook.xml": ET.tostring(workbook, encoding="utf-8", xml_declaration=True),
            "xl/_rels/workbook.xml.rels": ET.tostring(relationships, encoding="utf-8", xml_declaration=True),
            "[Content_Types].xml": ET.tostring(content_types, encoding="utf-8", xml_declaration=True),
            **{targets[name]: _worksheet_xml(frame) for name, frame in frames.items()},
        }
        with zipfile.ZipFile(temp_path, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as target:
            for item in source.infolist():
                target.writestr(item, replacements.get(item.filename, source.read(item.filename)))
            for name, data in replacements.items():
                if name not in source.namelist():
                    target.writestr(name, data)

    try:
        try:
            os.replace(temp_path, model_path)
        except PermissionError:
            # Excel may deny rename/delete while still permitting a shared
            # write. Copy the already-built package directly over the file.
            shutil.copyfile(temp_path, model_path)
    finally:
        temp_path.unlink(missing_ok=True)


def _replace_sheets_in_open_excel(model_path: Path, frames: dict[str, pd.DataFrame]) -> None:
    """Replace requested worksheets through Excel when the workbook is already open."""
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
        sheet = WorkbookExporter._get_or_create_excel_sheet(workbook, sheet_name)
        WorkbookExporter._write_frame_to_excel_sheet(sheet, frame)
    workbook.Save()


def _print_bcg_refresh_summary(
    fact_bcg: pd.DataFrame,
    sales_lines: pd.DataFrame,
    dim_segment: pd.DataFrame,
) -> None:
    summary = BCGMatrixBuilder.quality_summary(sales_lines, fact_bcg, dim_segment)
    duplicate_count = summary["duplicate_company_product_count"]
    bcg_ytd = summary["bcg_ytd_value"]
    fact_ytd = summary["fact_sales_valid_invoice_ytd_value"]
    ytd_delta = summary["bcg_ytd_value_delta"]
    checks = {
        "Dim_Segment contains exactly the five business segments": bool(summary["dim_segment_exact_business_values"]),
        "Fact_BCGMatrix does not contain SegmentKey or SalesSegment": bool(summary["segment_columns_removed"]),
        "No duplicate rows by Company + ProductKey": duplicate_count == 0,
        "Fact_BCGMatrix YTD equals Fact_SalesLines valid invoice YTD": abs(float(ytd_delta)) < 0.01,
        "Existing YTD/LYTD BCG columns are present": bool(summary["ytd_lytd_columns_exist"]),
    }
    passed = sum(1 for value in checks.values() if value)

    print(f"Fact_BCGMatrix row count: {summary['row_count']}")
    print(f"Duplicate count by Company + ProductKey: {duplicate_count}")
    print(f"Segment columns removed from Fact_BCGMatrix: {'PASS' if summary['segment_columns_removed'] else 'FAIL'}")
    if summary["segment_columns_present"]:
        print(f"Unexpected BCG segment columns present: {summary['segment_columns_present']}")
    print(f"Fact_BCGMatrix total YTD value: {bcg_ytd:.2f}")
    print(f"Fact_SalesLines valid invoice YTD value: {fact_ytd:.2f}")
    print(f"Total YTD value reconciliation delta: {ytd_delta:.2f}")
    print(f"Test result summary: {passed}/{len(checks)} passed")
    for name, ok in checks.items():
        print(f"  {'PASS' if ok else 'FAIL'} - {name}")


def _print_product_name_summary(
    dim_product: pd.DataFrame,
    fact_bcg: pd.DataFrame,
) -> None:
    duplicate_clean_count = (
        int(dim_product["ProductNameClean"].dropna().duplicated().sum())
        if "ProductNameClean" in dim_product.columns
        else 0
    )
    sample_columns = [column for column in ["ProductNameRaw", "ProductName", "ProductNameClean"] if column in dim_product.columns]
    samples = dim_product[sample_columns].drop_duplicates().head(8) if sample_columns else pd.DataFrame()

    checks = {
        "Dim_Product ProductName is not blank": "ProductName" in dim_product.columns and dim_product["ProductName"].astype("string").str.strip().ne("").all(),
        "Fact_BCGMatrix ProductName is not blank": "ProductName" in fact_bcg.columns and fact_bcg["ProductName"].astype("string").str.strip().ne("").all(),
        "ProductNameClean exists in Dim_Product": "ProductNameClean" in dim_product.columns,
        "ProductNameClean exists in Fact_BCGMatrix": "ProductNameClean" in fact_bcg.columns,
        "No double spaces in Dim_Product ProductName": "ProductName" in dim_product.columns and not dim_product["ProductName"].astype("string").str.contains(r"\s{2,}", regex=True).any(),
        "No repeated hyphen spacing in Dim_Product ProductName": "ProductName" in dim_product.columns and not dim_product["ProductName"].astype("string").str.contains(r"--| -\s+- ", regex=True).any(),
    }
    passed = sum(1 for ok in checks.values() if ok)

    print(f"Normalized Dim_Product rows: {len(dim_product)}")
    print(f"Normalized Fact_BCGMatrix rows: {len(fact_bcg)}")
    print("Sample before/after product names:")
    if samples.empty:
        print("  (none)")
    else:
        print(samples.to_string(index=False))
    print(f"Duplicate ProductNameClean count: {duplicate_clean_count}")
    print(f"Product normalization test summary: {passed}/{len(checks)} passed")
    for name, ok in checks.items():
        print(f"  {'PASS' if ok else 'FAIL'} - {name}")


def _normalize_fact_sales_lines_product_names(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    raw_source = (
        out["product_name_raw"]
        if "product_name_raw" in out.columns
        else out["ProductNameRaw"]
        if "ProductNameRaw" in out.columns
        else out["product_name"]
        if "product_name" in out.columns
        else out["ProductName"]
        if "ProductName" in out.columns
        else out["product_name_clean"]
        if "product_name_clean" in out.columns
        else pd.Series(pd.NA, index=out.index)
    )
    names = TextUtils.product_name_frame(raw_source)
    out["product_name_raw"] = names["ProductNameRaw"]
    out["product_name"] = names["ProductName"]
    out["product_name_clean"] = names["ProductNameClean"]
    out["ProductNameRaw"] = names["ProductNameRaw"]
    out["ProductName"] = names["ProductName"]
    out["ProductNameClean"] = names["ProductNameClean"]
    if "is_discount" in out.columns:
        is_discount = out["is_discount"].fillna(False).astype(bool)
        out.loc[is_discount, "product_name"] = "Discount"
        out.loc[is_discount, "product_name_clean"] = "DISCOUNT"
        out.loc[is_discount, "ProductName"] = "Discount"
        out.loc[is_discount, "ProductNameClean"] = "DISCOUNT"
    return out


def main() -> int:
    product_master = ProductMasterLoader(
        logger=Logger(False),
        export_conflicts=True,
        base_dir=MODEL_PATH.parent,
    ).load(PRODUCTS_PATH)

    fact_sales_lines = _normalize_fact_sales_lines_product_names(
        pd.read_excel(MODEL_PATH, sheet_name="Fact_SalesLines")
    )
    fact_sales_lines = ProductMapper.attach(fact_sales_lines, product_master)
    dim_product = ProductDimensionBuilder().build(product_master, fact_sales_lines)
    dim_segment = SegmentDimensionBuilder(PipelineSettings()).build(pd.DataFrame(), pd.DataFrame())
    if "SalesSegment" in fact_sales_lines.columns:
        fact_sales_lines["SalesSegment"] = fact_sales_lines["SalesSegment"].apply(SegmentDimensionBuilder.normalize_segment)
        fact_sales_lines["SegmentKey"] = fact_sales_lines["SalesSegment"].map(SegmentDimensionBuilder.segment_key_map()).astype("Int64")
    try:
        dim_product_cost = pd.read_excel(MODEL_PATH, sheet_name="Dim_ProductCost")
    except ValueError:
        dim_product_cost = pd.DataFrame()
    dim_product_cost = ProductCostDimensionBuilder.normalize_existing(dim_product_cost)
    fact_bcg = BCGMatrixBuilder.build(fact_sales_lines, dim_product_cost, dim_product=dim_product)

    # Direct package editing preserves every unrelated workbook sheet.
    updated_sheets = {
        "Dim_Product": dim_product,
        "Dim_ProductCost": dim_product_cost,
        "Dim_Segment": dim_segment,
        "Fact_SalesLines": fact_sales_lines,
        "Fact_BCGMatrix": fact_bcg,
    }
    try:
        _upsert_model_sheets(MODEL_PATH, updated_sheets)
    except PermissionError:
        _replace_sheets_in_open_excel(MODEL_PATH, updated_sheets)

    QA_PATH.unlink(missing_ok=True)
    OLD_AMBIGUOUS_QA_PATH.unlink(missing_ok=True)
    print(f"Dim_Product rows: {len(dim_product)}")
    print(f"Dim_Segment values: {', '.join(dim_segment['Segment'].astype(str).tolist())}")
    _print_product_name_summary(dim_product, fact_bcg)
    print(f"RawFromOdoo product count added: {int(dim_product['ProductMappingStatus'].astype('string').eq('RawFromOdoo').sum())}")
    print(f"Matched product count: {int(fact_sales_lines['ProductMappingStatus'].astype('string').ne('RawFromOdoo').sum())}")
    print(f"Unmatched product count: {int(fact_sales_lines['ProductMappingStatus'].astype('string').eq('RawFromOdoo').sum())}")
    _print_bcg_refresh_summary(fact_bcg, fact_sales_lines, dim_segment)
    for column in ["bcg_class_YTD", "bcg_class_LYTD", "bcg_movement"]:
        print(f"Count by {column}:")
        print(fact_bcg[column].value_counts(dropna=False).to_string())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
