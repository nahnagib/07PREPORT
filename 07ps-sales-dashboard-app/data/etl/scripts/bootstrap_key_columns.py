"""One-off bootstrap of the frozen key columns in the Excel inputs (docs/rename-map.md, "Input file changes").

Writes into a COPY of the input folder (refuses the production Input folder unless --allow-production-input):

  SalesTeam.xlsx      salesperson: + SalespersonKey, ChannelKey; + the Odoo-only salespeople (no team, Inactive);
                      salesteam: + CompanyKey, SegmentKey; new sheets OdooUsers, OdooTeams, channel, segment
  sales_targets.xlsx  Targets: + SalespersonKey, CompanyKey
  PRODUCTS.xlsx       Products: + ProductMasterKey (today's derived key, frozen)
  OffDays.xlsx        + CompanyKey
  BlockedCustomers    + CustomerKey (unique exact name match to an Odoo commercial partner; others left blank)

and review files into --docs-dir:
  customer_name_duplicates.csv, product_unmatched.csv, blocked_customers_mapping_review.csv,
  bootstrap_salespeople_added.csv

Inputs: the reviewed mapping CSV (Odoo user -> salesperson), the current warehouse (read-only, DB_* / DB_URL:
today's keys and sales), Odoo (read-only, ODOO_* + the platform guard variables). Re-running on a fresh copy gives
the same result. Values are frozen from today's warehouse, so every existing key keeps its number.

Usage:
  python scripts/bootstrap_key_columns.py --input-dir <a COPY of 07PREPORT/Input, never the folder itself> \
      --mapping-csv "C:/Users/Lenovo/Desktop/07PREPORT/Claude outputs/odoo_user_salesperson_mapping_review_2026-10-01.csv" \
      --docs-dir ../../../docs
"""

from __future__ import annotations

import argparse
import logging
import re
import sys
from pathlib import Path

import openpyxl
import pandas as pd
from sqlalchemy import create_engine, text

