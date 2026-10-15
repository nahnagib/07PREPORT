"""Collections (Receivables and Collections page, Collections trend): money collected from customers, by payment date.

Tasks of the finance_receivables job (after load_receivables, so every schedule that refreshes the receivables also
refreshes collections; the receivables snapshot is committed before these run):

  extract_collections  raw_odoo_customer_payment (0040): account.payment with payment_type inbound, partner_type customer,
                       companies of the run (ODOO_COMPANY_IDS + ODOO_COMPANY_NAMES), every state. First run (empty table)
                       = full history; later runs = payments written since the last load (write_date, 1 h overlap), every
                       posted payment not reconciled yet, and the payments behind reconciliations created since then.
                       For those payments: their receivable lines, the account.partial.reconcile rows on those lines, the
                       matched (debit) lines and their moves.
  load_collections     fact_finance_collection (0040 + 0042 split) and fact_finance_collection_invoice (0042), replaced
                       for the payments read (all of them on a full run).

Rules (decision of 2026-10-08, 0040; split 2026-10-11, 0042; same scope as the Debt Report):
  * a collection = a POSTED inbound customer payment that is not an internal transfer, dated by the payment's date
    (account.payment.date, Odoo's date), never by the reconciliation's create_date. Credit notes, write-offs and exchange
    differences are never collections: this starts from cash, not from reconciliations (the old Power BI counted every
    reconciliation in the week of its create_date).
  * amount = account.payment.amount (payment currency), amount_company_ccy = amount_company_currency_signed x share.
  * split of the amount (payment currency, from account.partial.reconcile.credit_amount_currency on the payment's
    receivable line): applied to customer invoice lines (out_invoice / out_receipt) OVERDUE on the payment date (due date
    before it) or NOT YET DUE (due on or after it); applied to any other receivable debit ("other": opening balances,
    refunds paid out, exchange difference entries); UNAPPLIED = the rest (not matched yet). due date = date_maturity, else
    the invoice due date, else the line date (transform.due_date, the receivables' rule).
  * attribution: the invoice part goes to the matched invoices' salesperson (invoice_user_id; none -> -1, like the Debt
    Report's invoices) and branch (the invoice's Odoo team, finance transform rules), one row per salesperson + branch;
    the unapplied + other part is one row for the customer's salesperson of record and that salesperson's branch
    ('customer'), or -1 / -1 ('none'). The rows of a payment always add up to the payment.
  * is_intercompany = the customer is one of our companies' partners or FINANCE_INTERCOMPANY_PARTNER_IDS; the view
    v_finance_collection_trend removes those rows and the report exclusions.
"""

from __future__ import annotations

import datetime as _dt
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

import pandas as pd
from sqlalchemy import bindparam, text

from core.jobs import ensure_date_range
from core.keys import UNKNOWN, UNKNOWN_TEXT
from core.resolve import KeyMaps, _int_or_none
from departments.finance import jobs as fin
from departments.finance import transform as tf
from etl_platform import quality as q
from etl_platform.load import insert_rows, upsert
from etl_platform.registry import REGISTRY, DatasetSpec, TaskSpec
from etl_platform.runner import RunContext, TaskResult
from etl_platform.sources.odoo import m2o_id

RAW = "raw_odoo_customer_payment"
FACT = "fact_finance_collection"
MATCHES = "fact_finance_collection_invoice"
INVOICE_DATES = "dim_finance_collection_invoice_date"
INVOICE_MOVE_TYPES = ("out_invoice", "out_receipt")
OVERLAP = _dt.timedelta(hours=1)
EPS = 0.005
PAYMENT_DOMAIN = [("payment_type", "=", "inbound"), ("partner_type", "=", "customer")]
PAYMENT_FIELDS = ["id", "move_id", "name", "date", "state", "partner_id", "company_id", "currency_id", "journal_id", "amount",
                  "amount_company_currency_signed", "is_internal_transfer", "is_reconciled", "write_date"]
