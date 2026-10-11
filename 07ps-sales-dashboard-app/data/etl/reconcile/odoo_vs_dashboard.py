"""Odoo vs dashboard reconciliation of open customer invoices (Receivables and Collections page), per company x currency
and per invoice. READ-ONLY on both sides: Odoo through the guarded client (read methods only), the warehouse through
SELECTs.

  python reconcile/odoo_vs_dashboard.py [--date 2026-10-11] [--db-host 127.0.0.1] [--out DIR]

Odoo side = Odoo's Invoicing > Customers > Invoices list with the filters Unpaid + Posted, i.e. account.move with
  move_type = out_invoice, state = posted, payment_state in (not_paid, partial)
for EVERY company in res.company (not only the ETL's configured ones). Columns as in Odoo's list grouped by currency:
  Total (LYD) = amount_total_signed, Total in currency = amount_total_in_currency_signed,
  Amount Due (LYD) = amount_residual_signed, Amount Due in currency = amount_residual (sign of the move).
Overdue / not yet due on both sides at receivable-LINE level (account.move.line date_maturity, the instalments), the
dashboard's own rule: due before the as-of date = overdue, due today = not yet due. The invoice-level due date
(invoice_date_due) is printed next to it.

Dashboard side = the snapshot table (fact_finance_receivable_snapshot, the given or latest snapshot) and, for every
invoice, whether the page shows it: the API's default view (measures/debtReport.ts) = customer invoices
(PaymentKey -1, move_type out_invoice), receivable scope default, inter-company excluded, report exclusions
(v_finance_excluded_sales_team via EXCLUDED_TEAMS_CONDITION) applied.

Outputs (in --out, default reconcile/out/<date>):
  summary_company_currency.csv  one row per company x currency: Odoo vs snapshot vs page
  invoice_gaps.csv              one row per invoice that differs, with a REASON
  reasons.csv                   reason | companies | invoices | amount (LYD)
and a printed summary. Never prints credentials.
"""

from __future__ import annotations

