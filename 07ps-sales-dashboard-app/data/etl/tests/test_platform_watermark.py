"""Watermarks: (write_date, id) ordering, overlap, persistence in the load transaction."""

from __future__ import annotations

import datetime as dt

import pytest

from etl_platform.watermark import Watermark, WatermarkStore, advance, incremental_since, parse_odoo_datetime

T0 = dt.datetime(2026, 10, 1, 8, 0, 0)


def test_empty_watermark_means_full_extract():
    assert incremental_since(Watermark("ds"), 300) is None


def test_since_subtracts_the_overlap():
    assert incremental_since(Watermark("ds", T0, 5), 300) == T0 - dt.timedelta(minutes=5)


def test_advance_takes_the_max_write_date_then_id():
    wm = advance(Watermark("ds"), [
        {"id": 9, "write_date": "2026-10-01 08:00:00"},
        {"id": 3, "write_date": "2026-10-01 09:00:00"},
        {"id": 4, "write_date": "2026-10-01 09:00:00"},
        {"id": 50, "write_date": False},
    ])
    assert (wm.write_date, wm.last_id) == (dt.datetime(2026, 10, 1, 9), 4)


def test_advance_never_moves_backwards():
    wm = Watermark("ds", T0, 100)
    assert advance(wm, [{"id": 1, "write_date": "2026-09-01 00:00:00"}]) == wm
    assert advance(wm, []) == wm


@pytest.mark.parametrize("raw", ["2026-10-01 08:00:00", "2026-10-01 08:00:00.123", "2026-10-01T08:00:00", T0])
def test_parse_odoo_datetime_formats(raw):
    assert parse_odoo_datetime(raw).replace(microsecond=0) == T0


def test_store_roundtrip_and_reset(platform_engine):
    store = WatermarkStore(platform_engine)
    assert store.get("raw_odoo_res_partner").is_empty
    with platform_engine.begin() as conn:
        store.save(Watermark("raw_odoo_res_partner", T0, 42), run_uid="r1", conn=conn, full_refresh=True)
    got = store.get("raw_odoo_res_partner")
    assert (got.write_date, got.last_id) == (T0, 42) and got.last_full_refresh is not None
    with platform_engine.begin() as conn:
        store.save(Watermark("raw_odoo_res_partner", T0 + dt.timedelta(hours=1), 7, got.last_full_refresh), run_uid="r2", conn=conn)
    assert store.get("raw_odoo_res_partner").last_id == 7
    with platform_engine.begin() as conn:
        store.reset("raw_odoo_res_partner", conn=conn)
    assert store.get("raw_odoo_res_partner").is_empty


def test_watermark_does_not_move_when_the_load_rolls_back(platform_engine):
    store = WatermarkStore(platform_engine)
    with pytest.raises(RuntimeError):
        with platform_engine.begin() as conn:
            store.save(Watermark("ds", T0, 1), run_uid="r", conn=conn)
            raise RuntimeError("load failed")
    assert store.get("ds").is_empty
