"""NPS Score: the rating rule, the transform, the source module's safety rules and the process_nps job on SQLite with a
fake NPS source (no network, no SSH)."""

from __future__ import annotations

import contextlib
import datetime as _dt
import re
from dataclasses import replace

import pandas as pd
import pytest
from sqlalchemy import text

from core.resolve import KeyMaps
from core_fixtures import ODOO, PARTNER_COMPANY, FakeOdooSource, write_inputs
from departments.process import jobs as nps_jobs
from departments.process import nps
from departments.process import transform as tf
from departments.process import whatsapp as wa
from etl_platform.registry import REGISTRY, RegistryError, load_definitions
from etl_platform.runner import Runner
from etl_platform.sources import mysql_ssh as ms
from sqlite_schema import MIGRATIONS, apply_migration_sqlite

EXCEEDED, MET, BELOW = "<p>فاقت التوقعات</p>", "<p>في مستوى التوقعات</p>", "<p>أقل من المتوقع</p>"


# -- the developer's rule (nps.py) ----------------------------------------------------------------------------------------
def test_the_three_arabic_answers_are_the_three_levels():
    assert nps.classify("<p>فاقت التوقعات</p>") == 3
    assert nps.classify("<p>في مستوى التوقعات</p>") == 2
    assert nps.classify("<p>أقل من المتوقع</p>") == 1
    assert nps.classify("  <p>  أقل من المتوقع \n</p> ") == 1  # whitespace trimmed
    assert [lv.source_text for lv in nps.LEVELS] == ["فاقت التوقعات", "في مستوى التوقعات", "أقل من المتوقع"]


@pytest.mark.parametrize("body", ["<p>ممتاز</p>", "<p>فاقت التوقعات جدا</p>", "<p>في مستوى  التوقعات</p>", "<p>7</p>", "<p>10/10</p>"])
def test_anything_else_is_never_a_rating(body):
    assert nps.classify(body) is None
    assert nps.body_kind(body) == nps.KIND_COMMENT


@pytest.mark.parametrize("body", [None, "", "<p></p>", "<p> <br> </p>", float("nan")])
def test_blank_bodies(body):
    assert nps.classify(body) is None and nps.body_kind(body) == nps.KIND_BLANK


def test_comment_text_is_plain_and_masks_personal_data():
    body = "<p>اتصلوا على 0910000001 أو +218 91 000 0002<br>mail me@x.ly &amp; thanks 15</p>"
    assert nps.comment_text(body) == "اتصلوا على [phone] أو [phone]\nmail [email] & thanks 15"


def test_nps_style_from_counts():
    assert nps.nps_style(50, 76, 7) == 32.3
    assert nps.nps_style(0, 0, 0) is None  # no response: no score, never 0
    assert nps.nps_style(0, 0, 3) == -100.0 and nps.nps_style(2, 0, 0) == 100.0
    # groups add up by COUNTS: (1 + 0) - (0 + 3) over 5, not the average of +100 and -75
    assert nps.nps_style(1 + 0, 0 + 1, 0 + 3) == -40.0


def test_level_dimension_rows():
    frame = nps.level_frame().set_index("nps_level")
    assert frame.loc[1, "is_low_rating"] == 1 and frame.loc[3, "level_key"] == "exceeded"
    with pytest.raises(ValueError):
        nps.validate_levels(nps.LEVELS[:2])


# -- transform -------------------------------------------------------------------------------------------------------------
def _maps() -> KeyMaps:
    return KeyMaps(
        company_keys={-1, 1, 3}, company_name_keys={}, partner_customer={100: 100, 101: 100, 102: 102},
        user_salesperson={10: 49, 12: 60}, team_map={9: ("MJ-EST-BB", False), 27: ("SALESPERSON", True)},
        salesperson_team={49: "TK-BEN-BC-03", 60: "MJ-EST-BB", -1: "-1"}, salesperson_channel={49: 3, 60: 2, -1: -1},
        team_segment={"MJ-EST-BB": 1, "TK-BEN-BC-03": 2, "-1": -1}, product_keys=set(), product_master={}, master_keys=set(),
    )


def _row(i, body, *, at="2026-10-04 08:00:00", code="WH/OUT/1", order="S1", partner=101, sp=12, team=9, company="MAJAAL", sched="2026-09-27 10:00:00"):
    return {"id": i, "create_date": pd.Timestamp(at), "company_id": 7.0, "company_name": company, "delivery_code": code, "body": body,
            "order_id": order, "scheduled_date": pd.Timestamp(sched) if sched else None, "partner_id": partner, "salesperson_id": sp, "team_id": team}


LOOKUPS = tf.Lookups(
    orders={"S1": [(4001, 1, 100)], "S2": [(4002, 1, 100), (4003, 3, 102)], "S9": [(4009, 3, 102), (4010, 3, 999)]},
    deliveries={"TIKA/OUT/7": [(0, 3, 102)]},
)


def _build(rows, low=None):
    low = pd.DataFrame(low or [], columns=["id", "team_branch"])
    return tf.build(pd.DataFrame(rows), low, _maps(), LOOKUPS, "Africa/Tripoli")


