"""Finance receivables: transform rules and the finance_receivables job on SQLite with a fake Odoo (no network)."""

from __future__ import annotations

import datetime as _dt
import os
from dataclasses import replace

import pandas as pd
import pytest
from sqlalchemy import text

from core_fixtures import ODOO, PARTNER_COMPANY, WD, FakeOdooSource, write_inputs
from departments.finance import aging
from departments.finance import scope as rscope
from departments.finance import transform as tf
from etl_platform.registry import REGISTRY, load_definitions
from etl_platform.runner import Runner
from sqlite_schema import apply_migration_sqlite

SNAP = _dt.date(2026, 10, 4)


# -- aging --------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("days, key", [(-200, 1), (-61, 1), (-60, 2), (-31, 2), (-30, 3), (-16, 3), (-15, 4), (0, 4), (1, 5),
                                       (30, 5), (31, 6), (60, 6), (61, 7), (90, 7), (91, 8), (900, 8)])
def test_aging_boundaries(days, key):
    assert aging.bucket_key(days) == key


def test_buckets_cover_every_day_once_and_due_today_is_not_overdue():
    aging.validate_buckets()
    frame = aging.bucket_frame().set_index("AgingBucketKey")
    assert frame.loc[4, "is_overdue"] == 0 and frame.loc[5, "is_overdue"] == 1
    with pytest.raises(ValueError, match="gap or overlap"):
        aging.validate_buckets((aging.AgingBucket(1, "a", None, 0), aging.AgingBucket(2, "b", 2, None)))


# -- pure rules ---------------------------------------------------------------------------------------------------------
def test_due_date_prefers_the_instalment_maturity():
    assert tf.due_date("2026-09-01", "2026-10-31", "2026-08-01") == _dt.date(2026, 9, 1)  # never the last instalment
    assert tf.due_date(None, "2026-10-31", "2026-08-01") == _dt.date(2026, 10, 31)
    assert tf.due_date(False, False, "2026-08-01") == _dt.date(2026, 8, 1)


def test_delivery_rollup_stays_in_odoo_values():
    assert tf.rollup_delivery([]) is None  # no order: NULL + has_sales_order = 0, no invented label
    assert tf.rollup_delivery(["full", "full"]) == "full"
    assert tf.rollup_delivery(["pending", None, False]) == "pending"
    assert tf.rollup_delivery(["full", "pending"]) == "partial"
    assert tf.rollup_delivery(["started"]) == "partial"
    assert tf.origin_names(" S001, S002 ,") == ["S001", "S002"]


# -- fake Odoo with receivables ------------------------------------------------------------------------------------------
def _line(i, move, partner, company, maturity, residual, *, date="2026-08-01", currency=102, residual_ccy=None, payment=False):
    return {"id": i, "move_id": [move, f"M{move}"], "move_name": f"M{move}", "partner_id": [partner, "p"] if partner else False,
            "company_id": [company, "c"], "company_currency_id": [102, "LYD"], "currency_id": [currency, "x"], "date": date,
            "date_maturity": maturity, "amount_residual": residual,
            "amount_residual_currency": residual if residual_ccy is None else residual_ccy,
            "payment_id": [payment, "pay"] if payment else False, "write_date": WD}


def _move(i, move_type, company, partner, *, user=False, team=False, term=False, origin=False, due="2026-10-31", inv_date="2026-08-01"):
    return {"id": i, "name": f"DOC/{i}", "move_type": move_type, "state": "posted", "invoice_date": inv_date if move_type != "entry" else False,
            "invoice_date_due": due, "invoice_user_id": [user, "u"] if user else False, "team_id": [team, "t"] if team else False,
            "invoice_origin": origin, "invoice_payment_term_id": [term, "pt"] if term else False, "partner_id": [partner, "p"],
            "commercial_partner_id": [partner, "p"], "company_id": [company, "c"], "currency_id": [102, "LYD"], "amount_total": 1000.0,
            "amount_total_signed": 1000.0, "payment_state": "not_paid", "write_date": WD}


