"""NPS Detractor Follow-up: process_nps adds a case per detractor (idempotent, cut-over by NPS_FOLLOWUP_START), flags
source changes, and never writes a manual field (departments/process/followup.py, migrations 0052, 0066).

The tests run on the 0066 shape (column `stage`, `status` GENERATED from it) unless they say otherwise; `fu52` is the
table as 0052 left it, for the fallback that writes the stage into `status` until 0066 is applied."""

from __future__ import annotations

import pytest
from sqlalchemy import text

from sqlite_schema import MIGRATIONS, apply_migration_sqlite
from test_process_nps import BELOW, MET, SOURCE_FULL, SOURCE_LOW, SYNC, FakeNpsSource, _df, _src_row, npsjob  # noqa: F401

CASES = ("SELECT response_id, rated_at_local, stage, status, source_changed, source_change_reason, notes, version "
         "FROM nps_followup_case ORDER BY response_id")

# migration 0066 in SQLite (which can't drop a CHECK or rename one): the case table rebuilt in the 0066 shape. The
# status CASE is the migration's own text.
_STATUS_CASE = ("CASE WHEN stage IN ('NEW', 'CONTACTED', 'IN_PROGRESS') THEN 'OPEN' WHEN stage = 'RESOLVED' THEN 'CLOSE' "
                "WHEN stage = 'HISTORICAL' THEN NULL ELSE 'DISPUTED' END")
_CASE_0066 = f"""CREATE TABLE nps_followup_case (
  case_id INTEGER PRIMARY KEY AUTOINCREMENT, response_id BIGINT NOT NULL UNIQUE, rated_at_local DATETIME NULL,
  stage VARCHAR(20) NOT NULL DEFAULT 'NEW', status VARCHAR(10) GENERATED ALWAYS AS ({_STATUS_CASE}) STORED,
  reason_id BIGINT NULL, reason_note VARCHAR(200) NULL, owner_user_id INT NULL, owner_name VARCHAR(120) NULL,
  contacted_at DATETIME NULL, resolved_at DATETIME NULL, rejected_at DATETIME NULL, root_cause TEXT NULL, action_taken TEXT NULL,
  notes TEXT NULL, source_changed BOOLEAN NOT NULL DEFAULT FALSE, source_changed_at DATETIME NULL, source_change_reason VARCHAR(200) NULL,
  version INT NOT NULL DEFAULT 1, created_by INT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_by INT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_nps_followup_stage CHECK (stage IN ('HISTORICAL', 'NEW', 'CONTACTED', 'IN_PROGRESS', 'RESOLVED', 'REJECTED')),
  CONSTRAINT chk_nps_followup_resolved CHECK ((stage = 'RESOLVED' AND resolved_at IS NOT NULL) OR (stage <> 'RESOLVED' AND resolved_at IS NULL)),
  CONSTRAINT chk_nps_followup_rejected CHECK ((stage = 'REJECTED' AND rejected_at IS NOT NULL) OR (stage <> 'REJECTED' AND rejected_at IS NULL)),
  CONSTRAINT chk_nps_followup_resolved_after CHECK (resolved_at IS NULL OR rated_at_local IS NULL OR resolved_at >= rated_at_local),
  CONSTRAINT chk_nps_followup_contacted_after CHECK (contacted_at IS NULL OR rated_at_local IS NULL OR contacted_at >= rated_at_local))"""


def _apply_0066(engine) -> None:
    with open(MIGRATIONS / "0066_nps_followup_stage_status.sql", encoding="utf-8") as f:
        assert _STATUS_CASE.replace("'", "''") in f.read(), "the test's status CASE must be the migration's"
    with engine.begin() as conn:
        conn.execute(text("DROP TABLE nps_followup_case"))
        conn.execute(text(_CASE_0066))


@pytest.fixture
def fu52(npsjob, monkeypatch):
    engine, run, source = npsjob
    apply_migration_sqlite(engine, "0052_nps_detractor_followup.sql")
    monkeypatch.setenv("NPS_FOLLOWUP_START", "2026-10-04")
    return engine, run, source


@pytest.fixture
def fu(fu52):
    _apply_0066(fu52[0])
    return fu52


