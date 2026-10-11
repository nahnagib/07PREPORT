"""Receivables: raw Odoo frames -> conformed invoice and payment dimensions, invoice->order bridge, snapshot rows. Pure.

Rules (docs/receivables-etl.md; spec of 2026-10-01, decisions of 2026-10-04):
  * grain: one open receivable journal item (account.move.line) per snapshot date;
  * due date: line.date_maturity, else move.invoice_date_due, else line.date -- never invoice_date_due when
    date_maturity exists (for instalment terms invoice_date_due is the LAST instalment);
  * days_past_due = snapshot date - due date; due today is NOT overdue; bucket from aging.AGING_BUCKETS;
  * labels: NONE here. Facts and dimensions keep Odoo's technical values (move_type, payment_type, partner_type,
    payment_state, state, delivery_status); labels come from dim_odoo_selection_label (core.labels);
  * amounts keep Odoo's sign: credit notes and inbound payments negative;
  * customer: the line partner's commercial partner (map_partner_customer, as sales);
  * salesperson: move.invoice_user_id through sheet OdooUsers -- for customer invoices and credit notes ONLY that,
    as Odoo's Salesperson filter sees it (decision 2026-10-08): no user -> -1 Unassigned; for every other line (payments,
    entries) with no user, the customer's salesperson of record (partner.user_id through OdooUsers), so payments net
    against invoices per salesperson in the customer table;
  * team: move.team_id through sheet OdooTeams (crm.team id, never the name) -- the document's OWN team, as Odoo's
    Sales Team filter sees it, never the salesperson's team (decision 2026-10-06, so the report and Odoo filter the
    same documents): no team -> '-1' Unknown; a team whose OdooTeams row says SALESPERSON (it has no Excel org team,
    e.g. 27 EXPORT) -> its own member 'ODOO-TEAM-<id>', named after the Odoo team (decision 2026-10-08; sales keeps
    the salesperson's team for those); an Odoo team missing from OdooTeams -> '-1';
  * payment term: move.invoice_payment_term_id, else the customer's default term for that company;
  * delivery status (customer invoices only): the invoice's sale orders (sale.order.invoice_ids; else invoice_origin
    names in the same company), rolled up in Odoo's own values: every order 'full' -> full; no order delivered at
    all ('pending' / empty) -> pending; anything else -> partial; no order -> NULL with has_sales_order = 0;
  * inter-company: the customer is the partner of one of our own companies, or one of the configured inter-company
    partners (FINANCE_INTERCOMPANY_PARTNER_IDS, e.g. "مديونية شركة تيكا") -> is_intercompany = 1;
  * receivable_scope: customer_debt | other_receivable from Odoo's technical values (scope.py, the one place the
    rules live). Inter-company stays its own flag, independent of the scope.
"""

from __future__ import annotations

import datetime as _dt
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping

import pandas as pd

from core.keys import UNKNOWN
from core.resolve import KeyMaps, _int_or_none
from departments.finance.aging import AGING_BUCKETS, bucket_key
from departments.finance.scope import CUSTOMER_DEBT, RECEIVABLE_SCOPES, receivable_scope

FULL, PARTIAL, PENDING = "full", "partial", "pending"  # Odoo sale.order.delivery_status values


@dataclass
class FinanceInputs:
    """Lookups the transform needs besides KeyMaps (all read from the core dimensions)."""
    currency_keys: set[int]
    payment_term_keys: set[int]
    customer_salesperson: Mapping[int, int]  # CustomerKey -> SalespersonKey of record
    customer_company_term: Mapping[tuple[int, int], int]  # (CustomerKey, CompanyKey) -> default PaymentTermKey
    own_company_customers: set[int]  # CustomerKeys of our own companies' partners
    # CustomerKeys of the configured inter-company partners (FINANCE_INTERCOMPANY_PARTNER_IDS)
    configured_intercompany_customers: set[int] = field(default_factory=set)

    @property
    def intercompany_customers(self) -> set[int]:
        return set(self.own_company_customers) | set(self.configured_intercompany_customers)


@dataclass
class FinanceBuild:
    fact: pd.DataFrame
    invoices: pd.DataFrame
    payments: pd.DataFrame
    bridge: pd.DataFrame
    fallbacks: dict[str, list[Any]] = field(default_factory=dict)
    stats: dict[str, Any] = field(default_factory=dict)

    def fell(self, key: str, ids: Iterable[Any]) -> None:
        ids = [i for i in ids if i is not None]
        if ids:
            self.fallbacks.setdefault(key, []).extend(ids)


