"""Checks on the sample data:  python tests/test_report.py   (or: pytest tests)

1. the balance of every line rebuilt for a past date equals the true balance from the full history
2. every week reconciles: start - collected - credit notes - other + new overdue = end
3. KPI arithmetic: overdue + not due = outstanding, aging buckets add up to overdue
4. scope: inter-company, excluded team and outbound payments are out; currencies never mixed
"""
from __future__ import annotations

import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from demo_odoo import DemoOdoo  # noqa: E402
from engine import rep_report, residual_at  # noqa: E402
from extract import extract  # noqa: E402
from settings import Settings  # noqa: E402

AS_OF = dt.date(2026, 10, 3)


def _setup():
    odoo = DemoOdoo()
    s = Settings(company_ids=[1, 3], intercompany_partner_ids=[], exclude_team_names=["مبيعات BMH"])
    data = extract(odoo, s, AS_OF - dt.timedelta(days=28))
    return odoo, s, data


def test_residual_rebuild_matches_history():
    odoo, s, data = _setup()
    all_partials = list(odoo.db_["account.partial.reconcile"].values())
    aml = odoo.db_["account.move.line"]
    for d in [AS_OF - dt.timedelta(days=7 * k) for k in range(5)]:
        rebuilt = residual_at(data.lines, data.partials, d)
        for (_, line), got in zip(data.lines.iterrows(), rebuilt):
            raw = aml[line["line_id"]]
            if dt.date.fromisoformat(raw["date"]) > d:
                assert got == 0
                continue
            truth = raw["amount_currency"]
            for p in all_partials:
                if p["max_date"] <= d.isoformat():
                    if p["debit_move_id"][0] == raw["id"]:
                        truth -= p["debit_amount_currency"]
                    if p["credit_move_id"][0] == raw["id"]:
                        truth += p["credit_amount_currency"]
            assert abs(round(truth, 2) - got) < 0.01, (raw["move_name"], d, truth, got)


def test_weeks_reconcile_and_kpis_add_up():
    _, s, data = _setup()
    lines = data.lines[data.lines["excluded"].isna()]
    n = 0
    for _, grp in lines.groupby(["rep_id", "currency"]):
        r = rep_report(grp.reset_index(drop=True), data.partials, AS_OF, s)
        for w in r.weeks:
            assert abs(w.unexplained) < 0.01, (r.rep, w)
        k = r.kpi
        assert abs(k["overdue"] + k["not_due"] - k["gross"]) < 0.01
        assert abs(r.aging["Amount Past Due"].sum() - k["overdue"]) < 0.01
        assert abs(r.aging["% of Overdue"].sum() - 1) < 1e-9 or k["overdue"] == 0
        assert r.week.end_overdue == round(k["overdue"], 2)          # the tracker ends where the KPIs are
        assert r.weeks[1].end_overdue == r.week.start_overdue          # weeks chain
        assert list(r.priority["bucket"]) == sorted(r.priority["bucket"], reverse=True)
        n += 1
    assert n >= 3


def test_scope():
    odoo, s, data = _setup()
    assert set(data.lines["excluded"].dropna()) == {"intercompany", "team: مبيعات BMH"}
    outbound = [l["id"] for l in odoo.db_["account.move.line"].values()
                if l["payment_id"] and odoo.db_["account.payment"][l["payment_id"][0]]["payment_type"] == "outbound"]
    assert outbound and not set(outbound) & set(data.lines["line_id"])
    assert set(data.lines["currency"]) == {"LYD", "USD"}
    # a line booked on a contact person is reported under the company
    assert "Accounts dept" not in set(data.lines["customer"])


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
