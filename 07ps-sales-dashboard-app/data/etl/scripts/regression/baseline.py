"""Regression baseline: totals of every fact, grouped by business names/codes (never by surrogate keys), so the
legacy tables and the rebuilt tables can be compared row for row (docs/rename-map.md, phase 4).

  python scripts/regression/baseline.py --profile legacy --out ~/etl-rebuild-backups/baseline_<ts>
  python scripts/regression/baseline.py --profile new    --out ~/etl-rebuild-backups/regression_<ts>
  python scripts/regression/baseline.py --profile legacy --prefix zz_baseline_ --window --out ...

--prefix  reads the legacy tables under a prefix (the zz_baseline_* copies restored from the pre-rebuild dump).
--window  keeps only the records listed in table zz_regression_window (fact, record_id) for the facts that have a
          record id (WINDOW_ID); facts without one are captured whole. Used to compare like with like: only records
          that existed, unchanged, at baseline time.

Every numeric measure column of each fact is summed (plus a row count), per grouping:
  total, company x month, team x month, salesperson x month, channel x month, segment x month,
  and for sales lines brand x month and category x month.
Customer counts per company x month and the per-customer list are exported to explain count differences.
Read-only: the session is set READ ONLY on MySQL. Reads DB_URL / DB_* (config.settings).
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

import pandas as pd
from sqlalchemy import create_engine, text

ROOT = Path(__file__).resolve().parents[2]
for p in (ROOT, ROOT / "src"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

from config.settings import Settings  # noqa: E402

MONTH_CUTOFF = "2026-09-30"  # last complete day before the rebuild; later rows are excluded on both sides


@dataclass(frozen=True)
class FactSpec:
    name: str  # logical name, identical in both profiles
    table: str
    date_expr: str | None  # SQL date expression on alias f
    measures: tuple[str, ...]
    groups: dict[str, str] = field(default_factory=dict)  # group name -> SQL expression (joins in `joins`)
    joins: str = ""
    apply_cutoff: bool = True  # False for plans/calendars that legitimately run into the future


# record id per fact (same column in both profiles) for --window; facts without one are snapshots or derived totals
WINDOW_ID = {"sales_lines": "f.OdooOrderID", "orders": "f.SalesDocumentID", "sales_documents": "f.SalesDocumentID",
             "deliveries": "f.DeliveryFactID", "leads": "f.LeadID", "opportunities": "f.OpportunityID"}
WINDOW_TABLE = "zz_regression_window"


def _legacy_joins(company=True, salesperson=True, channel=True, segment=True) -> tuple[str, dict[str, str]]:
    joins, groups = [], {}
    if company:
        joins.append("LEFT JOIN dim_company dc ON dc.CompanyKey = f.CompanyKey")
        groups["company"] = "COALESCE(dc.Company, 'Unknown')"
    if salesperson:
        joins.append("LEFT JOIN dim_salesperson ds ON ds.SalespersonKey = f.SalespersonKey")
        groups["salesperson"] = "COALESCE(ds.salesperson, 'Unknown_Salesperson')"
    if channel:
        joins.append("LEFT JOIN dim_distributionchannel dch ON dch.ChannelKey = f.ChannelKey")
        groups["channel"] = "COALESCE(dch.DistributionChannel, 'Unknown')"
    if segment:
        joins.append("LEFT JOIN dim_segment dsg ON dsg.SegmentKey = f.SegmentKey")
        groups["segment"] = "COALESCE(dsg.Segment, 'Unknown')"
    return " ".join(joins), groups


def legacy_specs() -> list[FactSpec]:
    specs = []

    def add(name, table, date_expr, measures, team=True, cutoff=True, **flags):
        joins, groups = _legacy_joins(**flags)
        if team:
            groups["team"] = "COALESCE(f.SalesTeamKey, 'MJ-TIK-00')"
        specs.append(FactSpec(name, table, date_expr, tuple(measures), groups, joins, cutoff))

    add("sales_lines", "fact_saleslines", "f.order_date_date",
        ["Value", "Volume", "quantity", "line_total", "untaxed_total", "qty_ordered", "qty_delivered", "InvoiceValue"])
    specs[-1].groups.update({"brand": "COALESCE(f.Brand, '(none)')", "category": "COALESCE(f.Category, '(none)')"})
    add("orders", "fact_orders", "f.OrderDate",
        ["OrderValue", "OrderVolume", "IsRealQuotation", "IsSystemGeneratedQuotation", "IsWonQuotation", "IsRealSalesOrder", "IsLinkedToOpportunity"])
    add("sales_documents", "fact_sales", "f.OrderDate",
        ["OrderValue", "OrderVolume", "IsRealQuotation", "IsSystemGeneratedQuotation", "IsWonQuotation", "IsRealSalesOrder", "IsLinkedToOpportunity"])
    add("targets", "fact_targets", "f.TargetDate", ["Target_Revenue", "Target_Volume"], cutoff=False)
    add("deliveries", "fact_delivery", "f.OrderDate", ["OrderedQuantity", "DeliveredQuantity", "RemainingQuantity", "IsRealDelivery", "Count"], channel=False, segment=False)
    add("leads", "fact_lead", "f.LeadCreatedDate", ["IsActiveLead", "IsConvertedToOpportunity", "Count"], channel=False, segment=False)
    add("opportunities", "fact_opportunity", "f.OpportunityCreatedDate",
        ["ExpectedRevenue", "ProratedRevenue", "IsWon", "IsLost", "IsOpen", "HasQuotation", "Count"], channel=False, segment=False)
    add("product_daily", "fact_productsalesdaily", "f.OrderDate", ["Value", "Qty", "QtyOrdered", "QtyDelivered", "CostValue", "Lines"], channel=False, segment=False)
    add("inventory", "fact_inventory", "f.SnapshotDate", ["OnHandQty", "ReservedQty", "AvailableQty", "InventoryValue"], cutoff=False, team=False, salesperson=False, channel=False, segment=False)
    specs.append(FactSpec("bcg_matrix", "fact_bcgmatrix", None, ("total_quantity_YTD", "total_quantity_LYTD", "total_value_YTD", "total_value_LYTD"),
                          {"company": "COALESCE(f.Company, 'Unknown')"}))
    specs.append(FactSpec("offdays", "fact_offdays", "f.Date", (), {"company": "COALESCE(f.Company, '(all)')"}, apply_cutoff=False))
    return specs


def _new_joins(company=True, salesperson=True, channel=True, segment=True) -> tuple[str, dict[str, str]]:
    """Same groupings on the conformed model. Labels are mapped back to the legacy wording so files compare 1:1:
    team '-1' -> 'MJ-TIK-00', salesperson -1 'Unassigned' -> 'Unknown_Salesperson' (the documented renames)."""
    joins, groups = [], {}
    if company:
        joins.append("LEFT JOIN dim_company dc ON dc.CompanyKey = f.CompanyKey")
        groups["company"] = "CASE WHEN f.CompanyKey = -1 THEN 'Unknown' ELSE COALESCE(dc.Company, 'Unknown') END"
    if salesperson:
        joins.append("LEFT JOIN dim_salesperson ds ON ds.SalespersonKey = f.SalespersonKey")
        groups["salesperson"] = "CASE WHEN f.SalespersonKey = -1 THEN 'Unknown_Salesperson' ELSE COALESCE(ds.salesperson, 'Unknown_Salesperson') END"
    if channel:
        joins.append("LEFT JOIN dim_channel dch ON dch.ChannelKey = f.ChannelKey")
        groups["channel"] = "COALESCE(dch.DistributionChannel, 'Unknown')"
    if segment:
        joins.append("LEFT JOIN dim_segment dsg ON dsg.SegmentKey = f.SegmentKey")
        groups["segment"] = "COALESCE(dsg.Segment, 'Unknown')"
    return " ".join(joins), groups


def new_specs() -> list[FactSpec]:
    """The legacy specs, read from the serving views of the conformed model."""
    table_of = {"fact_saleslines": "v_sales_lines", "fact_orders": "v_sales_orders", "fact_sales": "v_sales_documents",
                "fact_targets": "v_sales_targets", "fact_delivery": "v_sales_deliveries", "fact_lead": "v_sales_leads",
                "fact_opportunity": "v_sales_opportunities", "fact_productsalesdaily": "v_sales_product_daily",
                "fact_inventory": "v_sales_inventory", "fact_bcgmatrix": "v_sales_bcg_matrix", "fact_offdays": "dim_offday"}
    out = []
    for spec in legacy_specs():
        flags = {"company": "company" in spec.groups, "salesperson": "salesperson" in spec.groups,
                 "channel": "channel" in spec.groups, "segment": "segment" in spec.groups}
        joins, groups = _new_joins(**flags) if spec.joins else ("", {})
        for g, expr in spec.groups.items():
            if g == "team":
                groups[g] = "CASE WHEN f.SalesTeamKey = '-1' THEN 'MJ-TIK-00' ELSE f.SalesTeamKey END"
            elif g not in groups:
                groups[g] = expr  # plain columns (brand, category, BCG/offday company text)
        if spec.name == "offdays":
            groups = {"company": "COALESCE(f.Company, '(all)')"}
        out.append(FactSpec(spec.name, table_of[spec.table], spec.date_expr, spec.measures, groups, joins, spec.apply_cutoff))
    return out


PROFILES = {"legacy": legacy_specs, "new": new_specs}
CUSTOMER_QUERIES = {
    "new": {
        "customers_by_company_month": (
            "SELECT COALESCE(dc.Company,'Unknown') AS company, DATE_FORMAT(f.order_date_date, '%Y-%m') AS month, "
            "COUNT(DISTINCT f.CustomerKey) AS customers, COUNT(DISTINCT f.OdooPartnerID) AS odoo_partners "
            "FROM v_sales_lines f LEFT JOIN dim_company dc ON dc.CompanyKey = f.CompanyKey "
            "WHERE (f.order_date_date <= :cutoff OR f.order_date_date IS NULL) GROUP BY 1, 2"),
        "customer_list": (
            "SELECT COALESCE(dc.Company,'Unknown') AS company, f.CustomerKey AS customer_key, MAX(cu.customer) AS customer, "
            "GROUP_CONCAT(DISTINCT f.OdooPartnerID ORDER BY f.OdooPartnerID) AS odoo_partner_ids, COUNT(*) AS line_count, SUM(f.Value) AS value "
            "FROM v_sales_lines f LEFT JOIN dim_company dc ON dc.CompanyKey = f.CompanyKey LEFT JOIN dim_customer cu ON cu.CustomerKey = f.CustomerKey "
            "WHERE (f.order_date_date <= :cutoff OR f.order_date_date IS NULL) GROUP BY 1, 2"),
    },
    "legacy": {
        "customers_by_company_month": (
            "SELECT COALESCE(dc.Company,'Unknown') AS company, DATE_FORMAT(f.order_date_date, '%Y-%m') AS month, "
            "COUNT(DISTINCT f.CustomerKey) AS customers, COUNT(DISTINCT f.OdooPartnerID) AS odoo_partners "
            "FROM fact_saleslines f LEFT JOIN dim_company dc ON dc.CompanyKey = f.CompanyKey "
            "WHERE (f.order_date_date <= :cutoff OR f.order_date_date IS NULL) GROUP BY 1, 2"),
        "customer_list": (
            "SELECT COALESCE(dc.Company,'Unknown') AS company, f.CustomerID AS legacy_customer_id, MAX(f.customer) AS customer, "
            "GROUP_CONCAT(DISTINCT f.OdooPartnerID ORDER BY f.OdooPartnerID) AS odoo_partner_ids, COUNT(*) AS line_count, SUM(f.Value) AS value "
            "FROM fact_saleslines f LEFT JOIN dim_company dc ON dc.CompanyKey = f.CompanyKey "
            "WHERE (f.order_date_date <= :cutoff OR f.order_date_date IS NULL) GROUP BY 1, 2"),
    },
}


def _measures_sql(spec: FactSpec) -> str:
    parts = ["COUNT(*) AS row_count"] + [f"SUM(f.`{m}`) AS `{m}`" for m in spec.measures]
    return ", ".join(parts)


LEGACY_TABLES = ("fact_saleslines", "fact_orders", "fact_sales", "fact_targets", "fact_delivery", "fact_lead", "fact_opportunity",
                 "fact_productsalesdaily", "fact_inventory", "fact_bcgmatrix", "fact_offdays", "dim_company", "dim_salesperson",
                 "dim_distributionchannel", "dim_segment")


def _prefixed(sql: str, prefix: str) -> str:
    if not prefix:
        return sql
    return re.sub(r"\b(" + "|".join(LEGACY_TABLES) + r")\b(?=\s+(?:f|dc|ds|dch|dsg|cu)\b)", lambda m: prefix + m.group(1), sql)


def _window_sql(spec_name: str) -> str | None:
    expr = WINDOW_ID.get(spec_name)
    if expr is None:
        return None
    # explicit collation: CAST() takes the connection's default (utf8mb4_0900_ai_ci), the window table is unicode_ci
    return (f"CAST({expr} AS CHAR) COLLATE utf8mb4_unicode_ci IN "
            f"(SELECT record_id FROM {WINDOW_TABLE} WHERE fact = '{spec_name}')")


def capture(engine, profile: str, out: Path, *, prefix: str = "", window: bool = False) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    manifest = {"profile": profile, "prefix": prefix, "window": window,
                "captured_at_utc": _dt.datetime.now(_dt.timezone.utc).isoformat(), "cutoff": MONTH_CUTOFF, "files": {}}
    with engine.connect() as conn:
        mysql = engine.dialect.name == "mysql"
        if mysql:
            conn.execute(text("SET SESSION TRANSACTION READ ONLY"))
        try:
            for spec in PROFILES[profile]():
                # DATE(): the cutoff day counts whole (several date columns are DATETIME); undated rows count too
                conds = [f"(DATE({spec.date_expr}) <= :cutoff OR {spec.date_expr} IS NULL)"] if spec.date_expr and spec.apply_cutoff else []
                if window and _window_sql(spec.name):
                    conds.append(_window_sql(spec.name))
                where = ("WHERE " + " AND ".join(conds)) if conds else ""
                groupings = {"total": []}
                month = f"DATE_FORMAT({spec.date_expr}, '%Y-%m')" if spec.date_expr else None
                for g in spec.groups:
                    groupings[f"{g}_month" if month else g] = [g]
                for label, cols in groupings.items():
                    select_cols = [f"{spec.groups[c]} AS `{c}`" for c in cols]
                    if month and label != "total":
                        select_cols.append(f"{month} AS `month`")
                    group_by = ", ".join(str(i + 1) for i in range(len(select_cols)))
                    sql = _prefixed(f"SELECT {', '.join(select_cols + [_measures_sql(spec)])} FROM {spec.table} f {spec.joins} {where}"
                                    + (f" GROUP BY {group_by}" if group_by else ""), prefix)
                    df = pd.read_sql(text(sql), conn, params={"cutoff": MONTH_CUTOFF})
                    name = f"{spec.name}__{label}.csv"
                    df.sort_values(list(df.columns[: len(select_cols)]) or list(df.columns[:1])).to_csv(out / name, index=False, float_format="%.6f")
                    manifest["files"][name] = {"rows": len(df), "sql": sql}
            for name, sql in CUSTOMER_QUERIES.get(profile, {}).items():
                if window:
                    sql = sql.replace("WHERE (", f"WHERE {_window_sql('sales_lines')} AND (", 1)
                sql = _prefixed(sql, prefix)
                df = pd.read_sql(text(sql), conn, params={"cutoff": MONTH_CUTOFF})
                df.to_csv(out / f"{name}.csv", index=False, float_format="%.6f")
                manifest["files"][f"{name}.csv"] = {"rows": len(df), "sql": sql}
        finally:
            if mysql:  # the session goes back to a pool: never leave it read-only
                conn.rollback()
                conn.execute(text("SET SESSION TRANSACTION READ WRITE"))

    (out / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    return manifest


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", choices=sorted(PROFILES), required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--prefix", default="", help="legacy profile: table-name prefix, e.g. zz_baseline_")
    ap.add_argument("--window", action="store_true", help=f"only records listed in {WINDOW_TABLE}")
    args = ap.parse_args(argv)
    engine = create_engine(Settings.from_env(None).sqlalchemy_url, future=True)
    if args.prefix and args.profile != "legacy":
        ap.error("--prefix applies to the legacy profile only")
    manifest = capture(engine, args.profile, args.out, prefix=args.prefix, window=args.window)
    print(f"{len(manifest['files'])} file(s) written to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