def _details(engine) -> str:
    return _df(engine, "SELECT details FROM etl_task_log WHERE task_name = 'load_nps' ORDER BY rowid DESC").details.iloc[0]


def test_one_case_per_detractor_new_from_the_cutover_and_idempotent(fu):
    engine, run, _ = fu
    run()
    run()
    cases = _df(engine, CASES)
    # source row 3 is the only detractor; rated 08:00 UTC = 10:00 Tripoli on 4 Oct, the cut-over day
    assert cases.response_id.tolist() == [3] and cases.stage.tolist() == ["NEW"] and cases.status.tolist() == ["OPEN"]
    assert str(cases.rated_at_local.iloc[0]).startswith("2026-10-04 10:00")
    assert cases.source_changed.tolist() == [0] and cases.version.tolist() == [1]
    assert '"created": 0' in _details(engine)  # the second run added nothing
    assert _df(engine, "SELECT COUNT(*) AS n FROM nps_followup_audit").n.iloc[0] == 0


def test_detractors_before_the_cutover_are_historical(fu, monkeypatch):
    engine, run, _ = fu
    monkeypatch.setenv("NPS_FOLLOWUP_START", "2026-10-05")
    run()
    cases = _df(engine, CASES)
    # Historical is a stage without a status
    assert cases.stage.tolist() == ["HISTORICAL"] and cases.status.isna().all()


def test_manual_fields_survive_every_reload(fu):
    engine, run, _ = fu
    run()
    with engine.begin() as conn:
        conn.execute(text("UPDATE nps_followup_case SET stage = 'CONTACTED', contacted_at = '2026-10-05 09:00:00', "
                          "notes = 'called the customer', owner_user_id = 7, version = 2"))
    run()
    row = _df(engine, "SELECT stage, status, contacted_at, notes, owner_user_id, version FROM nps_followup_case").iloc[0]
    assert (row.stage, row.status, str(row.contacted_at)[:16], row.notes, int(row.owner_user_id), int(row.version)) == (
        "CONTACTED", "OPEN", "2026-10-05 09:00", "called the customer", 7, 2)


def test_a_rating_that_stops_being_a_detractor_or_leaves_the_source_is_flagged_kept_and_warned(fu):
    engine, run, source = fu
    run()
    with engine.begin() as conn:
        conn.execute(text("UPDATE nps_followup_case SET notes = 'kept'"))
    # the customer's rating is now "met expectations"
    changed = [r if r["id"] != 3 else _src_row(3, MET, code="WH/OUT/2") for r in SOURCE_FULL]
    source["fake"] = FakeNpsSource(changed, SOURCE_LOW, SYNC)
    run()
    case = _df(engine, CASES).iloc[0]
    assert (case.stage, int(case.source_changed), case.source_change_reason, case.notes) == (
        "NEW", 1, "rating is no longer a detractor", "kept")
    dq = _df(engine, "SELECT check_name, status, failing_rows FROM etl_dq_result ORDER BY rowid DESC").drop_duplicates("check_name").set_index("check_name")
    assert dq.loc["warn:nps_followup_source_changed", "status"] == "warn" and int(dq.loc["warn:nps_followup_source_changed", "failing_rows"]) == 1
    # then it leaves the source altogether
    source["fake"] = FakeNpsSource([r for r in SOURCE_FULL if r["id"] != 3], [r for r in SOURCE_LOW if r["id"] != 3], SYNC)
    run()
    assert _df(engine, CASES).source_change_reason.tolist() == ["rating no longer in the NPS source"]
    # and comes back as a detractor: the flag clears, the case was never duplicated
    source["fake"] = FakeNpsSource(SOURCE_FULL, SOURCE_LOW, SYNC)
    run()
    cases = _df(engine, CASES)
    assert len(cases) == 1 and int(cases.source_changed.iloc[0]) == 0 and cases.source_change_reason.isna().all()
    audit = _df(engine, "SELECT changed_by, field, old_value, new_value FROM nps_followup_audit ORDER BY audit_id")
    assert audit.changed_by.isna().all() and set(audit.field) == {"source_changed"}
    assert audit.new_value.tolist() == ["rating is no longer a detractor", "rating no longer in the NPS source", None]