PAY_LINE_FIELDS = ["id", "payment_id", "move_id", "account_type", "amount_residual_currency", "amount_currency", "parent_state"]
PARTIAL_FIELDS = ["id", "debit_move_id", "credit_move_id", "amount", "debit_amount_currency", "credit_amount_currency", "max_date"]
DEBIT_LINE_FIELDS = ["id", "move_id", "date", "date_maturity", "account_type"]
DEBIT_MOVE_FIELDS = ["id", "name", "move_type", "invoice_user_id", "team_id", "invoice_date", "invoice_date_due"]
KEY_DIMS = {"CustomerKey": ("dim_customer", "CustomerKey"), "CompanyKey": ("dim_company", "CompanyKey"),
            "SalespersonKey": ("dim_salesperson", "SalespersonKey"), "SalesTeamKey": ("dim_sales_team", "SalesTeamKey"),
            "CurrencyKey": ("dim_currency", "CurrencyKey"), "PaymentDateKey": ("dim_date", "DateKey")}


def _num(v: Any) -> float:
    return 0.0 if v in (None, False) or (isinstance(v, float) and pd.isna(v)) else float(v)


def _date(v: Any) -> _dt.date | None:
    return tf._date(v) if v not in (None, False, "") else None


# -- pure transform ----------------------------------------------------------------------------------------------------
@dataclass
class CollectionInputs:
    """What the transform needs from the warehouse besides KeyMaps (built by _inputs from the receivables' FinanceInputs)."""

    currency_keys: set[int]
    customer_salesperson: dict[int, int]
    intercompany_customers: set[int]


@dataclass
class CollectionBuild:
    fact: pd.DataFrame
    matches: pd.DataFrame
    fallbacks: dict[str, list[Any]] = field(default_factory=dict)
    stats: dict[str, Any] = field(default_factory=dict)

    def fell(self, key: str, ids: list[Any]) -> None:
        if ids:
            self.fallbacks.setdefault(key, []).extend(ids)


FACT_COLUMNS = ["payment_id", "allocation_no", "payment_name", "PaymentDateKey", "payment_date", "CompanyKey", "CustomerKey",
                "CurrencyKey", "SalespersonKey", "SalesTeamKey", "attribution", "share", "amount_doc_ccy", "amount_company_ccy",
                "applied_overdue_doc_ccy", "applied_not_due_doc_ccy", "applied_other_doc_ccy", "unapplied_doc_ccy", "is_intercompany"]
MATCH_COLUMNS = ["partial_id", "payment_id", "allocation_no", "debit_line_id", "move_id", "document", "move_type", "kind", "due_date",
                 "applied_doc_ccy", "applied_invoice_ccy", "reconciled_on"]