def test_one_response_per_rating_comments_linked_blanks_dropped():
    built = _build([_row(1, EXCEEDED), _row(2, "<p>شكرا</p>", at="2026-10-04 08:00:30"), _row(3, "<p></p>", at="2026-10-04 08:01:00"),
                    _row(4, BELOW, code="WH/OUT/2", order="S1"), _row(5, "<p>قبل التقييم</p>", code="WH/OUT/2", at="2026-10-04 07:00:00"),
                    _row(6, "<p>no rating here</p>", code="WH/OUT/3")],
                   low=[{"id": 4, "team_branch": "B2B"}])
    r = built.responses.set_index("response_id")
    assert list(r.index) == [1, 4] and r.loc[1, "nps_level"] == 3 and r.loc[4, "is_low_rating"] == 1
    assert r.loc[4, "in_low_rating_table"] == 1 and r.loc[4, "team_branch"] == "B2B" and r.loc[1, "team_branch"] is None
    c = built.comments.set_index("comment_id")
    assert c.loc[2, "response_id"] == 1  # the rating before it
    assert c.loc[5, "response_id"] == 4  # no rating before it on that delivery: the first one after
    assert c.loc[6, "response_id"] == -1  # its delivery has no rating
    assert r.loc[1, "has_comment"] == 1 and r.loc[4, "has_comment"] == 1
    assert built.stats["blank"] == 1 and built.stats["by_level"] == {"exceeded": 1, "met": 0, "below": 1}
    assert built.stats["nps_style"] == 0.0


def test_dates_are_utc_converted_to_tripoli_a_late_rating_moves_to_the_next_day():
    r = _build([_row(1, MET, at="2026-10-04 22:30:00", sched="2026-09-30 23:00:00")]).responses.iloc[0]
    assert r["rated_at_local"] == _dt.datetime(2026, 10, 5, 0, 30) and r["RatingDateKey"] == 20261005
    assert r["DeliveryDateKey"] == 20261001
    assert _build([_row(1, MET, sched=None)]).responses.iloc[0]["DeliveryDateKey"] == -1
    mixed = _build([_row(1, MET), _row(2, MET, sched=None, at="2026-10-04 09:00:00")]).responses  # NaT among dates
    assert mixed["DeliveryDateKey"].tolist() == [20260927, -1]


def test_company_comes_from_the_order_then_the_delivery_then_the_company_name_never_the_source_company_id():
    built = _build([
        _row(1, MET, order="S1", company="TIKA"),                      # order S1 is Majaal: the order wins
        _row(2, MET, order=None, code="TIKA/OUT/7", partner=102),       # no order: the delivery's company
        _row(3, MET, order=None, code="INV/2026/10/0166", partner=None, sp=None, team=None, company="TIKA"),  # "company 7" rows
        _row(4, MET, order=None, code="Tom Tom", partner=None, sp=None, team=None, company="OTHER"),
    ])
    r = built.responses.set_index("response_id")
    assert r["CompanyKey"].to_dict() == {1: 1, 2: 3, 3: 3, 4: -1}
    assert r["company_source"].to_dict() == {1: "order", 2: "delivery", 3: "company_name", 4: "none"}
    assert built.fallbacks["fact_process_nps_response.CompanyKey"] == [4]


def test_a_matched_document_without_a_company_falls_through_to_the_next_step():
    # live 2026-10-19: ratings on supplier receipts (WH/IN) whose delivery row has CompanyKey -1 got company -1
    lookups = tf.Lookups(orders={"P00997": [(5001, -1, -1)]}, deliveries={"WH/IN/05581": [(0, -1, -1)], "TIKA/OUT/7": [(0, 3, 102)]})
    rows = pd.DataFrame([
        _row(1, MET, order="P00997", code="WH/IN/05581", partner=None, sp=None, team=None, company="MAJAAL"),
        _row(2, MET, order="P00997", code="TIKA/OUT/7", partner=102, company="MAJAAL"),
        _row(3, MET, order=None, code="WH/IN/05581", partner=None, sp=None, team=None, company="OTHER"),
    ])
    built = tf.build(rows, pd.DataFrame(columns=["id", "team_branch"]), _maps(), lookups, "Africa/Tripoli")
    r = built.responses.set_index("response_id")
    assert r["CompanyKey"].to_dict() == {1: 1, 2: 3, 3: -1}
    assert r["company_source"].to_dict() == {1: "company_name", 2: "delivery", 3: "none"}
    assert r.loc[1, "SalesOrderKey"] == 5001  # the order itself still links


def test_an_order_name_used_by_two_companies_is_narrowed_by_the_customer_then_the_company():
    built = _build([_row(1, MET, order="S2", partner=102), _row(2, MET, order="S2", partner=None, company="MAJAAL"),
                    _row(3, MET, order="S9", partner=None, company="TIKA"), _row(4, MET, order="S404")])
    r = built.responses.set_index("response_id")
    assert r["SalesOrderKey"].to_dict() == {1: 4003, 2: 4002, 3: -1, 4: -1}  # S9: two Tika orders, no customer: no guess
    assert built.stats["orders_ambiguous"] == 1 and built.stats["orders_not_found"] == 1


def test_org_keys_follow_the_house_rules():
    built = _build([_row(1, MET, sp=12, team=9), _row(2, MET, sp=10, team=27), _row(3, MET, sp=10, team=None), _row(4, MET, sp=99, team=55)])
    r = built.responses.set_index("response_id")
    assert r["CustomerKey"].tolist() == [100] * 4  # partner 101 -> its commercial partner 100
    assert r["SalespersonKey"].tolist() == [60, 49, 49, -1]
    assert r["SalesTeamKey"].tolist() == ["MJ-EST-BB", "TK-BEN-BC-03", "TK-BEN-BC-03", "-1"]  # SALESPERSON / no team -> person's team
    assert r["SegmentKey"].tolist() == [1, 2, 2, -1] and r["ChannelKey"].tolist() == [2, 3, 3, -1]
    assert built.fallbacks["fact_process_nps_response.SalespersonKey"] == [99]
    assert built.fallbacks["fact_process_nps_response.SalesTeamKey(unlisted Odoo team)"] == [55]