import argparse
import csv
import datetime as _dt
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
for p in (ROOT, ROOT / "src"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

from sqlalchemy import create_engine, text  # noqa: E402
from sqlalchemy.engine import make_url  # noqa: E402

from etl_platform.config import PlatformConfig  # noqa: E402
from etl_platform.sources.odoo import OdooSource, m2o_id, m2o_name  # noqa: E402

LOCAL_DB_HOSTS = {"127.0.0.1", "localhost", "host.docker.internal"}
ODOO_LIST_DOMAIN = [("move_type", "=", "out_invoice"), ("state", "=", "posted"), ("payment_state", "in", ["not_paid", "partial"])]
MOVE_FIELDS = ["id", "name", "company_id", "currency_id", "partner_id", "commercial_partner_id", "invoice_date", "invoice_date_due",
               "amount_total_signed", "amount_total_in_currency_signed", "amount_residual_signed", "amount_residual", "payment_state",
               "team_id", "invoice_user_id", "create_date", "write_date"]
LINE_FIELDS = ["id", "move_id", "date", "date_maturity", "amount_residual", "amount_residual_currency", "account_id", "reconciled", "write_date"]
TOL = 0.01
# the finance extraction reads Odoo during the minutes before the load time: a change in that window may or may not be in
EXTRACT_WINDOW = _dt.timedelta(minutes=15)

# the page's default view, per invoice line (debtReport.ts baseConditions + LINE_KIND_SQL 'invoice')
SNAPSHOT_SQL = """
SELECT f.move_id, f.line_id, f.CompanyKey, f.CustomerKey, f.CurrencyKey, cur.currency, f.SalesTeamKey, st.SalesTeam,
       sg.Segment, f.due_date, f.days_past_due, f.residual_company_ccy, f.residual_doc_ccy, f.is_intercompany,
       f.receivable_scope, rs.is_default, f.PaymentKey, i.move_type, i.document, f.loaded_at_utc,
       CASE WHEN EXISTS (SELECT 1 FROM v_finance_excluded_sales_team x WHERE x.SalesTeamKey = f.SalesTeamKey
                         AND (x.invoices_only = 0 OR (f.PaymentKey = -1 AND i.move_type = 'out_invoice'))) THEN 1 ELSE 0 END AS excluded,
       (SELECT CONCAT_WS(' / ', MAX(CASE WHEN x.excluded_invoices = 1 THEN 'no Odoo sales team' END),
                       MAX(CASE WHEN x.excluded_by_team = 1 THEN CONCAT('team ', x.sales_team) END),
                       MAX(CASE WHEN x.excluded_by_segment = 1 THEN CONCAT('segment ', x.segment) END))
          FROM v_finance_excluded_sales_team x WHERE x.SalesTeamKey = f.SalesTeamKey) AS exclusion_rule
FROM fact_finance_receivable_snapshot f
JOIN dim_finance_receivable_scope rs ON rs.receivable_scope = f.receivable_scope
JOIN dim_finance_invoice i ON i.move_id = f.move_id
JOIN dim_currency cur ON cur.CurrencyKey = f.CurrencyKey
JOIN dim_sales_team st ON st.SalesTeamKey = f.SalesTeamKey
LEFT JOIN dim_segment sg ON sg.SegmentKey = st.SegmentKey
WHERE f.SnapshotDateKey = :snap AND f.PaymentKey = -1 AND i.move_type = 'out_invoice'
"""


def num(v: Any) -> float:
    return 0.0 if v in (None, False) else float(v)


def as_date(v: Any) -> _dt.date | None:
    if v in (None, False, ""):
        return None
    if isinstance(v, _dt.datetime):
        return v.date()
    if isinstance(v, _dt.date):
        return v
    return _dt.date.fromisoformat(str(v)[:10])


def as_dt(v: Any) -> _dt.datetime | None:
    if v in (None, False, ""):
        return None
    if isinstance(v, _dt.datetime):
        return v
    return _dt.datetime.fromisoformat(str(v)[:19])


# -- Odoo --------------------------------------------------------------------------------------------------------------
def report_company_ids(config: PlatformConfig, companies: list[dict]) -> set[int]:
    """The report's companies: the ETL's one config list (ODOO_COMPANY_IDS + ODOO_COMPANY_NAMES, as the runner resolves it)."""
    from sales_pipeline.product_matching import normalize_match_company

    by_name = {normalize_match_company(c["name"]).upper(): int(c["id"]) for c in companies if c.get("name")}
    ids = set(config.odoo_company_ids)
    for name in config.odoo_company_names:
        key = normalize_match_company(name).upper()
        if key not in by_name:
            raise RuntimeError(f"ODOO_COMPANY_NAMES entry not found in Odoo: {name}")
        ids.add(by_name[key])
    return ids


def odoo_side(src: OdooSource, as_of: _dt.date, config: PlatformConfig) -> tuple[list[dict], dict[int, dict], dict[int, str], set[int]]:
    """(companies, open invoices by move id, company id -> why it is not read, the report's company ids)."""
    x = src.client.execute_kw
    companies = x("res.company", "search_read", [[]], {"fields": ["id", "name", "currency_id"], "order": "id", "context": {"active_test": False}})
    user = x("res.users", "read", [[src.client.uid], ["company_ids"]])[0]
    allowed = set(user["company_ids"])
    report_ids = report_company_ids(config, companies)
    invoices: dict[int, dict] = {}
    refused: dict[int, str] = {}
    for c in companies:
        cid = int(c["id"])
        if cid not in report_ids:
            refused[cid] = "out of the report (not in ODOO_COMPANY_IDS / ODOO_COMPANY_NAMES)"
            continue
        if cid not in allowed:
            refused[cid] = "IN THE REPORT BUT NOT READABLE: not in the API user's allowed companies (Odoo refuses reads)"
            continue
        ctx = {"allowed_company_ids": [cid], "active_test": False}
        dom = [("company_id", "=", cid), *ODOO_LIST_DOMAIN]
        moves = x("account.move", "search_read", [dom], {"fields": MOVE_FIELDS, "order": "id", "context": ctx})
        ids = [m["id"] for m in moves]
        lines: dict[int, list[dict]] = defaultdict(list)
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            for ln in x("account.move.line", "search_read",
                        [[("move_id", "in", chunk), ("account_type", "=", "asset_receivable"), ("reconciled", "=", False), ("amount_residual", "!=", 0)]],
                        {"fields": LINE_FIELDS, "context": ctx}):
                lines[m2o_id(ln["move_id"])].append(ln)
        for m in moves:
            ls = lines.get(m["id"], [])
            # a line without date_maturity falls back to the invoice due date, then the line date (Odoo's aged
            # receivable does the same: COALESCE(date_maturity, date); the ETL: transform.due_date)
            for ln in ls:
                ln["_due"] = as_date(ln["date_maturity"]) or as_date(m["invoice_date_due"]) or as_date(ln["date"])
            overdue = sum(num(ln["amount_residual"]) for ln in ls if ln["_due"] and ln["_due"] < as_of)
            invoices[m["id"]] = {
                "move_id": m["id"], "document": m["name"], "company_id": cid, "company": c["name"],
                "currency": m2o_name(m["currency_id"]), "customer_id": m2o_id(m["commercial_partner_id"]),
                "customer": m2o_name(m["commercial_partner_id"]), "invoice_date": as_date(m["invoice_date"]),
                "due_date": as_date(m["invoice_date_due"]),
                "line_due_max": max((ln["_due"] for ln in ls if ln["_due"]), default=None),
                "lines_without_maturity": sum(1 for ln in ls if not ln["date_maturity"]),
                "total_company": num(m["amount_total_signed"]), "total_ccy": num(m["amount_total_in_currency_signed"]),
                "due_company": num(m["amount_residual_signed"]), "due_ccy": num(m["amount_residual"]),
                "lines_due_company": sum(num(ln["amount_residual"]) for ln in ls),
                "lines_due_ccy": sum(num(ln["amount_residual_currency"]) for ln in ls), "n_lines": len(ls),
                "overdue_company": overdue, "team_id": m2o_id(m["team_id"]), "team": m2o_name(m["team_id"]),
                "create_date": as_dt(m["create_date"]), "write_date": as_dt(m["write_date"]),
            }
    return companies, invoices, refused, report_ids


def odoo_recheck(src: OdooSource, move_ids: list[int], company_ids: list[int]) -> dict[int, dict]:
    """Current state in Odoo of the snapshot's invoices that are not open in Odoo now (paid since? cancelled?)."""
    out: dict[int, dict] = {}
    ctx = {"allowed_company_ids": company_ids, "active_test": False}
    for i in range(0, len(move_ids), 500):
        for m in src.client.execute_kw("account.move", "read", [move_ids[i:i + 500], ["id", "state", "payment_state", "amount_residual_signed", "write_date"]], {"context": ctx}):
            out[m["id"]] = m
    return out


# -- warehouse ---------------------------------------------------------------------------------------------------------
def snapshot_side(engine, snap: int) -> dict[int, dict]:
    docs: dict[int, dict] = {}
    with engine.connect() as conn:
        for r in conn.execute(text(SNAPSHOT_SQL), {"snap": snap}).mappings():
            d = docs.get(int(r["move_id"]))
            if d is None:
                d = docs[int(r["move_id"])] = {
                    "move_id": int(r["move_id"]), "document": r["document"], "company_id": int(r["CompanyKey"]), "customer_id": int(r["CustomerKey"]),
                    "currency": r["currency"], "team_key": r["SalesTeamKey"], "team": r["SalesTeam"], "segment": r["Segment"],
                    "due_company": 0.0, "due_ccy": 0.0, "overdue_company": 0.0, "n_lines": 0, "line_due_max": None,
                    "is_intercompany": int(r["is_intercompany"]), "is_default": int(r["is_default"]), "excluded": int(r["excluded"]),
                    "exclusion_rule": r["exclusion_rule"] or "", "loaded_at": r["loaded_at_utc"],
                }
            d["due_company"] += num(r["residual_company_ccy"])
            d["due_ccy"] += num(r["residual_doc_ccy"])
            if num(r["days_past_due"]) > 0:
                d["overdue_company"] += num(r["residual_company_ccy"])
            d["n_lines"] += 1
            dd = as_date(r["due_date"])
            if dd and (d["line_due_max"] is None or dd > d["line_due_max"]):
                d["line_due_max"] = dd
    for d in docs.values():
        d["shown"] = int(d["excluded"] == 0 and d["is_default"] == 1 and d["is_intercompany"] == 0)
    return docs


def hidden_reason(d: dict) -> str:
    if d["is_intercompany"]:
        return "in snapshot, hidden: inter-company partner (FINANCE_INTERCOMPANY_PARTNER_IDS / own company)"
    if not d["is_default"]:
        return "in snapshot, hidden: receivable scope not customer debt"
    return f"in snapshot, hidden: report exclusion ({d['exclusion_rule'] or d['team']})"


# -- main --------------------------------------------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--date", help="snapshot date (default: the latest snapshot)")
    ap.add_argument("--db-host", help="override DB_HOST (e.g. 127.0.0.1 when run outside Docker); must be local")
    ap.add_argument("--out", help="output folder (default reconcile/out/<snapshot date>)")
    args = ap.parse_args()

    config = PlatformConfig.from_env(str(ROOT / ".env"))
    url = make_url(config.database_url)
    if args.db_host:
        url = url.set(host=args.db_host)
    if url.host not in LOCAL_DB_HOSTS:
        print(f"refusing: DB host {url.host!r} is not local", file=sys.stderr)
        return 2
    engine = create_engine(url)
    with engine.connect() as conn:
        snap = int(args.date.replace("-", "")) if args.date else int(conn.execute(text("SELECT MAX(SnapshotDateKey) FROM fact_finance_receivable_snapshot")).scalar())
        loaded = conn.execute(text("SELECT MIN(loaded_at_utc), MAX(loaded_at_utc) FROM fact_finance_receivable_snapshot WHERE SnapshotDateKey = :s"), {"s": snap}).one()
    as_of = _dt.date(snap // 10000, snap // 100 % 100, snap % 100)
    today = _dt.datetime.now(ZoneInfo(config.business_timezone)).date()
    snap_loaded = loaded[1]
    print(f"snapshot {as_of} loaded {loaded[0]} .. {loaded[1]} UTC; Odoo read now ({today}); overdue as of {as_of}")

    src = OdooSource.connect(config, "debt", today=today)
    companies, odoo, refused, report_ids = odoo_side(src, as_of, config)
    ours = snapshot_side(engine, snap)
    names = {int(c["id"]): c["name"] for c in companies}
    print("\nOdoo companies:")
    for c in companies:
        cid = int(c["id"])
        state = refused.get(cid, "in the report, readable")
        print(f"  {cid:>3} {c['name']:<16} currency {m2o_name(c['currency_id'])}  {state}")

    gone = sorted(m for m in ours if m not in odoo)
    now_state = odoo_recheck(src, gone, sorted(report_ids - set(refused))) if gone else {}

    gaps: list[dict] = []

    def gap(reason: str, o: dict | None, d: dict | None, detail: str = "") -> None:
        base = o or d
        gaps.append({
            "reason": reason, "company": names.get(base["company_id"], base["company_id"]), "move_id": base["move_id"],
            "document": (o or {}).get("document") or (d or {}).get("document"), "currency": base["currency"],
            "customer_odoo": (o or {}).get("customer_id"), "customer_dash": (d or {}).get("customer_id"),
            "due_lyd_odoo": round(o["due_company"], 2) if o else "", "due_lyd_dash": round(d["due_company"], 2) if d else "",
            "due_ccy_odoo": round(o["due_ccy"], 2) if o else "", "due_ccy_dash": round(d["due_ccy"], 2) if d else "",
            "due_date_odoo": (o or {}).get("due_date") or "", "line_due_odoo": (o or {}).get("line_due_max") or "",
            "line_due_dash": (d or {}).get("line_due_max") or "",
            "overdue_lyd_odoo": round(o["overdue_company"], 2) if o else "", "overdue_lyd_dash": round(d["overdue_company"], 2) if d else "",
            "odoo_team": (o or {}).get("team") or "", "dash_team": (d or {}).get("team") or "",
            "odoo_created": (o or {}).get("create_date") or "", "odoo_write": (o or {}).get("write_date") or "",
            "detail": detail, "amount_lyd": round((o or d)["due_company"], 2),
        })

    for mid, o in odoo.items():
        d = ours.get(mid)
        if d is None:
            if o["company_id"] not in {dd["company_id"] for dd in ours.values()}:
                gap("missing: no snapshot line at all for this company (ETL did not extract it)", o, None)
            elif o["write_date"] and snap_loaded and o["write_date"] > snap_loaded:
                gap("missing: created/changed in Odoo after the snapshot was taken (stale snapshot)", o, None,
                    f"odoo write {o['write_date']} > snapshot {snap_loaded}")
            else:
                gap("missing: open in Odoo before the snapshot but not extracted (UNEXPLAINED)", o, None)
            continue
        diffs = []
        if d["company_id"] != o["company_id"]:
            diffs.append("company")
        if d["currency"] != o["currency"]:
            diffs.append("currency")
        if d["customer_id"] != o["customer_id"]:
            diffs.append("customer")
        if abs(d["due_company"] - o["due_company"]) > TOL or abs(d["due_ccy"] - o["due_ccy"]) > TOL:
            diffs.append("amount")
        if d["line_due_max"] != o["line_due_max"]:
            diffs.append("due date")
        if abs(d["overdue_company"] - o["overdue_company"]) > TOL:
            diffs.append("overdue split")
        if diffs:
            changed = o["write_date"] and snap_loaded and o["write_date"] > snap_loaded
            why = "differs: changed in Odoo after the snapshot (stale snapshot)" if changed else f"differs: {', '.join(diffs)} (UNEXPLAINED)"
            if not changed and diffs == ["customer"]:
                why = "differs: customer = invoice line partner, not Odoo's commercial partner"
            gap(why, o, d, f"fields: {', '.join(diffs)}")
        if not d["shown"]:
            gap(hidden_reason(d), o, d)

    for mid in gone:
        d = ours[mid]
        cur = now_state.get(mid)
        if cur is None:
            gap("extra: in snapshot, not readable in Odoo now (deleted or company refused)", None, d)
        elif cur.get("write_date") and snap_loaded and as_dt(cur["write_date"]) > snap_loaded:
            gap(f"extra: in snapshot, closed in Odoo after the snapshot (now {cur['state']}/{cur['payment_state']})", None, d)
        elif cur.get("write_date") and snap_loaded and as_dt(cur["write_date"]) > snap_loaded - EXTRACT_WINDOW:
            gap(f"extra: in snapshot, closed in Odoo while the snapshot was being extracted (now {cur['state']}/{cur['payment_state']})", None, d,
                f"odoo write {cur['write_date']}, snapshot loaded {snap_loaded}")
        else:
            gap(f"extra: in snapshot but not open in Odoo (now {cur['state']}/{cur['payment_state']}) (UNEXPLAINED)", None, d)

    # summary per company x currency
    agg: dict[tuple[str, str], dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for o in odoo.values():
        a = agg[(o["company"], o["currency"])]
        a["odoo_n"] += 1
        a["odoo_total_lyd"] += o["total_company"]
        a["odoo_total_ccy"] += o["total_ccy"]
        a["odoo_due_lyd"] += o["due_company"]
        a["odoo_due_ccy"] += o["due_ccy"]
        a["odoo_overdue_lyd"] += o["overdue_company"]
    for d in ours.values():
        a = agg[(names.get(d["company_id"], str(d["company_id"])), d["currency"])]
        for pre, ok in (("snap", True), ("page", bool(d["shown"]))):
            if ok:
                a[f"{pre}_n"] += 1
                a[f"{pre}_due_lyd"] += d["due_company"]
                a[f"{pre}_due_ccy"] += d["due_ccy"]
                a[f"{pre}_overdue_lyd"] += d["overdue_company"]
    cols = ["odoo_n", "snap_n", "page_n", "odoo_total_lyd", "odoo_total_ccy", "odoo_due_lyd", "snap_due_lyd", "page_due_lyd",
            "odoo_due_ccy", "snap_due_ccy", "page_due_ccy", "odoo_overdue_lyd", "snap_overdue_lyd", "page_overdue_lyd"]

    out = Path(args.out) if args.out else ROOT / "reconcile" / "out" / str(as_of)
    out.mkdir(parents=True, exist_ok=True)
    with open(out / "summary_company_currency.csv", "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["company", "currency", *cols])
        for (comp, ccy), a in sorted(agg.items()):
            w.writerow([comp, ccy, *[round(a.get(c, 0.0), 2) for c in cols]])
    with open(out / "invoice_gaps.csv", "w", newline="", encoding="utf-8-sig") as fh:
        if gaps:
            w = csv.DictWriter(fh, fieldnames=list(gaps[0]))
            w.writeheader()
            w.writerows(sorted(gaps, key=lambda g: (g["reason"], str(g["company"]), g["move_id"])))
    reasons: dict[str, dict] = {}
    for g in gaps:
        r = reasons.setdefault(g["reason"], {"companies": set(), "invoices": set(), "amount": 0.0})
        r["companies"].add(str(g["company"]))
        r["invoices"].add(g["move_id"])
        r["amount"] += num(g["amount_lyd"])
    with open(out / "reasons.csv", "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["reason", "companies", "invoices", "amount_lyd"])
        for k, r in sorted(reasons.items(), key=lambda kv: -kv[1]["amount"]):
            w.writerow([k, ", ".join(sorted(r["companies"])), len(r["invoices"]), round(r["amount"], 2)])

    print("\nPer company x currency (n = invoices, amounts = Amount Due in LYD; page = what the dashboard shows):")
    print(f"  {'company':<14}{'ccy':<5}{'odoo n':>7}{'snap n':>7}{'page n':>7}{'odoo due':>15}{'snap due':>15}{'page due':>15}{'odoo overdue':>15}{'page overdue':>15}")
    for (comp, ccy), a in sorted(agg.items()):
        print(f"  {comp:<14}{ccy:<5}{a['odoo_n']:>7.0f}{a['snap_n']:>7.0f}{a['page_n']:>7.0f}{a['odoo_due_lyd']:>15,.2f}{a['snap_due_lyd']:>15,.2f}"
              f"{a['page_due_lyd']:>15,.2f}{a['odoo_overdue_lyd']:>15,.2f}{a['page_overdue_lyd']:>15,.2f}")
    print("\nReasons (an invoice can have 2: e.g. differs + hidden):")
    for k, r in sorted(reasons.items(), key=lambda kv: -kv[1]["amount"]):
        print(f"  {len(r['invoices']):>5} inv  {r['amount']:>15,.2f} LYD  [{', '.join(sorted(r['companies']))}]  {k}")
    print(f"\nCSV: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