def _scratch() -> FinanceBuild:
    return FinanceBuild(pd.DataFrame(), pd.DataFrame(), pd.DataFrame(), pd.DataFrame())


def _date(v: Any) -> _dt.date | None:
    if v is None or v is False or v == "" or (not isinstance(v, (str, _dt.date)) and pd.isna(v)):
        return None
    if isinstance(v, _dt.datetime):
        return v.date()
    if isinstance(v, _dt.date):
        return v
    return pd.to_datetime(v).date()


def due_date(date_maturity: Any, invoice_date_due: Any, line_date: Any) -> _dt.date | None:
    return _date(date_maturity) or _date(invoice_date_due) or _date(line_date)


def date_key(d: _dt.date | None) -> int:
    return UNKNOWN if d is None else d.year * 10000 + d.month * 100 + d.day


def rollup_delivery(statuses: list[Any]) -> str | None:
    """Odoo delivery_status values of an invoice's orders -> one value in Odoo's terms; None when no order."""
    if not statuses:
        return None
    values = [s if isinstance(s, str) and s else PENDING for s in statuses]
    if all(v == FULL for v in values):
        return FULL
    if all(v == PENDING for v in values):
        return PENDING
    return PARTIAL


def origin_names(invoice_origin: Any) -> list[str]:
    if not isinstance(invoice_origin, str):
        return []
    return [p.strip() for p in invoice_origin.split(",") if p.strip()]


INVOICE_MOVE_TYPES = ("out_invoice", "out_refund")


def _salespeople(maps: KeyMaps, inputs: FinanceInputs, out: FinanceBuild, scope: str, user_ids: list[Any],
                 customer_keys: list[int], move_types: list[Any] | None = None) -> tuple[list[int], list[str]]:
    """``move_types``: when given, a customer invoice / credit note without a user stays -1 (Odoo's own Salesperson)."""
    keys, sources, fell = [], [], []
    for n, (u, c) in enumerate(zip(user_ids, customer_keys)):
        uid = _int_or_none(u)
        if uid is not None:
            k = maps.user_salesperson.get(uid, UNKNOWN)
            if k == UNKNOWN:
                fell.append(uid)
            keys.append(k)
            sources.append("invoice_user")
        elif move_types is not None and move_types[n] in INVOICE_MOVE_TYPES:
            keys.append(UNKNOWN)
            sources.append("none")
        else:
            k = inputs.customer_salesperson.get(int(c), UNKNOWN)
            keys.append(k)
            sources.append("customer" if k != UNKNOWN else "none")
    out.fell(f"{scope}.SalespersonKey (Odoo user not in OdooUsers)", fell)
    return keys, sources


def _payment_terms(inputs: FinanceInputs, out: FinanceBuild, scope: str, term_ids: list[Any], customers: list[int],
                   companies: list[int]) -> list[int]:
    keys, fell = [], []
    for t, c, co in zip(term_ids, customers, companies):
        tid = _int_or_none(t)
        if tid is not None and tid in inputs.payment_term_keys:
            keys.append(tid)
            continue
        if tid is not None:
            fell.append(tid)
        keys.append(inputs.customer_company_term.get((int(c), int(co)), UNKNOWN))
    out.fell(f"{scope}.PaymentTermKey (Odoo payment term not in dim_payment_term)", fell)
    return keys


def _currencies(inputs: FinanceInputs, out: FinanceBuild, scope: str, ids: list[Any]) -> list[int]:
    keys, fell = [], []
    for v in ids:
        cid = _int_or_none(v)
        if cid is not None and cid in inputs.currency_keys:
            keys.append(cid)
        else:
            keys.append(UNKNOWN)
            if cid is not None:
                fell.append(cid)
    out.fell(f"{scope}.CurrencyKey (currency id)", fell)
    return keys


def delivery_by_move(moves: pd.DataFrame, so_inv: pd.DataFrame, origin_orders: pd.DataFrame) -> dict[int, tuple[str | None, int]]:
    """(rolled-up delivery_status, has_sales_order) per customer-invoice move; (None, 0) for every other move."""
    by_move: dict[int, list[Any]] = {}
    for r in so_inv.itertuples(index=False):
        by_move.setdefault(int(r.move_id), []).append(r.delivery_status)
    by_name = {(str(r.name), _int_or_none(r.company_id)): r.delivery_status for r in origin_orders.itertuples(index=False)} \
        if len(origin_orders) else {}
    out: dict[int, tuple[str | None, int]] = {}
    for m in moves.itertuples(index=False):
        if m.move_type != "out_invoice":
            out[int(m.id)] = (None, 0)
            continue
        statuses = by_move.get(int(m.id))
        if not statuses:
            key = _int_or_none(m.company_id)
            statuses = [by_name[(n, key)] for n in origin_names(m.invoice_origin) if (n, key) in by_name]
        out[int(m.id)] = (rollup_delivery(statuses), int(bool(statuses)))
    return out


