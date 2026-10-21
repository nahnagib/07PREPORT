"""Phase B step 1: the sales build from the mirror (skip rules, changed-row writes to shd_* / live), the live-vs-shadow
comparison, ETL_SALES_MODE, and the per-module locks that keep a long sales build from blocking the other modules."""

from __future__ import annotations

import datetime as _dt
import json
import threading
from dataclasses import replace
from types import SimpleNamespace

import pandas as pd
import pytest
from sqlalchemy import create_engine, text

from departments.sales import incremental as inc
from etl_platform.config import sales_mode_from_env
from etl_platform.db import RunLockError, run_lock
from etl_platform.registry import REGISTRY, JobSpec, Registry, TaskSpec, load_definitions
from etl_platform.runner import Runner, TaskResult
from etl_platform.watermark import WatermarkStore

TABLES = ("fact_sales_lines", "dim_sales_order")
LINES_DDL = ("(SaleReportLineID INTEGER PRIMARY KEY, SalesLineGroupKey TEXT, OdooOrderID INTEGER, CompanyKey INTEGER, DateKey INTEGER, "
             "SalespersonKey INTEGER, CustomerKey INTEGER, quantity REAL, Volume REAL, line_total REAL, Value REAL, untaxed_total REAL, "
             "qty_ordered REAL, qty_delivered REAL, InvoiceValue REAL, _run_id TEXT)")
ORDER_DDL = "(SalesOrderKey INTEGER PRIMARY KEY, order_number TEXT, CompanyKey INTEGER, CustomerKey INTEGER, _run_id TEXT)"


@pytest.fixture
def marts(platform_engine, monkeypatch):
    load_definitions()  # registers every department in the platform's order (as the runner does)
    from departments.sales import jobs as sales_jobs
    with platform_engine.begin() as conn:
        for prefix in ("", "shd_"):
            conn.execute(text(f"CREATE TABLE {prefix}fact_sales_lines {LINES_DDL}"))
            conn.execute(text(f"CREATE TABLE {prefix}dim_sales_order {ORDER_DDL}"))
        for ddl in ("CREATE TABLE raw_odoo_mirror (model TEXT, company_ctx INTEGER, record_id INTEGER, parent_id INTEGER, write_date DATETIME, "
                    "payload TEXT, mirrored_at_utc DATETIME, run_uid TEXT, PRIMARY KEY (model, company_ctx, record_id))",
                    "CREATE TABLE etl_shadow_compare (compare_uid TEXT PRIMARY KEY, module TEXT, as_of_date DATE, run_uid TEXT, live_run_uid TEXT, "
                    "shadow_run_uid TEXT, started_at_utc DATETIME, finished_at_utc DATETIME, status TEXT, tables_compared INTEGER, rows_live INTEGER, "
                    "rows_shadow INTEGER, rows_only_live INTEGER, rows_only_shadow INTEGER, rows_different INTEGER, cells_compared INTEGER, "
                    "cells_diff INTEGER, excluded_orders INTEGER, summary_json TEXT, error_message TEXT)",
                    "CREATE TABLE etl_shadow_diff (compare_uid TEXT, table_name TEXT, cell_key TEXT, measure TEXT, live_value REAL, "
                    "shadow_value REAL, diff REAL, status TEXT, PRIMARY KEY (compare_uid, table_name, cell_key, measure))",
                    "CREATE TABLE dim_customer (CustomerKey INTEGER PRIMARY KEY)", "CREATE TABLE dim_company (CompanyKey INTEGER PRIMARY KEY)",
                    "CREATE TABLE dim_salesperson (SalespersonKey INTEGER PRIMARY KEY)", "CREATE TABLE dim_date (DateKey INTEGER PRIMARY KEY)",
                    "CREATE TABLE dim_sales_order_keys (x INTEGER)"):
            conn.execute(text(ddl))
        for t, col, vals in (("dim_customer", "CustomerKey", (-1, 100, 200)), ("dim_company", "CompanyKey", (-1, 1)),
                             ("dim_salesperson", "SalespersonKey", (-1, 7)), ("dim_date", "DateKey", (-1, 20261001, 20261002))):
            for v in vals:
                conn.execute(text(f"INSERT INTO {t} ({col}) VALUES (:v)"), {"v": v})
        conn.execute(text("INSERT INTO raw_odoo_mirror VALUES ('sale.order', 0, 1, NULL, '2026-10-20 08:00:00', :p, '2026-10-20 08:00:00', 'r')"),
                     {"p": json.dumps({"id": 1, "currency_id": [102, "LYD"]})})
        conn.execute(text("INSERT INTO raw_odoo_mirror VALUES ('sale.order', 0, 2, NULL, '2026-10-20 08:00:00', :p, '2026-10-20 08:00:00', 'r')"),
                     {"p": json.dumps({"id": 2, "currency_id": [102, "LYD"]})})
    monkeypatch.setattr(sales_jobs, "MART_TABLES", TABLES)
    monkeypatch.setattr(sales_jobs, "KEY_DIMS", {k: v for k, v in sales_jobs.KEY_DIMS.items()
                                                 if k in ("CustomerKey", "CompanyKey", "SalespersonKey", "DateKey")})
    return platform_engine