def test_without_the_setting_or_the_migration_no_case_is_created(npsjob, monkeypatch):
    engine, run, _ = npsjob
    monkeypatch.delenv("NPS_FOLLOWUP_START", raising=False)
    run()
    assert "skipped: migration 0052 not applied" in _details(engine)
    apply_migration_sqlite(engine, "0052_nps_detractor_followup.sql")
    run()
    assert "skipped: NPS_FOLLOWUP_START is not set" in _details(engine)
    assert _df(engine, "SELECT COUNT(*) AS n FROM nps_followup_case").n.iloc[0] == 0


def test_a_bad_cutover_date_fails_the_run(fu, monkeypatch):
    _, run, _ = fu
    monkeypatch.setenv("NPS_FOLLOWUP_START", "04/10/2026")
    with pytest.raises(Exception, match="NPS_FOLLOWUP_START must be a date"):
        run()


def test_migration_seeds_the_eight_agreed_reasons(fu):
    engine, _, _ = fu
    reasons = _df(engine, "SELECT name_en, name_ar FROM nps_followup_reason ORDER BY sort_order")
    assert reasons.name_en.tolist() == ["Late delivery", "Damaged product", "Wrong or missing item", "Driver behaviour",
                                        "Product quality", "Price or invoice issue", "Customer service", "Other"]
    assert reasons.name_ar.str.len().gt(0).all()


def test_after_0066_only_the_stage_is_written_and_the_status_follows_it(fu):
    engine, run, _ = fu
    run()  # an INSERT naming `status` would fail here: it is a generated column
    details = _details(engine)
    assert '"stage_column": "stage"' in details and '"by_stage": {"NEW": 1}' in details and '"by_status": {"OPEN": 1}' in details
    for stage, status in (("CONTACTED", "OPEN"), ("IN_PROGRESS", "OPEN"), ("HISTORICAL", None)):
        with engine.begin() as conn:
            conn.execute(text("UPDATE nps_followup_case SET stage = :s"), {"s": stage})
        got = _df(engine, "SELECT status FROM nps_followup_case").status.iloc[0]
        assert (None if got is None or got != got else got) == status, stage
    with engine.begin() as conn:
        conn.execute(text("UPDATE nps_followup_case SET stage = 'RESOLVED', resolved_at = '2026-10-05 09:00:00'"))
    assert _df(engine, "SELECT status FROM nps_followup_case").status.tolist() == ["CLOSE"]
    with engine.begin() as conn:
        conn.execute(text("UPDATE nps_followup_case SET stage = 'REJECTED', resolved_at = NULL, rejected_at = '2026-10-05 10:00:00'"))
    assert _df(engine, "SELECT status FROM nps_followup_case").status.tolist() == ["DISPUTED"]
    run()  # a reload leaves the stage alone
    assert _df(engine, CASES)[["stage", "status"]].values.tolist() == [["REJECTED", "DISPUTED"]]


def test_before_0066_the_stage_is_written_into_the_old_column(fu52):
    engine, run, _ = fu52
    run()
    old = "status"  # 0052: the stage values still live in the column `status`
    assert _df(engine, f"SELECT {old} AS stage FROM nps_followup_case").stage.tolist() == ["NEW"]
    assert '"stage_column": "status"' in _details(engine) and "by_status" not in _details(engine)


def test_the_database_refuses_resolved_without_a_date_rejected_without_a_time_and_dates_before_the_rating(fu):
    engine, run, _ = fu
    run()
    for sql in ("UPDATE nps_followup_case SET stage = 'RESOLVED'",
                "UPDATE nps_followup_case SET stage = 'RESOLVED', resolved_at = '2026-10-03 09:00:00'",
                "UPDATE nps_followup_case SET stage = 'REJECTED'",
                "UPDATE nps_followup_case SET rejected_at = '2026-10-05 09:00:00'",
                "UPDATE nps_followup_case SET contacted_at = '2026-10-04 09:59:00'",
                "UPDATE nps_followup_case SET stage = 'SOLVED'",
                "UPDATE nps_followup_case SET stage = 'DONE'"):
        with pytest.raises(Exception, match="CHECK"), engine.begin() as conn:
            conn.execute(text(sql))
    with pytest.raises(Exception, match="generated column"), engine.begin() as conn:
        conn.execute(text("UPDATE nps_followup_case SET status = 'CLOSE'"))
