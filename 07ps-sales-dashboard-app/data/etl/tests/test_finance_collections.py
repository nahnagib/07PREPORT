"""Collections transform (departments/finance/collections.py): allocation rows, overdue / not yet due / other / unapplied
split, attribution, and the rows of every payment adding up to the payment. Pure: no Odoo, no database."""

from __future__ import annotations

import datetime as _dt

import pytest

from core.resolve import KeyMaps
from departments.finance import collections as col

MAPS = KeyMaps(
    partner_customer={500: 500, 501: 501, 502: 502, 900: 900},
    user_salesperson={10: 1, 20: 2},
    team_map={7: ("TEAM-A", False), 8: ("TEAM-B", False)},
    salesperson_team={1: "TEAM-A", 2: "TEAM-B", 3: "TEAM-C"},
    company_keys={1, 3},
)
INPUTS = col.CollectionInputs(currency_keys={102, 2}, customer_salesperson={500: 3, 501: -1, 900: 1}, intercompany_customers={900})


def pay(i, amount, *, partner=500, date="2026-09-15", state="posted", transfer=False, ccy=102, company_amount=None):
    return {"id": i, "name": f"PAY{i}", "date": date, "state": state, "partner_id": [partner, "p"], "company_id": [1, "Majaal"],
            "currency_id": [ccy, "c"], "amount": amount, "amount_company_currency_signed": amount if company_amount is None else company_amount,
            "is_internal_transfer": transfer}


def pline(line_id, payment_id):
    return {"id": line_id, "payment_id": [payment_id, "p"], "account_type": "asset_receivable"}


def partial(i, debit_line, credit_line, amount, max_date="2026-09-15"):
    return {"id": i, "debit_move_id": [debit_line, "d"], "credit_move_id": [credit_line, "c"], "amount": amount,
            "credit_amount_currency": amount, "debit_amount_currency": amount, "max_date": max_date}


DEBIT_LINES = {
    1001: {"id": 1001, "move_id": [2001, "INV1"], "date": "2026-08-01", "date_maturity": "2026-09-01"},   # overdue on 15 Sep
    1002: {"id": 1002, "move_id": [2002, "INV2"], "date": "2026-09-10", "date_maturity": "2026-10-10"},   # not yet due
    1003: {"id": 1003, "move_id": [2003, "INV3"], "date": "2026-08-15", "date_maturity": "2026-09-15"},   # due on the day
    1004: {"id": 1004, "move_id": [2004, "MISC"], "date": "2025-12-31", "date_maturity": False},          # opening balance
    1005: {"id": 1005, "move_id": [2005, "INV5"], "date": "2026-07-01", "date_maturity": False},          # due from the invoice
}
DEBIT_MOVES = {
    2001: {"id": 2001, "name": "INV1", "move_type": "out_invoice", "invoice_user_id": [10, "u"], "team_id": [7, "t"], "invoice_date_due": "2026-09-01"},
    2002: {"id": 2002, "name": "INV2", "move_type": "out_invoice", "invoice_user_id": [20, "u"], "team_id": [8, "t"], "invoice_date_due": "2026-10-10"},
    2003: {"id": 2003, "name": "INV3", "move_type": "out_invoice", "invoice_user_id": [10, "u"], "team_id": [7, "t"], "invoice_date_due": "2026-09-15"},
    2004: {"id": 2004, "name": "MISC", "move_type": "entry", "invoice_user_id": False, "team_id": False, "invoice_date_due": False},
    2005: {"id": 2005, "name": "INV5", "move_type": "out_invoice", "invoice_user_id": False, "team_id": False, "invoice_date_due": "2026-08-01"},
}


def build(payments, lines=(), partials=()):
    return col.build_collections(list(payments), list(lines), list(partials), DEBIT_LINES, DEBIT_MOVES, MAPS, INPUTS)


def rows_of(b, payment_id):
    return b.fact[b.fact["payment_id"] == payment_id].to_dict("records")


def test_fully_matched_payment_splits_by_salesperson_and_due_state():
    b = build([pay(1, 1000)], [pline(11, 1)], [partial(1, 1001, 11, 600), partial(2, 1002, 11, 400)])
    r = rows_of(b, 1)
    assert [(x["SalespersonKey"], x["SalesTeamKey"], x["attribution"]) for x in r] == [(1, "TEAM-A", "invoice"), (2, "TEAM-B", "invoice")]
    assert r[0]["applied_overdue_doc_ccy"] == 600 and r[0]["applied_not_due_doc_ccy"] == 0
    assert r[1]["applied_not_due_doc_ccy"] == 400 and r[1]["applied_overdue_doc_ccy"] == 0
    assert sum(x["amount_doc_ccy"] for x in r) == pytest.approx(1000)
    assert [x["share"] for x in r] == [pytest.approx(0.6), pytest.approx(0.4)]
    assert b.matches["allocation_no"].tolist() == [1, 2]
    assert b.matches["kind"].tolist() == ["overdue", "not_due"]


