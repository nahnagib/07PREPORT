"""Runs a registered job: dependency jobs first, then the job's tasks in dependency order.

For every job run (unless ``JobSpec.log_run`` is False) one ``etl_run_log`` row goes ``running`` ->
``success``/``partial``/``failed``; dependency jobs get their own rows with ``parent_run_uid`` set to the run that
started them, so one ``full_all`` run is one top-level row plus its core_dims / finance / sales rows. Every task gets an
``etl_task_log`` row (rows extracted/loaded, -1 key fallbacks with sample source ids, watermark before/after).
Every check result goes to ``etl_dq_result``. The whole invocation holds the MySQL ETL lock, so a second trigger
fails with ``RunLockError`` after the lock wait instead of running alongside.

Failure rules for a job with dependency jobs:
* a required dependency fails -> the job's own tasks do not run and the job fails;
* a dependency whose own required dependency failed earlier in the run (finance when core_dims failed) is not
  started: it gets a ``skipped`` row;
* an optional dependency (``JobSpec.optional_jobs``, finance in ``full_all``) fails -> everything else still
  runs and keeps its data, and the job ends ``partial`` with "<department> failed: <error>". Nothing is retried
  inside the run; the next scheduled run tries again.

Progress lines ``Pipeline step <task> started|completed|failed`` match the pattern the Node worker already
parses (runPipelineJob.ts STAGE_PATTERN), so the ETL Control Center shows task progress unchanged.
"""

from __future__ import annotations

import datetime as _dt
import logging
import socket
import traceback
import uuid
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.engine import Engine

from etl_platform import meta
from etl_platform.config import PlatformConfig
from etl_platform.db import run_lock
from etl_platform.notify import notify, register_channel
from etl_platform.quality import QualityCheckFailed, QualityRunner
from etl_platform.registry import DatasetSpec, JobSpec, Registry, RegistryError, TaskSpec
from etl_platform.watermark import Watermark, WatermarkStore

logger = logging.getLogger(__name__)

STATUS_RUNNING, STATUS_SUCCESS, STATUS_FAILED, STATUS_SKIPPED = "running", "success", "failed", "skipped"
STATUS_PARTIAL = "partial"  # an optional dependency job failed; the rest of the run succeeded
NOT_RUN = (STATUS_FAILED, STATUS_SKIPPED)
STALE_RUNNING_AFTER = _dt.timedelta(hours=6)  # same as sales_pipeline.etl_run_log
FALLBACK_SAMPLE = 20


def utc_now() -> _dt.datetime:
    return _dt.datetime.now(_dt.timezone.utc)


def _naive(value: _dt.datetime) -> _dt.datetime:
    return value.astimezone(_dt.timezone.utc).replace(tzinfo=None)


@dataclass
class TaskResult:
    rows_extracted: int = 0
    rows_loaded: int = 0
    details: dict[str, Any] = field(default_factory=dict)


class DependencyFailed(RuntimeError):
    pass


