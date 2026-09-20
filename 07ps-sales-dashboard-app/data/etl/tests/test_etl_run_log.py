"""etl_run_log: UTC handling, success/failure semantics, watermark, concurrency.

Runs against a file-backed SQLite database (an in-memory one is per-thread with SQLAlchemy's default
pool, which would hide the concurrency cases).
"""

from __future__ import annotations

import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import pytest
from sqlalchemy import create_engine, text

from config.settings import Settings
from sales_pipeline.etl_run_log import (
    STALE_RUNNING_AFTER,
    EtlRunLog,
    to_business_naive,
    to_naive_utc,
    to_utc,
    utc_now,
)
from sales_pipeline.pipeline import PowerBISalesPipeline
from sales_pipeline.product_name_mapper import ProductMappingError
from sales_pipeline.runtime import PipelineRunContext

TRIPOLI = "Africa/Tripoli"


@pytest.fixture
def engine(tmp_path: Path):
    eng = create_engine(f"sqlite+pysqlite:///{tmp_path / 'wh.db'}", future=True)
    with eng.begin() as conn:
        conn.execute(text("CREATE TABLE Fact_Orders (order_number TEXT, OrderDateTime TIMESTAMP, QuotationDate TIMESTAMP)"))
    return eng


def _seed_orders(engine, rows):
    with engine.begin() as conn:
        for number, order_dt, created_dt in rows:
            conn.execute(
                text("INSERT INTO Fact_Orders VALUES (:n, :o, :c)"),
                {"n": number, "o": order_dt, "c": created_dt},
            )


def _last_success(engine):
    with engine.connect() as conn:
        return conn.execute(
            text(
                "SELECT run_uid, finished_at_utc, watermark_order_created_utc FROM etl_run_log "
                "WHERE status = 'success' ORDER BY finished_at_utc DESC, run_id DESC LIMIT 1"
            )
        ).first()


def _finish_ok(log: EtlRunLog, started: datetime, finished: datetime):
    return log.finish_success(finished, started, rows_processed=10, odoo_extract_count=5, qa_issues_count=0)


# --- timezone normalisation -------------------------------------------------------------------


def test_same_instant_in_different_timezones_normalises_to_one_utc_value():
    tripoli_local = datetime(2026, 9, 20, 14, 42)  # naive business wall-clock, UTC+2
    utc_aware = datetime(2026, 9, 20, 12, 42, tzinfo=timezone.utc)
    new_york = datetime(2026, 9, 20, 8, 42, tzinfo=timezone(timedelta(hours=-4)))
    assert to_utc(tripoli_local, TRIPOLI) == utc_aware == to_utc(new_york, TRIPOLI)
    assert to_utc(tripoli_local, TRIPOLI).utcoffset() == timedelta(0)
    # A naive value is never silently treated as UTC when a business zone is given.
    assert to_naive_utc(tripoli_local, TRIPOLI) == datetime(2026, 9, 20, 12, 42)


def test_legacy_business_naive_round_trip():
    assert to_business_naive(datetime(2026, 9, 20, 12, 5, tzinfo=timezone.utc), TRIPOLI) == datetime(2026, 9, 20, 14, 5)


def test_dst_gap_and_overlap_do_not_raise_and_are_deterministic():
    berlin = "Europe/Berlin"
    gap = to_utc(datetime(2026, 3, 29, 2, 30), berlin)  # 02:30 does not exist (spring forward)
    overlap = to_utc(datetime(2026, 10, 25, 2, 30), berlin)  # 02:30 happens twice (fall back)
    assert gap == datetime(2026, 3, 29, 1, 30, tzinfo=timezone.utc)  # offset before the transition (+01:00)
    assert overlap == datetime(2026, 10, 25, 0, 30, tzinfo=timezone.utc)  # first occurrence (+02:00)
    # Tripoli has a fixed +02:00 offset year-round.
    assert to_utc(datetime(2026, 1, 1, 12), TRIPOLI) == to_utc(datetime(2026, 7, 1, 12), TRIPOLI) - timedelta(days=181)


