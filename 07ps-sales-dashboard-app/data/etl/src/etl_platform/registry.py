"""Declarative registry of datasets, tasks and jobs.

* A **dataset** describes one table: where it comes from (Odoo model / Excel sheet / SQL), its natural key,
  its incremental field, the table it lands in, how it is loaded and which quality checks guard it.
* A **task** is a function ``fn(ctx) -> TaskResult | None`` plus the tasks it depends on. Transforms called
  by tasks are pure DataFrame functions so they can be unit tested without a database.
* A **job** is a named, ordered set of tasks, optionally depending on other jobs (department jobs depend on
  ``core_dims``). ``main`` and ``full_all`` are jobs with no tasks of their own, only job dependencies.

Definitions live next to the code that implements them: ``core/jobs.py``, ``departments/<dept>/jobs.py``.
``load_definitions()`` imports them.
"""

from __future__ import annotations

import hashlib
import importlib
import json
import logging
import pkgutil
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable, Iterable, Literal, Mapping

from etl_platform.quality import CheckSpec

if TYPE_CHECKING:
    from etl_platform.runner import RunContext, TaskResult

logger = logging.getLogger(__name__)

Layer = Literal["raw", "core", "mart", "serving"]
LoadPattern = Literal["upsert", "replace", "swap", "snapshot_replace", "append"]
SourceKind = Literal["odoo", "excel", "sql", "mysql"]  # mysql: a remote MySQL source (sources/mysql_ssh.py)


class RegistryError(ValueError):
    """The registered definitions are inconsistent (unknown dependency, cycle, duplicate name...)."""


@dataclass(frozen=True)
class DatasetSpec:
    name: str
    department: str
    layer: Layer
    source: SourceKind
    target_table: str
    load_pattern: LoadPattern
    natural_key: tuple[str, ...]
    model: str | None = None  # odoo model, or the source table of a mysql dataset
    file: str | None = None  # excel (file name inside the input folder)
    sheet: str | None = None  # excel
    domain: tuple[Any, ...] = ()
    fields: tuple[str, ...] = ()
    incremental_field: str | None = None  # e.g. "write_date"
    credential_profile: str = "default"  # odoo: which ODOO_* credential set (sources/odoo.py)
    checks: tuple[CheckSpec, ...] = ()
    description: str = ""

    @property
    def source_object(self) -> str | None:
        if self.source in ("odoo", "mysql"):
            return self.model
        if self.source == "excel":
            return f"{self.file}:{self.sheet}" if self.sheet else self.file
        return None

    def definition_hash(self) -> str:
        payload = {
            "department": self.department, "layer": self.layer, "source": self.source, "target": self.target_table,
            "load": self.load_pattern, "key": list(self.natural_key), "object": self.source_object,
            "domain": repr(self.domain), "fields": list(self.fields), "incremental": self.incremental_field,
            "checks": [c.name for c in self.checks],
        }
        return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class TaskSpec:
    name: str
    fn: "Callable[[RunContext], TaskResult | None]" = field(compare=False)
    depends_on: tuple[str, ...] = ()
    datasets: tuple[str, ...] = ()  # declared checks of these datasets run after the task
    description: str = ""


@dataclass(frozen=True)
class JobSpec:
    name: str
    department: str
    tasks: tuple[str, ...] = ()
    depends_on_jobs: tuple[str, ...] = ()
    # Dependency jobs (a subset of depends_on_jobs) whose failure does not fail this job: it still runs its other
    # dependencies and tasks and ends ``partial`` (e.g. ``main`` keeps the sales refresh when finance fails).
    optional_jobs: tuple[str, ...] = ()
    mode: str = "full"  # stored in etl_run_log.mode
    # Skip this job when it is a dependency and succeeded within this many minutes (None = always run).
    # The window for core_dims comes from PlatformConfig.core_dims_fresh_minutes when this is "config".
    reuse_within_minutes: int | Literal["config"] | None = None
    # False for diagnostics (platform_selfcheck) that must never show up as a data refresh.
    log_run: bool = True
    # Umbrella jobs only. ``configurable_modules``: run only the dependency jobs listed in ETL_REFRESH_MODULES
    # (PlatformConfig.refresh_modules); the others are left out of the run, without a log row. ``isolated``: every
    # dependency is a separate module -- a failed one never stops another, even one that depends on it (finance still
    # runs on the shared lists of the previous cycle when core_dims fails); the run is 'partial' when some modules
    # failed and 'failed' only when none succeeded.
    configurable_modules: bool = False
    isolated: bool = False
    # Extra etl_run_log values (e.g. the sales order watermark) read in the SAME transaction that flips the
    # run to success, so the log describes exactly what was loaded.
    on_success: "Callable[[Any], Mapping[str, Any]] | None" = field(default=None, compare=False)
    # Read at run time (after the .env is loaded): a reason when the job is switched off in this environment (e.g. a
    # source that is not configured here), else None. As a dependency of an umbrella job it is then recorded as
    # 'skipped' and the umbrella job is not affected; run on its own it fails with that reason.
    disabled_reason: "Callable[[], str | None] | None" = field(default=None, compare=False)
    description: str = ""