@dataclass
class RunContext:
    """What a task function receives."""

    engine: Engine
    config: PlatformConfig
    registry: Registry
    run_uid: str
    job: JobSpec
    as_of: _dt.date
    full_refresh: bool
    dataset_filter: str | None
    allow_large_change: bool
    quality: QualityRunner
    watermarks: WatermarkStore
    trigger_source: str
    _sources: dict[str, Any] = field(default_factory=dict, repr=False)
    task_name: str | None = None
    # data handed from one task of the job to the next (e.g. extracted frames -> conform -> load); in memory only
    state: dict[str, Any] = field(default_factory=dict)
    fallbacks: dict[str, dict[str, Any]] = field(default_factory=dict)
    watermark_before: dict[str, Any] = field(default_factory=dict)
    watermark_after: dict[str, Any] = field(default_factory=dict)

    @property
    def logger(self) -> logging.Logger:
        return logging.getLogger(f"etl.{self.job.department}.{self.task_name or self.job.name}")

    def dataset(self, name: str) -> DatasetSpec:
        return self.registry.datasets[name]

    def wants(self, dataset_name: str) -> bool:
        return self.dataset_filter is None or self.dataset_filter == dataset_name

    def odoo(self, profile: str = "default"):
        """Connected read-only Odoo source for a credential profile, shared by every task of the invocation."""
        key = f"odoo:{profile}"
        if key not in self._sources:
            from etl_platform.sources.odoo import OdooSource

            self._sources[key] = OdooSource.connect(self.config, profile, today=self.as_of)
        return self._sources[key]

    def odoo_company_ids(self, profile: str = "default") -> tuple[int, ...]:
        """Configured Odoo companies, with ODOO_COMPANY_NAMES resolved against accessible res.company rows."""
        cache_key = f"odoo_company_ids:{profile}"
        if cache_key in self.state:
            return self.state[cache_key]
        ids = list(self.config.odoo_company_ids)
        names = self.config.odoo_company_names
        if names:
            from sales_pipeline.product_matching import normalize_match_company

            source = self.odoo(profile)
            companies = source.accessible_companies()
            by_name = {
                normalize_match_company(c.get("name")).upper(): int(c["id"])
                for c in companies
                if c.get("name") is not None
            }
            missing = [name for name in names if normalize_match_company(name).upper() not in by_name]
            if missing:
                visible = ", ".join(f"{c['id']} {c.get('name')}" for c in companies)
                raise RuntimeError(
                    "ODOO_COMPANY_NAMES not visible to the Odoo user: "
                    + ", ".join(missing)
                    + f". Visible companies: {visible}"
                )
            ids.extend(by_name[normalize_match_company(name).upper()] for name in names)
        resolved = tuple(dict.fromkeys(int(i) for i in ids))
        self.state[cache_key] = resolved
        if f"odoo:{profile}" in self._sources:
            self._sources[f"odoo:{profile}"].company_ids = resolved
        return resolved

    def excel(self):
        if "excel" not in self._sources:
            from etl_platform.sources.excel import ExcelSource

            self._sources["excel"] = ExcelSource(self.config.input_dir)
        return self._sources["excel"]

    def record_fallback(self, key: str, source_ids: Iterable[Any]) -> int:
        """Reports facts that fell back to the -1 member of a dimension. Not a failure; logged per task."""
        ids = [i for i in source_ids]
        if not ids:
            return 0
        entry = self.fallbacks.setdefault(key, {"count": 0, "sample_ids": []})
        entry["count"] += len(ids)
        distinct = sorted({str(i) for i in ids if i is not None})
        for i in distinct:
            if len(entry["sample_ids"]) >= FALLBACK_SAMPLE:
                break
            if i not in entry["sample_ids"]:
                entry["sample_ids"].append(i)
        notify("WARNING", f"{key}: {len(ids)} row(s) fell back to the -1 (Unknown) member", task=self.task_name, sample=",".join(distinct[:10]))
        return len(ids)

    def record_watermark(self, dataset: str, before: Watermark, after: Watermark) -> None:
        self.watermark_before[dataset] = before.as_dict()
        self.watermark_after[dataset] = after.as_dict()

    def _begin_task(self, name: str) -> None:
        self.task_name = name
        self.fallbacks = {}
        self.watermark_before = {}
        self.watermark_after = {}


