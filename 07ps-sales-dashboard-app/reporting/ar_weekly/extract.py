"""Read the receivable data from Odoo and shape it into two tables.

lines     one row per customer-debt receivable journal item (account.move.line) that is open now OR was
          touched by a reconciliation since ``since`` (so its balance on any past week end can be rebuilt)
partials  every account.partial.reconcile with max_date > since on a receivable line

Rules mirror the Debt Report ETL (docs/receivables-etl.md):
* grain: receivable lines (account_type = asset_receivable), posted; due date = date_maturity, else the
  invoice due date, else the line date (instalments age per line)
* customer-debt scope: out_invoice / out_refund / out_receipt lines + inbound customer payments
* customer = commercial partner; salesperson = invoice_user_id, else the customer's salesperson
* amounts in the document currency (amount_residual_currency), never converted
"""
from __future__ import annotations

import datetime as dt
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pandas as pd

from odoo_api import OdooClient, m2o_id, m2o_name
from settings import Settings

log = logging.getLogger("ar_weekly.extract")

DEBT_MOVE_TYPES = ["out_invoice", "out_refund", "out_receipt"]
INVOICE_MOVE_TYPES = {"out_invoice", "out_receipt"}

LINE_FIELDS = ["id", "move_id", "move_name", "partner_id", "company_id", "currency_id", "date", "date_maturity",
               "amount_residual", "amount_residual_currency", "balance", "account_type", "payment_id", "parent_state"]
MOVE_FIELDS = ["id", "name", "move_type", "invoice_user_id", "team_id", "partner_id", "commercial_partner_id",
               "company_id", "currency_id", "invoice_date", "invoice_date_due", "amount_total", "invoice_origin", "ref",
               "journal_id", "payment_id", "origin_payment_id", "statement_line_id"]
PARTIAL_FIELDS = ["id", "debit_move_id", "credit_move_id", "amount", "debit_amount_currency", "credit_amount_currency",
                  "max_date", "company_id"]


@dataclass
class Extract:
    lines: pd.DataFrame
    partials: pd.DataFrame
    since: dt.date
    meta: dict[str, Any] = field(default_factory=dict)


def _d(v: Any) -> dt.date | None:
    if not v:
        return None
    return dt.date.fromisoformat(str(v)[:10])


def load_sales_team_file(path: Path | None) -> dict[str, Any]:
    """Optional Input/SalesTeam.xlsx (the dashboard's own mapping): team segments and salesperson names."""
    out: dict[str, Any] = {"team_by_odoo_id": {}, "team": {}, "sp_by_odoo_user": {}, "sp": {}}
    if not path or not path.is_file():
        if path:
            log.warning("Sales team file not found (%s): team/segment exclusions use team names only", path)
        return out
    try:
        x = pd.read_excel(path, sheet_name=None, dtype=object)
    except Exception as exc:  # file open in Excel, etc.
        log.warning("Could not read %s (%s): team/segment exclusions use team names only", path, exc)
        return out

    def clean(v: Any) -> str | None:
        return None if v is None or (isinstance(v, float) and pd.isna(v)) else str(v).strip()

    for _, r in x.get("OdooTeams", pd.DataFrame()).iterrows():
        if clean(r.get("odoo_team_id")):
            out["team_by_odoo_id"][int(float(r["odoo_team_id"]))] = clean(r.get("SalesTeamKey"))
    for _, r in x.get("salesteam", pd.DataFrame()).iterrows():
        if clean(r.get("TeamKey")):
            out["team"][clean(r["TeamKey"])] = {"name": clean(r.get("TeamName")), "segment": clean(r.get("Segment"))}
    for _, r in x.get("OdooUsers", pd.DataFrame()).iterrows():
        if clean(r.get("odoo_user_id")) and clean(r.get("SalespersonKey")):
            out["sp_by_odoo_user"][int(float(r["odoo_user_id"]))] = int(float(r["SalespersonKey"]))
    for _, r in x.get("salesperson", pd.DataFrame()).iterrows():
        if clean(r.get("SalespersonKey")):
            out["sp"][int(float(r["SalespersonKey"]))] = {"name": clean(r.get("Name")), "team": clean(r.get("TeamKey")),
                                                         "channel": clean(r.get("DistributionChannel"))}
    log.info("Sales team file: %s Odoo teams, %s Odoo users mapped", len(out["team_by_odoo_id"]), len(out["sp_by_odoo_user"]))
    return out