FIN = {k: [dict(r) for r in v] for k, v in ODOO.items()}
FIN["res.company"] = [dict(r, partner_id=[{1: 1, 2: 6251, 3: 9313}[r["id"]], "x"]) for r in FIN["res.company"]]
FIN["res.partner"] = FIN["res.partner"] + [
    {"id": 1, "name": "Majaal", "display_name": "Majaal", "commercial_partner_id": [1, "Majaal"], "parent_id": False, "is_company": True,
     "customer_rank": 1, "supplier_rank": 0, "user_id": False, "company_id": False, "type": "contact", "ref": False, "active": True, "write_date": WD}]
FIN["account.move.line"] = [
    _line(1, 1000, 101, 1, "2026-09-01", 500.0),                    # instalment 1: overdue 33 days
    _line(2, 1000, 101, 1, "2026-10-31", 500.0),                    # instalment 2: not due (-27)
    _line(3, 1001, 100, 3, "2026-10-04", -200.0),                   # credit note due today: NOT overdue
    _line(4, 1002, 100, 1, False, -1000.0, date="2026-09-20", currency=2, residual_ccy=-200.0, payment=77),  # USD unapplied payment
    _line(5, 1003, 102, 1, "2026-06-01", 300.0),                    # invoice without a sales order, 125 days overdue
    _line(6, 1004, 1, 3, "2026-09-30", 999.0),                      # Tika -> Majaal: inter-company
]
FIN["account.move"] = [
    _move(1000, "out_invoice", 1, 100, user=12, team=9, term=8, origin="S001"),
    _move(1001, "out_refund", 3, 100, term=7),
    dict(_move(1002, "entry", 1, 100, due=False), journal_id=[30, "Bank"]),
    _move(1003, "out_invoice", 1, 102, user=13, term=99),
    _move(1004, "out_invoice", 3, 1, user=10, team=27, term=7),
]
FIN["account.payment"] = [{"id": 77, "move_id": [1002, "M1002"], "name": "PBNK1/2026/0001", "payment_type": "inbound", "partner_type": "customer",
                           "state": "posted", "journal_id": [30, "Bank"], "partner_id": [100, "ACME"], "company_id": [1, "Majaal"],
                           "currency_id": [2, "USD"], "date": "2026-09-20", "amount": 200.0, "ref": "advance", "is_reconciled": False,
                           "is_matched": False, "create_uid": [12, "Sara"], "create_date": WD, "write_date": WD}]
FIN["account.journal"] = [{"id": 30, "name": {"en_US": "Bank", "ar_001": "البنك"}, "code": "BNK1", "type": "bank", "company_id": [1, "Majaal"]}]
FIN["sale.order"] = [{"id": 4000, "name": "S001", "company_id": [1, "Majaal"], "delivery_status": "partial", "invoice_ids": [1000], "write_date": WD}]


class FinanceFakeOdoo(FakeOdooSource):
    id_chunk_size = 500

    def search_read_all(self, model, domain, fields, *, order="id", include_archived=False, company_ids=None):
        if model == "sale.order":
            self.calls.append((model, "search"))
            rows = self.data.get(model, [])
            for f, op, v in domain:
                if f == "invoice_ids":
                    rows = [r for r in rows if set(r["invoice_ids"]) & set(v)]
                elif f == "name":
                    rows = [r for r in rows if r["name"] in v]
            return [{k: r.get(k, False) for k in fields} for r in rows]
        return super().search_read_all(model, domain, fields, order=order, include_archived=include_archived, company_ids=company_ids)

    def read_by_ids(self, model, ids, fields, *, include_archived=True):
        wanted = set(ids)
        return [{f: r.get(f, False) for f in fields} for r in self.data.get(model, []) if r["id"] in wanted]


@pytest.fixture
def fin(platform_engine, platform_config, tmp_path, monkeypatch):
    for m in ("0029_core_dimensions.sql", "0030_core_team_map.sql", "0031_sales_mart.sql", "0032_core_odoo_labels.sql",
              "0033_finance_receivables.sql", "0034_finance_receivable_scope.sql",
              "0040_finance_collections.sql", "0042_finance_collection_split.sql"):
        apply_migration_sqlite(platform_engine, m)
    load_definitions()
    for var in ("ODOO_DEBT_LOGIN", "ODOO_DEBT_API_KEY", "ODOO_DEBT_KEY_EXPIRES"):
        monkeypatch.delenv(var, raising=False)
    settings = {"config": replace(platform_config, input_dir=write_inputs(tmp_path / "inputs"), odoo_company_ids=(1, 3))}
    fake = FinanceFakeOdoo(FIN, PARTNER_COMPANY)

    def run(job="finance_receivables", as_of=SNAP, **kw):
        runner = Runner(REGISTRY, platform_engine, settings["config"])
        runner._sources["odoo:default"] = fake
        return runner.run(job, as_of=as_of, trigger_source="test", **kw)

    run("core_dims")
    run.settings = settings  # tests may change the config (e.g. FINANCE_INTERCOMPANY_PARTNER_IDS)
    return platform_engine, run, fake


