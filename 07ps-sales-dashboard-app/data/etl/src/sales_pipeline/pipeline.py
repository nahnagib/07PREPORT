from __future__ import annotations

import logging
import hashlib
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Callable, Literal

import pandas as pd
from sqlalchemy import inspect, text

from config.settings import Settings
from sales_pipeline.cleaning import DataFrameUtils, ProductMapper, SalesCleaner, SalesOrgEnricher
from sales_pipeline.dimensions import (
    CompanyDimensionBuilder,
    CrmStageDimensionBuilder,
    CustomerDimensionBuilder,
    DateDimensionBuilder,
    DistributionChannelDimensionBuilder,
    InvoiceDimensionBuilder,
    LostReasonDimensionBuilder,
    ProductDimensionBuilder,
    SalesTeamDimensionBuilder,
    SalespersonDimensionBuilder,
    SegmentDimensionBuilder,
)
from sales_pipeline.export import DatabaseExporter, InventoryValidationExporter, SQLExportResult, WorkbookExporter
from sales_pipeline.crm.active_flags import coerce_nullable_bool
from sales_pipeline.facts import (
    DeliveryFactBuilder,
    LeadFactBuilder,
    OffDaysFactBuilder,
    OpportunityFactBuilder,
    OrdersFactBuilder,
    PipelineFactBuilder,
    SalesFactBuilder,
    SalesLinesFactBuilder,
    TargetsFactBuilder,
)
from sales_pipeline.facts.quotation_classification import add_delivery_classification, add_quotation_classification, add_quotation_outcome_flags, add_sales_order_classification
from sales_pipeline.crm import CrmCleaner, CrmModelBuilder, CrmValidationSummary
from sales_pipeline.inventory import InventoryModelBuilder, InventoryRepository
from sales_pipeline.legacy_transform import (
    BCGMatrixBuilder,
    BlockedCustomersLoader,
    Logger as LegacyLogger,
    PipelineSettings,
    ProductActiveFlagReconciler,
    ProductMasterLoader,
    ProductCostDimensionBuilder,
    ProductCostMatcher,
    SALES_COLUMN_MAP,
    SalesOrgRepository,
    TargetsLoader,
)
from sales_pipeline.odoo import CrmRepository, OdooClient, ProductCostRepository, SaleOrderLineRepository, SaleOrderRepository, SalesReportRepository, StockMoveRepository, StockPickingRepository
from sales_pipeline.odoo.sales_report_repository import odoo_utc_datetime_to_local
from sales_pipeline.qa import QAService
from sales_pipeline.runtime import PipelineRunContext
from sales_pipeline.reference_cache import ReferenceDataCache
from sales_pipeline.staging import StagingStore, odoo_incremental_domain
from sales_pipeline.validation import ModelValidator
from sales_pipeline.product_name_mapper import ProductNameMapper


REQUIRED_INPUT_FILES = [
    "sales_targets.xlsx",
    "SalesTeam.xlsx",
    "OffDays.xlsx",
    "PRODUCTS.xlsx",
]

REQUIRED_OUTPUT_SHEETS = [
    "Fact_SalesLines",
    "Fact_BCGMatrix",
    "Fact_Orders",
    "Fact_Targets",
    "Fact_OffDays",
    "Fact_Inventory",
    "Dim_Date",
    "Dim_Customer",
    "Dim_Salesperson",
    "Dim_SalesTeam",
    "Dim_Company",
    "Dim_Product",
    "Dim_ProductCost",
    "Dim_DistributionChannel",
    "Dim_Segment",
    "Dim_Invoice",
    "QA_MissingProductCost",
    "Fact_Lead",
    "Fact_Opportunity",
    "Fact_Sales",
    "Fact_Delivery",
    "Dim_CRMStage",
    "Dim_LostReason",
    "QA_CRM_MissingLinks",
    "QA_CRM_DataQuality",
    "QA_CRM_UnmappedKeys",
    "QA_CRM_FieldAvailability",
    "QA_Inventory_DataQuality",
]

CRM_OUTPUT_SHEETS = [
    "Fact_Lead",
    "Fact_Opportunity",
    "Fact_Sales",
    "Fact_Delivery",
    "Dim_CRMStage",
    "Dim_LostReason",
    "QA_CRM_MissingLinks",
    "QA_CRM_DataQuality",
    "QA_CRM_UnmappedKeys",
    "QA_CRM_FieldAvailability",
]

OutputMode = Literal["excel", "sql", "both"]
LoadMode = Literal["full", "incremental"]


@dataclass(frozen=True)
class PipelineRunResult:
    output_mode: OutputMode
    load_mode: LoadMode
    workbook_path: Path | None
    sql_result: SQLExportResult | None
    sheet_counts: dict[str, int]
    crm_summary: CrmValidationSummary
    total_duration_minutes: float
    full_refresh: bool
    force: bool
    force_sales_full_refresh: bool


