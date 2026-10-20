"""Change-detecting writes: only new or changed rows are written and stamped; deletions are reported."""

from __future__ import annotations

import datetime as dt

import pandas as pd
import pytest
from sqlalchemy import text

from etl_platform.load import replace_changed, upsert_changed

T0 = dt.datetime(2026, 10, 20, 8, 0, 0)
T1 = dt.datetime(2026, 10, 20, 8, 30, 0)


@pytest.fixture
def db(platform_engine):
    with platform_engine.begin() as conn:
        conn.execute(text("CREATE TABLE dim_c (k INTEGER NOT NULL PRIMARY KEY, name TEXT NOT NULL, rate NUMERIC, since DATE, "
                          "flag BOOLEAN, admin_note TEXT, updated_at_utc DATETIME)"))
        conn.execute(text("CREATE TABLE map_m (a INTEGER NOT NULL, b TEXT NOT NULL, target INTEGER, updated_at_utc DATETIME, "
                          "PRIMARY KEY (a, b))"))
    return platform_engine


def _rows(engine, sql):
    with engine.connect() as conn:
        return [tuple(r) for r in conn.execute(text(sql))]


def _frame(**overrides):
    base = {"k": [1, 2, 3], "name": ["a", "b", "c"], "rate": [1.5, 2.0, None],
            "since": [dt.date(2026, 1, 1), dt.date(2026, 2, 1), None], "flag": [True, False, True]}
    base.update(overrides)
    return pd.DataFrame(base)


def test_first_write_inserts_everything_and_stamps_it(db):
    with db.begin() as conn:
        cs = upsert_changed(conn, "dim_c", _frame(), now=T0)
    assert (len(cs.inserted), len(cs.updated), cs.unchanged) == (3, 0, 0)
    assert _rows(db, "SELECT k, updated_at_utc FROM dim_c ORDER BY k") == [(1, "2026-10-20 08:00:00.000000"), (2, "2026-10-20 08:00:00.000000"),
                                                                          (3, "2026-10-20 08:00:00.000000")]


def test_unchanged_rows_are_not_written_and_keep_their_stamp(db):
    with db.begin() as conn:
        upsert_changed(conn, "dim_c", _frame(), now=T0)
    with db.begin() as conn:
        # same content, but read back types differ (int vs float, date vs Timestamp, bool vs int): still no change
        cs = upsert_changed(conn, "dim_c", _frame(rate=[1.5, 2, float("nan")], since=pd.to_datetime(["2026-01-01", "2026-02-01", None]),
                                                  flag=[1, 0, 1]), now=T1)
    assert (len(cs.inserted), len(cs.updated), cs.unchanged) == (0, 0, 3)
    assert {r[1] for r in _rows(db, "SELECT k, updated_at_utc FROM dim_c")} == {"2026-10-20 08:00:00.000000"}


def test_only_the_changed_row_is_restamped(db):
    with db.begin() as conn:
        upsert_changed(conn, "dim_c", _frame(), now=T0)
    with db.begin() as conn:
        cs = upsert_changed(conn, "dim_c", _frame(name=["a", "B", "c"], k=[1, 2, 4]), now=T1)
    assert cs.updated == [(2,)] and cs.inserted == [(4,)] and cs.unchanged == 1
    assert _rows(db, "SELECT k, name, updated_at_utc FROM dim_c ORDER BY k") == [
        (1, "a", "2026-10-20 08:00:00.000000"), (2, "B", "2026-10-20 08:30:00.000000"),
        (3, "c", "2026-10-20 08:00:00.000000"),  # not in the frame: left alone by upsert_changed
        (4, "c", "2026-10-20 08:30:00.000000")]


def test_compare_columns_ignore_columns_owned_elsewhere(db):
    with db.begin() as conn:
        upsert_changed(conn, "dim_c", _frame(), now=T0)
        conn.execute(text("UPDATE dim_c SET admin_note = 'kept' WHERE k = 1"))
    with db.begin() as conn:
        cs = upsert_changed(conn, "dim_c", _frame(admin_note=[None, None, None]), update_columns=["name", "rate", "since", "flag"], now=T1)
    assert cs.written == 0
    assert _rows(db, "SELECT admin_note FROM dim_c WHERE k = 1") == [("kept",)]


def test_replace_changed_mirrors_the_frame_and_reports_deleted_keys(db):
    m = pd.DataFrame({"a": [1, 1, 2], "b": ["x", "y", "x"], "target": [10, 11, 20]})
    with db.begin() as conn:
        replace_changed(conn, "map_m", m, now=T0)
    with db.begin() as conn:
        cs = replace_changed(conn, "map_m", pd.DataFrame({"a": [1, 2, 3], "b": ["x", "x", "z"], "target": [10, 21, 30]}), now=T1)
    assert cs.deleted == [(1, "y")] and cs.updated == [(2, "x")] and cs.inserted == [(3, "z")] and cs.unchanged == 1
    assert _rows(db, "SELECT a, b, target, updated_at_utc FROM map_m ORDER BY a, b") == [
        (1, "x", 10, "2026-10-20 08:00:00.000000"), (2, "x", 21, "2026-10-20 08:30:00.000000"), (3, "z", 30, "2026-10-20 08:30:00.000000")]
    summary = cs.summary()
    assert summary["deleted"] == 1 and summary["deleted_keys"] == [[1, "y"]]


def test_replace_changed_with_an_empty_frame_deletes_everything(db):
    with db.begin() as conn:
        replace_changed(conn, "map_m", pd.DataFrame({"a": [1], "b": ["x"], "target": [1]}), now=T0)
    with db.begin() as conn:
        cs = replace_changed(conn, "map_m", pd.DataFrame({"a": pd.Series([], dtype="int64"), "b": pd.Series([], dtype=str),
                                                          "target": pd.Series([], dtype="int64")}), now=T1)
    assert cs.deleted == [(1, "x")]
    assert _rows(db, "SELECT COUNT(*) FROM map_m") == [(0,)]