class Runner:
    def __init__(self, registry: Registry, engine: Engine, config: PlatformConfig) -> None:
        self.registry = registry
        self.engine = engine
        self.config = config
        self._sources: dict[str, Any] = {}
        self._done: dict[str, str] = {}
        self._totals: dict[str, dict[str, int]] = {}
        # status of the top-level job of the last run() (success / partial / failed); run.py maps it to an exit code
        self.last_status: str | None = None

    # -- public -------------------------------------------------------------------------------------------
    def run(
        self, job_name: str, *, as_of: _dt.date | None = None, full_refresh: bool = False, dataset: str | None = None,
        allow_large_change: bool = False, trigger_source: str = "cli",
    ) -> str:
        """Runs ``job_name``; returns its run_uid. Raises on failure (after logging it)."""
        self.registry.validate()
        job = self.registry.get_job(job_name)
        if dataset is not None:
            self._check_dataset_filter(job, dataset)
        meta.require_meta_tables(self.engine)
        as_of = as_of or _dt.datetime.now(ZoneInfo(self.config.business_timezone)).date()
        self._done = {}
        self._totals = {}
        self.last_status = None
        with run_lock(self.engine, self.config.lock_name, self.config.lock_timeout_seconds):
            self._sync_dataset_registry()
            try:
                return self._run_job(job, parent_uid=None, as_of=as_of, full_refresh=full_refresh, dataset=dataset,
                                     allow_large_change=allow_large_change, trigger_source=trigger_source)
            finally:
                self.last_status = self._done.get(job.name, STATUS_FAILED)

    # -- jobs ---------------------------------------------------------------------------------------------
    def _run_job(self, job: JobSpec, *, parent_uid: str | None, as_of: _dt.date, full_refresh: bool, dataset: str | None,
                 allow_large_change: bool, trigger_source: str) -> str:
        run_uid = str(uuid.uuid4())
        started = utc_now()
        logger.info("Job %s started (run_uid=%s as_of=%s full_refresh=%s dataset=%s)", job.name, run_uid, as_of, full_refresh, dataset)
        if job.log_run:
            self._start_run_row(job, run_uid, parent_uid, trigger_source, started)
        quality = QualityRunner(self.engine, run_uid, job.name, allow_large_change=allow_large_change)
        issues: list[str] = []
        unregister = register_channel(lambda lvl, msg, ctx: issues.append(f"{lvl}: {msg}") if lvl in ("WARNING", "ERROR", "CRITICAL") else None)
        totals = {"extracted": 0, "loaded": 0}
        optional_failures: list[str] = []
        try:
            # Every dependency is attempted even if an earlier one failed (full_all still runs sales when finance
            # fails); a dependency whose own required dependency failed is skipped, not started.
            dep_failures: list[str] = []
            for dep_name in job.depends_on_jobs:
                optional = dep_name in job.optional_jobs
                failures = optional_failures if optional else dep_failures
                if self._done.get(dep_name) in NOT_RUN:
                    failures.append(f"dependency job '{dep_name}' {self._done[dep_name]} earlier in this run")
                    continue
                if dep_name in self._done:
                    continue
                dep = self.registry.get_job(dep_name)
                blocker = self._failed_requirement(dep)
                if blocker is not None:
                    reason = f"skipped: dependency job '{blocker}' failed"
                    logger.warning("Job %s %s", dep.name, reason)
                    if dep.log_run:
                        self._skipped_run_row(dep, run_uid, trigger_source, reason)
                    self._done[dep.name] = STATUS_SKIPPED
                    failures.append(f"{dep.department} {reason}" if optional else f"dependency job '{dep.name}' {reason}")
                    continue
                fresh = None if full_refresh else self._fresh_success(dep)
                if fresh is not None:
                    logger.info("Job %s: dependency %s reused (succeeded at %s UTC, within %s min)", job.name, dep.name, fresh, self._reuse_window(dep))
                    self._done[dep.name] = "reused"
                    continue
                try:
                    self._run_job(dep, parent_uid=run_uid, as_of=as_of, full_refresh=full_refresh, dataset=None,
                                  allow_large_change=allow_large_change, trigger_source=trigger_source)
                except Exception as exc:  # noqa: BLE001 - recorded on the dependency's own row; reported below
                    if optional:
                        logger.error("Job %s: optional dependency %s failed; the rest of the run continues", job.name, dep.name)
                        failures.append(f"{dep.department} failed: {type(exc).__name__}: {exc}")
                    else:
                        failures.append(f"dependency job '{dep.name}' failed: {exc}")
                finally:
                    if not job.tasks:  # an umbrella job (main, full_all) reports what its dependency jobs loaded
                        for key, value in self._totals.get(dep.name, {}).items():
                            totals[key] += value
            if dep_failures:
                raise DependencyFailed("; ".join(dep_failures + optional_failures))

            ctx = RunContext(self.engine, self.config, self.registry, run_uid, job, as_of, full_refresh, dataset,
                             allow_large_change, quality, WatermarkStore(self.engine), trigger_source, self._sources)
            for task in self.registry.task_order(job):
                if dataset is not None and dataset not in task.datasets:
                    logger.info("Pipeline step %s skipped (--dataset %s)", task.name, dataset)
                    continue
                result = self._run_task(ctx, task)
                totals["extracted"] += result.rows_extracted
                totals["loaded"] += result.rows_loaded
        except Exception as exc:
            finished = utc_now()
            message = f"{type(exc).__name__}: {exc}"
            self._totals[job.name] = totals
            if job.log_run:
                self._finish_run_row(run_uid, STATUS_FAILED, started, finished, totals, quality_issue_count(issues), message)
            notify("ERROR", f"ETL job '{job.name}' failed: {message}", job=job.name, run_uid=run_uid)
            self._done[job.name] = STATUS_FAILED
            raise
        finally:
            unregister()
        finished = utc_now()
        status = STATUS_PARTIAL if optional_failures else STATUS_SUCCESS
        message = "; ".join(optional_failures) or None
        self._totals[job.name] = totals
        if job.log_run:
            self._finish_run_row(run_uid, status, started, finished, totals, quality_issue_count(issues), message, job.on_success)
        self._done[job.name] = status
        if status == STATUS_PARTIAL:
            logger.warning("Job %s completed PARTIALLY in %.1fs: %s", job.name, (finished - started).total_seconds(), message)
        else:
            logger.info("Job %s completed in %.1fs (extracted=%s loaded=%s)", job.name, (finished - started).total_seconds(),
                        f"{totals['extracted']:,}", f"{totals['loaded']:,}")
        return run_uid

    def _failed_requirement(self, job: JobSpec) -> str | None:
        """The first required dependency of ``job`` that failed or was skipped earlier in this run, else None."""
        for dep_name in job.depends_on_jobs:
            if dep_name not in job.optional_jobs and self._done.get(dep_name) in NOT_RUN:
                return dep_name
        return None

    def _check_dataset_filter(self, job: JobSpec, dataset: str) -> None:
        if dataset not in self.registry.datasets:
            raise RegistryError(f"Unknown dataset '{dataset}'")
        if not any(dataset in self.registry.tasks[t].datasets for t in job.tasks):
            raise RegistryError(f"Dataset '{dataset}' is not loaded by any task of job '{job.name}'")

    def _reuse_window(self, job: JobSpec) -> int | None:
        if job.reuse_within_minutes == "config":
            return self.config.core_dims_fresh_minutes
        return job.reuse_within_minutes

    def _fresh_success(self, job: JobSpec) -> _dt.datetime | None:
        window = self._reuse_window(job)
        if not window:
            return None
        cutoff = _naive(utc_now() - _dt.timedelta(minutes=window))
        t = meta.etl_run_log
        with self.engine.connect() as conn:
            last = conn.execute(
                select(func.max(t.c.finished_at_utc)).where(t.c.job_name == job.name, t.c.status == STATUS_SUCCESS)
            ).scalar()
        return last if last is not None and last >= cutoff else None

    # -- tasks --------------------------------------------------------------------------------------------
    def _run_task(self, ctx: RunContext, task: TaskSpec) -> TaskResult:
        ctx._begin_task(task.name)
        started = utc_now()
        logger.info("Pipeline step %s started", task.name)
        task_log_id = self._start_task_row(ctx, task, started)
        pending_before = len(ctx.quality.pending)
        try:
            result = task.fn(ctx) or TaskResult()
            for ds in self.registry.datasets_of_task(task):
                if ds.checks:
                    ctx.quality.evaluate(ds.checks, task_name=task.name)
            failed = [r for r in ctx.quality.pending[pending_before:] if r.failed]
            if failed:
                raise QualityCheckFailed(failed)
        except Exception as exc:
            self._finish_task_row(task_log_id, ctx, STATUS_FAILED, started, None, f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=8)}")
            logger.error("Pipeline step %s failed: %s", task.name, exc)
            raise
        finally:
            ctx.quality.flush()
        self._finish_task_row(task_log_id, ctx, STATUS_SUCCESS, started, result, None)
        logger.info("Pipeline step %s completed (extracted=%s loaded=%s)", task.name, f"{result.rows_extracted:,}", f"{result.rows_loaded:,}")
        return result

    # -- log rows -----------------------------------------------------------------------------------------
    def _start_run_row(self, job: JobSpec, run_uid: str, parent_uid: str | None, trigger_source: str, started: _dt.datetime) -> None:
        t = meta.etl_run_log
        now = utc_now()
        with self.engine.begin() as conn:
            conn.execute(
                t.update()
                .where(t.c.status == STATUS_RUNNING, t.c.started_at_utc < _naive(now - STALE_RUNNING_AFTER))
                .values(status=STATUS_FAILED, finished_at_utc=_naive(now), error_message="Abandoned: process ended without recording a result")
            )
            conn.execute(t.insert().values(
                run_uid=run_uid, mode=job.mode[:20], output_mode="sql", trigger_source=(trigger_source or "unknown")[:64],
                status=STATUS_RUNNING, started_at_utc=_naive(started), business_timezone=self.config.business_timezone,
                legacy_backfill=0, host=socket.gethostname()[:128], created_at_utc=_naive(now),
                job_name=job.name[:64], department=job.department[:32], parent_run_uid=parent_uid,
            ))

    def _finish_run_row(self, run_uid: str, status: str, started: _dt.datetime, finished: _dt.datetime, totals: Mapping[str, int],
                        qa_issues: int, error: str | None, on_success: Any = None) -> None:
        t = meta.etl_run_log
        values: dict[str, Any] = {
            "status": status, "finished_at_utc": _naive(finished),
            "duration_seconds": round((finished - started).total_seconds(), 3),
            "rows_processed": int(totals.get("loaded", 0)), "odoo_extract_count": int(totals.get("extracted", 0)),
            "qa_issues_count": int(qa_issues), "error_message": (error or None) and error[:60000],
        }
        try:
            with self.engine.begin() as conn:
                if status in (STATUS_SUCCESS, STATUS_PARTIAL) and on_success is not None:
                    values.update(dict(on_success(conn) or {}))
                conn.execute(t.update().where(t.c.run_uid == run_uid).values(**values))
        except Exception:
            # A run whose success cannot be recorded must not look successful: fail loudly (as the legacy
            # pipeline does), so it is retried rather than silently stale.
            logger.exception("Could not write etl_run_log for run %s", run_uid)
            if status in (STATUS_SUCCESS, STATUS_PARTIAL):
                raise

    def _skipped_run_row(self, job: JobSpec, parent_uid: str, trigger_source: str, reason: str) -> None:
        """A dependency job that was not started because a job it needs failed: a finished row, so the run's
        history shows every step it was meant to take."""
        run_uid = str(uuid.uuid4())
        now = utc_now()
        self._start_run_row(job, run_uid, parent_uid, trigger_source, now)
        self._finish_run_row(run_uid, STATUS_SKIPPED, now, now, {}, 0, reason)

    def _start_task_row(self, ctx: RunContext, task: TaskSpec, started: _dt.datetime) -> int | None:
        t = meta.etl_task_log
        with self.engine.begin() as conn:
            res = conn.execute(t.insert().values(
                run_uid=ctx.run_uid, job_name=ctx.job.name, task_name=task.name, status=STATUS_RUNNING, started_at_utc=_naive(started),
            ))
            return int(res.inserted_primary_key[0]) if res.inserted_primary_key else None

    def _finish_task_row(self, task_log_id: int | None, ctx: RunContext, status: str, started: _dt.datetime,
                         result: TaskResult | None, error: str | None) -> None:
        if task_log_id is None:
            return
        finished = utc_now()
        t = meta.etl_task_log
        with self.engine.begin() as conn:
            conn.execute(t.update().where(t.c.task_log_id == task_log_id).values(
                status=status, finished_at_utc=_naive(finished), duration_seconds=round((finished - started).total_seconds(), 3),
                rows_extracted=result.rows_extracted if result else None, rows_loaded=result.rows_loaded if result else None,
                unknown_key_fallbacks=sum(v["count"] for v in ctx.fallbacks.values()) if ctx.fallbacks else 0,
                fallback_detail=ctx.fallbacks or None, watermark_before=ctx.watermark_before or None,
                watermark_after=ctx.watermark_after or None, details=(result.details or None) if result else None,
                error_message=(error or None) and error[:60000],
            ))

    def _sync_dataset_registry(self) -> None:
        """Upserts every registered dataset definition into etl_dataset_registry (the dataset catalogue)."""
        if not self.registry.datasets:
            return
        t = meta.etl_dataset_registry
        now = _naive(utc_now())
        with self.engine.begin() as conn:
            existing = {r.dataset: r.definition_hash for r in conn.execute(select(t.c.dataset, t.c.definition_hash))}
            for ds in self.registry.datasets.values():
                values = dict(department=ds.department, layer=ds.layer, source=ds.source, source_object=ds.source_object,
                              target_table=ds.target_table, load_pattern=ds.load_pattern, natural_key=list(ds.natural_key),
                              incremental_field=ds.incremental_field, definition_hash=ds.definition_hash(), updated_at_utc=now)
                if ds.name not in existing:
                    conn.execute(t.insert().values(dataset=ds.name, first_registered_utc=now, **values))
                elif existing[ds.name] != values["definition_hash"]:
                    conn.execute(t.update().where(t.c.dataset == ds.name).values(**values))


def quality_issue_count(issues: list[str]) -> int:
    return len(issues)