def build_collections(payments: list[dict[str, Any]], pay_lines: list[dict[str, Any]], partials: list[dict[str, Any]],
                      debit_lines: dict[int, dict[str, Any]], debit_moves: dict[int, dict[str, Any]], maps: KeyMaps,
                      inputs: CollectionInputs) -> CollectionBuild:
    """One fact row per payment x allocation (see the module doc) + one match row per partial reconciliation."""
    out = CollectionBuild(pd.DataFrame(columns=FACT_COLUMNS), pd.DataFrame(columns=MATCH_COLUMNS))
    lines_of: dict[int, list[int]] = defaultdict(list)
    for ln in pay_lines:
        if ln.get("account_type") == "asset_receivable" and m2o_id(ln.get("payment_id")) is not None:
            lines_of[m2o_id(ln["payment_id"])].append(int(ln["id"]))
    partials_of_line: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for p in partials:
        partials_of_line[m2o_id(p["credit_move_id"])].append(p)
    rows, matches = [], []
    skipped = defaultdict(int)
    fell_cust, fell_user, fell_team, fell_ccy = [], [], [], []
    for pay in payments:
        if pay.get("state") != "posted":
            skipped["not_posted"] += 1
            continue
        if pay.get("is_internal_transfer"):
            skipped["internal_transfer"] += 1
            continue
        amount = _num(pay.get("amount"))
        if abs(amount) < EPS:
            skipped["zero_amount"] += 1
            continue
        pay_date = _date(pay.get("date"))
        if pay_date is None:
            skipped["no_date"] += 1
            continue
        partner = m2o_id(pay.get("partner_id"))
        customer = maps.partner_customer.get(partner, UNKNOWN) if partner is not None else UNKNOWN
        if partner is not None and customer == UNKNOWN:
            fell_cust.append(partner)
        company = m2o_id(pay.get("company_id"))
        company_key = company if company in maps.company_keys else UNKNOWN
        ccy = m2o_id(pay.get("currency_id"))
        ccy_key = ccy if ccy in inputs.currency_keys else UNKNOWN
        if ccy is not None and ccy_key == UNKNOWN:
            fell_ccy.append(ccy)
        # the payment's matches, grouped by the invoice's salesperson + branch
        groups: dict[tuple[int, str], dict[str, float]] = {}
        other = 0.0
        pay_matches = []
        for line_id in lines_of.get(int(pay["id"]), []):
            for p in partials_of_line.get(line_id, []):
                applied = _num(p.get("credit_amount_currency")) or _num(p.get("amount"))
                dl = debit_lines.get(m2o_id(p["debit_move_id"]), {})
                mv = debit_moves.get(m2o_id(dl.get("move_id")), {})
                due = tf.due_date(dl.get("date_maturity"), mv.get("invoice_date_due"), dl.get("date"))
                if mv.get("move_type") in INVOICE_MOVE_TYPES:
                    kind = "overdue" if due is not None and due < pay_date else "not_due"
                    uid = _int_or_none(m2o_id(mv.get("invoice_user_id")))
                    sp = maps.user_salesperson.get(uid, UNKNOWN) if uid is not None else UNKNOWN
                    if uid is not None and sp == UNKNOWN:
                        fell_user.append(uid)
                    team_id = m2o_id(mv.get("team_id"))
                    keys, unlisted = maps.teams([team_id], [sp], person_fallback=False)
                    team = tf.own_team_keys(maps, [team_id], keys)[0]
                    fell_team.extend(unlisted)
                    g = groups.setdefault((sp, team), {"overdue": 0.0, "not_due": 0.0})
                    g[kind] += applied
                    gkey: tuple[int, str] | None = (sp, team)
                else:
                    kind, gkey = "other", None
                    other += applied
                pay_matches.append({"partial_id": int(p["id"]), "debit_line_id": m2o_id(p["debit_move_id"]), "move_id": m2o_id(dl.get("move_id")),
                                    "document": mv.get("name"), "move_type": mv.get("move_type"), "kind": kind, "due_date": due,
                                    "applied_doc_ccy": applied, "applied_invoice_ccy": _num(p.get("debit_amount_currency")) or None,
                                    "reconciled_on": _date(p.get("max_date")), "_group": gkey})
        applied_total = other + sum(g["overdue"] + g["not_due"] for g in groups.values())
        scale = 1.0
        if applied_total > amount + EPS:  # never more than the payment (rounding of foreign-currency partials)
            scale = amount / applied_total
            skipped["applied_scaled_to_amount"] += 1
            for g in groups.values():
                g["overdue"] *= scale
                g["not_due"] *= scale
            other *= scale
            applied_total = amount
        unapplied = amount - applied_total
        allocations: list[dict[str, Any]] = []
        for (sp, team), g in sorted(groups.items(), key=lambda kv: (-(kv[1]["overdue"] + kv[1]["not_due"]), kv[0][0], kv[0][1])):
            allocations.append({"SalespersonKey": sp, "SalesTeamKey": team, "attribution": "invoice", "applied_overdue_doc_ccy": g["overdue"],
                                "applied_not_due_doc_ccy": g["not_due"], "applied_other_doc_ccy": 0.0, "unapplied_doc_ccy": 0.0, "_group": (sp, team)})
        if abs(other) > EPS or abs(unapplied) > EPS or not allocations:
            sp = inputs.customer_salesperson.get(customer, UNKNOWN)
            allocations.append({"SalespersonKey": sp, "SalesTeamKey": maps.salesperson_team.get(sp, UNKNOWN_TEXT) if sp != UNKNOWN else UNKNOWN_TEXT,
                                "attribution": "customer" if sp != UNKNOWN else "none", "applied_overdue_doc_ccy": 0.0,
                                "applied_not_due_doc_ccy": 0.0, "applied_other_doc_ccy": other, "unapplied_doc_ccy": unapplied, "_group": None})
        # a rounding residue below EPS (e.g. 0.004 of a 3-decimal LYD partial) has no row of its own: it goes to the last
        # row's "not matched yet", so the rows of a payment add up to it exactly and the shares to 1
        residue = amount - sum(a["applied_overdue_doc_ccy"] + a["applied_not_due_doc_ccy"] + a["applied_other_doc_ccy"] + a["unapplied_doc_ccy"]
                               for a in allocations)
        if residue:
            allocations[-1]["unapplied_doc_ccy"] += residue
        company_amount = _num(pay.get("amount_company_currency_signed"))
        for n, a in enumerate(allocations, start=1):
            part = a["applied_overdue_doc_ccy"] + a["applied_not_due_doc_ccy"] + a["applied_other_doc_ccy"] + a["unapplied_doc_ccy"]
            share = part / amount
            rows.append({"payment_id": int(pay["id"]), "allocation_no": n, "payment_name": pay.get("name"),
                         "PaymentDateKey": tf.date_key(pay_date), "payment_date": pay_date, "CompanyKey": company_key, "CustomerKey": customer,
                         "CurrencyKey": ccy_key, "SalespersonKey": a["SalespersonKey"], "SalesTeamKey": a["SalesTeamKey"],
                         "attribution": a["attribution"], "share": round(share, 10), "amount_doc_ccy": part,
                         "amount_company_ccy": company_amount * share, "applied_overdue_doc_ccy": a["applied_overdue_doc_ccy"],
                         "applied_not_due_doc_ccy": a["applied_not_due_doc_ccy"], "applied_other_doc_ccy": a["applied_other_doc_ccy"],
                         "unapplied_doc_ccy": a["unapplied_doc_ccy"], "is_intercompany": int(customer in inputs.intercompany_customers)})
            a["_no"] = n
        no_of_group = {a["_group"]: a["_no"] for a in allocations}
        for m in pay_matches:
            m["applied_doc_ccy"] *= scale
            matches.append({**{k: v for k, v in m.items() if k != "_group"}, "payment_id": int(pay["id"]),
                            "allocation_no": no_of_group.get(m["_group"], no_of_group.get(None, 1))})
    out.fact = pd.DataFrame(rows, columns=FACT_COLUMNS)
    out.matches = pd.DataFrame(matches, columns=MATCH_COLUMNS)
    out.fell(f"{FACT}.CustomerKey (partner id)", fell_cust)
    out.fell(f"{FACT}.SalespersonKey (Odoo user not in OdooUsers)", fell_user)
    out.fell(f"{FACT}.SalesTeamKey (Odoo team id not in OdooTeams)", fell_team)
    out.fell(f"{FACT}.CurrencyKey (Odoo currency not in dim_currency)", fell_ccy)
    out.stats = {"payments": len(payments), "fact_rows": len(rows), "matches": len(matches), "skipped": dict(skipped),
                 "collected_by_currency": {str(k): round(float(v), 2) for k, v in out.fact.groupby("CurrencyKey")["amount_doc_ccy"].sum().items()} if rows else {}}
    return out


