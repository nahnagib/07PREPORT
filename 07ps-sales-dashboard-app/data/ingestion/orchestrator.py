"""Ties together Odoo extraction, the vendored pipeline's transform logic, and the star-schema
loader into one refresh run - the "replace only the final export step" integration this session's
kickoff prompt asked for.

Sequence (mirrors ``PowerBISalesPipeline.run()`` step-for-step through its transform phase - see
vendor/sales_pipeline_src/sales_pipeline/pipeline.py lines 223-430 - then diverges only at the
final export, which the vendored ``run()`` would otherwise send to a flat/denormalized MySQL
schema or an Excel workbook):

  1. odoo.extract.extract_all()          - mocked by default; real Odoo gated behind ALLOW_LIVE_ODOO=1
  2. input_sheets.settings_factory       - resolves and validates INPUT_DIR (manual Excel sheets)
  3. pipeline.transform(...)             - UNMODIFIED vendored business logic (product mastering,
                                            sales cleaning, dimension building, BCG matrix, etc.)
  4. pipeline.transform_crm(...)         - UNMODIFIED vendored CRM logic (quotation classification,
                                            customer status, won/lost/open, synthetic ETL leads)
  5. the same post-transform merge steps run() itself performs (sheets.update(crm_sheets),
     _align_fact_orders_with_fact_sales, _ensure_fact_orders_order_key,
     _extend_dim_date_for_sales_and_delivery, _validate_model_key_integrity, ModelValidator) -
     called directly on the same pipeline instance, not reimplemented
  6. star_schema.loader.StarSchemaLoader - the ONLY genuinely new step; replaces run()'s own
     DatabaseExporter.export()/export_incremental() flat-table write
  7. pipeline_run_log / pipeline_run_audit rows written - adopting the vendored schema (see
     data/warehouse/migrations/0007_etl_and_audit_log.sql), not a bespoke logging table

Zero business-rule code was rewritten to build this. See README.md for what "report, don't
silently fix" means in this context: any exception here aborts the run and is logged into
pipeline_run_log with status=FAILED rather than partially loading the warehouse.
"""
from __future__ import annotations

import datetime
import json
import logging
import os
import time
import warnings

import pandas as pd
import pymysql

from input_sheets.settings_factory import build_settings
from odoo.extract import extract_all
from sales_pipeline.pipeline import PowerBISalesPipeline
from star_schema.loader import StarSchemaLoader

logger = logging.getLogger(__name__)


def _db_connect() -> pymysql.connections.Connection:
    return pymysql.connect(
        host=os.environ.get("DB_HOST", "localhost"),
        port=int(os.environ.get("DB_PORT", "3306")),
        user=os.environ.get("DB_USER", "root"),
        password=os.environ.get("DB_PASSWORD", ""),
        database=os.environ.get("DB_NAME", "ps_warehouse"),
        unix_socket=os.environ.get("DB_SOCKET") or None,
        autocommit=False,
        charset="utf8mb4",
    )


