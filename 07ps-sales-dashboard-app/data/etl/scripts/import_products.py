"""Validate PRODUCTS.xlsx and load it into the warehouse as `dim_product_master`.

    python scripts/import_products.py                       # the file in ETL_INPUT_DIR, validate + load
    python scripts/import_products.py path/to/PRODUCTS.xlsx --dry-run   # validate + summary only

The file is rejected (exit code 1, nothing written) if a required column is missing, a Company is not
Majaal/Tika, an OdooProductName is blank, or Company + normalized OdooProductName appears twice.
Re-running with an updated file replaces the table in one transaction. The next ETL run re-maps every
sales and stock line against it (the ETL reads the same file with the same validation).

Database settings come from the environment / .env, exactly like the pipeline (DB_HOST, DB_NAME, ...).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
for extra in (PROJECT_DIR / "src", PROJECT_DIR):
    if str(extra) not in sys.path:
        sys.path.insert(0, str(extra))

import pandas as pd  # noqa: E402
from sqlalchemy import text  # noqa: E402

from config.settings import Settings  # noqa: E402
from sales_pipeline.export.database_exporter import DatabaseExporter  # noqa: E402
from sales_pipeline.legacy_transform import Logger, ProductMasterLoader, ProductMasterValidationError  # noqa: E402

TABLE = "dim_product_master"
COLUMNS = [
    "ProductMatchKey", "ProductKey", "SheetProductKey", "Company", "Category", "Brand", "SubBrand", "Family",
    "ProductName", "OdooProductName", "OdooProductNameNorm", "ProductLevel", "SKU", "Size", "IsActive", "SourceRow",
]


def load_and_validate(path: Path) -> pd.DataFrame:
    return ProductMasterLoader(Logger(enabled=False), export_conflicts=False, base_dir=path.parent).load(path)


def print_summary(df: pd.DataFrame, path: Path) -> None:
    summary = ProductMasterLoader.summary(df)
    print(f"File: {path}")
    print(f"Rows: {summary['rows']}")
    for company, count in summary["rows_per_company"].items():
        print(f"  {company}: {count}")
    print(f"Blank Category: {summary['blank_category']}")
    print(f"Blank ProductName: {summary['blank_product_name']} (displayed with their Odoo name)")
    print(f"Blank SKU: {summary['blank_sku']}")
    print(f"Inactive (IsActive=0): {summary['inactive_rows']}")
    warnings = summary["warnings"]
    print(f"Warnings: {len(warnings)} (the file is not rejected for these)")
    for line in warnings:
        print(f"  - {line}")


def write_table(df: pd.DataFrame, settings: Settings, source: Path) -> None:
    exporter = DatabaseExporter(settings)
    out = df[COLUMNS].copy()
    out["SourceFile"] = source.name
    out["ImportedAtUtc"] = pd.Timestamp.now(tz="UTC").tz_localize(None)
    clean = DatabaseExporter._clean_for_sql(out)
    with exporter.engine.begin() as conn:
        conn.execute(text(f"DROP TABLE IF EXISTS {TABLE}"))
        clean.to_sql(TABLE, conn, if_exists="replace", index=False, dtype=DatabaseExporter._dtype_map(clean))
    print(f"Loaded {len(out)} rows into {TABLE}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("path", nargs="?", help="PRODUCTS.xlsx (default: <ETL_INPUT_DIR>/PRODUCTS.xlsx)")
    parser.add_argument("--dry-run", action="store_true", help="validate and print the summary; write nothing")
    parser.add_argument("--json", action="store_true", help="print the summary as JSON")
    args = parser.parse_args(argv)

    settings = Settings.from_env()
    path = Path(args.path) if args.path else settings.products_path
    try:
        df = load_and_validate(path)
    except ProductMasterValidationError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(ProductMasterLoader.summary(df), ensure_ascii=False, indent=2))
    else:
        print_summary(df, path)
    if not args.dry_run:
        write_table(df, settings, path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
