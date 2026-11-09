"""Reconciles the dashboard's NET balance per customer + company + currency with Odoo's partner balance, and lists the
customers finance should reconcile in Odoo: overdue invoices AND open credit notes / unreconciled payments at once.

  python scripts/finance/reconcile_net_credits.py [--date 2026-11-06] [--out ../../OUTPUT] [--no-odoo] [--env-file .env]

Since 2026-11-09 the Credit Policy chart, the Customers table aging bucket and the collection rate apply a customer's
unapplied credits FIFO to its open invoices (backend/src/measures/creditAllocation.ts). That is only right if the
snapshot's net balance per group equals Odoo's, so this script checks it, line by line:

  dashboard  = the snapshot's lines in the report's scope (customer debt, no inter-company, no 'other' scope, no
               excluded segment / team -- an invoice-only rule keeps that team's credits), kinds invoice, credit note
               and payment, summed per CustomerKey + CompanyKey + currency (residual_doc_ccy, residual_company_ccy);
  odoo       = Odoo's open receivable lines NOW (posted, unreconciled, residual != 0; read-only search_read), the
               same line ids kept or excluded as on the snapshot; summed the same way.

Every difference is explained per line: a line opened in Odoo after the snapshot, a line closed (paid / reconciled)
since, or a residual that changed since (write_date after the snapshot load). A difference with no such line is
"unexplained". Re-run right after the finance job for the smallest timing noise.

Writes, in --out:
  net_credits_reconciliation_<date>.csv    every group, both sides, difference and its explanation
  net_credits_to_reconcile_<date>.csv      groups with overdue invoices and open credits (snapshot only)
Read-only on both sides. --no-odoo skips Odoo (the second CSV only).
"""

from __future__ import annotations