# -- extract -----------------------------------------------------------------------------------------------------------
def _chunks(ids: list[int], size: int):
    for i in range(0, len(ids), size):
        yield ids[i:i + size]


def extract_collections(ctx: RunContext) -> TaskResult:
    src = fin.finance_source(ctx)
    companies = list(ctx.odoo_company_ids(ctx.state.get("odoo_profile", fin.PROFILE)))
    company_dom = [("company_id", "in", companies)] if companies else []
    with ctx.engine.connect() as conn:
        watermark = conn.execute(text(f"SELECT MAX(_source_write_date) FROM {RAW}")).scalar()
    full = watermark is None
    base = [*PAYMENT_DOMAIN, *company_dom]
    pay_fields, skipped_f = src.available_fields("account.payment", PAYMENT_FIELDS)
    if full:
        payments = src.search_read_all("account.payment", base, pay_fields)
        changed_by_partial = 0
    else:
        since = (pd.Timestamp(watermark) - OVERLAP).strftime("%Y-%m-%d %H:%M:%S")
        ids = set(src.search_ids("account.payment", [*base, ("write_date", ">", since)]))
        ids |= set(src.search_ids("account.payment", [*base, ("state", "=", "posted"), ("is_reconciled", "=", False)]))
        recent = src.search_read_all("account.partial.reconcile", [("create_date", ">", since), *company_dom], ["credit_move_id"])
        lines = src.read_by_ids("account.move.line", [m2o_id(p["credit_move_id"]) for p in recent], ["id", "payment_id"])
        by_partial = {m2o_id(ln.get("payment_id")) for ln in lines if m2o_id(ln.get("payment_id")) is not None}
        changed_by_partial = len(by_partial - ids)
        ids |= by_partial
        payments = []
        for chunk in _chunks(sorted(ids), src.id_chunk_size):  # the base domain again: a reconciliation may be an outbound payment's
            payments += src.search_read_all("account.payment", [*base, ("id", "in", chunk)], pay_fields)
    pay_ids = sorted(int(p["id"]) for p in payments)
    pay_lines: list[dict[str, Any]] = []
    for chunk in _chunks(pay_ids, src.id_chunk_size):
        pay_lines += src.search_read_all("account.move.line", [("payment_id", "in", chunk), ("account_type", "=", "asset_receivable")], PAY_LINE_FIELDS)
    line_ids = sorted(int(ln["id"]) for ln in pay_lines)
    partials: list[dict[str, Any]] = []
    for chunk in _chunks(line_ids, src.id_chunk_size):
        partials += src.search_read_all("account.partial.reconcile", [("credit_move_id", "in", chunk)], PARTIAL_FIELDS)
    debit_lines = {int(r["id"]): r for r in src.read_by_ids("account.move.line", [m2o_id(p["debit_move_id"]) for p in partials], DEBIT_LINE_FIELDS)}
    debit_moves = {int(r["id"]): r for r in src.read_by_ids("account.move", [m2o_id(r.get("move_id")) for r in debit_lines.values()], DEBIT_MOVE_FIELDS)}
    ctx.state.update(collection_payments=payments, collection_pay_lines=pay_lines, collection_partials=partials,
                     collection_debit_lines=debit_lines, collection_debit_moves=debit_moves, collection_full=full)
    details = {"full_history": full, "watermark": str(watermark) if watermark else None, "payments": len(payments),
               "payment_receivable_lines": len(pay_lines), "partials": len(partials), "matched_lines": len(debit_lines),
               "matched_moves": len(debit_moves), "payments_from_new_reconciliations": changed_by_partial,
               "skipped_fields": {"account.payment": skipped_f}}
    ctx.logger.info("Collections extracted: %s", details)
    return TaskResult(rows_extracted=len(payments) + len(pay_lines) + len(partials), details=details)


