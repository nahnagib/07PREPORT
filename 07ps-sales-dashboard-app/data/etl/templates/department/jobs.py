"""<Dept> department jobs (template -- copy to src/departments/<dept>/jobs.py; see README.md).

  <dept>_<topic>  Odoo -> raw_odoo_* -> dim_<dept>_* + fact_<dept>_<topic>; depends on core_dims.

Load: one transaction -- upsert the dimension, replace the day's snapshot, evaluate the checks on that transaction;
a failed orphan/sanity check rolls everything back.
"""

from __future__ import annotations

import datetime as _dt
from typing import Any

import pandas as pd

from core.jobs import ensure_date_range
from core.resolve import KeyMaps
from etl_platform import quality as q
from etl_platform.load import replace_all, snapshot_replace, upsert
from etl_platform.notify import notify
from etl_platform.registry import REGISTRY, DatasetSpec, JobSpec, TaskSpec
from etl_platform.runner import RunContext, TaskResult
from etl_platform.sources.odoo import OdooConfigError, OdooCredentials, m2o_id

from departments.DEPT import transform as tf  # rename DEPT

DEPARTMENT = "<dept>"
PROFILE = "<dept>"  # ODOO_<DEPT>_LOGIN / _API_KEY / _KEY_EXPIRES
MODEL, DOMAIN = "<odoo.model>", [("state", "!=", "cancel")]
FIELDS = ["id", "partner_id", "company_id", "user_id", "team_id", "state", "amount", "write_date"]
FACT, DIM = "fact_<dept>_<topic>", "dim_<dept>_<thing>"
KEY_DIMS = {
    "CustomerKey": ("dim_customer", "CustomerKey"), "CompanyKey": ("dim_company", "CompanyKey"),
    "SalespersonKey": ("dim_salesperson", "SalespersonKey"), "SalesTeamKey": ("dim_sales_team", "SalesTeamKey"),
    "SnapshotDateKey": ("dim_date", "DateKey"),
}


def source(ctx: RunContext):
    try:
        OdooCredentials.from_env(PROFILE)
    except OdooConfigError:
        notify("WARNING", f"{ctx.job.name} runs with the default read-only ETL credentials: ODOO_{PROFILE.upper()}_* not set")
        return ctx.odoo("default")
    return ctx.odoo(PROFILE)


def extract(ctx: RunContext) -> TaskResult:
    src = source(ctx)
    fields, skipped = src.available_fields(MODEL, FIELDS)
    rows = src.search_read_all(MODEL, [*DOMAIN, ("company_id", "in", list(ctx.config.odoo_company_ids))], fields)
    frame = pd.DataFrame([{k: (m2o_id(v) if isinstance(v, list) else (None if v is False else v)) for k, v in r.items()} for r in rows])
    frame["_extracted_at"], frame["_run_id"] = _dt.datetime.utcnow(), ctx.run_uid
    with ctx.engine.begin() as conn:
        replace_all(conn, "raw_odoo_<model>", frame.drop(columns=["write_date"], errors="ignore"))
    ctx.state["records"] = frame
    return TaskResult(rows_extracted=len(rows), rows_loaded=len(frame), details={"skipped_fields": skipped})


def load(ctx: RunContext) -> TaskResult:
    with ctx.engine.connect() as conn:
        maps = KeyMaps.load(conn)
    built = tf.build(ctx.state["records"], maps, ctx.as_of)
    for key, ids in built.fallbacks.items():
        ctx.record_fallback(key, ids)
    snap = tf.date_key(ctx.as_of)
    fact = built.fact.assign(_run_id=ctx.run_uid)
    with ctx.engine.begin() as conn:
        ensure_date_range(conn, ctx.as_of, ctx.as_of)
        if len(built.dimension):
            upsert(conn, DIM, built.dimension)
        _, inserted = snapshot_replace(conn, FACT, fact.drop(columns=["SnapshotDateKey"]), {"SnapshotDateKey": snap})
        checks = [q.orphan(FACT, col, dim, dim_col, where=f"SnapshotDateKey = {snap}") for col, (dim, dim_col) in KEY_DIMS.items()]
        q.raise_for_failures(ctx.quality.evaluate(checks, conn, task_name="load"))
    return TaskResult(rows_loaded=inserted, details=built.stats)


REGISTRY.dataset(DatasetSpec("raw_odoo_<model>", DEPARTMENT, "raw", "odoo", "raw_odoo_<model>", "replace", ("id",), model=MODEL))
REGISTRY.dataset(DatasetSpec(FACT, DEPARTMENT, "mart", "sql", FACT, "snapshot_replace", ("SnapshotDateKey", "record_id")))
REGISTRY.task(TaskSpec("extract_<dept>", extract))
REGISTRY.task(TaskSpec("load_<dept>", load, depends_on=("extract_<dept>",)))
REGISTRY.job(JobSpec("<dept>_<topic>", DEPARTMENT, tasks=("extract_<dept>", "load_<dept>"), depends_on_jobs=("core_dims",),
                     mode="snapshot", description="<what the job loads>"))
