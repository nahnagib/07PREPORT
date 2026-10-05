"""Load patterns: upsert, snapshot replace, atomic swap, and their validation."""

from __future__ import annotations

import datetime as dt

import pandas as pd
import pytest
from sqlalchemy import text

from etl_platform.load import LoadError, atomic_swap, insert_rows, snapshot_replace, upsert


@pytest.fixture
def db(platform_engine):
    with platform_engine.begin() as conn:
        conn.execute(text("CREATE TABLE dim_thing (thing_key INTEGER NOT NULL PRIMARY KEY, name TEXT NOT NULL, note TEXT)"))
        conn.execute(text(
            "CREATE TABLE fact_snap (snapshot_date DATE NOT NULL, line_id INTEGER NOT NULL, amount NUMERIC, "
            "PRIMARY KEY (snapshot_date, line_id))"
        ))
        conn.execute(text("CREATE TABLE fact_mart (k INTEGER NOT NULL PRIMARY KEY, v NUMERIC)"))
        conn.execute(text("INSERT INTO fact_mart VALUES (1, 10), (2, 20)"))
    return platform_engine


def _rows(engine, sql):
    with engine.connect() as conn:
        return [tuple(r) for r in conn.execute(text(sql))]


# -- upsert -----------------------------------------------------------------------------------------------------
def test_upsert_inserts_then_updates_and_leaves_unsent_columns_alone(db):
    with db.begin() as conn:
        upsert(conn, "dim_thing", pd.DataFrame({"thing_key": [1, 2], "name": ["a", "b"], "note": ["n1", "n2"]}))
    with db.begin() as conn:
        upsert(conn, "dim_thing", pd.DataFrame({"thing_key": [2, 3], "name": ["B", "c"]}))
    assert _rows(db, "SELECT thing_key, name, note FROM dim_thing ORDER BY thing_key") == [(1, "a", "n1"), (2, "B", "n2"), (3, "c", None)]


def test_upsert_twice_with_same_data_is_idempotent(db):
    df = pd.DataFrame({"thing_key": [-1, 5], "name": ["Unknown", "x"]})
    for _ in range(2):
        with db.begin() as conn:
            upsert(conn, "dim_thing", df)
    assert _rows(db, "SELECT thing_key, name FROM dim_thing ORDER BY thing_key") == [(-1, "Unknown"), (5, "x")]


@pytest.mark.parametrize("df, match", [
    (pd.DataFrame({"thing_key": [1], "name": ["a"], "bogus": [1]}), "not in the table: bogus"),
    (pd.DataFrame({"thing_key": [1, 1], "name": ["a", "b"]}), "duplicate key"),
    (pd.DataFrame({"thing_key": [None], "name": ["a"]}), "NULL key"),
    (pd.DataFrame({"thing_key": [1], "note": ["x"]}), "NOT NULL column"),
])
def test_upsert_rejects_bad_frames(db, df, match):
    with db.begin() as conn, pytest.raises(LoadError, match=match):
        upsert(conn, "dim_thing", df)


def test_upsert_key_must_be_the_primary_key(db):
    with db.begin() as conn, pytest.raises(LoadError, match="must equal the table's primary key"):
        upsert(conn, "dim_thing", pd.DataFrame({"thing_key": [1], "name": ["a"]}), key=["name"])


def test_insert_rows_appends(db):
    with db.begin() as conn:
        assert insert_rows(conn, "dim_thing", pd.DataFrame({"thing_key": [7], "name": ["z"]})) == 1
    assert _rows(db, "SELECT name FROM dim_thing") == [("z",)]


# -- snapshot replace --------------------------------------------------------------------------------------------
def test_snapshot_replace_only_touches_its_partition(db):
    d1, d2 = dt.date(2026, 9, 30), dt.date(2026, 10, 1)
    with db.begin() as conn:
        snapshot_replace(conn, "fact_snap", pd.DataFrame({"line_id": [1, 2], "amount": [5, 6]}), {"snapshot_date": d1})
        snapshot_replace(conn, "fact_snap", pd.DataFrame({"line_id": [1, 2, 3], "amount": [7, 8, 9]}), {"snapshot_date": d2})
    with db.begin() as conn:  # re-run of the same day replaces it
        deleted, inserted = snapshot_replace(conn, "fact_snap", pd.DataFrame({"line_id": [9], "amount": [1]}), {"snapshot_date": d2})
    assert (deleted, inserted) == (3, 1)
    rows = _rows(db, "SELECT snapshot_date, line_id FROM fact_snap ORDER BY snapshot_date, line_id")
    assert rows == [("2026-09-30", 1), ("2026-09-30", 2), ("2026-10-01", 9)]