def extract(client: OdooClient, s: Settings, since: dt.date) -> Extract:
    company_dom = [("company_id", "in", s.company_ids)] if s.company_ids else []

    # 1. open customer-debt receivable lines (same basis as the Debt Report / Aged Receivable)
    open_dom = [("account_type", "=", "asset_receivable"), ("parent_state", "=", "posted"), ("reconciled", "=", False),
                ("amount_residual", "!=", 0),
                "|", ("move_id.move_type", "in", DEBT_MOVE_TYPES), ("payment_id.payment_type", "=", "inbound"),
                *company_dom]
    open_lines = client.search_read_all("account.move.line", open_dom, LINE_FIELDS)

    # 2. reconciliations since `since` (payments, credit notes, write-offs applied to receivables)
    partial_dom = [("max_date", ">", since.isoformat()), ("debit_move_id.account_type", "=", "asset_receivable"), *company_dom]
    partials_raw = client.search_read_all("account.partial.reconcile", partial_dom, PARTIAL_FIELDS)

    # 3. the lines on either side of those reconciliations that are not open any more
    have = {r["id"] for r in open_lines}
    need = {m2o_id(p["debit_move_id"]) for p in partials_raw} | {m2o_id(p["credit_move_id"]) for p in partials_raw}
    closed_lines = client.read_ids("account.move.line", need - have - {None}, LINE_FIELDS)
    all_lines = [r for r in open_lines + closed_lines if r.get("parent_state", "posted") == "posted"]

    # 4. their moves, payments and journals
    moves = {r["id"]: r for r in client.read_ids("account.move", {m2o_id(r["move_id"]) for r in all_lines}, MOVE_FIELDS)}
    pay_ids = {m2o_id(r.get("payment_id")) for r in all_lines} | {m2o_id(m.get("payment_id") or m.get("origin_payment_id"))
                                                                  for m in moves.values()}
    payments = {r["id"]: r for r in client.read_ids("account.payment", pay_ids - {None}, ["id", "payment_type", "partner_type"],
                                                    skip_denied=True)}
    journals = {r["id"]: r for r in client.read_ids("account.journal", {m2o_id(m.get("journal_id")) for m in moves.values()},
                                                    ["id", "type", "name"], skip_denied=True)}

    # 5. customers (commercial partners) and salespeople
    pids = {m2o_id(r.get("partner_id")) for r in all_lines} | {m2o_id(m.get("commercial_partner_id")) for m in moves.values()}
    partners = {r["id"]: r for r in client.read_ids("res.partner", pids - {None}, ["id", "name", "commercial_partner_id", "user_id", "ref"],
                                                    skip_denied=True)}
    extra = {m2o_id(p.get("commercial_partner_id")) for p in partners.values()} - set(partners) - {None}
    partners.update({r["id"]: r for r in client.read_ids("res.partner", extra, ["id", "name", "commercial_partner_id", "user_id", "ref"],
                                                         skip_denied=True)})
    companies = client.search_read_all("res.company", [], ["id", "name", "partner_id", "currency_id"])

    def commercial(pid: int | None) -> int | None:
        p = partners.get(pid) if pid else None
        return (m2o_id(p.get("commercial_partner_id")) or pid) if p else pid

    rep_ids: set[int] = set()
    for m in moves.values():
        rep_ids.add(m2o_id(m.get("invoice_user_id")))
    for p in partners.values():
        rep_ids.add(m2o_id(p.get("user_id")))
    users = {r["id"]: r for r in client.read_ids("res.users", rep_ids - {None}, ["id", "name", "login", "email"], skip_denied=True)}
    # users the API user may not read still have their name on the invoice / customer (many2one display name)
    for m in moves.values():
        uid = m2o_id(m.get("invoice_user_id"))
        if uid and uid not in users:
            users[uid] = {"id": uid, "name": m2o_name(m.get("invoice_user_id")), "login": "", "email": ""}
    for p in partners.values():
        uid = m2o_id(p.get("user_id"))
        if uid and uid not in users:
            users[uid] = {"id": uid, "name": m2o_name(p.get("user_id")), "login": "", "email": ""}

    teamfile = load_sales_team_file(s.sales_team_file)
    own_partners = {commercial(m2o_id(c.get("partner_id"))) for c in companies}
    interco = own_partners | {commercial(p) or p for p in s.intercompany_partner_ids}
    company_names = {c["id"]: c["name"] for c in companies}

    # 6. one row per line
    rows = []
    for r in all_lines:
        m = moves.get(m2o_id(r["move_id"]), {})
        mt = m.get("move_type")
        pay = payments.get(m2o_id(r.get("payment_id")) or m2o_id(m.get("payment_id") or m.get("origin_payment_id")))
        jtype = (journals.get(m2o_id(m.get("journal_id"))) or {}).get("type")
        if pay:
            in_scope = (pay.get("payment_type"), pay.get("partner_type")) == ("inbound", "customer")
        else:
            in_scope = mt in DEBT_MOVE_TYPES
        # how a reconciliation against this line should be read when it is the CREDIT side
        if mt == "out_refund":
            settle = "credit_note"
        elif pay or m.get("statement_line_id") or jtype in ("bank", "cash"):
            settle = "cash"
        else:
            settle = "other"
        cust = m2o_id(m.get("commercial_partner_id")) or commercial(m2o_id(r.get("partner_id")))
        cp = partners.get(cust, {})
        rep_id, rep_src = m2o_id(m.get("invoice_user_id")), "invoice_user"
        if not rep_id:
            rep_id, rep_src = m2o_id(cp.get("user_id")), "customer"
        if not rep_id:
            rep_src = "none"
        u = users.get(rep_id, {})
        sp = teamfile["sp"].get(teamfile["sp_by_odoo_user"].get(rep_id or -1), {})
        odoo_team = m2o_name(m.get("team_id"))
        team_key = teamfile["team_by_odoo_id"].get(m2o_id(m.get("team_id")) or -1)
        if not team_key or team_key.upper() == "SALESPERSON":
            team_key = sp.get("team")
        tinfo = teamfile["team"].get(team_key or "", {})
        team_name = tinfo.get("name") or odoo_team
        excluded = None
        if cust in interco and s.exclude_intercompany:
            excluded = "intercompany"
        elif (tinfo.get("segment") or "").strip().lower() in s.exclude_segments:
            excluded = f"segment: {tinfo.get('segment').strip()}"
        elif odoo_team in s.exclude_team_names or team_name in s.exclude_team_names:
            excluded = f"team: {team_name}"
        balance = float(r.get("balance") or 0)
        rows.append({
            "line_id": r["id"], "move_id": m2o_id(r["move_id"]), "document": m.get("name") or r.get("move_name"),
            "move_type": mt, "in_scope": in_scope, "settle_class": settle,
            "kind": "invoice" if (mt in INVOICE_MOVE_TYPES and balance > 0) else "credit",
            "company_id": m2o_id(r.get("company_id")), "company": company_names.get(m2o_id(r.get("company_id"))) or m2o_name(r.get("company_id")),
            "currency": m2o_name(r.get("currency_id")) or m2o_name(m.get("currency_id")) or "",
            "date": _d(r.get("date")), "due": _d(r.get("date_maturity")) or _d(m.get("invoice_date_due")) or _d(r.get("date")),
            "invoice_date": _d(m.get("invoice_date")),
            "residual": float(r.get("amount_residual_currency") if r.get("amount_residual_currency") not in (None, False) else r.get("amount_residual") or 0),
            "residual_company": float(r.get("amount_residual") or 0),
            "amount_document": float(m.get("amount_total") or 0),
            "customer_id": cust, "customer": cp.get("name") or m2o_name(m.get("commercial_partner_id")) or "Unknown customer",
            "customer_ref": cp.get("ref") or "",
            "rep_id": rep_id or 0, "rep": sp.get("name") or u.get("name") or "Unassigned", "rep_odoo_name": u.get("name") or "",
            "rep_email": u.get("email") or (u.get("login") if "@" in str(u.get("login") or "") else "") or "",
            "rep_source": rep_src, "team": team_name or "", "team_key": team_key or "", "channel": sp.get("channel") or "",
            "excluded": excluded, "origin": m.get("invoice_origin") or m.get("ref") or "",
        })
    cols = ["line_id", "move_id", "document", "move_type", "in_scope", "settle_class", "kind", "company_id", "company",
            "currency", "date", "due", "invoice_date", "residual", "residual_company", "amount_document", "customer_id",
            "customer", "customer_ref", "rep_id", "rep", "rep_odoo_name", "rep_email", "rep_source", "team", "team_key",
            "channel", "excluded", "origin"]
    every = pd.DataFrame(rows, columns=cols)

    settle_by_line = dict(zip(every["line_id"], every["settle_class"]))
    prow = []
    for p in partials_raw:
        amount = float(p.get("amount") or 0)
        da = p.get("debit_amount_currency")
        ca = p.get("credit_amount_currency")
        prow.append({"partial_id": p["id"], "debit_line": m2o_id(p["debit_move_id"]), "credit_line": m2o_id(p["credit_move_id"]),
                     "amt_debit": float(da) if da not in (None, False) else amount,
                     "amt_credit": float(ca) if ca not in (None, False) else amount,
                     "max_date": _d(p.get("max_date")),
                     "credit_class": settle_by_line.get(m2o_id(p["credit_move_id"]), "other")})
    partials = pd.DataFrame(prow, columns=["partial_id", "debit_line", "credit_line", "amt_debit", "amt_credit", "max_date", "credit_class"])

    lines = every[every["in_scope"]].reset_index(drop=True)
    meta = {"open_lines_read": len(open_lines), "closed_lines_read": len(closed_lines), "partials": len(partials),
            "lines_in_scope": len(lines), "excluded": lines["excluded"].value_counts(dropna=True).to_dict(),
            "rep_source": lines["rep_source"].value_counts().to_dict()}
    log.info("Extract: %s", meta)
    return Extract(lines=lines, partials=partials, since=since, meta=meta)
