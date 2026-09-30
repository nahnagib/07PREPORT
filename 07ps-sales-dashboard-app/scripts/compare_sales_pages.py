"""Before/after table of the Sales pages' headline KPIs, per company, for two running API instances.

  python scripts/compare_sales_pages.py --before http://localhost:4201 --after http://localhost:4202 --anchor 2026-09-28

Both APIs are logged into with the local test account (--accounts-file, never printed). Prints a markdown
table: page | company | metric | before | after | change | change %.
"""

from __future__ import annotations

import argparse
import json
import re
import urllib.parse
import urllib.request
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
COMPANIES = {"All": None, "Majaal": 1, "Tika": 2}
PAGES = {
    "Tachometer": ("/tachometer/overview", [
        ("Value YTD", "ytdValue.actual"), ("Volume YTD", "ytdVolume.actual"), ("Value MTD", "mtdValue.actual"),
        ("Value same period LY", "ytdValue.lastYearSamePeriod"), ("ASP YTD", "aspYtd.actualAsp")]),
    "Critical Number": ("/critical-number/overview", [
        ("Daily counter", "dailyCounter.actual"), ("Monthly actual", "monthlyCounter.actualValue"),
        ("Yearly actual", "yearlyCounter.actualValue"), ("Yearly achievement %", "yearlyCounter.achievementPct")]),
    "Revenue Trend": ("/revenue-trend/overview", [
        ("Value variance YTD %", "kpis.valueVarianceYtd.variancePct"), ("Volume variance YTD %", "kpis.volumeVarianceYtd.variancePct"),
        ("ASP variance YTD %", "kpis.aspVarianceYtd.variancePct")]),
    "Invoices Engine": ("/invoices-engine/overview", [
        ("Invoices YTD", "kpis.ytd.invoiceCount"), ("Avg sales / invoice YTD", "kpis.ytd.avgSalesPerInvoice"),
        ("Avg lines / invoice YTD", "kpis.ytd.avgLinesPerInvoice"), ("Invoices LYTD", "kpis.lytd.invoiceCount")]),
    "Customer Growth": ("/customer-growth/overview", [
        ("Customers YTD", "kpis.totalCustomers.ytd"), ("New customers YTD", "kpis.newCustomers.ytd"),
        ("Retention rate", "rates.retentionRatePct")]),
}


def login(base: str, accounts: dict[str, str]) -> str:
    body = json.dumps({"email": accounts["TEST_ADMIN_EMAIL"], "password": accounts["TEST_ADMIN_PASSWORD"]}).encode()
    req = urllib.request.Request(base + "/auth/login", data=body, headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=30).read())["token"]


def get(base: str, token: str, path: str, anchor: str, company: int | None) -> dict:
    params = {"anchorDate": anchor}
    if company is not None:
        params["companyKeys"] = str(company)
    req = urllib.request.Request(f"{base}{path}?{urllib.parse.urlencode(params)}", headers={"Authorization": f"Bearer {token}"})
    return json.loads(urllib.request.urlopen(req, timeout=180).read())


def pick(obj: dict, dotted: str):
    for part in dotted.split("."):
        obj = obj.get(part) if isinstance(obj, dict) else None
    return obj


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--before", required=True)
    ap.add_argument("--after", required=True)
    ap.add_argument("--anchor", required=True)
    ap.add_argument("--accounts-file", default=str(APP / "backend" / ".env.test-accounts.local"))
    args = ap.parse_args()
    accounts = {}
    for line in Path(args.accounts_file).read_text(encoding="utf-8").splitlines():
        m = re.match(r"^([A-Z_]+)=(.*)$", line.strip())
        if m:
            accounts[m.group(1)] = m.group(2)
    tokens = {args.before: login(args.before, accounts), args.after: login(args.after, accounts)}
    print(f"Anchor date {args.anchor}\n")
    print("| Page | Company | Metric | Before | After | Change | Change % |")
    print("|---|---|---|---:|---:|---:|---:|")
    for page, (path, metrics) in PAGES.items():
        for company, key in COMPANIES.items():
            b = get(args.before, tokens[args.before], path, args.anchor, key)
            a = get(args.after, tokens[args.after], path, args.anchor, key)
            for label, dotted in metrics:
                vb, va = pick(b, dotted), pick(a, dotted)
                if not isinstance(vb, (int, float)) or not isinstance(va, (int, float)):
                    print(f"| {page} | {company} | {label} | {vb} | {va} | | |")
                    continue
                is_pct = dotted.endswith("Pct") or "Pct" in dotted.split(".")[-1]
                fmt = (lambda v: f"{v * 100:,.2f}%") if is_pct else (lambda v: f"{v:,.2f}")
                diff = va - vb
                rel = f"{diff / vb * 100:+.2f}%" if vb and not is_pct else ""
                chg = f"{diff * 100:+.2f} pp" if is_pct else f"{diff:+,.2f}"
                print(f"| {page} | {company} | {label} | {fmt(vb)} | {fmt(va)} | {chg} | {rel} |")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
