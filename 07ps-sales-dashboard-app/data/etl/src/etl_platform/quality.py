"""Declarative data-quality checks, recorded per run in ``etl_dq_result``.

Check types
  not_null            no NULL in the given columns
  unique              no duplicate value combinations
  orphan              every fact key exists in the dimension (lists the offending ids)
  min_rows            at least N rows (e.g. "0 rows returned" for a snapshot)
  row_count_change    row count vs the last recorded value of the same check, at most X% change
  metric_change       any scalar (e.g. total open amount) vs a previous value, at most X% change
  reconciliation      two scalars agree within a tolerance
  custom_sql          a query whose result rows are the failures

Severity ``warn`` records and logs; ``fail`` makes ``raise_for_failures`` raise. ``--allow-large-change``
downgrades failing *_change checks to warnings (and says so in the result).

Evaluation and recording are separate on purpose: a task evaluates checks on the connection that holds its
load transaction (so it can roll back on failure), and the runner writes the queued results afterwards in
their own transaction, so a rolled-back load still leaves its check results behind.
"""

from __future__ import annotations

import datetime as _dt
import decimal
import logging
import math
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Sequence

from sqlalchemy import select, text
from sqlalchemy.engine import Connection, Engine

logger = logging.getLogger(__name__)

SEVERITIES = ("warn", "fail")
SAMPLE_SIZE = 20
MESSAGE_ID_LIMIT = 50


@dataclass(frozen=True, eq=False)
class CheckSpec:
    name: str
    check_type: str
    table: str | None
    severity: str = "fail"
    params: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.severity not in SEVERITIES:
            raise ValueError(f"Check '{self.name}': severity must be one of {SEVERITIES}, got '{self.severity}'")


# -- constructors ---------------------------------------------------------------------------------------
def not_null(table: str, columns: Sequence[str], *, severity: str = "fail", where: str | None = None, name: str | None = None) -> CheckSpec:
    return CheckSpec(name or f"not_null:{table}:{','.join(columns)}", "not_null", table, severity, {"columns": tuple(columns), "where": where})


def unique(table: str, columns: Sequence[str], *, severity: str = "fail", where: str | None = None, name: str | None = None) -> CheckSpec:
    return CheckSpec(name or f"unique:{table}:{','.join(columns)}", "unique", table, severity, {"columns": tuple(columns), "where": where})


def orphan(
    fact_table: str, fact_column: str, dim_table: str, dim_column: str, *,
    severity: str = "fail", where: str | None = None, name: str | None = None,
) -> CheckSpec:
    return CheckSpec(
        name or f"orphan:{fact_table}.{fact_column}->{dim_table}.{dim_column}", "orphan", fact_table, severity,
        {"fact_column": fact_column, "dim_table": dim_table, "dim_column": dim_column, "where": where},
    )


def min_rows(table: str, minimum: int = 1, *, severity: str = "fail", where: str | None = None, name: str | None = None) -> CheckSpec:
    return CheckSpec(name or f"min_rows:{table}", "min_rows", table, severity, {"minimum": int(minimum), "where": where})


def row_count_change(table: str, max_change_pct: float, *, severity: str = "fail", where: str | None = None, name: str | None = None) -> CheckSpec:
    return CheckSpec(name or f"row_count_change:{table}", "row_count_change", table, severity, {"max_change_pct": float(max_change_pct), "where": where})


def metric_change(
    name: str, sql: str, max_change_pct: float, *, previous_sql: str | None = None, table: str | None = None,
    severity: str = "fail", params: Mapping[str, Any] | None = None,
) -> CheckSpec:
    """``sql`` returns the current scalar. ``previous_sql`` returns the comparison value; without it the last
    recorded observed value of this check is used."""
    return CheckSpec(name, "metric_change", table, severity, {"sql": sql, "previous_sql": previous_sql, "max_change_pct": float(max_change_pct), "bind": dict(params or {})})


def reconciliation(
    name: str, left_sql: str, right_sql: str, *, tolerance: float = 0.0, table: str | None = None,
    severity: str = "fail", params: Mapping[str, Any] | None = None,
) -> CheckSpec:
    return CheckSpec(name, "reconciliation", table, severity, {"left_sql": left_sql, "right_sql": right_sql, "tolerance": float(tolerance), "bind": dict(params or {})})


