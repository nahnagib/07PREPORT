"""Built-in jobs. ``platform_selfcheck`` verifies a deployment without loading any data:

* the database is reachable and has the meta tables (the runner checks this before any job);
* every configured Odoo credential profile passes the production guard, logs in, and can read
  ``res.company`` (read-only calls only);
* the Excel input folder exists and lists its files.

It is a diagnostic, so it never writes an ``etl_run_log`` row (it must never count as a data refresh).
"""

from __future__ import annotations

import os
import re

from sqlalchemy import text

from etl_platform.registry import REGISTRY, JobSpec, TaskSpec
from etl_platform.runner import RunContext, TaskResult


def configured_odoo_profiles() -> list[str]:
    profiles = ["default"]
    for name in sorted(os.environ):
        m = re.fullmatch(r"ODOO_([A-Z0-9]+)_API_KEY", name)
        if m and os.environ[name].strip():
            profiles.append(m.group(1).lower())
    return profiles


def _selfcheck_database(ctx: RunContext) -> TaskResult:
    with ctx.engine.connect() as conn:
        version = conn.execute(text("SELECT VERSION()" if ctx.engine.dialect.name == "mysql" else "SELECT sqlite_version()")).scalar()
    ctx.logger.info("Database reachable: %s %s", ctx.engine.dialect.name, version)
    return TaskResult(details={"dialect": ctx.engine.dialect.name, "version": str(version)})


def _selfcheck_odoo(ctx: RunContext) -> TaskResult:
    details = {}
    for profile in configured_odoo_profiles():
        source = ctx.odoo(profile)
        companies = source.client.search_count("res.company", [], context=source.context)
        details[profile] = {"server_version": source.server_version, "mode": source.mode, "companies_visible": companies}
        ctx.logger.info("Odoo profile '%s': mode=%s version=%s companies visible=%s", profile, source.mode, source.server_version, companies)
    return TaskResult(rows_extracted=len(details), details=details)


def _selfcheck_inputs(ctx: RunContext) -> TaskResult:
    folder = ctx.config.input_dir
    if not folder.is_dir():
        raise FileNotFoundError(f"ETL input folder not found: {folder}")
    files = sorted(p.name for p in folder.iterdir() if p.is_file() and not p.name.startswith("~$"))
    ctx.logger.info("Input folder %s: %s", folder, ", ".join(files) or "(empty)")
    return TaskResult(details={"input_dir": str(folder), "files": files})


REGISTRY.task(TaskSpec("selfcheck_database", _selfcheck_database))
REGISTRY.task(TaskSpec("selfcheck_odoo", _selfcheck_odoo, depends_on=("selfcheck_database",)))
REGISTRY.task(TaskSpec("selfcheck_inputs", _selfcheck_inputs, depends_on=("selfcheck_database",)))
REGISTRY.job(JobSpec(
    "platform_selfcheck", department="platform", mode="check", log_run=False,
    tasks=("selfcheck_database", "selfcheck_odoo", "selfcheck_inputs"),
    description="Read-only deployment check: database + meta tables, Odoo guard/login per profile, input folder.",
))