def _rows(engine, sql):
    with engine.connect() as conn:
        return pd.read_sql(text(sql), conn)


def test_snapshot_rows_follow_the_receivable_rules(fin):
    engine, run, _ = fin
    run()
    f = _rows(engine, "SELECT * FROM fact_finance_receivable_snapshot ORDER BY line_id").set_index("line_id")
    assert len(f) == 6 and set(f["SnapshotDateKey"]) == {20261004}
    # instalment invoice: aged by each line's maturity, never by the move's final due date
    assert f.loc[1, ["days_past_due", "AgingBucketKey", "DueDateKey"]].tolist() == [33, 6, 20260901]
    assert f.loc[2, ["days_past_due", "AgingBucketKey"]].tolist() == [-27, 3]
    assert f.loc[1, ["CustomerKey", "SalespersonKey", "SalesTeamKey", "PaymentTermKey", "delivery_status"]].tolist() == \
        [100, 60, "MJ-EST-BB", 8, "partial"]  # contact 101 -> ACME 100; user 12 -> Sara (60); team 9 -> MJ-EST-BB; Odoo value
    # credit note due today: not overdue, negative, salesperson from the customer of record (no invoice user)
    assert f.loc[3, ["days_past_due", "AgingBucketKey", "residual_company_ccy", "salesperson_source", "PaymentKey"]].tolist() == \
        [0, 4, -200.0, "customer", -1]
    assert f.loc[3, "SalespersonKey"] == 49 and f.loc[3, "SalesTeamKey"] == "-1"  # no team -> Unknown, as Odoo's Sales Team filter sees it (never the salesperson's team)
    # foreign-currency unapplied payment: no maturity -> line date; both currencies kept
    assert f.loc[4, ["PaymentKey", "DueDateKey", "residual_company_ccy", "residual_doc_ccy", "CurrencyKey"]].tolist() == \
        [77, 20260920, -1000.0, -200.0, 2]
    # invoice without a sales order; Odoo user 13 is not in OdooUsers -> -1; unknown term 99 -> customer default (-1)
    assert f.loc[5, ["SalespersonKey", "PaymentTermKey", "AgingBucketKey"]].tolist() == [-1, -1, 8] and pd.isna(f.loc[5, "delivery_status"])
    # inter-company: the customer is Majaal's own partner
    assert f.loc[6, "is_intercompany"] == 1 and f.loc[[1, 2, 3, 4, 5], "is_intercompany"].sum() == 0
    assert "document_type" not in f.columns  # facts keep technical values and keys only
    inv = _rows(engine, "SELECT move_id, move_type, invoice_final_due_date, delivery_status, has_sales_order FROM dim_finance_invoice WHERE move_id > 0 ORDER BY 1")
    assert inv["move_type"].tolist() == ["out_invoice", "out_refund", "entry", "out_invoice", "out_invoice"]
    assert inv["has_sales_order"].tolist() == [1, 0, 0, 0, 0]
    pay = _rows(engine, "SELECT * FROM dim_finance_payment WHERE PaymentKey > 0").iloc[0]
    assert (pay.payment_type, pay.partner_type, pay.journal_name_en, pay.journal_name_ar, pay.memo) == ("inbound", "customer", "Bank", "البنك", "advance")
    assert str(inv.loc[0, "invoice_final_due_date"]) == "2026-10-31"
    assert _rows(engine, "SELECT move_id, SalesOrderKey FROM bridge_finance_invoice_order").values.tolist() == [[1000, 4000]]
    buckets = _rows(engine, "SELECT AgingBucketKey FROM dim_finance_aging_bucket ORDER BY 1")["AgingBucketKey"].tolist()
    assert buckets == [-1, 1, 2, 3, 4, 5, 6, 7, 8]