class PowerBISalesPipeline:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.logger = logging.getLogger(__name__)
        self.legacy_logger = LegacyLogger(enabled=True)
        self.pipeline_settings = PipelineSettings(verbose=True)
        self._latest_odoo_sale_order_start: dict[str, Any] = {}
        self._latest_odoo_sale_order_end: dict[str, Any] = {}
        # Centralized product-name mapper — loaded once, reused every transform run.
        self.mapper = ProductNameMapper(settings.products_path)
        self.logger.info(
            "ProductNameMapper ready — %d Odoo→clean mappings loaded from %s",
            self.mapper.mapping_count(),
            settings.products_path,
        )

    def run(
        self,
        output_mode: OutputMode = "excel",
        load_mode: LoadMode = "full",
        scheduled_refresh_time: str | None = None,
        force: bool = False,
        full_refresh: bool = False,
        force_sales_full_refresh: bool = False,
        odoo_cutoff_utc: str | None = None,
        full_validation: bool = False,
        include_qa: bool = False,
        fast: bool = False,
        strict: bool = False,
        validation_baseline: str | Path | None = None,
        write_validation_baseline: str | Path | None = None,
    ) -> PipelineRunResult:
        run_context = PipelineRunContext(scheduled_refresh_time=scheduled_refresh_time)
        odoo_extract_count = 0
        db_loaded_count = 0
        qa_issues_count = 0
        crm_summary = CrmValidationSummary()
        sql_result: SQLExportResult | None = None
        workbook_path: Path | None = None
        sheets: dict[str, pd.DataFrame] = {}
        stock_quants_raw = pd.DataFrame()
        stock_locations_raw = pd.DataFrame()
        inventory_companies_raw = pd.DataFrame()
        if output_mode not in {"excel", "sql", "both"}:
            raise ValueError("output_mode must be one of: excel, sql, both")
        if load_mode not in {"full", "incremental"}:
            raise ValueError("load_mode must be one of: full, incremental")
        if full_refresh:
            load_mode = "full"
        if fast:
            if load_mode != "incremental":
                self.logger.warning("--fast is only supported for incremental mode; continuing with normal %s mode", load_mode)
            elif output_mode != "sql":
                self.logger.info("--fast selected; switching output mode from %s to sql", output_mode)
                output_mode = "sql"
        if load_mode == "incremental" and output_mode == "excel":
            raise ValueError("Incremental mode requires SQL cache/staging. Use --output sql or --output both.")
        include_qa_outputs = include_qa or full_validation or not (load_mode == "incremental" and output_mode == "sql")
        if fast:
            include_qa_outputs = False
        latest_order_before: tuple[Any, Any] | None = None
        latest_order_after: tuple[Any, Any] | None = None
        effective_odoo_cutoff_utc: pd.Timestamp | None = self._parse_odoo_cutoff_utc(odoo_cutoff_utc)
        incremental_since_utc: pd.Timestamp | None = None
        metadata_exporter: DatabaseExporter | None = None
        try:
            with run_context.step("validate_config_and_inputs"):
                self.settings.validate(require_database=output_mode in {"sql", "both"} or load_mode == "incremental")
                self._validate_inputs()
                self.settings.output_dir.mkdir(parents=True, exist_ok=True)
                self.logger.info("Pipeline load mode: %s", load_mode.upper())
                self.logger.info("Pipeline output mode: %s", output_mode.upper())
                self.logger.info("Pipeline fast mode: %s", fast)
                self.logger.info("Pipeline QA outputs enabled: %s", include_qa_outputs)
                if output_mode == "sql":
                    self.logger.info("SQL-only output selected; skipping Excel workbook export and final Excel/SQL validation")

            if output_mode in {"sql", "both"} or load_mode == "incremental":
                with run_context.step("read_sql_incremental_metadata"):
                    metadata_exporter = DatabaseExporter(self.settings)
                    latest_order_before = self._latest_sql_order_tuple(metadata_exporter)
                    if load_mode == "incremental":
                        incremental_since_utc = self._incremental_cutoff_from_sql(latest_order_before)
                    self._audit_excel_sources(metadata_exporter, load_mode)

            with run_context.step("odoo_authenticate"):
                self.logger.info("Connecting to Odoo")
                client = OdooClient(
                    url=self.settings.odoo_url,
                    db=self.settings.odoo_db,
                    username=self.settings.odoo_user,
                    api_key=self.settings.odoo_api_key,
                    timeout_seconds=self.settings.rpc_timeout_seconds,
                    max_retries=self.settings.max_retries,
                )
                client.authenticate()

            with run_context.step("extract_product_cost_and_inventory"):
                # product.product costs and the 3 inventory models are fully
                # independent — extract them in parallel to save ~1-2 minutes.
                self.logger.info("Fetching product costs and inventory models (parallel)")
                _uid_early = client.uid
                _bs_early = self.settings.batch_size

                product_cost_repo = ProductCostRepository(self._make_odoo_client(_uid_early), _bs_early)
                _inv_quants_r = InventoryRepository(self._make_odoo_client(_uid_early), _bs_early)
                _inv_locs_r = InventoryRepository(self._make_odoo_client(_uid_early), _bs_early)
                _inv_comp_r = InventoryRepository(self._make_odoo_client(_uid_early), _bs_early)

                _early_tasks: dict[str, Callable[[], pd.DataFrame]] = {
                    "product.product": product_cost_repo.fetch_product_costs,
                    "stock.quant": _inv_quants_r.fetch_stock_quants,
                    "stock.location": _inv_locs_r.fetch_locations,
                    "res.company": _inv_comp_r.fetch_companies,
                }
                _early_started = time.perf_counter()
                _early_fetched = self._parallel_odoo_fetch(_early_tasks, uid=_uid_early, max_workers=4)
                self.logger.info(
                    "PERF extract_product_cost_and_inventory parallel_total duration_seconds=%.2f",
                    time.perf_counter() - _early_started,
                )

                product_cost_raw = _early_fetched["product.product"]
                stock_quants_raw = _early_fetched["stock.quant"]
                stock_locations_raw = _early_fetched["stock.location"]
                inventory_companies_raw = _early_fetched["res.company"]

                self.logger.info("Odoo extraction product.product costs rows=%s", len(product_cost_raw))
                self.logger.info("Odoo stock.quant rows extracted=%s", len(stock_quants_raw))
                odoo_extract_count += len(product_cost_raw) + len(stock_quants_raw) + len(stock_locations_raw) + len(inventory_companies_raw)

            # Full mode keeps the proven workbook path. Incremental mode uses
            # SQL-backed staging and then rebuilds the same final sheet dict.
            use_staging = load_mode == "incremental"
            if use_staging:
                with run_context.step("sync_incremental_staging"):
                    (
                        sales_raw,
                        leads_raw,
                        stages_raw,
                        lost_reasons_raw,
                        sale_orders_raw,
                        stock_pickings_raw,
                        stock_moves_raw,
                        field_availability,
                        changed_count,
                        effective_full_refresh,
                    ) = self._sync_and_read_staging(
                        client,
                        requested_full_refresh=full_refresh,
                        force=force,
                        force_sales_full_refresh=force_sales_full_refresh,
                        odoo_cutoff_utc=str(effective_odoo_cutoff_utc) if effective_odoo_cutoff_utc is not None else None,
                        incremental_since_utc=incremental_since_utc,
                    )
                    odoo_extract_count += changed_count
                    full_refresh = effective_full_refresh
                    sale_report_cache_started = time.perf_counter()
                    sales_raw = self._sync_incremental_sale_report_cache(
                        client=client,
                        since_utc=incremental_since_utc,
                        cutoff_utc=effective_odoo_cutoff_utc,
                    )
                    self.logger.info("sale.report cache refresh completed rows=%s duration_seconds=%.2f", len(sales_raw), time.perf_counter() - sale_report_cache_started)
            else:
                with run_context.step("extract_sale_report"):
                    self.logger.info("Fetching sale.report")
                    extract_started = time.perf_counter()
                    sales_raw = SalesReportRepository(
                        client=client,
                        batch_size=self.settings.batch_size,
                        timezone=self.settings.timezone,
                        assume_utc_for_naive=self.settings.assume_utc_for_naive,
                    ).fetch_sale_report()
                    self.logger.info("Odoo extraction sale.report rows=%s duration_seconds=%.2f", len(sales_raw), time.perf_counter() - extract_started)
                    odoo_extract_count += len(sales_raw)
                    if output_mode in {"sql", "both"}:
                        cache_started = time.perf_counter()
                        self._replace_sale_report_cache(sales_raw)
                        self.logger.info("sale.report cache refresh completed rows=%s duration_seconds=%.2f", len(sales_raw), time.perf_counter() - cache_started)

                with run_context.step("extract_crm_models"):
                    self.logger.info("Fetching CRM models (parallel)")
                    _uid = client.uid
                    _bs = self.settings.batch_size

                    # One OdooClient (own transport) and one repo instance per model.
                    # This avoids both shared-socket races and shared field_availability
                    # mutation races — each instance is written by exactly one thread.
                    _crm_leads_r = CrmRepository(self._make_odoo_client(_uid), _bs)
                    _crm_stages_r = CrmRepository(self._make_odoo_client(_uid), _bs)
                    _crm_lost_r = CrmRepository(self._make_odoo_client(_uid), _bs)
                    order_repo = SaleOrderRepository(self._make_odoo_client(_uid), _bs)
                    picking_repo = StockPickingRepository(self._make_odoo_client(_uid), _bs)
                    move_repo = StockMoveRepository(self._make_odoo_client(_uid), _bs)

                    _tasks: dict[str, Callable[[], pd.DataFrame]] = {
                        "crm.lead": _crm_leads_r.fetch_leads,
                        "crm.stage": _crm_stages_r.fetch_stages,
                        "crm.lost.reason": _crm_lost_r.fetch_lost_reasons,
                        "sale.order": order_repo.fetch_orders,
                        "stock.picking": picking_repo.fetch_pickings,
                        "stock.move": move_repo.fetch_moves,
                    }

                    _parallel_started = time.perf_counter()
                    _fetched = self._parallel_odoo_fetch(_tasks, uid=_uid)
                    self.logger.info(
                        "PERF extract_crm_models parallel_total duration_seconds=%.2f",
                        time.perf_counter() - _parallel_started,
                    )

                    leads_raw = _fetched["crm.lead"]
                    stages_raw = _fetched["crm.stage"]
                    lost_reasons_raw = _fetched["crm.lost.reason"]
                    sale_orders_raw = _fetched["sale.order"]
                    stock_pickings_raw = _fetched["stock.picking"]
                    stock_moves_raw = _fetched["stock.move"]

                    # Merge field_availability from all per-model repo instances
                    field_availability = pd.concat(
                        [
                            _crm_leads_r.field_availability,
                            _crm_stages_r.field_availability,
                            _crm_lost_r.field_availability,
                            order_repo.field_availability,
                            picking_repo.field_availability,
                            move_repo.field_availability,
                        ],
                        ignore_index=True,
                    )
                    odoo_extract_count += len(leads_raw) + len(stages_raw) + len(lost_reasons_raw) + len(sale_orders_raw) + len(stock_pickings_raw) + len(stock_moves_raw)

            field_availability = pd.concat(
                [field_availability, product_cost_repo.field_availability],
                ignore_index=True,
            )

            with run_context.step("transform_sales_model"):
                sheets = self.transform(
                    sales_raw,
                    include_qa=include_qa_outputs,
                    use_reference_cache=True,
                    product_cost_raw=product_cost_raw,
                    stock_quants_raw=stock_quants_raw,
                    stock_locations_raw=stock_locations_raw,
                    inventory_companies_raw=inventory_companies_raw,
                    sale_orders_raw=sale_orders_raw,
                )
                if metadata_exporter is not None:
                    self._write_excel_source_metadata(metadata_exporter, load_mode)

            with run_context.step("transform_crm_model"):
                crm_sheets, crm_summary = self.transform_crm(
                    leads_raw=leads_raw,
                    stages_raw=stages_raw,
                    lost_reasons_raw=lost_reasons_raw,
                    sale_orders_raw=sale_orders_raw,
                    stock_pickings_raw=stock_pickings_raw,
                    stock_moves_raw=stock_moves_raw,
                    field_availability=field_availability,
                    fact_orders=sheets["Fact_Orders"],
                    dim_customer=sheets["Dim_Customer"],
                    dim_salesteam=sheets["Dim_SalesTeam"],
                    dim_salesperson=sheets["Dim_Salesperson"],
                    dim_company=sheets["Dim_Company"],
                    dim_channel=sheets["Dim_DistributionChannel"],
                    dim_segment=sheets["Dim_Segment"],
                    dim_invoice=sheets["Dim_Invoice"],
                    include_qa=include_qa_outputs,
                )
                sheets.update(crm_sheets)
                sheets["Fact_Orders"] = self._align_fact_orders_with_fact_sales(sheets["Fact_Orders"], sheets.get("Fact_Sales", pd.DataFrame()))
                sheets["Fact_Orders"] = self._ensure_fact_orders_order_key(sheets["Fact_Orders"])
                refresh_date = pd.Timestamp.now(tz=self.settings.timezone).date()
                sheets["Dim_Date"] = self._extend_dim_date_for_sales_and_delivery(sheets, refresh_date=refresh_date)
                self._validate_model_key_integrity(sheets, refresh_date=refresh_date)
                structural_issues = ModelValidator.validate(sheets, strict=strict)
                for issue in structural_issues:
                    log = self.logger.error if issue.severity == "ERROR" else self.logger.warning
                    log("Model validation %s: table=%s check=%s details=%s", issue.severity, issue.table, issue.check, issue.details)
                ModelValidator.raise_for_errors(structural_issues)
                validation_manifest = ModelValidator.manifest(sheets)
                if validation_baseline:
                    differences = ModelValidator.compare_manifest(Path(validation_baseline), validation_manifest)
                    for difference in differences:
                        self.logger.warning("Full/incremental comparison: %s", difference)
                    if strict and differences:
                        raise RuntimeError("Validation baseline comparison failed: " + "; ".join(differences))
                if write_validation_baseline:
                    ModelValidator.write_manifest(Path(write_validation_baseline), validation_manifest)
                    self.logger.info("Validation baseline written: %s", write_validation_baseline)
                qa_issues_count = crm_summary.qa_issues_count
                self._validate_output_sheets(sheets, include_qa=include_qa_outputs)

            if output_mode in {"excel", "both"}:
                with run_context.step("export_excel_workbook"):
                    workbook_path = WorkbookExporter(self.legacy_logger).export(sheets, self.settings.output_path)
                    self.logger.info("Workbook exported: %s", workbook_path)

                with run_context.step("export_inventory_validation"):
                    inventory_validation_exporter = InventoryValidationExporter()
                    inventory_validation_path = inventory_validation_exporter.export(
                        sheets["Fact_Inventory"],
                        sheets["Dim_Product"],
                        self.settings.inventory_validation_path,
                    )
                    self.logger.info("Inventory validation workbook exported: %s", inventory_validation_path)
                    unmapped_products_path = inventory_validation_exporter.export_unmapped_products(
                        sheets["Fact_Inventory"],
                        sheets["Dim_Product"],
                        self.settings.unmapped_products_path,
                    )
                    self.logger.info("Unmapped products workbook exported: %s", unmapped_products_path)

            if output_mode in {"sql", "both"}:
                with run_context.step("load_database_and_validate"):
                    exporter = DatabaseExporter(self.settings)
                    cutoff_local = self._local_cutoff_from_utc(incremental_since_utc)
                    incremental_sql = load_mode == "incremental"
                    sql_export_started = time.perf_counter()
                    sql_result = exporter.export_incremental(sheets, cutoff_local) if incremental_sql else exporter.export(sheets)
                    self.logger.info("SQL table load phase completed duration_seconds=%.2f", time.perf_counter() - sql_export_started)
                    validation_started = time.perf_counter()
                    self._log_sql_validation(sql_result)
                    if not sql_result.mismatches.empty:
                        raise RuntimeError(self._sql_row_count_error_message(sql_result))
                    if incremental_sql and not full_validation:
                        self._validate_incremental_sql_window(exporter, sheets, cutoff_local)
                    else:
                        self._validate_sql_matches_final_dataframes(exporter, sheets)
                    self.logger.info("SQL validation phase completed duration_seconds=%.2f", time.perf_counter() - validation_started)
                    self._log_sales_date_validation(exporter)
                    self._validate_sales_freshness(exporter)
                    if output_mode == "both" and workbook_path is not None:
                        self._validate_excel_matches_sql_output(workbook_path, exporter, sheets)
                    elif output_mode == "sql":
                        self.logger.info("Final Excel/SQL validation skipped: SQL-only output did not export a workbook")
                    db_loaded_count = sum(sql_result.table_counts.values())
                    latest_order_after = self._latest_sql_order_tuple(exporter)

            run_context.finish("SUCCESS")
            if output_mode in {"sql", "both"}:
                audit_exporter = DatabaseExporter(self.settings)
                try:
                    audit_exporter.write_run_audit(
                        run_context=run_context,
                        load_mode=load_mode,
                        output_mode=output_mode,
                        odoo_cutoff_utc=effective_odoo_cutoff_utc,
                        latest_order_before=latest_order_before,
                        latest_order_after=latest_order_after,
                        row_counts=sql_result.table_counts if sql_result else {name: len(df) for name, df in sheets.items()},
                    )
                except Exception as audit_exc:  # noqa: BLE001
                    self.logger.warning("Could not write pipeline_run_audit; data load remains successful: %s", audit_exc)
                try:
                    audit_exporter.write_run_log(
                        run_context=run_context,
                        odoo_extract_count=odoo_extract_count,
                        db_loaded_count=db_loaded_count,
                        qa_issues_count=qa_issues_count,
                    )
                except Exception as run_log_exc:  # noqa: BLE001
                    self.logger.warning("Could not write pipeline_run_log; data load remains successful: %s", run_log_exc)
            self._log_runtime(run_context)
            self._log_crm_summary(crm_summary)
            self._log_run_summary(
                run_context=run_context,
                load_mode=load_mode,
                fast=fast,
                odoo_extract_count=odoo_extract_count,
                sheets=sheets,
                db_loaded_count=db_loaded_count,
                qa_issues_count=qa_issues_count,
                workbook_path=workbook_path,
            )
            return PipelineRunResult(
                output_mode=output_mode,
                load_mode=load_mode,
                workbook_path=workbook_path,
                sql_result=sql_result,
                sheet_counts={name: len(df) for name, df in sheets.items()},
                crm_summary=crm_summary,
                total_duration_minutes=run_context.total_duration_minutes,
                full_refresh=full_refresh,
                force=force,
                force_sales_full_refresh=force_sales_full_refresh,
            )
        except Exception as exc:
            run_context.finish("FAILED", str(exc))
            if output_mode in {"sql", "both"}:
                try:
                    audit_exporter = DatabaseExporter(self.settings)
                    latest_order_after = self._latest_sql_order_tuple(audit_exporter)
                    audit_exporter.write_run_audit(
                        run_context=run_context,
                        load_mode=load_mode,
                        output_mode=output_mode,
                        odoo_cutoff_utc=effective_odoo_cutoff_utc,
                        latest_order_before=latest_order_before,
                        latest_order_after=latest_order_after,
                        row_counts=sql_result.table_counts if sql_result else None,
                    )
                except Exception as log_exc:  # noqa: BLE001
                    self.logger.error("Could not write failed run to pipeline_run_audit: %s", log_exc)
                try:
                    audit_exporter = DatabaseExporter(self.settings)
                    audit_exporter.write_run_log(
                        run_context=run_context,
                        odoo_extract_count=odoo_extract_count,
                        db_loaded_count=db_loaded_count,
                        qa_issues_count=qa_issues_count,
                    )
                except Exception as run_log_exc:  # noqa: BLE001
                    self.logger.error("Could not write failed run to pipeline_run_log: %s", run_log_exc)
            self._log_runtime(run_context)
            raise

    def transform(
        self,
        sales_raw: pd.DataFrame,
        include_qa: bool = True,
        use_reference_cache: bool = False,
        product_cost_raw: pd.DataFrame | None = None,
        stock_quants_raw: pd.DataFrame | None = None,
        stock_locations_raw: pd.DataFrame | None = None,
        inventory_companies_raw: pd.DataFrame | None = None,
        sale_orders_raw: pd.DataFrame | None = None,
    ) -> dict[str, pd.DataFrame]:
        _t0 = time.perf_counter()
        sales = self._normalize_sales_export(sales_raw)
        self.logger.info("PERF transform normalize_sales_export rows=%s duration_seconds=%.2f", len(sales), time.perf_counter() - _t0)

        # Normalize known Odoo product aliases without using PRODUCTS.xlsx as an approval gate.
        # Unmapped names pass through unchanged so every Odoo product row remains in the ETL.
        if "product_name" in sales.columns:
            sales["_odoo_name_raw"] = sales["product_name"]
            sales["product_name"] = self.mapper.apply_to_series(sales["product_name"])
            self.logger.info(
                "ProductNameMapper applied: %d transaction rows preserved; unmapped Odoo products pass through unchanged",
                len(sales),
            )

        _t1 = time.perf_counter()
        reference_cache = ReferenceDataCache(self.settings.output_dir / ".pipeline_cache")
        load_reference = reference_cache.load if use_reference_cache else lambda _name, _path, loader: loader()
        sales_org = load_reference("sales_org", self.settings.sales_team_path, lambda: SalesOrgRepository(self.legacy_logger).load(self.settings.sales_team_path))
        sales_org_enricher = SalesOrgEnricher(sales_org)
        targets = load_reference("targets", self.settings.targets_path, lambda: TargetsLoader(self.legacy_logger).load(self.settings.targets_path))
        product_master = load_reference(
            "product_master",
            self.settings.products_path,
            lambda: ProductMasterLoader(
                logger=self.legacy_logger,
                export_conflicts=True,
                base_dir=self.settings.output_dir.parent,
            ).load(self.settings.products_path),
        )
        blocked_customers = load_reference(
            "blocked_customers",
            self.settings.blocked_customers_path,
            lambda: BlockedCustomersLoader(self.legacy_logger).load(self.settings.blocked_customers_path),
        )
        fact_offdays = load_reference(
            "offdays",
            self.settings.offdays_path,
            lambda: OffDaysFactBuilder().build(self.settings.offdays_path, self.pipeline_settings.offdays_country),
        )
        self.logger.info("PERF transform load_reference_data duration_seconds=%.2f", time.perf_counter() - _t1)

        _t2 = time.perf_counter()
        cleaner = SalesCleaner()
        sales = cleaner.clean_order_numbers(sales)
        sales = cleaner.clean_customer(sales)
        sales = cleaner.clean_product_names(sales)
        self.logger.info("PERF transform clean_product_names rows=%s duration_seconds=%.2f", len(sales), time.perf_counter() - _t2)
        _t3 = time.perf_counter()
        sales = ProductMapper.attach(sales, product_master, product_cost_raw if product_cost_raw is not None else pd.DataFrame())
        self.logger.info("PERF transform product_mapper_attach rows=%s duration_seconds=%.2f", len(sales), time.perf_counter() - _t3)
        sales = cleaner.clean_quantity(sales)
        sales = cleaner.clean_value(sales)
        if "untaxed_total" in sales.columns:
            sales["untaxed_total"] = pd.to_numeric(sales["untaxed_total"], errors="coerce")
        if "order_date" in sales.columns:
            # Odoo datetime values arrive as UTC, often without timezone markers.
            # Convert to local business time first; order_date_date is then the
            # normalized reporting date used by DateKey and Power BI relations.
            sales["order_date"] = odoo_utc_datetime_to_local(sales["order_date"], self.settings.timezone)
        _t4 = time.perf_counter()
        sales = cleaner.clean_order_dates(sales)
        self._log_sales_filter_impact(sales, "before invoice_status filter")
        if self.settings.include_uninvoiced_sales_lines:
            self.logger.info("Sales invoice filter: INCLUDE_UNINVOICED_SALES_LINES=true, keeping invoice_status='no' rows")
        else:
            self.logger.info("Sales invoice filter: excluding invoice_status='no' quotation rows; keeping confirmed sale/done rows")
            sales = self._filter_sales_dashboard_rows(sales)
        self._log_sales_filter_impact(sales, "after invoice_status filter")
        sales = cleaner.add_first_purchase_date(sales)
        sales = cleaner.clean_salesperson(sales)
        self.logger.info("PERF transform clean_and_filter_sales rows=%s duration_seconds=%.2f", len(sales), time.perf_counter() - _t4)

        _t5 = time.perf_counter()
        sales = sales_org_enricher.enrich_sales(sales)
        self.logger.info("PERF transform enrich_sales rows=%s duration_seconds=%.2f", len(sales), time.perf_counter() - _t5)

        sales = cleaner.clean_company(sales)
        sales = cleaner.add_invoice_summary(sales)
        sales["DateKey"] = pd.to_datetime(sales["order_date_date"], errors="coerce").dt.strftime("%Y%m%d").astype("Int64")
        _t6 = time.perf_counter()
        targets = sales_org_enricher.normalize_targets(targets)
        if "SalesSegment" in targets.columns:
            targets["SalesSegment"] = SegmentDimensionBuilder.normalize_segment_series(targets["SalesSegment"])
        targets["TargetDate"] = pd.to_datetime(targets["TargetDate"], errors="coerce")
        targets["DateKey"] = targets["TargetDate"].dt.strftime("%Y%m%d").astype("Int64")
        self.logger.info("PERF transform normalize_targets duration_seconds=%.2f", time.perf_counter() - _t6)

        _t7 = time.perf_counter()
        dim_product = ProductDimensionBuilder().build(
            product_master,
            sales,
            raw_odoo_products=product_cost_raw if product_cost_raw is not None else pd.DataFrame(),
        )
        self.logger.info(
            "Dim_Product loaded: %d products from manual and Odoo sources",
            len(dim_product),
        )
        dim_salesperson = SalespersonDimensionBuilder(sales_org, self.pipeline_settings).build(sales)
        dim_channel = DistributionChannelDimensionBuilder().build(sales_org.people_active, targets)
        dim_salesteam = SalesTeamDimensionBuilder(sales_org, self.pipeline_settings).build()
        dim_date = DateDimensionBuilder(self.pipeline_settings.weekly_rest_day_name).build(sales)
        dim_company = CompanyDimensionBuilder().build(sales)
        dim_segment = SegmentDimensionBuilder(self.pipeline_settings).build(dim_salesteam, targets)
        product_sales_summary = InventoryModelBuilder.build_product_sales_summary(sales)
        self.logger.info("PERF transform build_dimensions duration_seconds=%.2f", time.perf_counter() - _t7)

        _t8 = time.perf_counter()
        inventory_result = InventoryModelBuilder().build(
            stock_quants=stock_quants_raw if stock_quants_raw is not None else pd.DataFrame(),
            locations=stock_locations_raw if stock_locations_raw is not None else pd.DataFrame(),
            product_raw=product_cost_raw if product_cost_raw is not None else pd.DataFrame(),
            dim_product=dim_product,
            dim_company=dim_company,
            snapshot_date=pd.Timestamp.now(tz=self.settings.timezone).date(),
            companies=inventory_companies_raw if inventory_companies_raw is not None else pd.DataFrame(),
            include_qa=include_qa,
            product_sales_summary=product_sales_summary,
        )
        dim_product = inventory_result.dim_product
        dim_company = inventory_result.dim_company
        self.logger.info("inventory rows after internal location filtering=%s", inventory_result.internal_rows_count)
        self.logger.info("products added to Dim_Product=%s", inventory_result.products_added_count)
        self.logger.info("PERF transform inventory_model_build duration_seconds=%.2f", time.perf_counter() - _t8)

        _t9 = time.perf_counter()
        dim_product_cost = ProductCostDimensionBuilder().build(
            product_cost_raw if product_cost_raw is not None else pd.DataFrame(),
            dim_product=dim_product,
        )
        self.logger.info("PERF transform product_cost_dim duration_seconds=%.2f", time.perf_counter() - _t9)

        _t9b = time.perf_counter()
        active_product_keys = ProductActiveFlagReconciler.active_base_keys(dim_product_cost)
        product_master = ProductActiveFlagReconciler.reconcile(
            product_master,
            active_product_keys,
            self.legacy_logger,
            products_path=self.settings.products_path,
        )
        dim_product = ProductActiveFlagReconciler.patch_dim_product(
            dim_product, active_product_keys, ProductDimensionBuilder.PRODUCT_SOURCE_INPUT
        )
        self.logger.info("PERF transform product_active_flag_reconcile duration_seconds=%.2f", time.perf_counter() - _t9b)

        _t10 = time.perf_counter()
        sales = self._attach_salesperson_fields(sales, dim_salesperson)
        sales = DataFrameUtils.add_key_from_dimension(sales, "DistributionChannel", dim_channel, "DistributionChannel", "ChannelKey")
        sales = DataFrameUtils.add_key_from_dimension(sales, "Company", dim_company, "Company", "CompanyKey")
        sales = self._attach_segment_key(sales, dim_segment, "Fact_SalesLines", [])
        self.logger.info("PERF transform attach_keys_to_sales rows=%s duration_seconds=%.2f", len(sales), time.perf_counter() - _t10)

        targets = DataFrameUtils.add_key_from_dimension(targets, "DistributionChannel", dim_channel, "DistributionChannel", "ChannelKey")
        targets = DataFrameUtils.add_key_from_dimension(targets, "Company", dim_company, "Company", "CompanyKey")
        targets = DataFrameUtils.add_key_from_dimension(targets, "SalesSegment", dim_segment, "Segment", "SegmentKey")

        salesperson_key_map = dict(zip(dim_salesperson["salesperson"].astype(str), dim_salesperson["SalespersonKey"].astype(int)))
        targets["SalespersonKey"] = targets["Salesperson"].astype(str).map(salesperson_key_map)
        targets["SalespersonKey"] = pd.to_numeric(targets["SalespersonKey"], errors="coerce").fillna(0).astype(int)

        _t11 = time.perf_counter()
        dim_customer = CustomerDimensionBuilder(
            sales_org,
            self.pipeline_settings,
            BlockedCustomersLoader(self.legacy_logger),
        ).build(
            sales,
            blocked_customers_path=self.settings.blocked_customers_path,
            blocked_customers=blocked_customers,
        )
        sales = self._attach_customer_keys(sales, dim_customer)
        self.logger.info("PERF transform customer_dim_and_attach duration_seconds=%.2f", time.perf_counter() - _t11)

        _t12 = time.perf_counter()
        fact_orders = OrdersFactBuilder().build(sales)
        fact_orders = self._ensure_fact_orders_order_key(fact_orders)
        fact_orders = self._attach_order_created_datetime(fact_orders, sale_orders_raw)
        dim_invoice = InvoiceDimensionBuilder().build(fact_orders)
        sales = DataFrameUtils.add_key_from_dimension(sales, "order_number", dim_invoice, "order_number", "InvoiceKey")
        fact_orders = DataFrameUtils.add_key_from_dimension(fact_orders, "order_number", dim_invoice, "order_number", "InvoiceKey")
        self.logger.info("PERF transform fact_orders_and_invoice_dim rows=%s duration_seconds=%.2f", len(fact_orders), time.perf_counter() - _t12)

        _t13 = time.perf_counter()
        fact_sales_lines = SalesLinesFactBuilder().build(sales)
        self.logger.info("PERF transform fact_sales_lines rows=%s duration_seconds=%.2f", len(fact_sales_lines), time.perf_counter() - _t13)
        _t14 = time.perf_counter()
        fact_bcg = BCGMatrixBuilder.build(fact_sales_lines, dim_product_cost, dim_product=dim_product)
        bcg_summary = BCGMatrixBuilder.quality_summary(fact_sales_lines, fact_bcg, dim_segment)
        self.logger.info("PERF transform bcg_build rows=%s duration_seconds=%.2f", len(fact_bcg), time.perf_counter() - _t14)
        bcg_checks = {
            "unique_company_product": bcg_summary["duplicate_company_product_count"] == 0,
            "segment_columns_removed": bool(bcg_summary["segment_columns_removed"]),
            "ytd_matches_sales_lines": abs(float(bcg_summary["bcg_ytd_value_delta"])) < 0.01,
            "ytd_lytd_columns": bool(bcg_summary["ytd_lytd_columns_exist"]),
        }
        bcg_passed = sum(1 for ok in bcg_checks.values() if ok)
        self.logger.info(
            "Fact_BCGMatrix refresh summary: rows=%s duplicate_company_product=%s segment_columns_removed=%s bcg_ytd=%.2f fact_sales_valid_invoice_ytd=%.2f ytd_delta=%.2f tests=%s/%s",
            f"{bcg_summary['row_count']:,}",
            bcg_summary["duplicate_company_product_count"],
            bcg_summary["segment_columns_removed"],
            bcg_summary["bcg_ytd_value"],
            bcg_summary["fact_sales_valid_invoice_ytd_value"],
            bcg_summary["bcg_ytd_value_delta"],
            bcg_passed,
            len(bcg_checks),
        )
        sheets = {
            "Fact_SalesLines": fact_sales_lines,
            "Fact_BCGMatrix": fact_bcg,
            "Fact_Orders": fact_orders,
            "Fact_Targets": TargetsFactBuilder().build(targets),
            "Fact_OffDays": fact_offdays,
            "Fact_Inventory": inventory_result.fact_inventory,
            "Dim_Date": dim_date,
            "Dim_Customer": dim_customer,
            "Dim_Salesperson": dim_salesperson,
            "Dim_SalesTeam": dim_salesteam,
            "Dim_Company": dim_company,
            "Dim_Product": dim_product,
            "Dim_ProductCost": dim_product_cost,
            "Dim_DistributionChannel": dim_channel,
            "Dim_Segment": dim_segment,
            "Dim_Invoice": dim_invoice,
        }
        if include_qa:
            qa_started = time.perf_counter()
            sheets["QA_MissingProductCost"] = ProductCostMatcher.missing_cost_qa(
                fact_sales_lines, dim_product_cost
            )
            sheets["QA_Inventory_DataQuality"] = inventory_result.qa_data_quality
            self.logger.info("Product unmapped QA exports disabled; all Odoo products are loaded")
            self.logger.info("QA inventory checks completed")
        else:
            self.logger.info("Skipping product QA generation for fast incremental SQL run")
        self.logger.info("Fact_Inventory rows written=%s", len(inventory_result.fact_inventory))
        return sheets

    # ------------------------------------------------------------------
    # Odoo parallel extraction helpers
    # ------------------------------------------------------------------

    def _make_odoo_client(self, uid: int) -> "OdooClient":
        """Create a fresh OdooClient (own transport) with a pre-authenticated UID.

        Each instance gets its own xmlrpc.client.Transport, so concurrent
        calls from multiple threads don't share a socket and are safe.
        """
        c = OdooClient(
            url=self.settings.odoo_url,
            db=self.settings.odoo_db,
            username=self.settings.odoo_user,
            api_key=self.settings.odoo_api_key,
            timeout_seconds=self.settings.rpc_timeout_seconds,
            max_retries=self.settings.max_retries,
        )
        c.uid = uid  # skip authenticate() round-trip; uid is already known
        return c

    def _parallel_odoo_fetch(
        self,
        tasks: dict[str, Callable[[], pd.DataFrame]],
        uid: int,
        max_workers: int = 6,
    ) -> dict[str, pd.DataFrame]:
        """Run multiple no-arg fetch callables concurrently, each using its own OdooClient.

        Args:
            tasks: mapping of label → zero-argument callable that returns a DataFrame.
            uid: authenticated Odoo uid (pre-shared so no re-auth is needed per thread).
            max_workers: thread pool size (default 6 — one per typical CRM model fetch).

        Returns:
            Dict with the same keys as *tasks*, values are the fetched DataFrames.
        """
        results: dict[str, pd.DataFrame] = {}
        errors: list[tuple[str, BaseException]] = []

        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_to_label = {executor.submit(fn): label for label, fn in tasks.items()}
            for future in as_completed(future_to_label):
                label = future_to_label[future]
                try:
                    results[label] = future.result()
                    self.logger.info("PERF parallel_odoo_fetch %s rows=%s", label, len(results[label]))
                except Exception as exc:  # noqa: BLE001
                    errors.append((label, exc))
                    self.logger.error("Parallel Odoo fetch %s failed: %s", label, exc)

        if errors:
            labels = ", ".join(label for label, _ in errors)
            raise RuntimeError(f"Parallel Odoo extraction failed for: {labels}") from errors[0][1]

        return results

    def _latest_sql_order_tuple(self, exporter: DatabaseExporter) -> tuple[Any, Any] | None:
        schema = exporter._effective_schema()
        fact_orders = self._latest_sql_tuple_for_table(exporter, schema, "Fact_Orders", "order_number", "OrderDateTime")
        fact_lines = self._latest_sql_tuple_for_table(exporter, schema, "Fact_SalesLines", "order_number", "order_date")
        fact_sales = self._latest_sql_tuple_for_table(exporter, schema, "Fact_Sales", "OrderNumber", "OrderDateTime")
        self.logger.info("Latest SQL Fact_Orders: %s | %s", fact_orders[0], fact_orders[1])
        self.logger.info("Latest SQL Fact_SalesLines: %s | %s", fact_lines[0], fact_lines[1])
        self.logger.info("Latest SQL Fact_Sales: %s | %s", fact_sales[0], fact_sales[1])

        candidates = [
            ("Fact_Orders", fact_orders),
            ("Fact_SalesLines", fact_lines),
            ("Fact_Sales", fact_sales),
        ]
        valid = [(source, value) for source, value in candidates if value != (None, None)]
        if not valid:
            self.logger.info("Latest SQL order: no existing final sales table found")
            return None
        selected_source, selected = max(valid, key=lambda item: pd.Timestamp(item[1][1]))
        greatest = self._greatest_sql_sales_timestamp(exporter)
        selected_ts = pd.to_datetime(selected[1], errors="coerce")
        if greatest is not None and selected_ts != pd.to_datetime(greatest, errors="coerce"):
            raise RuntimeError(
                "Incremental cutoff validation failed: selected latest timestamp "
                f"{selected_ts} from {selected_source} does not equal SQL greatest latest timestamp {greatest}."
            )
        self.logger.info(
            "Selected incremental latest SQL order: %s | %s | source=%s",
            selected[0],
            selected[1],
            selected_source,
        )
        return selected

    def _latest_sql_tuple_for_table(
        self,
        exporter: DatabaseExporter,
        schema: str | None,
        table_name: str,
        order_col: str,
        date_col: str,
    ) -> tuple[Any, Any]:
        try:
            table = exporter._quoted_table_name(table_name)
            q = exporter.engine.dialect.identifier_preparer.quote
            with exporter.engine.connect() as conn:
                row = conn.execute(
                    text(
                        f"""
                        SELECT {q(order_col)} AS order_value, {q(date_col)} AS date_value
                        FROM {table}
                        WHERE {q(date_col)} IS NOT NULL
                        ORDER BY {q(date_col)} DESC, {q(order_col)} DESC
                        LIMIT 1
                        """
                    )
                ).mappings().one_or_none()
        except Exception:  # noqa: BLE001
            return (None, None)
        if row is None:
            return (None, None)
        date_value = pd.to_datetime(row["date_value"], errors="coerce")
        if isinstance(date_value, pd.Timestamp) and not pd.isna(date_value):
            date_value = date_value.to_pydatetime().replace(microsecond=0)
        return (str(row["order_value"]), date_value)

    def _greatest_sql_sales_timestamp(self, exporter: DatabaseExporter) -> Any:
        fact_orders = exporter._quoted_table_name("Fact_Orders")
        fact_lines = exporter._quoted_table_name("Fact_SalesLines")
        fact_sales = exporter._quoted_table_name("Fact_Sales")
        q = exporter.engine.dialect.identifier_preparer.quote
        try:
            with exporter.engine.connect() as conn:
                return conn.execute(
                    text(
                        f"""
                        SELECT GREATEST(
                            (SELECT MAX({q("OrderDateTime")}) FROM {fact_orders}),
                            (SELECT MAX(order_date) FROM {fact_lines}),
                            (SELECT MAX({q("OrderDateTime")}) FROM {fact_sales})
                        )
                        """
                    )
                ).scalar_one_or_none()
        except Exception:  # noqa: BLE001
            return None

    def _incremental_cutoff_from_sql(self, latest_order: tuple[Any, Any] | None) -> pd.Timestamp | None:
        if not latest_order or latest_order[1] is None:
            self.logger.info("Incremental cutoff: no prior SQL latest order found; staging will fall back to full sync")
            return None
        latest_local = pd.to_datetime(latest_order[1], errors="coerce")
        if pd.isna(latest_local):
            self.logger.info("Incremental cutoff: prior SQL latest order timestamp is not parseable; staging will fall back to full sync")
            return None
        cutoff_local = latest_local - pd.Timedelta(days=self.settings.incremental_overlap_days)
        if cutoff_local.tzinfo is None:
            cutoff_utc = cutoff_local.tz_localize(self.settings.timezone).tz_convert("UTC").tz_localize(None)
        else:
            cutoff_utc = cutoff_local.tz_convert("UTC").tz_localize(None)
        self.logger.info("Incremental latest SQL order selected for cutoff: number=%s local_datetime=%s", latest_order[0], latest_local)
        self.logger.info("Incremental cutoff local with %s day overlap: %s", self.settings.incremental_overlap_days, cutoff_local)
        self.logger.info("Incremental cutoff UTC sent to Odoo write/create domains: %s", cutoff_utc)
        return cutoff_utc

    def _local_cutoff_from_utc(self, cutoff_utc: pd.Timestamp | None) -> pd.Timestamp | None:
        if cutoff_utc is None:
            return None
        cutoff = pd.Timestamp(cutoff_utc)
        if cutoff.tzinfo is None:
            return cutoff.tz_localize("UTC").tz_convert(self.settings.timezone).tz_localize(None)
        return cutoff.tz_convert(self.settings.timezone).tz_localize(None)

    def _audit_excel_sources(self, exporter: DatabaseExporter, load_mode: LoadMode) -> None:
        self.logger.info("Excel source fingerprint check:")
        for source_name, path in self._excel_source_paths().items():
            metadata = self._file_metadata(path)
            previous = exporter.get_load_metadata(source_name)
            unchanged = self._excel_metadata_unchanged(previous, metadata)
            if unchanged:
                self.logger.info("  %s unchanged; skipping Excel reload", source_name)
            else:
                self.logger.info("  %s changed; current file will be loaded", source_name)

    def _write_excel_source_metadata(self, exporter: DatabaseExporter, load_mode: LoadMode) -> None:
        for source_name, path in self._excel_source_paths().items():
            metadata = self._file_metadata(path)
            exporter.upsert_load_metadata(
                source_name=source_name,
                source_type="excel",
                source_path=str(path),
                last_modified_time=metadata["last_modified_time"],
                file_size=metadata["file_size"],
                checksum=metadata["checksum"],
                load_mode=load_mode,
                status="SUCCESS" if path.exists() else "MISSING",
            )

    def _excel_source_paths(self) -> dict[str, Path]:
        source_paths = {
            "sales_targets.xlsx": self.settings.targets_path,
            "SalesTeam.xlsx": self.settings.sales_team_path,
            "OffDays.xlsx": self.settings.offdays_path,
            "PRODUCTS.xlsx": self.settings.products_path,
            "BlockedCustomers.xlsx": self.settings.blocked_customers_path,
        }
        return source_paths

    @staticmethod
    def _excel_metadata_unchanged(previous: dict[str, Any] | None, metadata: dict[str, Any]) -> bool:
        return (
            previous is not None
            and str(previous.get("checksum") or "") == str(metadata["checksum"] or "")
            and int(previous.get("file_size") or -1) == int(metadata["file_size"] or -2)
        )

    @staticmethod
    def _file_metadata(path: Path) -> dict[str, Any]:
        if not path.exists():
            return {"last_modified_time": None, "file_size": None, "checksum": None}
        stat = path.stat()
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return {
            "last_modified_time": datetime.fromtimestamp(stat.st_mtime),
            "file_size": int(stat.st_size),
            "checksum": digest.hexdigest(),
        }

    def transform_crm(
        self,
        leads_raw: pd.DataFrame,
        stages_raw: pd.DataFrame,
        lost_reasons_raw: pd.DataFrame,
        sale_orders_raw: pd.DataFrame,
        stock_pickings_raw: pd.DataFrame,
        stock_moves_raw: pd.DataFrame,
        field_availability: pd.DataFrame,
        fact_orders: pd.DataFrame | None = None,
        dim_customer: pd.DataFrame | None = None,
        dim_salesteam: pd.DataFrame | None = None,
        dim_salesperson: pd.DataFrame | None = None,
        dim_channel: pd.DataFrame | None = None,
        dim_segment: pd.DataFrame | None = None,
        dim_company: pd.DataFrame | None = None,
        dim_invoice: pd.DataFrame | None = None,
        include_qa: bool = True,
    ) -> tuple[dict[str, pd.DataFrame], CrmValidationSummary]:
        cleaner = CrmCleaner(self.settings)
        leads = cleaner.normalize_leads(leads_raw, stages_raw)
        orders = cleaner.normalize_orders(sale_orders_raw)
        pickings = cleaner.normalize_pickings(stock_pickings_raw)
        moves = cleaner.normalize_moves(stock_moves_raw)
        dim_lost_reason = LostReasonDimensionBuilder().build(lost_reasons_raw)
        qa_unmapped_rows: list[dict[str, object]] = []
        refresh_timestamp = pd.Timestamp.now(tz=self.settings.timezone).tz_localize(None)

        crm_spine = PipelineFactBuilder().build(leads)
        crm_spine = self._attach_pipeline_fact_sales_keys(crm_spine, dim_customer, dim_salesteam, dim_salesperson, dim_company, dim_segment, dim_lost_reason, qa_unmapped_rows)
        fact_sales = SalesFactBuilder().build(orders, crm_spine, fact_orders, refresh_date=refresh_timestamp)
        fact_sales = self._attach_sales_fact_keys(
            fact_sales,
            dim_customer=dim_customer,
            dim_salesteam=dim_salesteam,
            dim_salesperson=dim_salesperson,
            dim_company=dim_company,
            dim_channel=dim_channel,
            dim_segment=dim_segment,
            dim_invoice=dim_invoice,
            qa_unmapped_rows=qa_unmapped_rows,
        )
        fact_delivery = DeliveryFactBuilder().build(pickings, moves, fact_sales)
        crm_spine, fact_sales, fact_delivery = self._attach_journey_flow_tracking(crm_spine, fact_sales, fact_delivery, refresh_date=refresh_timestamp)
        fact_lead = LeadFactBuilder().build(crm_spine)
        fact_sales_export = SalesFactBuilder().project(fact_sales, refresh_date=refresh_timestamp)
        fact_opportunity = OpportunityFactBuilder().build(crm_spine, fact_sales_export, refresh_date=refresh_timestamp)
        self._log_quotation_outcome_validation(fact_sales_export)
        fact_delivery_export = DeliveryFactBuilder().project(fact_delivery)
        dim_stage = CrmStageDimensionBuilder().build(stages_raw)
        qa_missing_links = pd.DataFrame()
        qa_data_quality = pd.DataFrame()
        qa_unmapped_keys = pd.DataFrame()
        if include_qa:
            qa_started = time.perf_counter()
            qa_missing_links = CrmModelBuilder.build_missing_links(leads, orders)
            self.logger.info("QA table QA_CRM_MissingLinks generated rows=%s duration_seconds=%.2f", len(qa_missing_links), time.perf_counter() - qa_started)
            qa_started = time.perf_counter()
            qa_data_quality = self._build_pipeline_data_quality_checks(crm_spine, fact_sales, fact_delivery, fact_orders=fact_orders)
            self.logger.info("QA table QA_CRM_DataQuality generated rows=%s duration_seconds=%.2f", len(qa_data_quality), time.perf_counter() - qa_started)
            qa_started = time.perf_counter()
            qa_unmapped_keys = pd.DataFrame(qa_unmapped_rows, columns=["TableName", "KeyName", "SourceValue", "LeadID", "Notes"])
            self.logger.info("QA table QA_CRM_UnmappedKeys generated rows=%s duration_seconds=%.2f", len(qa_unmapped_keys), time.perf_counter() - qa_started)
        else:
            self.logger.info("Skipping CRM QA table generation for fast incremental SQL run")

        self.logger.info("Fact_Lead rows count: %s", f"{len(fact_lead):,}")
        self.logger.info("Fact_Opportunity rows count: %s", f"{len(fact_opportunity):,}")
        self.logger.info("Fact_Sales rows count: %s", f"{len(fact_sales_export):,}")
        self.logger.info("Fact_Delivery rows count: %s", f"{len(fact_delivery_export):,}")

        crm_sheets = {
            "Fact_Lead": fact_lead,
            "Fact_Opportunity": fact_opportunity,
            "Fact_Sales": fact_sales_export,
            "Fact_Delivery": fact_delivery_export,
            "Dim_CRMStage": dim_stage,
            "Dim_LostReason": dim_lost_reason,
        }
        if include_qa:
            crm_sheets.update(
                {
                    "QA_CRM_MissingLinks": qa_missing_links,
                    "QA_CRM_DataQuality": qa_data_quality,
                    "QA_CRM_UnmappedKeys": qa_unmapped_keys,
                    "QA_CRM_FieldAvailability": field_availability,
                }
            )
        data_quality_issue_count = int(qa_data_quality["Status"].isin(["FAIL", "WARN"]).sum()) if include_qa and "Status" in qa_data_quality.columns else 0
        summary = CrmValidationSummary(
            crm_leads_fetched=int((leads["LeadType"].astype("string").str.lower() == "lead").sum()) if "LeadType" in leads.columns else len(leads),
            crm_opportunities_fetched=int((leads["LeadType"].astype("string").str.lower() == "opportunity").sum()) if "LeadType" in leads.columns else len(leads),
            quotations_fetched=int(orders["IsQuotation"].sum()) if "IsQuotation" in orders.columns else 0,
            sales_orders_fetched=int(orders["IsSalesOrder"].sum()) if "IsSalesOrder" in orders.columns else 0,
            deliveries_fetched=len(pickings),
            crm_output_sheets_exported=len(crm_sheets),
            qa_issues_count=(len(qa_missing_links) + len(qa_unmapped_keys) + data_quality_issue_count) if include_qa else 0,
        )
        return crm_sheets, summary

    def _log_quotation_outcome_validation(self, fact_sales: pd.DataFrame) -> None:
        if fact_sales.empty:
            self.logger.info("Quotation outcome validation: real=0 won=0 real_b2b=0 real_b2b_without_sales_order_date=0")
            return

        is_real = coerce_nullable_bool(fact_sales.get("IsRealQuotation", pd.Series(False, index=fact_sales.index))).fillna(False).astype(bool)
        is_won = coerce_nullable_bool(fact_sales.get("IsWonQuotation", pd.Series(False, index=fact_sales.index))).fillna(False).astype(bool)
        sales_segment = fact_sales.get("SalesSegment", pd.Series(pd.NA, index=fact_sales.index)).astype("string").str.strip().str.upper()
        sales_order_date = pd.to_datetime(fact_sales.get("SalesOrderDate", pd.Series(pd.NaT, index=fact_sales.index)), errors="coerce")
        real_b2b = is_real & sales_segment.eq("B2B")
        real_b2b_without_sales_order_date = real_b2b & sales_order_date.isna()

        self.logger.info(
            "Quotation outcome validation: real=%s won=%s real_b2b=%s real_b2b_without_sales_order_date=%s",
            int(is_real.sum()),
            int(is_won.sum()),
            int(real_b2b.sum()),
            int(real_b2b_without_sales_order_date.sum()),
        )

        won_not_real = int((is_won & ~is_real).sum())
        sales_document_type = fact_sales.get("SalesDocumentType", pd.Series(pd.NA, index=fact_sales.index)).astype("string").str.strip()
        source_quote = fact_sales.get("SourceQuotationID", pd.Series(pd.NA, index=fact_sales.index)).astype("string")
        quote_id = fact_sales.get("QuotationID", pd.Series(pd.NA, index=fact_sales.index)).astype("string")
        quote_key = source_quote.where(source_quote.notna(), quote_id)
        is_real_sales_order = coerce_nullable_bool(fact_sales.get("IsRealSalesOrder", pd.Series(False, index=fact_sales.index))).fillna(False).astype(bool)
        sales_order_links = pd.DataFrame(
            {
                "QuotationKey": quote_key,
                "IsSalesOrder": sales_document_type.eq("Sales Order"),
                "IsRealSalesOrder": is_real_sales_order,
            }
        )
        sales_order_links = sales_order_links[sales_order_links["IsSalesOrder"] & sales_order_links["QuotationKey"].notna()]
        linked_real_sales_order_map = sales_order_links.groupby("QuotationKey")["IsRealSalesOrder"].max().astype(bool).to_dict() if not sales_order_links.empty else {}
        linked_real_sales_order = quote_key.map(linked_real_sales_order_map).fillna(False).astype(bool)
        won_without_real_sales_order = int((is_won & ~linked_real_sales_order).sum())
        if won_not_real:
            raise RuntimeError(f"IsWonQuotation validation failed: won quotations not marked real={won_not_real}")
        if won_without_real_sales_order:
            raise RuntimeError(f"IsWonQuotation validation failed: won quotations without linked real sales order={won_without_real_sales_order}")

    def _attach_journey_flow_tracking(
        self,
        fact_pipeline: pd.DataFrame,
        fact_sales: pd.DataFrame,
        fact_delivery: pd.DataFrame,
        refresh_date: object | None = None,
    ) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
        pipeline = self._ensure_pipeline_journey_key(fact_pipeline)
        sales = fact_sales.copy()
        delivery = fact_delivery.copy()
        sales = add_quotation_classification(sales, refresh_date=refresh_date)
        sales = add_sales_order_classification(sales)
        sales = add_quotation_outcome_flags(sales)
        delivery = add_delivery_classification(delivery)
        journey_meta = self._build_journey_metadata(pipeline, sales, delivery)
        pipeline = self._merge_journey_metadata(pipeline, journey_meta)
        sales = self._merge_journey_metadata(sales, journey_meta)
        delivery = self._merge_journey_metadata(delivery, journey_meta)
        pipeline = add_quotation_classification(pipeline, refresh_date=refresh_date)
        sales = add_quotation_classification(sales, refresh_date=refresh_date)
        sales = add_sales_order_classification(sales)
        sales = add_quotation_outcome_flags(sales)
        delivery = add_delivery_classification(delivery)

        pipeline_order = [col for col in PipelineFactBuilder.COLUMNS if col in pipeline.columns]
        sales_order = [col for col in SalesFactBuilder.COLUMNS if col in sales.columns]
        delivery_order = [col for col in DeliveryFactBuilder.COLUMNS if col in delivery.columns]
        return (
            pipeline[pipeline_order + [col for col in pipeline.columns if col not in pipeline_order]],
            sales[sales_order + [col for col in sales.columns if col not in sales_order]],
            delivery[delivery_order + [col for col in delivery.columns if col not in delivery_order]],
        )

    @staticmethod
    def _ensure_pipeline_journey_key(fact_pipeline: pd.DataFrame) -> pd.DataFrame:
        out = fact_pipeline.copy()
        lead_id = out.get("LeadID", pd.Series(pd.NA, index=out.index)).astype("string")
        opportunity_id = out.get("OpportunityID", pd.Series(pd.NA, index=out.index)).astype("string")
        lead_type = out.get("LeadType", pd.Series(pd.NA, index=out.index)).astype("string").str.strip().str.lower()
        is_etl_lead = out.get("IsETLCreatedLead", pd.Series(False, index=out.index)).fillna(False).astype(bool)
        has_lead = lead_id.notna()
        has_opportunity = opportunity_id.notna()
        is_lead_row = (lead_type.isin(["lead", "systematic"]) | is_etl_lead) & has_lead
        out["JourneyKey"] = pd.NA
        out.loc[is_lead_row, "JourneyKey"] = "LEAD-" + lead_id[is_lead_row]
        etl_lead_row = is_lead_row & lead_id.str.startswith("ETL-LEAD-", na=False)
        out.loc[etl_lead_row, "JourneyKey"] = lead_id[etl_lead_row]
        out.loc[~is_lead_row & has_lead, "JourneyKey"] = "LEAD-" + lead_id[~is_lead_row & has_lead]
        etl_linked_row = ~is_lead_row & has_lead & lead_id.str.startswith("ETL-LEAD-", na=False)
        out.loc[etl_linked_row, "JourneyKey"] = lead_id[etl_linked_row]
        out.loc[~has_lead & has_opportunity, "JourneyKey"] = "OPP-" + opportunity_id[~has_lead & has_opportunity]
        fallback = out["JourneyKey"].isna() & out.get("PipelineRecordID", pd.Series(pd.NA, index=out.index)).notna()
        out.loc[fallback, "JourneyKey"] = "PIPE-" + out.loc[fallback, "PipelineRecordID"].astype("string")
        return out

    @classmethod
    def _build_journey_metadata(
        cls,
        fact_pipeline: pd.DataFrame,
        fact_sales: pd.DataFrame,
        fact_delivery: pd.DataFrame,
    ) -> pd.DataFrame:
        keys = pd.concat(
            [
                fact_pipeline.get("JourneyKey", pd.Series(dtype="object")),
                fact_sales.get("JourneyKey", pd.Series(dtype="object")),
                fact_delivery.get("JourneyKey", pd.Series(dtype="object")),
            ],
            ignore_index=True,
        ).dropna().astype(str)
        meta = pd.DataFrame({"JourneyKey": sorted(set(keys.tolist()))})
        if meta.empty:
            return pd.DataFrame(columns=cls._journey_metadata_columns())
        for col in ["HasLead", "HasOpportunity", "HasQuotation", "HasSalesOrder", "HasDelivery"]:
            meta[col] = False
        for col in ["LeadID", "OpportunityID", "QuotationID", "SalesOrderID", "DeliveryID"]:
            meta[col] = pd.NA
        for col in ["LeadCreatedDate", "OpportunityCreatedDate", "QuotationDate", "SalesOrderDate", "DeliveryDate"]:
            meta[col] = pd.NaT
        meta["DeliveryStatus"] = pd.NA

        meta = cls._merge_pipeline_stage_metadata(meta, fact_pipeline)
        meta = cls._merge_sales_stage_metadata(meta, fact_sales)
        meta = cls._merge_delivery_stage_metadata(meta, fact_delivery)
        # PERF: Replaced apply(cls._journey_type, axis=1) and apply(cls._flow_type, axis=1)
        # with vectorized numpy.select(). For datasets with thousands of journeys this cuts
        # ~2-4 seconds of Python-level row iteration per call.
        import numpy as np
        _hl = meta["HasLead"].astype("boolean").fillna(False).astype(bool)
        _ho = meta["HasOpportunity"].astype("boolean").fillna(False).astype(bool)
        _hq = meta["HasQuotation"].astype("boolean").fillna(False).astype(bool)
        _hs = meta["HasSalesOrder"].astype("boolean").fillna(False).astype(bool)
        _hd = meta["HasDelivery"].astype("boolean").fillna(False).astype(bool)
        meta["JourneyType"] = np.select(
            [
                _hl & _ho & _hq & _hs & _hd,
                _hl & _ho & _hq & _hs,
                _hl & _ho & _hq,
                _hl & _ho,
                _hl,
                _ho & _hq & _hs,
                _ho & _hq,
                _ho,
                _hq & _hs,
                _hs,
                _hq,
            ],
            [
                "Full Flow",
                "Lead to Sales",
                "Lead to Quotation",
                "Lead to Opportunity Only",
                "Lead Only",
                "Opportunity to Sales",
                "Opportunity to Quotation",
                "Opportunity Only",
                "Direct Quotation to Sales",
                "Sales Without CRM",
                "Direct Quotation Only",
            ],
            default="Unknown",
        )
        _ds = meta["DeliveryStatus"].astype("object").fillna("")
        meta["FlowType"] = np.select(
            [
                _hd & _ds.eq("Fully Delivered"),
                _hd & _ds.eq("Partially Delivered"),
                _hd & _ds.eq("Started"),
                _hd,
                _hs,
                _hq,
                _ho,
                _hl,
            ],
            ["Delivered", "Partially Delivered", "Delivery Started", "Delivery",
             "Sales Order", "Quotation", "Opportunity", "Lead"],
            default="Unknown",
        )
        return meta[cls._journey_metadata_columns()]

    @staticmethod
    def _journey_metadata_columns() -> list[str]:
        return [
            "JourneyKey",
            "JourneyType",
            "FlowType",
            "HasLead",
            "HasOpportunity",
            "HasQuotation",
            "HasSalesOrder",
            "HasDelivery",
            "LeadID",
            "OpportunityID",
            "QuotationID",
            "SalesOrderID",
            "DeliveryID",
            "DeliveryStatus",
            "LeadCreatedDate",
            "OpportunityCreatedDate",
            "QuotationDate",
            "SalesOrderDate",
            "DeliveryDate",
        ]

    @staticmethod
    def _first_non_null(series: pd.Series) -> object:
        values = series.dropna()
        return values.iloc[0] if not values.empty else pd.NA

    @staticmethod
    def _min_datetime(series: pd.Series) -> object:
        values = pd.to_datetime(series, errors="coerce").dropna()
        return values.min() if not values.empty else pd.NaT

    @classmethod
    def _merge_pipeline_stage_metadata(cls, meta: pd.DataFrame, fact_pipeline: pd.DataFrame) -> pd.DataFrame:
        if fact_pipeline.empty or "JourneyKey" not in fact_pipeline.columns:
            return meta
        out = meta.copy()
        source = fact_pipeline.dropna(subset=["JourneyKey"]).copy()
        if source.empty:
            return out
        lead_type = source.get("LeadType", pd.Series(pd.NA, index=source.index)).astype("string").str.strip().str.lower()
        is_etl_lead = source.get("IsETLCreatedLead", pd.Series(False, index=source.index)).fillna(False).astype(bool)
        source["_IsLeadRow"] = lead_type.isin(["lead", "systematic"]) | is_etl_lead
        source["_IsOpportunityRow"] = source.get("OpportunityID", pd.Series(pd.NA, index=source.index)).notna()
        source["_OpportunityCreated"] = pd.to_datetime(source.get("OpenDate", pd.Series(pd.NaT, index=source.index)), errors="coerce").combine_first(
            pd.to_datetime(source.get("CreatedDate", pd.Series(pd.NaT, index=source.index)), errors="coerce")
        )
        grouped = source.groupby("JourneyKey", as_index=False).agg(
            HasLead=("_IsLeadRow", "max"),
            HasOpportunity=("_IsOpportunityRow", "max"),
            LeadID=("LeadID", cls._first_non_null),
            OpportunityID=("OpportunityID", cls._first_non_null),
            LeadCreatedDate=("CreatedDate", lambda s: cls._min_datetime(s[source.loc[s.index, "_IsLeadRow"]])),
            OpportunityCreatedDate=("_OpportunityCreated", lambda s: cls._min_datetime(s[source.loc[s.index, "_IsOpportunityRow"]])),
        )
        out = out.merge(grouped, on="JourneyKey", how="left", suffixes=("", "_pipeline"))
        for col in ["HasLead", "HasOpportunity"]:
            out[col] = out[f"{col}_pipeline"].astype("boolean").fillna(False).astype(bool) | out[col].astype("boolean").fillna(False).astype(bool)
            out = out.drop(columns=[f"{col}_pipeline"])
        for col in ["LeadID", "OpportunityID", "LeadCreatedDate", "OpportunityCreatedDate"]:
            out[col] = out[col].where(out[col].notna(), out[f"{col}_pipeline"])
            out = out.drop(columns=[f"{col}_pipeline"])
        return out

    @classmethod
    def _merge_sales_stage_metadata(cls, meta: pd.DataFrame, fact_sales: pd.DataFrame) -> pd.DataFrame:
        if fact_sales.empty or "JourneyKey" not in fact_sales.columns:
            return meta
        out = meta.copy()
        source = fact_sales.dropna(subset=["JourneyKey"]).copy()
        if source.empty:
            return out
        source["_HasQuotation"] = source.get("IsRealQuotation", pd.Series(False, index=source.index)).astype("boolean").fillna(False).astype(bool)
        source["_HasSalesOrder"] = source.get("IsRealSalesOrder", pd.Series(False, index=source.index)).astype("boolean").fillna(False).astype(bool)
        grouped = source.groupby("JourneyKey", as_index=False).agg(
            HasQuotation=("_HasQuotation", "max"),
            HasSalesOrder=("_HasSalesOrder", "max"),
            LeadID=("LeadID", cls._first_non_null),
            OpportunityID=("OpportunityID", cls._first_non_null),
            QuotationID=("SourceQuotationID", cls._first_non_null),
            SalesOrderID=("SalesOrderID", cls._first_non_null),
            QuotationDate=("QuotationDate", cls._min_datetime),
            SalesOrderDate=("SalesOrderDate", cls._min_datetime),
        )
        out = out.merge(grouped, on="JourneyKey", how="left", suffixes=("", "_sales"))
        for col in ["HasQuotation", "HasSalesOrder"]:
            out[col] = out[f"{col}_sales"].astype("boolean").fillna(False).astype(bool) | out[col].astype("boolean").fillna(False).astype(bool)
            out = out.drop(columns=[f"{col}_sales"])
        for col in ["LeadID", "OpportunityID", "QuotationID", "SalesOrderID", "QuotationDate", "SalesOrderDate"]:
            out[col] = out[col].where(out[col].notna(), out[f"{col}_sales"])
            out = out.drop(columns=[f"{col}_sales"])
        return out

    @classmethod
    def _merge_delivery_stage_metadata(cls, meta: pd.DataFrame, fact_delivery: pd.DataFrame) -> pd.DataFrame:
        if fact_delivery.empty or "JourneyKey" not in fact_delivery.columns:
            return meta
        out = meta.copy()
        source = fact_delivery.dropna(subset=["JourneyKey"]).copy()
        if source.empty:
            return out
        source["_HasDelivery"] = source.get("IsRealDelivery", pd.Series(False, index=source.index)).astype("boolean").fillna(False).astype(bool)
        grouped = source.groupby("JourneyKey", as_index=False).agg(
            HasDelivery=("_HasDelivery", "max"),
            DeliveryID=("DeliveryID", cls._first_non_null),
            DeliveryStatus=("DeliveryStatus", cls._delivery_status_for_journey),
            DeliveryDate=("DoneDate", cls._min_datetime),
        )
        out = out.merge(grouped, on="JourneyKey", how="left", suffixes=("", "_delivery"))
        out["HasDelivery"] = out["HasDelivery_delivery"].astype("boolean").fillna(False).astype(bool) | out["HasDelivery"].astype("boolean").fillna(False).astype(bool)
        out = out.drop(columns=["HasDelivery_delivery"])
        for col in ["DeliveryID", "DeliveryStatus", "DeliveryDate"]:
            out[col] = out[col].where(out[col].notna(), out[f"{col}_delivery"])
            out = out.drop(columns=[f"{col}_delivery"])
        return out

    @staticmethod
    def _delivery_status_for_journey(series: pd.Series) -> object:
        values = series.dropna().astype(str).tolist()
        if not values:
            return pd.NA
        priority = {
            "Fully Delivered": 4,
            "Partially Delivered": 3,
            "Started": 2,
            "Not Delivered": 1,
        }
        return max(values, key=lambda value: priority.get(value, 0))

    @staticmethod
    def _journey_type(row: pd.Series) -> str:
        has_lead = bool(row.get("HasLead"))
        has_opportunity = bool(row.get("HasOpportunity"))
        has_quotation = bool(row.get("HasQuotation"))
        has_sales_order = bool(row.get("HasSalesOrder"))
        has_delivery = bool(row.get("HasDelivery"))
        if has_lead and has_opportunity and has_quotation and has_sales_order and has_delivery:
            return "Full Flow"
        if has_lead and has_opportunity and has_quotation and has_sales_order:
            return "Lead to Sales"
        if has_lead and has_opportunity and has_quotation:
            return "Lead to Quotation"
        if has_lead and has_opportunity:
            return "Lead to Opportunity Only"
        if has_lead:
            return "Lead Only"
        if has_opportunity and has_quotation and has_sales_order:
            return "Opportunity to Sales"
        if has_opportunity and has_quotation:
            return "Opportunity to Quotation"
        if has_opportunity:
            return "Opportunity Only"
        if has_quotation and has_sales_order:
            return "Direct Quotation to Sales"
        if has_sales_order:
            return "Sales Without CRM"
        if has_quotation:
            return "Direct Quotation Only"
        return "Unknown"

    @staticmethod
    def _flow_type(row: pd.Series) -> str:
        if bool(row.get("HasDelivery")):
            delivery_status = str(row.get("DeliveryStatus") or "")
            if delivery_status == "Fully Delivered":
                return "Delivered"
            if delivery_status == "Partially Delivered":
                return "Partially Delivered"
            if delivery_status == "Started":
                return "Delivery Started"
            return "Delivery"
        if bool(row.get("HasSalesOrder")):
            return "Sales Order"
        if bool(row.get("HasQuotation")):
            return "Quotation"
        if bool(row.get("HasOpportunity")):
            return "Opportunity"
        if bool(row.get("HasLead")):
            return "Lead"
        return "Unknown"

    @staticmethod
    def _merge_journey_metadata(fact: pd.DataFrame, journey_meta: pd.DataFrame) -> pd.DataFrame:
        out = fact.copy()
        if out.empty or journey_meta.empty or "JourneyKey" not in out.columns:
            return out
        metadata_cols = [col for col in journey_meta.columns if col != "JourneyKey"]
        existing_cols = [col for col in metadata_cols if col in out.columns]
        out = out.merge(journey_meta, on="JourneyKey", how="left", suffixes=("", "_journey"))
        flag_cols = {"HasLead", "HasOpportunity", "HasQuotation", "HasSalesOrder", "HasDelivery"}
        overwrite_cols = flag_cols | {"JourneyType", "FlowType"}
        for col in metadata_cols:
            journey_col = f"{col}_journey" if col in existing_cols else col
            if journey_col not in out.columns:
                continue
            if col in overwrite_cols:
                out[col] = out[journey_col]
            elif col in existing_cols:
                out[col] = out[col].combine_first(out[journey_col])
            else:
                out[col] = out[journey_col]
            if journey_col != col:
                out = out.drop(columns=[journey_col])
        for col in flag_cols:
            if col in out.columns:
                out[col] = out[col].astype("boolean").fillna(False).astype(bool)
        return out

    def _attach_sales_fact_keys(
        self,
        fact_sales: pd.DataFrame,
        dim_customer: pd.DataFrame | None,
        dim_salesteam: pd.DataFrame | None,
        dim_salesperson: pd.DataFrame | None,
        dim_company: pd.DataFrame | None,
        dim_channel: pd.DataFrame | None,
        dim_segment: pd.DataFrame | None,
        dim_invoice: pd.DataFrame | None,
        qa_unmapped_rows: list[dict[str, object]],
    ) -> pd.DataFrame:
        out = fact_sales.copy()
        out = self._attach_customer_key_by_customer(out, dim_customer, "Fact_Sales", qa_unmapped_rows)
        out = self._attach_sales_team_key_and_segment(out, dim_salesteam, "Fact_Sales", qa_unmapped_rows)
        out = self._attach_sales_team_attributes(out, dim_salesteam)
        out = self._attach_salesperson_key(out, dim_salesperson, "Fact_Sales", qa_unmapped_rows)
        out = self._attach_distribution_channel_key(out, dim_salesperson, dim_channel, "Fact_Sales", qa_unmapped_rows)
        out = self._attach_company_key(out, dim_company, "Fact_Sales", qa_unmapped_rows)
        out = self._attach_segment_key(out, dim_segment, "Fact_Sales", qa_unmapped_rows)
        out = self._attach_invoice_key(out, dim_invoice)

        ordered = [col for col in SalesFactBuilder.COLUMNS if col in out.columns]
        trailing = [col for col in out.columns if col not in ordered]
        return out[ordered + trailing]

    def _attach_customer_key_by_customer(
        self,
        fact: pd.DataFrame,
        dim_customer: pd.DataFrame | None,
        fact_name: str,
        qa_unmapped_rows: list[dict[str, object]],
    ) -> pd.DataFrame:
        out = fact.copy()
        if "CustomerKey" in out.columns:
            out = out.drop(columns=["CustomerKey"])
        if dim_customer is None or dim_customer.empty or not {"CustomerID", "CustomerKey"}.issubset(dim_customer.columns):
            out["CustomerKey"] = pd.NA
            self._append_unmapped_key_rows(out, qa_unmapped_rows, fact_name, "CustomerKey", "Customer", "Dim_Customer unavailable")
            return out

        source_customer_id = out["CustomerID"] if "CustomerID" in out.columns else pd.Series(pd.NA, index=out.index)
        out["_CustomerIDJoin"] = CustomerDimensionBuilder._clean_customer_id(source_customer_id)
        missing_customer_id = out["_CustomerIDJoin"].isna()
        if missing_customer_id.any() and "Customer" in out.columns:
            out.loc[missing_customer_id, "_CustomerIDJoin"] = out.loc[missing_customer_id, "Customer"].apply(CustomerDimensionBuilder._make_synthetic_customer_id)
        lookup = dim_customer[["CustomerID", "CustomerKey"]].dropna(subset=["CustomerID"]).drop_duplicates("CustomerID")
        out = out.merge(lookup, left_on="_CustomerIDJoin", right_on="CustomerID", how="left", validate="m:1", suffixes=("", "_dim"))
        if "CustomerID_dim" in out.columns:
            out = out.drop(columns=["CustomerID_dim"])
        missing = out["CustomerKey"].isna()
        self._append_unmapped_key_rows(out[missing], qa_unmapped_rows, fact_name, "CustomerKey", "Customer", "No Dim_Customer match")
        out["CustomerKey"] = pd.to_numeric(out["CustomerKey"], errors="coerce").astype("Int64")
        return out.drop(columns=["_CustomerIDJoin"], errors="ignore")

    @staticmethod
    def _attach_sales_team_attributes(fact: pd.DataFrame, dim_salesteam: pd.DataFrame | None) -> pd.DataFrame:
        out = fact.copy()
        for col in ["SalesCity", "SalesTeamStatus"]:
            if col in out.columns:
                out = out.drop(columns=[col])
        if dim_salesteam is None or dim_salesteam.empty or "SalesTeamKey" not in dim_salesteam.columns:
            out["SalesCity"] = pd.NA
            out["SalesTeamStatus"] = pd.NA
            return out
        lookup_cols = [col for col in ["SalesTeamKey", "SalesCity", "SalesTeamStatus"] if col in dim_salesteam.columns]
        lookup = dim_salesteam[lookup_cols].drop_duplicates("SalesTeamKey").copy()
        out = out.merge(lookup, on="SalesTeamKey", how="left", validate="m:1")
        if "SalesCity" not in out.columns:
            out["SalesCity"] = pd.NA
        if "SalesTeamStatus" not in out.columns:
            out["SalesTeamStatus"] = pd.NA
        return out

    def _attach_distribution_channel_key(
        self,
        fact: pd.DataFrame,
        dim_salesperson: pd.DataFrame | None,
        dim_channel: pd.DataFrame | None,
        fact_name: str,
        qa_unmapped_rows: list[dict[str, object]],
    ) -> pd.DataFrame:
        out = fact.copy()
        for col in ["DistributionChannel", "ChannelKey"]:
            if col in out.columns:
                out = out.drop(columns=[col])
        if dim_salesperson is not None and not dim_salesperson.empty and {"salesperson", "DistributionChannel"}.issubset(dim_salesperson.columns):
            lookup = dim_salesperson[["salesperson", "DistributionChannel"]].dropna(subset=["salesperson"]).drop_duplicates("salesperson").copy()
            lookup["_SalespersonJoinKey"] = self._normalized_text_series(lookup["salesperson"])
            out["_SalespersonJoinKey"] = self._normalized_text_series(out.get("Salesperson", pd.Series(index=out.index, dtype="object")))
            out = out.merge(
                lookup[["_SalespersonJoinKey", "DistributionChannel"]],
                on="_SalespersonJoinKey",
                how="left",
                validate="m:1",
            )
            out = out.drop(columns=["_SalespersonJoinKey"], errors="ignore")
        else:
            out["DistributionChannel"] = pd.NA
        out["DistributionChannel"] = out["DistributionChannel"].astype("string").fillna(self.pipeline_settings.unknown_channel_name).astype(str).str.strip().replace({"": self.pipeline_settings.unknown_channel_name})
        if dim_channel is None or dim_channel.empty or not {"DistributionChannel", "ChannelKey"}.issubset(dim_channel.columns):
            out["ChannelKey"] = pd.NA
            self._append_unmapped_key_rows(out, qa_unmapped_rows, fact_name, "ChannelKey", "DistributionChannel", "Dim_DistributionChannel unavailable")
            return out
        out = DataFrameUtils.add_key_from_dimension(out, "DistributionChannel", dim_channel, "DistributionChannel", "ChannelKey")
        missing = out["ChannelKey"].isna()
        self._append_unmapped_key_rows(out[missing], qa_unmapped_rows, fact_name, "ChannelKey", "DistributionChannel", "No Dim_DistributionChannel match")
        out["ChannelKey"] = pd.to_numeric(out["ChannelKey"], errors="coerce").astype("Int64")
        return out

    @staticmethod
    def _attach_invoice_key(fact: pd.DataFrame, dim_invoice: pd.DataFrame | None) -> pd.DataFrame:
        out = fact.copy()
        if "InvoiceKey" in out.columns:
            out = out.drop(columns=["InvoiceKey"])
        if dim_invoice is None or dim_invoice.empty or not {"order_number", "InvoiceKey"}.issubset(dim_invoice.columns):
            out["InvoiceKey"] = pd.NA
            return out
        lookup = dim_invoice[["order_number", "InvoiceKey"]].dropna(subset=["order_number"]).drop_duplicates("order_number")
        out = out.merge(lookup, left_on="OrderNumber", right_on="order_number", how="left", validate="m:1").drop(columns=["order_number"], errors="ignore")
        out["InvoiceKey"] = pd.to_numeric(out["InvoiceKey"], errors="coerce").astype("Int64")
        return out

    @staticmethod
    def _ensure_fact_orders_order_key(fact_orders: pd.DataFrame) -> pd.DataFrame:
        out = fact_orders.copy()
        if "OrderKey" in out.columns:
            return out
        if "SalesOrderID" in out.columns and out["SalesOrderID"].notna().all() and not out["SalesOrderID"].duplicated().any():
            out.insert(0, "OrderKey", pd.to_numeric(out["SalesOrderID"], errors="coerce").astype("Int64").astype("string"))
        elif "order_number" in out.columns:
            out.insert(0, "OrderKey", out["order_number"].astype("string"))
        else:
            out.insert(0, "OrderKey", pd.Series([f"ORDER-{idx + 1}" for idx in range(len(out))], index=out.index, dtype="string"))
        return out

    def _attach_order_created_datetime(self, fact_orders: pd.DataFrame, sale_orders_raw: pd.DataFrame | None) -> pd.DataFrame:
        """Adds Fact_Orders.CreatedDateTime -- Odoo sale.order.create_date (record creation),
        distinct from OrderDateTime (sale.order.date_order, the order/confirmation date). sale.report
        -- the line-level source `sales`/OrdersFactBuilder.build() is otherwise built from -- has no
        create_date field at all (confirmed against the live Odoo instance), so this is sourced
        separately from sale_orders_raw (the raw sale.order fetch both the full and incremental
        extraction paths already pull, see run()'s `sale_orders_raw` variable), joined by order
        number/name, and converted with the same odoo_utc_datetime_to_local(..., self.settings.timezone)
        used for order_date so both fields land in Libya local time consistently.
        """
        out = fact_orders.copy()
        if sale_orders_raw is None or sale_orders_raw.empty or "name" not in sale_orders_raw.columns or "create_date" not in sale_orders_raw.columns or "order_number" not in out.columns:
            out["CreatedDateTime"] = pd.NaT
            return out
        created = sale_orders_raw[["name", "create_date"]].copy()
        created["name"] = created["name"].astype("string").str.strip().str.upper()
        created = created.dropna(subset=["name"]).drop_duplicates(subset=["name"], keep="first")
        created["CreatedDateTime"] = odoo_utc_datetime_to_local(created["create_date"], self.settings.timezone)
        out = out.merge(created[["name", "CreatedDateTime"]], left_on="order_number", right_on="name", how="left").drop(columns=["name"])
        return out

    @staticmethod
    def _align_fact_orders_with_fact_sales(fact_orders: pd.DataFrame, fact_sales: pd.DataFrame) -> pd.DataFrame:
        if fact_orders.empty or fact_sales.empty or "order_number" not in fact_orders.columns:
            return fact_orders
        sales_orders = fact_sales.loc[fact_sales.get("SalesDocumentType", pd.Series(index=fact_sales.index)).eq("Sales Order")].copy()
        if sales_orders.empty or "OrderNumber" not in sales_orders.columns:
            return fact_orders
        link_cols = [
            "OrderNumber",
            "SalesDocumentID",
            "SalesDocumentType",
            "QuotationID",
            "SourceQuotationID",
            "OrderID",
            "SalesOrderID",
            "JourneyKey",
            "JourneyType",
            "FlowType",
            "HasLead",
            "HasOpportunity",
            "HasQuotation",
            "HasSalesOrder",
            "HasDelivery",
            "DeliveryID",
            "DeliveryStatus",
            "OpportunityID",
            "LeadID",
            "LeadCreatedDate",
            "OpportunityCreatedDate",
            "QuotationDate",
            "SalesOrderDate",
            "QuotationAgeMinutes",
            "QuotationAgeHours",
            "QuotationToSalesOrderMinutes",
            "QuotationToSalesOrderHours",
            "IsRealQuotation",
            "IsSystemGeneratedQuotation",
            "IsWonQuotation",
            "QuotationClassification",
            "QuotationRealReason",
            "IsRealSalesOrder",
            "SalesOrderClassification",
            "DeliveryDate",
            "IsLinkedToOpportunity",
        ]
        lookup = sales_orders[[col for col in link_cols if col in sales_orders.columns]].drop_duplicates("OrderNumber")
        out = fact_orders.merge(lookup, left_on="order_number", right_on="OrderNumber", how="left", validate="m:1")
        return out.drop(columns=["OrderNumber"], errors="ignore")

    def _extend_dim_date_for_sales_and_delivery(self, sheets: dict[str, pd.DataFrame], refresh_date: Any | None = None) -> pd.DataFrame:
        date_values: list[pd.Series] = []
        fact_orders = sheets.get("Fact_Orders", pd.DataFrame())
        for col in ["OrderDate", "OrderDateTime", "order_date_date", "order_date"]:
            if col in fact_orders.columns:
                date_values.append(fact_orders[col])
        fact_sales = sheets.get("Fact_Sales", pd.DataFrame())
        for col in ["OrderDate", "OrderDateTime", "order_date_date", "order_date"]:
            if col in fact_sales.columns:
                date_values.append(fact_sales[col])
        # Also derive dates from DateKey (YYYYMMDD int) if no date columns are present
        if not date_values:
            for fact_name in ("Fact_Orders", "Fact_Sales"):
                fact = sheets.get(fact_name, pd.DataFrame())
                if "DateKey" in fact.columns:
                    dk = pd.to_numeric(fact["DateKey"], errors="coerce").dropna().astype(int)
                    dates = pd.to_datetime(dk.astype(str), format="%Y%m%d", errors="coerce").dropna()
                    date_values.append(dates)
        fact_inventory = sheets.get("Fact_Inventory", pd.DataFrame())
        if "SnapshotDate" in fact_inventory.columns:
            date_values.append(fact_inventory["SnapshotDate"])
        if not date_values:
            return sheets.get("Dim_Date", pd.DataFrame())
        order_dates = pd.to_datetime(pd.concat(date_values, ignore_index=True), errors="coerce").dropna()
        if order_dates.empty:
            return sheets.get("Dim_Date", pd.DataFrame())
        refresh = pd.Timestamp(refresh_date) if refresh_date is not None else pd.Timestamp.now(tz=self.settings.timezone)
        if refresh.tzinfo is not None:
            refresh = refresh.tz_convert(self.settings.timezone).tz_localize(None)
        refresh = refresh.normalize()
        start = order_dates.min().normalize()
        max_order_date = order_dates.max().normalize()
        end = max(max_order_date, refresh)
        self.logger.info("Dim_Date range: start=%s end=%s refresh_date=%s", start.date(), end.date(), refresh.date())
        return DateDimensionBuilder(self.pipeline_settings.weekly_rest_day_name).build(pd.DataFrame({"order_date_date": pd.date_range(start=start, end=end, freq="D")}))

    def _validate_model_key_integrity(self, sheets: dict[str, pd.DataFrame], refresh_date: Any | None = None) -> None:
        dim_invoice = sheets.get("Dim_Invoice", pd.DataFrame())
        if "InvoiceKey" in dim_invoice.columns:
            duplicate_dim_invoice = int(dim_invoice["InvoiceKey"].dropna().duplicated().sum())
            if duplicate_dim_invoice:
                raise RuntimeError(f"Dim_Invoice[InvoiceKey] must be unique; duplicates={duplicate_dim_invoice}")
        fact_orders = sheets.get("Fact_Orders", pd.DataFrame())
        if "OrderKey" in fact_orders.columns:
            duplicate_order_key = int(fact_orders["OrderKey"].dropna().duplicated().sum())
            if duplicate_order_key:
                raise RuntimeError(f"Fact_Orders[OrderKey] must be unique; duplicates={duplicate_order_key}")
        if "InvoiceKey" in fact_orders.columns:
            duplicate_fact_invoice = int(fact_orders["InvoiceKey"].dropna().duplicated().sum())
            self.logger.info("Fact_Orders duplicate InvoiceKey rows=%s; allowed because Fact_Orders is many-side to Dim_Invoice", duplicate_fact_invoice)
        dim_date = sheets.get("Dim_Date", pd.DataFrame())
        if "DateKey" not in dim_date.columns:
            raise RuntimeError("Dim_Date[DateKey] is required for sales/order date validation")
        dim_date_keys = set(pd.to_numeric(dim_date["DateKey"], errors="coerce").dropna().astype(int))
        for table_name in ["Fact_Orders", "Fact_Sales", "Fact_Delivery", "Fact_Inventory"]:
            fact = sheets.get(table_name, pd.DataFrame())
            key_col = "SnapshotDateKey" if table_name == "Fact_Inventory" else ("OrderDateKey" if "OrderDateKey" in fact.columns else "DateKey")
            if key_col not in fact.columns:
                continue
            fact_keys = set(pd.to_numeric(fact[key_col], errors="coerce").dropna().astype(int))
            missing = sorted(fact_keys - dim_date_keys)
            if missing:
                raise RuntimeError(f"{table_name}[{key_col}] has {len(missing)} DateKey value(s) missing from Dim_Date; first={missing[:5]}")
        refresh = pd.Timestamp(refresh_date) if refresh_date is not None else pd.Timestamp.now(tz=self.settings.timezone)
        if refresh.tzinfo is not None:
            refresh = refresh.tz_convert(self.settings.timezone).tz_localize(None)
        refresh_key = int(refresh.normalize().strftime("%Y%m%d"))
        if refresh_key not in dim_date_keys:
            raise RuntimeError(f"Dim_Date is missing refresh DateKey {refresh_key}")

    @staticmethod
    def _build_pipeline_data_quality_checks(
        fact_pipeline: pd.DataFrame,
        fact_sales: pd.DataFrame,
        fact_delivery: pd.DataFrame,
        fact_orders: pd.DataFrame | None = None,
    ) -> pd.DataFrame:
        rows: list[dict[str, object]] = []

        def add(check: str, value: int, ok: bool, notes: str) -> None:
            rows.append({"CheckName": check, "MetricValue": int(value), "Status": "PASS" if ok else "FAIL", "Notes": notes})

        def info(check: str, value: int, notes: str) -> None:
            rows.append({"CheckName": check, "MetricValue": int(value), "Status": "INFO", "Notes": notes})

        pipeline_record_id = fact_pipeline.get("PipelineRecordID", pd.Series(pd.NA, index=fact_pipeline.index)).astype("string")
        lead_id = fact_pipeline.get("LeadID", pd.Series(pd.NA, index=fact_pipeline.index)).astype("string")
        lead_type = fact_pipeline.get("LeadType", pd.Series(pd.NA, index=fact_pipeline.index)).astype("string").str.strip()
        opportunity_id = fact_pipeline.get("OpportunityID", pd.Series(pd.NA, index=fact_pipeline.index))
        opportunity_mask = (
            opportunity_id.notna()
            & ~lead_type.str.lower().isin(["lead", "systematic"])
            & (pipeline_record_id.str.startswith("OPP-", na=False) | lead_type.str.lower().eq("opportunity"))
        )
        missing_opp_journey = int(fact_pipeline.loc[opportunity_mask, "JourneyKey"].isna().sum()) if "JourneyKey" in fact_pipeline.columns else int(opportunity_mask.sum())
        add("Every opportunity has JourneyKey", missing_opp_journey, missing_opp_journey == 0, "Opportunity rows must be traceable through a real Odoo or ETL-created lead history step.")

        duplicate_opportunities = int(fact_pipeline.loc[opportunity_mask, "OpportunityID"].duplicated().sum()) if "OpportunityID" in fact_pipeline.columns else 0
        add("Every opportunity appears once", duplicate_opportunities, duplicate_opportunities == 0, "Each Odoo opportunity should have exactly one opportunity row.")

        is_odoo_lead = coerce_nullable_bool(fact_pipeline.get("IsOdooCreatedLead", pd.Series(False, index=fact_pipeline.index))).fillna(False).astype(bool)
        is_etl_lead = coerce_nullable_bool(fact_pipeline.get("IsETLCreatedLead", pd.Series(False, index=fact_pipeline.index))).fillna(False).astype(bool)
        has_lead = coerce_nullable_bool(fact_pipeline.get("HasLead", pd.Series(False, index=fact_pipeline.index))).fillna(False).astype(bool)
        lead_created = pd.to_datetime(fact_pipeline.get("LeadCreatedDate", pd.Series(pd.NaT, index=fact_pipeline.index)), errors="coerce")
        opportunity_created = pd.to_datetime(fact_pipeline.get("OpportunityCreatedDate", pd.Series(pd.NaT, index=fact_pipeline.index)), errors="coerce")

        missing_lead_history = int((opportunity_mask & (~has_lead | lead_id.isna() | lead_created.isna() | opportunity_created.isna())).sum())
        add("Every opportunity has lead history row", missing_lead_history, missing_lead_history == 0, "Each opportunity journey must include a real Odoo or ETL-created lead step.")

        lead_after_opportunity = int((opportunity_mask & lead_created.notna() & opportunity_created.notna() & lead_created.ge(opportunity_created)).sum())
        add("Opportunity lead history predates opportunity", lead_after_opportunity, lead_after_opportunity == 0, "LeadCreatedDate must be before OpportunityCreatedDate; ETL lead history uses opportunity time minus one minute.")

        etl_lead_rows = lead_type.eq("Systematic") | is_etl_lead
        invalid_etl_flags = int(
            (
                etl_lead_rows
                & (
                    ~is_etl_lead
                    | is_odoo_lead
                    | ~fact_pipeline.get("LeadCreationSource", pd.Series(pd.NA, index=fact_pipeline.index)).astype("string").eq("ETL")
                    | ~lead_id.str.startswith("ETL-LEAD-", na=False)
                )
            ).sum()
        )
        add("ETL-created lead history is flagged", invalid_etl_flags, invalid_etl_flags == 0, "ETL history rows must have IsETLCreatedLead=true, IsOdooCreatedLead=false, and LeadCreationSource=ETL.")

        odoo_lead_rows = lead_type.str.lower().eq("lead")
        invalid_odoo_flags = int((odoo_lead_rows & (~is_odoo_lead | is_etl_lead)).sum())
        add("Odoo lead rows are flagged", invalid_odoo_flags, invalid_odoo_flags == 0, "Real Odoo lead rows must have IsOdooCreatedLead=true and IsETLCreatedLead=false.")

        real_leads = int((lead_type.str.lower().eq("lead") & is_odoo_lead & ~opportunity_mask).sum())
        etl_leads = int(etl_lead_rows.sum())
        opportunity_relationships = int(opportunity_mask.sum())
        info("Real Odoo lead rows", real_leads, "LeadType = lead and LeadCreationSource = Odoo.")
        info("ETL-created lead history rows", etl_leads, "LeadType = Systematic and LeadCreationSource = ETL.")
        info("Odoo opportunity rows", opportunity_relationships, "Natural Odoo opportunities, including records completed by ETL lead history.")

        sales_order_mask = fact_sales.get("SalesDocumentType", pd.Series(pd.NA, index=fact_sales.index)).eq("Sales Order")
        missing_quotation_link = int(
            (
                sales_order_mask
                & fact_sales.get("SourceQuotationID", pd.Series(pd.NA, index=fact_sales.index)).isna()
                & fact_sales.get("QuotationID", pd.Series(pd.NA, index=fact_sales.index)).isna()
            ).sum()
        )
        add("Every sales order has quotation linkage", missing_quotation_link, missing_quotation_link == 0, "Sales orders must retain SourceQuotationID or QuotationID.")

        invalid_quotation_sequence = int(fact_sales.get("QuotationClassification", pd.Series(pd.NA, index=fact_sales.index)).eq("Invalid Date Sequence").sum())
        add("Quotation to sales order date sequence is valid", invalid_quotation_sequence, invalid_quotation_sequence == 0, "SalesOrderDate must be on or after QuotationDate.")

        invalid_real_sales_orders = int(
            (
                fact_sales.get("IsRealSalesOrder", pd.Series(False, index=fact_sales.index)).fillna(False).astype(bool)
                & ~fact_sales.get("IsRealQuotation", pd.Series(False, index=fact_sales.index)).fillna(False).astype(bool)
            ).sum()
        )
        add("Real sales orders come from real quotations", invalid_real_sales_orders, invalid_real_sales_orders == 0, "IsRealSalesOrder may only be true when IsRealQuotation is true.")

        missing_sales_journey = int(fact_sales.get("JourneyKey", pd.Series(pd.NA, index=fact_sales.index)).isna().sum())
        add("Every sales document has JourneyKey", missing_sales_journey, missing_sales_journey == 0, "Quotations and sales orders must be traceable through the journey spine.")

        journey_timeline_violations = PowerBISalesPipeline._journey_timeline_violations(fact_pipeline, fact_sales, fact_delivery)
        add("Journey timeline dates are chronological", journey_timeline_violations, journey_timeline_violations == 0, "Expected order is LeadCreatedDate <= OpportunityCreatedDate <= QuotationDate <= SalesOrderDate <= DeliveryDate.")

        missing_delivery_order = int(fact_delivery.get("SalesOrderID", pd.Series(pd.NA, index=fact_delivery.index)).isna().sum())
        add("Every delivery has SalesOrderID", missing_delivery_order, missing_delivery_order == 0, "Delivery rows must link to a sales order.")

        missing_delivery_journey = int(fact_delivery.get("JourneyKey", pd.Series(pd.NA, index=fact_delivery.index)).isna().sum())
        add("Every delivery has JourneyKey", missing_delivery_journey, missing_delivery_journey == 0, "Delivery rows must inherit the sales order journey spine.")

        null_delivery_status = int(fact_delivery.get("DeliveryStatus", pd.Series(pd.NA, index=fact_delivery.index)).isna().sum())
        add("DeliveryStatus is never null", null_delivery_status, null_delivery_status == 0, "DeliveryStatus must be populated for slicers.")

        allowed = {"Not Delivered", "Started", "Partially Delivered", "Fully Delivered"}
        invalid_delivery_status = int((~fact_delivery.get("DeliveryStatus", pd.Series(pd.NA, index=fact_delivery.index)).isin(allowed)).sum())
        add("DeliveryStatus uses allowed values", invalid_delivery_status, invalid_delivery_status == 0, "Allowed values are Not Delivered, Started, Partially Delivered, Fully Delivered.")

        missing_flow_type = int(
            fact_sales.get("FlowType", pd.Series(pd.NA, index=fact_sales.index)).isna().sum()
            + fact_pipeline.get("FlowType", pd.Series(pd.NA, index=fact_pipeline.index)).isna().sum()
            + fact_delivery.get("FlowType", pd.Series(pd.NA, index=fact_delivery.index)).isna().sum()
        )
        add("FlowType is populated", missing_flow_type, missing_flow_type == 0, "Every journey row should expose its furthest reached stage.")

        sales_without_crm = int(
            (
                fact_sales.get("HasSalesOrder", pd.Series(False, index=fact_sales.index)).fillna(False).astype(bool)
                & ~fact_sales.get("HasLead", pd.Series(False, index=fact_sales.index)).fillna(False).astype(bool)
                & ~fact_sales.get("HasOpportunity", pd.Series(False, index=fact_sales.index)).fillna(False).astype(bool)
            ).sum()
        )
        info("Sales order rows without CRM", sales_without_crm, "Sales-order documents whose journey has no lead or opportunity.")

        if fact_orders is not None and "InvoiceKey" in fact_orders.columns:
            duplicate_invoice_keys = int(fact_orders["InvoiceKey"].dropna().duplicated().sum())
            info(
                "Fact_Orders duplicate InvoiceKey rows",
                duplicate_invoice_keys,
                "Informational only: Dim_Invoice[InvoiceKey] is the one side; Fact_Orders[InvoiceKey] is the many side.",
            )

        missing_pipeline_columns = len([col for col in PipelineFactBuilder.COLUMNS if col not in fact_pipeline.columns])
        add("CRM journey spine keeps required columns", missing_pipeline_columns, missing_pipeline_columns == 0, "The internal CRM spine must preserve source CRM fields before splitting into lead and opportunity facts.")
        return pd.DataFrame(rows, columns=["CheckName", "MetricValue", "Status", "Notes"])

    @staticmethod
    def _journey_timeline_violations(*facts: pd.DataFrame) -> int:
        date_cols = ["LeadCreatedDate", "OpportunityCreatedDate", "QuotationDate", "SalesOrderDate", "DeliveryDate"]
        frames: list[pd.DataFrame] = []
        for fact in facts:
            if fact.empty or "JourneyKey" not in fact.columns:
                continue
            cols = ["JourneyKey"] + [col for col in date_cols if col in fact.columns]
            frames.append(fact[cols].copy())
        if not frames:
            return 0
        combined = pd.concat(frames, ignore_index=True).dropna(subset=["JourneyKey"])
        if combined.empty:
            return 0
        for col in date_cols:
            if col not in combined.columns:
                combined[col] = pd.NaT
            combined[col] = pd.to_datetime(combined[col], errors="coerce")
        grouped = combined.groupby("JourneyKey", as_index=False).agg({col: PowerBISalesPipeline._min_datetime for col in date_cols})
        # PERF: Replaced iterrows() timeline check with vectorized column comparisons.
        # Each pair of adjacent date columns is compared across ALL rows at once using
        # pandas boolean masks instead of a Python loop per journey.
        violations_mask = pd.Series(False, index=grouped.index)
        for i in range(len(date_cols) - 1):
            earlier_col = date_cols[i]
            later_col = date_cols[i + 1]
            t_earlier = pd.to_datetime(grouped[earlier_col], errors="coerce")
            t_later = pd.to_datetime(grouped[later_col], errors="coerce")
            both_present = t_earlier.notna() & t_later.notna()
            out_of_order = both_present & (t_later < t_earlier)
            violations_mask |= out_of_order
        return int(violations_mask.sum())

    def _attach_pipeline_fact_sales_keys(
        self,
        fact_pipeline: pd.DataFrame,
        dim_customer: pd.DataFrame | None,
        dim_salesteam: pd.DataFrame | None,
        dim_salesperson: pd.DataFrame | None,
        dim_company: pd.DataFrame | None,
        dim_segment: pd.DataFrame | None,
        dim_lost_reason: pd.DataFrame | None,
        qa_unmapped_rows: list[dict[str, object]],
    ) -> pd.DataFrame:
        out = fact_pipeline.copy()
        out = self._attach_customer_key_by_customer(out, dim_customer, "CRM_JourneySpine", qa_unmapped_rows)
        out = self._attach_sales_team_key_and_segment(out, dim_salesteam, "CRM_JourneySpine", qa_unmapped_rows)
        out = self._attach_salesperson_key(out, dim_salesperson, "CRM_JourneySpine", qa_unmapped_rows)
        out = self._attach_company_key(out, dim_company, "CRM_JourneySpine", qa_unmapped_rows)
        out = self._attach_segment_key(out, dim_segment, "CRM_JourneySpine", qa_unmapped_rows)
        out = self._attach_lost_reason_key(out, dim_lost_reason, "CRM_JourneySpine", qa_unmapped_rows)
        ordered = [col for col in PipelineFactBuilder.COLUMNS if col in out.columns]
        trailing = [col for col in out.columns if col not in ordered]
        return out[ordered + trailing]

    def _attach_sales_team_key_and_segment(
        self,
        fact: pd.DataFrame,
        dim_salesteam: pd.DataFrame | None,
        fact_name: str,
        qa_unmapped_rows: list[dict[str, object]],
    ) -> pd.DataFrame:
        out = fact.copy()
        for col in ["SalesTeamKey", "SalesSegment"]:
            if col in out.columns:
                out = out.drop(columns=[col])
        if dim_salesteam is None or dim_salesteam.empty or not {"SalesTeam", "SalesTeamKey"}.issubset(dim_salesteam.columns):
            out["SalesTeamKey"] = self.pipeline_settings.unknown_team_key
            out["SalesSegment"] = self.pipeline_settings.unknown_segment_name
            self.logger.warning(
                "%s SalesTeamKey mapping skipped: Dim_SalesTeam unavailable; rows assigned unknown=%s",
                fact_name,
                f"{len(out):,}",
            )
            self._append_unmapped_key_rows(out, qa_unmapped_rows, fact_name, "SalesTeamKey", "SalesTeam", "Dim_SalesTeam unavailable")
            return out

        lookup_cols = ["SalesTeam", "SalesTeamKey"]
        if "SalesSegment" in dim_salesteam.columns:
            lookup_cols.append("SalesSegment")
        if "SalesTeamCompany" in dim_salesteam.columns and "Company" in out.columns:
            lookup_cols.append("SalesTeamCompany")
        lookup = dim_salesteam[lookup_cols].copy()
        lookup["_SalesTeamJoinKey"] = self._normalized_text_series(lookup["SalesTeam"])
        out["_SalesTeamJoinKey"] = self._normalized_text_series(out.get("SalesTeam", pd.Series(index=out.index, dtype="object")))
        if "SalesTeamCompany" in lookup.columns and "Company" in out.columns:
            lookup["_CompanyJoinKey"] = self._normalized_text_series(lookup["SalesTeamCompany"])
            out["_CompanyJoinKey"] = self._normalized_text_series(out["Company"])
            composite_lookup = lookup.dropna(subset=["_SalesTeamJoinKey", "_CompanyJoinKey"]).drop_duplicates(subset=["_SalesTeamJoinKey", "_CompanyJoinKey"])
            out = out.merge(
                composite_lookup[["_SalesTeamJoinKey", "_CompanyJoinKey", "SalesTeamKey"] + (["SalesSegment"] if "SalesSegment" in composite_lookup.columns else [])],
                on=["_SalesTeamJoinKey", "_CompanyJoinKey"],
                how="left",
                validate="m:1",
            )
            missing = out["SalesTeamKey"].isna()
            if missing.any():
                name_lookup = lookup.dropna(subset=["_SalesTeamJoinKey"]).drop_duplicates(subset=["_SalesTeamJoinKey"])
                fallback = out.loc[missing, ["_SalesTeamJoinKey"]].merge(
                    name_lookup[["_SalesTeamJoinKey", "SalesTeamKey"] + (["SalesSegment"] if "SalesSegment" in name_lookup.columns else [])],
                    on="_SalesTeamJoinKey",
                    how="left",
                    validate="m:1",
                    suffixes=("", "_name"),
                )
                out.loc[missing, "SalesTeamKey"] = fallback["SalesTeamKey"].to_numpy()
                if "SalesSegment_name" in fallback.columns:
                    out.loc[missing, "SalesSegment"] = fallback["SalesSegment_name"].to_numpy()
                elif "SalesSegment" in fallback.columns:
                    out.loc[missing, "SalesSegment"] = fallback["SalesSegment"].to_numpy()
        else:
            lookup = lookup.dropna(subset=["_SalesTeamJoinKey"]).drop_duplicates(subset=["_SalesTeamJoinKey"])
            out = out.merge(
                lookup[["_SalesTeamJoinKey", "SalesTeamKey"] + (["SalesSegment"] if "SalesSegment" in lookup.columns else [])],
                on="_SalesTeamJoinKey",
                how="left",
                validate="m:1",
            )
        matched = int(out["SalesTeamKey"].notna().sum())
        unmapped = len(out) - matched
        self._append_unmapped_key_rows(out[out["SalesTeamKey"].isna()], qa_unmapped_rows, fact_name, "SalesTeamKey", "SalesTeam", "No Dim_SalesTeam match")
        out["SalesTeamKey"] = out["SalesTeamKey"].astype("string").fillna(self.pipeline_settings.unknown_team_key).astype(str)
        if "SalesSegment" not in out.columns:
            out["SalesSegment"] = self.pipeline_settings.unknown_segment_name
        out["SalesSegment"] = out["SalesSegment"].astype("string").fillna(self.pipeline_settings.unknown_segment_name).astype(str).str.strip().replace({"": self.pipeline_settings.unknown_segment_name})
        out = out.drop(columns=["_SalesTeamJoinKey", "_CompanyJoinKey"], errors="ignore")
        self.logger.info(
            "%s SalesTeamKey mapping: matched=%s unmapped=%s unknown_key=%s",
            fact_name,
            f"{matched:,}",
            f"{unmapped:,}",
            self.pipeline_settings.unknown_team_key,
        )
        return out

    def _attach_salesperson_key(
        self,
        fact: pd.DataFrame,
        dim_salesperson: pd.DataFrame | None,
        fact_name: str,
        qa_unmapped_rows: list[dict[str, object]],
    ) -> pd.DataFrame:
        out = fact.copy()
        if "SalespersonKey" in out.columns:
            out = out.drop(columns=["SalespersonKey"])

        if dim_salesperson is None or dim_salesperson.empty or not {"salesperson", "SalespersonKey"}.issubset(dim_salesperson.columns):
            out["SalespersonKey"] = self.pipeline_settings.unknown_salesperson_key
            self.logger.warning(
                "%s SalespersonKey mapping skipped: Dim_Salesperson unavailable; rows assigned unknown=%s",
                fact_name,
                f"{len(out):,}",
            )
            self._append_unmapped_key_rows(out, qa_unmapped_rows, fact_name, "SalespersonKey", "Salesperson", "Dim_Salesperson unavailable")
            return out

        lookup = dim_salesperson[["salesperson", "SalespersonKey"]].copy()
        lookup["_SalespersonJoinKey"] = self._normalized_text_series(lookup["salesperson"])
        lookup = lookup.dropna(subset=["_SalespersonJoinKey"]).drop_duplicates(subset=["_SalespersonJoinKey"])
        out["_SalespersonJoinKey"] = self._normalized_text_series(out.get("Salesperson", pd.Series(index=out.index, dtype="object")))
        out = out.merge(lookup[["_SalespersonJoinKey", "SalespersonKey"]], on="_SalespersonJoinKey", how="left", validate="m:1")
        matched = int(out["SalespersonKey"].notna().sum())
        unmapped = len(out) - matched
        self._append_unmapped_key_rows(out[out["SalespersonKey"].isna()], qa_unmapped_rows, fact_name, "SalespersonKey", "Salesperson", "No Dim_Salesperson match")
        out["SalespersonKey"] = (
            pd.to_numeric(out["SalespersonKey"], errors="coerce")
            .fillna(self.pipeline_settings.unknown_salesperson_key)
            .astype(int)
        )
        out = out.drop(columns=["_SalespersonJoinKey"], errors="ignore")
        self.logger.info(
            "%s SalespersonKey mapping: matched=%s unmapped=%s unknown_key=%s",
            fact_name,
            f"{matched:,}",
            f"{unmapped:,}",
            self.pipeline_settings.unknown_salesperson_key,
        )
        return out

    def _attach_segment_key(
        self,
        fact: pd.DataFrame,
        dim_segment: pd.DataFrame | None,
        fact_name: str,
        qa_unmapped_rows: list[dict[str, object]],
    ) -> pd.DataFrame:
        out = fact.copy()
        if "SegmentKey" in out.columns:
            out = out.drop(columns=["SegmentKey"])
        if "SalesSegment" not in out.columns:
            out["SalesSegment"] = self.pipeline_settings.unknown_segment_name
        out["SalesSegment"] = SegmentDimensionBuilder.normalize_segment_series(
            out["SalesSegment"].fillna(self.pipeline_settings.unknown_segment_name)
        )

        if dim_segment is None or dim_segment.empty or not {"Segment", "SegmentKey"}.issubset(dim_segment.columns):
            out["SegmentKey"] = pd.NA
            self.logger.warning("%s SegmentKey mapping skipped: Dim_Segment unavailable; rows assigned null=%s", fact_name, f"{len(out):,}")
            self._append_unmapped_key_rows(out, qa_unmapped_rows, fact_name, "SegmentKey", "SalesSegment", "Dim_Segment unavailable")
            return out

        lookup = dim_segment[["Segment", "SegmentKey"]].copy()
        lookup["_SegmentJoinKey"] = self._normalized_text_series(lookup["Segment"])
        lookup = lookup.dropna(subset=["_SegmentJoinKey"]).drop_duplicates(subset=["_SegmentJoinKey"])
        out["_SegmentJoinKey"] = self._normalized_text_series(out["SalesSegment"])
        out = out.merge(lookup[["_SegmentJoinKey", "SegmentKey"]], on="_SegmentJoinKey", how="left", validate="m:1")
        matched = int(out["SegmentKey"].notna().sum())
        unmapped = len(out) - matched
        self._append_unmapped_key_rows(out[out["SegmentKey"].isna()], qa_unmapped_rows, fact_name, "SegmentKey", "SalesSegment", "No Dim_Segment match")
        out["SegmentKey"] = pd.to_numeric(out["SegmentKey"], errors="coerce").astype("Int64")
        out = out.drop(columns=["_SegmentJoinKey"], errors="ignore")
        self.logger.info("%s SegmentKey mapping: matched=%s unmapped=%s", fact_name, f"{matched:,}", f"{unmapped:,}")
        return out

    def _attach_company_key(
        self,
        fact: pd.DataFrame,
        dim_company: pd.DataFrame | None,
        fact_name: str,
        qa_unmapped_rows: list[dict[str, object]],
    ) -> pd.DataFrame:
        out = fact.copy()
        if "CompanyKey" in out.columns:
            out = out.drop(columns=["CompanyKey"])

        if dim_company is None or dim_company.empty or not {"Company", "CompanyKey"}.issubset(dim_company.columns):
            out["CompanyKey"] = pd.NA
            self.logger.warning("%s CompanyKey mapping skipped: Dim_Company unavailable; rows assigned null=%s", fact_name, f"{len(out):,}")
            self._append_unmapped_key_rows(out, qa_unmapped_rows, fact_name, "CompanyKey", "Company", "Dim_Company unavailable")
            return out

        lookup = dim_company[["Company", "CompanyKey"]].copy()
        lookup["_CompanyJoinKey"] = self._normalized_text_series(lookup["Company"])
        lookup = lookup.dropna(subset=["_CompanyJoinKey"]).drop_duplicates(subset=["_CompanyJoinKey"])
        out["_CompanyJoinKey"] = self._normalized_text_series(out.get("Company", pd.Series(index=out.index, dtype="object")))
        out = out.merge(lookup[["_CompanyJoinKey", "CompanyKey"]], on="_CompanyJoinKey", how="left", validate="m:1")
        matched = int(out["CompanyKey"].notna().sum())
        unmapped = len(out) - matched
        self._append_unmapped_key_rows(out[out["CompanyKey"].isna()], qa_unmapped_rows, fact_name, "CompanyKey", "Company", "No Dim_Company match")
        out["CompanyKey"] = pd.to_numeric(out["CompanyKey"], errors="coerce").astype("Int64")
        out = out.drop(columns=["_CompanyJoinKey"], errors="ignore")
        self.logger.info("%s CompanyKey mapping: matched=%s unmapped=%s", fact_name, f"{matched:,}", f"{unmapped:,}")
        return out

    def _attach_lost_reason_key(
        self,
        fact: pd.DataFrame,
        dim_lost_reason: pd.DataFrame | None,
        fact_name: str,
        qa_unmapped_rows: list[dict[str, object]],
    ) -> pd.DataFrame:
        out = fact.copy()
        existing = pd.to_numeric(out.get("LostReasonID", pd.Series(index=out.index, dtype="object")), errors="coerce").astype("Int64")

        if dim_lost_reason is None or dim_lost_reason.empty or not {"LostReason", "LostReasonID"}.issubset(dim_lost_reason.columns):
            out["LostReasonID"] = existing
            self.logger.warning("%s LostReasonID mapping skipped: Dim_LostReason unavailable; rows assigned null=%s", fact_name, f"{int(existing.isna().sum()):,}")
            source_present = out.get("LostReason", pd.Series(index=out.index, dtype="object")).notna()
            self._append_unmapped_key_rows(out[out["LostReasonID"].isna() & source_present], qa_unmapped_rows, fact_name, "LostReasonID", "LostReason", "Dim_LostReason unavailable")
            return out

        lookup = dim_lost_reason[["LostReason", "LostReasonID"]].copy()
        lookup["_LostReasonJoinKey"] = self._normalized_text_series(lookup["LostReason"])
        lookup = lookup.dropna(subset=["_LostReasonJoinKey"]).drop_duplicates(subset=["_LostReasonJoinKey"])
        out["_LostReasonJoinKey"] = self._normalized_text_series(out.get("LostReason", pd.Series(index=out.index, dtype="object")))
        out = out.merge(
            lookup[["_LostReasonJoinKey", "LostReasonID"]].rename(columns={"LostReasonID": "LostReasonID_lookup"}),
            on="_LostReasonJoinKey",
            how="left",
            validate="m:1",
        )
        out["LostReasonID"] = existing.combine_first(pd.to_numeric(out["LostReasonID_lookup"], errors="coerce").astype("Int64"))
        source_present = out.get("LostReason", pd.Series(index=out.index, dtype="object")).notna()
        missing = out["LostReasonID"].isna() & source_present
        matched = int(out["LostReasonID"].notna().sum())
        unmapped = int(missing.sum())
        self._append_unmapped_key_rows(out[missing], qa_unmapped_rows, fact_name, "LostReasonID", "LostReason", "No Dim_LostReason match")
        out = out.drop(columns=["_LostReasonJoinKey", "LostReasonID_lookup"], errors="ignore")
        self.logger.info("%s LostReasonID mapping: matched=%s unmapped=%s", fact_name, f"{matched:,}", f"{unmapped:,}")
        return out

    @staticmethod
    def _normalized_text_series(series: pd.Series) -> pd.Series:
        return (
            series.astype("string")
            .str.strip()
            .str.lower()
            .str.replace(r"\s+", " ", regex=True)
            .replace({"": pd.NA, "false": pd.NA, "nan": pd.NA, "none": pd.NA, "<na>": pd.NA})
        )

    @staticmethod
    def _append_unmapped_key_rows(
        rows: pd.DataFrame,
        qa_unmapped_rows: list[dict[str, object]],
        table_name: str,
        key_name: str,
        source_col: str,
        notes: str,
    ) -> None:
        if rows.empty:
            return
        lead_values = rows["LeadID"] if "LeadID" in rows.columns else pd.Series(pd.NA, index=rows.index)
        source_values = rows[source_col] if source_col in rows.columns else pd.Series(pd.NA, index=rows.index)
        for idx in rows.index:
            qa_unmapped_rows.append(
                {
                    "TableName": table_name,
                    "KeyName": key_name,
                    "SourceValue": source_values.loc[idx],
                    "LeadID": lead_values.loc[idx],
                    "Notes": notes,
                }
            )

    def _sync_and_read_staging(
        self,
        client: OdooClient,
        requested_full_refresh: bool,
        force: bool,
        force_sales_full_refresh: bool,
        odoo_cutoff_utc: str | None,
        incremental_since_utc: pd.Timestamp | None = None,
    ) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame, int, bool]:
        store = StagingStore(self.settings)
        force_sales_full_refresh = force_sales_full_refresh or self.settings.force_sales_full_refresh
        cutoff_utc = self._parse_odoo_cutoff_utc(odoo_cutoff_utc)
        effective_full_refresh = store.should_full_refresh(requested_full_refresh)
        since = None if effective_full_refresh else incremental_since_utc
        if since is None and not effective_full_refresh:
            since = store.incremental_since()
        if not effective_full_refresh and since is None:
            effective_full_refresh = True
        self.logger.info(
            "Staging sync mode: %s%s",
            "full refresh" if effective_full_refresh else f"incremental since {since}",
            " (force)" if force else "",
        )
        if force_sales_full_refresh and not effective_full_refresh:
            self.logger.info("Sales staging sync mode: force sales full refresh enabled")
        if cutoff_utc is not None:
            self.logger.info("Sales Odoo cutoff UTC: %s", cutoff_utc.strftime("%Y-%m-%d %H:%M:%S"))
        if since is not None and not effective_full_refresh:
            self.logger.info("Odoo incremental write/create cutoff UTC: %s", pd.Timestamp(since).strftime("%Y-%m-%d %H:%M:%S"))

        order_domain = [] if effective_full_refresh or force_sales_full_refresh else odoo_incremental_domain(since)
        line_domain = [] if effective_full_refresh or force_sales_full_refresh else odoo_incremental_domain(since)
        picking_domain = [] if effective_full_refresh or force_sales_full_refresh else odoo_incremental_domain(since)
        move_domain = [] if effective_full_refresh or force_sales_full_refresh else odoo_incremental_domain(since)
        order_domain = self._with_domain_condition(order_domain, ["date_order", "<=", cutoff_utc.strftime("%Y-%m-%d %H:%M:%S")]) if cutoff_utc is not None else order_domain
        line_domain = self._with_domain_condition(line_domain, ["order_id.date_order", "<=", cutoff_utc.strftime("%Y-%m-%d %H:%M:%S")]) if cutoff_utc is not None else line_domain
        # CRM volume is small and Odoo custom fields can change inferred SQL
        # types between runs. Refreshing CRM raw tables fully avoids stale type
        # conflicts while sales still uses incremental extraction.
        lead_domain = None

        line_repo = SaleOrderLineRepository(client, self.settings.batch_size)
        order_repo = SaleOrderRepository(client, self.settings.batch_size)
        crm_repo = CrmRepository(client, self.settings.batch_size)
        picking_repo = StockPickingRepository(client, self.settings.batch_size)
        move_repo = StockMoveRepository(client, self.settings.batch_size)

        def timed_fetch(label: str, func: Any, *args: Any) -> pd.DataFrame:
            started = time.perf_counter()
            result = func(*args)
            self.logger.info("Odoo extraction %s rows=%s duration_seconds=%.2f", label, len(result), time.perf_counter() - started)
            return result

        extract_started_utc = pd.Timestamp.now(tz="UTC").tz_localize(None)
        latest_odoo_order_start = self._fetch_latest_odoo_sale_order(client, cutoff_utc=cutoff_utc)
        self._latest_odoo_sale_order_start = latest_odoo_order_start
        lines_changed = timed_fetch("sale.order.line changed", line_repo.fetch_lines, line_domain)
        orders_changed = timed_fetch("sale.order changed", order_repo.fetch_orders, order_domain)
        pickings_changed = timed_fetch("stock.picking changed", picking_repo.fetch_pickings, picking_domain)
        moves_changed = timed_fetch("stock.move changed", move_repo.fetch_moves, move_domain)
        latest_odoo_order_end = self._fetch_latest_odoo_sale_order(client, cutoff_utc=cutoff_utc)
        self._latest_odoo_sale_order_end = latest_odoo_order_end
        if effective_full_refresh or force_sales_full_refresh:
            catchup_order_domain: list[Any] = [["write_date", ">=", extract_started_utc.strftime("%Y-%m-%d %H:%M:%S")]]
            if cutoff_utc is not None:
                catchup_order_domain = ["&", *catchup_order_domain, ["date_order", "<=", cutoff_utc.strftime("%Y-%m-%d %H:%M:%S")]]
            catchup_orders = timed_fetch("sale.order catch-up", order_repo.fetch_orders, catchup_order_domain)
            if not catchup_orders.empty:
                self.logger.info("Sales catch-up fetched %s sale.order rows changed during extraction", len(catchup_orders))
                orders_changed = pd.concat([orders_changed, catchup_orders], ignore_index=True).drop_duplicates(subset=["id"], keep="last")
                catchup_order_ids = pd.to_numeric(catchup_orders["id"], errors="coerce").dropna().astype(int).tolist()
                catchup_line_domain: list[Any] = ["|", ["write_date", ">=", extract_started_utc.strftime("%Y-%m-%d %H:%M:%S")], ["order_id", "in", catchup_order_ids]]
            else:
                catchup_line_domain = [["write_date", ">=", extract_started_utc.strftime("%Y-%m-%d %H:%M:%S")]]
            if cutoff_utc is not None:
                catchup_line_domain = ["&", *catchup_line_domain, ["order_id.date_order", "<=", cutoff_utc.strftime("%Y-%m-%d %H:%M:%S")]]
            catchup_lines = timed_fetch("sale.order.line catch-up", line_repo.fetch_lines, catchup_line_domain)
            if not catchup_lines.empty:
                self.logger.info("Sales catch-up fetched %s sale.order.line rows changed during extraction", len(catchup_lines))
                lines_changed = pd.concat([lines_changed, catchup_lines], ignore_index=True).drop_duplicates(subset=["id"], keep="last")
            latest_end_id = latest_odoo_order_end.get("id")
            if latest_end_id and "id" in orders_changed.columns and int(latest_end_id) not in set(pd.to_numeric(orders_changed["id"], errors="coerce").dropna().astype(int)):
                self.logger.info("Latest Odoo sale.order %s was not in the extracted set; fetching it directly", latest_odoo_order_end.get("name"))
                latest_order_rows = timed_fetch("latest sale.order direct", order_repo.fetch_orders, [["id", "=", int(latest_end_id)]])
                latest_line_rows = timed_fetch("latest sale.order.line direct", line_repo.fetch_lines, [["order_id", "=", int(latest_end_id)]])
                orders_changed = pd.concat([orders_changed, latest_order_rows], ignore_index=True).drop_duplicates(subset=["id"], keep="last")
                lines_changed = pd.concat([lines_changed, latest_line_rows], ignore_index=True).drop_duplicates(subset=["id"], keep="last")
        if not effective_full_refresh and not force_sales_full_refresh and not orders_changed.empty and "id" in orders_changed.columns:
            changed_order_ids = pd.to_numeric(orders_changed["id"], errors="coerce").dropna().astype(int).tolist()
            if changed_order_ids:
                self.logger.info("Refreshing sale.order.line rows for %s changed parent sale.order records", len(changed_order_ids))
                parent_lines = timed_fetch("sale.order.line by changed parent", line_repo.fetch_lines, [["order_id", "in", changed_order_ids]])
                lines_changed = pd.concat([lines_changed, parent_lines], ignore_index=True).drop_duplicates(subset=["id"], keep="last")
        if not effective_full_refresh and not force_sales_full_refresh and not pickings_changed.empty and "id" in pickings_changed.columns:
            changed_picking_ids = pd.to_numeric(pickings_changed["id"], errors="coerce").dropna().astype(int).tolist()
            if changed_picking_ids:
                self.logger.info("Refreshing stock.move rows for %s changed stock.picking records", len(changed_picking_ids))
                picking_moves = timed_fetch("stock.move by changed picking", move_repo.fetch_moves, [["picking_id", "in", changed_picking_ids]])
                moves_changed = pd.concat([moves_changed, picking_moves], ignore_index=True).drop_duplicates(subset=["id"], keep="last")
        leads_changed = timed_fetch("crm.lead", crm_repo.fetch_leads, lead_domain)
        stages = timed_fetch("crm.stage", crm_repo.fetch_stages)
        lost_reasons = timed_fetch("crm.lost.reason", crm_repo.fetch_lost_reasons)

        if effective_full_refresh or force_sales_full_refresh:
            store.replace_table("raw_sale_order_line", lines_changed)
            store.add_primary_key_if_missing("raw_sale_order_line")
            store.replace_table("raw_sale_order", orders_changed)
            store.add_primary_key_if_missing("raw_sale_order")
            store.replace_table("raw_stock_picking", pickings_changed)
            store.add_primary_key_if_missing("raw_stock_picking")
            store.replace_table("raw_stock_move", moves_changed)
            store.add_primary_key_if_missing("raw_stock_move")
        else:
            store.upsert_table("raw_sale_order_line", lines_changed)
            store.upsert_table("raw_sale_order", orders_changed)
            store.upsert_table("raw_stock_picking", pickings_changed)
            store.upsert_table("raw_stock_move", moves_changed)

        store.replace_table("raw_crm_lead", leads_changed)
        store.add_primary_key_if_missing("raw_crm_lead")

        store.replace_table("raw_crm_stage", stages)
        store.add_primary_key_if_missing("raw_crm_stage")
        store.replace_table("raw_crm_lost_reason", lost_reasons)
        store.add_primary_key_if_missing("raw_crm_lost_reason")

        sale_orders_raw = store.read_table("raw_sale_order")
        leads_raw = store.read_table("raw_crm_lead")
        stages_raw = store.read_table("raw_crm_stage")
        lost_reasons_raw = store.read_table("raw_crm_lost_reason")
        stock_pickings_raw = store.read_table("raw_stock_picking")
        stock_moves_raw = store.read_table("raw_stock_move")
        self._log_staging_sales_diagnostics(
            latest_odoo_order=latest_odoo_order_end,
            latest_odoo_order_start=latest_odoo_order_start,
            orders_changed=orders_changed,
            lines_changed=lines_changed,
            sale_orders_raw=sale_orders_raw,
            sale_lines_raw=lines_changed,
        )
        # Incremental runs use raw_sale_report_api below. Building a full
        # staged order-line merge here was redundant and immediately discarded.
        sales_raw = pd.DataFrame()
        field_availability = pd.concat(
            [
                line_repo.field_availability,
                order_repo.field_availability,
                crm_repo.field_availability,
                picking_repo.field_availability,
                move_repo.field_availability,
            ],
            ignore_index=True,
        )
        changed_count = len(lines_changed) + len(orders_changed) + len(pickings_changed) + len(moves_changed) + len(leads_changed) + len(stages) + len(lost_reasons)
        return (
            sales_raw,
            leads_raw,
            stages_raw,
            lost_reasons_raw,
            sale_orders_raw,
            stock_pickings_raw,
            stock_moves_raw,
            field_availability,
            changed_count,
            effective_full_refresh,
        )

    def _replace_sale_report_cache(self, sales_raw: pd.DataFrame) -> None:
        store = StagingStore(self.settings)
        store.replace_table("raw_sale_report_api", sales_raw)
        self.logger.info("Cached raw_sale_report_api rows=%s for future incremental sale.report refreshes", len(sales_raw))

    def _sync_incremental_sale_report_cache(
        self,
        client: OdooClient,
        since_utc: pd.Timestamp | None,
        cutoff_utc: pd.Timestamp | None,
    ) -> pd.DataFrame:
        store = StagingStore(self.settings)
        repo = SalesReportRepository(
            client=client,
            batch_size=self.settings.batch_size,
            timezone=self.settings.timezone,
            assume_utc_for_naive=self.settings.assume_utc_for_naive,
        )
        cache_exists = store.has_table("raw_sale_report_api")
        if not cache_exists or since_utc is None:
            self.logger.info("sale.report incremental cache missing or cutoff unavailable; fetching full sale.report once to seed cache")
            sales_raw = repo.fetch_sale_report()
            store.replace_table("raw_sale_report_api", sales_raw)
            return sales_raw

        domain: list[Any] = [["date", ">=", pd.Timestamp(since_utc).strftime("%Y-%m-%d %H:%M:%S")]]
        if cutoff_utc is not None:
            domain = ["&", *domain, ["date", "<=", pd.Timestamp(cutoff_utc).strftime("%Y-%m-%d %H:%M:%S")]]
        changed = repo.fetch_sale_report(domain)
        cutoff_local = pd.Timestamp(since_utc)
        if cutoff_local.tzinfo is None:
            cutoff_local = cutoff_local.tz_localize("UTC").tz_convert(self.settings.timezone).tz_localize(None)
        else:
            cutoff_local = cutoff_local.tz_convert(self.settings.timezone).tz_localize(None)
        store.replace_date_window("raw_sale_report_api", changed, "Order Date", cutoff_local.to_pydatetime())
        combined = store.read_table("raw_sale_report_api")
        self.logger.info(
            "sale.report incremental cache refreshed in SQL: changed_window=%s final=%s cutoff_local=%s",
            len(changed),
            len(combined),
            cutoff_local,
        )
        return combined

    def _sales_raw_from_staged_order_lines(self, lines: pd.DataFrame, orders: pd.DataFrame) -> pd.DataFrame:
        if lines.empty:
            return pd.DataFrame(columns=list(SALES_COLUMN_MAP.keys()))
        order_cols = [
            col
            for col in [
                "id",
                "name",
                "date_order",
                "team_id",
                "team_id_id",
                "partner_id",
                "partner_id_id",
                "user_id",
                "user_id_id",
                "company_id",
                "company_id_id",
                "invoice_status",
                "state",
            ]
            if col in orders.columns
        ]
        merged = lines.merge(
            orders[order_cols],
            left_on="order_id_id",
            right_on="id",
            how="left",
            suffixes=("_line", "_order"),
        )
        out = pd.DataFrame()
        out["Order Date"] = merged.get("date_order")
        out["Related Order"] = merged.get("name_order", merged.get("order_id"))
        out["Customer"] = merged.get("order_partner_id", merged.get("partner_id"))
        out["Product"] = merged.get("product_id", merged.get("name_line", merged.get("name")))
        out["Salesperson"] = merged.get("salesman_id", merged.get("user_id"))
        out["Sales Team"] = merged.get("team_id")
        out["Company"] = merged.get("company_id_line", merged.get("company_id"))
        out["Untaxed Total"] = merged.get("price_subtotal")
        out["Total"] = merged.get("price_total")
        out["Qty Invoiced"] = merged.get("qty_invoiced", merged.get("product_uom_qty"))
        out["Status"] = merged.get("state_line", merged.get("state_order"))
        out["Invoice Status"] = merged.get("invoice_status_line", merged.get("invoice_status_order"))
        return out

    @staticmethod
    def _parse_odoo_cutoff_utc(value: str | None) -> pd.Timestamp | None:
        if value is None or not str(value).strip():
            return None
        parsed = pd.to_datetime(str(value).strip(), errors="raise", utc=True)
        return parsed.tz_convert("UTC").tz_localize(None)

    @staticmethod
    def _with_domain_condition(domain: list[Any], condition: list[Any]) -> list[Any]:
        if not domain:
            return [condition]
        return ["&", *domain, condition]

    def _fetch_latest_odoo_sale_order(self, client: OdooClient, cutoff_utc: pd.Timestamp | None = None) -> dict[str, Any]:
        fields = ["id", "name", "date_order", "write_date", "create_date", "amount_total", "state", "invoice_status"]
        domain: list[Any] = []
        if cutoff_utc is not None:
            domain = [["date_order", "<=", cutoff_utc.strftime("%Y-%m-%d %H:%M:%S")]]
        rows = client.search_read("sale.order", domain, fields, offset=0, limit=1, order="date_order desc, id desc")
        return rows[0] if rows else {}

    def _log_staging_sales_diagnostics(
        self,
        latest_odoo_order: dict[str, Any],
        latest_odoo_order_start: dict[str, Any],
        orders_changed: pd.DataFrame,
        lines_changed: pd.DataFrame,
        sale_orders_raw: pd.DataFrame,
        sale_lines_raw: pd.DataFrame,
    ) -> None:
        def max_local(df: pd.DataFrame, col: str) -> Any:
            if col not in df.columns or df.empty:
                return pd.NaT
            return odoo_utc_datetime_to_local(df[col], self.settings.timezone).max()

        latest_raw_order = sale_orders_raw.sort_values("date_order", ascending=False).head(1) if "date_order" in sale_orders_raw.columns and not sale_orders_raw.empty else pd.DataFrame()
        latest_raw_line = sale_lines_raw.sort_values("write_date", ascending=False).head(1) if "write_date" in sale_lines_raw.columns and not sale_lines_raw.empty else pd.DataFrame()
        latest_odoo_date = latest_odoo_order.get("date_order")
        latest_odoo_start_date = latest_odoo_order_start.get("date_order")
        latest_odoo_local = odoo_utc_datetime_to_local(pd.Series([latest_odoo_date]), self.settings.timezone).iloc[0] if latest_odoo_date else pd.NaT
        latest_odoo_start_local = odoo_utc_datetime_to_local(pd.Series([latest_odoo_start_date]), self.settings.timezone).iloc[0] if latest_odoo_start_date else pd.NaT
        self.logger.info("Sales staging diagnostics:")
        self.logger.info("  Latest Odoo sale.order at extraction start: %s | date_order=%s | state=%s | invoice_status=%s", latest_odoo_order_start.get("name"), latest_odoo_start_local, latest_odoo_order_start.get("state"), latest_odoo_order_start.get("invoice_status"))
        self.logger.info("  Latest Odoo sale.order: %s | date_order=%s | state=%s | invoice_status=%s | amount_total=%s", latest_odoo_order.get("name"), latest_odoo_local, latest_odoo_order.get("state"), latest_odoo_order.get("invoice_status"), latest_odoo_order.get("amount_total"))
        self.logger.info("  Changed sale.order rows fetched: %s | max date_order=%s | max write_date=%s", len(orders_changed), max_local(orders_changed, "date_order"), max_local(orders_changed, "write_date"))
        self.logger.info("  Changed sale.order.line rows fetched/upserted: %s | max create_date=%s | max write_date=%s", len(lines_changed), max_local(lines_changed, "create_date"), max_local(lines_changed, "write_date"))
        if not latest_raw_order.empty:
            row = latest_raw_order.iloc[0]
            self.logger.info("  Latest raw_sale_order: %s | date_order=%s | write_date=%s | state=%s | invoice_status=%s", row.get("name"), max_local(latest_raw_order, "date_order"), max_local(latest_raw_order, "write_date"), row.get("state"), row.get("invoice_status"))
        if not latest_raw_line.empty:
            row = latest_raw_line.iloc[0]
            self.logger.info("  Latest raw_sale_order_line by write_date: id=%s | order=%s | create_date=%s | write_date=%s | invoice_status=%s", row.get("id"), row.get("order_id"), max_local(latest_raw_line, "create_date"), max_local(latest_raw_line, "write_date"), row.get("invoice_status"))

    def _log_sales_filter_impact(self, sales: pd.DataFrame, label: str) -> None:
        if "invoice_status" not in sales.columns:
            self.logger.info("Sales filter validation %s: invoice_status column missing", label)
            return
        value_col = "Value" if "Value" in sales.columns else "line_total"
        total = pd.to_numeric(sales.get(value_col, pd.Series(dtype="float64")), errors="coerce").sum()
        rows = len(sales)
        status = sales["invoice_status"].astype("string").str.strip().str.lower()
        excluded = sales[status.eq("no")].copy()
        excluded_total = pd.to_numeric(excluded.get(value_col, pd.Series(dtype="float64")), errors="coerce").sum()
        self.logger.info("Sales filter validation %s: rows=%s total=%.2f invoice_status_no_rows=%s invoice_status_no_total=%.2f", label, rows, float(total), len(excluded), float(excluded_total))

    def _filter_sales_dashboard_rows(self, sales: pd.DataFrame) -> pd.DataFrame:
        out = sales.copy()
        if "invoice_status" not in out.columns:
            return out
        invoice_status = out["invoice_status"].astype("string").str.strip().str.lower()
        state = out.get("order_state", pd.Series(pd.NA, index=out.index)).astype("string").str.strip().str.lower()
        excluded_mask = invoice_status.eq("no") & ~state.isin(["sale", "done"])
        if excluded_mask.any():
            excluded = out.loc[excluded_mask]
            value = pd.to_numeric(excluded.get("Value", excluded.get("line_total", pd.Series(dtype="float64"))), errors="coerce").sum()
            self.logger.info(
                "Sales invoice filter excluded rows=%s value=%.2f because invoice_status='no' and state is not sale/done",
                len(excluded),
                float(value),
            )
        return out.loc[~excluded_mask].copy()

    def _validate_inputs(self) -> None:
        missing = [name for name in REQUIRED_INPUT_FILES if not (self.settings.input_dir / name).exists()]
        if missing:
            raise FileNotFoundError(f"Missing required input files in {self.settings.input_dir}: {', '.join(missing)}")
        if not self.settings.blocked_customers_path.exists():
            self.logger.warning("BlockedCustomers.xlsx missing; creating empty template at %s", self.settings.blocked_customers_path)
            BlockedCustomersLoader(self.legacy_logger).export_template(self.settings.blocked_customers_path)

    @staticmethod
    def _validate_output_sheets(sheets: dict[str, pd.DataFrame], include_qa: bool = True) -> None:
        required = REQUIRED_OUTPUT_SHEETS if include_qa else [sheet for sheet in REQUIRED_OUTPUT_SHEETS if not sheet.startswith("QA_")]
        missing = [sheet for sheet in required if sheet not in sheets]
        if missing:
            raise ValueError(f"Pipeline did not create required sheets: {missing}")

    def _log_crm_summary(self, summary: CrmValidationSummary) -> None:
        self.logger.info("CRM validation summary:")
        self.logger.info("  CRM leads fetched: %s", summary.crm_leads_fetched)
        self.logger.info("  CRM opportunities fetched: %s", summary.crm_opportunities_fetched)
        self.logger.info("  quotations fetched: %s", summary.quotations_fetched)
        self.logger.info("  sales orders fetched: %s", summary.sales_orders_fetched)
        self.logger.info("  deliveries fetched: %s", summary.deliveries_fetched)
        self.logger.info("  CRM output sheets exported: %s", summary.crm_output_sheets_exported)
        self.logger.info("  QA issues count: %s", summary.qa_issues_count)

    def _log_sql_validation(self, result: SQLExportResult) -> None:
        self.logger.info("SQL row-count validation:")
        for _, row in result.validation.iterrows():
            status = "OK" if bool(row["Matches"]) else "MISMATCH"
            self.logger.info(
                "  %s | expected=%s sql=%s diff=%s | load_mode=%s scope=%s export_rows=%s | %s",
                row["TableName"],
                row.get("ExpectedRows", row.get("ExportRows")),
                row["SQLRows"],
                row["Difference"],
                row.get("LoadMode", "unknown"),
                row.get("ValidationScope", "unknown"),
                row.get("ExportRows", row.get("ExpectedRows")),
                status,
            )

    @staticmethod
    def _sql_row_count_error_message(result: SQLExportResult) -> str:
        details = []
        for _, row in result.mismatches.iterrows():
            details.append(
                (
                    f"{row['TableName']} "
                    f"expected={row.get('ExpectedRows', row.get('ExportRows'))} "
                    f"sql={row['SQLRows']} "
                    f"diff={row['Difference']} "
                    f"load_mode={row.get('LoadMode', 'unknown')} "
                    f"scope={row.get('ValidationScope', 'unknown')}"
                )
            )
        return f"SQL row-count validation failed for {len(details)} table(s): " + "; ".join(details)

    def _validate_sql_matches_final_dataframes(self, exporter: DatabaseExporter, sheets: dict[str, pd.DataFrame]) -> None:
        self.logger.info("SQL/DataFrame mirror validation:")
        mismatches: list[str] = []
        schema = exporter._effective_schema()
        for table_name, expected in sheets.items():
            actual = pd.read_sql_table(exporter._database_table_name(table_name) or table_name, exporter.engine, schema=schema)
            expected_clean = DatabaseExporter._clean_for_sql(expected, exporter.engine.dialect.name)
            actual_clean = DatabaseExporter._clean_for_sql(actual, exporter.engine.dialect.name)
            if list(actual_clean.columns) != list(expected_clean.columns):
                mismatches.append(f"{table_name}: column mismatch")
                self.logger.error("  %s | column mismatch | expected=%s actual=%s", table_name, list(expected_clean.columns), list(actual_clean.columns))
                continue
            if len(actual_clean) != len(expected_clean):
                mismatches.append(f"{table_name}: row-count mismatch")
                self.logger.error("  %s | row-count mismatch | expected=%s actual=%s", table_name, len(expected_clean), len(actual_clean))
                continue
            expected_norm, actual_norm, expected_aligned, actual_aligned = self._normalized_dataframes_for_compare(expected_clean, actual_clean)
            if not expected_norm.equals(actual_norm):
                mismatches.append(f"{table_name}: normalized value mismatch")
                self.logger.error("  %s | normalized value mismatch", table_name)
                if table_name in {
                    "Fact_SalesLines", "Fact_BCGMatrix", "Fact_Orders",
                    "Fact_Sales", "Fact_Delivery", "Fact_Lead",
                    "Fact_Opportunity", "Dim_ProductCost",
                }:
                    self._log_table_mismatch_diagnostics(
                        table_name,
                        expected_aligned,
                        actual_aligned,
                        expected_norm,
                        actual_norm,
                    )
                continue
            self.logger.info("  %s | rows=%s columns=%s | OK", table_name, len(expected_clean), len(expected_clean.columns))

        self._validate_sales_fact_latest_matches("Fact_SalesLines", sheets, exporter)
        self._validate_sales_fact_latest_matches("Fact_Orders", sheets, exporter)
        if mismatches:
            raise RuntimeError("SQL/DataFrame mirror validation failed: " + "; ".join(mismatches))

    def _validate_sales_fact_latest_matches(self, table_name: str, sheets: dict[str, pd.DataFrame], exporter: DatabaseExporter) -> None:
        if table_name not in sheets:
            return
        schema = exporter._effective_schema()
        actual = pd.read_sql_table(exporter._database_table_name(table_name) or table_name, exporter.engine, schema=schema)
        expected = sheets[table_name]
        if table_name == "Fact_SalesLines":
            order_col = "order_number"
            date_col = "order_date"
        else:
            order_col = "order_number"
            date_col = "OrderDateTime"
        if order_col not in expected.columns or date_col not in expected.columns:
            return
        expected_latest = self._latest_order_tuple(expected, order_col, date_col)
        actual_latest = self._latest_order_tuple(actual, order_col, date_col)
        self.logger.info("  %s latest expected=%s actual=%s", table_name, expected_latest, actual_latest)
        if expected_latest != actual_latest:
            raise RuntimeError(f"{table_name} latest order mismatch between final DataFrame and SQL: expected={expected_latest}, actual={actual_latest}")

    def _validate_incremental_sql_window(self, exporter: DatabaseExporter, sheets: dict[str, pd.DataFrame], cutoff_local: pd.Timestamp | None) -> None:
        self.logger.info("Incremental SQL window validation:")
        self._validate_sales_fact_latest_matches("Fact_SalesLines", sheets, exporter)
        self._validate_sales_fact_latest_matches("Fact_Orders", sheets, exporter)
        if cutoff_local is None:
            self.logger.info("  No cutoff available; skipped window row-count checks")
            return
        schema = exporter._effective_schema()
        checks = [
            ("Fact_SalesLines", "order_date"),
            ("Fact_Orders", "OrderDateTime"),
        ]
        for table_name, date_col in checks:
            if table_name not in sheets or date_col not in sheets[table_name].columns:
                continue
            expected_window = sheets[table_name][pd.to_datetime(sheets[table_name][date_col], errors="coerce") >= pd.Timestamp(cutoff_local)]
            table = exporter._quoted_table_name(table_name)
            q = exporter.engine.dialect.identifier_preparer.quote
            with exporter.engine.connect() as conn:
                actual_window_count = int(
                    conn.execute(
                        text(f"SELECT COUNT(*) FROM {table} WHERE {q(date_col)} >= :cutoff"),
                        {"cutoff": pd.Timestamp(cutoff_local).to_pydatetime()},
                    ).scalar_one()
                )
            self.logger.info("  %s window rows expected=%s sql=%s cutoff=%s", table_name, len(expected_window), actual_window_count, cutoff_local)
            if len(expected_window) != actual_window_count:
                raise RuntimeError(f"Incremental SQL validation failed for {table_name}: window row count expected={len(expected_window)} sql={actual_window_count}")
        orders = pd.read_sql_table(exporter._database_table_name("Fact_Orders") or "Fact_Orders", exporter.engine, schema=schema, columns=["order_number"])
        duplicate_orders = int(orders["order_number"].duplicated().sum())
        self.logger.info("  Fact_Orders duplicate order_number rows=%s", duplicate_orders)
        if duplicate_orders:
            raise RuntimeError(f"Incremental SQL validation failed: duplicate Fact_Orders order_number rows={duplicate_orders}")

    def _validate_excel_matches_sql_output(self, workbook_path: Path, exporter: DatabaseExporter, sheets: dict[str, pd.DataFrame]) -> None:
        self.logger.info("Excel/SQL final output validation:")
        if not workbook_path.exists():
            raise RuntimeError(f"Excel/SQL validation failed: workbook does not exist at {workbook_path}")

        excel_book = pd.ExcelFile(workbook_path)
        separate_excel_outputs = {
            "QA_MissingProductCost": workbook_path.parent / "QA_MissingProductCost.xlsx",
        }
        mismatches: list[str] = []
        for sheet_name in sheets:
            if sheet_name in separate_excel_outputs:
                separate_path = separate_excel_outputs[sheet_name]
                if not separate_path.exists():
                    mismatches.append(f"{sheet_name}: separate Excel output is missing at {separate_path}")
                    self.logger.error("  %s | separate Excel output is missing at %s", sheet_name, separate_path)
                    continue
                excel_rows = len(pd.read_excel(separate_path))
            elif sheet_name in excel_book.sheet_names:
                excel_rows = len(pd.read_excel(excel_book, sheet_name=sheet_name))
            else:
                mismatches.append(f"{sheet_name}: missing from Excel workbook")
                self.logger.error("  %s | missing from Excel workbook", sheet_name)
                continue

            sql_rows = exporter._count_rows(sheet_name)
            if excel_rows != sql_rows:
                mismatches.append(f"{sheet_name}: row-count mismatch Excel={excel_rows} SQL={sql_rows}")
                self.logger.error("  %s | Excel rows=%s SQL rows=%s | MISMATCH", sheet_name, excel_rows, sql_rows)
            else:
                self.logger.info("  %s | Excel rows=%s SQL rows=%s | OK", sheet_name, excel_rows, sql_rows)

        fact_orders_excel = pd.read_excel(excel_book, sheet_name="Fact_Orders")
        excel_orders_latest = self._latest_order_tuple(fact_orders_excel, "order_number", "OrderDateTime")
        sql_orders_latest = self._latest_sql_tuple_for_table(exporter, exporter._effective_schema(), "Fact_Orders", "order_number", "OrderDateTime")
        self.logger.info("  Fact_Orders latest Excel=%s SQL=%s", excel_orders_latest, sql_orders_latest)
        if excel_orders_latest != sql_orders_latest:
            mismatches.append(f"Fact_Orders latest mismatch Excel={excel_orders_latest} SQL={sql_orders_latest}")

        fact_lines_excel = pd.read_excel(excel_book, sheet_name="Fact_SalesLines")
        excel_lines_latest = self._latest_sales_line_tuple(fact_lines_excel)
        sql_lines_latest = self._latest_sql_sales_line_tuple(exporter)
        self.logger.info("  Fact_SalesLines latest Excel=%s SQL=%s", excel_lines_latest, sql_lines_latest)
        if excel_lines_latest != sql_lines_latest:
            mismatches.append(f"Fact_SalesLines latest mismatch Excel={excel_lines_latest} SQL={sql_lines_latest}")

        if mismatches:
            raise RuntimeError("Excel/SQL final output validation failed: " + "; ".join(mismatches))

    def _latest_sql_sales_line_tuple(self, exporter: DatabaseExporter) -> tuple[Any, Any, Any]:
        try:
            table_name = exporter._database_table_name("Fact_SalesLines") or "Fact_SalesLines"
            columns = {str(col["name"]) for col in inspect(exporter.engine).get_columns(table_name, schema=exporter._effective_schema())}
            table = exporter._quoted_table_name("Fact_SalesLines")
            q = exporter.engine.dialect.identifier_preparer.quote
            date_date_select = f"{q('order_date_date')} AS order_date_date" if "order_date_date" in columns else "NULL AS order_date_date"
            with exporter.engine.connect() as conn:
                row = conn.execute(
                    text(
                        f"""
                        SELECT {q("order_number")} AS order_number, {q("order_date")} AS order_date, {date_date_select}
                        FROM {table}
                        WHERE {q("order_date")} IS NOT NULL
                        ORDER BY {q("order_date")} DESC, {q("order_number")} DESC
                        LIMIT 1
                        """
                    )
                ).mappings().one_or_none()
        except Exception:  # noqa: BLE001
            return (None, None, None)
        if row is None:
            return (None, None, None)
        order_date = pd.to_datetime(row["order_date"], errors="coerce")
        order_date_date = pd.to_datetime(row["order_date_date"], errors="coerce")
        if isinstance(order_date, pd.Timestamp) and not pd.isna(order_date):
            order_date = order_date.to_pydatetime().replace(microsecond=0)
        if isinstance(order_date_date, pd.Timestamp) and not pd.isna(order_date_date):
            order_date_date = order_date_date.to_pydatetime().replace(microsecond=0)
        elif pd.isna(order_date_date):
            order_date_date = None
        return (str(row["order_number"]), order_date, order_date_date)

    @staticmethod
    def _latest_sales_line_tuple(df: pd.DataFrame) -> tuple[Any, Any, Any]:
        if df.empty or "order_number" not in df.columns or "order_date" not in df.columns:
            return (None, None, None)
        tmp = df[["order_number", "order_date"] + (["order_date_date"] if "order_date_date" in df.columns else [])].copy()
        tmp["order_date"] = pd.to_datetime(tmp["order_date"], errors="coerce")
        if "order_date_date" in tmp.columns:
            tmp["order_date_date"] = pd.to_datetime(tmp["order_date_date"], errors="coerce")
        else:
            tmp["order_date_date"] = pd.NaT
        tmp = tmp.dropna(subset=["order_date"]).sort_values(["order_date", "order_number"], ascending=[False, False])
        if tmp.empty:
            return (None, None, None)
        row = tmp.iloc[0]
        order_date = row["order_date"]
        order_date_date = row["order_date_date"]
        if isinstance(order_date, pd.Timestamp):
            order_date = order_date.to_pydatetime().replace(microsecond=0)
        if isinstance(order_date_date, pd.Timestamp):
            order_date_date = order_date_date.to_pydatetime().replace(microsecond=0)
        elif pd.isna(order_date_date):
            order_date_date = None
        return (str(row["order_number"]), order_date, order_date_date)

    @staticmethod
    def _latest_order_tuple(df: pd.DataFrame, order_col: str, date_col: str) -> tuple[Any, Any]:
        if df.empty:
            return (None, None)
        tmp = df[[order_col, date_col]].copy()
        tmp[date_col] = pd.to_datetime(tmp[date_col], errors="coerce")
        tmp = tmp.dropna(subset=[date_col]).sort_values([date_col, order_col], ascending=[False, False])
        if tmp.empty:
            return (None, None)
        row = tmp.iloc[0]
        date_value = row[date_col]
        if isinstance(date_value, pd.Timestamp):
            date_value = date_value.to_pydatetime().replace(microsecond=0)
        return (str(row[order_col]), date_value)

    @classmethod
    def _normalized_dataframes_for_compare(cls, expected: pd.DataFrame, actual: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame]:
        expected_norm = pd.DataFrame(index=expected.index)
        actual_norm = pd.DataFrame(index=actual.index)
        for col in expected.columns:
            left, right = cls._normalize_compare_series(expected[col], actual[col], col)
            expected_norm[col] = left
            actual_norm[col] = right
        expected_order = cls._sort_index_for_normalized_frame(expected_norm)
        actual_order = cls._sort_index_for_normalized_frame(actual_norm)
        return (
            expected_norm.loc[expected_order].reset_index(drop=True),
            actual_norm.loc[actual_order].reset_index(drop=True),
            expected.loc[expected_order].reset_index(drop=True),
            actual.loc[actual_order].reset_index(drop=True),
        )

    @staticmethod
    def _normalize_compare_series(left: pd.Series, right: pd.Series, column_name: str) -> tuple[pd.Series, pd.Series]:
        column_lower = column_name.lower()
        key_hint = column_lower.endswith("key") or column_lower.endswith("_id") or column_lower == "id"
        bool_hint = (
            pd.api.types.is_bool_dtype(left)
            or pd.api.types.is_bool_dtype(right)
            or column_name.startswith("Is")
            or column_name.startswith("Has")
            or column_lower.startswith("is_")
        )
        left_null = PowerBISalesPipeline._null_like_mask(left)
        right_null = PowerBISalesPipeline._null_like_mask(right)
        left_bool = PowerBISalesPipeline._normalize_bool_like(left)
        right_bool = PowerBISalesPipeline._normalize_bool_like(right)
        if bool_hint and (pd.api.types.is_bool_dtype(left) or pd.api.types.is_bool_dtype(right) or left_bool.notna().any() or right_bool.notna().any()):
            left_non_na = ~left_null
            right_non_na = ~right_null
            left_bool_complete = int(left_non_na.sum()) == int(left_bool.notna().sum())
            right_bool_complete = int(right_non_na.sum()) == int(right_bool.notna().sum())
            if left_bool_complete and right_bool_complete:
                return (
                    left_bool.astype("string").fillna("<NA>"),
                    right_bool.astype("string").fillna("<NA>"),
                )

        date_hint = (
            not key_hint
            and not bool_hint
            and any(token in column_lower for token in ["date", "time", "deadline", "created", "updated", "open", "closed"])
        )
        if date_hint or pd.api.types.is_datetime64_any_dtype(left) or pd.api.types.is_datetime64_any_dtype(right):
            left_dt = pd.to_datetime(left, errors="coerce")
            right_dt = pd.to_datetime(right, errors="coerce")
            if left_dt.notna().any() or right_dt.notna().any():
                return (
                    left_dt.dt.strftime("%Y-%m-%d %H:%M:%S").astype("string").mask(left_null, "<NA>").fillna("<NA>"),
                    right_dt.dt.strftime("%Y-%m-%d %H:%M:%S").astype("string").mask(right_null, "<NA>").fillna("<NA>"),
                )

        left_num = pd.to_numeric(left, errors="coerce")
        right_num = pd.to_numeric(right, errors="coerce")
        left_count = int((~left_null).sum())
        right_count = int((~right_null).sum())
        numeric_like = left_count == int(left_num.notna().sum()) and right_count == int(right_num.notna().sum())
        if numeric_like and (left_num.notna().any() or right_num.notna().any()):
            return (
                PowerBISalesPipeline._normalize_numeric_for_compare(left_num, left_null),
                PowerBISalesPipeline._normalize_numeric_for_compare(right_num, right_null),
            )

        return (
            PowerBISalesPipeline._normalize_text_for_compare(left, left_null),
            PowerBISalesPipeline._normalize_text_for_compare(right, right_null),
        )

    @staticmethod
    def _normalize_numeric_for_compare(series: pd.Series, null_mask: pd.Series) -> pd.Series:
        def normalize_value(value: Any) -> str:
            if pd.isna(value):
                return "<NA>"
            number = round(float(value), 6)
            if number == 0:
                number = 0.0
            text_value = f"{number:.6f}".rstrip("0").rstrip(".")
            return text_value if text_value else "0"

        normalized = series.map(normalize_value).astype("string")
        return normalized.mask(null_mask, "<NA>").fillna("<NA>")

    @staticmethod
    def _normalize_text_for_compare(series: pd.Series, null_mask: pd.Series) -> pd.Series:
        normalized = series.astype("string").str.strip()
        normalized = normalized.replace({"": "<NA>", "None": "<NA>", "none": "<NA>", "nan": "<NA>", "NaN": "<NA>", "NaT": "<NA>", "<NA>": "<NA>"})
        normalized = normalized.replace({"True": "true", "TRUE": "true", "False": "false", "FALSE": "false"})
        return normalized.mask(null_mask, "<NA>").fillna("<NA>")

    @staticmethod
    def _null_like_mask(series: pd.Series) -> pd.Series:
        text = series.astype("string").str.strip()
        return series.isna() | text.isin(["", "None", "none", "nan", "NaN", "NaT", "<NA>"])

    @staticmethod
    def _normalize_bool_like(series: pd.Series) -> pd.Series:
        text = series.astype("string").str.strip().str.lower()
        mapped = text.map({
            "true": "true",
            "1": "true",
            "yes": "true",
            "y": "true",
            "false": "false",
            "0": "false",
            "no": "false",
            "n": "false",
        })
        mapped = mapped.where(series.notna(), pd.NA)
        return mapped

    @staticmethod
    def _sort_index_for_normalized_frame(df: pd.DataFrame) -> pd.Index:
        if df.empty:
            return df.index
        return df.sort_values(list(df.columns), kind="mergesort").index

    def _log_table_mismatch_diagnostics(
        self,
        table_name: str,
        expected_raw: pd.DataFrame,
        actual_raw: pd.DataFrame,
        expected_norm: pd.DataFrame,
        actual_norm: pd.DataFrame,
    ) -> None:
        self.logger.error("  %s diagnostics:", table_name)
        dtype_diffs = [
            f"{col}: df={expected_raw[col].dtype}, sql={actual_raw[col].dtype}"
            for col in expected_raw.columns
            if str(expected_raw[col].dtype) != str(actual_raw[col].dtype)
        ]
        self.logger.error("    dtype differences (%s): %s", len(dtype_diffs), dtype_diffs[:20])

        diff_mask = expected_norm.ne(actual_norm)
        differing_cols = [col for col in expected_norm.columns if bool(diff_mask[col].any())]
        self.logger.error("    first differing columns: %s", differing_cols[:10])

        differing_rows = diff_mask.any(axis=1)
        row_numbers = list(expected_norm.index[differing_rows][:10])
        self.logger.error("    first differing normalized row numbers: %s", row_numbers)

        for row_number in row_numbers[:10]:
            row_diff_cols = [col for col in differing_cols if bool(diff_mask.at[row_number, col])][:10]
            for col in row_diff_cols:
                df_raw_value = expected_raw.iloc[row_number][col] if row_number < len(expected_raw) else None
                sql_raw_value = actual_raw.iloc[row_number][col] if row_number < len(actual_raw) else None
                self.logger.error(
                    "    row=%s col=%s | df_raw=%r | sql_raw=%r | df_norm=%r | sql_norm=%r",
                    row_number,
                    col,
                    df_raw_value,
                    sql_raw_value,
                    expected_norm.at[row_number, col],
                    actual_norm.at[row_number, col],
                )

    def _log_sales_date_validation(self, exporter: DatabaseExporter) -> None:
        table = exporter._quoted_table_name("Fact_SalesLines")
        raw_orders = exporter._quoted_table_name("raw_sale_order")
        raw_lines = exporter._quoted_table_name("raw_sale_order_line")
        q = exporter.engine.dialect.identifier_preparer.quote
        raw_tables_available = self._has_required_tables(exporter, ["raw_sale_order", "raw_sale_order_line"])
        local_today = pd.Timestamp.now(tz=self.settings.timezone).date()
        start_of_year = local_today.replace(month=1, day=1)
        tomorrow = local_today + timedelta(days=1)
        with exporter.engine.connect() as conn:
            row = conn.execute(
                text(
                    f"""
                    SELECT
                        MAX(order_date) AS max_order_date,
                        MAX(order_date_date) AS max_order_date_date,
                        COALESCE(SUM({q("Value")}), 0) AS ytd_value
                    FROM {table}
                    WHERE order_date_date >= :start_of_year
                      AND order_date_date < :tomorrow
                    """
                ),
                {"start_of_year": start_of_year, "tomorrow": tomorrow},
            ).mappings().one()
            latest_order = conn.execute(
                text(
                    f"""
                    SELECT order_number
                    FROM {table}
                    WHERE order_date IS NOT NULL
                    ORDER BY order_date DESC
                    LIMIT 1
                    """
                )
            ).scalar_one_or_none()
        self.logger.info("Sales date validation:")
        self.logger.info("  Business timezone: %s", self.settings.timezone)
        self.logger.info("  max(order_date): %s", row["max_order_date"])
        self.logger.info("  max(order_date_date): %s", row["max_order_date_date"])
        self.logger.info("  YTD Value using order_date_date [%s, %s): %.2f", start_of_year, tomorrow, float(row["ytd_value"] or 0))
        self.logger.info("  latest order_number: %s", latest_order)
        if not raw_tables_available:
            self.logger.info(
                "  Raw sales staging validation skipped: raw_sale_order and/or raw_sale_order_line not present in schema %s",
                exporter._effective_schema() or "<default>",
            )
            return

        with exporter.engine.connect() as conn:
            raw_row = conn.execute(
                text(
                    f"""
                    WITH order_stats AS (
                        SELECT
                            MAX(CAST(date_order AS DATETIME)) AS max_raw_order_date_utc,
                            MAX(CAST(write_date AS DATETIME)) AS max_raw_order_write_utc,
                            COALESCE(SUM(CASE
                                WHEN DATE_ADD(CAST(date_order AS DATETIME), INTERVAL :tz_offset HOUR) >= :start_of_year
                                  AND DATE_ADD(CAST(date_order AS DATETIME), INTERVAL :tz_offset HOUR) < :tomorrow
                                THEN CAST(amount_total AS DECIMAL(18,4))
                                ELSE 0
                            END), 0) AS raw_order_ytd_value
                        FROM {raw_orders}
                    ),
                    line_stats AS (
                        SELECT
                            MAX(CAST(create_date AS DATETIME)) AS max_raw_line_create_utc,
                            MAX(CAST(write_date AS DATETIME)) AS max_raw_line_write_utc
                        FROM {raw_lines}
                    )
                    SELECT *
                    FROM order_stats
                    CROSS JOIN line_stats
                    """
                ),
                {"start_of_year": start_of_year, "tomorrow": tomorrow, "tz_offset": self._timezone_offset_hours()},
            ).mappings().one()
            raw_line_ytd = conn.execute(
                text(
                    f"""
                    SELECT
                        COALESCE(SUM(CASE
                            WHEN DATE_ADD(CAST(o.date_order AS DATETIME), INTERVAL :tz_offset HOUR) >= :start_of_year
                              AND DATE_ADD(CAST(o.date_order AS DATETIME), INTERVAL :tz_offset HOUR) < :tomorrow
                            THEN CAST(l.price_total AS DECIMAL(18,4))
                            ELSE 0
                        END), 0) AS raw_line_ytd_value
                    FROM {raw_orders} o
                    LEFT JOIN {raw_lines} l ON l.order_id_id = o.id
                    """
                ),
                {"start_of_year": start_of_year, "tomorrow": tomorrow, "tz_offset": self._timezone_offset_hours()},
            ).scalar_one()
            raw_exclusions = conn.execute(
                text(
                    f"""
                    SELECT
                        COALESCE(o.state, '') AS state,
                        COALESCE(o.invoice_status, '') AS invoice_status,
                        COUNT(DISTINCT o.id) AS order_count,
                        COALESCE(SUM(DISTINCT CAST(o.amount_total AS DECIMAL(18,4))), 0) AS order_value,
                        COUNT(l.id) AS line_count,
                        COALESCE(SUM(CAST(l.price_total AS DECIMAL(18,4))), 0) AS line_value
                    FROM {raw_orders} o
                    LEFT JOIN {raw_lines} l ON l.order_id_id = o.id
                    WHERE DATE_ADD(CAST(o.date_order AS DATETIME), INTERVAL :tz_offset HOUR) >= :start_of_year
                      AND DATE_ADD(CAST(o.date_order AS DATETIME), INTERVAL :tz_offset HOUR) < :tomorrow
                    GROUP BY 1, 2
                    ORDER BY line_value DESC
                    """
                ),
                {"start_of_year": start_of_year, "tomorrow": tomorrow, "tz_offset": self._timezone_offset_hours()},
            ).fetchall()
        self.logger.info("  raw_sale_order max date_order UTC: %s", raw_row["max_raw_order_date_utc"])
        self.logger.info("  raw_sale_order max write_date UTC: %s", raw_row["max_raw_order_write_utc"])
        self.logger.info("  raw_sale_order_line max create_date UTC: %s", raw_row["max_raw_line_create_utc"])
        self.logger.info("  raw_sale_order_line max write_date UTC: %s", raw_row["max_raw_line_write_utc"])
        self.logger.info("  raw sale.order YTD amount_total using local date window: %.2f", float(raw_row["raw_order_ytd_value"] or 0))
        self.logger.info("  raw sale.order.line YTD price_total using local order date window: %.2f", float(raw_line_ytd or 0))
        self.logger.info("Sales exclusion diagnostics by raw order state/invoice_status:")
        for state, invoice_status, order_count, order_value, line_count, line_value in raw_exclusions:
            reason = "excluded by invoice_status='no'" if str(invoice_status).strip().lower() == "no" and not self.settings.include_uninvoiced_sales_lines else "eligible/preserved"
            self.logger.info(
                "  state=%s invoice_status=%s orders=%s order_value=%.2f lines=%s line_value=%.2f | %s",
                state,
                invoice_status,
                order_count,
                float(order_value or 0),
                line_count,
                float(line_value or 0),
                reason,
            )

    def _validate_sales_freshness(self, exporter: DatabaseExporter) -> None:
        latest = self._latest_odoo_sale_order_end or self._latest_odoo_sale_order_start
        latest_name = latest.get("name")
        if not latest_name:
            self.logger.warning("Sales freshness validation skipped: no latest Odoo sale.order was captured")
            return
        if not self._has_required_tables(exporter, ["raw_sale_order", "raw_sale_order_line"]):
            self.logger.warning(
                "Sales freshness raw staging validation skipped: raw_sale_order and/or raw_sale_order_line not present in schema %s",
                exporter._effective_schema() or "<default>",
            )
            return

        latest_state = str(latest.get("state") or "").strip().lower()
        latest_invoice_status = str(latest.get("invoice_status") or "").strip().lower()
        latest_date_raw = latest.get("date_order")
        latest_date_local = (
            odoo_utc_datetime_to_local(pd.Series([latest_date_raw]), self.settings.timezone).iloc[0]
            if latest_date_raw
            else pd.NaT
        )

        raw_orders = exporter._quoted_table_name("raw_sale_order")
        raw_lines = exporter._quoted_table_name("raw_sale_order_line")
        fact_orders = exporter._quoted_table_name("Fact_Orders")
        fact_lines = exporter._quoted_table_name("Fact_SalesLines")
        fact_sales = exporter._quoted_table_name("Fact_Sales")
        q = exporter.engine.dialect.identifier_preparer.quote
        inspector = inspect(exporter.engine)
        schema = exporter._effective_schema()
        fact_sales_table = exporter._database_table_name("Fact_Sales") or "Fact_Sales"
        fact_sales_columns = {str(col["name"]) for col in inspector.get_columns(fact_sales_table, schema=schema)}
        fact_sales_identifier_col = self._first_available_column(
            fact_sales_columns,
            ["order_number", "OrderNumber", "SalesOrderID", "sales_order_id", "order_id", "OrderID"],
        )
        fact_sales_date_col = self._first_available_column(
            fact_sales_columns,
            ["order_date", "OrderDate", "OrderDateTime", "order_date_date", "Date", "CreatedDate"],
        )
        fact_sales_identifier_value = self._latest_order_identifier_value(latest, fact_sales_identifier_col)
        if fact_sales_identifier_col is None:
            self.logger.info("Fact_Sales freshness validation found no order identifier column; falling back to latest date")
        if fact_sales_date_col is None:
            self.logger.warning(
                "Fact_Sales freshness validation found no usable date column in %s; available columns=%s",
                fact_sales_table,
                sorted(fact_sales_columns),
            )

        with exporter.engine.connect() as conn:
            raw_match = conn.execute(
                text(
                    f"""
                    WITH matching_orders AS (
                        SELECT *
                        FROM {raw_orders}
                        WHERE name = :name
                    ),
                    latest_matching_order AS (
                        SELECT name, date_order, state, invoice_status, amount_total
                        FROM matching_orders
                        ORDER BY CAST(date_order AS DATETIME) DESC, id DESC
                        LIMIT 1
                    )
                    SELECT
                        latest_matching_order.name,
                        latest_matching_order.date_order,
                        latest_matching_order.state,
                        latest_matching_order.invoice_status,
                        latest_matching_order.amount_total,
                        COUNT(l.id) AS line_count,
                        COALESCE(SUM(CAST(l.price_total AS DECIMAL(18,4))), 0) AS line_value
                    FROM latest_matching_order
                    LEFT JOIN matching_orders o ON o.name = latest_matching_order.name
                    LEFT JOIN {raw_lines} l ON l.order_id_id = o.id
                    GROUP BY latest_matching_order.name, latest_matching_order.date_order, latest_matching_order.state, latest_matching_order.invoice_status, latest_matching_order.amount_total
                    """
                ),
                {"name": latest_name},
            ).mappings().one_or_none()
            latest_raw = conn.execute(
                text(
                    f"""
                    SELECT name, date_order, state, invoice_status
                    FROM {raw_orders}
                    ORDER BY CAST(date_order AS DATETIME) DESC, id DESC
                    LIMIT 1
                    """
                )
            ).mappings().one_or_none()
            fact_order_match = conn.execute(
                text(
                    f"""
                    SELECT COUNT(*) AS row_count, MAX({q("OrderDateTime")}) AS max_order_date, COALESCE(SUM({q("OrderValue")}), 0) AS value
                    FROM {fact_orders}
                    WHERE order_number = :name
                    """
                ),
                {"name": latest_name},
            ).mappings().one()
            fact_sales_match = conn.execute(
                text(
                    f"""
                    SELECT COUNT(*) AS row_count, MAX(order_date) AS max_order_date, COALESCE(SUM({q("Value")}), 0) AS value
                    FROM {fact_lines}
                    WHERE order_number = :name
                    """
                ),
                {"name": latest_name},
            ).mappings().one()
            fact_sales_doc_validation = "identifier"
            if fact_sales_identifier_col and fact_sales_identifier_value is not None:
                max_date_expr = f"MAX({q(fact_sales_date_col)})" if fact_sales_date_col else "NULL"
                fact_sales_doc_match = conn.execute(
                    text(
                        f"""
                        SELECT COUNT(*) AS row_count, {max_date_expr} AS max_order_date
                        FROM {fact_sales}
                        WHERE {q(fact_sales_identifier_col)} = :identifier_value
                        """
                    ),
                    {"identifier_value": fact_sales_identifier_value},
                ).mappings().one()
            elif fact_sales_date_col:
                fact_sales_doc_validation = "latest_date"
                fact_sales_doc_match = conn.execute(
                    text(
                        f"""
                        SELECT COUNT(*) AS row_count, MAX({q(fact_sales_date_col)}) AS max_order_date
                        FROM {fact_sales}
                        """
                    )
                ).mappings().one()
            else:
                fact_sales_doc_validation = "unavailable"
                fact_sales_doc_match = conn.execute(
                    text(
                        f"""
                        SELECT COUNT(*) AS row_count, NULL AS max_order_date
                        FROM {fact_sales}
                        """
                    )
                ).mappings().one()
            latest_fact_order = conn.execute(
                text(
                    f"""
                    SELECT order_number, {q("OrderDateTime")}
                    FROM {fact_orders}
                    ORDER BY {q("OrderDateTime")} DESC
                    LIMIT 1
                    """
                )
            ).mappings().one_or_none()
            latest_fact_sales = None
            if fact_sales_date_col:
                identifier_select = f"{q(fact_sales_identifier_col)} AS order_identifier" if fact_sales_identifier_col else "NULL AS order_identifier"
                latest_fact_sales = conn.execute(
                    text(
                        f"""
                        SELECT {identifier_select}, {q(fact_sales_date_col)} AS latest_date
                        FROM {fact_sales}
                        ORDER BY {q(fact_sales_date_col)} DESC
                        LIMIT 1
                        """
                    )
                ).mappings().one_or_none()

        self.logger.info("Sales freshness validation:")
        self.logger.info(
            "  Latest Odoo sale.order: %s | date_order=%s | state=%s | invoice_status=%s",
            latest_name,
            latest_date_local,
            latest_state,
            latest_invoice_status,
        )
        if latest_raw:
            self.logger.info(
                "  Latest raw_sale_order: %s | date_order=%s | state=%s | invoice_status=%s",
                latest_raw["name"],
                latest_raw["date_order"],
                latest_raw["state"],
                latest_raw["invoice_status"],
            )
        self.logger.info(
            "  Latest Odoo order in raw staging: rows=%s lines=%s line_value=%.2f",
            1 if raw_match else 0,
            int(raw_match["line_count"]) if raw_match else 0,
            float(raw_match["line_value"] or 0) if raw_match else 0,
        )
        self.logger.info(
            "  Latest Odoo order in Fact_Orders: rows=%s max_order_date=%s value=%.2f",
            fact_order_match["row_count"],
            fact_order_match["max_order_date"],
            float(fact_order_match["value"] or 0),
        )
        self.logger.info(
            "  Latest Odoo order in Fact_SalesLines: rows=%s max_order_date=%s value=%.2f",
            fact_sales_match["row_count"],
            fact_sales_match["max_order_date"],
            float(fact_sales_match["value"] or 0),
        )
        self.logger.info(
            "  Latest Odoo order in Fact_Sales: rows=%s max_order_date=%s",
            fact_sales_doc_match["row_count"],
            fact_sales_doc_match["max_order_date"],
        )
        if latest_fact_order:
            self.logger.info("  Latest Fact_Orders: %s | %s", latest_fact_order["order_number"], latest_fact_order["OrderDateTime"])
        if latest_fact_sales:
            self.logger.info("  Latest Fact_Sales: %s | %s", latest_fact_sales["order_identifier"], latest_fact_sales["latest_date"])

        if raw_match is None:
            raise RuntimeError(
                f"Sales freshness validation failed: latest Odoo sale.order {latest_name} was not written to raw_sale_order."
            )
        fact_sales_doc_fresh = int(fact_sales_doc_match["row_count"] or 0) > 0
        if fact_sales_doc_validation == "latest_date":
            fact_sales_doc_fresh = self._date_covers_latest_order(fact_sales_doc_match["max_order_date"], latest_date_local)
        elif fact_sales_doc_validation == "unavailable":
            self.logger.warning(
                "Fact_Sales freshness validation could not confirm latest sale.order %s because no identifier or date column exists",
                latest_name,
            )
            fact_sales_doc_fresh = True
        if not fact_sales_doc_fresh:
            raise RuntimeError(
                "Sales freshness validation failed: latest Odoo sale.order "
                f"{latest_name} was not written to Fact_Sales."
            )

        confirmed_sale = latest_state in {"sale", "done"}
        excluded_by_invoice_filter = (
            latest_invoice_status == "no"
            and not self.settings.include_uninvoiced_sales_lines
            and not confirmed_sale
        )
        has_lines = int(raw_match["line_count"] or 0) > 0

        if confirmed_sale or not excluded_by_invoice_filter:
            missing = []
            if has_lines and int(fact_sales_match["row_count"] or 0) == 0:
                missing.append("Fact_SalesLines")
            if has_lines and int(fact_order_match["row_count"] or 0) == 0:
                missing.append("Fact_Orders")
            if missing:
                raise RuntimeError(
                    "Sales freshness validation failed: latest Odoo sale.order "
                    f"{latest_name} is eligible for sales facts but missing from {', '.join(missing)}. "
                    f"state={latest_state}, invoice_status={latest_invoice_status}, raw_line_count={raw_match['line_count']}."
                )
            if not has_lines:
                self.logger.warning(
                    "Latest Odoo sale.order %s is eligible but has no raw_sale_order_line rows; sales fact rows cannot be built.",
                    latest_name,
                )
        else:
            self.logger.info(
                "  Latest Odoo sale.order %s is excluded from Fact_SalesLines/Fact_Orders by business rule: invoice_status='no' and state is not sale/done. It is present in Fact_Sales.",
                latest_name,
            )

    @staticmethod
    def _first_available_column(columns: set[str], candidates: list[str]) -> str | None:
        for candidate in candidates:
            if candidate in columns:
                return candidate
        columns_by_lower = {column.lower(): column for column in columns}
        for candidate in candidates:
            match = columns_by_lower.get(candidate.lower())
            if match:
                return match
        return None

    @staticmethod
    def _latest_order_identifier_value(latest: dict[str, Any], identifier_col: str | None) -> Any:
        if identifier_col is None:
            return None
        if identifier_col.lower() in {"salesorderid", "sales_order_id", "order_id", "orderid"}:
            return latest.get("id")
        return latest.get("name")

    @staticmethod
    def _date_covers_latest_order(sql_value: Any, latest_value: Any) -> bool:
        sql_date = pd.to_datetime(sql_value, errors="coerce")
        latest_date = pd.to_datetime(latest_value, errors="coerce")
        if pd.isna(sql_date) or pd.isna(latest_date):
            return False
        return sql_date.date() >= latest_date.date()

    def _has_required_tables(self, exporter: DatabaseExporter, table_names: list[str]) -> bool:
        inspector = inspect(exporter.engine)
        schema = exporter._effective_schema()
        return all(inspector.has_table(table_name, schema=schema) for table_name in table_names)

    def _timezone_offset_hours(self) -> int:
        now = pd.Timestamp.now(tz=self.settings.timezone)
        offset = now.utcoffset()
        return int(offset.total_seconds() // 3600) if offset else 0

    def _log_runtime(self, run_context: PipelineRunContext) -> None:
        self.logger.info("Pipeline runtime summary:")
        self.logger.info("  Start time: %s", run_context.start_time)
        self.logger.info("  End time: %s", run_context.end_time)
        self.logger.info("  Total duration: %.2f minutes", run_context.total_duration_minutes)
        self.logger.info("  Status: %s", run_context.status)
        if run_context.error_message:
            self.logger.info("  Error: %s", run_context.error_message)
        for step in run_context.step_timings:
            self.logger.info(
                "  Step %s | %s | %.2f minutes",
                step.step_name,
                step.status,
                step.duration_seconds / 60,
            )

    def _log_run_summary(
        self,
        *,
        run_context: PipelineRunContext,
        load_mode: str,
        fast: bool,
        odoo_extract_count: int,
        sheets: dict[str, pd.DataFrame],
        db_loaded_count: int,
        qa_issues_count: int,
        workbook_path: Path | None,
    ) -> None:
        mode = "fast incremental" if fast and load_mode == "incremental" else ("incremental SQL" if load_mode == "incremental" else "full")
        self.logger.info("Final run summary:")
        self.logger.info("  Mode used: %s", mode)
        self.logger.info("  Rows loaded from Odoo: %s", odoo_extract_count)
        self.logger.info("  Rows transformed: %s", sum(len(frame) for frame in sheets.values()))
        self.logger.info("  Rows exported to SQL: %s", db_loaded_count)
        self.logger.info("  QA issues: %s", qa_issues_count)
        self.logger.info("  Output path: %s", workbook_path or self.settings.db_name)
        self.logger.info("  Runtime seconds by stage: %s", {step.step_name: round(step.duration_seconds, 2) for step in run_context.step_timings})
        self.logger.info("  Output row counts: %s", {name: len(frame) for name, frame in sheets.items()})

    @staticmethod
    def _normalize_sales_export(raw: pd.DataFrame) -> pd.DataFrame:
        df = raw.copy()
        df.columns = [str(c).strip() for c in df.columns]
        existing = [col for col in SALES_COLUMN_MAP if col in df.columns]
        if not existing:
            raise ValueError(f"No expected sale.report export columns found. Got: {list(df.columns)}")
        out = df[existing].rename(columns={col: SALES_COLUMN_MAP[col] for col in existing})
        out = out.loc[:, ~out.columns.duplicated()]
        ordered_expected = list(dict.fromkeys(SALES_COLUMN_MAP.values()))
        for expected in ordered_expected:
            if expected not in out.columns:
                out[expected] = pd.NA
        return out[[col for col in ordered_expected if col in out.columns]]

    @staticmethod
    def _attach_salesperson_fields(df_sales: pd.DataFrame, dim_salesperson: pd.DataFrame) -> pd.DataFrame:
        out = df_sales.copy()
        lookup = dim_salesperson[["salesperson", "SalespersonKey", "DistributionChannel", "SalesTeamKey"]].dropna(subset=["salesperson"]).drop_duplicates("salesperson")
        for col in ["SalespersonKey", "DistributionChannel"]:
            if col in out.columns:
                out = out.drop(columns=[col])
        out = out.merge(lookup, on="salesperson", how="left", validate="m:1", suffixes=("", "_dim"))
        if "SalesTeamKey_dim" in out.columns:
            out["SalesTeamKey"] = out.get("SalesTeamKey", pd.Series(index=out.index, dtype="object")).combine_first(out["SalesTeamKey_dim"])
            out = out.drop(columns=["SalesTeamKey_dim"])
        out["SalespersonKey"] = pd.to_numeric(out["SalespersonKey"], errors="coerce").fillna(0).astype(int)
        out["DistributionChannel"] = out["DistributionChannel"].fillna("Unknown").astype(str).str.strip().replace({"": "Unknown"})
        return out

    @staticmethod
    def _attach_customer_keys(df_sales: pd.DataFrame, dim_customer: pd.DataFrame) -> pd.DataFrame:
        out = df_sales.copy()
        for col in ["CustomerKey", "CustomerStatus"]:
            if col in out.columns:
                out = out.drop(columns=[col])
        source_customer_id = out["customer_id"] if "customer_id" in out.columns else pd.Series(pd.NA, index=out.index)
        out["_CustomerIDJoin"] = CustomerDimensionBuilder._clean_customer_id(source_customer_id)
        missing_customer_id = out["_CustomerIDJoin"].isna()
        if missing_customer_id.any():
            out.loc[missing_customer_id, "_CustomerIDJoin"] = out.loc[missing_customer_id, "customer"].apply(CustomerDimensionBuilder._make_synthetic_customer_id)
        lookup = dim_customer[["CustomerID", "CustomerKey", "CustomerStatus"]].dropna(subset=["CustomerID"]).drop_duplicates("CustomerID")
        out = out.merge(lookup, left_on="_CustomerIDJoin", right_on="CustomerID", how="left", validate="m:1").drop(columns=["CustomerID", "_CustomerIDJoin"], errors="ignore")
        out["CustomerKey"] = pd.to_numeric(out["CustomerKey"], errors="coerce").astype("Int64")
        return out
