"""Runner: order, run/task logging, dependency jobs and reuse, failures, DQ gating, fallbacks."""

from __future__ import annotations

import datetime as dt
import logging
from dataclasses import replace

import pytest
from sqlalchemy import text

from etl_platform import quality as q
from etl_platform.quality import QualityCheckFailed
from etl_platform.registry import DatasetSpec, JobSpec, Registry, TaskSpec
from etl_platform.runner import DependencyFailed, Runner, TaskResult

AS_OF = dt.date(2026, 10, 1)


def _rows(engine, sql):
    with engine.connect() as conn:
        return [tuple(r) for r in conn.execute(text(sql))]


def _registry(calls: list[str], *, fail: set[str] = frozenset()) -> Registry:
    r = Registry()

    def make(name, loaded=1):
        def fn(ctx):
            calls.append(name)
            if name in fail:
                raise RuntimeError(f"{name} exploded")
            return TaskResult(rows_extracted=loaded, rows_loaded=loaded)
        return fn

    for name in ("build_customer", "build_company", "load_sales", "sales_checks", "load_finance"):
        r.task(TaskSpec(name, make(name), depends_on={
            "load_sales": ("build_customer", "build_company"), "sales_checks": ("load_sales",),
            "load_finance": ("build_customer",),
        }.get(name, ())))
    r.job(JobSpec("core_dims", "core", tasks=("build_customer", "build_company"), reuse_within_minutes="config"))
    r.job(JobSpec("sales_full", "sales", tasks=("sales_checks", "load_sales"), depends_on_jobs=("core_dims",)))
    r.job(JobSpec("finance_receivables", "finance", tasks=("load_finance",), depends_on_jobs=("core_dims",), mode="snapshot"))
    r.job(JobSpec("full_all", "all", depends_on_jobs=("core_dims", "sales_full", "finance_receivables")))
    return r


def test_job_runs_dependencies_first_and_logs_runs_and_tasks(platform_engine, platform_config, caplog):
    calls: list[str] = []
    caplog.set_level(logging.INFO)
    uid = Runner(_registry(calls), platform_engine, platform_config).run("sales_full", as_of=AS_OF)
    assert calls == ["build_customer", "build_company", "load_sales", "sales_checks"]
    runs = _rows(platform_engine, "SELECT job_name, department, status, parent_run_uid IS NOT NULL, rows_processed FROM etl_run_log ORDER BY run_id")
    assert runs == [("sales_full", "sales", "success", 0, 2), ("core_dims", "core", "success", 1, 2)]
    tasks = _rows(platform_engine, "SELECT job_name, task_name, status FROM etl_task_log ORDER BY task_log_id")
    assert [t[1] for t in tasks] == ["build_customer", "build_company", "load_sales", "sales_checks"]
    assert all(t[2] == "success" for t in tasks)
    assert _rows(platform_engine, f"SELECT COUNT(*) FROM etl_run_log WHERE run_uid = '{uid}'") == [(1,)]
    # the Node worker's progress parser keys on these lines
    assert "Pipeline step load_sales started" in caplog.text and "Pipeline step load_sales completed" in caplog.text


def test_recent_core_dims_success_is_reused(platform_engine, platform_config):
    calls: list[str] = []
    runner = Runner(_registry(calls), platform_engine, platform_config)
    runner.run("core_dims", as_of=AS_OF)
    calls.clear()
    runner.run("finance_receivables", as_of=AS_OF)
    assert calls == ["load_finance"]


def test_full_refresh_rebuilds_dependencies_even_when_fresh(platform_engine, platform_config):
    calls: list[str] = []
    runner = Runner(_registry(calls), platform_engine, platform_config)
    runner.run("core_dims", as_of=AS_OF)
    calls.clear()
    runner.run("finance_receivables", as_of=AS_OF, full_refresh=True)
    assert calls == ["build_customer", "build_company", "load_finance"]


def test_stale_core_dims_is_rebuilt(platform_engine, platform_config):
    calls: list[str] = []
    runner = Runner(_registry(calls), platform_engine, platform_config)
    runner.run("core_dims", as_of=AS_OF)
    with platform_engine.begin() as conn:
        conn.execute(text("UPDATE etl_run_log SET finished_at_utc = '2020-01-01 00:00:00'"))
    calls.clear()
    runner.run("finance_receivables", as_of=AS_OF)
    assert calls[:2] == ["build_customer", "build_company"]


def test_full_all_runs_core_once_and_continues_after_a_department_fails(platform_engine, platform_config):
    calls: list[str] = []
    runner = Runner(_registry(calls, fail={"load_sales"}), platform_engine, platform_config)
    with pytest.raises(DependencyFailed, match="sales_full"):
        runner.run("full_all", as_of=AS_OF)
    assert calls.count("build_customer") == 1
    assert "load_finance" in calls  # finance still ran after sales failed
    status = dict(_rows(platform_engine, "SELECT job_name, status FROM etl_run_log"))
    assert status == {"full_all": "failed", "core_dims": "success", "sales_full": "failed", "finance_receivables": "success"}
    err = _rows(platform_engine, "SELECT error_message FROM etl_run_log WHERE job_name = 'sales_full'")[0][0]
    assert "load_sales exploded" in err