# -- the source module (mysql_ssh.py) ---------------------------------------------------------------------------------------
NPS_ENV = {"NPS_SSH_HOST": "203.0.113.5", "NPS_SSH_PORT": "6934", "NPS_SSH_USER": "etl", "NPS_SSH_PASSWORD": "pw-secret",
           "NPS_SSH_HOST_KEY": "SHA256:abc", "NPS_DB_NAME": "xtremech_nps_dashboard", "NPS_DB_USER": "reader", "NPS_DB_PASSWORD": "db-secret"}


def test_settings_name_every_missing_variable_and_never_a_secret():
    with pytest.raises(ms.MySqlSourceConfigError) as err:
        ms.MySqlSshSettings.from_env("NPS", {"NPS_DB_NAME": "x"})
    msg = str(err.value)
    for name in ("NPS_DB_USER", "NPS_DB_PASSWORD", "NPS_SSH_HOST", "NPS_SSH_PORT", "NPS_SSH_USER",
                 "NPS_SSH_KEY_PATH or NPS_SSH_PASSWORD", "NPS_SSH_HOST_KEY or NPS_SSH_KNOWN_HOSTS"):
        assert name in msg
    s = ms.MySqlSshSettings.from_env("NPS", NPS_ENV)
    assert s.auth_method == "password" and s.db_host == "127.0.0.1" and s.db_port == 3306
    assert "secret" not in repr(s)
    direct = ms.MySqlSshSettings.from_env("NPS", {"NPS_SSH_ENABLED": "false", "NPS_DB_NAME": "x", "NPS_DB_USER": "u", "NPS_DB_PASSWORD": "p"})
    assert direct.ssh_enabled is False  # no SSH variables needed without the tunnel


def test_only_single_read_statements_reach_the_source():
    ms.check_read_only("SELECT 1")
    ms.check_read_only("  with x as (select 1) select * from x;")
    for bad in ("UPDATE sync_state SET source = 'x'", "DELETE FROM low_rating_data", "SELECT 1; DROP TABLE t", "INSERT INTO t VALUES (1)"):
        with pytest.raises(ms.ReadOnlyViolation):
            ms.check_read_only(bad)


class _Key:
    def __init__(self, raw: bytes):
        self.raw = raw

    def asbytes(self):
        return self.raw


def test_host_key_must_match_the_pinned_fingerprint():
    key = _Key(b"server-key")
    good = ms.fingerprint(key)
    ms._pinned_policy(good).missing_host_key(None, "h", key)  # accepted
    with pytest.raises(ms.SshHostKeyError, match="MISMATCH"):
        ms._pinned_policy("SHA256:somethingelse").missing_host_key(None, "h", key)
    with pytest.raises(ms.SshHostKeyError, match="no expected"):
        ms._pinned_policy("").missing_host_key(None, "h", key)


def test_network_errors_are_retried_auth_errors_are_not():
    calls, sleeps = [], []

    def flaky():
        calls.append(1)
        if len(calls) < 3:
            raise ms.SourceUnreachableError("timed out")
        return "ok"

    assert ms.with_retries(flaky, window_seconds=60, sleep=sleeps.append, initial_delay=1) == "ok"
    assert sleeps == [1, 2]
    with pytest.raises(ms.SourceUnreachableError, match="gave up"):
        ms.with_retries(lambda: (_ for _ in ()).throw(ms.SourceUnreachableError("down")), window_seconds=0, sleep=sleeps.append)
    auth_calls = []

    def rejected():
        auth_calls.append(1)
        raise ms.MySqlAuthError("1045")

    with pytest.raises(ms.MySqlAuthError):
        ms.with_retries(rejected, window_seconds=60, sleep=sleeps.append)
    assert len(auth_calls) == 1


@pytest.mark.parametrize("code, cls, hint", [(2003, ms.SourceUnreachableError, "NPS_DB_HOST"), (1045, ms.MySqlAuthError, "NPS_DB_USER"),
                                             (1049, ms.MySqlAuthError, "NPS_DB_NAME"), (1142, ms.MySqlAuthError, "GRANT".lower())])
def test_driver_errors_say_what_to_check(code, cls, hint):
    settings = ms.MySqlSshSettings.from_env("NPS", NPS_ENV)
    err = ms.mysql_error(Exception(code, "boom"), settings)
    assert isinstance(err, cls) and hint.lower() in str(err).lower() and "secret" not in str(err)


# -- the job on SQLite -----------------------------------------------------------------------------------------------------
class FakeNpsSource:
    def __init__(self, full, low, sync, messages=None):
        self.tables = {"nps_rating_full_data": full, "low_rating_data": low}
        if messages is not None:
            self.tables[wa.SOURCE_TABLE] = messages
        self.sync = sync
        self.queries: list[str] = []

    def read_table_incremental(self, table, columns, **kw):
        self.queries.append(table)
        return [{c: r.get(c) for c in columns} for r in self.tables[table]]

    def read_query(self, sql, params=None):
        ms.check_read_only(sql)
        self.queries.append(sql)
        if "information_schema.TABLES" in sql:
            return [{"n": int(wa.SOURCE_TABLE in self.tables)}]
        return list(self.sync)


def _src_row(i, body, *, at="2026-10-04 08:00:00", code="WH/OUT/1", order="S001", partner=101.0, sp=12.0, team=9.0, company="MAJAAL"):
    return {"id": i, "create_date": _dt.datetime.fromisoformat(at), "company_id": 7.0, "company_name": company, "created_id": 4,
            "created_name": "Public user", "mobile_number": "+218910000001", "delivery_code": code, "body": body, "failure_type": "0",
            "failure_reason": "0", "order_id": order, "scheduled_date": _dt.datetime(2026, 9, 27, 10), "partner_id": partner,
            "partner_name": "x", "salesperson_id": sp, "salesperson_name": "x", "team_id": team, "team_name": "x",
            "updated_at": _dt.datetime(2026, 10, 17, 11, 8, 30)}


