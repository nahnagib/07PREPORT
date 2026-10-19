"""NPS Detractor Follow-up: process_nps adds a case per detractor (idempotent, cut-over by NPS_FOLLOWUP_START), flags
source changes, and never writes a manual field (departments/process/followup.py, migration 0052)."""

from __future__ import annotations

import pytest
from sqlalchemy import text

from sqlite_schema import apply_migration_sqlite
from test_process_nps import BELOW, MET, SOURCE_FULL, SOURCE_LOW, SYNC, FakeNpsSource, _df, _src_row, npsjob  # noqa: F401

CASES = "SELECT response_id, rated_at_local, status, source_changed, source_change_reason, notes, version FROM nps_followup_case ORDER BY response_id"


@pytest.fixture
def fu(npsjob, monkeypatch):
    engine, run, source = npsjob
    apply_migration_sqlite(engine, "0052_nps_detractor_followup.sql")
    monkeypatch.setenv("NPS_FOLLOWUP_START", "2026-10-04")
    return engine, run, source


def _details(engine) -> str:
    return _df(engine, "SELECT details FROM etl_task_log WHERE task_name = 'load_nps' ORDER BY rowid DESC").details.iloc[0]


def test_one_case_per_detractor_new_from_the_cutover_and_idempotent(fu):
    engine, run, _ = fu
    run()
    run()
    cases = _df(engine, CASES)
    # source row 3 is the only detractor; rated 08:00 UTC = 10:00 Tripoli on 4 Oct, the cut-over day
    assert cases.response_id.tolist() == [3] and cases.status.tolist() == ["NEW"]
    assert str(cases.rated_at_local.iloc[0]).startswith("2026-10-04 10:00")
    assert cases.source_changed.tolist() == [0] and cases.version.tolist() == [1]
    assert '"created": 0' in _details(engine)  # the second run added nothing
    assert _df(engine, "SELECT COUNT(*) AS n FROM nps_followup_audit").n.iloc[0] == 0


def test_detractors_before_the_cutover_are_historical(fu, monkeypatch):
    engine, run, _ = fu
    monkeypatch.setenv("NPS_FOLLOWUP_START", "2026-10-05")
    run()
    assert _df(engine, CASES).status.tolist() == ["HISTORICAL"]


def test_manual_fields_survive_every_reload(fu):
    engine, run, _ = fu
    run()
    with engine.begin() as conn:
        conn.execute(text("UPDATE nps_followup_case SET status = 'CONTACTED', contacted_at = '2026-10-05 09:00:00', "
                          "notes = 'called the customer', owner_user_id = 7, version = 2"))
    run()
    row = _df(engine, "SELECT status, contacted_at, notes, owner_user_id, version FROM nps_followup_case").iloc[0]
    assert (row.status, str(row.contacted_at)[:16], row.notes, int(row.owner_user_id), int(row.version)) == (
        "CONTACTED", "2026-10-05 09:00", "called the customer", 7, 2)


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
    assert (case.status, int(case.source_changed), case.source_change_reason, case.notes) == (
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


def test_the_database_refuses_solved_without_a_date_and_dates_before_the_rating(fu):
    engine, run, _ = fu
    run()
    for sql in ("UPDATE nps_followup_case SET status = 'SOLVED'",
                "UPDATE nps_followup_case SET status = 'SOLVED', solved_at = '2026-10-03 09:00:00'",
                "UPDATE nps_followup_case SET contacted_at = '2026-10-04 09:59:00'",
                "UPDATE nps_followup_case SET status = 'DONE'"):
        with pytest.raises(Exception, match="CHECK"), engine.begin() as conn:
            conn.execute(text(sql))