def test_checks_fallbacks_and_credential_warning(fin, caplog):
    engine, run, _ = fin
    with caplog.at_level("WARNING"):
        run()
    assert any("default read-only ETL Odoo credentials" in r.getMessage() for r in caplog.records)
    dq = _rows(engine, "SELECT check_name, status FROM etl_dq_result WHERE task_name = 'load_receivables'")
    orphans = dq[dq["check_name"].str.startswith("orphan:")]
    assert len(orphans) >= 15 and set(orphans["status"]) == {"pass"}
    # the bridge order 4000 is not in dim_sales_order (no sales load in this test): a warning, not a failure
    assert dq.set_index("check_name").loc["warn:bridge_finance_invoice_order.order_not_in_sale_order_list", "status"] == "warn"
    details = _rows(engine, "SELECT details FROM etl_task_log WHERE task_name = 'load_receivables'").iloc[0, 0]
    assert '"bridged_orders_not_in_fact_sales_orders": 1' in details  # information only
    assert not dq["check_name"].str.startswith("sanity:").any()  # first snapshot: sanity checks start with the second
    log = _rows(engine, "SELECT fallback_detail FROM etl_task_log WHERE task_name = 'load_receivables'")
    assert '"13"' in log.iloc[0, 0]  # Odoo user 13 not in OdooUsers, reported
    run_log = _rows(engine, "SELECT department, job_name, status FROM etl_run_log WHERE job_name = 'finance_receivables'")
    assert run_log.values.tolist() == [["finance", "finance_receivables", "success"]]


def test_an_odoo_team_that_follows_the_salesperson_keeps_its_own_name(fin):
    """EXPORT (crm.team 27) is SALESPERSON in OdooTeams: sales uses the salesperson's team, receivables its own team."""
    engine, run, fake = fin
    fake.data["account.move"] = [dict(r, team_id=[27, "EXPORT"]) if r["id"] == 1003 else r for r in fake.data["account.move"]]
    run()
    f = _rows(engine, "SELECT f.line_id, f.SalesTeamKey, st.SalesTeam, st.CompanyKey, st.SegmentKey FROM fact_finance_receivable_snapshot f "
                      "JOIN dim_sales_team st ON st.SalesTeamKey = f.SalesTeamKey ORDER BY f.line_id").set_index("line_id")
    assert f.loc[5, "SalesTeamKey"] == "ODOO-TEAM-27" and f.loc[5, "SalesTeam"] == "EXPORT"
    assert int(f.loc[5, "CompanyKey"]) == 3 and int(f.loc[5, "SegmentKey"]) == -1
    assert f.loc[3, "SalesTeamKey"] == "-1"  # a document without an Odoo team (credit note 1001) stays Unknown
    inv = _rows(engine, "SELECT SalesTeamKey FROM dim_finance_invoice WHERE move_id = 1003")
    assert inv.iloc[0, 0] == "ODOO-TEAM-27"


def test_rerun_of_the_same_day_replaces_that_day(fin):
    engine, run, _ = fin
    run()
    run()
    assert _rows(engine, "SELECT COUNT(*) AS n FROM fact_finance_receivable_snapshot").iloc[0, 0] == 6
    details = _rows(engine, "SELECT details FROM etl_task_log WHERE task_name = 'load_receivables' ORDER BY started_at_utc")["details"].tolist()
    assert '"replaced_rows_of_same_day": 6' in details[-1]


def test_second_snapshot_runs_the_sanity_checks_and_a_large_change_fails(fin):
    engine, run, fake = fin
    run()
    run(as_of=SNAP + _dt.timedelta(days=1))  # same data: passes, history kept
    assert _rows(engine, "SELECT COUNT(DISTINCT SnapshotDateKey) AS n FROM fact_finance_receivable_snapshot").iloc[0, 0] == 2
    fake.data["account.move.line"] = [dict(r, amount_residual=r["amount_residual"] * 10) for r in fake.data["account.move.line"]]
    with pytest.raises(Exception):
        run(as_of=SNAP + _dt.timedelta(days=2))
    assert _rows(engine, "SELECT COUNT(*) AS n FROM fact_finance_receivable_snapshot WHERE SnapshotDateKey = 20261006").iloc[0, 0] == 0
    dq = _rows(engine, "SELECT check_name, status FROM etl_dq_result WHERE check_name = 'sanity:receivable_open_amount_change' ORDER BY dq_result_id")
    assert dq["status"].tolist()[-1] == "fail"