SOURCE_FULL = [_src_row(1, EXCEEDED), _src_row(2, "<p>شكرا 0910000001</p>", at="2026-10-04 08:00:20"),
               _src_row(3, BELOW, code="WH/OUT/2"), _src_row(4, MET, code="INV/2026/10/0166", order=None, partner=None, sp=None, team=None, company="TIKA"),
               _src_row(5, "<p></p>", code="WH/OUT/2", at="2026-10-04 09:00:00")]
SOURCE_LOW = [dict(_src_row(3, BELOW, code="WH/OUT/2"), team_branch="B2B", recipient_email="a@b.ly", email_notification=None, notification_date=None),
              dict(_src_row(5, "<p></p>", code="WH/OUT/2", at="2026-10-04 09:00:00"), team_branch="B2B", recipient_email="a@b.ly",
                   email_notification=None, notification_date=None)]
# staleness is measured against the real clock: a sync one hour ago
SYNC = [{"source": "odoo", "last_successful_sync": _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None) - _dt.timedelta(hours=1)}]


@pytest.fixture
def npsjob(platform_engine, platform_config, tmp_path, monkeypatch):
    for m in ("0029_core_dimensions.sql", "0030_core_team_map.sql", "0031_sales_mart.sql", "0032_core_odoo_labels.sql", "0046_process_nps.sql",
              "0049_process_nps_reach.sql", "0050_process_nps_reach_state.sql", "0051_process_nps_reach_live.sql"):
        apply_migration_sqlite(platform_engine, m)
    with platform_engine.begin() as conn:
        conn.execute(text("INSERT INTO dim_sales_order (SalesOrderKey, order_number, CompanyKey, CustomerKey) VALUES (4000, 'S001', 1, 100)"))
    load_definitions()
    monkeypatch.setenv("NPS_ENABLED", "true")
    for k, v in NPS_ENV.items():
        monkeypatch.setenv(k, v)
    config = replace(platform_config, input_dir=write_inputs(tmp_path / "inputs"))
    source = {"fake": FakeNpsSource(SOURCE_FULL, SOURCE_LOW, SYNC)}

    @contextlib.contextmanager
    def fake_open(settings):
        assert settings.db_name == "xtremech_nps_dashboard"
        yield source["fake"]

    monkeypatch.setattr(nps_jobs, "open_source", fake_open)

    def run(job="process_nps"):
        runner = Runner(REGISTRY, platform_engine, config)
        runner._sources["odoo:default"] = FakeOdooSource(ODOO, PARTNER_COMPANY)
        return runner.run(job, as_of=_dt.date(2026, 10, 17), trigger_source="test")

    run("core_dims")
    return platform_engine, run, source


def _df(engine, sql):
    with engine.connect() as conn:
        return pd.read_sql(text(sql), conn)


def test_job_loads_raw_and_facts_and_keeps_personal_data_in_raw(npsjob):
    engine, run, source = npsjob
    run()
    raw = _df(engine, "SELECT id, company_id, partner_id, mobile_number, _deleted_at FROM raw_nps_rating ORDER BY id")
    assert raw.id.tolist() == [1, 2, 3, 4, 5] and raw._deleted_at.isna().all() and raw.mobile_number.iloc[0] == "+218910000001"
    assert int(raw.partner_id.iloc[0]) == 101  # FLOAT ids -> whole numbers
    facts = _df(engine, "SELECT response_id, nps_level, CompanyKey, company_source, CustomerKey, SalesOrderKey, in_low_rating_table, "
                        "team_branch, has_comment FROM fact_process_nps_response ORDER BY response_id")
    assert facts.response_id.tolist() == [1, 3, 4] and facts.nps_level.tolist() == [3, 1, 2]
    assert facts.CompanyKey.tolist() == [1, 1, 3] and facts.company_source.tolist() == ["order", "order", "company_name"]
    assert facts.SalesOrderKey.tolist() == [4000, 4000, -1] and facts.CustomerKey.tolist() == [100, 100, -1]
    assert facts.in_low_rating_table.tolist() == [0, 1, 0] and facts.has_comment.tolist() == [1, 0, 0]
    comments = _df(engine, "SELECT comment_id, response_id, comment_text FROM fact_process_nps_comment")
    assert comments.values.tolist() == [[2, 1, "شكرا [phone]"]]
    cols = set(_df(engine, "SELECT * FROM fact_process_nps_response").columns) | set(_df(engine, "SELECT * FROM fact_process_nps_comment").columns)
    assert not {"mobile_number", "recipient_email", "partner_name"} & cols
    assert _df(engine, "SELECT COUNT(*) AS n FROM dim_process_nps_level").n.iloc[0] == 3
    assert _df(engine, "SELECT source FROM raw_nps_sync_state").source.tolist() == ["odoo"]
    log = _df(engine, "SELECT job_name, status, department FROM etl_run_log WHERE job_name = 'process_nps'")
    assert log.values.tolist() == [["process_nps", "success", "process"]]
    dq = _df(engine, "SELECT check_name, status FROM etl_dq_result").set_index("check_name").status
    assert dq["orphan:fact_process_nps_response.CompanyKey"] == "pass"
    assert (dq[dq.index.str.startswith(("orphan:", "fail:"))] == "pass").all()
    assert dq["warn:nps_sync_state_stale"] == "pass"  # synced an hour ago
    assert dq["warn:nps_company_unmatched"] == "pass"  # row 4 has no order: TIKA by company name
    assert dq["warn:nps_order_unmatched"] == "pass"
    assert dq["warn:nps_rows_not_a_rating"] == "warn"  # the comment (2) and the blank (5)
    assert dq["fail:fact_process_nps_response.duplicate_response_id"] == "pass"


