"""Excel inputs owned by core: the org file (SalesTeam.xlsx), the product catalogue (PRODUCTS.xlsx), off days
(OffDays.xlsx) and blocked customers (BlockedCustomers.xlsx).

Each sheet is validated against its schema (etl_platform.sources.excel) and copied as a whole into its
raw_excel_* table (replace_all), with the Excel row number and the file's SHA-256, so every dimension row can be
traced to the exact file and row it came from. The ETL never writes to an input file.

Key columns (docs/rename-map.md): SalespersonKey / ChannelKey / SegmentKey / CompanyKey in the org file,
ProductMasterKey in PRODUCTS.xlsx, CompanyKey in OffDays.xlsx, CustomerKey (Odoo commercial partner id) in
BlockedCustomers.xlsx.
"""

from __future__ import annotations

import datetime as _dt
from dataclasses import dataclass

import pandas as pd

from etl_platform.load import replace_all
from etl_platform.runner import RunContext, TaskResult
from etl_platform.sources.excel import Column, ExcelSource, SheetSchema

ORG_FILE = "SalesTeam.xlsx"
PRODUCTS_FILE = "PRODUCTS.xlsx"
OFFDAYS_FILE = "OffDays.xlsx"
BLOCKED_FILE = "BlockedCustomers.xlsx"

SALESPERSON = SheetSchema(
    sheet=("salesperson", "People", "Salespeople"),
    columns=(
        Column("SalespersonKey", "int", nullable=False, unique=True),
        Column("Name", "str", nullable=False, unique=True, aliases=("Salesperson", "Sales Person", "Employee")),
        Column("TeamKey", "str", aliases=("Team Key", "Team Code")),
        Column("Status", "str", allowed=("Active", "Inactive", "ACTIVE", "INACTIVE", "active", "inactive")),
        Column("DistributionChannel", "str", aliases=("Distribution Channel", "Channel")),
        Column("ChannelKey", "int"),
    ),
)
SALES_TEAM = SheetSchema(
    sheet=("salesteam", "Teams", "Sales Team"),
    columns=(
        Column("TeamKey", "str", nullable=False, unique=True, aliases=("Team Key", "Team Code")),
        Column("TeamName", "str", aliases=("Team Name",)),
        Column("Company", "str"),
        Column("CompanyKey", "int", nullable=False),
        Column("City", "str", aliases=("Branch",)),
        Column("Territory", "str", required=False),
        Column("Segment", "str", aliases=("SalesSegment", "Sales Segment")),
        Column("SegmentKey", "int", nullable=False),
        Column("Status", "str"),
    ),
)
ODOO_USERS = SheetSchema(
    sheet=("OdooUsers", "Odoo Users"),
    columns=(
        Column("odoo_user_id", "int", nullable=False, unique=True),
        Column("SalespersonKey", "int", nullable=False),
        Column("odoo_user_name", "str", required=False),
        Column("note", "str", required=False),
    ),
)
ODOO_TEAMS = SheetSchema(
    sheet=("OdooTeams", "Odoo Teams"),
    columns=(
        Column("odoo_team_id", "int", nullable=False, unique=True),
        Column("SalesTeamKey", "str", nullable=False),  # an Excel org code, or SALESPERSON
        Column("odoo_team_name", "str", required=False),
        Column("note", "str", required=False),
    ),
)
CHANNEL = SheetSchema(
    sheet=("channel",),
    columns=(Column("ChannelKey", "int", nullable=False, unique=True), Column("DistributionChannel", "str", nullable=False, unique=True)),
)
SEGMENT = SheetSchema(
    sheet=("segment",),
    columns=(Column("SegmentKey", "int", nullable=False, unique=True), Column("Segment", "str", nullable=False, unique=True)),
)
PRODUCTS = SheetSchema(
    sheet=("Products",),
    columns=(
        Column("ProductMasterKey", "str", unique=True),  # blank -> generated (core.transforms.product)
        Column("ProductKey", "str"),  # the sheet's family/SKU code; NOT unique
        Column("Company", "str", nullable=False, allowed=("Majaal", "Tika")),
        Column("Category", "str"),
        Column("Brand", "str"),
        Column("SubBrand", "str"),
        Column("Family", "str"),
        Column("ProductName", "str"),
        Column("OdooProductName", "str", nullable=False),
        Column("ProductLevel", "str"),
        Column("SKU", "str"),
        Column("Size", "str"),
        Column("IsActive", "bool"),
        Column("OdooProductID", "int", required=False),
    ),
)
OFFDAYS = SheetSchema(
    sheet=("Sheet1", "OffDays"),
    columns=(
        Column("Date", "date", nullable=False, date_format="%d/%m/%Y"),
        Column("OffDayType", "str"),
        Column("HolidayName", "str", required=False),
        Column("Reason", "str", required=False),
        Column("Country", "str"),
        Column("Company", "str"),
        Column("CompanyKey", "int"),
        Column("Branch", "str"),
        Column("IsActive", "bool"),
        Column("Source", "str", required=False),
        Column("Notes", "str", required=False),
    ),
)
BLOCKED = SheetSchema(
    sheet=("BlockedCustomers",),
    columns=(
        Column("CustomerKey", "int"),
        Column("CustomerID", "str"),
        Column("CustomerName", "str"),
        Column("IsBlocked", "bool"),
        Column("BlockedDate", "date", date_format="%d/%m/%Y"),
        Column("UnblockedDate", "date", date_format="%d/%m/%Y"),
        Column("BlockedReason", "str"),
        Column("Notes", "str"),
    ),
)


