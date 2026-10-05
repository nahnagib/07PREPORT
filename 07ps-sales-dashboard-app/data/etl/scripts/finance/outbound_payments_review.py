"""Review of the OUTBOUND customer payments in the receivable snapshot, for finance (read-only; no logic change).

  python scripts/finance/outbound_payments_review.py --date 2026-10-04 --out docs/

An outbound customer payment ("Send" to a "Customer") debits the customer's receivable: in the snapshot it is a
POSITIVE open amount. This script breaks them down (journal, company, creator user, customer's salesperson, month,
payment state, memo pattern), checks for a likely mispost or missed reconciliation -- an unreconciled inbound payment
or an open customer invoice for the same customer and amount within +-7 days -- and lists the top partners, sample
documents (Odoo ids) and the receivable lines that have no partner at all. Totals are Odoo's, unchanged.

Writes <out>/finance_outbound_payments_review.csv (one row per outbound payment line),
<out>/finance_receivable_lines_without_partner.csv and prints the tables used by the review document.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import pandas as pd
from sqlalchemy import create_engine, text

ROOT = Path(__file__).resolve().parents[2]
for p in (ROOT, ROOT / "src"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

from config.settings import Settings  # noqa: E402

MATCH_DAYS = 7
TOL = 0.01
MEMO_PATTERNS = [  # (pattern name, regex) -- first match wins; for grouping only
    ("empty", r"^\s*$"),
    ("personal withdrawal", r"مسحوبات شخصية|personal"),
    ("salary", r"مرتب|راتب|رواتب|salary"),
    ("zakat", r"زكاة|زكاه"),
    ("custody / advance", r"عهدة|عهده|سلفة|سلفه|advance"),
    ("transport", r"نقل|شحن|transport|shipping"),
    ("project / construction", r"مشروع|اعمال|أعمال|تأسيس|project"),
    ("cheque", r"شيك|cheque|check|chq"),
    ("transfer", r"تحويل|transfer|حوالة"),
    ("cash", r"نقد|كاش|cash"),
    ("refund / return", r"ارجاع|إرجاع|استرجاع|مرتجع|refund|return"),
    ("invoice reference", r"INV/|فاتورة"),
    ("salesperson / collector", r"مندوب|تحصيل|collect"),
    ("number only", r"^[\s\d/\-#.]+$"),
]


def memo_pattern(memo) -> str:
    text_ = "" if memo is None or (not isinstance(memo, str) and pd.isna(memo)) else str(memo)
    for name, rx in MEMO_PATTERNS:
        if re.search(rx, text_, re.I):
            return name
    return "other text"


def load(conn, snap: int) -> tuple[pd.DataFrame, pd.DataFrame]:
    lines = pd.read_sql(text("""
        SELECT f.line_id, f.move_id, f.PaymentKey, f.CustomerKey, f.CompanyKey, f.SalespersonKey AS line_salesperson_key,
               f.residual_company_ccy, f.due_date, f.days_past_due, f.is_intercompany,
               i.document, i.move_type, i.invoice_date, i.amount_total,
               p.payment_reference, p.payment_type, p.partner_type, p.state AS payment_state, p.journal_id, p.journal_name_en,
               p.journal_name_ar, p.payment_date, p.amount AS payment_amount, p.memo, p.is_reconciled, p.is_matched,
               p.created_by_user_id, cu.customer, cu.SalespersonKey AS customer_salesperson_key, sp.salesperson AS customer_salesperson,
               co.Company AS company
        FROM fact_finance_receivable_snapshot f
        JOIN dim_finance_invoice i ON i.move_id = f.move_id
        JOIN dim_finance_payment p ON p.PaymentKey = f.PaymentKey
        JOIN dim_customer cu ON cu.CustomerKey = f.CustomerKey
        JOIN dim_salesperson sp ON sp.SalespersonKey = cu.SalespersonKey
        JOIN dim_company co ON co.CompanyKey = f.CompanyKey
        WHERE f.SnapshotDateKey = :s"""), conn, params={"s": snap})
    nopartner = pd.read_sql(text("""
        SELECT l.id AS line_id, l.move_id, l.move_name AS entry, m.move_type, j.name_en AS journal_en, j.name_ar AS journal_ar,
               l.date, l.date_maturity, l.amount_residual, l.company_id
        FROM raw_odoo_account_move_line l
        LEFT JOIN raw_odoo_account_move m ON m.id = l.move_id
        LEFT JOIN raw_odoo_account_journal j ON j.id = m.journal_id
        WHERE l.partner_id IS NULL ORDER BY l.date, l.id"""), conn)
    return lines, nopartner


def match_candidates(lines: pd.DataFrame) -> pd.DataFrame:
    """For each outbound customer payment line: an unreconciled inbound payment (residual = -X) or an open customer
    invoice (residual = X) of the same customer and company, dated within +-MATCH_DAYS days."""
    out = lines[(lines["payment_type"] == "outbound") & (lines["partner_type"] == "customer")].copy()
    inbound = lines[(lines["payment_type"] == "inbound") & (lines["partner_type"] == "customer")].copy()
    invoices = lines[lines["move_type"] == "out_invoice"].copy()
    inbound["ref_date"] = pd.to_datetime(inbound["payment_date"])
    invoices["ref_date"] = pd.to_datetime(invoices["invoice_date"])
    out["ref_date"] = pd.to_datetime(out["payment_date"])
    found_in, found_inv = [], []
    for r in out.itertuples(index=False):
        key = (r.CustomerKey, r.CompanyKey)
        ib = inbound[(inbound["CustomerKey"] == key[0]) & (inbound["CompanyKey"] == key[1])
                     & ((inbound["residual_company_ccy"] + r.residual_company_ccy).abs() <= TOL)
                     & ((inbound["ref_date"] - r.ref_date).abs().dt.days <= MATCH_DAYS)]
        iv = invoices[(invoices["CustomerKey"] == key[0]) & (invoices["CompanyKey"] == key[1])
                      & ((invoices["residual_company_ccy"] - r.residual_company_ccy).abs() <= TOL)
                      & ((invoices["ref_date"] - r.ref_date).abs().dt.days <= MATCH_DAYS)]
        found_in.append(",".join(str(int(x)) for x in ib["PaymentKey"].head(5)))
        found_inv.append(",".join(str(int(x)) for x in iv["move_id"].head(5)))
    out["matching_inbound_payment_ids"] = found_in
    out["matching_open_invoice_move_ids"] = found_inv
    out["match"] = ["inbound payment" if a else ("open invoice" if b else "none") for a, b in zip(found_in, found_inv)]
    out["memo_pattern"] = out["memo"].map(memo_pattern)
    out["month"] = pd.to_datetime(out["payment_date"]).dt.strftime("%Y-%m")
    return out.drop(columns=["ref_date"])


def summarise(out: pd.DataFrame, by) -> pd.DataFrame:
    g = out.groupby(by, dropna=False).agg(lines=("line_id", "size"), open_amount=("residual_company_ccy", "sum"))
    g["share_pct"] = (g["open_amount"] / out["residual_company_ccy"].sum() * 100).round(1)
    return g.sort_values("open_amount", ascending=False).round(2)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--user-names", type=Path, help="optional CSV id,name of Odoo users (creator of the payment)")
    args = ap.parse_args(argv)
    engine = create_engine(Settings.from_env(None).sqlalchemy_url, future=True)
    with engine.connect() as conn:
        if engine.dialect.name == "mysql":
            conn.execute(text("SET SESSION TRANSACTION READ ONLY"))
        lines, nopartner = load(conn, int(args.date.replace("-", "")))
    out = match_candidates(lines)
    if args.user_names and args.user_names.exists():
        names = pd.read_csv(args.user_names)
        out["created_by"] = out["created_by_user_id"].map(dict(zip(names["id"], names["name"])))
    else:
        out["created_by"] = out["created_by_user_id"]
    args.out.mkdir(parents=True, exist_ok=True)
    cols = ["PaymentKey", "payment_reference", "move_id", "line_id", "company", "journal_name_en", "journal_name_ar", "payment_date", "month",
            "payment_state", "is_reconciled", "is_matched", "residual_company_ccy", "payment_amount", "memo", "memo_pattern", "CustomerKey",
            "customer", "customer_salesperson", "created_by", "days_past_due", "match", "matching_inbound_payment_ids",
            "matching_open_invoice_move_ids", "is_intercompany"]
    out[cols].sort_values("residual_company_ccy", ascending=False).to_csv(args.out / "finance_outbound_payments_review.csv", index=False, encoding="utf-8-sig")
    nopartner.to_csv(args.out / "finance_receivable_lines_without_partner.csv", index=False, encoding="utf-8-sig")
    pd.set_option("display.width", 250)
    print("TOTAL", len(out), round(float(out["residual_company_ccy"].sum()), 2))
    for title, by in (("journal", ["company", "journal_name_en"]), ("company", ["company"]), ("created_by", ["created_by"]),
                      ("customer_salesperson", ["customer_salesperson"]), ("month", ["month"]), ("payment_state", ["payment_state", "is_reconciled", "is_matched"]),
                      ("memo_pattern", ["memo_pattern"]), ("match", ["match"])):
        print(f"\n== by {title}")
        print(summarise(out, by).head(25).to_string())
    print("\n== top 20 partners")
    print(summarise(out, ["CustomerKey", "customer"]).head(20).to_string())
    print("\n== top memos")
    print(out["memo"].fillna("(empty)").value_counts().head(15).to_string())
    print("\n== samples")
    sample = pd.concat([out[out["match"] != "none"].nlargest(10, "residual_company_ccy"), out[out["match"] == "none"].nlargest(10, "residual_company_ccy")])
    print(sample[["PaymentKey", "payment_reference", "move_id", "company", "journal_name_en", "payment_date", "residual_company_ccy", "customer",
                  "memo", "match", "matching_inbound_payment_ids", "matching_open_invoice_move_ids"]].to_string(index=False))
    print("\n== lines without partner:", len(nopartner), round(float(nopartner["amount_residual"].sum()), 2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
