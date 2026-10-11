"""Sales department jobs.

  sales_full         extract + legacy transforms (sales_pipeline.build_sheets) -> conform keys -> load all marts
  sales_incremental  same tasks, run every 3 h. NOTE (phase 3): still a full Odoo extraction of sale.report & co;
                     write_date-incremental raw extraction for sales is delivered in phase 6.
  full_all           core_dims, sales_full (and finance from phase 5)

Load: every mart table is staged, ALL orphan/quality checks run on the staged tables, then all are swapped in one
RENAME TABLE (load.atomic_swap_many). A failed check leaves the live marts untouched.
"""

from __future__ import annotations

import dataclasses
import datetime as _dt
import logging
import os
import sys
from pathlib import Path
from typing import Any

import pandas as pd
from sqlalchemy import inspect, text

from config.settings import Settings
from core.jobs import ensure_date_range
from core.keys import UNKNOWN
from core.resolve import KeyMaps
from departments.sales import conform as cf
from etl_platform import quality as q
from etl_platform.load import atomic_swap_many, upsert
from etl_platform.registry import REGISTRY, DatasetSpec, JobSpec, TaskSpec
from etl_platform.runner import RunContext, TaskResult

DEPARTMENT = "sales"
MART_KEYS = {  # table -> primary key (migration 0031)
    "fact_sales_lines": ("SaleReportLineID",), "fact_sales_orders": ("SalesDocumentID",), "fact_sales_documents": ("SalesDocumentID",),
    "fact_sales_targets": ("YearMonth", "SalespersonKey", "SalesTeamKey", "CompanyKey"), "fact_sales_deliveries": ("DeliveryFactID",),
    "fact_sales_leads": ("LeadID", "IsOdooCreatedLead", "IsETLCreatedLead"), "fact_sales_opportunities": ("OpportunityID",),
    "fact_sales_product_daily": ("row_key",), "fact_sales_inventory_snapshot": ("SnapshotDateKey", "CompanyKey", "ProductKey", "LocationID"),
    "fact_sales_bcg_matrix": ("CompanyKey", "ProductMasterKey", "ProductKey"), "dim_sales_order": ("SalesOrderKey",),
    "dim_sales_crm_stage": ("StageID",), "dim_sales_lost_reason": ("LostReasonID",), "dim_sales_product_cost": ("ProductKey", "CompanyKey"),
    "dim_sales_product_dashboard": ("ProductMatchKey",), "dim_sales_product_group": ("ProductGroupKey",),
    "etl_sales_product_dashboard_meta": ("AsOfDate",),
}
MART_TABLES = tuple(MART_KEYS)
# every key column a sales table may carry -> the dimension it must exist in
KEY_DIMS = {
    "CustomerKey": ("dim_customer", "CustomerKey"), "SalespersonKey": ("dim_salesperson", "SalespersonKey"),
    "SalesTeamKey": ("dim_sales_team", "SalesTeamKey"), "ChannelKey": ("dim_channel", "ChannelKey"),
    "SegmentKey": ("dim_segment", "SegmentKey"), "CompanyKey": ("dim_company", "CompanyKey"),
    "ProductKey": ("dim_product", "ProductKey"), "ProductMasterKey": ("dim_product_master", "ProductMasterKey"),
    "SalesOrderKey": ("dim_sales_order", "SalesOrderKey"),
    **{c: ("dim_date", "DateKey") for c in cf.DATE_KEY_COLUMNS},
}
log = logging.getLogger(__name__)


def _settings(ctx: RunContext) -> Settings:
    os.environ.setdefault("ETL_INPUT_DIR", str(ctx.config.input_dir))
    settings = Settings.from_env(None)
    if settings.input_dir != ctx.config.input_dir:  # the platform's input folder wins
        settings = dataclasses.replace(settings, input_dir=ctx.config.input_dir)
    return settings


def _pipeline(ctx: RunContext):
    from sales_pipeline.pipeline import PowerBISalesPipeline

    if "pipeline" not in ctx.state:
        ctx.state["pipeline"] = PowerBISalesPipeline(_settings(ctx))
    return ctx.state["pipeline"]


# -- tasks -------------------------------------------------------------------------------------------------------------
def _regression_dir() -> Path | None:
    """Opt-in (ETL_REGRESSION_DIR): write regression totals of this run (scripts/regression/)."""
    raw = os.getenv("ETL_REGRESSION_DIR", "").strip()
    if not raw:
        return None
    tools = Path(__file__).resolve().parents[3] / "scripts" / "regression"
    if str(tools) not in sys.path:
        sys.path.insert(0, str(tools))
    return Path(raw)