def _lines(**over):
    base = dict(SaleReportLineID=[11, 21], SalesLineGroupKey=["a", "b"], OdooOrderID=[1, 2], CompanyKey=[1, 1], DateKey=[20261001, 20261002],
                SalespersonKey=[7, 7], CustomerKey=[100, 200], quantity=[2.0, 5.0], Volume=[1.0, 1.0], line_total=[20.0, 50.0],
                Value=[20.0, 50.0], untaxed_total=[20.0, 50.0], qty_ordered=[2.0, 5.0], qty_delivered=[2.0, 0.0], InvoiceValue=[0.0, 0.0])
    base.update(over)
    return pd.DataFrame(base)


def _orders():
    return pd.DataFrame({"SalesOrderKey": [1, 2], "order_number": ["S1", "S2"], "CompanyKey": [1, 1], "CustomerKey": [100, 200]})


class FakeQuality:
    def __init__(self):
        self.specs = []

    def evaluate(self, specs, conn, task_name=None, table_overrides=None):
        from etl_platform import quality as q

        self.specs += list(specs)
        return [q.CheckResult(s.name, s.kind, s.table, s.severity, passed=True, observed=None, details={}) for s in specs] \
            if hasattr(q, "CheckResult") and "passed" in getattr(q.CheckResult, "__dataclass_fields__", {}) else []


def _ctx(engine, tmp_path, run_uid="run-1", **state):
    cfg = SimpleNamespace(business_timezone="Africa/Tripoli", input_dir=tmp_path, odoo_page_size=2000, mirror_overlap_minutes=10,
                          mirror_audit_days=2)
    return SimpleNamespace(engine=engine, config=cfg, run_uid=run_uid, full_refresh=False, state=dict(state),
                           watermarks=WatermarkStore(engine), quality=FakeQuality())


def _write(engine, tmp_path, mode, lines, run_uid="run-1"):
    conformed = SimpleNamespace(tables={"fact_sales_lines": lines, "dim_sales_order": _orders()})
    ctx = _ctx(engine, tmp_path, run_uid, sales_mode=mode, conformed=conformed, build_reason="test", mirror_changed=None)
    return inc.write_sales_from_mirror(ctx), ctx


def _rows(engine, sql):
    with engine.connect() as conn:
        return [tuple(r) for r in conn.execute(text(sql))]