def test_an_empty_sync_state_warns(npsjob):
    engine, run, source = npsjob
    source["fake"] = FakeNpsSource(SOURCE_FULL, SOURCE_LOW, [])
    run()
    dq = _df(engine, "SELECT check_name, status, message FROM etl_dq_result").set_index("check_name")
    assert dq.loc["warn:nps_sync_state_stale", "status"] == "warn" and "sync_state is empty" in dq.loc["warn:nps_sync_state_stale", "message"]
    assert set(source["fake"].queries) >= {"nps_rating_full_data", "low_rating_data"}


def test_second_run_marks_rows_that_left_the_source_and_restores_them(npsjob):
    engine, run, source = npsjob
    run()
    source["fake"] = FakeNpsSource([r for r in SOURCE_FULL if r["id"] != 3], SOURCE_LOW, SYNC)
    run()
    raw = _df(engine, "SELECT id, _deleted_at FROM raw_nps_rating ORDER BY id").set_index("id")._deleted_at
    assert raw.notna().tolist() == [False, False, True, False, False]
    assert _df(engine, "SELECT response_id FROM fact_process_nps_response ORDER BY 1").response_id.tolist() == [1, 4]
    dq = _df(engine, "SELECT check_name, status FROM etl_dq_result ORDER BY dq_result_id DESC")
    assert dq.set_index("check_name").status.groupby(level=0).first()["warn:nps_low_rating_ids_not_in_full"] == "warn"
    source["fake"] = FakeNpsSource(SOURCE_FULL, SOURCE_LOW, SYNC)
    run()
    assert _df(engine, "SELECT COUNT(*) AS n FROM raw_nps_rating WHERE _deleted_at IS NOT NULL").n.iloc[0] == 0


def test_an_empty_source_does_not_wipe_the_warehouse(npsjob):
    engine, run, source = npsjob
    run()
    source["fake"] = FakeNpsSource([], [], SYNC)
    with pytest.raises(Exception, match="returned 0 rows"):
        run()
    assert _df(engine, "SELECT COUNT(*) AS n FROM raw_nps_rating WHERE _deleted_at IS NULL").n.iloc[0] == 5
    assert _df(engine, "SELECT COUNT(*) AS n FROM fact_process_nps_response").n.iloc[0] == 3


def test_missing_settings_fail_the_nps_job_only_naming_the_variables(npsjob, monkeypatch):
    engine, run, _ = npsjob
    monkeypatch.delenv("NPS_DB_PASSWORD")
    with pytest.raises(Exception, match="NPS_DB_PASSWORD"):
        run()
    err = _df(engine, "SELECT error_message FROM etl_run_log WHERE job_name = 'process_nps'").error_message.iloc[0]
    assert "NPS_DB_PASSWORD" in err and "db-secret" not in err and "pw-secret" not in err


def test_disabled_job_refuses_to_run_alone(npsjob, monkeypatch):
    _, run, _ = npsjob
    monkeypatch.setenv("NPS_ENABLED", "false")
    with pytest.raises(RegistryError, match="NPS_ENABLED"):
        run()


def test_job_definition():
    load_definitions()
    job = REGISTRY.jobs["process_nps"]
    assert job.department == "process" and job.depends_on_jobs == ("core_dims",) and job.tasks == ("extract_nps", "load_nps")
    assert REGISTRY.datasets["raw_nps_rating"].source == "mysql"


def test_unmatched_company_and_order_warn_but_load(npsjob):
    engine, run, source = npsjob
    lost = _src_row(9, MET, code="Tom Tom", order="S404", partner=None, sp=None, team=None, company="OTHER")
    source["fake"] = FakeNpsSource([*SOURCE_FULL, lost], SOURCE_LOW, SYNC)
    run()
    dq = _df(engine, "SELECT check_name, status, message FROM etl_dq_result").set_index("check_name")
    assert dq.loc["warn:nps_company_unmatched", "status"] == "warn" and "9" in dq.loc["warn:nps_company_unmatched", "message"]
    assert dq.loc["warn:nps_order_unmatched", "status"] == "warn" and "S404" in dq.loc["warn:nps_order_unmatched", "message"]
    assert _df(engine, "SELECT CompanyKey, SalesOrderKey FROM fact_process_nps_response WHERE response_id = 9").values.tolist() == [[-1, -1]]


def _message(i, state, **changes):
    return {"id": i, "create_date": _dt.datetime(2026, 10, 17, 22, 30), "company_name": "MAJAAL",
            "template_name": "Customer Feedback", "state": state, "mobile_number": "+218910000009",
            "failure_type": None, "failure_reason": None, "first_seen_at": _dt.datetime(2026, 10, 18),
            "updated_at": _dt.datetime(2026, 10, 18), **changes}


MESSAGES = [_message(1, " DELIVERED "), _message(2, "read", company_name="TIKA"), _message(3, "sent"),
            _message(4, "error", failure_reason="131026 Undeliverable"), _message(5, "error", failure_type="phone format"),
            _message(6, "queued"), _message(7, "read", template_name="Invoice"),
            _message(8, "sent", mobile_number="0910000001"),
            _message(9, "error", create_date=_dt.datetime(2026, 10, 17, 21, 59))]


