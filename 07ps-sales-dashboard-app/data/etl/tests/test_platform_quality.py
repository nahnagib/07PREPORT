"""Every data-quality check type, severities, overrides, and result recording."""

from __future__ import annotations

import pytest
from sqlalchemy import text

from etl_platform import quality as q
from etl_platform.quality import QualityCheckFailed, QualityRunner, raise_for_failures


@pytest.fixture
def db(platform_engine):
    with platform_engine.begin() as conn:
        conn.execute(text("CREATE TABLE dim_customer (customer_key INTEGER PRIMARY KEY, name TEXT)"))
        conn.execute(text("INSERT INTO dim_customer VALUES (-1, 'Unknown'), (10, 'A'), (20, 'B')"))
        conn.execute(text("CREATE TABLE fact_x (line_id INTEGER, customer_key INTEGER, amount NUMERIC, due DATE)"))
        conn.execute(text("INSERT INTO fact_x VALUES (1, 10, 100, '2026-10-01'), (2, 20, 50, '2026-10-02'), (3, -1, 5, NULL)"))
    return platform_engine


def _runner(engine, **kw):
    return QualityRunner(engine, "run-1", "test_job", **kw)


def _one(engine, spec, **kw):
    return _runner(engine, **kw).evaluate([spec])[0]


def test_not_null(db):
    assert _one(db, q.not_null("fact_x", ["customer_key"])).status == "pass"
    r = _one(db, q.not_null("fact_x", ["due"]))
    assert (r.status, r.failing_rows) == ("fail", 1)


def test_unique(db):
    assert _one(db, q.unique("fact_x", ["line_id"])).status == "pass"
    with db.begin() as conn:
        conn.execute(text("INSERT INTO fact_x VALUES (1, 10, 1, '2026-10-01')"))
    r = _one(db, q.unique("fact_x", ["line_id"]))
    assert r.status == "fail" and r.sample == [[1, 2]]


def test_orphan_lists_the_missing_ids(db):
    assert _one(db, q.orphan("fact_x", "customer_key", "dim_customer", "customer_key")).status == "pass"
    with db.begin() as conn:
        conn.execute(text("INSERT INTO fact_x VALUES (4, 77, 1, '2026-10-01'), (5, 77, 1, '2026-10-01'), (6, 88, 1, '2026-10-01')"))
    r = _one(db, q.orphan("fact_x", "customer_key", "dim_customer", "customer_key"))
    assert r.status == "fail"
    assert r.failing_rows == 3 and r.sample == [77, 88]
    assert "77, 88" in r.message


def test_orphan_with_warn_severity_does_not_fail(db):
    with db.begin() as conn:
        conn.execute(text("INSERT INTO fact_x VALUES (4, 77, 1, '2026-10-01')"))
    r = _one(db, q.orphan("fact_x", "customer_key", "dim_customer", "customer_key", severity="warn"))
    assert r.status == "warn" and not r.failed
    raise_for_failures([r])  # no raise


def test_min_rows(db):
    assert _one(db, q.min_rows("fact_x", 1)).status == "pass"
    assert _one(db, q.min_rows("fact_x", 1, where="amount > 1000")).status == "fail"


def test_row_count_change_against_previous_recorded_value(db):
    spec = q.row_count_change("fact_x", 50)
    first = _runner(db)
    assert first.evaluate([spec])[0].status == "pass"  # nothing to compare yet
    first.flush()
    with db.begin() as conn:
        conn.execute(text("DELETE FROM fact_x WHERE line_id IN (1, 2)"))  # 3 -> 1 rows: -66.7%
    assert _one(db, spec).status == "fail"
    overridden = _one(db, spec, allow_large_change=True)
    assert overridden.status == "warn" and "--allow-large-change" in overridden.message


def test_metric_change_with_previous_sql(db):
    spec = q.metric_change("open_total_change", "SELECT SUM(amount) FROM fact_x", 50, previous_sql="SELECT 100")
    r = _one(db, spec)  # 155 vs 100 = +55%
    assert r.status == "fail" and r.observed_value == pytest.approx(155)
    assert _one(db, q.metric_change("ok", "SELECT SUM(amount) FROM fact_x", 60, previous_sql="SELECT 100")).status == "pass"


def test_reconciliation_tolerance(db):
    left = "SELECT SUM(amount) FROM fact_x"
    assert _one(db, q.reconciliation("rec", left, "SELECT 155.0004", tolerance=0.001)).status == "pass"
    assert _one(db, q.reconciliation("rec", left, "SELECT 150", tolerance=0.001)).status == "fail"


def test_custom_sql_rows_are_failures(db):
    r = _one(db, q.custom_sql("missing_due", "SELECT line_id FROM fact_x WHERE due IS NULL"))
    assert r.status == "fail" and r.sample == [[3]]


def test_a_check_that_cannot_run_is_a_failure(db):
    r = _one(db, q.not_null("no_such_table", ["x"]))
    assert r.status == "fail" and "could not run" in r.message


def test_table_override_checks_the_staged_table(db):
    with db.begin() as conn:
        conn.execute(text("CREATE TABLE fact_x__new AS SELECT * FROM fact_x WHERE 0"))
    r = _runner(db).evaluate([q.min_rows("fact_x", 1)], table_overrides={"fact_x": "fact_x__new"})[0]
    assert r.status == "fail" and r.target_table == "fact_x__new"


def test_results_are_recorded_even_when_the_checked_load_rolls_back(db):
    runner = _runner(db)
    with pytest.raises(QualityCheckFailed, match="orphan"):
        with db.begin() as conn:
            conn.execute(text("INSERT INTO fact_x VALUES (9, 99, 1, '2026-10-01')"))
            results = runner.evaluate([q.orphan("fact_x", "customer_key", "dim_customer", "customer_key")], conn, task_name="load")
            raise_for_failures(results)
    assert runner.flush() == 1
    with db.connect() as conn:
        row = conn.execute(text("SELECT status, check_type, task_name, failing_rows FROM etl_dq_result")).one()
        assert tuple(row) == ("fail", "orphan", "load", 1)
        assert conn.execute(text("SELECT COUNT(*) FROM fact_x WHERE line_id = 9")).scalar() == 0  # rolled back


def test_invalid_severity_is_rejected():
    with pytest.raises(ValueError, match="severity"):
        q.not_null("t", ["c"], severity="error")