def test_due_on_the_payment_day_is_not_yet_due_and_missing_maturity_uses_the_invoice_due_date():
    b = build([pay(2, 300)], [pline(12, 2)], [partial(3, 1003, 12, 100), partial(4, 1005, 12, 200)])
    r = rows_of(b, 2)
    by_sp = {x["SalespersonKey"]: x for x in r}
    assert by_sp[1]["applied_not_due_doc_ccy"] == 100                  # INV3 due 15 Sep, paid 15 Sep
    assert by_sp[-1]["applied_overdue_doc_ccy"] == 200                 # INV5: no maturity -> invoice due 1 Aug -> overdue
    assert by_sp[-1]["attribution"] == "invoice"                      # an invoice without a user stays -1 (Debt Report rule)


def test_partly_matched_payment_puts_the_rest_on_the_customer_salesperson():
    b = build([pay(3, 1000)], [pline(13, 3)], [partial(5, 1001, 13, 250), partial(6, 1004, 13, 50)])
    r = rows_of(b, 3)
    assert len(r) == 2
    inv, rest = r
    assert inv["attribution"] == "invoice" and inv["applied_overdue_doc_ccy"] == 250
    assert rest["attribution"] == "customer" and rest["SalespersonKey"] == 3 and rest["SalesTeamKey"] == "TEAM-C"
    assert rest["applied_other_doc_ccy"] == 50 and rest["unapplied_doc_ccy"] == pytest.approx(700)
    assert inv["amount_doc_ccy"] + rest["amount_doc_ccy"] == pytest.approx(1000)
    assert b.matches.set_index("partial_id").loc[6, "allocation_no"] == 2  # the "other" match sits in the customer row


def test_unmatched_payment_of_a_customer_without_salesperson_is_none():
    b = build([pay(4, 80, partner=501)])
    (r,) = rows_of(b, 4)
    assert r["attribution"] == "none" and r["SalespersonKey"] == -1 and r["SalesTeamKey"] == "-1"
    assert r["unapplied_doc_ccy"] == 80 and r["share"] == 1


def test_only_posted_payments_that_are_not_internal_transfers_count():
    b = build([pay(5, 10, state="draft"), pay(6, 10, state="cancel"), pay(7, 10, transfer=True), pay(8, 0)])
    assert b.fact.empty
    assert b.stats["skipped"] == {"not_posted": 2, "internal_transfer": 1, "zero_amount": 1}


def test_company_amount_follows_the_share_and_currency_stays_the_payment_currency():
    b = build([pay(9, 100, ccy=2, company_amount=1000)], [pline(19, 9)], [partial(7, 1001, 19, 40)])
    r = rows_of(b, 9)
    assert [x["CurrencyKey"] for x in r] == [2, 2]
    assert [x["amount_company_ccy"] for x in r] == [pytest.approx(400), pytest.approx(600)]


def test_applied_more_than_the_payment_is_scaled_back():
    b = build([pay(10, 100)], [pline(20, 10)], [partial(8, 1001, 20, 60), partial(9, 1002, 20, 60.004)])
    r = rows_of(b, 10)
    assert sum(x["amount_doc_ccy"] for x in r) == pytest.approx(100)
    assert b.stats["skipped"].get("applied_scaled_to_amount") == 1
    assert b.matches["applied_doc_ccy"].sum() == pytest.approx(100)


def test_intercompany_customer_is_flagged_and_unknown_partner_falls_back():
    b = build([pay(11, 5, partner=900), pay(12, 5, partner=777)])
    assert rows_of(b, 11)[0]["is_intercompany"] == 1
    assert rows_of(b, 12)[0]["CustomerKey"] == -1
    assert b.fallbacks["fact_finance_collection.CustomerKey (partner id)"] == [777]


def test_a_rounding_residue_stays_in_the_payment_so_rows_add_up_exactly():
    b = build([pay(14, 1300)], [pline(24, 14)], [partial(10, 1002, 24, 1299.996)])
    (r,) = rows_of(b, 14)
    assert r["amount_doc_ccy"] == pytest.approx(1300, abs=1e-9) and r["share"] == 1
    assert r["applied_not_due_doc_ccy"] == pytest.approx(1299.996) and r["unapplied_doc_ccy"] == pytest.approx(0.004)


def test_payment_date_key_is_the_payment_date():
    (r,) = rows_of(build([pay(13, 5, date="2026-09-30")]), 13)
    assert r["PaymentDateKey"] == 20260930 and r["payment_date"] == _dt.date(2026, 9, 30)
