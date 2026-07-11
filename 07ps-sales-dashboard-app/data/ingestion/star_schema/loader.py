"""Loads the vendored pipeline's transformed ``sheets`` dict (the same in-memory DataFrames that
``pipeline.run(output_mode="excel")`` would otherwise write to SalesModel_OneOutput.xlsx, and
that ``pipeline.run(output_mode="sql")`` would otherwise write to its own flat/denormalized
MySQL tables via ``DatabaseExporter``) into the MySQL 8 star schema instead.

Column mappings below are adapted from this project's own prior validation script
(load_and_validate.py, run against the real SalesModel_OneOutput.xlsx export in the warehouse-
build session) - not re-derived from scratch. That script read column values from openpyxl rows
keyed by the source sheet's exact header names (e.g. ``r['CompanyKey']``); this module reads the
identical column names from ``pandas.DataFrame.to_dict('records')`` instead, since the vendored
pipeline's in-memory ``sheets`` dict uses the exact same header names as its own Excel export (it
IS the code that produces that export). The only genuinely new mapping work here is the manual-
input-only columns that don't exist in the source export at all (BlockedCustomers.xlsx's
UnblockedDate/BlockedReason/Notes, OffDays.xlsx's HolidayName/Reason/Source/Notes) - added to the
schema in this same session (migrations 0003/0004) and mapped here from the same Dim_Customer /
Fact_OffDays sheets the vendored pipeline already merges those manual sheets into.

This is a FULL replace-load (delete-then-insert per table) - suitable for this session's
validation run and for a scheduled full refresh. Incremental (delete/insert-by-window) loading
mirroring the vendored pipeline's own ``DatabaseExporter.export_incremental`` strategy is called
out as a follow-up in README.md, not implemented here - full-refresh-5x/day is what the Standards
document specifies (Section 2.1.2/5.14), and it is what this loader does.
"""
from __future__ import annotations

import datetime
import logging
from dataclasses import dataclass, field
from typing import Any, Callable

import pandas as pd
import pymysql

logger = logging.getLogger(__name__)


def _is_na(v: Any) -> bool:
    """Robust null check across every NaN-shaped value pandas/numpy can hand back from
    DataFrame.to_dict('records') - plain None, numpy.nan, pandas.NA, pandas.NaT, and numpy scalar
    types that don't subclass plain Python float. pd.isna() handles all of these; the only thing
    it can't take is a list/array (raises), which none of our column values are.
    """
    if v is None:
        return True
    try:
        result = pd.isna(v)
    except (TypeError, ValueError):
        return False
    return bool(result)


def to_date(v: Any):
    if _is_na(v):
        return None
    if isinstance(v, datetime.datetime):
        return v.date()
    if isinstance(v, datetime.date):
        return v
    if isinstance(v, str):
        try:
            return pd.to_datetime(v).date()
        except Exception:
            return None
    return None


def to_dt(v: Any):
    if _is_na(v):
        return None
    if isinstance(v, datetime.datetime):
        return v
    if isinstance(v, datetime.date):
        return datetime.datetime(v.year, v.month, v.day)
    if isinstance(v, str):
        try:
            return pd.to_datetime(v).to_pydatetime()
        except Exception:
            return None
    return None


def clean_int(v: Any):
    if _is_na(v):
        return None
    try:
        if isinstance(v, str) and v.strip() == "":
            return None
        return int(v)
    except (ValueError, TypeError):
        return None


def clean_bool(v: Any) -> bool:
    if _is_na(v):
        return False
    return bool(v)


def clean_key(v: Any):
    """Some source key columns arrive as the literal string '<NA>' (a pandas-to-Excel export
    artifact) instead of a true blank - see the prior session's load_and_validate.py for the
    original finding. Treated as a real null, matching that precedent.
    """
    if _is_na(v):
        return None
    if isinstance(v, str) and v.strip() in ("<NA>", "nan", "NaN", "None", "NaT", ""):
        return None
    return v


def clean_num(v: Any):
    """Same '<NA>'-as-string precedent as clean_key, plus the literal string 'nan' - observed on
    LYTD (last-year-to-date) BCG columns when there is no prior-year sales history at all (e.g.
    testing against a narrow mocked date range with no "last year" to compare against). A real
    float NaN is caught by _is_na(); this catches the stringified form some upstream pandas
    operation already converted it to before it reached this loader.
    """
    if _is_na(v):
        return None
    if isinstance(v, str) and v.strip().lower() in ("nan", "<na>", "none", "nat", ""):
        return None
    return v