def build_sales_sheets(ctx: RunContext) -> TaskResult:
    build = _pipeline(ctx).build_sheets(include_qa=False)
    ctx.state["build"] = build
    reg = _regression_dir()
    if reg is not None:  # legacy totals from THIS extraction (isolates conformance from Odoo changes)
        from sheets_capture import capture_sheets

        capture_sheets(build.sheets, reg / "legacy_same_run")
    return TaskResult(rows_extracted=build.odoo_extract_count, details={"sheets": {k: len(v) for k, v in build.sheets.items()}})


def conform_sales(ctx: RunContext) -> TaskResult:
    build = ctx.state["build"]
    with ctx.engine.connect() as conn:
        maps = KeyMaps.load(conn)
    targets = pd.read_excel(ctx.config.input_dir / "sales_targets.xlsx", sheet_name="Targets")
    targets["Salesperson"] = targets["Salesperson"].replace({"SalesPerson 2": "Sales Person 2"})  # approved: typo
    pipeline = _pipeline(ctx)
    result = cf.conform(build, maps, targets, lambda lines: pipeline.rebuild_product_tables(lines, build.sheets))
    for key, ids in result.fallbacks.items():
        ctx.record_fallback(key, ids)
    _apply_customer_growth(ctx, result)
    ctx.state["conformed"] = result
    return TaskResult(rows_loaded=0, details={"tables": {k: len(v) for k, v in result.tables.items()}, "legacy_key_parity": result.parity,
                                              "notes": result.notes})


def _apply_customer_growth(ctx: RunContext, result: cf.Conformed) -> None:
    """Customer Growth columns of dim_customer, recomputed by the legacy CustomerDimensionBuilder at
    commercial-partner grain, upserted column-scoped; then copied onto the sales lines like the legacy pipeline."""
    from sales_pipeline.legacy_transform import BlockedCustomersLoader, CustomerDimensionBuilder, PipelineSettings, SalesOrgRepository

    pipeline = _pipeline(ctx)
    with ctx.engine.connect() as conn:
        names = dict(conn.execute(text("SELECT CustomerKey, customer FROM dim_customer")).fetchall())
        blocked = pd.read_sql(text("SELECT CustomerKey, customer AS CustomerName, IsBlocked, BlockedDate, UnblockedDate, BlockedReason, Notes "
                                   "FROM dim_customer WHERE IsBlocked = 1"), conn)
    blocked["CustomerID"] = blocked["CustomerKey"].astype(str)
    legacy_logger = pipeline.legacy_logger
    sales_org = SalesOrgRepository(legacy_logger).load(pipeline.settings.sales_team_path)
    df = cf.customer_growth_input(result.tables["fact_sales_lines"], {int(k): v for k, v in names.items()})
    dim = CustomerDimensionBuilder(sales_org, PipelineSettings(), BlockedCustomersLoader(legacy_logger)).build(
        df, blocked_customers_path=None, blocked_customers=blocked.drop(columns=["CustomerKey"]))
    growth = cf.growth_rows(dim)
    names = {int(k): v for k, v in names.items()}
    unknown = sorted(set(growth["CustomerKey"]) - set(names))
    if unknown:  # never inserts customers: dim_customer is owned by core_dims
        ctx.record_fallback("customer growth rows without a dim_customer member (skipped)", unknown)
        growth = growth[growth["CustomerKey"].isin(names)]
    growth["customer"] = growth["CustomerKey"].map(names)  # NOT NULL for the INSERT branch only; not updated
    growth["updated_at_utc"] = _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None)
    with ctx.engine.begin() as conn:
        upsert(conn, "dim_customer", growth, update_columns=[*cf.GROWTH_COLUMNS, "updated_at_utc"])
    by_key = growth.set_index("CustomerKey")
    lines = result.tables["fact_sales_lines"]
    for col in ("First_Purchase_Date", "CustomerStatus"):
        if col in lines.columns:
            lines[col] = lines["CustomerKey"].map(by_key[col]).to_numpy()