def test_reach_rules_tripoli_dates_exclusions_error_groups_and_privacy():
    config = wa.ReachConfig.from_env({"NPS_REACH_ENABLED": "true", "NPS_REACH_START": "2026-10-18",
                                    "NPS_REACH_EXCLUDED_NUMBERS": "+218 91 000 0001"})
    fact = wa.build_messages(pd.DataFrame(MESSAGES), config, "Africa/Tripoli", lambda name: {"MAJAAL": 1, "TIKA": 3}[name])
    assert fact.MessageDateKey.tolist() == [20261018] * 8 + [20261017]
    assert fact.in_reach_scope.tolist() == [1] * 6 + [0, 0, 0]
    assert fact.box.tolist()[:6] == ["delivered", "read", "not_delivered", "error", "error", "other"]
    assert fact.failure_group.tolist()[:6] == ["-", "-", "-", "undeliverable_131026", "phone_format", "-"]
    assert not {"mobile_number", "failure_reason", "failure_type"} & set(fact.columns)


@pytest.mark.parametrize("code,group", [("131026", "undeliverable_131026"), ("131049", "ecosystem_131049"),
                                      ("quality", "template_quality"), ("invalid recipient", "phone_format"),
                                      ("131000", "meta_temporary"), ("new failure", "other")])
def test_reach_failure_groups_and_fixable_flags(code, group):
    assert wa.failure_group(None, code, "error") == group
    assert wa.failure_group(code, code, "read") is None
    flags = wa.group_frame().set_index("failure_group").is_fixable.to_dict()
    assert {key for key, fixable in flags.items() if fixable} == {"phone_format", "template_quality"}


# every failure value of the 2026-10-19 profile of whatsapp_outbound_messages, with the group agreed on 2026-10-19
REAL_FAILURES = [
    ("phone_invalid", "", "phone_format"),
    ("phone_invalid", None, "phone_format"),
    ("whatsapp_unrecoverable", "131026 : Message undeliverable", "undeliverable_131026"),
    ("whatsapp_unrecoverable", "131049 : This message was not delivered to maintain healthy ecosystem engagement.", "ecosystem_131049"),
    ("whatsapp_unrecoverable", "130472 : User's number is part of an experiment", "ecosystem_131049"),
    ("whatsapp_recoverable", "An unexpected error has occurred. Please retry your request later.", "meta_temporary"),
    ("whatsapp_unrecoverable", "131050 : Unable to deliver the message. This recipient has chosen to stop receiving marketing "
                               "messages on WhatsApp from your business", "opted_out_131050"),
    ("whatsapp_unrecoverable", "131047 : Re-engagement message", "other"),
    ("whatsapp_recoverable", "(#2) Service temporarily unavailable", "meta_temporary"),
]


@pytest.mark.parametrize("failure_type,failure_reason,group", REAL_FAILURES)
def test_every_real_failure_value_lands_in_its_agreed_group(failure_type, failure_reason, group):
    assert wa.failure_group(failure_type, failure_reason, "error") == group
    # an old failure text on a message that got through is ignored
    assert wa.failure_group(failure_type, failure_reason, "read") is None
    assert wa.failure_group(failure_type, failure_reason, "sent") is None


def test_agreed_group_labels_order_and_fixable_flags():
    frame = wa.group_frame().set_index("failure_group")
    assert frame.loc["ecosystem_131049", "label_en"] == "Meta held back (131049/130472)"
    assert frame.loc["opted_out_131050", "label_en"] == "Customer opted out of marketing (131050)"
    assert frame.loc["phone_format", "label_en"] == "Phone number missing or invalid"
    assert "Odoo contact" in frame.loc["phone_format", "hint"]
    assert not frame.loc[["ecosystem_131049", "opted_out_131050", "meta_temporary", "other"], "is_fixable"].any()
    assert frame.loc["phone_format", "is_fixable"] == 1
    assert list(frame.sort_values("sort_order").index) == ["undeliverable_131026", "ecosystem_131049", "opted_out_131050",
                                                           "template_quality", "phone_format", "meta_temporary", "other", "-"]


def test_migration_0051_seeds_the_same_groups_as_the_code():
    sql = (MIGRATIONS / "0051_process_nps_reach_live.sql").read_text(encoding="utf-8")
    frame = wa.group_frame().set_index("failure_group")
    for key in ("ecosystem_131049", "opted_out_131050", "phone_format"):
        assert f"'{frame.loc[key, 'label_en']}'" in sql


@pytest.mark.parametrize("enabled", [False, True])
def test_reach_absent_source_or_disabled_never_invents_counts(npsjob, monkeypatch, enabled):
    engine, run, source = npsjob
    monkeypatch.setenv("NPS_REACH_ENABLED", str(enabled))
    run()
    assert _df(engine, "SELECT COUNT(*) AS n FROM fact_process_nps_response").n.iloc[0] == 3
    assert _df(engine, "SELECT COUNT(*) AS n FROM process_nps_reach_state").n.iloc[0] == 0
    assert wa.SOURCE_TABLE not in source["fake"].queries
    assert any("information_schema.TABLES" in sql for sql in source["fake"].queries) == enabled