@dataclass(frozen=True)
class ExcelInput:
    dataset: str
    file: str
    schema: SheetSchema
    table: str
    rename: tuple[tuple[str, str], ...] = ()
    row_is_key: bool = False  # tables keyed by _excel_row (no natural key in the sheet)


INPUTS = (
    ExcelInput("raw_excel_salesperson", ORG_FILE, SALESPERSON, "raw_excel_salesperson"),
    ExcelInput("raw_excel_sales_team", ORG_FILE, SALES_TEAM, "raw_excel_sales_team"),
    ExcelInput("raw_excel_odoo_users", ORG_FILE, ODOO_USERS, "raw_excel_odoo_users"),
    ExcelInput("raw_excel_odoo_teams", ORG_FILE, ODOO_TEAMS, "raw_excel_odoo_teams"),
    ExcelInput("raw_excel_channel", ORG_FILE, CHANNEL, "raw_excel_channel"),
    ExcelInput("raw_excel_segment", ORG_FILE, SEGMENT, "raw_excel_segment"),
    ExcelInput("raw_excel_products", PRODUCTS_FILE, PRODUCTS, "raw_excel_products", rename=(("ProductKey", "SheetProductKey"),)),
    ExcelInput("raw_excel_offdays", OFFDAYS_FILE, OFFDAYS, "raw_excel_offdays", row_is_key=True),
    ExcelInput("raw_excel_blocked_customers", BLOCKED_FILE, BLOCKED, "raw_excel_blocked_customers", row_is_key=True),
)


def read_input(source: ExcelSource, spec: ExcelInput) -> pd.DataFrame:
    df = source.read(spec.file, spec.schema)
    rows = df.attrs.get("excel_rows", list(range(2, len(df) + 2)))
    df = df.rename(columns=dict(spec.rename))
    df["_excel_row"] = rows
    return df


def load_excel_input(ctx: RunContext, spec: ExcelInput, *, transform=None) -> TaskResult:
    """Validates the sheet and replaces its raw_excel_* table. ``transform(df) -> df`` may finish the rows
    (e.g. generate blank ProductMasterKeys) before they are written."""
    source = ctx.excel()
    df = read_input(source, spec)
    if transform is not None:
        df = transform(df)
    df["_file_sha256"] = ExcelSource.file_hash(source.path(spec.file))
    df["_extracted_at"] = _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None)
    df["_run_id"] = ctx.run_uid
    with ctx.engine.begin() as conn:
        deleted, inserted = replace_all(conn, spec.table, df)
    return TaskResult(rows_extracted=len(df), rows_loaded=inserted, details={"file": spec.file, "replaced": deleted})