def test_shadow_mode_writes_the_shd_copies_and_leaves_the_live_tables_alone(marts, tmp_path):
    res, _ = _write(marts, tmp_path, "shadow", _lines())
    assert res.rows_loaded == 4
    assert _rows(marts, "SELECT COUNT(*) FROM shd_fact_sales_lines") == [(2,)] and _rows(marts, "SELECT COUNT(*) FROM fact_sales_lines") == [(0,)]
    assert res.details["targets"]["fact_sales_lines"] == "shd_fact_sales_lines"


def test_only_changed_rows_are_written_and_stamped_with_the_run(marts, tmp_path):
    _write(marts, tmp_path, "shadow", _lines(), run_uid="run-1")
    res, _ = _write(marts, tmp_path, "shadow", _lines(quantity=[2.0, 6.0]), run_uid="run-2")
    assert res.rows_loaded == 1 and res.details["tables"]["fact_sales_lines"]["updated"] == 1
    assert _rows(marts, "SELECT SaleReportLineID, _run_id FROM shd_fact_sales_lines ORDER BY 1") == [(11, "run-1"), (21, "run-2")]
    res, _ = _write(marts, tmp_path, "shadow", _lines(quantity=[2.0, 6.0]), run_uid="run-3")
    assert res.rows_loaded == 0  # the same content again: nothing written


def test_incremental_mode_writes_the_live_tables(marts, tmp_path):
    _write(marts, tmp_path, "incremental", _lines())
    assert _rows(marts, "SELECT COUNT(*) FROM fact_sales_lines") == [(2,)] and _rows(marts, "SELECT COUNT(*) FROM shd_fact_sales_lines") == [(0,)]


def test_a_failing_quality_check_writes_nothing(marts, tmp_path, monkeypatch):
    from etl_platform import quality as q

    def boom(results):
        raise q.QualityCheckFailed([])

    monkeypatch.setattr(q, "raise_for_failures", boom)
    with pytest.raises(q.QualityCheckFailed):
        _write(marts, tmp_path, "shadow", _lines())
    assert _rows(marts, "SELECT COUNT(*) FROM shd_fact_sales_lines") == [(0,)]  # the transaction rolled back


def test_build_reasons(marts, tmp_path, monkeypatch):
    ctx = _ctx(marts, tmp_path)
    monkeypatch.setattr(inc, "_last_build", lambda conn: None)
    assert inc.build_reason(ctx, "shadow") == "first build in shadow mode"
    today = _dt.datetime.now(__import__("zoneinfo").ZoneInfo("Africa/Tripoli")).date().isoformat()
    last = {"started": _dt.datetime(2026, 10, 21, 8), "mode": "shadow", "business_date": today,
            "inputs_signature": inc._inputs_signature(tmp_path), "mirror_changed": None}
    monkeypatch.setattr(inc, "_last_build", lambda conn: dict(last))
    monkeypatch.setattr(inc, "dim_changes_since", lambda conn, since: (SimpleNamespace(empty=True), {}))
    assert inc.build_reason(ctx, "shadow") is None  # nothing changed: the build ends in seconds
    assert inc.build_reason(ctx, "incremental") == "first build in incremental mode"
    (tmp_path / "SalesTeam.xlsx").write_bytes(b"x")
    assert inc.build_reason(ctx, "shadow") == "input workbook(s) changed"
    last["inputs_signature"] = inc._inputs_signature(tmp_path)
    with marts.begin() as conn:
        WatermarkStore(marts).save(WatermarkStore(marts).get(inc.MIRROR_CHANGED, conn=conn).__class__(inc.MIRROR_CHANGED, _dt.datetime(2026, 10, 21, 9)),
                                   run_uid="m", conn=conn)
    assert inc.build_reason(ctx, "shadow").startswith("Odoo records changed")
    last["mirror_changed"] = "2026-10-21 09:00:00"
    assert inc.build_reason(ctx, "shadow") is None
    last["business_date"] = "2026-10-20"
    assert inc.build_reason(ctx, "shadow").startswith("business date")