def test_snapshot_replace_rolls_back_with_its_transaction(db):
    d = dt.date(2026, 10, 1)
    with db.begin() as conn:
        snapshot_replace(conn, "fact_snap", pd.DataFrame({"line_id": [1], "amount": [5]}), {"snapshot_date": d})
    with pytest.raises(RuntimeError):
        with db.begin() as conn:
            snapshot_replace(conn, "fact_snap", pd.DataFrame({"line_id": [2], "amount": [6]}), {"snapshot_date": d})
            raise RuntimeError("integrity check failed")
    assert _rows(db, "SELECT line_id FROM fact_snap") == [(1,)]


def test_snapshot_replace_rejects_rows_from_another_partition(db):
    df = pd.DataFrame({"snapshot_date": [dt.date(2026, 9, 1)], "line_id": [1], "amount": [1]})
    with db.begin() as conn, pytest.raises(LoadError, match="outside partition"):
        snapshot_replace(conn, "fact_snap", df, {"snapshot_date": dt.date(2026, 10, 1)})


# -- atomic swap -------------------------------------------------------------------------------------------------
def test_atomic_swap_replaces_the_whole_table(db):
    atomic_swap(db, "fact_mart", pd.DataFrame({"k": [3, 4, 5], "v": [1, 2, 3]}))
    assert _rows(db, "SELECT k FROM fact_mart ORDER BY k") == [(3,), (4,), (5,)]
    with db.connect() as conn:
        names = {r[0] for r in conn.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))}
    assert "fact_mart__new" not in names and "fact_mart__old" not in names


def test_atomic_swap_aborted_by_check_leaves_original_and_cleans_up(db):
    seen = {}

    def reject(conn, staged):
        seen["count"] = conn.execute(text(f"SELECT COUNT(*) FROM {staged}")).scalar()
        raise RuntimeError("orphan check failed")

    with pytest.raises(RuntimeError, match="orphan"):
        atomic_swap(db, "fact_mart", pd.DataFrame({"k": [9], "v": [9]}), before_swap=reject)
    assert seen["count"] == 1  # the check saw the staged data, not the live table
    assert _rows(db, "SELECT k FROM fact_mart ORDER BY k") == [(1,), (2,)]
    with db.connect() as conn:
        names = {r[0] for r in conn.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))}
    assert "fact_mart__new" not in names


def test_atomic_swap_keeps_primary_key(db):
    atomic_swap(db, "fact_mart", pd.DataFrame({"k": [1], "v": [1]}))
    with pytest.raises(Exception):
        with db.begin() as conn:
            conn.execute(text("INSERT INTO fact_mart VALUES (1, 2)"))


# -- atomic swap of several tables ---------------------------------------------------------------------------------
def test_atomic_swap_many_swaps_all_tables_together(db):
    from etl_platform.load import atomic_swap_many

    with db.begin() as conn:
        conn.execute(text("CREATE TABLE fact_other (k INTEGER NOT NULL PRIMARY KEY, v NUMERIC)"))
        conn.execute(text("INSERT INTO fact_other VALUES (1, 1)"))
    seen = {}

    def check(conn, staged):
        seen.update(staged)

    atomic_swap_many(db, {"fact_mart": pd.DataFrame({"k": [7], "v": [7]}), "fact_other": pd.DataFrame({"k": [8, 9], "v": [8, 9]})}, before_swap=check)
    assert seen == {"fact_mart": "fact_mart__new", "fact_other": "fact_other__new"}
    assert _rows(db, "SELECT k FROM fact_mart") == [(7,)] and _rows(db, "SELECT k FROM fact_other ORDER BY k") == [(8,), (9,)]


def test_atomic_swap_many_failed_check_leaves_every_table_untouched(db):
    from etl_platform.load import atomic_swap_many

    with db.begin() as conn:
        conn.execute(text("CREATE TABLE fact_other (k INTEGER NOT NULL PRIMARY KEY, v NUMERIC)"))
        conn.execute(text("INSERT INTO fact_other VALUES (1, 1)"))

    def reject(conn, staged):
        raise RuntimeError("orphan check failed")

    with pytest.raises(RuntimeError, match="orphan"):
        atomic_swap_many(db, {"fact_mart": pd.DataFrame({"k": [7], "v": [7]}), "fact_other": pd.DataFrame({"k": [8], "v": [8]})}, before_swap=reject)
    assert _rows(db, "SELECT k FROM fact_mart ORDER BY k") == [(1,), (2,)]
    assert _rows(db, "SELECT k FROM fact_other") == [(1,)]
    with db.connect() as conn:
        names = {r[0] for r in conn.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))}
    assert not {n for n in names if n.endswith(("__new", "__old"))}
