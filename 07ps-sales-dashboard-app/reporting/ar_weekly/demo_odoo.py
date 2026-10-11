"""An in-memory stand-in for Odoo with realistic receivable data, used by --demo and the tests.

It answers the same read calls as the real XML-RPC API (search_read / read / search / search_count / fields_get)
and evaluates Odoo domains, including dotted paths ("move_id.move_type") and '|' / '&' / '!' operators.
"""
from __future__ import annotations

import datetime as dt
import random
from typing import Any

from odoo_api import OdooClient, OdooError, READ_ONLY_METHODS

TODAY = dt.date(2026, 10, 8)
RELATIONS = {
    ("account.move.line", "move_id"): "account.move", ("account.move.line", "payment_id"): "account.payment",
    ("account.move.line", "partner_id"): "res.partner", ("account.move.line", "company_id"): "res.company",
    ("account.partial.reconcile", "debit_move_id"): "account.move.line",
    ("account.partial.reconcile", "credit_move_id"): "account.move.line",
    ("account.partial.reconcile", "company_id"): "res.company", ("account.move", "payment_id"): "account.payment",
    ("account.move", "journal_id"): "account.journal", ("res.partner", "user_id"): "res.users",
}


def _iso(d: dt.date) -> str:
    return d.isoformat()


class DemoOdoo(OdooClient):
    def __init__(self, seed: int = 7) -> None:  # noqa: D401  (no network)
        self.url, self.db, self.login, self._key = "demo://odoo", "demo", "demo@example.com", "x"
        self.company_ids, self.lang, self.max_retries, self.uid = [1, 3], "en_US", 1, 2
        self._fields_cache = {}
        self.db_ = {m: {} for m in ("res.company", "res.users", "res.partner", "account.journal", "account.move",
                                    "account.move.line", "account.payment", "account.partial.reconcile")}
        self._next = {m: 1 for m in self.db_}
        self.rng = random.Random(seed)
        self._build()

    # -- API surface ---------------------------------------------------------------------------------------------
    def server_version(self) -> str:
        return "17.0 (demo)"

    def authenticate(self) -> int:
        return self.uid

    def call(self, model: str, method: str, args: list | None = None, kwargs: dict | None = None) -> Any:
        if method not in READ_ONLY_METHODS:
            raise OdooError(f"Refused: '{method}' is not a read method")
        args, kwargs = args or [], kwargs or {}
        table = self.db_.get(model)
        if table is None:
            raise OdooError(f"{model}.{method}: unknown model in demo")
        if method == "fields_get":
            keys = set().union(*[r.keys() for r in table.values()]) if table else {"id"}
            return {k: {"type": "char", "string": k} for k in keys}
        if method == "read":
            ids, fields = args[0], kwargs.get("fields")
            return [self._pick(table[i], fields) for i in ids if i in table]
        domain = args[0] if args else []
        rows = [r for r in sorted(table.values(), key=lambda r: r["id"]) if self._match(model, r, domain)]
        if method in ("search_count",):
            return len(rows)
        off, lim = kwargs.get("offset", 0), kwargs.get("limit")
        rows = rows[off: off + lim if lim else None]
        if method == "search":
            return [r["id"] for r in rows]
        return [self._pick(r, kwargs.get("fields")) for r in rows]

    @staticmethod
    def _pick(r: dict, fields: list | None) -> dict:
        return {k: r.get(k, False) for k in (["id"] + [f for f in fields if f != "id"])} if fields else dict(r)

    # -- domain evaluation ---------------------------------------------------------------------------------------
    def _value(self, model: str, rec: dict, path: str) -> Any:
        head, _, rest = path.partition(".")
        v = rec.get(head, False)
        if not rest:
            return v
        rid = v[0] if isinstance(v, list) and v else (v if isinstance(v, int) and v else None)
        target = RELATIONS.get((model, head))
        if not rid or not target or rid not in self.db_[target]:
            return False
        return self._value(target, self.db_[target][rid], rest)

    def _leaf(self, model: str, rec: dict, leaf) -> bool:
        path, op, val = leaf
        v = self._value(model, rec, path)
        if isinstance(v, list) and v and isinstance(v[0], int):
            v = v[0]
        if op == "=":
            return v == val
        if op == "!=":
            return v != val
        if op == "in":
            return v in val
        if op == "not in":
            return v not in val
        if v is False or v is None:
            return False
        return {">": v > val, "<": v < val, ">=": v >= val, "<=": v <= val}[op]

    def _match(self, model: str, rec: dict, domain: list) -> bool:
        stack: list[bool] = []
        for tok in reversed(domain):
            if tok == "|":
                a, b = stack.pop(), stack.pop()
                stack.append(a or b)
            elif tok == "&":
                a, b = stack.pop(), stack.pop()
                stack.append(a and b)
            elif tok == "!":
                stack.append(not stack.pop())
            else:
                stack.append(self._leaf(model, rec, tok))
        return all(stack)

    # -- data generation ---------------------------------------------------------------------------------------
    def _add(self, model: str, **vals) -> dict:
        i = self._next[model]
        self._next[model] += 1
        vals["id"] = i
        self.db_[model][i] = vals
        return vals

    def _build(self) -> None:
        R = self.rng
        majaal_p = self._add("res.partner", name="Majaal Ceramics", commercial_partner_id=False, user_id=False, ref="")
        tika_p = self._add("res.partner", name="TIKA Trading", commercial_partner_id=False, user_id=False, ref="")
        self.c1 = self._add("res.company", name="Majaal", partner_id=[majaal_p["id"], majaal_p["name"]], currency_id=[1, "LYD"])
        self._next["res.company"] = 3  # production ids: Majaal = 1, TIKA = 3
        self.c3 = self._add("res.company", name="TIKA", partner_id=[tika_p["id"], tika_p["name"]], currency_id=[1, "LYD"])
        users = [self._add("res.users", name=n, login=l, email=e) for n, l, e in (
            ("Marwan", "marwan@example.com", "marwan@example.com"),
            ("Salma Ben Ali", "salma@example.com", "salma@example.com"),
            ("Khaled Omar", "khaled", "khaled@example.com"))]
        self.j_sale = self._add("account.journal", name="Customer Invoices", type="sale")
        self.j_bank = self._add("account.journal", name="Bank", type="bank")
        self.j_cash = self._add("account.journal", name="Cash", type="cash")
        self.j_misc = self._add("account.journal", name="Miscellaneous", type="general")
        prefixes = ["Al-Rawabi", "Sahel", "Green Mountain", "Al-Manara", "Dar Al-Bina", "Al-Wafa", "Coastline", "Al-Nakheel",
                    "Medina", "Al-Fajr", "Barqa", "Al-Hilal", "Zahra", "Al-Andalus", "Noor", "Al-Waha", "Jabal", "Al-Saha",
                    "Qasr", "Al-Bayan", "Tibesti", "Al-Marj", "Wadi", "Al-Shorouq", "Fezzan"]
        kinds = ["Contracting", "Tiles & Sanitary", "Developers", "Finishing Works", "Building Supplies", "Home Center",
                 "Interiors", "Ceramic Gallery", "Trading"]
        customers = []
        n = 0
        for u, count in ((users[0], 54), (users[1], 30), (users[2], 22)):
            for _ in range(count):
                name = f"{prefixes[n % len(prefixes)]} {kinds[(n * 7) % len(kinds)]}" + (f" {n // len(prefixes) + 1}" if n >= len(prefixes) else "")
                n += 1
                p = self._add("res.partner", name=name, commercial_partner_id=False, user_id=[u["id"], u["name"]], ref=f"C{1000 + n}")
                p["commercial_partner_id"] = [p["id"], p["name"]]
                customers.append((p, u, R.choice(["good", "good", "slow", "slow", "bad", "very_bad"])))
        # a contact person under a company (lines on the contact must roll up to the commercial partner)
        contact = self._add("res.partner", name="Accounts dept", commercial_partner_id=customers[1][0]["commercial_partner_id"],
                            user_id=False, ref="")
        self.seq = 0
        team_ok, team_x = [1, "Wholesale Tripoli"], [2, "مبيعات BMH"]
        for p, u, behaviour in customers:
            for _ in range(R.randint(1, 3)):
                inv_date = TODAY - dt.timedelta(days=R.randint(1, 170))
                term = R.choice([30, 45, 60])
                amount = round(R.lognormvariate(9.0, 0.55), -1)
                inst = 2 if R.random() < 0.12 else 1
                inv, lines = self._invoice(p, u, inv_date, term, amount, inst, team_ok,
                                           partner_on_line=contact if p is customers[1][0] else p)
                self._pay(p, lines, behaviour)
            if R.random() < 0.08:  # an open credit note
                self._credit_note(p, u, TODAY - dt.timedelta(days=R.randint(5, 40)), round(R.uniform(300, 2500), -1), team_ok)
            if R.random() < 0.07:  # an unapplied customer payment
                self._payment(p, TODAY - dt.timedelta(days=R.randint(1, 20)), round(R.uniform(1000, 6000), -1))
        # in scope but excluded: inter-company and an excluded team
        self._invoice(tika_p | {"commercial_partner_id": [tika_p["id"], tika_p["name"]]}, users[0], TODAY - dt.timedelta(days=80), 30, 250000, 1, team_ok)
        self._invoice(customers[3][0], users[0], TODAY - dt.timedelta(days=70), 30, 12000, 1, team_x)
        # a USD invoice (document currency kept separate)
        self._invoice(customers[5][0], users[0], TODAY - dt.timedelta(days=50), 30, 8000, 1, team_ok, currency=(2, "USD"), rate=4.8)
        # an outbound customer payment: other_receivable, never in the report
        self._payment(customers[2][0], TODAY - dt.timedelta(days=12), 5000, outbound=True)

    def _name(self, prefix: str, d: dt.date) -> str:
        self.seq += 1
        return f"{prefix}/{d:%Y}/{d:%m}/{self.seq:04d}"

    def _invoice(self, p, u, d, term, amount, inst, team, currency=(1, "LYD"), rate=1.0, partner_on_line=None):
        name = self._name("INV", d)
        due = d + dt.timedelta(days=term)
        m = self._add("account.move", name=name, move_type="out_invoice", invoice_user_id=[u["id"], u["name"]], team_id=team,
                      partner_id=[p["id"], p["name"]], commercial_partner_id=p["commercial_partner_id"], company_id=[1, "Majaal"],
                      currency_id=list(currency), invoice_date=_iso(d), invoice_date_due=_iso(due), amount_total=amount,
                      invoice_origin=f"S{self.seq:05d}", ref="", journal_id=[self.j_sale["id"], "Customer Invoices"],
                      payment_id=False, statement_line_id=False)
        lines = []
        part = round(amount / inst, 2)
        for k in range(inst):
            amt = part if k < inst - 1 else round(amount - part * (inst - 1), 2)
            mat = d + dt.timedelta(days=term // inst * (k + 1)) if inst > 1 else due
            pl = partner_on_line or p
            lines.append(self._add("account.move.line", move_id=[m["id"], name], move_name=name, partner_id=[pl["id"], pl["name"]],
                                   company_id=[1, "Majaal"], currency_id=list(currency), date=_iso(d), date_maturity=_iso(mat),
                                   amount_currency=amt, balance=round(amt * rate, 2), amount_residual=round(amt * rate, 2),
                                   amount_residual_currency=amt, account_type="asset_receivable", payment_id=False,
                                   parent_state="posted", reconciled=False, _rate=rate))
        return m, lines

    def _credit_note(self, p, u, d, amount, team):
        name = self._name("RINV", d)
        m = self._add("account.move", name=name, move_type="out_refund", invoice_user_id=[u["id"], u["name"]], team_id=team,
                      partner_id=[p["id"], p["name"]], commercial_partner_id=p["commercial_partner_id"], company_id=[1, "Majaal"],
                      currency_id=[1, "LYD"], invoice_date=_iso(d), invoice_date_due=_iso(d), amount_total=amount, invoice_origin="",
                      ref="Breakage claim", journal_id=[self.j_sale["id"], "Customer Invoices"], payment_id=False, statement_line_id=False)
        return self._add("account.move.line", move_id=[m["id"], name], move_name=name, partner_id=[p["id"], p["name"]],
                         company_id=[1, "Majaal"], currency_id=[1, "LYD"], date=_iso(d), date_maturity=_iso(d), amount_currency=-amount,
                         balance=-amount, amount_residual=-amount, amount_residual_currency=-amount, account_type="asset_receivable",
                         payment_id=False, parent_state="posted", reconciled=False, _rate=1.0)

    def _payment(self, p, d, amount, outbound=False, currency=(1, "LYD"), rate=1.0):
        pay = self._add("account.payment", payment_type="outbound" if outbound else "inbound", partner_type="customer")
        j = self.j_cash if self.rng.random() < 0.3 else self.j_bank
        name = self._name("PBNK", d)
        m = self._add("account.move", name=name, move_type="entry", invoice_user_id=False, team_id=False, partner_id=[p["id"], p["name"]],
                      commercial_partner_id=p["commercial_partner_id"], company_id=[1, "Majaal"], currency_id=list(currency),
                      invoice_date=False, invoice_date_due=False, amount_total=amount, invoice_origin="", ref="",
                      journal_id=[j["id"], j["name"]], payment_id=[pay["id"], name], statement_line_id=False)
        sign = 1 if outbound else -1
        return self._add("account.move.line", move_id=[m["id"], name], move_name=name, partner_id=[p["id"], p["name"]],
                         company_id=[1, "Majaal"], currency_id=list(currency), date=_iso(d), date_maturity=_iso(d),
                         amount_currency=sign * amount, balance=round(sign * amount * rate, 2), amount_residual=round(sign * amount * rate, 2),
                         amount_residual_currency=sign * amount, account_type="asset_receivable", payment_id=[pay["id"], name],
                         parent_state="posted", reconciled=False, _rate=rate)

    def _reconcile(self, debit: dict, credit: dict, amt: float) -> None:
        amt = round(min(amt, debit["amount_residual_currency"], -credit["amount_residual_currency"]), 2)
        if amt <= 0:
            return
        md = max(debit["date"], credit["date"])
        self._add("account.partial.reconcile", debit_move_id=[debit["id"], debit["move_name"]],
                  credit_move_id=[credit["id"], credit["move_name"]], amount=round(amt * debit["_rate"], 2),
                  debit_amount_currency=amt, credit_amount_currency=amt, max_date=md, company_id=[1, "Majaal"])
        for line, s in ((debit, -1), (credit, 1)):
            line["amount_residual_currency"] = round(line["amount_residual_currency"] + s * amt, 2)
            line["amount_residual"] = round(line["amount_residual"] + s * amt * line["_rate"], 2)
            line["reconciled"] = abs(line["amount_residual_currency"]) < 0.005

    def _pay(self, p, lines, behaviour):
        R = self.rng
        for ln in lines:
            due = dt.date.fromisoformat(ln["date_maturity"])
            if behaviour == "good":
                delay, share = R.randint(-10, 12), 1.0
            elif behaviour == "slow":
                delay, share = R.randint(5, 45), R.choice([1.0, 1.0, 0.5])
            elif behaviour == "bad":
                delay, share = R.randint(25, 90), R.choice([1.0, 0.5, 0.3, 0.0])
            else:
                delay, share = R.randint(60, 140), R.choice([0.0, 0.0, 0.25])
            pay_date = due + dt.timedelta(days=delay)
            if share <= 0 or pay_date > TODAY:
                continue
            ccy = tuple(ln["currency_id"])
            amount = round(ln["amount_residual_currency"] * share, 2)
            if R.random() < 0.15:  # pays in two parts, the 2nd one later
                first = round(amount * 0.5, 2)
                pl = self._payment(p, pay_date, first, currency=ccy, rate=ln["_rate"])
                self._reconcile(ln, pl, first)
                d2 = pay_date + dt.timedelta(days=R.randint(5, 25))
                if d2 <= TODAY:
                    pl2 = self._payment(p, d2, amount - first, currency=ccy, rate=ln["_rate"])
                    self._reconcile(ln, pl2, amount - first)
            else:
                pl = self._payment(p, pay_date, amount, currency=ccy, rate=ln["_rate"])
                self._reconcile(ln, pl, amount)
            if R.random() < 0.05 and ln["amount_residual_currency"] > 0:  # small write-off of the remainder
                wo_name = self._name("MISC", pay_date)
                m = self._add("account.move", name=wo_name, move_type="entry", invoice_user_id=False, team_id=False,
                              partner_id=[p["id"], p["name"]], commercial_partner_id=p["commercial_partner_id"], company_id=[1, "Majaal"],
                              currency_id=list(ccy), invoice_date=False, invoice_date_due=False, amount_total=0, invoice_origin="",
                              ref="Write-off", journal_id=[self.j_misc["id"], "Miscellaneous"], payment_id=False, statement_line_id=False)
                rem = ln["amount_residual_currency"]
                wl = self._add("account.move.line", move_id=[m["id"], wo_name], move_name=wo_name, partner_id=[p["id"], p["name"]],
                               company_id=[1, "Majaal"], currency_id=list(ccy), date=_iso(pay_date), date_maturity=_iso(pay_date),
                               amount_currency=-rem, balance=-rem, amount_residual=-rem, amount_residual_currency=-rem,
                               account_type="asset_receivable", payment_id=False, parent_state="posted", reconciled=False, _rate=ln["_rate"])
                self._reconcile(ln, wl, rem)