def test_legacy_mode_skips_the_build_without_touching_odoo_or_the_mirror(marts, tmp_path, monkeypatch):
    monkeypatch.setenv("ETL_SALES_MODE", "legacy")
    ctx = _ctx(marts, tmp_path)
    res = inc.build_sales_from_mirror(ctx)
    assert res.details == {"skipped": "ETL_SALES_MODE=legacy: the sales tables are built by the 5x/day job"}
    assert inc.write_sales_from_mirror(ctx).details["skipped"] == "ETL_SALES_MODE=legacy"


def test_sales_mode_is_validated(monkeypatch):
    monkeypatch.setenv("ETL_SALES_MODE", "Shadow ")
    assert sales_mode_from_env() == "shadow"
    monkeypatch.setenv("ETL_SALES_MODE", "shdow")
    with pytest.raises(ValueError, match="not one of legacy, shadow, incremental"):
        sales_mode_from_env()


# -- comparison --------------------------------------------------------------------------------------------------------------
def _fill(engine, table, df):
    df.to_sql(table, engine, if_exists="append", index=False)


def test_identical_tables_match(marts, tmp_path):
    for prefix in ("", "shd_"):
        _fill(marts, f"{prefix}fact_sales_lines", _lines(_run_id=["x", "y"] if prefix else ["p", "q"]))  # _run_id is never compared
        _fill(marts, f"{prefix}dim_sales_order", _orders())
    res = inc.shadow_compare(_ctx(marts, tmp_path))
    assert res.details["status"] == "match" and res.details["cells_diff"] == 0 and res.details["rows_different"] == 0
    # both lines are company 1 / LYD / 2026-10 / salesperson 7: one cell
    assert _rows(marts, "SELECT status, rows_live, rows_shadow, cells_compared FROM etl_shadow_compare") == [("match", 4, 4, 1)]


def test_differences_are_counted_located_and_stored(marts, tmp_path):
    _fill(marts, "fact_sales_lines", _lines())
    _fill(marts, "shd_fact_sales_lines", _lines(quantity=[2.0, 4.0]))
    _fill(marts, "dim_sales_order", _orders())
    _fill(marts, "shd_dim_sales_order", _orders().iloc[:1])
    res = inc.shadow_compare(_ctx(marts, tmp_path))
    assert res.details["status"] == "diff" and res.details["rows_different"] == 1 and res.details["rows_only_live"] == 1
    summary = json.loads(_rows(marts, "SELECT summary_json FROM etl_shadow_compare")[0][0])
    assert summary["tables"]["fact_sales_lines"]["different_columns"] == {"quantity": 1}  # where to look
    cells = _rows(marts, "SELECT cell_key, measure, live_value, shadow_value FROM etl_shadow_diff WHERE status = 'DIFF' AND cell_key <> '*'")
    assert cells == [("1|LYD|202610|7", "quantity", 7.0, 6.0)]


def test_orders_changed_during_the_comparison_are_left_out(marts, tmp_path, monkeypatch):
    _fill(marts, "fact_sales_lines", _lines())
    _fill(marts, "shd_fact_sales_lines", _lines(quantity=[2.0, 4.0]))  # order 2 differs...
    for prefix in ("", "shd_"):
        _fill(marts, f"{prefix}dim_sales_order", _orders())
    with marts.begin() as conn:  # ...because it was edited in Odoo after the 02:00 read began
        conn.execute(text("UPDATE raw_odoo_mirror SET write_date = '2026-10-21 02:30:00' WHERE record_id = 2"))
    monkeypatch.setattr(inc, "_last_run", lambda conn, job: ("live-run", _dt.datetime(2026, 10, 21, 2, 0)) if job == "sales_full" else ("shd", None))
    res = inc.shadow_compare(_ctx(marts, tmp_path))
    assert res.details["status"] == "match" and res.details["excluded_orders"] == 1