def load_sales_marts(ctx: RunContext) -> TaskResult:
    result: cf.Conformed = ctx.state["conformed"]
    insp = inspect(ctx.engine)
    frames: dict[str, pd.DataFrame] = {}
    dropped: dict[str, list[str]] = {}
    for table in MART_TABLES:
        cols = [c["name"] for c in insp.get_columns(table)]
        df = result.tables[table].copy()
        df["_run_id"] = ctx.run_uid
        extra = [c for c in df.columns if c not in cols]
        if extra:
            dropped[table] = extra
        frames[table] = df[[c for c in df.columns if c in cols]]
    if dropped:
        log.warning("Columns produced by the legacy transforms but not in the mart schema (not loaded): %s", dropped)

    # dim_date must cover every date key before the orphan checks
    keys = [int(v) for df in frames.values() for c in cf.DATE_KEY_COLUMNS if c in df.columns for v in df[c].unique() if int(v) > 0]
    if keys:
        lo, hi = min(keys), max(keys)
        with ctx.engine.begin() as conn:
            ensure_date_range(conn, _dt.date(lo // 10000, lo // 100 % 100, lo % 100), _dt.date(hi // 10000, hi // 100 % 100, hi % 100))

    def check(conn, staged: dict[str, str]) -> None:
        overrides = dict(staged)
        specs = []
        for table, df in frames.items():
            for col in df.columns:
                if col in KEY_DIMS:
                    dim, dim_col = KEY_DIMS[col]
                    specs.append(q.orphan(table, col, dim, dim_col, name=f"orphan:{table}.{col}"))
            specs.append(q.min_rows(table, 1, name=f"min_rows:{table}", severity="fail" if table.startswith("fact_sales_lines") else "warn"))
        results = ctx.quality.evaluate(specs, conn, task_name="load_sales_marts", table_overrides=overrides)
        q.raise_for_failures(results)

    counts = atomic_swap_many(ctx.engine, frames, before_swap=check)
    reg = _regression_dir()
    if reg is not None:  # totals of the loaded marts, read back through the serving views
        from sqlalchemy import create_engine
        from sqlalchemy.pool import NullPool

        from baseline import capture

        # its own unpooled engine: capture() makes its session read-only, which must never reach the job's pool
        engine = create_engine(ctx.engine.url, poolclass=NullPool, future=True)
        try:
            capture(engine, "new", reg / "new")
        finally:
            engine.dispose()
    return TaskResult(rows_loaded=sum(counts.values()), details={"rows": counts, "dropped_columns": dropped})


def sales_watermark(conn) -> dict[str, Any]:
    """etl_run_log watermark columns, read back from the loaded orders in the same transaction (refreshStatus)."""
    from sales_pipeline.etl_run_log import _naive_or_none, read_target_watermark

    tz = os.getenv("TIMEZONE", "Africa/Tripoli")
    wm = read_target_watermark(conn, "fact_sales_orders", tz)
    return {"watermark_order_date_utc": _naive_or_none(wm.order_date_utc), "watermark_order_created_utc": _naive_or_none(wm.order_created_utc),
            "watermark_order_number": wm.order_number}


# -- registration ----------------------------------------------------------------------------------------------------------
for table in MART_TABLES:
    REGISTRY.dataset(DatasetSpec(table, DEPARTMENT, "mart", "sql", table, "swap", MART_KEYS[table]))
REGISTRY.task(TaskSpec("build_sales_sheets", build_sales_sheets))
REGISTRY.task(TaskSpec("conform_sales", conform_sales, depends_on=("build_sales_sheets",)))
REGISTRY.task(TaskSpec("load_sales_marts", load_sales_marts, depends_on=("conform_sales",)))
for name, mode in (("sales_full", "full"), ("sales_incremental", "incremental")):
    REGISTRY.job(JobSpec(name, DEPARTMENT, tasks=("build_sales_sheets", "conform_sales", "load_sales_marts"),
                         depends_on_jobs=("core_dims",), mode=mode, on_success=sales_watermark,
                         description="Sales marts on conformed keys (legacy transforms, platform keys/load/quality)."))
# The pipelines the schedules run (one run id, the steps as child rows):
#   main     = core_dims -> sales_incremental                       every 3 h / "Sales Refresh" / npm run etl:incremental
#   full_all = core_dims -> finance_receivables -> sales_full       02:00 / "Full Refresh"; finance before sales so the
#              receivables report does not wait for the sales load; a finance failure leaves the run 'partial' and
#              the sales rebuild still happens; a core_dims failure skips both.
# The receivables snapshot also has its own daily schedule (finance_receivables alone, 15:00 Africa/Tripoli).
REGISTRY.job(JobSpec("main", "all", depends_on_jobs=("core_dims", "sales_incremental"), mode="incremental",
                     description="Scheduled pipeline: core dims -> sales (incremental). No finance."))
REGISTRY.job(JobSpec("full_all", "all", depends_on_jobs=("core_dims", "finance_receivables", "sales_full"),
                     optional_jobs=("finance_receivables",), mode="full",
                     description="Nightly pipeline: core dims -> receivables snapshot -> sales (full rebuild)."))
