"""Generates migrations/0031_sales_mart.sql + down/0031_sales_mart_down.sql from the legacy sales tables.

The sales marts keep the legacy column sets (approved rule D3: existing sales columns keep their names) and swap the
legacy key columns for conformed ones:
  CustomerKey BIGINT, CompanyKey BIGINT, SalespersonKey INT, SalesTeamKey VARCHAR(64), ChannelKey INT, SegmentKey INT,
  DateKey / *DateKey INT, all NOT NULL (-1 = Unknown);
  legacy text ProductKey -> ProductMasterKey VARCHAR(191) (+ ProductKey BIGINT = Odoo product id where the table
  carries OdooProductID); InvoiceKey (row number) -> SalesOrderKey BIGINT (Odoo sale.order id).
The generated SQL is committed and reviewed like any migration; this script is only how it was produced.

Usage: python data/warehouse/tools/gen_0031_sales_mart.py  (reads the legacy tables; DB_* env, read-only)
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pymysql

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "migrations" / "0031_sales_mart.sql"
DOWN = HERE.parent / "down" / "0031_sales_mart_down.sql"

# legacy table -> (new table, primary key columns (after conformance), extra columns to add)
TABLES = {
    "fact_saleslines": ("fact_sales_lines", ["SaleReportLineID"], ["SalesOrderKey BIGINT NOT NULL DEFAULT -1", "ProductKey BIGINT NOT NULL DEFAULT -1"]),
    "fact_orders": ("fact_sales_orders", ["SalesDocumentID"], ["SalesOrderKey BIGINT NOT NULL DEFAULT -1"]),
    "fact_sales": ("fact_sales_documents", ["SalesDocumentID"], ["SalesOrderKey BIGINT NOT NULL DEFAULT -1"]),
    "fact_targets": ("fact_sales_targets", ["YearMonth", "SalespersonKey", "SalesTeamKey", "CompanyKey"], []),
    "fact_delivery": ("fact_sales_deliveries", ["DeliveryFactID"], []),
    "fact_lead": ("fact_sales_leads", ["LeadID", "IsOdooCreatedLead", "IsETLCreatedLead"], []),
    "fact_opportunity": ("fact_sales_opportunities", ["OpportunityID"], []),
    "fact_productsalesdaily": ("fact_sales_product_daily", ["row_key"], ["row_key CHAR(40) NOT NULL COMMENT 'sha1 of the grain (date, company, product match key, salesperson, team, channel, segment, intercompany, uom)'"]),
    "fact_inventory": ("fact_sales_inventory_snapshot", ["SnapshotDateKey", "CompanyKey", "ProductKey", "LocationID"], ["ProductKey BIGINT NOT NULL DEFAULT -1"]),
    "fact_bcgmatrix": ("fact_sales_bcg_matrix", ["CompanyKey", "ProductMasterKey", "ProductKey"],
                       ["CompanyKey BIGINT NOT NULL DEFAULT -1", "ProductKey BIGINT NOT NULL DEFAULT -1 COMMENT 'Odoo product id for a product with no PRODUCTS.xlsx row, else -1'"]),
    "dim_crmstage": ("dim_sales_crm_stage", ["StageID"], []),
    "dim_lostreason": ("dim_sales_lost_reason", ["LostReasonID"], []),
    "dim_productcost": ("dim_sales_product_cost", ["ProductKey", "CompanyKey"], ["ProductKey BIGINT NOT NULL DEFAULT -1", "CompanyKey BIGINT NOT NULL DEFAULT -1"]),
    "dim_productdashboard": ("dim_sales_product_dashboard", ["ProductMatchKey"], ["CompanyKey BIGINT NOT NULL DEFAULT -1"]),
    "dim_productdashboardgroup": ("dim_sales_product_group", ["ProductGroupKey"], []),
    "productdashboard_meta": ("etl_sales_product_dashboard_meta", ["AsOfDate"], []),
}
# legacy tables retired by this migration (renamed zz_legacy_*), beyond the ones above
RETIRED_ONLY = ["dim_invoice", "raw_sale_order", "raw_sale_order_line", "raw_sale_report_api",
                "raw_stock_move", "raw_stock_picking", "raw_crm_lead", "raw_crm_stage", "raw_crm_lost_reason"]
KEY_TYPES = {
    "CustomerKey": "BIGINT NOT NULL DEFAULT -1", "CompanyKey": "BIGINT NOT NULL DEFAULT -1",
    "SalespersonKey": "INT NOT NULL DEFAULT -1", "SalesTeamKey": "VARCHAR(64) NOT NULL DEFAULT '-1'",
    "ChannelKey": "INT NOT NULL DEFAULT -1", "SegmentKey": "INT NOT NULL DEFAULT -1",
}
PK_TEXT = {"SaleReportLineID": "BIGINT NOT NULL", "SalesDocumentID": "BIGINT NOT NULL", "YearMonth": "VARCHAR(7) NOT NULL",
           "DeliveryFactID": "VARCHAR(191) NOT NULL", "LeadID": "VARCHAR(191) NOT NULL", "OpportunityID": "BIGINT NOT NULL",
           "LocationID": "BIGINT NOT NULL", "StageID": "BIGINT NOT NULL", "LostReasonID": "BIGINT NOT NULL",
           "ProductMatchKey": "VARCHAR(600) NOT NULL", "ProductGroupKey": "VARCHAR(600) NOT NULL", "SnapshotDateKey": "INT NOT NULL",
           "IsOdooCreatedLead": "TINYINT(1) NOT NULL", "IsETLCreatedLead": "TINYINT(1) NOT NULL", "AsOfDate": "DATE NOT NULL"}
INDEXES = {  # secondary indexes the backend filters/joins on
    "fact_sales_lines": ["DateKey", "CustomerKey", "SalespersonKey", "SalesTeamKey", "CompanyKey", "ProductKey", "ProductMasterKey", "SalesOrderKey"],
    "fact_sales_orders": ["DateKey", "OrderDateTime", "QuotationDate", "CustomerKey", "SalespersonKey", "SalesTeamKey", "CompanyKey"],
    "fact_sales_documents": ["DateKey", "CustomerKey", "SalespersonKey", "SalesTeamKey", "CompanyKey"],
    "fact_sales_deliveries": ["OrderDateKey", "SalespersonKey", "SalesTeamKey", "CompanyKey"],
    "fact_sales_leads": ["LeadCreatedDateKey", "SalespersonKey", "SalesTeamKey", "CompanyKey"],
    "fact_sales_opportunities": ["OpportunityCreatedDateKey", "SalespersonKey", "SalesTeamKey", "CompanyKey"],
    "fact_sales_product_daily": ["DateKey", "CompanyKey", "SalespersonKey", "SalesTeamKey"],
}
VIEWS = {"v_sales_lines": "fact_sales_lines", "v_sales_orders": "fact_sales_orders", "v_sales_documents": "fact_sales_documents",
         "v_sales_targets": "fact_sales_targets", "v_sales_deliveries": "fact_sales_deliveries", "v_sales_leads": "fact_sales_leads",
         "v_sales_opportunities": "fact_sales_opportunities", "v_sales_product_daily": "fact_sales_product_daily",
         "v_sales_inventory": "fact_sales_inventory_snapshot", "v_sales_bcg_matrix": "fact_sales_bcg_matrix",
         "v_sales_product_dashboard": "dim_sales_product_dashboard"}


def column_def(name: str, col_type: str, new_table: str, pk: list[str]) -> str | None:
    if name == "InvoiceKey":
        return None  # replaced by SalesOrderKey
    if name == "ProductKey":
        return f"ProductMasterKey VARCHAR(191) NOT NULL DEFAULT '-1'"
    if name in KEY_TYPES:
        return f"{name} {KEY_TYPES[name]}"
    if name == "DateKey" or name.endswith("DateKey"):
        return f"{name} INT NOT NULL DEFAULT -1" if name not in pk else f"{name} INT NOT NULL"
    if name in pk and name in PK_TEXT:
        return f"{name} {PK_TEXT[name]}"
    return f"`{name}` {col_type.upper()} NULL"


def main() -> int:
    conn = pymysql.connect(host=os.getenv("DB_HOST", "127.0.0.1"), port=int(os.getenv("DB_PORT", "3306")), user=os.environ["DB_USER"],
                           password=os.environ["DB_PASSWORD"], database=os.environ.get("DB_NAME", "powerBI_Data"), charset="utf8mb4")
    cur = conn.cursor()
    cur.execute("SET SESSION TRANSACTION READ ONLY")
    up = [HEADER]
    renames = []
    for legacy, (new, pk, extra) in TABLES.items():
        cur.execute("SELECT column_name, column_type FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = %s "
                    "ORDER BY ordinal_position", (legacy,))
        cols = cur.fetchall()
        if not cols:
            raise SystemExit(f"legacy table {legacy} not found")
        names = {c for c, _ in cols}
        defs, seen = [], set()
        for c, t in cols:
            d = column_def(c, t, new, pk)
            if d:
                defs.append("    " + d)
                seen.add(d.split()[0].strip("`"))
        for e in extra:
            col = e.split()[0]
            if col in seen:
                continue
            if col == "ProductKey" and "OdooProductID" not in names and new not in ("dim_sales_product_cost", "fact_sales_bcg_matrix"):
                continue
            defs.append("    " + e)
            seen.add(col)
        defs.append("    _run_id CHAR(36) NULL COMMENT 'etl_run_log.run_uid of the load'")
        defs.append(f"    PRIMARY KEY ({', '.join(pk)})")
        for ix in INDEXES.get(new, []):
            if ix in seen and ix not in pk[:1]:
                defs.append(f"    INDEX ix_{new}_{ix.lower()} ({ix})")
        up.append(f"CREATE TABLE IF NOT EXISTS {new} (\n" + ",\n".join(defs) +
                  "\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;\n")
        renames.append(legacy)
    up.insert(1, rename_block(renames + RETIRED_ONLY))
    up.append(SALES_ORDER_DIM)
    for view, table in VIEWS.items():
        up.append(f"CREATE OR REPLACE VIEW {view} AS SELECT * FROM {table};")
    OUT.write_text("\n".join(up) + "\n", encoding="utf-8")
    DOWN.write_text(down_sql(renames + RETIRED_ONLY), encoding="utf-8")
    print(f"wrote {OUT} and {DOWN}")
    return 0


def rename_block(tables: list[str]) -> str:
    lines = ["-- 1. legacy sales tables -> zz_legacy_* (rollback copies; dropped by the retire migration after the regression)",
             "--    plus a fact_offdays recreated by a legacy run after 0029 (its pre-rebuild copy is zz_legacy_fact_offdays)."]
    for t in tables:
        lines.append(f"SET @s = (SELECT IF(COUNT(*) = 1, 'RENAME TABLE {t} TO zz_legacy_{t}', 'DO 0') FROM information_schema.TABLES "
                     f"WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{t}' AND (SELECT COUNT(*) FROM information_schema.TABLES "
                     f"WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'zz_legacy_{t}') = 0);")
        lines.append("PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;")
    lines.append("SET @s = (SELECT IF(COUNT(*) = 1, 'DROP TABLE fact_offdays', 'DO 0') FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() "
                 "AND TABLE_NAME = 'fact_offdays' AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'zz_legacy_fact_offdays') = 1);")
    lines.append("PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;")
    return "\n".join(lines) + "\n\n-- 2. sales mart tables (conformed keys; loaded by departments/sales with an atomic swap)\n"


def down_sql(tables: list[str]) -> str:
    new = [n for n, _, _ in TABLES.values()] + ["dim_sales_order"]
    lines = ["-- Reverses 0031_sales_mart.sql. Idempotent.", "SET NAMES utf8mb4;",
             "DROP VIEW IF EXISTS " + ", ".join(VIEWS) + ";",
             "DROP TABLE IF EXISTS " + ", ".join(new) + ";"]
    for t in tables:
        lines.append(f"SET @s = (SELECT IF(COUNT(*) = 1, 'RENAME TABLE zz_legacy_{t} TO {t}', 'DO 0') FROM information_schema.TABLES "
                     f"WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'zz_legacy_{t}');")
        lines.append("PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;")
    return "\n".join(lines) + "\n"


HEADER = """-- 0031: sales department mart (GENERATED by data/warehouse/tools/gen_0031_sales_mart.py from the legacy tables; review the
-- generated SQL like any migration). docs/rename-map.md section 2.
--
-- Columns are the legacy ones (rule D3) with conformed keys: CustomerKey (commercial partner), CompanyKey (Odoo id),
-- SalespersonKey (frozen), SalesTeamKey (Excel code, AS TRANSACTED: the document's Odoo team via map_odoo_team_sales_team),
-- ChannelKey (follows the salesperson), SegmentKey (follows the team), ProductKey (Odoo product id),
-- ProductMasterKey (frozen PRODUCTS.xlsx code), SalesOrderKey (Odoo sale.order id). -1 / '-1' = Unknown; no NULL keys.
-- Pages read the v_sales_* views. Idempotent. Reverse: down/0031_sales_mart_down.sql.

SET NAMES utf8mb4;
"""

SALES_ORDER_DIM = """CREATE TABLE IF NOT EXISTS dim_sales_order (
    SalesOrderKey BIGINT NOT NULL PRIMARY KEY COMMENT 'Odoo sale.order id (replaces the row-number Dim_Invoice.InvoiceKey)',
    order_number VARCHAR(64) NOT NULL,
    CompanyKey BIGINT NOT NULL DEFAULT -1,
    CustomerKey BIGINT NOT NULL DEFAULT -1,
    _run_id CHAR(36) NULL,
    INDEX ix_dim_sales_order_number (order_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. serving views (1:1 projections; the backend reads these, so physical marts can change without touching it)
"""

if __name__ == "__main__":
    sys.exit(main())