import argparse
import csv
import datetime as _dt
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
for p in (ROOT, ROOT / "src"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

from sqlalchemy import create_engine, text  # noqa: E402

from departments.finance.jobs import RECEIVABLE_DOMAIN  # noqa: E402
from etl_platform.config import PlatformConfig  # noqa: E402

TOL = 0.005

# The Debt Report's line kinds and scope (backend measures/debtReport.ts LINE_KIND_SQL, EXCLUDED_TEAMS_CONDITION).
LINES_SQL = """
SELECT f.line_id, f.move_id, i.document, i.move_type, f.CustomerKey, f.CustomerKey AS partner_id, cu.customer, cu.ref,
       f.CompanyKey, co.Company AS company, cur.currency, f.days_past_due,
       DATE_FORMAT(COALESCE(f.due_date, i.invoice_final_due_date), '%Y-%m-%d') AS due, DATE_FORMAT(i.invoice_date, '%Y-%m-%d') AS invoice_date,
       f.residual_doc_ccy AS doc, f.residual_company_ccy AS lyd,
       CASE WHEN f.is_intercompany = 1 THEN 'intercompany'
            WHEN rs.is_default = 0 THEN 'other'
            WHEN f.PaymentKey = -1 AND i.move_type = 'out_invoice' THEN 'invoice'
            WHEN f.PaymentKey = -1 AND i.move_type = 'out_refund' THEN 'credit_note'
            ELSE 'payment' END AS kind,
       EXISTS (SELECT 1 FROM v_finance_excluded_sales_team x WHERE x.SalesTeamKey = f.SalesTeamKey
                 AND (x.invoices_only = 0 OR (f.PaymentKey = -1 AND i.move_type = 'out_invoice'))) AS team_excluded
FROM fact_finance_receivable_snapshot f
JOIN dim_finance_receivable_scope rs ON rs.receivable_scope = f.receivable_scope
JOIN dim_finance_invoice i ON i.move_id = f.move_id
JOIN dim_customer cu ON cu.CustomerKey = f.CustomerKey
JOIN dim_company co ON co.CompanyKey = f.CompanyKey
JOIN dim_currency cur ON cur.CurrencyKey = f.CurrencyKey
WHERE f.SnapshotDateKey = :s
"""


def fifo_overdue(lines: list[dict]) -> tuple[float, float, float]:
    """(invoice overdue before, overdue after the credits, credits applied) of one group -- the creditAllocation.ts rule."""
    pool = -sum(l["doc"] for l in lines if not (l["kind"] == "invoice" and l["doc"] > 0))
    left = max(0.0, pool)
    open_lines = sorted((l for l in lines if l["kind"] == "invoice" and l["doc"] > 0),
                        key=lambda l: (l["due"] is None, l["due"] or "", l["invoice_date"] or "", l["move_id"], l["line_id"]))
    before = after = 0.0
    for l in open_lines:
        take = min(left, l["doc"])
        left -= take
        if l["days_past_due"] > 0:
            before += l["doc"]
            after += l["doc"] - take
    return before, after, max(0.0, pool) - left


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--date", help="snapshot date (default: the latest snapshot)")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parents[5] / "OUTPUT"), help="output directory")
    ap.add_argument("--no-odoo", action="store_true", help="skip the Odoo comparison")
    ap.add_argument("--env-file", help="the platform .env (default: found from data/etl)")
    args = ap.parse_args()
    config = PlatformConfig.from_env(args.env_file)
    engine = create_engine(config.database_url)
    with engine.connect() as conn:
        snap = int(args.date.replace("-", "")) if args.date else conn.execute(text("SELECT MAX(SnapshotDateKey) FROM fact_finance_receivable_snapshot")).scalar()
        loaded = conn.execute(text("SELECT MAX(loaded_at_utc) FROM fact_finance_receivable_snapshot WHERE SnapshotDateKey = :s"), {"s": snap}).scalar()
        rows = [dict(r._mapping) for r in conn.execute(text(LINES_SQL), {"s": snap})]
    for r in rows:
        for k in ("doc", "lyd"):
            r[k] = float(r[k] or 0)
        r["days_past_due"] = int(r["days_past_due"] or 0)
        r["kept"] = r["kind"] in ("invoice", "credit_note", "payment") and not r["team_excluded"]
    by_line = {int(r["line_id"]): r for r in rows}
    kept = [r for r in rows if r["kept"]]
    snap_iso = f"{str(snap)[:4]}-{str(snap)[4:6]}-{str(snap)[6:]}"
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    print(f"Snapshot {snap_iso} (loaded {loaded} UTC): {len(rows):,} lines, {len(kept):,} in the report's scope")

    groups: dict[tuple, list[dict]] = defaultdict(list)
    for r in kept:
        groups[(int(r["CustomerKey"]), int(r["CompanyKey"]), r["currency"])].append(r)

    # ---- customers finance should reconcile: overdue invoices + open credits ------------------------------------------
    todo = []
    for (cust, comp, ccy), ls in groups.items():
        credits = [l for l in ls if l["kind"] in ("credit_note", "payment") and l["doc"] < 0]
        if not credits:
            continue
        before, after, applied = fifo_overdue(ls)
        if before <= TOL:
            continue
        f = ls[0]
        todo.append({
            "customer_key": cust, "customer_code": f["ref"] or f["partner_id"], "customer": f["customer"], "company": f["company"], "currency": ccy,
            "overdue_invoices": round(before, 3), "open_credits": round(-sum(l["doc"] for l in credits), 3), "credits_applied_to_overdue": round(before - after, 3),
            "overdue_after_credits": round(after, 3), "net_balance": round(sum(l["doc"] for l in ls), 3),
            "credit_documents": " ".join(sorted({str(l["document"]) for l in credits})),
            "overdue_documents": " ".join(sorted({str(l["document"]) for l in ls if l["kind"] == "invoice" and l["doc"] > 0 and l["days_past_due"] > 0})),
        })
    todo.sort(key=lambda t: -t["credits_applied_to_overdue"])
    todo_path = out / f"net_credits_to_reconcile_{snap_iso}.csv"
    with todo_path.open("w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=list(todo[0].keys()) if todo else ["customer_key"])
        w.writeheader()
        w.writerows(todo)
    covered = sum(1 for t in todo if t["overdue_after_credits"] <= TOL)
    print(f"To reconcile in Odoo: {len(todo)} customer/company/currency groups with overdue invoices AND open credits "
          f"({covered} fully covered = no longer overdue on the dashboard) -> {todo_path}")
    if args.no_odoo:
        return 0

    # ---- Odoo now, line by line ------------------------------------------------------------------------------------
    from etl_platform.sources.odoo import OdooSource  # noqa: E402
    odoo = OdooSource.connect(config, "default", today=_dt.date.today())
    companies = sorted({int(r["CompanyKey"]) for r in rows if int(r["CompanyKey"]) > 0})
    o_lines = odoo.search_read_all("account.move.line", [*RECEIVABLE_DOMAIN, ("company_id", "in", companies)],
                                   ["id", "move_id", "partner_id", "company_id", "currency_id", "amount_residual", "amount_residual_currency", "write_date"])
    o_by_id = {int(l["id"]): l for l in o_lines}
    loaded_s = str(loaded)[:19] if loaded else ""
    diff_lines: dict[tuple, list[str]] = defaultdict(list)
    odoo_sum: dict[tuple, list[float]] = defaultdict(lambda: [0.0, 0.0])
    customer_of_partner = {str(r["partner_id"]): int(r["CustomerKey"]) for r in rows if r["partner_id"] is not None}
    new_lines = 0
    for lid, ol in o_by_id.items():
        r = by_line.get(lid)
        if r is None:
            # opened after the snapshot: added to its partner's group (when the snapshot has one), always a timing note
            new_lines += 1
            partner = str(ol["partner_id"][0]) if ol.get("partner_id") else None
            ccy = ol["currency_id"][1] if ol.get("currency_id") else None
            key = (customer_of_partner.get(partner or ""), ol["company_id"][0] if ol.get("company_id") else None, ccy)
            odoo_sum[key][0] += float(ol["amount_residual_currency"] or 0)
            odoo_sum[key][1] += float(ol["amount_residual"] or 0)
            diff_lines[key].append(f"new since the snapshot {ol['move_id'][1] if ol.get('move_id') else lid} {float(ol['amount_residual_currency'] or 0):,.3f}")
            continue
        if not r["kept"]:
            continue
        key = (int(r["CustomerKey"]), int(r["CompanyKey"]), r["currency"])
        odoo_sum[key][0] += float(ol["amount_residual_currency"] or 0)
        odoo_sum[key][1] += float(ol["amount_residual"] or 0)
        if abs(float(ol["amount_residual_currency"] or 0) - r["doc"]) > TOL:
            why = "changed after the snapshot" if str(ol.get("write_date") or "") > loaded_s else "DIFFERENT, not changed since"
            diff_lines[key].append(f"{r['document']} {r['doc']:,.3f} -> {float(ol['amount_residual_currency'] or 0):,.3f} ({why})")
    for lid, r in by_line.items():
        if r["kept"] and lid not in o_by_id:
            diff_lines[(int(r["CustomerKey"]), int(r["CompanyKey"]), r["currency"])].append(f"{r['document']} {r['doc']:,.3f} closed in Odoo since")
    result = []
    for key, ls in groups.items():
        cust, comp, ccy = key
        dash = sum(l["doc"] for l in ls)
        o = odoo_sum.get(key, [0.0, 0.0])[0]
        notes = diff_lines.get(key, [])
        diff = round(dash - o, 3)
        explained = abs(diff) <= TOL or (notes and not any("DIFFERENT" in n for n in notes))
        result.append({
            "customer_key": cust, "customer_code": ls[0]["ref"] or ls[0]["partner_id"], "customer": ls[0]["customer"], "company": ls[0]["company"],
            "currency": ccy, "dashboard_net": round(dash, 3), "odoo_net_now": round(o, 3), "difference": diff,
            "status": "match" if abs(diff) <= TOL else ("timing" if explained else "UNEXPLAINED"), "lines": "; ".join(notes)[:2000],
        })
    result.sort(key=lambda r: (r["status"] == "match", -abs(r["difference"])))
    rec_path = out / f"net_credits_reconciliation_{snap_iso}.csv"
    with rec_path.open("w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=list(result[0].keys()))
        w.writeheader()
        w.writerows(result)
    counts = defaultdict(int)
    for r in result:
        counts[r["status"]] += 1
    print(f"Net balance vs Odoo now: {len(result):,} groups -> match {counts['match']:,}, timing {counts['timing']:,}, "
          f"UNEXPLAINED {counts['UNEXPLAINED']:,}; {new_lines:,} Odoo lines opened since the snapshot -> {rec_path}")
    return 1 if counts["UNEXPLAINED"] else 0


if __name__ == "__main__":
    sys.exit(main())