# -- load --------------------------------------------------------------------------------------------------------------
def _raw_frame(payments: list[dict[str, Any]], matches: pd.DataFrame, ctx: RunContext) -> pd.DataFrame:
    now = fin._now()
    invoices_of: dict[int, list[int]] = defaultdict(list)
    for pid, mid, mt in zip(matches["payment_id"], matches["move_id"], matches["move_type"]):
        if mt in INVOICE_MOVE_TYPES and mid is not None and int(mid) not in invoices_of[int(pid)]:
            invoices_of[int(pid)].append(int(mid))
    rows = []
    for p in payments:
        rows.append({"id": int(p["id"]), "move_id": m2o_id(p.get("move_id")), "name": p.get("name") or None, "date": _date(p.get("date")),
                     "state": p.get("state") or None, "partner_id": m2o_id(p.get("partner_id")), "company_id": m2o_id(p.get("company_id")),
                     "currency_id": m2o_id(p.get("currency_id")), "journal_id": m2o_id(p.get("journal_id")), "amount": _num(p.get("amount")),
                     "amount_company_currency_signed": _num(p.get("amount_company_currency_signed")),
                     "is_internal_transfer": int(bool(p.get("is_internal_transfer"))), "is_reconciled": int(bool(p.get("is_reconciled"))),
                     # the invoices this payment is matched to, from the reconciliations read (= Odoo's reconciled_invoice_ids)
                     "reconciled_invoice_ids": "[" + ",".join(str(i) for i in invoices_of.get(int(p["id"]), [])) + "]",
                     "_extracted_at": now, "_run_id": ctx.run_uid,
                     "_source_write_date": pd.to_datetime(p["write_date"]).to_pydatetime() if p.get("write_date") else None})
    return pd.DataFrame(rows, columns=["id", "move_id", "name", "date", "state", "partner_id", "company_id", "currency_id", "journal_id",
                                       "amount", "amount_company_currency_signed", "is_internal_transfer", "is_reconciled",
                                       "reconciled_invoice_ids", "_extracted_at", "_run_id", "_source_write_date"])


