"""Reconcile the Product pages with their sources. Exit code 0 = everything matches, 1 = any mismatch.

  python scripts/reconcile_products.py --api-url http://localhost:4000 [--from 2026-01-01 --to 2026-09-29]
         [--sample 5 --seed 7] [--odoo] [--env-file backend/.env] [--accounts-file backend/.env.test-accounts.local]

Checks
  1. 10 products (top 5 by value + `--sample` random, seeded), in their company view: the dashboard API's
     Value, Volume and Velocity vs the ETL source rows (Fact_SalesLines: SUM(untaxed_total), SUM(quantity),
     quantity / days) -- exact to the cent / 3 decimals.
  2. BMH view: every row == the sum of its company parts, and each part == that company view's row.
  3. Grand total, per company and BMH: all products + Unmapped from the API == SUM(Fact_SalesLines.Value)
     for the same period, which is what every Sales page sums (tachometer, revenue trend, invoices engine, ...).
  4. CemAir, per company and BMH: 2025 and the current YTD from the API vs the source rows, and -- with
     --odoo -- vs live Odoo sale.report (Sales > Reporting > Sales Analysis, confirmed orders), read-only.
  5. With --odoo, for the same 10 products: finished-goods on-hand quantity and value per company vs live
     Odoo stock.quant (internal, non-scrap locations; RM Warehouse and Vessel excluded; negative quants
     count as 0), and the unit cost the margin/BCG used (CostValue / costed qty) vs Odoo's per-company
     standard_price. Read-only.

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
COMPANIES = ("Majaal", "Tika")
ODOO_COMPANY_ID = {"Majaal": 1, "Tika": 3}
RAW_MATERIALS, IN_TRANSIT = {"RM WAREHOUSE"}, {"VESSEL"}


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


def overview(base: str, token: str, start: str, end: str, company: str | None = None) -> dict:
    params = {"fromDate": start, "toDate": end}
    if company:
        params["company"] = company
    return api_get(base, f"/product-dashboard/bcg-matrix/overview?{urllib.parse.urlencode(params)}", token)


def company_rows(base: str, token: str, start: str, end: str) -> dict[str, dict]:
    """Every product row of both company views, keyed by ProductMatchKey (Company + Odoo name)."""
    rows: dict[str, dict] = {}
    for company in COMPANIES:
        for p in overview(base, token, start, end, company)["products"]:
            rows[p["productMatchKey"]] = p
    return rows


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


_ODOO = None


def odoo_client():
    global _ODOO
    if _ODOO is None:
        sys.path[:0] = [str(APP / "data" / "etl" / "src"), str(APP / "data" / "etl")]
        from sales_pipeline.odoo.client import OdooClient  # noqa: E402

        env = {**read_env(APP / "data" / "etl" / ".env"), **read_env(APP / "backend" / ".env"), **os.environ}
        _ODOO = OdooClient(env["ODOO_URL"], env["ODOO_DB"], env["ODOO_USER"], env["ODOO_API_KEY"], timeout_seconds=180)
    return _ODOO


def odoo_stock(company: str, product_ids: list[int]) -> tuple[float, float]:
    """Finished-goods on hand (qty, value) in Odoo for one company, same location rules as the pages."""
    cid = ODOO_COMPANY_ID[company]
    ctx = {"allowed_company_ids": [cid]}
    quants = odoo_client().execute_kw(
        "stock.quant", "search_read",
        [[["product_id", "in", product_ids], ["company_id", "=", cid], ["location_id.usage", "=", "internal"],
          ["location_id.scrap_location", "=", False]]],
        {"fields": ["quantity", "value", "warehouse_id", "location_id"], "context": ctx},
    )
    qty = value = 0.0
    for q in quants:
        wh = (q["warehouse_id"][1] if q.get("warehouse_id") else str(q["location_id"][1]).split("/")[0]).strip().upper()
        if wh in RAW_MATERIALS or wh in IN_TRANSIT or float(q["quantity"] or 0) <= 0:
            continue
        qty += float(q["quantity"] or 0)
        value += float(q["value"] or 0)
    return qty, value


def odoo_cost(company: str, product_ids: list[int]) -> set[float]:
    cid = ODOO_COMPANY_ID[company]
    rows = odoo_client().execute_kw(
        "product.product", "read", [product_ids, ["standard_price"]],
        {"context": {"allowed_company_ids": [cid], "force_company": cid, "active_test": False}},
    )
    return {round(float(r["standard_price"] or 0), 4) for r in rows}


def odoo_value(company_id: int, product_name: str, start: str, end: str) -> tuple[float, float]:
    """Live Odoo sale.report totals (read-only read_group), dates as Tripoli calendar days."""
    client = odoo_client()
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
    print(f"Period {period['from']} .. {period['to']} ({period['days']} days); product snapshot as of {api['asOfDate']}; default view {api['view']}")
    src = source_by_product(cur, period["from"], period["to"])
    by_key = company_rows(args.api_url, token, period["from"], period["to"])

    # 1. ten products, company view
    ranked = sorted(src.items(), key=lambda kv: -kv[1]["value"])
    top = [k for k, _ in ranked[: 5]]
    rest = [k for k, v in ranked[5:] if v["lines"] > 0]
    sample = random.Random(args.seed).sample(rest, min(args.sample, len(rest)))
    print("\n1) Product-level check, company view (dashboard API vs Fact_SalesLines)")
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

    # 2. BMH view rows == sum of their company parts
    shared = [p for p in api["products"] if len(p["companies"]) > 1]
    bad = []
    for p in api["products"]:
        parts_value = sum(x["value"] for x in p["parts"])
        company_value = sum(by_key.get(x["productMatchKey"], {"value": 0.0})["value"] for x in p["parts"])
        if round(p["value"], 2) != round(parts_value, 2) or round(parts_value, 2) != round(company_value, 2):
            bad.append(p["productMatchKey"])
    print(f"\n2) BMH view: {len(api['products'])} rows, {len(shared)} shared by both companies; rows != sum of company parts: {len(bad)}")
    if bad:
        failures.append(f"BMH rows not equal to company parts: {bad[:5]}")

    # 3. grand totals, per company and BMH
    print("\n3) Grand total (all products + Unmapped == Sales pages total)")
    sales_value, sales_lines = sales_pages_total(cur, period["from"], period["to"])
    mapped_value = sum(p["value"] for p in api["products"] if p["isMapped"])
    print(f"   BMH mapped products  {mapped_value:>18,.2f}")
    print(f"   BMH Unmapped         {api['unmapped']['value']:>18,.2f}   ({api['unmapped']['products']} products, {api['unmapped']['lines']} lines)")
    print(f"   = product pages      {api['totals']['value']:>18,.2f}   ({api['totals']['lines']} lines)")
    print(f"   Sales pages          {sales_value:>18,.2f}   ({sales_lines} lines)  SUM(Fact_SalesLines.Value)")
    print(f"   difference           {api['totals']['value'] - sales_value:>18,.2f}")
    print(f"   (of which intercompany, information only: {api['intercompanyValue']:,.2f})")
    if round(mapped_value + api["unmapped"]["value"], 2) != round(api["totals"]["value"], 2):
        failures.append("BMH mapped + unmapped != product total")
    if round(api["totals"]["value"], 2) != round(sales_value, 2) or api["totals"]["lines"] != sales_lines:
        failures.append(f"BMH product total {api['totals']['value']:.2f} != Sales pages {sales_value:.2f}")
    cur.execute("SELECT CompanyKey, Company FROM dim_company")
    company_keys = {str(n): k for k, n in cur.fetchall()}
    company_sum = 0.0
    for company in COMPANIES:
        c_api = overview(args.api_url, token, period["from"], period["to"], company)
        cur.execute("SELECT COALESCE(SUM(Value),0), COUNT(*) FROM fact_saleslines WHERE CompanyKey=%s AND order_date_date BETWEEN %s AND %s",
                    (company_keys[company], period["from"], period["to"]))
        c_sales, c_lines = cur.fetchone()
        c_mapped = sum(p["value"] for p in c_api["products"] if p["isMapped"])
        company_sum += c_api["totals"]["value"]
        ok = round(c_api["totals"]["value"], 2) == round(float(c_sales), 2) and c_api["totals"]["lines"] == int(c_lines)
        ok &= round(c_mapped + c_api["unmapped"]["value"], 2) == round(c_api["totals"]["value"], 2)
        print(f"   {company:<7} products {c_mapped:>16,.2f} + Unmapped {c_api['unmapped']['value']:>14,.2f} = {c_api['totals']['value']:>16,.2f}"
              f"  Sales pages {float(c_sales):>16,.2f}  diff {c_api['totals']['value'] - float(c_sales):,.2f}  {'OK' if ok else 'MISMATCH'}")
        if not ok:
            failures.append(f"{company} product total != Sales pages")
    if round(company_sum, 2) != round(api["totals"]["value"], 2):
        failures.append("Majaal + Tika != BMH total")
    print(f"   Majaal + Tika = {company_sum:,.2f}; BMH = {api['totals']['value']:,.2f}")

    # 4. CemAir per company and BMH
    print("\n4) CemAir per company and BMH (API vs Fact_SalesLines" + (" vs live Odoo sale.report" if args.odoo else "") + ")")
    ytd_start = f"{dt.date.fromisoformat(period['to']).year}-01-01"
    for label, (start, end) in {"2025": ("2025-01-01", "2025-12-31"), "YTD": (ytd_start, period["to"])}.items():
        rows = company_rows(args.api_url, token, start, end)
        bmh = overview(args.api_url, token, start, end)
        src_p = source_by_product(cur, start, end)
        parts_total = 0.0
        for key, (company, company_id) in CEMAIR_KEYS.items():
            a = rows.get(key)
            a_val = a["value"] if a else 0.0
            parts_total += a_val
            s_val = src_p.get(key, {"value": 0.0})["value"]
            line = f"   {label:<5} {key:<16} api {a_val:>14,.2f}  source {s_val:>14,.2f}"
            ok = round(a_val, 2) == round(s_val, 2)
            if args.odoo:
                odoo_name = "Cemair" if company == "Majaal" else "Cem Air"
                o_val, _ = odoo_value(company_id, odoo_name, start, end)
                line += f"  odoo {o_val:>14,.2f}  diff {a_val - o_val:,.2f}"
                ok &= round(o_val, 2) == round(a_val, 2)
            print(line + ("  OK" if ok else "  MISMATCH"))
            if not ok:
                failures.append(f"CemAir {label} {key} mismatch")
        g = next((p for p in bmh["products"] if any(x["productMatchKey"] in CEMAIR_KEYS for x in p["parts"])), None)
        g_val = g["value"] if g else 0.0
        ok = g is not None and round(g_val, 2) == round(parts_total, 2) and {x["productMatchKey"] for x in g["parts"]} == set(CEMAIR_KEYS)
        print(f"   {label:<5} BMH {g['productName'] if g else '-'!s:<12} api {g_val:>14,.2f}  = Majaal + Tika {parts_total:>14,.2f}  {'OK' if ok else 'MISMATCH'}")
        if not ok:
            failures.append(f"CemAir {label} BMH != Majaal + Tika")

    # 5. stock and cost vs Odoo for the same 10 products
    if args.odoo:
        print("\n5) Stock on hand and unit cost vs live Odoo (same 10 products)")
        print(f"{'product':<40} {'qty api':>12} {'qty odoo':>12} {'value api':>14} {'value odoo':>14} {'cost used':>11} {'odoo cost':>11}  ok")
        for key in top + sample:
            a = by_key.get(key)
            if a is None:
                continue
            company = a["company"]
            cur.execute("SELECT DISTINCT OdooProductID FROM fact_saleslines WHERE ProductMatchKey=%s AND OdooProductID IS NOT NULL", (key,))
            ids = [int(r[0]) for r in cur.fetchall()]
            o_qty, o_val = odoo_stock(company, ids) if ids else (0.0, 0.0)
            cur.execute("SELECT SUM(CostValue), SUM(CostedQty), SUM(UncostedQty) FROM fact_productsalesdaily WHERE ProductMatchKey=%s AND OrderDate BETWEEN %s AND %s",
                        (key, period["from"], period["to"]))
            cv, cq, uq = cur.fetchone()
            used = round(float(cv) / float(cq), 4) if cq else None
            o_costs = odoo_cost(company, ids) if ids else set()
            ok = round(a["stockQty"], 3) == round(o_qty, 3) and round(a["stockValue"], 2) == round(o_val, 2)
            cost_ok = (used is None and o_costs <= {0.0}) or (used is not None and o_costs == {used})
            ok &= cost_ok
            name = f"{company}: {a['productName']}"[:40]
            print(f"{name:<40} {a['stockQty']:>12,.3f} {o_qty:>12,.3f} {a['stockValue']:>14,.2f} {o_val:>14,.2f} "
                  f"{('-' if used is None else f'{used:,.4f}'):>11} {','.join(f'{c:,.4f}' for c in sorted(o_costs)) or '-':>11}  {'OK' if ok else 'MISMATCH'}")
            if not ok:
                failures.append(f"{key}: stock/cost mismatch")

    print("\nRESULT:", "ALL CHECKS PASSED" if not failures else f"{len(failures)} FAILURE(S): " + "; ".join(failures))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