@dataclass
class LoadReport:
    inserted: dict = field(default_factory=dict)
    skipped: dict = field(default_factory=dict)
    errors: dict = field(default_factory=dict)

    @property
    def total_inserted(self) -> int:
        return sum(self.inserted.values())

    @property
    def total_errors(self) -> int:
        return sum(len(v) for v in self.errors.values())

    @property
    def clean(self) -> bool:
        return self.total_errors == 0


class StarSchemaLoader:
    """Full replace-load of the star schema from a pipeline sheets dict."""

    def __init__(self, connection):
        self.conn = connection
        self.cur = connection.cursor()
        self.report = LoadReport()

    def _bulk_insert(self, table: str, cols, rows, transform: Callable):
        ok = 0
        errors = []
        placeholders = ",".join(["%s"] * len(cols))
        sql = f"INSERT INTO {table} ({','.join(cols)}) VALUES ({placeholders})"
        for row in rows:
            try:
                values = transform(row)
                if values is None:
                    continue
                self.cur.execute(sql, values)
                ok += 1
            except Exception as exc:  # noqa: BLE001 - report, don't silently swallow
                errors.append((row, str(exc)))
        self.conn.commit()
        self.report.inserted[table] = ok
        self.report.skipped[table] = len(errors)
        if errors:
            self.report.errors[table] = errors[:10]
        logger.info("%s: inserted=%d errors=%d", table, ok, len(errors))

    def _truncate_all(self, tables):
        self.cur.execute("SET FOREIGN_KEY_CHECKS=0")
        for t in tables:
            self.cur.execute(f"DELETE FROM `{t}`")
        self.cur.execute("SET FOREIGN_KEY_CHECKS=1")
        self.conn.commit()

    def _extend_dim_date(self, sheets):
        """The vendored pipeline's own Dim_Date sheet only covers dates actually observed in
        sale.report. Fact_Targets and Fact_OffDays are full manual-input files that legitimately
        span years - far outside whatever narrow window a given Odoo extract's sales rows happen
        to cover (especially visible when testing against a small mocked Odoo dataset, but a real
        latent gap even in production on a fresh install with limited Odoo sales history).

        Backfills any DateKey referenced by Fact_Targets/Fact_OffDays/Fact_Lead/Fact_Opportunity/
        Fact_Orders/Fact_SalesLines/Fact_Sales/Fact_Delivery that Dim_Date is missing, deriving
        standard calendar attributes directly from the YYYYMMDD key - calendar arithmetic, not
        business logic, so this isn't "re-deriving" anything the vendored pipeline decides.
        """
        dim_date = sheets["Dim_Date"]
        existing_keys = set(pd.to_numeric(dim_date["DateKey"], errors="coerce").dropna().astype(int))

        date_key_columns = [
            ("Fact_Targets", "DateKey"), ("Fact_OffDays", "DateKey"),
            ("Fact_Lead", "LeadCreatedDateKey"),
            ("Fact_Opportunity", "OpportunityCreatedDateKey"), ("Fact_Opportunity", "ExpectedCloseDateKey"),
            ("Fact_Orders", "DateKey"), ("Fact_SalesLines", "DateKey"),
            ("Fact_Sales", "DateKey"), ("Fact_Delivery", "OrderDateKey"),
            ("Fact_Delivery", "ScheduledDateKey"), ("Fact_Delivery", "DoneDateKey"),
        ]
        needed_keys = set()
        for sheet_name, col in date_key_columns:
            sheet = sheets.get(sheet_name)
            if sheet is None or col not in sheet.columns:
                continue
            values = pd.to_numeric(sheet[col], errors="coerce").dropna().astype(int)
            needed_keys.update(int(v) for v in values if v > 0)

        missing_keys = sorted(needed_keys - existing_keys)
        if not missing_keys:
            return dim_date

        new_rows = []
        for key in missing_keys:
            try:
                d = datetime.datetime.strptime(str(key), "%Y%m%d").date()
            except ValueError:
                logger.warning("Skipping unparseable DateKey found in a fact sheet (not YYYYMMDD): %s", key)
                continue
            new_rows.append({
                "DateKey": key, "Date": d, "Year": d.year, "Month": d.month,
                "MonthName": d.strftime("%b"), "YearMonth": d.strftime("%Y-%m"),
                "Quarter": f"{d.year}Q{(d.month - 1) // 3 + 1}", "DayOfMonth": d.day,
                "DayOfYear": d.timetuple().tm_yday, "WeekdayNumber": d.weekday(),
                "WeekdayName": d.strftime("%A"),
                # Not backfilled for these synthetic (out-of-observed-sales-range) dates - see
                # docstring above and README.md's reconciliation notes.
                "IsWeeklyRestDay": False,
            })
        logger.info(
            "Extended Dim_Date with %d date(s) referenced by Targets/OffDays/CRM/Delivery but "
            "outside the sales-observed range (%d already present).",
            len(new_rows), len(existing_keys),
        )
        return pd.concat([dim_date, pd.DataFrame(new_rows)], ignore_index=True)

    def load_all(self, sheets, snapshot_date=None) -> LoadReport:
        snapshot_date = snapshot_date or datetime.date.today()
        sheets = dict(sheets)
        sheets["Dim_Date"] = self._extend_dim_date(sheets)

        self._truncate_all([
            "fact_order_line", "fact_quotation", "fact_delivery", "fact_opportunity", "fact_lead",
            "fact_order", "fact_target_plan", "fact_calendar_exception",
            "fact_customer_status_snapshot", "fact_inventory_snapshot",
            "fact_product_performance_snapshot",
            "dim_product", "dim_customer", "dim_salesperson", "dim_sales_team",
            "dim_lost_reason", "dim_crm_stage", "dim_distribution_channel", "dim_segment",
            "dim_company", "dim_date",
        ])

        self._load_dimensions(sheets)
        self._load_customer_status_snapshot(sheets, snapshot_date)
        self._load_targets_and_calendar(sheets)
        self._load_crm(sheets)
        self._load_inventory_and_bcg(sheets, snapshot_date)
        self._load_sales(sheets)
        return self.report

    def _load_dimensions(self, sheets):
        dim_company = sheets["Dim_Company"].to_dict("records")
        dim_segment = sheets["Dim_Segment"].to_dict("records")
        dim_channel = sheets["Dim_DistributionChannel"].to_dict("records")
        dim_sales_team = sheets["Dim_SalesTeam"].to_dict("records")
        dim_salesperson = sheets["Dim_Salesperson"].to_dict("records")
        dim_crm_stage = sheets["Dim_CRMStage"].to_dict("records")
        dim_lost_reason = sheets["Dim_LostReason"].to_dict("records")
        dim_date = sheets["Dim_Date"].to_dict("records")
        dim_customer = sheets["Dim_Customer"].to_dict("records")
        dim_product = sheets["Dim_Product"].to_dict("records")
        dim_product_cost = sheets["Dim_ProductCost"].to_dict("records")

        self._bulk_insert("dim_company", ["company_key", "company_name"], dim_company,
                           lambda r: (clean_int(r["CompanyKey"]), r["Company"]))
        self._bulk_insert("dim_segment", ["segment_key", "segment_name"], dim_segment,
                           lambda r: (clean_int(r["SegmentKey"]), r["Segment"]))
        self._bulk_insert("dim_distribution_channel", ["channel_key", "channel_name"], dim_channel,
                           lambda r: (clean_int(r["ChannelKey"]), r["DistributionChannel"]))

        self.company_name_to_key = {r["Company"]: clean_int(r["CompanyKey"]) for r in dim_company}
        self.segment_name_to_key = {r["Segment"]: clean_int(r["SegmentKey"]) for r in dim_segment}
        self.channel_name_to_key = {r["DistributionChannel"]: clean_int(r["ChannelKey"]) for r in dim_channel}

        def normalize_status(v):
            if not v:
                return "UNKNOWN"
            u = str(v).strip().upper()
            return u if u in ("ACTIVE", "INACTIVE") else "UNKNOWN"

        self._bulk_insert(
            "dim_sales_team",
            ["sales_team_key", "sales_team_name", "segment_key", "city", "company_key",
             "sales_team_status", "sales_team_status_raw"],
            dim_sales_team,
            lambda r: (
                clean_key(r["SalesTeamKey"]), r["SalesTeam"],
                self.segment_name_to_key.get(r.get("SalesSegment")), r.get("SalesCity"),
                self.company_name_to_key.get(r.get("SalesTeamCompany")),
                normalize_status(r.get("SalesTeamStatus")), r.get("SalesTeamStatus"),
            ),
        )
        self._bulk_insert(
            "dim_salesperson",
            ["salesperson_key", "salesperson_name", "sales_team_key", "distribution_channel_key"],
            dim_salesperson,
            lambda r: (
                clean_int(r["SalespersonKey"]), r["salesperson"], clean_key(r.get("SalesTeamKey")),
                self.channel_name_to_key.get(r.get("DistributionChannel")),
            ),
        )
        self._bulk_insert(
            "dim_crm_stage", ["stage_id", "stage_name", "sequence_order", "is_won_stage"], dim_crm_stage,
            lambda r: (clean_int(r["StageID"]), r["Stage"], clean_int(r["Sequence"]), clean_bool(r["IsWonStage"])),
        )
        self._bulk_insert(
            "dim_lost_reason", ["lost_reason_id", "lost_reason", "lost_reason_english"], dim_lost_reason,
            lambda r: (clean_int(r["LostReasonID"]), r["LostReason"], r.get("LostReasonEnglish")),
        )
        self._bulk_insert(
            "dim_date",
            ["date_key", "calendar_date", "year", "month", "month_name", "year_month_label",
             "quarter_label", "day_of_month", "day_of_year", "weekday_number", "weekday_name",
             "is_weekly_rest_day"],
            dim_date,
            lambda r: (
                clean_int(r["DateKey"]), to_date(r["Date"]), clean_int(r["Year"]), clean_int(r["Month"]),
                r["MonthName"], r["YearMonth"], r["Quarter"], clean_int(r["DayOfMonth"]),
                clean_int(r["DayOfYear"]), clean_int(r["WeekdayNumber"]), r["WeekdayName"],
                clean_bool(r["IsWeeklyRestDay"]),
            ),
        )

        self.cur.execute(
            "INSERT INTO dim_customer (customer_key, customer_business_id, customer_name, customer_segment) "
            "VALUES (-1, NULL, 'Unknown Customer', 'Unknown')"
        )
        self.conn.commit()
        self._bulk_insert(
            "dim_customer",
            ["customer_key", "customer_business_id", "customer_name", "company_key", "sales_team_key",
             "distribution_channel_key", "customer_segment", "first_purchase_date"],
            dim_customer,
            lambda r: (
                clean_int(r["CustomerKey"]), r.get("CustomerID"), r["customer"],
                self.company_name_to_key.get(r.get("company")), clean_key(r.get("SalesTeamKey")),
                self.channel_name_to_key.get(r.get("DistributionChannel")), r.get("CustomerSegment"),
                to_date(r.get("First_Purchase_Date")),
            ),
        )

        cost_by_key = {r["ProductKey"]: r.get("ProductCost") for r in dim_product_cost}
        self._bulk_insert(
            "dim_product",
            ["product_key", "company_key", "category", "brand", "family", "sku", "size_label",
             "product_name", "product_name_clean", "is_active", "product_mapping_status", "standard_cost"],
            dim_product,
            lambda r: (
                r["ProductKey"], self.company_name_to_key.get(r.get("Company")), r.get("Category"),
                r.get("Brand"), r.get("Family"), r.get("SKU"), r.get("Size"), r["ProductName"],
                r.get("ProductNameClean"), clean_bool(r.get("IsActive")), r.get("ProductMappingStatus"),
                clean_num(cost_by_key.get(r["ProductKey"])),
            ),
        )
        self.dim_customer_records = dim_customer

    def _load_customer_status_snapshot(self, sheets, snapshot_date):
        dim_customer = self.dim_customer_records
        self._bulk_insert(
            "fact_customer_status_snapshot",
            ["snapshot_date", "customer_key", "last_purchase_date", "ly_value", "ytd_value",
             "full_2023_value", "full_2024_value", "full_2025_value", "has_history_before_lytd",
             "has_history_post_lytd_last_year", "is_lytd", "is_ytd", "is_ly_full_year",
             "is_active_ytd", "is_blocked", "blocked_date", "unblocked_date", "blocked_reason",
             "notes", "customer_class_ly", "customer_status"],
            dim_customer,
            lambda r: (
                snapshot_date, clean_int(r["CustomerKey"]), to_date(r.get("Last_Purchase_Date")),
                clean_num(r.get("LY_Value")) or 0, clean_num(r.get("YTD_Value")) or 0,
                clean_num(r.get("Full_2023_Value")), clean_num(r.get("Full_2024_Value")),
                clean_num(r.get("Full_2025_Value")), clean_bool(r.get("HasHistoryBeforeLYTD")),
                clean_bool(r.get("HasHistoryPostLYTDLastYear")), clean_bool(r.get("IsLYTD")),
                clean_bool(r.get("IsYTD")), clean_bool(r.get("IsLYFullYear")),
                clean_bool(r.get("IsActiveYTD")), clean_bool(r.get("IsBlocked")),
                to_date(r.get("BlockedDate")),
                to_date(r.get("UnblockedDate")), r.get("BlockedReason"), r.get("Notes"),
                r.get("CustomerClass_LY"), r["CustomerStatus"],
            ),
        )

    def _load_targets_and_calendar(self, sheets):
        fact_targets = sheets["Fact_Targets"].to_dict("records")
        fact_offdays = sheets["Fact_OffDays"].to_dict("records")

        self._bulk_insert(
            "fact_target_plan",
            ["date_key", "target_year", "target_month", "target_grain", "company_key",
             "sales_team_key", "salesperson_key", "segment_key", "channel_key", "currency",
             "target_revenue", "target_volume", "asp_last_year", "asp_this_year"],
            fact_targets,
            lambda r: (
                clean_int(r["DateKey"]), clean_int(r["Year"]), clean_int(r["Month"]),
                "SALESPERSON", clean_int(r.get("CompanyKey")),
                clean_key(r.get("SalesTeamKey")), clean_int(r["SalespersonKey"]),
                clean_int(r["SegmentKey"]), clean_int(r["ChannelKey"]), r.get("Currency"),
                clean_num(r["Target_Revenue"]), clean_num(r.get("Target_Volume")),
                clean_num(r.get("ASP_LY")), clean_num(r.get("ASP_ThisYear")),
            ),
        )
        self._bulk_insert(
            "fact_calendar_exception",
            ["date_key", "off_day_type", "country", "company_key", "sales_team_key", "is_active",
             "holiday_name", "reason", "source", "notes"],
            fact_offdays,
            lambda r: (
                clean_int(r["DateKey"]), r["OffDayType"], r.get("Country"),
                self.company_name_to_key.get(r.get("Company")), r.get("Branch"),
                clean_bool(r.get("IsActive")),
                r.get("HolidayName"), r.get("Reason"), r.get("Source"), r.get("Notes"),
            ),
        )

    def _load_crm(self, sheets):
        fact_lead = sheets["Fact_Lead"].to_dict("records")
        fact_opportunity = sheets["Fact_Opportunity"].to_dict("records")

        self._bulk_insert(
            "fact_lead",
            ["lead_id", "pipeline_record_id", "journey_key", "lead_name", "lead_type",
             "lead_created_date", "lead_created_date_key", "lead_source", "salesperson_key",
             "sales_team_key", "segment_key", "company_key", "customer_key",
             "is_odoo_created_lead", "is_etl_created_lead", "lead_creation_source",
             "is_active_lead", "is_converted_to_opportunity", "opportunity_id", "lead_age_days"],
            fact_lead,
            lambda r: (
                r["LeadID"], r.get("PipelineRecordID"), r.get("JourneyKey"), r["LeadName"],
                r.get("LeadType"), to_dt(r.get("LeadCreatedDate")), clean_int(r.get("LeadCreatedDateKey")),
                r.get("LeadSource"), clean_int(r.get("SalespersonKey")), clean_key(r.get("SalesTeamKey")),
                clean_int(r.get("SegmentKey")), clean_int(r.get("CompanyKey")),
                clean_int(r.get("CustomerKey")) if r.get("CustomerKey") is not None else -1,
                clean_bool(r.get("IsOdooCreatedLead")), clean_bool(r.get("IsETLCreatedLead")),
                r.get("LeadCreationSource"), clean_bool(r.get("IsActiveLead")),
                clean_bool(r.get("IsConvertedToOpportunity")), None, clean_num(r.get("LeadAgeDays")),
            ),
        )
        lead_ids_loaded = {r["LeadID"] for r in fact_lead}
        self.lead_ids_loaded = lead_ids_loaded

        self._bulk_insert(
            "fact_opportunity",
            ["opportunity_id", "lead_id", "journey_key", "pipeline_record_id", "opportunity_name",
             "opportunity_created_date", "opportunity_created_date_key", "expected_close_date",
             "expected_close_date_key", "stage_id", "probability", "expected_revenue",
             "prorated_revenue", "is_active_opportunity", "is_won", "is_lost", "is_open",
             "lost_reason_id", "salesperson_key", "sales_team_key", "segment_key", "company_key",
             "customer_key", "has_quotation", "first_quotation_date", "last_quotation_id",
             "last_quotation_date", "last_quotation_value", "last_quotation_status",
             "days_since_last_quotation", "opportunity_age_days"],
            fact_opportunity,
            lambda r: (
                clean_int(r["OpportunityID"]),
                r["LeadID"] if r.get("LeadID") in lead_ids_loaded else None,
                r.get("JourneyKey"), r.get("PipelineRecordID"), r["OpportunityName"],
                to_dt(r.get("OpportunityCreatedDate")), clean_int(r.get("OpportunityCreatedDateKey")),
                to_date(r.get("ExpectedCloseDate")), clean_int(r.get("ExpectedCloseDateKey")),
                clean_int(r.get("StageID")), clean_num(r.get("Probability")),
                clean_num(r.get("ExpectedRevenue")), clean_num(r.get("ProratedRevenue")),
                clean_bool(r.get("IsActiveOpportunity")), clean_bool(r.get("IsWon")),
                clean_bool(r.get("IsLost")), clean_bool(r.get("IsOpen")),
                clean_int(r.get("LostReasonID")), clean_int(r.get("SalespersonKey")),
                clean_key(r.get("SalesTeamKey")), clean_int(r.get("SegmentKey")),
                clean_int(r.get("CompanyKey")),
                clean_int(r.get("CustomerKey")) if r.get("CustomerKey") is not None else -1,
                clean_bool(r.get("HasQuotation")), to_dt(r.get("FirstQuotationDate")),
                clean_int(r.get("LastQuotationID")), to_dt(r.get("LastQuotationDate")),
                clean_num(r.get("LastQuotationValue")), r.get("LastQuotationStatus"),
                clean_num(r.get("DaysSinceLastQuotation")), clean_num(r.get("OpportunityAge")),
            ),
        )
        self.fact_opportunity_ids = {clean_int(r["OpportunityID"]) for r in fact_opportunity}

    def _load_inventory_and_bcg(self, sheets, snapshot_date):
        fact_inventory = sheets["Fact_Inventory"].to_dict("records")
        fact_bcg = sheets["Fact_BCGMatrix"].to_dict("records")

        self._bulk_insert(
            "fact_inventory_snapshot",
            ["snapshot_date", "product_key", "location_id", "company_key", "location_name",
             "warehouse_name", "on_hand_qty", "reserved_qty", "available_qty", "product_cost",
             "inventory_value", "inventory_status", "days_on_hand", "avg_daily_sales",
             "velocity_class"],
            fact_inventory,
            lambda r: (
                to_date(r.get("SnapshotDate")) or snapshot_date, r["ProductKey"],
                clean_int(r.get("LocationID")), clean_int(r.get("CompanyKey")), r.get("LocationName"),
                r.get("WarehouseName"), clean_num(r.get("OnHandQty")), clean_num(r.get("ReservedQty")),
                clean_num(r.get("AvailableQty")), clean_num(r.get("ProductCost")),
                clean_num(r.get("InventoryValue")), r.get("InventoryStatus"), clean_num(r.get("DOH")),
                clean_num(r.get("Avg_Daily_Sales")), r.get("Velocity_Class"),
            ),
        )
        self._bulk_insert(
            "fact_product_performance_snapshot",
            ["snapshot_date", "product_key", "company_key", "total_quantity_ytd",
             "total_quantity_lytd", "total_value_ytd", "total_value_lytd", "avg_unit_price_ytd",
             "avg_unit_price_lytd", "avg_product_cost_ytd", "avg_product_cost_lytd",
             "perc_gross_profit_ytd", "perc_gross_profit_lytd", "volume_class_ytd",
             "volume_class_lytd", "profit_class_ytd", "profit_class_lytd", "bcg_code_ytd",
             "bcg_code_lytd", "bcg_class_ytd", "bcg_class_lytd", "quantity_growth_pct",
             "gross_profit_change_pp", "bcg_movement"],
            fact_bcg,
            lambda r: (
                snapshot_date, r["ProductKey"], self.company_name_to_key.get(r.get("Company")),
                clean_num(r.get("total_quantity_YTD")), clean_num(r.get("total_quantity_LYTD")),
                clean_num(r.get("total_value_YTD")), clean_num(r.get("total_value_LYTD")),
                clean_num(r.get("avg_unit_price_YTD")), clean_num(r.get("avg_unit_price_LYTD")),
                clean_num(r.get("avg_product_cost_YTD")), clean_num(r.get("avg_product_cost_LYTD")),
                clean_num(r.get("perc_gross_profit_YTD")), clean_num(r.get("perc_gross_profit_LYTD")),
                clean_num(r.get("volume_class_YTD")), clean_num(r.get("volume_class_LYTD")), clean_num(r.get("profit_class_YTD")),
                clean_num(r.get("profit_class_LYTD")), clean_num(r.get("bcg_code_YTD")), clean_num(r.get("bcg_code_LYTD")),
                clean_num(r.get("bcg_class_YTD")), clean_num(r.get("bcg_class_LYTD")), clean_num(r.get("quantity_growth_pct")),
                clean_num(r.get("gross_profit_change_pp")), clean_num(r.get("bcg_movement")),
            ),
        )

    def _load_sales(self, sheets):
        fact_orders = sheets["Fact_Orders"].to_dict("records")
        fact_saleslines = sheets["Fact_SalesLines"].to_dict("records")
        fact_quotation = sheets.get("Fact_Sales", pd.DataFrame()).to_dict("records")
        fact_delivery = sheets.get("Fact_Delivery", pd.DataFrame()).to_dict("records")
        lead_ids = self.lead_ids_loaded
        opp_ids = self.fact_opportunity_ids

        self._bulk_insert(
            "fact_order",
            ["order_key", "invoice_key", "date_key", "order_datetime", "customer_key",
             "salesperson_key", "sales_team_key", "segment_key", "channel_key", "company_key",
             "order_value", "order_volume", "invoice_status", "order_state", "quotation_date",
             "quotation_age_minutes", "is_real_quotation", "is_real_sales_order",
             "is_linked_to_opportunity", "opportunity_id", "lead_id"],
            fact_orders,
            lambda r: (
                r["order_number"], clean_int(r.get("InvoiceKey")), clean_int(r.get("DateKey")),
                to_dt(r.get("OrderDateTime")), clean_int(r.get("CustomerKey")),
                clean_int(r.get("SalespersonKey")), clean_key(r.get("SalesTeamKey")),
                clean_int(r.get("SegmentKey")), clean_int(r.get("ChannelKey")), clean_int(r.get("CompanyKey")),
                clean_num(r.get("OrderValue")), clean_num(r.get("OrderVolume")), r.get("invoice_status"),
                r.get("order_state"), to_dt(r.get("QuotationDate")), clean_int(r.get("QuotationAgeMinutes")),
                clean_bool(r.get("IsRealQuotation")), clean_bool(r.get("IsRealSalesOrder")),
                clean_bool(r.get("IsLinkedToOpportunity")),
                clean_int(r.get("OpportunityID")) if r.get("OpportunityID") in opp_ids else None,
                r.get("LeadID") if r.get("LeadID") in lead_ids else None,
            ),
        )
        order_keys_loaded = {r["order_number"] for r in fact_orders}
        self.order_keys_loaded = order_keys_loaded

        self._bulk_insert(
            "fact_order_line",
            ["order_key", "invoice_key", "date_key", "customer_key", "salesperson_key",
             "sales_team_key", "segment_key", "channel_key", "company_key", "product_key",
             "quantity", "line_value", "invoice_value", "invoice_class", "is_discount",
             "invoice_status", "customer_status_at_sale"],
            fact_saleslines,
            lambda r: None if r.get("order_number") not in order_keys_loaded else (
                r["order_number"], clean_int(r.get("InvoiceKey")), clean_int(r.get("DateKey")),
                clean_int(r.get("CustomerKey")), clean_int(r.get("SalespersonKey")),
                clean_key(r.get("SalesTeamKey")), clean_int(r.get("SegmentKey")),
                clean_int(r.get("ChannelKey")), clean_int(r.get("CompanyKey")), r.get("ProductKey"),
                clean_num(r.get("quantity")), clean_num(r.get("line_total")), clean_num(r.get("InvoiceValue")),
                r.get("Invoice Class") if r.get("Invoice Class") in ("A", "B", "C", "D") else None,
                clean_bool(r.get("is_discount")), r.get("invoice_status"), r.get("CustomerStatus"),
            ),
        )

        if fact_quotation:
            self._bulk_insert(
                "fact_quotation",
                ["quotation_id", "sales_document_type", "order_key", "invoice_key", "journey_key",
                 "quotation_date", "sales_order_date", "quotation_age_minutes", "date_key",
                 "customer_key", "salesperson_key", "sales_team_key", "segment_key", "channel_key",
                 "company_key", "opportunity_id", "lead_id", "is_real_quotation", "is_won_quotation",
                 "quotation_classification", "is_real_sales_order", "sales_order_classification",
                 "is_linked_to_opportunity", "order_value", "order_volume", "invoice_status",
                 "order_state"],
                fact_quotation,
                lambda r: (
                    clean_int(r.get("SalesDocumentID")), r.get("SalesDocumentType"),
                    r.get("OrderNumber") if r.get("OrderNumber") in order_keys_loaded else None,
                    clean_int(r.get("InvoiceKey")), r.get("JourneyKey"), to_dt(r.get("QuotationDate")),
                    to_dt(r.get("SalesOrderDate")), clean_int(r.get("QuotationAgeMinutes")),
                    clean_int(r.get("DateKey")),
                    clean_int(r.get("CustomerKey")) if r.get("CustomerKey") is not None else -1,
                    clean_int(r.get("SalespersonKey")), clean_key(r.get("SalesTeamKey")),
                    clean_int(r.get("SegmentKey")), clean_int(r.get("ChannelKey")), clean_int(r.get("CompanyKey")),
                    clean_int(r.get("OpportunityID")) if r.get("OpportunityID") in opp_ids else None,
                    r.get("LeadID") if r.get("LeadID") in lead_ids else None,
                    clean_bool(r.get("IsRealQuotation")), clean_bool(r.get("IsWonQuotation")),
                    clean_num(r.get("QuotationClassification")), clean_bool(r.get("IsRealSalesOrder")),
                    clean_num(r.get("SalesOrderClassification")), clean_bool(r.get("IsLinkedToOpportunity")),
                    clean_num(r.get("OrderValue")), clean_num(r.get("OrderVolume")), clean_num(r.get("InvoiceStatus")),
                    clean_num(r.get("OrderState")),
                ),
            )
        self.cur.execute("SELECT quotation_id FROM fact_quotation")
        quotation_ids_loaded = {row[0] for row in self.cur.fetchall()}

        if fact_delivery:
            self._bulk_insert(
                "fact_delivery",
                ["delivery_fact_id", "picking_id", "delivery_reference", "order_key", "quotation_id",
                 "opportunity_id", "lead_id", "customer_key", "salesperson_key", "sales_team_key",
                 "segment_key", "company_key", "order_date_key", "scheduled_datetime",
                 "scheduled_date_key", "done_datetime", "done_date_key", "delivery_datetime",
                 "delivery_status", "is_real_delivery", "delivery_classification", "picking_state",
                 "ordered_quantity", "delivered_quantity", "remaining_quantity",
                 "delivery_progress_percent"],
                fact_delivery,
                lambda r: (
                    clean_num(r.get("DeliveryFactID")), clean_int(r.get("PickingID")), clean_num(r.get("DeliveryReference")),
                    r.get("OrderNumber") if r.get("OrderNumber") in order_keys_loaded else None,
                    clean_int(r.get("QuotationID")) if clean_int(r.get("QuotationID")) in quotation_ids_loaded else None,
                    clean_int(r.get("OpportunityID")) if r.get("OpportunityID") in opp_ids else None,
                    r.get("LeadID") if r.get("LeadID") in lead_ids else None,
                    clean_int(r.get("CustomerKey")) if r.get("CustomerKey") is not None else -1,
                    clean_int(r.get("SalespersonKey")), clean_key(r.get("SalesTeamKey")),
                    clean_int(r.get("SegmentKey")), clean_int(r.get("CompanyKey")), clean_int(r.get("OrderDateKey")),
                    to_dt(r.get("ScheduledDate")), clean_int(r.get("ScheduledDateKey")), to_dt(r.get("DoneDate")),
                    clean_int(r.get("DoneDateKey")), to_dt(r.get("DeliveryDate")), clean_num(r.get("DeliveryStatus")),
                    clean_bool(r.get("IsRealDelivery")), clean_num(r.get("DeliveryClassification")), clean_num(r.get("PickingState")),
                    clean_num(r.get("OrderedQuantity")), clean_num(r.get("DeliveredQuantity")),
                    clean_num(r.get("RemainingQuantity")), clean_num(r.get("DeliveryProgressPercent")),
                ),
            )