def test_pipeline_run_context_is_utc_aware():
    ctx = PipelineRunContext()
    ctx.finish("SUCCESS")
    assert ctx.start_time.utcoffset() == timedelta(0)
    assert ctx.end_time is not None and ctx.end_time.utcoffset() == timedelta(0)
    assert ctx.total_duration_seconds >= 0


# --- success / failure semantics ---------------------------------------------------------------


def test_success_row_stores_utc_finish_and_target_watermark(engine):
    _seed_orders(
        engine,
        [
            ("S001", datetime(2026, 9, 20, 9, 0), datetime(2026, 9, 20, 8, 55)),
            ("S002", datetime(2026, 9, 20, 14, 42), datetime(2026, 9, 20, 14, 40)),  # Tripoli wall-clock
        ],
    )
    log = EtlRunLog(engine, TRIPOLI)
    started = utc_now() - timedelta(minutes=3)
    log.start("incremental", "sql", "scheduled-incremental", started)
    finished = utc_now()
    watermark = _finish_ok(log, started, finished)

    assert watermark.order_date_utc == datetime(2026, 9, 20, 12, 42, tzinfo=timezone.utc)
    assert watermark.order_created_utc == datetime(2026, 9, 20, 12, 40, tzinfo=timezone.utc)
    assert watermark.order_number == "S002"
    with engine.connect() as conn:
        row = conn.execute(text("SELECT * FROM etl_run_log")).mappings().one()
    assert row["status"] == "success" and row["mode"] == "incremental"
    assert row["trigger_source"] == "scheduled-incremental" and row["business_timezone"] == TRIPOLI
    assert row["rows_processed"] == 10 and row["duration_seconds"] == pytest.approx(180, abs=5)
    assert to_utc(pd.Timestamp(row["finished_at_utc"]).to_pydatetime(), "UTC") == finished.replace(microsecond=finished.microsecond)


def test_watermark_tolerates_a_fact_orders_without_quotationdate(tmp_path):
    """Fact_Orders has no QuotationDate when Fact_Sales was empty; the run must still succeed."""
    eng = create_engine(f"sqlite+pysqlite:///{tmp_path / 'nocol.db'}", future=True)
    with eng.begin() as conn:
        conn.execute(text("CREATE TABLE Fact_Orders (order_number TEXT, OrderDateTime TIMESTAMP)"))
        conn.execute(text("INSERT INTO Fact_Orders VALUES ('S001', '2026-09-20 14:42:00')"))
    log = EtlRunLog(eng, TRIPOLI)
    started = utc_now() - timedelta(minutes=1)
    log.start("incremental", "sql", "manual", started)
    watermark = _finish_ok(log, started, utc_now())
    assert watermark.order_created_utc is None
    assert watermark.order_date_utc == datetime(2026, 9, 20, 12, 42, tzinfo=timezone.utc)
    assert _last_success(eng) is not None


def test_failed_run_never_updates_last_refresh(engine):
    _seed_orders(engine, [("S001", datetime(2026, 9, 20, 9, 0), datetime(2026, 9, 20, 9, 0))])
    good = EtlRunLog(engine, TRIPOLI)
    t0 = utc_now() - timedelta(hours=2)
    good.start("full", "sql", "manual", t0)
    _finish_ok(good, t0, t0 + timedelta(minutes=10))
    before = _last_success(engine)

    bad = EtlRunLog(engine, TRIPOLI)
    t1 = utc_now() - timedelta(minutes=5)
    bad.start("incremental", "sql", "scheduled-incremental", t1)
    bad.finish_failed(utc_now(), t1, "validate_config_and_inputs: Missing required input files")

    assert _last_success(engine) == before
    with engine.connect() as conn:
        failed = conn.execute(text("SELECT * FROM etl_run_log WHERE status = 'failed'")).mappings().one()
    assert failed["watermark_order_created_utc"] is None and failed["watermark_order_date_utc"] is None
    assert "Missing required input files" in failed["error_message"]


