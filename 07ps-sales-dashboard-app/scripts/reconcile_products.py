"""Reconcile the Product pages with their sources. Exit code 0 = everything matches, 1 = any mismatch.

  python scripts/reconcile_products.py --api-url http://localhost:4000 [--from 2026-01-01 --to 2026-09-29]
         [--sample 5 --seed 7] [--odoo] [--env-file backend/.env] [--accounts-file backend/.env.test-accounts.local]

Checks
  1. 10 products (top 5 by value + `--sample` random, seeded): the dashboard API's Value, Volume and Velocity
     vs the ETL source rows (Fact_SalesLines: SUM(untaxed_total), SUM(quantity), quantity / days) -- exact
     to the cent / 3 decimals.
  2. Grand total: all products + Unmapped from the API == SUM(Fact_SalesLines.Value) for the same period,
     which is what every Sales page sums (tachometer, revenue trend, invoices engine, ...).
  3. CemAir, per company: 2025 and the current YTD from the API vs the source rows, and -- with --odoo --
     vs live Odoo sale.report (Sales > Reporting > Sales Analysis, confirmed orders), read-only.

Credentials: DB_* from the env file; the API token from DASHBOARD_TOKEN, or by logging in with the local
test account in --accounts-file (TEST_ADMIN_EMAIL / TEST_ADMIN_PASSWORD). Nothing is printed or stored.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import random
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import pymysql

APP = Path(__file__).resolve().parents[1]
CEMAIR_KEYS = {"MAJAAL|CEMAIR": ("Majaal", 1), "TIKA|CEM AIR": ("TIKA", 3)}


def read_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            m = re.match(r"^([A-Z_][A-Z0-9_]*)=(.*)$", line.strip())
            if m:
                env[m.group(1)] = m.group(2).strip().strip('"')
    return env


def api_get(base: str, path: str, token: str) -> dict:
    req = urllib.request.Request(base.rstrip("/") + path, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def api_token(base: str, accounts: dict[str, str]) -> str:
    if os.getenv("DASHBOARD_TOKEN"):
        return os.environ["DASHBOARD_TOKEN"]
    body = json.dumps({"email": accounts["TEST_ADMIN_EMAIL"], "password": accounts["TEST_ADMIN_PASSWORD"]}).encode()
    req = urllib.request.Request(base.rstrip("/") + "/auth/login", data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data.get("token") or data.get("accessToken")


def overview(base: str, token: str, start: str, end: str) -> dict:
    qs = urllib.parse.urlencode({"fromDate": start, "toDate": end})
    return api_get(base, f"/product-dashboard/bcg-matrix/overview?{qs}", token)


def source_by_product(cur, start: str, end: str) -> dict[str, dict]:
    cur.execute(
        """SELECT ProductMatchKey, COALESCE(uom, '') AS uom, SUM(untaxed_total), SUM(quantity), COUNT(*)
           FROM fact_saleslines WHERE order_date_date BETWEEN %s AND %s GROUP BY ProductMatchKey, COALESCE(uom, '')""",
        (start, end),
    )
    out: dict[str, dict] = {}
    for key, uom, value, qty, lines in cur.fetchall():
        p = out.setdefault(key, {"value": 0.0, "qty": {}, "lines": 0})
        p["value"] += float(value or 0)
        p["qty"][uom] = p["qty"].get(uom, 0.0) + float(qty or 0)
        p["lines"] += int(lines)
    return out


def sales_pages_total(cur, start: str, end: str) -> tuple[float, int]:
    cur.execute("SELECT COALESCE(SUM(Value),0), COUNT(*) FROM fact_saleslines WHERE order_date_date BETWEEN %s AND %s", (start, end))
    value, lines = cur.fetchone()
    return float(value), int(lines)


def odoo_value(company_id: int, product_name: str, start: str, end: str) -> tuple[float, float]:
    """Live Odoo sale.report totals (read-only read_group), dates as Tripoli calendar days."""
    sys.path[:0] = [str(APP / "data" / "etl" / "src"), str(APP / "data" / "etl")]
    from sales_pipeline.odoo.client import OdooClient  # noqa: E402

    env = {**read_env(APP / "backend" / ".env"), **os.environ}
    client = OdooClient(env["ODOO_URL"], env["ODOO_DB"], env["ODOO_USER"], env["ODOO_API_KEY"], timeout_seconds=120)
    tz = dt.timezone(dt.timedelta(hours=2))  # Africa/Tripoli has no DST
    utc_start = dt.datetime.fromisoformat(start).replace(tzinfo=tz).astimezone(dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    utc_end = (dt.datetime.fromisoformat(end) + dt.timedelta(days=1)).replace(tzinfo=tz).astimezone(dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    domain = [["company_id", "=", company_id], ["product_id.name", "=", product_name], ["state", "in", ["sale", "done"]],
              ["date", ">=", utc_start], ["date", "<", utc_end]]
    groups = client.execute_kw("sale.report", "read_group", [domain, ["price_subtotal:sum", "qty_invoiced:sum"], []], {"lazy": False})
    g = groups[0] if groups else {}
    return float(g.get("price_subtotal") or 0), float(g.get("qty_invoiced") or 0)


def main() -> int:
    today = dt.date.today()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--api-url", default="http://localhost:4000")
    ap.add_argument("--from", dest="start", default=f"{today.year}-01-01")
    ap.add_argument("--to", dest="end", default=today.isoformat())
    ap.add_argument("--sample", type=int, default=5)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--odoo", action="store_true", help="also reconcile CemAir against live Odoo (read-only)")
    ap.add_argument("--env-file", default=str(APP / "backend" / ".env"))
    ap.add_argument("--accounts-file", default=str(APP / "backend" / ".env.test-accounts.local"))
    args = ap.parse_args()

    env = {**read_env(Path(args.env_file)), **{k: v for k, v in os.environ.items() if k.startswith("DB_")}}
    db = pymysql.connect(host=env["DB_HOST"], port=int(env.get("DB_PORT", 3306)), user=env["DB_USER"],
                         password=env["DB_PASSWORD"], database=env["DB_NAME"], charset="utf8mb4")
    cur = db.cursor()
    token = api_token(args.api_url, read_env(Path(args.accounts_file)))
    failures: list[str] = []

    api = overview(args.api_url, token, args.start, args.end)
    period = api["period"]
    print(f"Period {period['from']} .. {period['to']} ({period['days']} days); product snapshot as of {api['asOfDate']}")
    src = source_by_product(cur, period["from"], period["to"])
    by_key = {p["productMatchKey"]: p for p in api["products"]}

    # 1. ten products
    ranked = sorted(src.items(), key=lambda kv: -kv[1]["value"])
    top = [k for k, _ in ranked[: 5]]
    rest = [k for k, v in ranked[5:] if v["lines"] > 0]
    sample = random.Random(args.seed).sample(rest, min(args.sample, len(rest)))
    print("\n1) Product-level check (dashboard API vs Fact_SalesLines)")
    print(f"{'product':<46} {'value api':>15} {'value src':>15} {'volume api':>12} {'volume src':>12} {'velocity api':>12} {'velocity src':>12}  ok")
    for key in top + sample:
        s = src[key]
        a = by_key.get(key)
        src_single = len(s["qty"]) == 1
        src_vol = next(iter(s["qty"].values())) if src_single else None
        src_vel = src_vol / period["days"] if src_vol is not None else None
        if a is None:
            failures.append(f"{key}: missing from API")
            print(f"{key:<46} MISSING FROM API")
            continue
        ok = round(a["value"], 2) == round(s["value"], 2)
        ok &= (a["volume"] is None and src_vol is None) or (a["volume"] is not None and src_vol is not None and round(a["volume"], 3) == round(src_vol, 3))
        ok &= (a["velocity"] is None and src_vel is None) or (a["velocity"] is not None and src_vel is not None and abs(a["velocity"] - src_vel) < 1e-9)
        if not src_single:
            ok &= sorted((u["uom"], round(u["qty"], 3)) for u in a["volumeByUom"]) == sorted((u, round(q, 3)) for u, q in s["qty"].items())
        vol_txt = lambda v: "per-UoM" if v is None else f"{v:,.3f}"  # noqa: E731
        vel_txt = lambda v: "per-UoM" if v is None else f"{v:,.4f}"  # noqa: E731
        name = f"{a['company']}: {a['productName']}"[:46]
        print(f"{name:<46} {a['value']:>15,.2f} {s['value']:>15,.2f} {vol_txt(a['volume']):>12} {vol_txt(src_vol):>12} {vel_txt(a['velocity']):>12} {vel_txt(src_vel):>12}  {'OK' if ok else 'MISMATCH'}")
        if not ok:
            failures.append(f"{key}: product-level mismatch")

    # 2. grand total
    sales_value, sales_lines = sales_pages_total(cur, period["from"], period["to"])
    mapped_value = sum(p["value"] for p in api["products"] if p["isMapped"])
    print("\n2) Grand total (all products + Unmapped == Sales pages total)")
    print(f"   mapped products      {mapped_value:>18,.2f}")
    print(f"   Unmapped             {api['unmapped']['value']:>18,.2f}   ({api['unmapped']['products']} products, {api['unmapped']['lines']} lines)")
    print(f"   = product pages      {api['totals']['value']:>18,.2f}   ({api['totals']['lines']} lines)")
    print(f"   Sales pages          {sales_value:>18,.2f}   ({sales_lines} lines)  SUM(Fact_SalesLines.Value)")
    print(f"   (of which intercompany, information only: {api['intercompanyValue']:,.2f})")
    if round(mapped_value + api["unmapped"]["value"], 2) != round(api["totals"]["value"], 2):
        failures.append("mapped + unmapped != product total")
    if round(api["totals"]["value"], 2) != round(sales_value, 2) or api["totals"]["lines"] != sales_lines:
        failures.append(f"product total {api['totals']['value']:.2f} != Sales pages {sales_value:.2f}")
    print(f"   difference           {api['totals']['value'] - sales_value:>18,.2f}  {'OK' if not failures or 'Sales pages' not in failures[-1] else 'MISMATCH'}")

    # 3. CemAir per company
    print("\n3) CemAir per company (API vs Fact_SalesLines" + (" vs live Odoo sale.report" if args.odoo else "") + ")")
    ytd_start = f"{dt.date.fromisoformat(period['to']).year}-01-01"
    for label, (start, end) in {"2025": ("2025-01-01", "2025-12-31"), "YTD": (ytd_start, period["to"])}.items():
        api_p = overview(args.api_url, token, start, end)
        src_p = source_by_product(cur, start, end)
        for key, (company, company_id) in CEMAIR_KEYS.items():
            a = next((p for p in api_p["products"] if p["productMatchKey"] == key), None)
            a_val = a["value"] if a else 0.0
            s_val = src_p.get(key, {"value": 0.0})["value"]
            line = f"   {label:<5} {key:<16} api {a_val:>14,.2f}  source {s_val:>14,.2f}"
            ok = round(a_val, 2) == round(s_val, 2)
            if args.odoo:
                odoo_name = "Cemair" if company == "Majaal" else "Cem Air"
                o_val, _ = odoo_value(company_id, odoo_name, start, end)
                line += f"  odoo {o_val:>14,.2f}"
                ok &= round(o_val, 2) == round(a_val, 2)
            print(line + ("  OK" if ok else "  MISMATCH"))
            if not ok:
                failures.append(f"CemAir {label} {key} mismatch")

    print("\nRESULT:", "ALL CHECKS PASSED" if not failures else f"{len(failures)} FAILURE(S): " + "; ".join(failures))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