def _inputs(conn, own_partners: list[int], intercompany_partners: tuple[int, ...]) -> CollectionInputs:
    fi = fin._inputs(conn, own_partners, intercompany_partners)
    return CollectionInputs(currency_keys=set(fi.currency_keys), customer_salesperson=dict(fi.customer_salesperson),
                            intercompany_customers=set(fi.intercompany_customers))


def _checks() -> list[q.CheckSpec]:
    specs = [q.orphan(FACT, col, dim, dim_col, name=f"orphan:{FACT}.{col}") for col, (dim, dim_col) in KEY_DIMS.items()]
    # every payment's rows add up to the payment, and the split adds up to each row
    specs.append(q.custom_sql(
        "sanity:collection_rows_add_up_to_payment",
        f"SELECT c.payment_id FROM {FACT} c JOIN {RAW} r ON r.id = c.payment_id GROUP BY c.payment_id, r.amount "
        "HAVING ABS(SUM(c.amount_doc_ccy) - r.amount) > 0.0001 OR ABS(SUM(c.share) - 1) > 0.000001", table=FACT))
    specs.append(q.custom_sql(
        "sanity:collection_split_adds_up",
        f"SELECT payment_id FROM {FACT} WHERE ABS(applied_overdue_doc_ccy + applied_not_due_doc_ccy + applied_other_doc_ccy "
        "+ unapplied_doc_ccy - amount_doc_ccy) > 0.0001", table=FACT))
    return specs