def test_reach_job_fixture_table_rebuild_delete_restore_and_empty_guard(npsjob, monkeypatch):
    engine, run, source = npsjob
    monkeypatch.setenv("NPS_REACH_ENABLED", "true")
    monkeypatch.setenv("NPS_REACH_START", "2026-10-18")
    monkeypatch.setenv("NPS_REACH_EXCLUDED_NUMBERS", "+218910000001")
    source["fake"] = FakeNpsSource(SOURCE_FULL, SOURCE_LOW, SYNC, MESSAGES)
    run()
    fact = _df(engine, "SELECT * FROM fact_process_nps_message ORDER BY message_id")
    assert len(fact) == 9 and fact.in_reach_scope.sum() == 6
    assert _df(engine, "SELECT messages_loaded FROM process_nps_reach_state").messages_loaded.iloc[0] == 9
    assert _df(engine, "SELECT mobile_number FROM raw_nps_whatsapp_message WHERE id = 8").mobile_number.iloc[0] == "0910000001"
    dq = _df(engine, "SELECT check_name, status FROM etl_dq_result").set_index("check_name").status
    assert dq["warn:nps_message_other_state"] == "warn"
    assert (dq[dq.index.str.startswith("orphan:fact_process_nps_message")] == "pass").all()
    assert _df(engine, "SELECT reach_start FROM process_nps_reach_state").reach_start.astype(str).tolist() == ["2026-10-18"]
    # State transitions are reflected on every full snapshot; a message that left the source is never hidden: it keeps
    # being counted, flagged with deleted_in_source_at, and the disappearance is warned with its count.
    source["fake"].tables[wa.SOURCE_TABLE] = [_message(1, "read")]
    run()
    fact = _df(engine, "SELECT message_id, box, deleted_in_source_at FROM fact_process_nps_message ORDER BY message_id")
    assert len(fact) == 9 and fact.box.tolist()[:3] == ["read", "read", "not_delivered"]
    assert fact.deleted_in_source_at.isna().tolist() == [True] + [False] * 8
    assert _df(engine, "SELECT COUNT(*) AS n FROM raw_nps_whatsapp_message WHERE _deleted_at IS NOT NULL").n.iloc[0] == 8
    gone = _last_dq(engine, "warn:nps_reach_rows_disappeared")
    assert (gone.status, gone.failing_rows) == ("warn", 8)
    previous_run = _df(engine, "SELECT _run_id FROM process_nps_reach_state")._run_id.iloc[0]
    source["fake"].tables[wa.SOURCE_TABLE] = []
    run()
    assert len(_df(engine, "SELECT message_id FROM fact_process_nps_message")) == 9
    assert _df(engine, "SELECT _run_id FROM process_nps_reach_state")._run_id.iloc[0] == previous_run
    source["fake"].tables[wa.SOURCE_TABLE] = MESSAGES
    run()
    assert _df(engine, "SELECT COUNT(*) AS n FROM raw_nps_whatsapp_message WHERE _deleted_at IS NOT NULL").n.iloc[0] == 0
    assert _df(engine, "SELECT COUNT(*) AS n FROM fact_process_nps_message WHERE deleted_in_source_at IS NOT NULL").n.iloc[0] == 0


def test_reach_serving_views_reconcile_source_dates_companies_states_and_errors(npsjob, monkeypatch, capsys):
    from scripts.process.check_nps_totals import reconcile_reach

    engine, run, source = npsjob
    monkeypatch.setenv("NPS_REACH_ENABLED", "true")
    monkeypatch.setenv("NPS_REACH_START", "2026-10-18")
    monkeypatch.setenv("NPS_REACH_EXCLUDED_NUMBERS", "+218910000001")
    source["fake"] = FakeNpsSource(SOURCE_FULL, SOURCE_LOW, SYNC, MESSAGES)
    run()
    views = re.findall(r"CREATE OR REPLACE VIEW (\w+) AS(.*?);", (MIGRATIONS / "0049_process_nps_reach.sql").read_text(encoding="utf-8"), re.S)
    with engine.begin() as conn:
        for name, query in views:
            conn.execute(text(f"CREATE VIEW {name} AS {query}"))
        boxes = conn.execute(text("SELECT CompanyKey, total_reach, delivered, not_delivered, read_count, error_count, other_state "
                                  "FROM v_process_nps_reach ORDER BY CompanyKey")).fetchall()
        assert [tuple(row) for row in boxes] == [(1, 5, 1, 1, 0, 2, 1), (3, 1, 0, 0, 1, 0, 0)]
        day = _dt.date(2026, 10, 18)
        assert reconcile_reach(conn, MESSAGES, wa.ReachConfig.from_env(), "Africa/Tripoli", day, day)
        conn.execute(text("UPDATE fact_process_nps_message SET box = 'read' WHERE message_id = 3"))
        assert not reconcile_reach(conn, MESSAGES, wa.ReachConfig.from_env(), "Africa/Tripoli", day, day)
    assert "+218910000009" not in capsys.readouterr().out


def test_reach_successful_empty_first_load_is_ready(npsjob, monkeypatch):
    engine, run, source = npsjob
    monkeypatch.setenv("NPS_REACH_ENABLED", "true")
    source["fake"] = FakeNpsSource(SOURCE_FULL, SOURCE_LOW, SYNC, [])
    run()
    assert _df(engine, "SELECT messages_loaded FROM process_nps_reach_state").messages_loaded.tolist() == [0]


def test_reach_failed_quality_checks_roll_back_snapshot_and_load_state(npsjob, monkeypatch):
    engine, run, source = npsjob
    monkeypatch.setenv("NPS_REACH_ENABLED", "true")
    source["fake"] = FakeNpsSource(SOURCE_FULL, SOURCE_LOW, SYNC, [_message(1, "sent")])
    run()
    previous = _df(engine, "SELECT _run_id FROM process_nps_reach_state")._run_id.iloc[0]
    # Broken company resolution must fail the quality gate, never commit half a snapshot.
    monkeypatch.setattr(nps_jobs.tf, "source_company", lambda *_: 987654)
    source["fake"].tables[wa.SOURCE_TABLE] = [_message(2, "read")]
    with pytest.raises(Exception, match="(?i)quality"):
        run()
    assert _df(engine, "SELECT _run_id FROM process_nps_reach_state")._run_id.iloc[0] == previous
    assert _df(engine, "SELECT message_id, box FROM fact_process_nps_message").values.tolist() == [[1, "not_delivered"]]