def test_run_that_failed_after_loading_records_the_watermark_but_still_is_not_a_refresh(engine):
    _seed_orders(engine, [("S009", datetime(2026, 9, 20, 14, 42), datetime(2026, 9, 20, 14, 40))])
    log = EtlRunLog(engine, TRIPOLI)
    t1 = utc_now() - timedelta(minutes=5)
    log.start("incremental", "sql", "scheduled-incremental", t1)
    log.finish_failed(utc_now(), t1, "validate_sales_freshness failed", data_loaded=True)

    assert _last_success(engine) is None  # a failed run is never a refresh
    with engine.connect() as conn:
        row = conn.execute(text("SELECT status, watermark_order_created_utc, watermark_order_number FROM etl_run_log")).one()
    assert row[0] == "failed" and row[2] == "S009"
    assert to_utc(pd.Timestamp(row[1]).to_pydatetime(), "UTC") == datetime(2026, 9, 20, 12, 40, tzinfo=timezone.utc)


def test_running_rows_do_not_count_as_a_refresh_and_stale_ones_are_abandoned(engine):
    log = EtlRunLog(engine, TRIPOLI)
    log.start("incremental", "sql", "manual", utc_now())
    assert _last_success(engine) is None

    stale_start = utc_now() - STALE_RUNNING_AFTER - timedelta(minutes=1)
    with engine.begin() as conn:
        conn.execute(text("UPDATE etl_run_log SET started_at_utc = :t"), {"t": to_naive_utc(stale_start)})
    EtlRunLog(engine, TRIPOLI).start("incremental", "sql", "manual", utc_now())
    with engine.connect() as conn:
        statuses = sorted(r[0] for r in conn.execute(text("SELECT status FROM etl_run_log")))
    assert statuses == ["failed", "running"]


def test_concurrent_runs_each_get_their_own_row_and_last_success_follows_finish_time(engine):
    _seed_orders(engine, [("S001", datetime(2026, 9, 20, 9, 0), datetime(2026, 9, 20, 9, 0))])
    logs = [EtlRunLog(engine, TRIPOLI) for _ in range(4)]
    base = utc_now() - timedelta(hours=1)
    errors: list[Exception] = []

    def run(index: int, log: EtlRunLog) -> None:
        try:
            log.start("incremental", "sql", f"t{index}", base)
            # Later index finishes later, regardless of thread scheduling.
            _finish_ok(log, base, base + timedelta(minutes=index + 1))
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=run, args=(i, log)) for i, log in enumerate(logs)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors
    with engine.connect() as conn:
        assert conn.execute(text("SELECT COUNT(DISTINCT run_uid) FROM etl_run_log WHERE status='success'")).scalar_one() == 4
    assert _last_success(engine).run_uid == logs[3].run_uid


# --- pipeline integration ----------------------------------------------------------------------


def _settings(tmp_path: Path, **overrides) -> Settings:
    base = dict(
        odoo_url="x",
        odoo_db="x",
        odoo_user="x",
        odoo_api_key="x",
        input_dir=tmp_path / "input",
        output_dir=tmp_path / "out",
        output_file="out.xlsx",
        batch_size=100,
        timezone=TRIPOLI,
        assume_utc_for_naive=False,
        db_url=f"sqlite+pysqlite:///{tmp_path / 'run.db'}",
    )
    base.update(overrides)
    return Settings(**base)


