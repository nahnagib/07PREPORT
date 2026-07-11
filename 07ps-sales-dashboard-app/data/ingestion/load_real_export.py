"""Loads a real SalesModel_OneOutput.xlsx export directly into the MySQL star schema, bypassing
the mocked-Odoo pipeline entirely.

Why this script exists: the Tachometer measures layer (data/warehouse/measures/) was validated
against genuine historical data by reading SalesModel_OneOutput.xlsx directly and loading it via
star_schema.loader.StarSchemaLoader - see data/ingestion/tachometer_kpi_validation.md. That
validation was originally done as an ad hoc, one-off script; this is the same approach made
reusable and committed to the repo, so a real export can be loaded locally with one command
instead of hand-writing pymysql/openpyxl code again.

This is NOT the ingestion pipeline (orchestrator.py) - it does not touch Odoo (mocked or real) and
does not merge in the manual Input/ Excel files (SalesTeam.xlsx, sales_targets.xlsx, etc). It reads
one workbook that already has every sheet the star schema needs, in the exact column layout
StarSchemaLoader already expects (the loader's docstring explains why the column names line up:
it's the same header layout the vendored pipeline's own Excel export produces).

Usage:
    DB_HOST=localhost DB_PORT=3306 DB_USER=root DB_PASSWORD= DB_NAME=ps_warehouse \
        python load_real_export.py /path/to/SalesModel_OneOutput.xlsx

Loads ALL 21 required sheets (skips the QA_* informational sheets, which no table maps to) and
performs a full replace-load (StarSchemaLoader.load_all truncates every star-schema table first) -
so this is meant for a throwaway/validation warehouse, never a production database with live data
already in it.
"""
from __future__ import annotations

import argparse
import logging
import os
import sys

import pandas as pd
import pymysql

sys.path.insert(0, os.path.dirname(__file__))
from star_schema.loader import StarSchemaLoader  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

# Every sheet star_schema/loader.py's load_all() reads. QA_* sheets are informational only in the
# source export - no star-schema table maps to them (see data/warehouse/README.md).
REQUIRED_SHEETS = [
    "Dim_Company", "Dim_Segment", "Dim_DistributionChannel", "Dim_SalesTeam", "Dim_Salesperson",
    "Dim_CRMStage", "Dim_LostReason", "Dim_Date", "Dim_Customer", "Dim_Product", "Dim_ProductCost",
    "Fact_Targets", "Fact_OffDays", "Fact_Lead", "Fact_Opportunity", "Fact_Inventory",
    "Fact_BCGMatrix", "Fact_Orders", "Fact_SalesLines", "Fact_Sales", "Fact_Delivery",
]


def build_connection():
    return pymysql.connect(
        host=os.environ.get("DB_HOST", "localhost"),
        port=int(os.environ.get("DB_PORT", "3306")),
        user=os.environ.get("DB_USER", "root"),
        password=os.environ.get("DB_PASSWORD", ""),
        database=os.environ.get("DB_NAME", "ps_warehouse"),
        unix_socket=os.environ.get("DB_SOCKET") or None,
        autocommit=False,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "xlsx_path",
        nargs="?",
        default=os.environ.get("EXPORT_XLSX_PATH"),
        help="Path to SalesModel_OneOutput.xlsx (or set EXPORT_XLSX_PATH)",
    )
    args = parser.parse_args()

    if not args.xlsx_path:
        parser.error("Provide the xlsx path as an argument or set EXPORT_XLSX_PATH")

    logger.info("Reading %s ...", args.xlsx_path)
    all_sheets = pd.read_excel(args.xlsx_path, sheet_name=None, engine="openpyxl")
    missing = [s for s in REQUIRED_SHEETS if s not in all_sheets]
    if missing:
        raise SystemExit(f"Export is missing required sheet(s): {missing}")
    sheets = {name: all_sheets[name] for name in REQUIRED_SHEETS}
    for name, df in sheets.items():
        logger.info("  %-24s %d rows", name, len(df))

    conn = build_connection()
    try:
        loader = StarSchemaLoader(conn)
        report = loader.load_all(sheets)
    finally:
        conn.close()

    print("\n--- Load report ---")
    for table, count in sorted(report.inserted.items()):
        skipped = report.skipped.get(table, 0)
        flag = "  <-- had errors" if report.errors.get(table) else ""
        print(f"{table:<36} inserted={count:<8} skipped={skipped}{flag}")
    if not report.clean:
        print(f"\n{report.total_errors} row(s) failed to load - first few errors per table:")
        for table, errs in report.errors.items():
            print(f"  {table}:")
            for row, msg in errs[:3]:
                print(f"    {msg}")
        sys.exit(1)
    print("\nDone - loaded cleanly.")


if __name__ == "__main__":
    main()