def test_debt_profile_is_used_once_configured(fin, monkeypatch):
    engine, run, fake = fin
    monkeypatch.setenv("ODOO_DEBT_LOGIN", "bot@example.invalid")
    monkeypatch.setenv("ODOO_DEBT_API_KEY", "test-not-a-key")
    from departments.finance import jobs as fj

    class Ctx:
        job = type("J", (), {"name": "finance_receivables"})()
        state: dict = {}

        def odoo(self, profile):
            return f"source:{profile}"

    ctx = Ctx()
    assert fj.finance_source(ctx) == "source:debt" and ctx.state["odoo_profile"] == "debt"


# -- receivable scope (decision A2) and configured inter-company partners (decision A1) -------------------------------------
@pytest.mark.parametrize("move_type, payment_type, partner_type, expected", [
    ("out_invoice", None, None, "customer_debt"),       # customer invoice
    ("out_refund", None, None, "customer_debt"),        # customer credit note
    ("out_receipt", None, None, "customer_debt"),       # sales receipt
    ("entry", "inbound", "customer", "customer_debt"),  # Receive / Customer
    ("entry", "outbound", "customer", "other_receivable"),  # Send / Customer (withdrawals, salaries, custody...)
    ("entry", "outbound", "supplier", "other_receivable"),  # Send / Vendor
    ("entry", "inbound", "supplier", "other_receivable"),   # Receive / Vendor
    ("entry", None, None, "other_receivable"),          # journal entry without an invoice
    (None, None, None, "other_receivable"),             # move not returned by Odoo
])
def test_receivable_scope_rules(move_type, payment_type, partner_type, expected):
    assert rscope.receivable_scope(move_type, payment_type, partner_type) == expected


def test_scope_definitions_are_complete():
    rscope.validate_scopes()
    frame = rscope.scope_frame()
    assert frame["receivable_scope"].tolist() == ["customer_debt", "other_receivable"]
    assert frame["is_default"].tolist() == [1, 0] and frame["label_ar"].notna().all()


def test_snapshot_carries_the_scope_and_the_scope_dimension(fin):
    engine, run, fake = fin
    run()
    f = _rows(engine, "SELECT line_id, receivable_scope, is_intercompany FROM fact_finance_receivable_snapshot ORDER BY line_id").set_index("line_id")
    # invoices, the credit note and the inbound customer payment are customer debt; inter-company stays a separate flag
    assert f["receivable_scope"].tolist() == ["customer_debt"] * 6 and f.loc[6, "is_intercompany"] == 1
    dim = _rows(engine, "SELECT receivable_scope, is_default, label_en FROM dim_finance_receivable_scope ORDER BY sort_order")
    assert dim.values.tolist() == [["customer_debt", 1, "Customer debt"], ["other_receivable", 0, "Other receivable entries"]]
    dq = _rows(engine, "SELECT status FROM etl_dq_result WHERE check_name = 'orphan:fact_finance_receivable_snapshot.receivable_scope'")
    assert dq["status"].tolist() == ["pass"]

    # an outbound customer payment and a plain journal entry -> other_receivable; with every scope the total is unchanged
    fake.data["account.move.line"] = fake.data["account.move.line"] + [
        _line(7, 1005, 100, 1, False, 750.0, date="2026-09-10", payment=78), _line(8, 1006, 100, 1, False, -50.0, date="2026-09-11")]
    fake.data["account.move"] = fake.data["account.move"] + [dict(_move(1005, "entry", 1, 100, due=False), journal_id=[30, "Bank"]),
                                                             _move(1006, "entry", 1, 100, due=False)]
    fake.data["account.payment"] = fake.data["account.payment"] + [dict(fake.data["account.payment"][0], id=78, move_id=[1005, "M1005"],
                                                                        payment_type="outbound", ref="withdrawal")]
    try:
        run()
    finally:
        fake.data.update({k: FIN[k] for k in ("account.move.line", "account.move", "account.payment")})
    g = _rows(engine, "SELECT receivable_scope, is_intercompany, SUM(residual_company_ccy) AS net, COUNT(*) AS n "
                      "FROM fact_finance_receivable_snapshot GROUP BY receivable_scope, is_intercompany ORDER BY 1, 2")
    assert g.values.tolist() == [["customer_debt", 0, 100.0, 5], ["customer_debt", 1, 999.0, 1], ["other_receivable", 0, 700.0, 2]]
    details = _rows(engine, "SELECT details FROM etl_task_log WHERE task_name = 'load_receivables' ORDER BY started_at_utc").iloc[-1, 0]
    assert '"open_amount_net_default_view": 100.0' in details and '"other_receivable": {"rows": 2, "net": 700.0}' in details