def test_run_failing_at_validate_config_and_inputs_is_recorded_as_failed(tmp_path):
    (tmp_path / "input").mkdir()  # exists but empty -> InputValidationError in step one
    pipeline = PowerBISalesPipeline(_settings(tmp_path))
    with pytest.raises(Exception, match="Input validation failed"):
        pipeline.run(output_mode="sql", load_mode="full")
    engine = create_engine(f"sqlite+pysqlite:///{tmp_path / 'run.db'}", future=True)
    with engine.connect() as conn:
        rows = conn.execute(text("SELECT status, error_message, watermark_order_created_utc FROM etl_run_log")).all()
    assert len(rows) == 1 and rows[0][0] == "failed"
    assert "Input validation failed" in rows[0][1] and rows[0][2] is None
    assert _last_success(engine) is None


def test_zero_product_mappings_fail_the_run_unless_explicitly_allowed(tmp_path):
    (tmp_path / "input").mkdir()
    pd.DataFrame({"OdooProductName": [None], "ProductName": [None]}).to_excel(tmp_path / "input" / "PRODUCTS.xlsx", index=False)
    with pytest.raises(ProductMappingError, match="0 mappings"):
        _ = PowerBISalesPipeline(_settings(tmp_path)).mapper
    allowed = PowerBISalesPipeline(_settings(tmp_path, allow_empty_product_mapping=True))
    assert allowed.mapper.mapping_count() == 0


# --- backfill of legacy pipeline_run_log rows ---------------------------------------------------


def _load_backfill():
    import importlib.util

    path = Path(__file__).resolve().parents[1] / "scripts" / "backfill_etl_run_log.py"
    spec = importlib.util.spec_from_file_location("backfill_etl_run_log", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_backfill_normalises_legacy_rows_using_db_created_at_not_the_ambiguous_naive_end_time():
    backfill = _load_backfill()
    # A Docker-era row: the container wrote its UTC clock (12:05) into pipeline_end_time, while the DB
    # server (Tripoli, UTC+2) stamped created_at with its own 14:05:01.
    legacy = {
        "run_id": 7,
        "pipeline_end_time": datetime(2026, 9, 20, 12, 5, 0),
        "created_at": datetime(2026, 9, 20, 14, 5, 1),
        "total_duration_minutes": 4.5,
        "status": "SUCCESS",
        "db_loaded_count": 1234,
        "odoo_extract_count": 99,
        "qa_issues_count": 0,
        "error_message": "step: SUCCESS 0.10 min",
    }
    audit = [{"created_at": datetime(2026, 9, 20, 14, 5, 0), "load_mode": "incremental", "output_mode": "sql",
              "latest_order_datetime_after": datetime(2026, 9, 20, 14, 42)}]
    out = backfill.convert_legacy_row(legacy, audit, "Africa/Tripoli", TRIPOLI)

    assert out["finished_at_utc"] == datetime(2026, 9, 20, 12, 5, 1)  # 14:05:01 Tripoli == 12:05:01 UTC
    assert out["started_at_utc"] == out["finished_at_utc"] - timedelta(minutes=4.5)
    assert out["status"] == "success" and out["mode"] == "incremental" and out["legacy_backfill"] == 1
    assert out["watermark_order_date_utc"] == datetime(2026, 9, 20, 12, 42)
    assert out["error_message"] is None
    assert backfill.inferred_naive_zone_offset_hours(legacy) == 2.0  # naive end time was UTC, i.e. 2h behind DB-local
    # Deterministic key => re-running the backfill cannot duplicate rows.
    assert out["run_uid"] == backfill.convert_legacy_row(legacy, [], "Africa/Tripoli", TRIPOLI)["run_uid"]


def test_backfill_keeps_failed_legacy_rows_failed_and_without_watermark():
    backfill = _load_backfill()
    legacy = {"run_id": 8, "pipeline_end_time": None, "created_at": datetime(2026, 9, 20, 10, 0), "total_duration_minutes": None,
              "status": "FAILED", "error_message": "boom"}
    out = backfill.convert_legacy_row(legacy, [], "Africa/Tripoli", TRIPOLI)
    assert out["status"] == "failed" and out["error_message"] == "boom" and out["watermark_order_date_utc"] is None
