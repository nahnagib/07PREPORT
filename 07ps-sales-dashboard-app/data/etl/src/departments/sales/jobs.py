"""Sales department jobs.

  sales_full         extract + legacy transforms (sales_pipeline.build_sheets) -> conform keys -> load all marts
  sales_incremental  same tasks, run 5x a day (main); skipped when ETL_SALES_MODE=incremental.
  sales_mirror       Odoo -> raw_odoo_mirror by write_date (30-minute refresh; full check at 02:00)  } Phase B,
  sales_build        the marts from the mirror, changed rows only, to shd_* (shadow) or live          } departments/
  sales_shadow_compare  live vs shd_* after the 02:00 refresh (shadow mode)                          } sales/incremental.py
  full_all           core_dims, finance_receivables, sales_full, process_nps (departments/process/jobs.py), then in
                     shadow mode sales_mirror (full check), sales_build, sales_shadow_compare

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
from departments.sales import incremental as inc
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
    _apply_customer_growth(ctx, result, write=ctx.state.get("write_customer_growth", True))
    ctx.state["conformed"] = result
    return TaskResult(rows_loaded=0, details={"tables": {k: len(v) for k, v in result.tables.items()}, "legacy_key_parity": result.parity,
                                              "notes": result.notes})


def _apply_customer_growth(ctx: RunContext, result: cf.Conformed, *, write: bool = True) -> None:
    """Customer Growth columns of dim_customer, recomputed by the legacy CustomerDimensionBuilder at
    commercial-partner grain, upserted column-scoped; then copied onto the sales lines like the legacy pipeline.
    ``write=False`` (the shadow build): copied onto the lines only; the live dim_customer is left to the live build."""
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
    if write:
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
REGISTRY.job(JobSpec("sales_full", DEPARTMENT, tasks=("build_sales_sheets", "conform_sales", "load_sales_marts"),
                     depends_on_jobs=("core_dims",), mode="full", on_success=sales_watermark,
                     description="Sales marts on conformed keys (legacy transforms, platform keys/load/quality)."))
REGISTRY.job(JobSpec("sales_incremental", DEPARTMENT, tasks=("build_sales_sheets", "conform_sales", "load_sales_marts"),
                     depends_on_jobs=("core_dims",), mode="incremental", on_success=sales_watermark,
                     disabled_reason=inc.mode_disabled("legacy", "shadow"),
                     description="Sales marts on conformed keys (legacy transforms, platform keys/load/quality). "
                                 "Skipped in ETL_SALES_MODE=incremental: sales_build writes the live tables every 30 minutes."))

# Phase B (departments/sales/incremental.py) -----------------------------------------------------------------------------
REGISTRY.task(TaskSpec("mirror_sync", inc.mirror_sync))
REGISTRY.task(TaskSpec("build_sales_from_mirror", inc.build_sales_from_mirror))
REGISTRY.task(TaskSpec("conform_sales_from_mirror", inc.conform_sales_from_mirror, depends_on=("build_sales_from_mirror",)))
REGISTRY.task(TaskSpec("write_sales_from_mirror", inc.write_sales_from_mirror, depends_on=("conform_sales_from_mirror",)))
REGISTRY.task(TaskSpec("shadow_compare", inc.shadow_compare))
REGISTRY.job(JobSpec("sales_mirror", DEPARTMENT, tasks=("mirror_sync",), mode="incremental", locks=("sales_mirror",),
                     disabled_reason=inc.mode_disabled("shadow", "incremental"),
                     description="Odoo -> raw_odoo_mirror by write_date (the records the sales build reads); 02:00: id checks + audit."))
REGISTRY.job(JobSpec("sales_build", DEPARTMENT, tasks=("build_sales_from_mirror", "conform_sales_from_mirror", "write_sales_from_mirror"),
                     mode="incremental", locks=inc.build_locks,
                     description="Sales marts from the Odoo mirror, changed rows only: shd_* (shadow) or live (incremental); "
                                 "seconds when nothing changed. Queue etl-long."))
REGISTRY.job(JobSpec("sales_shadow_compare", DEPARTMENT, tasks=("shadow_compare",), mode="full", locks=("sales", "sales_shadow"),
                     disabled_reason=inc.mode_disabled("shadow"),
                     description="Live (02:00, from sale.report) vs shadow (from the mirror) sales tables -> etl_shadow_compare."))
# The pipelines the schedules run (one run id, the steps as child rows):
#   main     = core_dims -> sales_incremental                       every 3 h / "Sales Refresh" / npm run etl:incremental
#   full_all = core_dims -> finance_receivables -> sales_full -> process_nps   02:00 / "Full Refresh"; finance before
#              sales so the receivables report does not wait for the sales load; a finance or NPS failure leaves the
#              run 'partial' and everything else keeps its data; a core_dims failure skips all three. NPS runs last:
#              it reads the sales orders / deliveries to find each rating's company. NPS_ENABLED=false: not run.
# The receivables snapshot also has its own daily schedule (finance_receivables alone, 15:00 Africa/Tripoli).
REGISTRY.job(JobSpec("main", "all", depends_on_jobs=("core_dims", "sales_incremental"), mode="incremental",
                     description="Scheduled pipeline: core dims -> sales (incremental). No finance."))
# In shadow mode full_all then brings the mirror up to date with the id checks (sales_mirror), rebuilds the shadow tables
# (sales_build: the business date changed) and compares them with the live tables just rebuilt from Odoo. In legacy mode
# those three are skipped; in incremental mode sales_mirror and sales_build run (the live tables were just rebuilt from
# Odoo, so the build finds nothing to change), the comparison is skipped. lock_wait="full": waits for a running
# sales_build instead of losing the night's rebuild.
REGISTRY.job(JobSpec("full_all", "all", depends_on_jobs=("core_dims", "finance_receivables", "sales_full", "process_nps", "sales_mirror",
                                                         "sales_build", "sales_shadow_compare"),
                     optional_jobs=("finance_receivables", "process_nps", "sales_mirror", "sales_build", "sales_shadow_compare"),
                     mode="full", lock_wait="full",
                     description="Nightly pipeline: core dims -> receivables snapshot -> sales (full rebuild) -> NPS Score "
                                 "(-> mirror check, shadow build, live vs shadow comparison)."))

# refresh_30m = the 30-minute refresh (ETL_SCHEDULE_REFRESH_*, backend registerSchedules.ts): the modules listed in
# ETL_REFRESH_MODULES, in this order, each isolated (a failed module never stops the next one; it keeps its watermark
# and the next cycle retries it) and locked on its own (a module whose lock is busy is skipped this cycle). Sales joins
# as sales_mirror (seconds): the sales tables themselves are built by sales_build on the second queue, so a long build
# never holds up receivables, collections or NPS. Candidates are the modules registered in this build
# ("departments.process.jobs", which registers process_nps, is imported before this module).
REFRESH_CANDIDATES = ("core_dims", "sales_mirror", "finance_receivables", "process_nps")
REGISTRY.job(JobSpec("refresh_30m", "all", depends_on_jobs=tuple(j for j in REFRESH_CANDIDATES if j in REGISTRY.jobs),
                     mode="incremental", configurable_modules=True, isolated=True,
                     description="30-minute refresh: shared lists -> sales mirror -> receivables and collections -> NPS (ETL_REFRESH_MODULES)."))