def test_reach_reconciliation_keeps_messages_that_left_the_source(npsjob, monkeypatch, capsys):
    from scripts.process.check_nps_totals import reconcile_reach

    engine, run, source = npsjob
    monkeypatch.setenv("NPS_REACH_ENABLED", "true")
    source["fake"] = FakeNpsSource(SOURCE_FULL, SOURCE_LOW, SYNC, MESSAGES)
    run()
    source["fake"].tables[wa.SOURCE_TABLE] = MESSAGES[1:]  # message 1 (delivered, MAJAAL) disappears
    run()
    views = re.findall(r"CREATE OR REPLACE VIEW (\w+) AS(.*?);", (MIGRATIONS / "0049_process_nps_reach.sql").read_text(encoding="utf-8"), re.S)
    with engine.begin() as conn:
        for name, query in views:
            conn.execute(text(f"CREATE VIEW {name} AS {query}"))
        assert conn.execute(text("SELECT SUM(delivered) FROM v_process_nps_reach WHERE CompanyKey = 1")).scalar() == 1
        day = _dt.date(2026, 10, 17)
        assert reconcile_reach(conn, MESSAGES[1:], wa.ReachConfig.from_env(), "Africa/Tripoli", day, _dt.date(2026, 10, 18))
    out = capsys.readouterr().out
    assert "still counted: 1" in out and out.count("MATCH") >= 5 and "DIFFERENT" not in out


def _last_dq(engine, name):
    return _df(engine, f"SELECT status, failing_rows, message FROM etl_dq_result WHERE check_name = '{name}' "
                       "ORDER BY dq_result_id DESC").iloc[0]


def _recent(i, state, **changes):
    """A message sent an hour ago (the staleness check uses the real clock)."""
    now = _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None)
    return _message(i, state, create_date=now - _dt.timedelta(hours=1), **changes)


def test_reach_quality_checks_warn_and_land_in_the_task_log(npsjob, monkeypatch):
    engine, run, source = npsjob
    monkeypatch.setenv("NPS_REACH_ENABLED", "true")
    source["fake"] = FakeNpsSource(SOURCE_FULL, SOURCE_LOW, SYNC, [
        _recent(1, "read"), _recent(2, "queued"),
        _recent(3, "error", failure_type="whatsapp_unrecoverable", failure_reason="131047 : Re-engagement message"),
        _recent(4, "error", company_name="ATHENA")])
    run()
    other = _last_dq(engine, "warn:nps_message_error_in_other")
    assert other.status == "warn" and "131047" in other.message and "Re-engagement" not in other.message
    assert _last_dq(engine, "warn:nps_message_other_state").status == "warn"
    assert _last_dq(engine, "warn:nps_message_company_unmatched").status == "warn"
    for name in ("warn:nps_message_source_stale", "warn:nps_reach_rows_disappeared", "fail:nps_message_state_missing"):
        assert _last_dq(engine, name).status == "pass", name
    details = _df(engine, "SELECT details FROM etl_task_log WHERE task_name = 'load_nps' ORDER BY task_log_id DESC").details.iloc[0]
    assert '"warn:nps_message_error_in_other": "warn (2)"' in details  # 131047 and the empty failure of message 4
    assert '"fail:nps_message_state_missing": "pass (0)"' in details
    assert "+218910000009" not in details


def test_reach_no_new_message_for_three_days_warns(npsjob, monkeypatch):
    engine, run, source = npsjob
    monkeypatch.setenv("NPS_REACH_ENABLED", "true")
    source["fake"] = FakeNpsSource(SOURCE_FULL, SOURCE_LOW, SYNC, [_message(1, "read", create_date=_dt.datetime(2026, 1, 1))])
    run()
    assert _last_dq(engine, "warn:nps_message_source_stale").status == "warn"


def test_reach_duplicate_source_id_fails_and_keeps_the_previous_snapshot(npsjob, monkeypatch):
    engine, run, source = npsjob
    monkeypatch.setenv("NPS_REACH_ENABLED", "true")
    source["fake"] = FakeNpsSource(SOURCE_FULL, SOURCE_LOW, SYNC, [_recent(1, "sent")])
    run()
    source["fake"].tables[wa.SOURCE_TABLE] = [_recent(1, "read"), _recent(1, "read"), _recent(2, "read")]
    with pytest.raises(Exception, match="duplicate_source_id"):
        run()
    assert _df(engine, "SELECT message_id, box FROM fact_process_nps_message").values.tolist() == [[1, "not_delivered"]]
    error = _df(engine, "SELECT error_message FROM etl_task_log WHERE task_name = 'extract_nps' ORDER BY task_log_id DESC").error_message.iloc[0]
    assert "fail:nps_message_duplicate_source_id: 1 id(s) repeated" in error


@pytest.mark.parametrize("missing,fails", [(5, False), (6, True)])
def test_reach_missing_state_fails_above_a_few_rows(npsjob, monkeypatch, missing, fails):
    engine, run, source = npsjob
    monkeypatch.setenv("NPS_REACH_ENABLED", "true")
    source["fake"] = FakeNpsSource(SOURCE_FULL, SOURCE_LOW, SYNC,
                                   [_recent(i, None) for i in range(1, missing + 1)] + [_recent(99, "read")])
    if fails:
        with pytest.raises(Exception, match="state_missing"):
            run()
    else:
        run()
        assert _last_dq(engine, "fail:nps_message_state_missing").status == "pass"