def custom_sql(name: str, sql: str, *, table: str | None = None, severity: str = "fail", params: Mapping[str, Any] | None = None) -> CheckSpec:
    return CheckSpec(name, "custom_sql", table, severity, {"sql": sql, "bind": dict(params or {})})


# -- results ---------------------------------------------------------------------------------------------
@dataclass
class CheckResult:
    spec: CheckSpec
    status: str  # pass | warn | fail
    observed_value: float | None = None
    threshold: float | None = None
    failing_rows: int | None = None
    sample: list[Any] | None = None
    message: str = ""
    target_table: str | None = None

    @property
    def failed(self) -> bool:
        return self.status == "fail"


class QualityCheckFailed(RuntimeError):
    def __init__(self, results: Sequence[CheckResult]) -> None:
        self.results = list(results)
        lines = [f"{r.spec.name}: {r.message}" for r in self.results]
        super().__init__("Data-quality check(s) failed:\n  - " + "\n  - ".join(lines))


def raise_for_failures(results: Iterable[CheckResult]) -> None:
    failed = [r for r in results if r.failed]
    if failed:
        raise QualityCheckFailed(failed)


def _json_safe(value: Any) -> Any:
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, (_dt.date, _dt.datetime)):
        return value.isoformat()
    if hasattr(value, "item"):  # numpy scalars
        return value.item()
    return value


def _scalar_float(value: Any) -> float | None:
    if value is None:
        return None
    return float(value)


