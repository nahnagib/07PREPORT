-- 0035 (was 0034 until 2026-10-04; 0034 is now finance receivable scope): retire the legacy ETL tables. IRREVERSIBLE -- there is no down script; the pre-rebuild dump is the rollback
-- (docs/rename-map.md section 9, docs/deployment-plan.md).
--
-- Kept in migrations/manual/ so apply_migrations.py (which only sees migrations/*.sql, by basename) can never apply it,
-- not even when asked by name. Apply it deliberately with the mysql client:
--   mysql --defaults-extra-file=<admin.cnf> powerBI_Data < data/warehouse/migrations/manual/0035_retire_legacy.sql
-- Apply ONLY at deployment, after the regression is approved and the platform has run in production for the agreed
-- observation period (docs/deployment-plan.md, step 9). Nothing in the backend, frontend or ETL platform reads these
-- tables (checked 2026-10-04): the zz_legacy_* copies were kept as a rollback aid by 0029/0031; pipeline_* were the
-- legacy run logs (replaced by etl_run_log / etl_task_log, 0028); qa_* were the legacy QA side tables; _tmp_keys_*
-- are leftovers of aborted legacy loads. Every table is named explicitly (no wildcards).

SET NAMES utf8mb4;

-- legacy sales/dimension copies (0029, 0031)
DROP TABLE IF EXISTS zz_legacy_dim_company, zz_legacy_dim_crmstage, zz_legacy_dim_customer, zz_legacy_dim_date,
    zz_legacy_dim_distributionchannel, zz_legacy_dim_invoice, zz_legacy_dim_lostreason, zz_legacy_dim_product,
    zz_legacy_dim_productcost, zz_legacy_dim_productdashboard, zz_legacy_dim_productdashboardgroup, zz_legacy_dim_salesperson,
    zz_legacy_dim_salesteam, zz_legacy_dim_segment;
DROP TABLE IF EXISTS zz_legacy_fact_bcgmatrix, zz_legacy_fact_delivery, zz_legacy_fact_inventory, zz_legacy_fact_lead,
    zz_legacy_fact_offdays, zz_legacy_fact_opportunity, zz_legacy_fact_orders, zz_legacy_fact_productsalesdaily,
    zz_legacy_fact_sales, zz_legacy_fact_saleslines, zz_legacy_fact_targets, zz_legacy_productdashboard_meta;
DROP TABLE IF EXISTS zz_legacy_raw_crm_lead, zz_legacy_raw_crm_lost_reason, zz_legacy_raw_crm_stage, zz_legacy_raw_sale_order,
    zz_legacy_raw_sale_order_line, zz_legacy_raw_sale_report_api, zz_legacy_raw_stock_move, zz_legacy_raw_stock_picking;

-- legacy run logs and QA side tables
DROP TABLE IF EXISTS pipeline_load_metadata, pipeline_run_audit, pipeline_run_log;
DROP TABLE IF EXISTS qa_crm_dataquality, qa_crm_fieldavailability, qa_crm_missinglinks, qa_crm_unmappedkeys,
    qa_inventory_dataquality, qa_missingproductcost, qa_productdataquality, qa_productunmapped;

-- leftovers of aborted legacy loads (names as found on 2026-10-04; any other _tmp_keys_* is dropped by hand)
DROP TABLE IF EXISTS _tmp_keys_1378b70907da4ebd, _tmp_keys_24c917882fe84ba9, _tmp_keys_5892a872c6ff4e6c, _tmp_keys_a62acce9fd484929;