def test_configured_intercompany_partners_are_flagged(fin):
    engine, run, _ = fin
    run.settings["config"] = replace(run.settings["config"], finance_intercompany_partner_ids=(102,))
    run()
    f = _rows(engine, "SELECT line_id, CustomerKey, is_intercompany FROM fact_finance_receivable_snapshot ORDER BY line_id").set_index("line_id")
    assert f.loc[5, "is_intercompany"] == 1 and f.loc[6, "is_intercompany"] == 1  # configured partner 102 + Majaal's own partner
    assert f.loc[[1, 2, 3, 4], "is_intercompany"].sum() == 0
    details = _rows(engine, "SELECT details FROM etl_task_log WHERE task_name = 'load_receivables'").iloc[0, 0]
    assert '"intercompany_partner_ids_configured": [102]' in details


# -- Aged Receivable comparison ------------------------------------------------------------------------------------------
def test_aged_receivable_export_is_parsed_and_compared(tmp_path):
    import sys

    sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1] / "scripts" / "finance"))
    import compare_aged_receivable as car

    sheet = pd.DataFrame([["Aged Receivable", None, None, None, None, None, None, None],
                          [None, "At Date", "1-30", "31-60", "61-90", "91-120", "Older", "Total"],
                          ["ACME Building", 500.0, None, 500.0, None, None, None, 1000.0],
                          ["Gone Customer", None, 10.0, None, None, None, None, 10.0],
                          ["Total", 500.0, 10.0, 500.0, None, None, None, 1010.0]])
    path = tmp_path / "aged.xlsx"
    sheet.to_excel(path, header=False, index=False)
    odoo = car.read_export(path)
    assert odoo.set_index("customer").loc["ACME Building", ["not_due", "d31_60", "total"]].tolist() == [500.0, 500.0, 1000.0]
    ours = pd.DataFrame([{"customer": "acme  building", "CustomerKey": 100, **{c: 0.0 for c in car.COLUMNS}, "not_due": 500.0,
                          "d31_60": 450.0, "total": 950.0}])
    r = car.compare(odoo, ours).set_index("customer")
    assert r.loc["ACME Building", "matched"] == "both" and r.loc["ACME Building", "total_delta"] == -50.0
    assert r.loc["Gone Customer", "matched"] == "odoo_only"


def test_odoo_labels_are_stored_in_english_and_arabic(fin):
    engine, _, _ = fin  # core_dims ran in the fixture
    labels = _rows(engine, "SELECT model, field, value, label_en, label_ar, label_language_ar FROM dim_odoo_selection_label")
    lab = labels.set_index(["model", "field", "value"])
    assert lab.loc[("account.move", "move_type", "out_refund"), ["label_en", "label_ar"]].tolist() == ["Customer Credit Note", "إشعار دائن للعميل"]  # trimmed
    assert lab.loc[("account.payment", "payment_type", "outbound"), "label_en"] == "Send"
    assert set(labels["label_language_ar"]) == {"ar_001"}


def test_english_only_when_arabic_is_not_active():
    from core.labels import arabic_language, build_labels

    assert arabic_language(["en_US"]) is None and arabic_language(["en_US", "ar_001"]) == "ar_001"
    per_lang = {"en_US": {"account.payment": {"payment_type": {"string": "Payment Type", "selection": [["inbound", "Receive"]]}}}}
    frame = build_labels(per_lang, "en_US", None)
    assert frame.loc[0, "label_en"] == "Receive" and frame.loc[0, "label_ar"] is None


def test_recount_reports_lines_posted_during_the_read():
    from departments.finance import jobs as fj

    class Src:
        def search_ids(self, model, domain, include_archived=True):
            return [1, 2, 3, 99]  # 99 posted while the pages were read; 4 was reconciled meanwhile

    r = fj.recount_lines(Src(), [], {1, 2, 3, 4})
    assert (r["appeared_count"], r["closed_count"], r["appeared_during_read"], r["closed_during_read"]) == (1, 1, [99], [4])