def test_failed_core_dims_stops_the_departments_that_need_it(platform_engine, platform_config):
    calls: list[str] = []
    with pytest.raises(DependencyFailed):
        Runner(_registry(calls, fail={"build_company"}), platform_engine, platform_config).run("full_all", as_of=AS_OF)
    assert "load_sales" not in calls and "load_finance" not in calls


def test_failed_task_marks_task_and_run_failed(platform_engine, platform_config):
    with pytest.raises(RuntimeError, match="exploded"):
        Runner(_registry([], fail={"build_customer"}), platform_engine, platform_config).run("core_dims", as_of=AS_OF)
    assert _rows(platform_engine, "SELECT status FROM etl_run_log") == [("failed",)]
    assert _rows(platform_engine, "SELECT task_name, status FROM etl_task_log") == [("build_customer", "failed")]


def test_declared_dataset_check_failure_fails_the_task(platform_engine, platform_config):
    with platform_engine.begin() as conn:
        conn.execute(text("CREATE TABLE fact_t (k INTEGER)"))
    r = Registry()
    r.dataset(DatasetSpec("fact_t", "sales", "mart", "sql", "fact_t", "swap", ("k",), checks=(q.min_rows("fact_t", 1),)))
    r.task(TaskSpec("load_t", lambda ctx: TaskResult(), datasets=("fact_t",)))
    r.job(JobSpec("j", "sales", tasks=("load_t",)))
    with pytest.raises(QualityCheckFailed):
        Runner(r, platform_engine, platform_config).run("j", as_of=AS_OF)
    assert _rows(platform_engine, "SELECT check_type, status FROM etl_dq_result") == [("min_rows", "fail")]
    assert _rows(platform_engine, "SELECT dataset, target_table FROM etl_dataset_registry") == [("fact_t", "fact_t")]


def test_fallbacks_are_recorded_on_the_task(platform_engine, platform_config):
    def fn(ctx):
        ctx.record_fallback("fact_sales_lines.customer_key", [501, 502, 501])
        return TaskResult(rows_loaded=3)

    r = Registry()
    r.task(TaskSpec("load", fn))
    r.job(JobSpec("j", "sales", tasks=("load",)))
    Runner(r, platform_engine, platform_config).run("j", as_of=AS_OF)
    count, detail = _rows(platform_engine, "SELECT unknown_key_fallbacks, fallback_detail FROM etl_task_log")[0]
    assert count == 3 and '"501"' in detail and '"502"' in detail
    assert _rows(platform_engine, "SELECT qa_issues_count FROM etl_run_log") == [(1,)]


def test_diagnostic_job_writes_no_run_row(platform_engine, platform_config):
    r = Registry()
    r.task(TaskSpec("check", lambda ctx: None))
    r.job(JobSpec("diag", "platform", tasks=("check",), log_run=False))
    Runner(r, platform_engine, platform_config).run("diag", as_of=AS_OF)
    assert _rows(platform_engine, "SELECT COUNT(*) FROM etl_run_log") == [(0,)]


def test_dataset_filter_runs_only_matching_tasks(platform_engine, platform_config):
    calls = []
    r = Registry()
    r.dataset(DatasetSpec("a", "sales", "raw", "sql", "a", "upsert", ("id",)))
    r.dataset(DatasetSpec("b", "sales", "raw", "sql", "b", "upsert", ("id",)))
    r.task(TaskSpec("load_a", lambda ctx: calls.append("a"), datasets=("a",)))
    r.task(TaskSpec("load_b", lambda ctx: calls.append("b"), datasets=("b",)))
    r.job(JobSpec("j", "sales", tasks=("load_a", "load_b")))
    Runner(r, platform_engine, platform_config).run("j", as_of=AS_OF, dataset="b")
    assert calls == ["b"]


def test_company_names_are_resolved_once_and_added_to_ids(platform_engine, platform_config, monkeypatch):
    class FakeOdoo:
        def __init__(self):
            self.company_ids = ()
            self.calls = 0

        def accessible_companies(self):
            self.calls += 1
            return [{"id": 1, "name": "Majaal"}, {"id": 3, "name": "TIKA"}, {"id": 4, "name": "Athena"}]

    source = FakeOdoo()

    def connect(*args, **kwargs):
        return source

    monkeypatch.setattr("etl_platform.sources.odoo.OdooSource.connect", connect)
    seen = []
    r = Registry()
    r.task(TaskSpec("resolve", lambda ctx: seen.append(ctx.odoo_company_ids()) or TaskResult()))
    r.job(JobSpec("j", "core", tasks=("resolve",)))
    cfg = replace(platform_config, odoo_company_ids=(1, 3), odoo_company_names=("Athena",))
    Runner(r, platform_engine, cfg).run("j", as_of=AS_OF)
    assert seen == [(1, 3, 4)]
    assert source.company_ids == (1, 3, 4)
    assert source.calls == 1


def test_missing_meta_schema_is_reported(platform_config, tmp_path):
    from sqlalchemy import create_engine

    from etl_platform.meta import MetaSchemaError

    bare = create_engine(f"sqlite+pysqlite:///{tmp_path / 'bare.db'}", future=True)
    r = Registry()
    r.job(JobSpec("j", "x"))
    with pytest.raises(MetaSchemaError, match="0028"):
        Runner(r, bare, platform_config).run("j")