# -- per-module locks ---------------------------------------------------------------------------------------------------------
def _lock_registry(gate):
    load_definitions()
    r = Registry()

    def hold(ctx):
        gate["entered"].set()
        gate["release"].wait(30)
        return TaskResult()

    def quick(ctx):
        gate.setdefault("ran", []).append(ctx.job.name)
        return TaskResult()

    r.task(TaskSpec("hold", hold))
    r.task(TaskSpec("quick", quick))
    r.job(JobSpec("long_sales", "sales", tasks=("hold",)))
    r.job(JobSpec("finance_job", "finance", tasks=("quick",)))
    r.job(JobSpec("sales_job", "sales", tasks=("quick",)))
    r.job(JobSpec("cycle", "all", depends_on_jobs=("finance_job", "sales_job"), isolated=True))
    r.validate()
    return r


def test_a_long_sales_run_does_not_block_finance_and_the_refresh_skips_only_sales(platform_engine, platform_config):
    gate = {"entered": threading.Event(), "release": threading.Event()}
    reg = _lock_registry(gate)
    cfg = replace(platform_config, lock_timeout_seconds=1)
    t = threading.Thread(target=lambda: Runner(reg, platform_engine, cfg).run("long_sales", trigger_source="test"))
    t.start()
    try:
        assert gate["entered"].wait(30)
        other = create_engine(platform_engine.url, future=True)
        try:
            Runner(reg, other, cfg).run("finance_job", trigger_source="test")  # different module: runs at once
            with pytest.raises(RunLockError):
                Runner(reg, other, cfg).run("sales_job", trigger_source="test")  # same module: refused after the wait
            runner = Runner(reg, other, cfg)
            runner.run("cycle", trigger_source="test")  # isolated: sales skipped as locked, finance runs
            assert runner._done["sales_job"] == "skipped" and runner._done["finance_job"] == "success"
        finally:
            other.dispose()
    finally:
        gate["release"].set()
        t.join(30)
    assert gate["ran"] == ["finance_job", "finance_job"]


def test_lock_names_cover_every_module_a_job_runs(platform_engine, platform_config, monkeypatch):
    load_definitions()
    runner = Runner(REGISTRY, platform_engine, platform_config)
    runner._done = {}
    monkeypatch.setenv("ETL_SALES_MODE", "shadow")
    names = runner._lock_names(REGISTRY.jobs["full_all"])
    assert names == sorted(f"sales_pipeline_full_load:{m}" for m in ("core", "finance", "process", "sales", "sales_mirror", "sales_shadow"))
    assert runner._lock_names(REGISTRY.jobs["sales_build"]) == ["sales_pipeline_full_load:sales_shadow"]
    monkeypatch.setenv("ETL_SALES_MODE", "incremental")  # the build writes the live tables: the same lock as the 02:00 rebuild
    assert runner._lock_names(REGISTRY.jobs["sales_build"]) == ["sales_pipeline_full_load:sales"]
    assert runner._lock_wait(REGISTRY.jobs["full_all"]) == platform_config.full_lock_wait_seconds


def test_the_refresh_runs_the_mirror_and_the_5x_job_stops_in_incremental_mode(monkeypatch):
    load_definitions()
    assert REGISTRY.jobs["refresh_30m"].depends_on_jobs == ("core_dims", "sales_mirror", "finance_receivables", "process_nps")
    monkeypatch.setenv("ETL_SALES_MODE", "legacy")
    assert REGISTRY.jobs["sales_mirror"].disabled_reason() == "ETL_SALES_MODE=legacy"
    assert REGISTRY.jobs["sales_incremental"].disabled_reason() is None
    monkeypatch.setenv("ETL_SALES_MODE", "incremental")
    assert REGISTRY.jobs["sales_mirror"].disabled_reason() is None
    assert REGISTRY.jobs["sales_incremental"].disabled_reason() == "ETL_SALES_MODE=incremental"
    assert REGISTRY.jobs["sales_shadow_compare"].disabled_reason() == "ETL_SALES_MODE=incremental"