def _write_run_log(
    conn: pymysql.connections.Connection,
    started_at: datetime.datetime,
    finished_at: datetime.datetime,
    status: str,
    error_message: str | None,
    odoo_extract_count: int,
    db_loaded_count: int,
    qa_issues_count: int,
    scheduled_refresh_time: str | None,
) -> int:
    """Writes one row to pipeline_run_log - schema adopted verbatim from the vendored pipeline's
    own database_exporter.py (see migrations/0007_etl_and_audit_log.sql header note).
    """
    cur = conn.cursor()
    cur.execute(
        """INSERT INTO pipeline_run_log
           (scheduled_refresh_time, pipeline_start_time, pipeline_end_time, total_duration_minutes,
            status, error_message, odoo_extract_count, db_loaded_count, qa_issues_count)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
        (
            scheduled_refresh_time, started_at, finished_at,
            (finished_at - started_at).total_seconds() / 60.0,
            status, (error_message or "")[:2000] if error_message else None,
            odoo_extract_count, db_loaded_count, qa_issues_count,
        ),
    )
    conn.commit()
    return cur.lastrowid


def _write_run_audit(
    conn: pymysql.connections.Connection,
    started_at: datetime.datetime,
    finished_at: datetime.datetime,
    status: str,
    error_message: str | None,
    row_counts: dict[str, int],
    odoo_source: str,
) -> None:
    """Writes one row to pipeline_run_audit - same adopted schema. load_mode is always "full" for
    this loader (see star_schema/loader.py docstring); output_mode records where data actually
    came from (mock vs live Odoo) since that matters more here than the vendored pipeline's own
    excel/sql/both distinction.
    """
    cur = conn.cursor()
    cur.execute(
        """INSERT INTO pipeline_run_audit
           (started_at, finished_at, load_mode, output_mode, status, error_message, row_counts_json)
           VALUES (%s, %s, %s, %s, %s, %s, %s)""",
        (
            started_at, finished_at, "full", f"star_schema_mysql(odoo_source={odoo_source})",
            status, (error_message or "")[:2000] if error_message else None,
            json.dumps(row_counts),
        ),
    )
    conn.commit()


def run_refresh(scheduled_refresh_time: str | None = None) -> dict:
    """One full refresh cycle. Returns a small summary dict; raises on failure (after logging a
    FAILED row to pipeline_run_log/pipeline_run_audit) - callers (scheduler_new.py, or a manual
    invocation) decide what to do with a raised exception, this function does not swallow one.
    """
    started_at = datetime.datetime.now()
    conn = None
    try:
        warnings.filterwarnings("ignore")
        settings = build_settings()
        pipeline = PowerBISalesPipeline(settings)

        logger.info("Extracting from Odoo...")
        data = extract_all(batch_size=settings.batch_size)

        logger.info("Running vendored transform() [sales/dimensions/inventory/BCG]...")
        sheets = pipeline.transform(
            data.sales_raw,
            include_qa=True,
            use_reference_cache=False,
            product_cost_raw=data.product_cost_raw,
            stock_quants_raw=data.stock_quants_raw,
            stock_locations_raw=data.stock_locations_raw,
            inventory_companies_raw=data.inventory_companies_raw,
        )

        logger.info("Running vendored transform_crm() [lead/opportunity/quotation/delivery]...")
        crm_sheets, crm_summary = pipeline.transform_crm(
            leads_raw=data.leads_raw,
            stages_raw=data.stages_raw,
            lost_reasons_raw=data.lost_reasons_raw,
            sale_orders_raw=data.sale_orders_raw,
            stock_pickings_raw=data.stock_pickings_raw,
            stock_moves_raw=data.stock_moves_raw,
            field_availability=data.field_availability,
            fact_orders=sheets["Fact_Orders"],
            dim_customer=sheets["Dim_Customer"],
            dim_salesteam=sheets["Dim_SalesTeam"],
            dim_salesperson=sheets["Dim_Salesperson"],
            dim_company=sheets["Dim_Company"],
            dim_channel=sheets["Dim_DistributionChannel"],
            dim_segment=sheets["Dim_Segment"],
            dim_invoice=sheets["Dim_Invoice"],
            include_qa=True,
        )
        sheets.update(crm_sheets)

        # Same post-merge steps run() performs before its own export (pipeline.py ~lines 408-419) -
        # called on the same pipeline instance so nothing is reimplemented.
        sheets["Fact_Orders"] = pipeline._align_fact_orders_with_fact_sales(
            sheets["Fact_Orders"], sheets.get("Fact_Sales", pd.DataFrame())
        )
        sheets["Fact_Orders"] = pipeline._ensure_fact_orders_order_key(sheets["Fact_Orders"])
        refresh_date = pd.Timestamp.now(tz=settings.timezone).date()
        sheets["Dim_Date"] = pipeline._extend_dim_date_for_sales_and_delivery(sheets, refresh_date=refresh_date)
        pipeline._validate_model_key_integrity(sheets, refresh_date=refresh_date)

        odoo_extract_count = (
            len(data.sales_raw) + len(data.leads_raw) + len(data.sale_orders_raw)
            + len(data.stock_pickings_raw) + len(data.stock_moves_raw)
            + len(data.product_cost_raw) + len(data.stock_quants_raw)
        )
        qa_issues_count = crm_summary.qa_issues_count if hasattr(crm_summary, "qa_issues_count") else 0

        logger.info("Loading into MySQL star schema...")
        conn = _db_connect()
        loader = StarSchemaLoader(conn)
        report = loader.load_all(sheets, snapshot_date=refresh_date)

        finished_at = datetime.datetime.now()
        status = "SUCCESS" if report.clean else "SUCCESS_WITH_ROW_ERRORS"
        error_message = None
        if not report.clean:
            error_message = (
                f"{report.total_errors} row(s) across "
                f"{[t for t in report.errors]} failed to load - see application logs for detail. "
                "Reported, not silently dropped or coerced."
            )
            logger.warning(error_message)

        _write_run_log(
            conn, started_at, finished_at, status, error_message,
            odoo_extract_count, report.total_inserted, qa_issues_count, scheduled_refresh_time,
        )
        _write_run_audit(
            conn, started_at, finished_at, status, error_message, report.inserted, data.source,
        )
        conn.close()

        logger.info(
            "Refresh complete: status=%s odoo_source=%s rows_loaded=%d errors=%d duration_min=%.2f",
            status, data.source, report.total_inserted, report.total_errors,
            (finished_at - started_at).total_seconds() / 60.0,
        )
        return {
            "status": status,
            "odoo_source": data.source,
            "rows_loaded": report.total_inserted,
            "row_errors": report.total_errors,
            "duration_minutes": (finished_at - started_at).total_seconds() / 60.0,
        }

    except Exception as exc:  # noqa: BLE001 - report, don't silently fix (per session standard)
        finished_at = datetime.datetime.now()
        logger.exception("Refresh FAILED: %s", exc)
        try:
            if conn is None:
                conn = _db_connect()
            _write_run_log(
                conn, started_at, finished_at, "FAILED", str(exc), 0, 0, 0, scheduled_refresh_time,
            )
            _write_run_audit(conn, started_at, finished_at, "FAILED", str(exc), {}, "unknown")
            conn.close()
        except Exception:  # noqa: BLE001 - logging failure must never mask the original error
            logger.exception("Additionally failed to write the FAILED run to pipeline_run_log/audit.")
        raise


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    result = run_refresh()
    print(result)