def load_collections(ctx: RunContext) -> TaskResult:
    payments = ctx.state["collection_payments"]
    with ctx.engine.connect() as conn:
        maps = KeyMaps.load(conn)
        own = ctx.state.get("own_company_partners") or []
        inputs = _inputs(conn, own, tuple(ctx.config.finance_intercompany_partner_ids))
    built = build_collections(payments, ctx.state["collection_pay_lines"], ctx.state["collection_partials"],
                              ctx.state["collection_debit_lines"], ctx.state["collection_debit_moves"], maps, inputs)
    for key, ids in built.fallbacks.items():
        ctx.record_fallback(key, ids)
    now = fin._now()
    fact = built.fact.assign(loaded_at_utc=now, _run_id=ctx.run_uid)
    matches = built.matches.assign(loaded_at_utc=now, _run_id=ctx.run_uid)
    raw = _raw_frame(payments, built.matches, ctx)
    pay_ids = [int(p["id"]) for p in payments]
    with ctx.engine.begin() as conn:
        dates = [d for d in fact["payment_date"] if d is not None]
        if dates:
            ensure_date_range(conn, min(dates), max(dates))
        own_teams = {str(k) for k in fact["SalesTeamKey"] if str(k).startswith(tf.OWN_TEAM_PREFIX)}
        if own_teams:
            odoo_teams = {int(r[0]): (r[1], None if r[2] is None else int(r[2]))
                          for r in conn.execute(text("SELECT id, name, company_id FROM raw_odoo_crm_team"))}
            upsert(conn, "dim_sales_team", tf.own_team_members(own_teams, odoo_teams, maps.company_keys).assign(updated_at_utc=now))
        upsert(conn, RAW, raw)
        # These dates outlive payment allocation replacements, including full collection reloads.
        invoice_dates = collection_invoice_dates(ctx.state["collection_debit_moves"])
        upsert(conn, INVOICE_DATES, invoice_dates.assign(updated_at_utc=now))
        if ctx.state.get("collection_full"):
            deleted = conn.execute(text(f"DELETE FROM {FACT}")).rowcount or 0
            conn.execute(text(f"DELETE FROM {MATCHES}"))
        else:
            deleted = 0
            for chunk in _chunks(pay_ids, 1000):
                deleted += conn.execute(text(f"DELETE FROM {FACT} WHERE payment_id IN :ids").bindparams(bindparam("ids", expanding=True)), {"ids": chunk}).rowcount or 0
                conn.execute(text(f"DELETE FROM {MATCHES} WHERE payment_id IN :ids").bindparams(bindparam("ids", expanding=True)), {"ids": chunk})
        inserted = insert_rows(conn, FACT, fact)
        insert_rows(conn, MATCHES, matches)
        results = ctx.quality.evaluate(_checks(), conn, task_name="load_collections")
        q.raise_for_failures(results)
    details = {**built.stats, "replaced_rows": deleted, "full_history": bool(ctx.state.get("collection_full"))}
    ctx.logger.info("Collections loaded: %s payment(s), %s row(s), %s match(es); skipped %s", len(payments), inserted,
                    len(matches), built.stats["skipped"])
    return TaskResult(rows_loaded=inserted, details=details)


def collection_invoice_dates(moves: dict[int, dict[str, Any]]) -> pd.DataFrame:
    """Actual invoice dates, including fully paid invoices absent from the receivables snapshot."""
    return pd.DataFrame([
        {"move_id": int(m["id"]), "invoice_date": _date(m.get("invoice_date"))}
        for m in moves.values() if m.get("move_type") in INVOICE_MOVE_TYPES
    ], columns=["move_id", "invoice_date"])


# -- registration ------------------------------------------------------------------------------------------------------
REGISTRY.dataset(DatasetSpec(RAW, fin.DEPARTMENT, "raw", "odoo", RAW, "upsert", ("id",), model="account.payment"))
REGISTRY.dataset(DatasetSpec(FACT, fin.DEPARTMENT, "mart", "sql", FACT, "upsert", ("payment_id", "allocation_no")))
REGISTRY.dataset(DatasetSpec(MATCHES, fin.DEPARTMENT, "mart", "sql", MATCHES, "upsert", ("partial_id",)))
REGISTRY.dataset(DatasetSpec(INVOICE_DATES, fin.DEPARTMENT, "conform", "odoo", INVOICE_DATES, "upsert", ("move_id",), model="account.move"))
REGISTRY.task(TaskSpec("extract_collections", extract_collections, depends_on=("load_receivables",)))
REGISTRY.task(TaskSpec("load_collections", load_collections, depends_on=("extract_collections",)))