def build_payments(payments: pd.DataFrame, journals: pd.DataFrame, maps: KeyMaps, inputs: FinanceInputs) -> pd.DataFrame:
    if not len(payments):
        return pd.DataFrame(columns=["PaymentKey"])
    jn = journals.set_index("id") if len(journals) else pd.DataFrame(columns=["name_en", "name_ar"])
    companies, _ = maps.companies(list(payments["company_id"]))
    return pd.DataFrame({
        "PaymentKey": payments["id"].astype("int64").to_numpy(),
        "payment_reference": payments["name"].to_numpy(),
        "payment_type": payments["payment_type"].to_numpy(),
        "partner_type": payments["partner_type"].to_numpy(),
        "state": payments["state"].to_numpy(),
        "journal_id": [_int_or_none(j) for j in payments["journal_id"]],
        "journal_name_en": [jn.at[int(j), "name_en"] if _int_or_none(j) is not None and int(j) in jn.index else None for j in payments["journal_id"]],
        "journal_name_ar": [jn.at[int(j), "name_ar"] if _int_or_none(j) is not None and int(j) in jn.index else None for j in payments["journal_id"]],
        "payment_date": [_date(d) for d in payments["date"]],
        "amount": pd.to_numeric(payments["amount"]).to_numpy(),
        "memo": payments["ref"].to_numpy(),
        "is_reconciled": payments["is_reconciled"].map(lambda v: None if v is None or pd.isna(v) else int(bool(v))).to_numpy(),
        "is_matched": payments["is_matched"].map(lambda v: None if v is None or pd.isna(v) else int(bool(v))).to_numpy(),
        "created_by_user_id": [_int_or_none(u) for u in payments["create_uid"]],
        "CompanyKey": companies,
        "CurrencyKey": _currencies(inputs, _scratch(), "dim_finance_payment", list(payments["currency_id"])),
    })


OWN_TEAM_PREFIX = "ODOO-TEAM-"


def own_team_keys(maps: KeyMaps, odoo_team_ids: Iterable[Any], keys: Iterable[str]) -> list[str]:
    """The document's own team for an Odoo team whose OdooTeams row says SALESPERSON: 'ODOO-TEAM-<id>' instead of the
    '-1' maps.teams(person_fallback=False) gives it. Every other key is kept."""
    out = []
    for v, key in zip(odoo_team_ids, keys):
        tid = _int_or_none(v)
        mapped = maps.team_map.get(tid) if tid is not None else None
        out.append(f"{OWN_TEAM_PREFIX}{tid}" if mapped is not None and mapped[1] else key)
    return out


def own_team_members(keys: Iterable[str], odoo_teams: Mapping[int, tuple[str | None, int | None]], company_keys: set[int]) -> pd.DataFrame:
    """dim_sales_team rows for the ODOO-TEAM-<id> keys: the Odoo team's name and company, no segment (-1).
    ``odoo_teams``: crm.team id -> (name, company id) from raw_odoo_crm_team."""
    rows = []
    for key in sorted(set(keys)):
        tid = int(key[len(OWN_TEAM_PREFIX):])
        name, company = odoo_teams.get(tid, (None, None))
        rows.append({"SalesTeamKey": key, "SalesTeam": name or f"Odoo team {tid}",
                     "CompanyKey": company if company in company_keys else UNKNOWN, "SalesTeamCompany": None,
                     "SegmentKey": UNKNOWN, "SalesSegment": None, "SalesCity": None, "Territory": None,
                     "SalesTeamStatus": "ODOO_TEAM"})
    return pd.DataFrame(rows, columns=["SalesTeamKey", "SalesTeam", "CompanyKey", "SalesTeamCompany", "SegmentKey", "SalesSegment",
                                       "SalesCity", "Territory", "SalesTeamStatus"])


