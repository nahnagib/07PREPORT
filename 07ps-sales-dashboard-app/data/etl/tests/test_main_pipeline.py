"""The pipelines on SQLite with the fake Odoo: `main` = core_dims -> sales_incremental (no finance), `full_all` =
core_dims -> finance_receivables -> sales_full, and finance_receivables alone (its own 15:00 schedule).

core_dims and finance_receivables are the REAL registered jobs (real transforms and loads, migration DDL); the
umbrella jobs are the real `main` / `full_all` definitions. Only sales is a stub, so these tests run in seconds and
can fail on purpose: the real sales job is covered by test_pipeline_refactor_facts.py / test_sales_conform.py.
"""

from __future__ import annotations

import datetime as _dt
import threading
from dataclasses import replace

import pandas as pd
import pytest
from sqlalchemy import create_engine, text

from core_fixtures import PARTNER_COMPANY, write_inputs
from etl_platform import run as cli
from etl_platform.db import RunLockError, run_lock
from etl_platform.registry import REGISTRY, JobSpec, Registry, TaskSpec, load_definitions
from etl_platform.runner import STATUS_PARTIAL, Runner, TaskResult
from sqlite_schema import apply_migration_sqlite
from test_finance_receivables import FIN, SNAP, FinanceFakeOdoo

SNAPSHOT = "fact_finance_receivable_snapshot"