ROOT = Path(__file__).resolve().parents[1]
for p in (ROOT, ROOT / "src"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

from core.keys import UNKNOWN  # noqa: E402
from core.transforms import product as prod  # noqa: E402
from etl_platform.config import PlatformConfig  # noqa: E402
from etl_platform.sources.odoo import OdooSource  # noqa: E402
from sales_pipeline.legacy_transform import ProductMasterLoader  # noqa: E402

log = logging.getLogger("bootstrap_key_columns")

CHANNELS = {"Projects": 2, "Retail": 3, "Wholesales": 4}  # frozen: today's dim_distributionchannel keys
SEGMENTS = {"B2B": 1, "B2C": 2, "Backoffice": 3, "Inter Company": 4}  # frozen: today's dim_segment keys
COMPANIES = {"MAJAAL": 1, "TIKA": 3}  # Odoo res.company ids
# Target sheet names that match no salesperson today (legacy key 0). Proposed resolution, for confirmation:
TARGET_NAME_FIXES = {"SalesPerson 2": "Sales Person 2"}  # same team MJ-BEN-FO-02: a spelling variant
TARGET_ONLY_SALESPEOPLE = {"Yousef Misrata": "TK-MST-BC-01"}  # becomes a salesperson (team from the targets sheet)


def norm(value) -> str:
    return re.sub(r"\s+", " ", str(value).strip()) if value is not None and not (isinstance(value, float) and pd.isna(value)) else ""


def loose(value) -> str:
    return re.sub(r"\s+", " ", norm(value)).casefold()


# -- workbook helpers ----------------------------------------------------------------------------------------------
def header_map(ws) -> dict[str, int]:
    return {norm(c.value): c.column for c in ws[1] if c.value is not None}


def ensure_column(ws, name: str) -> int:
    headers = header_map(ws)
    if name in headers:
        return headers[name]
    col = ws.max_column + 1
    ws.cell(row=1, column=col, value=name)
    return col


def data_rows(ws):
    for row in range(2, ws.max_row + 1):
        if any(ws.cell(row=row, column=c).value not in (None, "") for c in range(1, ws.max_column + 1)):
            yield row


def replace_sheet(wb, name: str, frame: pd.DataFrame) -> None:
    if name in wb.sheetnames:
        del wb[name]
    ws = wb.create_sheet(name)
    ws.append(list(frame.columns))
    for rec in frame.itertuples(index=False):
        ws.append([None if (isinstance(v, float) and pd.isna(v)) else v for v in rec])


# -- steps ---------------------------------------------------------------------------------------------------------
def org_file(input_dir: Path, mapping: pd.DataFrame, legacy_sp: dict[str, int]) -> tuple[dict[str, int], pd.DataFrame]:
    path = input_dir / "SalesTeam.xlsx"
    wb = openpyxl.load_workbook(path)
    ws = wb["salesperson"]
    h = header_map(ws)
    key_col, ch_col = ensure_column(ws, "SalespersonKey"), ensure_column(ws, "ChannelKey")
    proposed = {norm(r.excel_name): int(r.proposed_salesperson_key) for r in mapping.itertuples() if norm(r.excel_name) and pd.notna(r.proposed_salesperson_key)}
    keys: dict[str, int] = {}
    without_key: list[tuple[int, str]] = []
    for row in data_rows(ws):
        name = norm(ws.cell(row=row, column=h["Name"]).value)
        if not name:
            continue
        key = proposed.get(name, legacy_sp.get(name))
        channel = norm(ws.cell(row=row, column=h["DistributionChannel"]).value)
        ws.cell(row=row, column=ch_col, value=CHANNELS[channel] if channel else None)
        if key is None:  # in the sheet but never sold anything: no key exists today, so a new one is assigned
            without_key.append((row, name))
            continue
        ws.cell(row=row, column=key_col, value=key)
        keys[name] = key

    next_key = max([*keys.values(), *legacy_sp.values()]) + 1
    added = []
    for row, name in without_key:
        ws.cell(row=row, column=key_col, value=next_key)
        keys[name] = next_key
        added.append({"SalespersonKey": next_key, "Name": name, "odoo_user_id": None, "TeamKey": norm(ws.cell(row=row, column=h["TeamKey"]).value),
                      "reason": "already in SalesTeam.xlsx; never sold, so no key existed: new key", "fact_orders": 0,
                      "fact_order_value": 0.0, "last_order_date": None})
        next_key += 1
    odoo_only = mapping[(mapping["category"] == "ODOO_USER_NO_EXCEL_MATCH") & (mapping["fact_orders"] > 0)]
    for r in odoo_only.itertuples():
        name = norm(r.odoo_user_name)
        if name in keys:
            continue
        key = legacy_sp[name] if name in legacy_sp else next_key
        next_key = max(next_key, key + 1)
        ws.append(_person_row(h, ws.max_column, name, None, "Inactive", key_col, key))  # no team = former salesperson
        keys[name] = key
        added.append({"SalespersonKey": key, "Name": name, "odoo_user_id": int(r.odoo_user_id), "TeamKey": None,
                      "reason": "Odoo user with orders, not in SalesTeam.xlsx", "fact_orders": int(r.fact_orders),
                      "fact_order_value": float(r.fact_order_value), "last_order_date": r.last_order_date})
    for name, team in TARGET_ONLY_SALESPEOPLE.items():
        if name in keys:
            continue
        key = legacy_sp.get(name, next_key)
        next_key = max(next_key, key + 1)
        ws.append(_person_row(h, ws.max_column, name, team, "Inactive", key_col, key))
        keys[name] = key
        added.append({"SalespersonKey": key, "Name": name, "odoo_user_id": None, "TeamKey": team,
                      "reason": "only in sales_targets.xlsx (no Odoo user, no orders); Inactive", "fact_orders": 0,
                      "fact_order_value": 0.0, "last_order_date": None})

    wt = wb["salesteam"]
    ht = header_map(wt)
    ck_col, sk_col = ensure_column(wt, "CompanyKey"), ensure_column(wt, "SegmentKey")
    for row in data_rows(wt):
        company = norm(wt.cell(row=row, column=ht["Company"]).value).upper()
        segment = norm(wt.cell(row=row, column=ht["Segment"]).value)
        wt.cell(row=row, column=ck_col, value=COMPANIES.get(company, UNKNOWN))
        wt.cell(row=row, column=sk_col, value=SEGMENTS.get(segment, UNKNOWN))

    users = mapping[mapping["category"].isin(["EXACT_MATCH", "AMBIGUOUS_NAME_MULTIPLE_ODOO_USERS"]) & mapping["odoo_user_id"].notna()]
    user_rows = [{"odoo_user_id": int(r.odoo_user_id), "SalespersonKey": keys[norm(r.excel_name)], "odoo_user_name": norm(r.odoo_user_name),
                  "note": "bootstrap: exact name match" + (" (one person, several Odoo users)" if r.category.startswith("AMBIGUOUS") else "")}
                 for r in users.itertuples()]
    user_rows += [{"odoo_user_id": int(a["odoo_user_id"]), "SalespersonKey": a["SalespersonKey"], "odoo_user_name": a["Name"],
                   "note": "bootstrap: Odoo-only salesperson (no team: Inactive)"} for a in added if a["odoo_user_id"]]
    replace_sheet(wb, "OdooUsers", pd.DataFrame(user_rows).sort_values("odoo_user_id"))
    replace_sheet(wb, "channel", pd.DataFrame({"ChannelKey": list(CHANNELS.values()), "DistributionChannel": list(CHANNELS)}))
    replace_sheet(wb, "segment", pd.DataFrame({"SegmentKey": list(SEGMENTS.values()), "Segment": list(SEGMENTS)}))
    wb.save(path)
    log.info("SalesTeam.xlsx: %s salespeople keyed, %s added, %s Odoo users mapped", len(keys), len(added), len(user_rows))
    return keys, pd.DataFrame(added)


def _person_row(h, width, name, team, status, key_col, key):
    row = [None] * max(width, key_col)
    row[h["Name"] - 1], row[h["TeamKey"] - 1], row[h["Status"] - 1] = name, team, status
    row[key_col - 1] = key
    return row


def odoo_teams_sheet(input_dir: Path, teams: pd.DataFrame, orders: pd.DataFrame, review_path: Path) -> pd.DataFrame:
    """Sheet OdooTeams (Odoo team id -> Excel team code) from today's exact team-name matches (the legacy rule), and
    docs/odoo_team_mapping_review.csv. An Odoo team with documents but no Excel team -> SALESPERSON (follows the
    document's salesperson, as the legacy fallback did); teams without documents are left out (-> -1 if ever used)."""
    path = input_dir / "SalesTeam.xlsx"
    xl = pd.read_excel(path, "salesteam")
    exact = {norm(n): k for n, k in zip(xl["TeamName"], xl["TeamKey"]) if norm(n)}
    used = orders.groupby("team_id_id").size().to_dict() if "team_id_id" in orders else {}
    rows, review = [], []
    for t in teams.sort_values("id").itertuples():
        key = exact.get(norm(t.name))
        n = int(used.get(t.id, 0))
        cat = "MATCHED" if key else ("UNMATCHED_WITH_DOCUMENTS" if n else "NO_DOCUMENTS")
        if key:
            rows.append([int(t.id), key, t.name, "bootstrap: exact name match (as the legacy pipeline)"])
        elif n:
            rows.append([int(t.id), "SALESPERSON", t.name, "bootstrap: no Excel team; follows the salesperson, as today - confirm"])
        review.append({"category": cat, "odoo_team_id": int(t.id), "odoo_team_name": t.name, "SalesTeamKey": key or ("SALESPERSON (proposed)" if n else None),
                       "sale_orders": n})
    wb = openpyxl.load_workbook(path)
    replace_sheet(wb, "OdooTeams", pd.DataFrame(rows, columns=["odoo_team_id", "SalesTeamKey", "odoo_team_name", "note"]))
    wb.save(path)
    out = pd.DataFrame(review)
    out.to_csv(review_path, index=False, encoding="utf-8-sig")
    return out


def targets_file(input_dir: Path, sp_keys: dict[str, int]) -> list[str]:
    path = input_dir / "sales_targets.xlsx"
    wb = openpyxl.load_workbook(path)
    ws = wb["Targets"]
    h = header_map(ws)
    sp_col, ck_col = ensure_column(ws, "SalespersonKey"), ensure_column(ws, "CompanyKey")
    unknown = set()
    for row in data_rows(ws):
        name = norm(ws.cell(row=row, column=h["Salesperson"]).value)
        name = TARGET_NAME_FIXES.get(name, name)
        key = sp_keys.get(name)
        if key is None and name:
            unknown.add(name)
        ws.cell(row=row, column=sp_col, value=key)
        company = norm(ws.cell(row=row, column=h["Company"]).value).upper()
        ws.cell(row=row, column=ck_col, value=COMPANIES.get(company, UNKNOWN if not company else None))
    wb.save(path)
    return sorted(unknown)


def products_file(input_dir: Path) -> pd.DataFrame:
    path = input_dir / "PRODUCTS.xlsx"
    loaded = ProductMasterLoader(logging.getLogger("ProductMasterLoader"), export_conflicts=False, base_dir=input_dir).load(path)  # today's exact rules
    key_by_row = dict(zip(loaded["SourceRow"].astype(int), loaded["ProductKey"]))
    wb = openpyxl.load_workbook(path)
    ws = wb["Products"]
    col = ensure_column(ws, "ProductMasterKey")
    for row in data_rows(ws):
        if row in key_by_row:
            ws.cell(row=row, column=col, value=key_by_row[row])
    wb.save(path)
    log.info("PRODUCTS.xlsx: %s ProductMasterKey values frozen", len(key_by_row))
    return loaded


def offdays_file(input_dir: Path) -> None:
    path = input_dir / "OffDays.xlsx"
    wb = openpyxl.load_workbook(path)
    ws = wb.worksheets[0]
    h = header_map(ws)
    col = ensure_column(ws, "CompanyKey")
    for row in data_rows(ws):
        company = norm(ws.cell(row=row, column=h["Company"]).value).upper()
        ws.cell(row=row, column=col, value=COMPANIES.get(company) if company else None)
    wb.save(path)


def blocked_file(input_dir: Path, partners: pd.DataFrame) -> pd.DataFrame:
    commercial = partners[partners["id"] == partners["commercial_partner_id"]]
    by_name: dict[str, list[int]] = {}
    for pid, name in zip(commercial["id"], commercial["name"]):
        by_name.setdefault(loose(name), []).append(int(pid))
    path = input_dir / "BlockedCustomers.xlsx"
    wb = openpyxl.load_workbook(path)
    ws = wb["BlockedCustomers"]
    h = header_map(ws)
    col = ensure_column(ws, "CustomerKey")
    review = []
    for row in data_rows(ws):
        name = norm(ws.cell(row=row, column=h["CustomerName"]).value)
        ids = by_name.get(loose(name), [])
        ws.cell(row=row, column=col, value=ids[0] if len(ids) == 1 else None)
        review.append({"excel_row": row, "CustomerID": ws.cell(row=row, column=h["CustomerID"]).value, "CustomerName": name,
                       "status": "MATCHED" if len(ids) == 1 else ("AMBIGUOUS" if ids else "NO_MATCH"),
                       "CustomerKey": ids[0] if len(ids) == 1 else None, "candidate_ids": ";".join(map(str, ids))})
    wb.save(path)
    return pd.DataFrame(review)


def customer_duplicates(partners: pd.DataFrame, orders: pd.DataFrame) -> pd.DataFrame:
    commercial_of = dict(zip(partners["id"], partners["commercial_partner_id"].fillna(partners["id"]).astype(int)))
    orders = orders.assign(CustomerKey=orders["partner_id_id"].map(commercial_of))
    stats = orders.groupby("CustomerKey").agg(order_count=("id", "count"), companies=("company", lambda s: "/".join(sorted(set(s.dropna())))),
                                               last_order=("date_order", "max"))
    commercial = partners[partners["id"] == partners["commercial_partner_id"]].copy()
    commercial["name_key"] = commercial["name"].map(loose)
    dup_keys = commercial["name_key"].value_counts()
    dup_keys = set(dup_keys[dup_keys > 1].index) - {""}
    out = commercial[commercial["name_key"].isin(dup_keys)].copy()
    out = out.join(stats, on="id")
    out["order_count"] = out["order_count"].fillna(0).astype(int)
    out["names_in_group"] = out.groupby("name_key")["id"].transform("count")
    out["group_orders"] = out.groupby("name_key")["order_count"].transform("sum")
    out = out.sort_values(["group_orders", "name_key", "order_count"], ascending=[False, True, False])
    return out[["name", "id", "is_company", "customer_rank", "active", "companies", "order_count", "last_order", "names_in_group", "ref"]].rename(
        columns={"name": "customer_name", "id": "CustomerKey (Odoo commercial partner id)"})


def product_unmatched(products: pd.DataFrame, master: pd.DataFrame, sales: pd.DataFrame) -> pd.DataFrame:
    dim = prod.build_products(products)
    m = prod.build_product_master(master, {"Majaal": 1, "Tika": 3})
    m = m.merge(master[["ProductMasterKey", "OdooProductID"]], on="ProductMasterKey", how="left")
    pm = prod.build_product_master_map(dim, m, {1: "Majaal", 3: "Tika"})
    return prod.unmatched_report(dim, pm, sales, {1: "Majaal", 3: "Tika"})


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-dir", required=True, type=Path)
    ap.add_argument("--mapping-csv", required=True, type=Path)
    ap.add_argument("--docs-dir", required=True, type=Path)
    ap.add_argument("--allow-production-input", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    resolved = args.input_dir.resolve()
    if resolved.name.lower() == "input" and (resolved.parent / ".git").exists() and not args.allow_production_input:
        log.error("Refusing to edit %s: it looks like the repository/production Input folder. Use a copy.", resolved)
        return 2

    config = PlatformConfig.from_env(None)
    engine = create_engine(config.database_url, future=True)
    with engine.connect() as conn:
        conn.execute(text("SET SESSION TRANSACTION READ ONLY")) if engine.dialect.name == "mysql" else None
        legacy_sp = {norm(n): int(k) for k, n in conn.execute(text("SELECT SalespersonKey, salesperson FROM dim_salesperson"))}
        orders = pd.read_sql(text("SELECT id, partner_id_id, company_id AS company, LEFT(date_order, 10) AS date_order, "
                                  "CAST(team_id_id AS SIGNED) AS team_id_id FROM raw_sale_order"), conn)
        sales = pd.read_sql(text(
            "SELECT OdooProductID AS ProductKey, CASE CompanyKey WHEN 2 THEN 3 ELSE CompanyKey END AS CompanyKey, "
            "SUM(Value) AS sales_value, SUM(CASE WHEN order_date_date >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH) THEN Value ELSE 0 END) AS sales_value_last_12m, "
            "COUNT(*) AS line_count, MAX(order_date_date) AS last_sale_date FROM fact_saleslines GROUP BY 1, 2"), conn)
    mapping = pd.read_csv(args.mapping_csv, encoding="utf-8-sig")

    source = OdooSource.connect(config, "default")
    partners = pd.DataFrame(source.search_read_all("res.partner", [], ["id", "name", "commercial_partner_id", "is_company", "customer_rank", "active", "ref"], include_archived=True))
    partners["commercial_partner_id"] = partners["commercial_partner_id"].map(lambda v: v[0] if v else None)
    products = pd.DataFrame(source.search_read_all("product.product", [], ["id", "product_tmpl_id", "name", "display_name", "default_code", "company_id", "categ_id", "uom_id", "detailed_type", "active"], include_archived=True))
    for f in ("product_tmpl_id", "company_id"):
        products[f] = products[f].map(lambda v: v[0] if v else None)
    products["categ_name"] = products["categ_id"].map(lambda v: v[1] if v else None)
    products["uom_name"] = products["uom_id"].map(lambda v: v[1] if v else None)

    teams = pd.DataFrame(source.search_read_all("crm.team", [], ["id", "name", "company_id", "active"], include_archived=True))
    sp_keys, added = org_file(args.input_dir, mapping, legacy_sp)
    odoo_teams_sheet(args.input_dir, teams, orders, args.docs_dir / "odoo_team_mapping_review.csv")
    unknown_targets = targets_file(args.input_dir, sp_keys)
    loaded_master = products_file(args.input_dir)
    offdays_file(args.input_dir)
    blocked = blocked_file(args.input_dir, partners)

    master = loaded_master.rename(columns={"ProductKey": "ProductMasterKey"}).assign(_excel_row=loaded_master["SourceRow"])
    if "OdooProductID" not in master:
        master["OdooProductID"] = None
    args.docs_dir.mkdir(parents=True, exist_ok=True)
    customer_duplicates(partners, orders).to_csv(args.docs_dir / "customer_name_duplicates.csv", index=False, encoding="utf-8-sig")
    product_unmatched(products, master, sales).to_csv(args.docs_dir / "product_unmatched.csv", index=False, encoding="utf-8-sig")
    blocked.to_csv(args.docs_dir / "blocked_customers_mapping_review.csv", index=False, encoding="utf-8-sig")
    added.to_csv(args.docs_dir / "bootstrap_salespeople_added.csv", index=False, encoding="utf-8-sig")
    if unknown_targets:
        log.error("sales_targets.xlsx still has salesperson names with no key: %s", unknown_targets)
        return 1
    log.info("Done. Review files written to %s", args.docs_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
