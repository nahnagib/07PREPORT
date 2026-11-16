"""product_stock_period_end (migration 0079, SKU Trend): period-end detection, the ETL snapshot step, the backfill's
validation helpers (scripts/backfill_stock_period_end.py). No Odoo, no MySQL."""

from __future__ import annotations

import datetime as dt
import importlib.util
from pathlib import Path

import pytest
from departments.sales import stock_period_end as spe
from sqlalchemy import create_engine, text

D = dt.date


@pytest.mark.parametrize("day, expected", [
    (D(2026, 11, 13), ("week",)),                    # a Friday: weeks run Saturday..Friday
    (D(2026, 11, 14), ()),                            # Saturday: a week starts
    (D(2026, 11, 16), ()),
    (D(2026, 11, 30), ("month",)),                    # Monday, last day of November
    (D(2026, 2, 28), ("month",)),
    (D(2028, 2, 28), ()),                             # leap year: 29 Feb ends the month
    (D(2028, 2, 29), ("month",)),                     # leap day
    (D(2026, 7, 31), ("week", "month")),              # a Friday and a month end
    (D(2026, 12, 31), ("month", "year")),
    (D(2027, 12, 31), ("week", "month", "year")),     # a Friday 31 December
])
def test_period_ends_on(day, expected):
    assert spe.period_ends_on(day) == expected


def test_needed_period_ends_are_the_closed_periods_of_each_window_plus_the_one_before():
    ends = spe.needed_period_ends(D(2026, 11, 16))
    fridays = [d for d in ends if d.weekday() == 4]
    assert fridays[-1] == D(2026, 11, 13)             # the week before the current one (Sat 14 Nov ..)
    assert D(2026, 8, 28) in ends                       # 12th Friday back: the week before the 12-week window (29 Aug ..)
    assert D(2026, 8, 21) not in ends
    assert D(2026, 10, 31) in ends and D(2025, 11, 30) in ends and D(2025, 10, 31) not in ends
    assert [d for d in ends if (d.month, d.day) == (12, 31)] == [D(2021, 12, 31), D(2022, 12, 31), D(2023, 12, 31), D(2024, 12, 31), D(2025, 12, 31)]
    assert all(d < D(2026, 11, 14) for d in ends)      # never the current, in-progress period (live on hand)
    # 12 + 12 + 5 = 29 period ends; 31 Dec 2025 ends both a month and the year: 28 dates
    assert len(ends) == 28 and ends == sorted(set(ends))
    assert all(spe.period_ends_on(d) for d in ends)


def _sqlite(snapshot_date: str | None, with_table: bool = True):
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE fact_sales_inventory_snapshot (SnapshotDate DATE, ProductCompanyKey TEXT, OnHandQty REAL)"))
        if snapshot_date:
            conn.execute(text("INSERT INTO fact_sales_inventory_snapshot VALUES (:d, 'Majaal|1', 5)"), {"d": snapshot_date})
        if with_table:
            conn.execute(text("CREATE TABLE product_stock_period_end (product_id INT, company_id INT, period_end_date DATE, qty_on_hand REAL, "
                              "source TEXT, loaded_at TEXT)"))
    return engine


def test_snapshot_step_is_a_no_op_off_a_period_end_and_before_0079():
    with _sqlite("2026-11-16").begin() as conn:
        assert spe.snapshot_period_end(conn) == {"snapshot_date": "2026-11-16", "period_end": False}
    with _sqlite("2026-11-13", with_table=False).begin() as conn:
        assert "apply migration 0079" in spe.snapshot_period_end(conn)["skipped"]
    with _sqlite(None).begin() as conn:
        assert spe.snapshot_period_end(conn) == {"skipped": "no inventory snapshot"}


def test_snapshot_step_on_a_period_end_runs_one_insert_select(monkeypatch):
    calls = []

    class Result:
        def __init__(self, value=None, rowcount=0):
            self._value, self.rowcount = value, rowcount

        def scalar(self):
            return self._value

    class Conn:
        def execute(self, stmt, params=None):
            calls.append((str(stmt), params))
            return Result(D(2026, 10, 30)) if "MAX(SnapshotDate)" in str(stmt) else Result(rowcount=1804)

    monkeypatch.setattr(spe, "inspect", lambda conn: type("I", (), {"has_table": lambda self, t: True})())
    out = spe.snapshot_period_end(Conn())
    assert out == {"snapshot_date": "2026-10-30", "period_end": ["week"], "rows": 1804}
    sql, params = calls[-1]
    assert sql.lstrip().startswith("INSERT INTO product_stock_period_end") and "SELECT" in sql and "'snapshot'" in sql
    assert "JOIN dim_sales_product_dashboard p ON p.ProductCompanyKey = s.ProductCompanyKey" in sql
    assert params == {"d": D(2026, 10, 30)}
    assert len(calls) == 2  # the snapshot date, then ONE statement


def _backfill():
    path = Path(__file__).resolve().parents[1] / "scripts" / "backfill_stock_period_end.py"
    spec = importlib.util.spec_from_file_location("backfill_stock_period_end", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_backfill_end_of_day_is_business_time_in_utc():
    assert _backfill().end_of_day_utc(D(2026, 10, 31), "Africa/Tripoli") == "2026-10-31 21:59:59"


def test_backfill_validation_counts_products_with_stock_on_either_side():
    with_stock, diffs = _backfill().compare({(1, 1): 10.0, (2, 1): 5.0, (3, 3): 0.0, (4, 3): 7.0}, {(1, 1): 10.004, (2, 1): 2.0, (5, 3): 1.0})
    assert with_stock == 4                               # 1, 2, 4, 5 (3 has none anywhere)
    assert [(k, a, b) for _, k, a, b in diffs] == [((4, 3), 7.0, 0.0), ((2, 1), 5.0, 2.0), ((5, 3), 0.0, 1.0)]


def test_backfill_reads_aggregates_only():
    calls = []

    class Client:
        def execute_kw(self, model, method, args, kwargs):
            calls.append((model, method, args, kwargs))
            return [{"product_id": [7, "Tile"], "company_id": [1, "Majaal"], "quantity": 12.5, "__count": 3},
                    {"product_id": False, "company_id": [1, "Majaal"], "quantity": 1.0}]

    assert _backfill().on_hand_at(Client(), "2026-10-31 21:59:59", [1, 3]) == {(7, 1): 12.5}
    model, method, args, kwargs = calls[0]
    assert (model, method) == ("stock.valuation.layer", "read_group")
    assert args == [[["create_date", "<=", "2026-10-31 21:59:59"]], ["quantity:sum"], ["product_id", "company_id"]]
    assert kwargs["lazy"] is False and kwargs["context"]["allowed_company_ids"] == [1, 3]
