-- Reverse of 0054 (Phase B incremental sales). Set ETL_SALES_MODE=legacy and restart first: nothing may write these
-- tables while they are dropped. The live sales marts are not touched except the two fact_sales_lines columns.

SET NAMES utf8mb4;

DROP TABLE IF EXISTS etl_shadow_diff;
DROP TABLE IF EXISTS etl_shadow_compare;
DROP TABLE IF EXISTS raw_odoo_names;
DROP TABLE IF EXISTS raw_odoo_mirror_meta;
DROP TABLE IF EXISTS raw_odoo_mirror;

DROP TABLE IF EXISTS shd_fact_sales_lines;
DROP TABLE IF EXISTS shd_fact_sales_orders;
DROP TABLE IF EXISTS shd_fact_sales_documents;
DROP TABLE IF EXISTS shd_fact_sales_targets;
DROP TABLE IF EXISTS shd_fact_sales_deliveries;
DROP TABLE IF EXISTS shd_fact_sales_leads;
DROP TABLE IF EXISTS shd_fact_sales_opportunities;
DROP TABLE IF EXISTS shd_fact_sales_product_daily;
DROP TABLE IF EXISTS shd_fact_sales_inventory_snapshot;
DROP TABLE IF EXISTS shd_fact_sales_bcg_matrix;
DROP TABLE IF EXISTS shd_dim_sales_order;
DROP TABLE IF EXISTS shd_dim_sales_crm_stage;
DROP TABLE IF EXISTS shd_dim_sales_lost_reason;
DROP TABLE IF EXISTS shd_dim_sales_product_cost;
DROP TABLE IF EXISTS shd_dim_sales_product_dashboard;
DROP TABLE IF EXISTS shd_dim_sales_product_group;
DROP TABLE IF EXISTS shd_etl_sales_product_dashboard_meta;

SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE fact_sales_lines DROP INDEX ux_fact_sales_lines_group_key', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND INDEX_NAME = 'ux_fact_sales_lines_group_key');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE fact_sales_lines DROP COLUMN Discount', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND COLUMN_NAME = 'Discount');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE fact_sales_lines DROP COLUMN SalesLineGroupKey', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND COLUMN_NAME = 'SalesLineGroupKey');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