# -- runner ----------------------------------------------------------------------------------------------
class QualityRunner:
    def __init__(self, engine: Engine, run_uid: str, job_name: str, *, allow_large_change: bool = False) -> None:
        self.engine = engine
        self.run_uid = run_uid
        self.job_name = job_name
        self.allow_large_change = allow_large_change
        self._pending: list[tuple[str | None, CheckResult]] = []

    def evaluate(
        self, checks: Iterable[CheckSpec], conn: Connection | None = None, *, task_name: str | None = None,
        table_overrides: Mapping[str, str] | None = None,
    ) -> list[CheckResult]:
        """Evaluates the checks (on ``conn`` if given) and queues the results for ``flush``.

        ``table_overrides`` maps a logical table to the physical one to check, e.g. a swap load checks
        ``fact_x__new`` before it replaces ``fact_x``."""
        overrides = dict(table_overrides or {})
        results: list[CheckResult] = []
        if conn is None:
            with self.engine.connect() as own:
                for spec in checks:
                    results.append(self._evaluate_one(own, spec, overrides))
        else:
            for spec in checks:
                results.append(self._evaluate_one(conn, spec, overrides))
        for result in results:
            self._pending.append((task_name, result))
            log = logger.error if result.failed else (logger.warning if result.status == "warn" else logger.info)
            log("DQ %s [%s] %s: %s", result.status.upper(), result.spec.check_type, result.spec.name, result.message)
        return results

    def flush(self) -> int:
        """Writes queued results to etl_dq_result in their own transaction. Returns the number written."""
        from etl_platform.meta import etl_dq_result

        if not self._pending:
            return 0
        now = _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None)
        rows = [
            {
                "run_uid": self.run_uid,
                "job_name": self.job_name,
                "task_name": task_name,
                "check_name": r.spec.name[:160],
                "check_type": r.spec.check_type,
                "severity": r.spec.severity,
                "target_table": r.target_table,
                "status": r.status,
                "observed_value": r.observed_value,
                "threshold": r.threshold,
                "failing_rows": r.failing_rows,
                "sample": _json_safe(r.sample) if r.sample is not None else None,
                "message": r.message[:60000],
                "checked_at_utc": now,
            }
            for task_name, r in self._pending
        ]
        with self.engine.begin() as conn:
            conn.execute(etl_dq_result.insert(), rows)
        written = len(rows)
        self._pending.clear()
        return written

    @property
    def pending(self) -> list[CheckResult]:
        return [r for _, r in self._pending]

    # -- evaluation per type -----------------------------------------------------------------------------
    def _evaluate_one(self, conn: Connection, spec: CheckSpec, overrides: Mapping[str, str]) -> CheckResult:
        q = conn.dialect.identifier_preparer.quote
        table = overrides.get(spec.table, spec.table) if spec.table else None
        try:
            handler = getattr(self, f"_check_{spec.check_type}")
        except AttributeError:
            raise ValueError(f"Unknown check type '{spec.check_type}' in check '{spec.name}'") from None
        try:
            result = handler(conn, spec, table, q, overrides)
        except Exception as exc:  # noqa: BLE001 - a check that cannot run is itself a failure
            result = CheckResult(spec, "fail", message=f"check could not run: {exc}")
        result.target_table = table
        return result

    def _status(self, spec: CheckSpec, ok: bool) -> str:
        return "pass" if ok else spec.severity

    @staticmethod
    def _where(where: str | None, alias: str | None = None) -> str:
        return f" WHERE ({where})" if where else ""

    def _check_not_null(self, conn, spec, table, q, overrides) -> CheckResult:
        cols = spec.params["columns"]
        cond = " OR ".join(f"{q(c)} IS NULL" for c in cols)
        where = spec.params.get("where")
        sql = f"SELECT COUNT(*) FROM {q(table)} WHERE ({cond})" + (f" AND ({where})" if where else "")
        n = int(conn.execute(text(sql)).scalar_one())
        msg = "no NULLs" if n == 0 else f"{n} row(s) with NULL in {', '.join(cols)}"
        return CheckResult(spec, self._status(spec, n == 0), observed_value=n, threshold=0, failing_rows=n, message=msg)

    def _check_unique(self, conn, spec, table, q, overrides) -> CheckResult:
        cols = ", ".join(q(c) for c in spec.params["columns"])
        sql = (
            f"SELECT {cols}, COUNT(*) AS n FROM {q(table)}{self._where(spec.params.get('where'))} "
            f"GROUP BY {cols} HAVING COUNT(*) > 1 ORDER BY {cols}"
        )
        rows = conn.execute(text(sql)).fetchall()
        sample = [list(r) for r in rows[:SAMPLE_SIZE]]
        msg = "unique" if not rows else f"{len(rows)} duplicated key value(s), e.g. {sample[:5]}"
        return CheckResult(spec, self._status(spec, not rows), observed_value=len(rows), threshold=0, failing_rows=len(rows), sample=sample or None, message=msg)

    def _check_orphan(self, conn, spec, table, q, overrides) -> CheckResult:
        p = spec.params
        dim = overrides.get(p["dim_table"], p["dim_table"])
        where = p.get("where")
        sql = (
            f"SELECT f.{q(p['fact_column'])} AS k, COUNT(*) AS n FROM {q(table)} f "
            f"LEFT JOIN {q(dim)} d ON f.{q(p['fact_column'])} = d.{q(p['dim_column'])} "
            f"WHERE d.{q(p['dim_column'])} IS NULL" + (f" AND ({where})" if where else "") +
            f" GROUP BY f.{q(p['fact_column'])} ORDER BY f.{q(p['fact_column'])}"
        )
        rows = conn.execute(text(sql)).fetchall()
        total = int(sum(r[1] for r in rows))
        ids = [_json_safe(r[0]) for r in rows]
        if not rows:
            msg = f"every {table}.{p['fact_column']} exists in {dim}.{p['dim_column']}"
        else:
            shown = ", ".join(str(i) for i in ids[:MESSAGE_ID_LIMIT]) + (" ..." if len(ids) > MESSAGE_ID_LIMIT else "")
            msg = f"{total} row(s) / {len(ids)} key(s) in {table}.{p['fact_column']} missing from {dim}.{p['dim_column']}: {shown}"
        return CheckResult(spec, self._status(spec, not rows), observed_value=len(ids), threshold=0, failing_rows=total, sample=ids[:SAMPLE_SIZE] or None, message=msg)

    def _check_min_rows(self, conn, spec, table, q, overrides) -> CheckResult:
        n = int(conn.execute(text(f"SELECT COUNT(*) FROM {q(table)}{self._where(spec.params.get('where'))}")).scalar_one())
        minimum = spec.params["minimum"]
        ok = n >= minimum
        return CheckResult(spec, self._status(spec, ok), observed_value=n, threshold=minimum, message=f"{n} row(s), minimum {minimum}")

    def _check_row_count_change(self, conn, spec, table, q, overrides) -> CheckResult:
        current = float(conn.execute(text(f"SELECT COUNT(*) FROM {q(table)}{self._where(spec.params.get('where'))}")).scalar_one())
        previous = self._previous_observed(conn, spec.name)
        return self._change_result(spec, current, previous, "row count")

    def _check_metric_change(self, conn, spec, table, q, overrides) -> CheckResult:
        bind = spec.params.get("bind") or {}
        current = _scalar_float(conn.execute(text(spec.params["sql"]), bind).scalar())
        if spec.params.get("previous_sql"):
            previous = _scalar_float(conn.execute(text(spec.params["previous_sql"]), bind).scalar())
        else:
            previous = self._previous_observed(conn, spec.name)
        return self._change_result(spec, current, previous, "value")

    def _change_result(self, spec: CheckSpec, current: float | None, previous: float | None, what: str) -> CheckResult:
        limit = spec.params["max_change_pct"]
        if current is None:
            return CheckResult(spec, spec.severity, threshold=limit, message=f"current {what} is NULL")
        if previous is None:
            return CheckResult(spec, "pass", observed_value=current, threshold=limit, message=f"{what} {current:,.3f}; no previous value to compare")
        if previous == 0:
            change = 0.0 if current == 0 else math.inf
        else:
            change = abs(current - previous) / abs(previous) * 100.0
        msg = f"{what} {current:,.3f} vs previous {previous:,.3f} ({change:.1f}% change, limit {limit:.1f}%)"
        if change <= limit:
            return CheckResult(spec, "pass", observed_value=current, threshold=limit, message=msg)
        if previous == 0:
            return CheckResult(spec, "pass", observed_value=current, threshold=limit, message=msg + "; previous was 0, treated as first load")
        if self.allow_large_change:
            return CheckResult(spec, "warn", observed_value=current, threshold=limit, message=msg + "; allowed by --allow-large-change")
        return CheckResult(spec, spec.severity, observed_value=current, threshold=limit, message=msg + "; re-run with --allow-large-change if this is expected")

    def _check_reconciliation(self, conn, spec, table, q, overrides) -> CheckResult:
        bind = spec.params.get("bind") or {}
        left = _scalar_float(conn.execute(text(spec.params["left_sql"]), bind).scalar()) or 0.0
        right = _scalar_float(conn.execute(text(spec.params["right_sql"]), bind).scalar()) or 0.0
        diff = abs(left - right)
        tol = spec.params["tolerance"]
        ok = diff <= tol
        return CheckResult(spec, self._status(spec, ok), observed_value=diff, threshold=tol,
                           message=f"left {left:,.3f} vs right {right:,.3f}, difference {diff:,.3f} (tolerance {tol:,.3f})")

    def _check_custom_sql(self, conn, spec, table, q, overrides) -> CheckResult:
        rows = conn.execute(text(spec.params["sql"]), spec.params.get("bind") or {}).fetchall()
        sample = [_json_safe(list(r)) for r in rows[:SAMPLE_SIZE]]
        msg = "no failing rows" if not rows else f"{len(rows)} failing row(s), e.g. {sample[:5]}"
        return CheckResult(spec, self._status(spec, not rows), observed_value=len(rows), threshold=0, failing_rows=len(rows), sample=sample or None, message=msg)

    def _previous_observed(self, conn: Connection, check_name: str) -> float | None:
        from etl_platform.meta import etl_dq_result as t

        row = conn.execute(
            select(t.c.observed_value)
            .where(t.c.check_name == check_name[:160], t.c.status.in_(("pass", "warn")), t.c.observed_value.is_not(None))
            .order_by(t.c.checked_at_utc.desc(), t.c.dq_result_id.desc())
            .limit(1)
        ).first()
        return float(row[0]) if row else None