class FlakyOdoo(FinanceFakeOdoo):
    """Fails every read of the models in ``fail`` (an Odoo outage seen by one department only)."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fail: set[str] = set()

    def search_read_all(self, model, *args, **kwargs):
        if model in self.fail:
            raise RuntimeError(f"Odoo read of {model} timed out")
        return super().search_read_all(model, *args, **kwargs)


def _registry(sales_gate: dict) -> Registry:
    """REGISTRY's datasets, tasks, core_dims, finance_receivables, main and full_all; sales replaced by a stub that
    appends one row to stub_sales (and can block / fail on demand)."""
    load_definitions()
    r = Registry()
    r.datasets.update(REGISTRY.datasets)
    r.tasks.update(REGISTRY.tasks)

    def load_stub_sales(ctx):
        if "entered" in sales_gate:
            sales_gate["entered"].set()
            sales_gate["release"].wait(30)
        if sales_gate.get("fail"):
            raise RuntimeError("sales load exploded")
        with ctx.engine.begin() as conn:
            conn.execute(text("INSERT INTO stub_sales (run_uid) VALUES (:u)"), {"u": ctx.run_uid})
        return TaskResult(rows_extracted=1, rows_loaded=1)

    def load_stub_nps(ctx):
        if sales_gate.get("nps_fail"):
            raise RuntimeError("NPS source unreachable")
        with ctx.engine.begin() as conn:
            conn.execute(text("INSERT INTO stub_nps (run_uid) VALUES (:u)"), {"u": ctx.run_uid})
        return TaskResult(rows_extracted=1, rows_loaded=1)

    r.task(TaskSpec("load_stub_sales", load_stub_sales))
    r.task(TaskSpec("load_stub_nps", load_stub_nps))
    for name in ("core_dims", "finance_receivables", "main", "full_all"):
        r.job(REGISTRY.jobs[name])
    # the NPS source is not configured in these tests: full_all records process_nps as skipped (disabled), unless a
    # test sets gate["nps"]; then the real process_nps job (same dependencies) runs a stub task that can fail
    r.job(replace(REGISTRY.jobs["process_nps"], tasks=("load_stub_nps",),
                  disabled_reason=lambda: None if sales_gate.get("nps") else "NPS_ENABLED is not true"))
    for name, mode in (("sales_incremental", "incremental"), ("sales_full", "full")):
        r.job(JobSpec(name, "sales", tasks=("load_stub_sales",), depends_on_jobs=("core_dims",), mode=mode))
    r.validate()
    return r


@pytest.fixture
def pipe(platform_engine, platform_config, tmp_path):
    for m in ("0029_core_dimensions.sql", "0030_core_team_map.sql", "0031_sales_mart.sql", "0032_core_odoo_labels.sql",
              "0033_finance_receivables.sql", "0034_finance_receivable_scope.sql",
              "0040_finance_collections.sql", "0042_finance_collection_split.sql", "0045_collection_invoice_dates.sql"):
        apply_migration_sqlite(platform_engine, m)
    with platform_engine.begin() as conn:
        conn.execute(text("CREATE TABLE stub_sales (run_uid VARCHAR(36))"))
        conn.execute(text("CREATE TABLE stub_nps (run_uid VARCHAR(36))"))
    gate: dict = {}
    registry = _registry(gate)
    config = replace(platform_config, input_dir=write_inputs(tmp_path / "inputs"), odoo_company_ids=(1, 3))
    fake = FlakyOdoo({k: [dict(r) for r in v] for k, v in FIN.items()}, PARTNER_COMPANY)

    def runner(cfg=None, engine=None) -> Runner:
        rn = Runner(registry, engine or platform_engine, cfg or config)
        rn._sources["odoo:default"] = fake
        return rn

    def run(job="main", as_of=SNAP, cfg=None, **kw):
        rn = runner(cfg)
        uid = rn.run(job, as_of=as_of, trigger_source="test", **kw)
        return uid, rn.last_status

    return {"engine": platform_engine, "run": run, "runner": runner, "fake": fake, "gate": gate, "config": config,
            "tmp": tmp_path}


def _df(engine, sql) -> pd.DataFrame:
    with engine.connect() as conn:
        return pd.read_sql(text(sql), conn)


def _runs(engine) -> pd.DataFrame:
    return _df(engine, "SELECT run_uid, job_name, status, parent_run_uid, rows_processed, error_message FROM etl_run_log ORDER BY run_id")


def _count(engine, table) -> int:
    return int(_df(engine, f"SELECT COUNT(*) AS n FROM {table}").iloc[0, 0])


def test_main_runs_core_then_sales_and_no_finance(pipe):
    engine = pipe["engine"]
    uid, status = pipe["run"]()
    assert status == "success"
    runs = _runs(engine)
    top = runs[runs.parent_run_uid.isna()]
    assert top[["run_uid", "job_name", "status"]].values.tolist() == [[uid, "main", "success"]]
    children = runs[runs.parent_run_uid.notna()]
    assert set(children.parent_run_uid) == {uid}  # every step points at the main row
    assert children.job_name.tolist() == ["core_dims", "sales_incremental"]
    assert (children.status == "success").all()
    assert int(top.rows_processed.iloc[0]) == int(children.rows_processed.sum())  # the umbrella row sums its steps
    assert _count(engine, SNAPSHOT) == 0 and _count(engine, "stub_sales") == 1  # main takes no snapshot
    assert _count(engine, "etl_task_log WHERE job_name = 'finance_receivables'") == 0
    assert REGISTRY.jobs["main"].depends_on_jobs == ("core_dims", "sales_incremental")


def test_full_all_runs_core_then_finance_then_sales_under_one_run_id(pipe):
    engine = pipe["engine"]
    uid, status = pipe["run"]("full_all")
    assert status == "success"
    runs = _runs(engine)
    assert runs[runs.parent_run_uid.isna()].job_name.tolist() == ["full_all"]
    children = runs[runs.parent_run_uid.notna()]
    assert set(children.parent_run_uid) == {uid}
    assert children.job_name.tolist() == ["core_dims", "finance_receivables", "sales_full", "process_nps"]  # finance before sales
    assert children.status.tolist() == ["success", "success", "success", "skipped"]  # NPS switched off here: not a failure
    assert "disabled: NPS_ENABLED is not true" in children.error_message.iloc[-1]
    assert _count(engine, SNAPSHOT) == 6 and _count(engine, "stub_sales") == 1


def test_daily_finance_run_reuses_a_fresh_core_dims(pipe):
    engine = pipe["engine"]
    pipe["run"]()  # a main run at, say, 12:00 builds core_dims
    uid, status = pipe["run"]("finance_receivables")  # 15:00
    assert status == "success"
    runs = _runs(engine)
    assert runs[runs.parent_run_uid == uid].empty  # core_dims succeeded minutes ago: reused, no child row
    assert runs.job_name.tolist()[-1] == "finance_receivables"
    assert _count(engine, SNAPSHOT) == 6


def test_core_dims_failure_skips_finance_and_sales_and_fails_the_run(pipe):
    engine = pipe["engine"]
    empty = pipe["tmp"] / "no_inputs"
    empty.mkdir()
    with pytest.raises(Exception, match="core_dims"):
        pipe["run"]("full_all", cfg=replace(pipe["config"], input_dir=empty))
    runs = _runs(engine).set_index("job_name")
    assert runs.status.to_dict() == {"full_all": "failed", "core_dims": "failed", "finance_receivables": "skipped",
                                     "sales_full": "skipped", "process_nps": "skipped"}
    assert "skipped: dependency job 'core_dims' failed" in runs.loc["finance_receivables", "error_message"]
    assert _count(engine, SNAPSHOT) == 0 and _count(engine, "stub_sales") == 0
    assert _count(engine, "etl_task_log WHERE job_name IN ('finance_receivables', 'sales_full')") == 0  # never started


def test_finance_failure_leaves_full_all_partial_and_keeps_core_and_sales(pipe):
    engine, fake = pipe["engine"], pipe["fake"]
    fake.fail = {"account.move.line"}
    uid, status = pipe["run"]("full_all")
    assert status == STATUS_PARTIAL
    runs = _runs(engine).set_index("job_name")
    assert runs.status.to_dict() == {"full_all": "partial", "core_dims": "success", "finance_receivables": "failed",
                                     "sales_full": "success", "process_nps": "skipped"}
    assert runs.loc["full_all", "error_message"].startswith("finance failed: RuntimeError: Odoo read of account.move.line timed out")
    assert _count(engine, "dim_customer") > 0  # core data kept
    assert _count(engine, "stub_sales") == 1  # sales still ran after finance failed
    assert _count(engine, SNAPSHOT) == 0
    # the next finance run (15:00) retries by itself
    fake.fail = set()
    uid2, status2 = pipe["run"]("finance_receivables")
    assert status2 == "success" and uid2 != uid
    assert _count(engine, SNAPSHOT) == 6


def test_main_failure_rules(pipe):
    engine = pipe["engine"]
    pipe["gate"]["fail"] = True
    with pytest.raises(Exception, match="sales_incremental"):
        pipe["run"]()
    assert _runs(engine).set_index("job_name").status.to_dict() == {"main": "failed", "core_dims": "success", "sales_incremental": "failed"}
    pipe["gate"]["fail"] = False
    empty = pipe["tmp"] / "no_inputs"
    empty.mkdir()
    with pytest.raises(Exception, match="core_dims"):
        pipe["run"](cfg=replace(pipe["config"], input_dir=empty, core_dims_fresh_minutes=0))
    assert _runs(engine).tail(3).status.tolist() == ["failed", "failed", "skipped"]  # main, core_dims, sales_incremental


def test_sales_failure_fails_full_all_but_keeps_the_snapshot(pipe):
    engine = pipe["engine"]
    pipe["gate"]["fail"] = True
    with pytest.raises(Exception, match="sales_full"):
        pipe["run"]("full_all")
    assert _runs(engine).set_index("job_name").status.to_dict() == {
        "full_all": "failed", "core_dims": "success", "finance_receivables": "success", "sales_full": "failed",
        "process_nps": "skipped"}
    assert _count(engine, SNAPSHOT) == 6


# NPS Score runs once a night as the last, optional step of full_all (decision 2026-10-19): it must still run when
# sales or finance failed earlier in the run, and its own failure must never mark the other steps failed.
def test_nps_still_runs_when_sales_fails_earlier_in_full_all(pipe):
    engine, gate = pipe["engine"], pipe["gate"]
    gate["nps"], gate["fail"] = True, True
    with pytest.raises(Exception, match="sales_full"):
        pipe["run"]("full_all")
    assert _runs(engine).set_index("job_name").status.to_dict() == {
        "full_all": "failed", "core_dims": "success", "finance_receivables": "success", "sales_full": "failed",
        "process_nps": "success"}
    assert _count(engine, "stub_nps") == 1 and _count(engine, SNAPSHOT) == 6


def test_nps_still_runs_when_finance_fails_earlier_in_full_all(pipe):
    engine, fake = pipe["engine"], pipe["fake"]
    pipe["gate"]["nps"] = True
    fake.fail = {"account.move.line"}
    _, status = pipe["run"]("full_all")
    assert status == STATUS_PARTIAL
    runs = _runs(engine).set_index("job_name")
    assert runs.status.to_dict() == {"full_all": "partial", "core_dims": "success", "finance_receivables": "failed",
                                     "sales_full": "success", "process_nps": "success"}
    assert runs.loc["full_all", "error_message"].startswith("finance failed:")
    assert _count(engine, "stub_nps") == 1 and _count(engine, "stub_sales") == 1


def test_nps_failure_leaves_full_all_partial_and_every_other_step_successful(pipe):
    engine, gate = pipe["engine"], pipe["gate"]
    gate["nps"], gate["nps_fail"] = True, True
    uid, status = pipe["run"]("full_all")
    assert status == STATUS_PARTIAL
    runs = _runs(engine).set_index("job_name")
    assert runs.status.to_dict() == {"full_all": "partial", "core_dims": "success", "finance_receivables": "success",
                                     "sales_full": "success", "process_nps": "failed"}
    assert runs.loc["full_all", "error_message"] == "process failed: RuntimeError: NPS source unreachable"
    for job in ("core_dims", "finance_receivables", "sales_full"):
        assert pd.isna(runs.loc[job, "error_message"])
    assert _count(engine, "stub_sales") == 1 and _count(engine, SNAPSHOT) == 6  # sales and finance data kept
    assert _count(engine, "stub_nps") == 0


def test_a_second_trigger_while_a_run_holds_the_lock_is_refused(pipe):
    engine, gate = pipe["engine"], pipe["gate"]
    gate["entered"], gate["release"] = threading.Event(), threading.Event()
    first: dict = {}

    def first_run():
        try:
            first["result"] = pipe["run"]()
        except Exception as exc:  # pragma: no cover - reported by the assertion below
            first["error"] = exc

    t = threading.Thread(target=first_run)
    t.start()
    try:
        assert gate["entered"].wait(60), "first run never reached the sales step"
        # a second process: its own engine on the same database, a 1 s lock wait instead of 30 s
        other = create_engine(engine.url, future=True)
        try:
            with pytest.raises(RunLockError, match="this trigger was skipped"):
                pipe["runner"](cfg=replace(pipe["config"], lock_timeout_seconds=1), engine=other).run("finance_receivables", as_of=SNAP)
        finally:
            other.dispose()
    finally:
        gate["release"].set()
        t.join(60)
    assert "error" not in first and first["result"][1] == "success"
    runs = _runs(engine)
    assert runs[runs.parent_run_uid.isna()].job_name.tolist() == ["main"]  # only one run was recorded
    assert _count(engine, SNAPSHOT) == 0


def test_same_day_rerun_replaces_today_and_keeps_earlier_dates(pipe):
    engine = pipe["engine"]
    pipe["run"]("full_all", as_of=SNAP - _dt.timedelta(days=1))
    pipe["run"]("full_all")  # 02:00
    pipe["run"]("finance_receivables")  # 15:00 the same day
    per_day = _df(engine, f"SELECT SnapshotDateKey AS d, COUNT(*) AS n, COUNT(DISTINCT line_id) AS lines FROM {SNAPSHOT} "
                          "GROUP BY SnapshotDateKey ORDER BY 1")
    assert per_day.values.tolist() == [[20261003, 6, 6], [20261004, 6, 6]]


def _cli(monkeypatch, pipe, job="main"):
    monkeypatch.setattr(cli, "_configure_logging", lambda job: None)
    monkeypatch.setattr(cli.PlatformConfig, "from_env", classmethod(lambda cls, env_file=None: pipe["config"]))
    monkeypatch.setattr(cli, "create_platform_engine", lambda url, tz: pipe["engine"])
    monkeypatch.setattr(cli, "Runner", lambda registry, engine, config: pipe["runner"]())
    return cli.main([job, "--date", SNAP.isoformat()])


def test_cli_exit_codes(pipe, monkeypatch):
    assert _cli(monkeypatch, pipe) == cli.EXIT_SUCCESS
    pipe["fake"].fail = {"account.move.line"}
    assert _cli(monkeypatch, pipe, "full_all") == cli.EXIT_PARTIAL == 3
    assert _cli(monkeypatch, pipe, "finance_receivables") == cli.EXIT_FAILED  # alone, finance is not optional
    pipe["fake"].fail = set()
    pipe["gate"]["fail"] = True
    assert _cli(monkeypatch, pipe) == cli.EXIT_FAILED
    pipe["gate"]["fail"] = False
    with run_lock(pipe["engine"], pipe["config"].lock_name, 1):  # another run holds the lock
        monkeypatch.setattr(cli.PlatformConfig, "from_env",
                            classmethod(lambda cls, env_file=None: replace(pipe["config"], lock_timeout_seconds=1)))
        monkeypatch.setattr(cli, "Runner", lambda registry, engine, config: pipe["runner"](cfg=config))
        assert cli.main(["main", "--date", SNAP.isoformat()]) == cli.EXIT_LOCKED == 4


def test_job_definitions(pipe):
    assert REGISTRY.jobs["main"].depends_on_jobs == ("core_dims", "sales_incremental")
    assert REGISTRY.jobs["main"].optional_jobs == ()
    assert REGISTRY.jobs["full_all"].depends_on_jobs == ("core_dims", "finance_receivables", "sales_full", "process_nps")
    assert REGISTRY.jobs["full_all"].optional_jobs == ("finance_receivables", "process_nps")
    assert REGISTRY.jobs["process_nps"].depends_on_jobs == ("core_dims",)
    assert REGISTRY.jobs["finance_receivables"].depends_on_jobs == ("core_dims",)
