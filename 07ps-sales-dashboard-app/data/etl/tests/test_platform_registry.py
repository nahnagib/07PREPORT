"""Registry: validation, deterministic task order, job/task cycles, cross-job dependencies."""

from __future__ import annotations

import pytest

from etl_platform import quality as q
from etl_platform.registry import DatasetSpec, JobSpec, Registry, RegistryError, TaskSpec, load_definitions


def _noop(ctx):
    return None


def _reg(*tasks: TaskSpec, jobs: tuple[JobSpec, ...] = (), datasets: tuple[DatasetSpec, ...] = ()) -> Registry:
    r = Registry()
    for d in datasets:
        r.dataset(d)
    for t in tasks:
        r.task(t)
    for j in jobs:
        r.job(j)
    return r


def test_task_order_follows_dependencies_and_keeps_declared_order_for_ties():
    r = _reg(
        TaskSpec("load_fact", _noop, depends_on=("dim_b", "dim_a")),
        TaskSpec("dim_a", _noop, depends_on=("extract",)),
        TaskSpec("dim_b", _noop, depends_on=("extract",)),
        TaskSpec("extract", _noop),
        TaskSpec("checks", _noop),
        jobs=(JobSpec("j", "sales", tasks=("load_fact", "dim_b", "dim_a", "extract", "checks")),),
    )
    r.validate()
    order = [t.name for t in r.task_order(r.jobs["j"])]
    # among ready tasks, the one listed first in the job runs first
    assert order == ["extract", "dim_b", "dim_a", "load_fact", "checks"]
    # deterministic: same answer every time
    assert order == [t.name for t in r.task_order(r.jobs["j"])]


def test_task_cycle_is_rejected():
    r = _reg(TaskSpec("a", _noop, depends_on=("b",)), TaskSpec("b", _noop, depends_on=("a",)),
             jobs=(JobSpec("j", "sales", tasks=("a", "b")),))
    with pytest.raises(RegistryError, match="cycle"):
        r.validate()


def test_job_cycle_is_rejected():
    r = _reg(jobs=(JobSpec("a", "x", depends_on_jobs=("b",)), JobSpec("b", "x", depends_on_jobs=("a",))))
    with pytest.raises(RegistryError, match="Job dependency cycle"):
        r.validate()


def test_unknown_references_are_all_reported():
    r = _reg(TaskSpec("a", _noop, depends_on=("missing_task",), datasets=("missing_ds",)),
             jobs=(JobSpec("j", "x", tasks=("a", "ghost"), depends_on_jobs=("nojob",)),))
    with pytest.raises(RegistryError) as exc:
        r.validate()
    msg = str(exc.value)
    for fragment in ("missing_task", "missing_ds", "ghost", "nojob"):
        assert fragment in msg


def test_dependency_on_a_task_of_a_dependency_job_is_allowed():
    r = _reg(TaskSpec("build_dims", _noop), TaskSpec("load_sales", _noop, depends_on=("build_dims",)),
             jobs=(JobSpec("core_dims", "core", tasks=("build_dims",)),
                   JobSpec("sales_full", "sales", tasks=("load_sales",), depends_on_jobs=("core_dims",))))
    r.validate()
    assert [t.name for t in r.task_order(r.jobs["sales_full"])] == ["load_sales"]


def test_dependency_outside_job_and_its_dependencies_is_rejected():
    r = _reg(TaskSpec("build_dims", _noop), TaskSpec("load_sales", _noop, depends_on=("build_dims",)),
             jobs=(JobSpec("core_dims", "core", tasks=("build_dims",)), JobSpec("sales_full", "sales", tasks=("load_sales",))))
    with pytest.raises(RegistryError, match="neither in the job nor"):
        r.validate()


def test_duplicate_names_are_rejected_but_reregistering_the_same_spec_is_fine():
    r = Registry()
    spec = JobSpec("j", "x")
    r.job(spec)
    r.job(spec)
    with pytest.raises(RegistryError, match="Duplicate job"):
        r.job(JobSpec("j", "y"))


def test_dataset_definition_hash_changes_with_the_definition():
    a = DatasetSpec("raw_odoo_res_partner", "core", "raw", "odoo", "raw_odoo_res_partner", "upsert", ("id",), model="res.partner")
    b = DatasetSpec("raw_odoo_res_partner", "core", "raw", "odoo", "raw_odoo_res_partner", "upsert", ("id",), model="res.partner",
                    checks=(q.not_null("raw_odoo_res_partner", ["id"]),))
    assert a.definition_hash() != b.definition_hash()
    assert a.definition_hash() == DatasetSpec(**{**a.__dict__}).definition_hash()


def test_builtin_definitions_load_and_validate():
    registry = load_definitions()
    registry.validate()
    assert "platform_selfcheck" in registry.jobs
    assert registry.jobs["platform_selfcheck"].log_run is False