class Registry:
    def __init__(self) -> None:
        self.datasets: dict[str, DatasetSpec] = {}
        self.tasks: dict[str, TaskSpec] = {}
        self.jobs: dict[str, JobSpec] = {}

    # -- registration ------------------------------------------------------------------------------
    def dataset(self, spec: DatasetSpec) -> DatasetSpec:
        self._add(self.datasets, spec.name, spec, "dataset")
        return spec

    def task(self, spec: TaskSpec) -> TaskSpec:
        self._add(self.tasks, spec.name, spec, "task")
        return spec

    def job(self, spec: JobSpec) -> JobSpec:
        self._add(self.jobs, spec.name, spec, "job")
        return spec

    @staticmethod
    def _add(store: dict[str, Any], name: str, spec: Any, kind: str) -> None:
        existing = store.get(name)
        if existing is not None and existing != spec:
            raise RegistryError(f"Duplicate {kind} name '{name}'")
        store[name] = spec

    # -- lookups ---------------------------------------------------------------------------------
    def get_job(self, name: str) -> JobSpec:
        try:
            return self.jobs[name]
        except KeyError:
            known = ", ".join(sorted(self.jobs)) or "(none registered)"
            raise RegistryError(f"Unknown job '{name}'. Registered jobs: {known}") from None

    def datasets_of_task(self, task: TaskSpec) -> list[DatasetSpec]:
        return [self.datasets[name] for name in task.datasets]

    # -- validation and ordering -----------------------------------------------------------------
    def validate(self) -> None:
        problems: list[str] = []
        for task in self.tasks.values():
            for dep in task.depends_on:
                if dep not in self.tasks:
                    problems.append(f"task '{task.name}' depends on unknown task '{dep}'")
            for ds in task.datasets:
                if ds not in self.datasets:
                    problems.append(f"task '{task.name}' references unknown dataset '{ds}'")
        for job in self.jobs.values():
            for name in job.tasks:
                if name not in self.tasks:
                    problems.append(f"job '{job.name}' lists unknown task '{name}'")
            for dep in job.depends_on_jobs:
                if dep not in self.jobs:
                    problems.append(f"job '{job.name}' depends on unknown job '{dep}'")
            for dep in job.optional_jobs:
                if dep not in job.depends_on_jobs:
                    problems.append(f"job '{job.name}' lists optional job '{dep}' that is not one of its dependencies")
        for ds in self.datasets.values():
            if not ds.natural_key:
                problems.append(f"dataset '{ds.name}' has no natural key")
            if ds.source == "odoo" and not ds.model:
                problems.append(f"odoo dataset '{ds.name}' has no model")
            if ds.source == "excel" and not ds.file:
                problems.append(f"excel dataset '{ds.name}' has no file")
        if problems:
            raise RegistryError("Invalid ETL definitions:\n  - " + "\n  - ".join(problems))
        self._check_job_cycles()
        for job in self.jobs.values():
            self.task_order(job)  # raises on task cycles

    def _check_job_cycles(self) -> None:
        state: dict[str, int] = {}

        def visit(name: str, path: list[str]) -> None:
            if state.get(name) == 1:
                raise RegistryError("Job dependency cycle: " + " -> ".join(path + [name]))
            if state.get(name) == 2:
                return
            state[name] = 1
            for dep in self.jobs[name].depends_on_jobs:
                visit(dep, path + [name])
            state[name] = 2

        for name in self.jobs:
            visit(name, [])

    def task_order(self, job: JobSpec) -> list[TaskSpec]:
        """The job's tasks in dependency order. Ties keep the order the job lists them in, so the order is
        deterministic. A dependency on a task outside the job must be satisfied by one of the job's
        dependency jobs (it ran before this job), otherwise the definition is invalid."""
        members = list(job.tasks)
        position = {name: i for i, name in enumerate(members)}
        provided_elsewhere = self._tasks_of_jobs(job.depends_on_jobs)
        indegree = {name: 0 for name in members}
        dependents: dict[str, list[str]] = {name: [] for name in members}
        for name in members:
            for dep in self.tasks[name].depends_on:
                if dep in position:
                    indegree[name] += 1
                    dependents[dep].append(name)
                elif dep not in provided_elsewhere:
                    raise RegistryError(
                        f"Task '{name}' in job '{job.name}' depends on '{dep}', which is neither in the job nor "
                        "in one of its dependency jobs"
                    )
        ready = sorted((n for n in members if indegree[n] == 0), key=position.__getitem__)
        ordered: list[str] = []
        while ready:
            current = ready.pop(0)
            ordered.append(current)
            for nxt in dependents[current]:
                indegree[nxt] -= 1
                if indegree[nxt] == 0:
                    ready.append(nxt)
                    ready.sort(key=position.__getitem__)
        if len(ordered) != len(members):
            stuck = [n for n in members if n not in ordered]
            raise RegistryError(f"Task dependency cycle in job '{job.name}' involving: {', '.join(stuck)}")
        return [self.tasks[n] for n in ordered]

    def _tasks_of_jobs(self, job_names: Iterable[str]) -> set[str]:
        out: set[str] = set()
        for name in job_names:
            job = self.jobs.get(name)
            if job is None:
                continue
            out.update(job.tasks)
            out.update(self._tasks_of_jobs(job.depends_on_jobs))
        return out


REGISTRY = Registry()

DEFINITION_PACKAGES = ("core", "departments")
_loaded = False


def load_definitions(registry: Registry = REGISTRY, packages: Iterable[str] = DEFINITION_PACKAGES) -> Registry:
    """Imports etl_platform.builtin plus every ``jobs`` module under the definition packages. Idempotent."""
    global _loaded
    if registry is REGISTRY and _loaded:
        return registry
    importlib.import_module("etl_platform.builtin")
    for package_name in packages:
        try:
            package = importlib.import_module(package_name)
        except ModuleNotFoundError:
            logger.debug("Definition package '%s' not found; skipped", package_name)
            continue
        for module in pkgutil.walk_packages(package.__path__, prefix=f"{package_name}."):
            leaf = module.name.rsplit(".", 1)[-1]
            if leaf == "jobs" and "._template" not in module.name:
                importlib.import_module(module.name)
    if registry is REGISTRY:
        _loaded = True
    return registry