def build(lines: pd.DataFrame, moves: pd.DataFrame, so_inv: pd.DataFrame, origin_orders: pd.DataFrame, payments: pd.DataFrame,
          journals: pd.DataFrame, maps: KeyMaps, inputs: FinanceInputs, snapshot_date: _dt.date) -> FinanceBuild:
    out = _scratch()
    mv = moves.set_index(moves["id"].astype("int64"), drop=False) if len(moves) else moves
    missing_moves = sorted({int(m) for m in lines["move_id"] if _int_or_none(m) is not None and int(m) not in mv.index})
    out.fell("fact_finance_receivable_snapshot.move_id (move not returned by Odoo)", missing_moves)
    delivery = delivery_by_move(moves, so_inv, origin_orders) if len(moves) else {}
    known_payments = set(payments["id"].astype("int64")) if len(payments) else set()

    def m(col: str) -> list[Any]:
        return [mv.at[int(i), col] if _int_or_none(i) is not None and int(i) in mv.index else None for i in lines["move_id"]]

    customers, f1 = maps.customers(list(lines["partner_id"]))
    out.fell("fact_finance_receivable_snapshot.CustomerKey (partner id)", f1)
    companies, f2 = maps.companies(list(lines["company_id"]))
    out.fell("fact_finance_receivable_snapshot.CompanyKey (company id)", f2)
    people, sources = _salespeople(maps, inputs, out, "fact_finance_receivable_snapshot", m("invoice_user_id"), customers,
                                   [mt if pid is None or _int_or_none(pid) is None else None for mt, pid in zip(m("move_type"), lines["payment_id"])])
    teams, f3 = maps.teams(m("team_id"), people, person_fallback=False)
    teams = own_team_keys(maps, m("team_id"), teams)
    out.fell("fact_finance_receivable_snapshot.SalesTeamKey (Odoo team id not in OdooTeams)", f3)
    terms = _payment_terms(inputs, out, "fact_finance_receivable_snapshot", m("invoice_payment_term_id"), customers, companies)
    currencies = _currencies(inputs, out, "fact_finance_receivable_snapshot", list(lines["currency_id"]))
    pay_keys, pay_missing = [], []
    for p in lines["payment_id"]:
        pid = _int_or_none(p)
        if pid is None:
            pay_keys.append(UNKNOWN)
        elif pid in known_payments:
            pay_keys.append(pid)
        else:
            pay_keys.append(UNKNOWN)
            pay_missing.append(pid)
    out.fell("fact_finance_receivable_snapshot.PaymentKey (payment not returned by Odoo)", pay_missing)
    dues = [due_date(dm, idd, ld) for dm, idd, ld in zip(lines["date_maturity"], m("invoice_date_due"), lines["date"])]
    inv_dates = [_date(i) or _date(ld) for i, ld in zip(m("invoice_date"), lines["date"])]
    days = [(snapshot_date - d).days if d is not None else None for d in dues]
    pay_frame = payments.set_index(payments["id"].astype("int64")) if len(payments) else pd.DataFrame(columns=["payment_type", "partner_type"])
    move_types = m("move_type")
    scopes = [receivable_scope(mt, *((pay_frame.at[k, "payment_type"], pay_frame.at[k, "partner_type"]) if k != UNKNOWN else (None, None)))
              for mt, k in zip(move_types, pay_keys)]
    intercompany = inputs.intercompany_customers
    fact = pd.DataFrame({
        "SnapshotDateKey": date_key(snapshot_date),
        "line_id": lines["id"].astype("int64").to_numpy(),
        "move_id": [int(i) if _int_or_none(i) is not None and int(i) in mv.index else UNKNOWN for i in lines["move_id"]],
        "PaymentKey": pay_keys,
        "DueDateKey": [date_key(d) for d in dues],
        "InvoiceDateKey": [date_key(d) for d in inv_dates],
        "CustomerKey": customers, "CompanyKey": companies, "SalespersonKey": people, "SalesTeamKey": teams,
        "CurrencyKey": currencies, "PaymentTermKey": terms,
        "AgingBucketKey": [bucket_key(d) if d is not None else UNKNOWN for d in days],
        "due_date": dues,
        "days_past_due": days,
        "residual_company_ccy": pd.to_numeric(lines["amount_residual"]).fillna(0.0).to_numpy(),
        "residual_doc_ccy": pd.to_numeric(lines["amount_residual_currency"]).to_numpy(),
        "delivery_status": [delivery.get(int(i), (None, 0))[0] if _int_or_none(i) is not None else None for i in lines["move_id"]],
        "is_intercompany": [int(c in intercompany) for c in customers],
        "receivable_scope": scopes,
        "salesperson_source": sources,
    })
    out.fact = fact

    if len(moves):
        mm = moves.copy()
        m_customers, _ = maps.customers(list(mm["commercial_partner_id"].where(mm["commercial_partner_id"].notna(), mm["partner_id"])))
        m_companies, _ = maps.companies(list(mm["company_id"]))
        m_people, _ = _salespeople(maps, inputs, _scratch(), "dim_finance_invoice", list(mm["invoice_user_id"]), m_customers,
                                   list(mm["move_type"]))
        m_teams, _ = maps.teams(list(mm["team_id"]), m_people, person_fallback=False)
        m_teams = own_team_keys(maps, list(mm["team_id"]), m_teams)
        out.invoices = pd.DataFrame({
            "move_id": mm["id"].astype("int64").to_numpy(),
            "document": mm["name"].to_numpy(),
            "move_type": mm["move_type"].to_numpy(),
            "state": mm["state"].to_numpy(),
            "payment_state": mm["payment_state"].to_numpy(),
            "journal_id": [_int_or_none(j) for j in mm["journal_id"]],
            "invoice_date": [_date(v) for v in mm["invoice_date"]],
            "invoice_final_due_date": [_date(v) for v in mm["invoice_date_due"]],
            "invoice_origin": mm["invoice_origin"].to_numpy(),
            "amount_total": pd.to_numeric(mm["amount_total"]).to_numpy(),
            "amount_total_signed": pd.to_numeric(mm["amount_total_signed"]).to_numpy(),
            "delivery_status": [delivery.get(int(i), (None, 0))[0] for i in mm["id"]],
            "has_sales_order": [delivery.get(int(i), (None, 0))[1] for i in mm["id"]],
            "CustomerKey": m_customers, "CompanyKey": m_companies, "SalespersonKey": m_people, "SalesTeamKey": m_teams,
            "PaymentTermKey": _payment_terms(inputs, _scratch(), "dim_finance_invoice", list(mm["invoice_payment_term_id"]), m_customers, m_companies),
            "CurrencyKey": _currencies(inputs, _scratch(), "dim_finance_invoice", list(mm["currency_id"])),
            "is_intercompany": [int(c in intercompany) for c in m_customers],
        })
    out.payments = build_payments(payments, journals, maps, inputs)
    out.bridge = pd.DataFrame({
        "move_id": so_inv["move_id"].astype("int64").to_numpy(),
        "SalesOrderKey": so_inv["sale_order_id"].astype("int64").to_numpy(),
        "order_name": so_inv["order_name"].to_numpy(),
        "delivery_status": so_inv["delivery_status"].to_numpy(),
    }) if len(so_inv) else pd.DataFrame(columns=["move_id", "SalesOrderKey", "order_name", "delivery_status"])

    overdue = fact["days_past_due"].fillna(0) > 0
    clean = fact[fact["is_intercompany"] == 0]
    move_type = pd.Series(move_types).fillna("(none)")
    by_scope = {}
    for s_ in RECEIVABLE_SCOPES:
        for ic in (0, 1):
            part = fact[(fact["receivable_scope"] == s_.key) & (fact["is_intercompany"] == ic)]
            by_scope[f"{s_.key}{'+intercompany' if ic else ''}"] = {"rows": len(part), "net": round(float(part["residual_company_ccy"].sum()), 2)}
    default = fact[(fact["receivable_scope"] == CUSTOMER_DEBT) & (fact["is_intercompany"] == 0)]
    pay = out.payments.set_index("PaymentKey") if len(out.payments) else pd.DataFrame(columns=["payment_type", "partner_type"])
    pay_kind = [f"{pay.at[k, 'payment_type']}/{pay.at[k, 'partner_type']}" if k != UNKNOWN and k in pay.index else None for k in fact["PaymentKey"]]
    out.stats = {
        "snapshot_date": snapshot_date.isoformat(), "rows": len(fact),
        "rows_by_move_type": {k: int(v) for k, v in move_type.value_counts().items()},
        "payment_lines_by_type": {k: {"rows": int(v), "net": round(float(fact.loc[[p == k for p in pay_kind], "residual_company_ccy"].sum()), 2)}
                                  for k, v in pd.Series([p for p in pay_kind if p]).value_counts().items()},
        "open_amount_net": round(float(fact["residual_company_ccy"].sum()), 2),
        "overdue_amount": round(float(fact.loc[overdue, "residual_company_ccy"].sum()), 2),
        "open_amount_net_excl_intercompany": round(float(clean["residual_company_ccy"].sum()), 2),
        "intercompany_rows": int(fact["is_intercompany"].sum()),
        "by_scope": by_scope,
        "open_amount_net_default_view": round(float(default["residual_company_ccy"].sum()), 2),
        "configured_intercompany_customers": sorted(inputs.configured_intercompany_customers),
        "missing_due_date": int(fact["due_date"].isna().sum()),
        "salesperson_source": {k: int(v) for k, v in fact["salesperson_source"].value_counts().items()},
        "lines_without_date_maturity": int(lines["date_maturity"].isna().sum()),
        "buckets": [b.label for b in AGING_BUCKETS],
    }
    return out
