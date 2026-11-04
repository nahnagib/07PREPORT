-- 0065: Product pages, one company per product (2026-11-04).
--
-- The cross-company ("BMH") grouping of the Product pages is removed: every product row is one Odoo product in one
-- company, so dim_sales_product_group (+ its shadow copy) and the ProductGroupKey column are dropped. Athena is left
-- out of the product tables by the ETL (config/product_dashboard.json product_pages.excluded_companies) -- no schema
-- change for that. Rebuilt by the next ETL run; run a full refresh after applying.
--
-- Apply AFTER 0064. Idempotent. Reverse: down/0065_product_pages_one_company_down.sql.

SET NAMES utf8mb4;

DROP TABLE IF EXISTS shd_dim_sales_product_group;
DROP TABLE IF EXISTS dim_sales_product_group;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_sales_product_dashboard' AND COLUMN_NAME = 'ProductGroupKey') = 1,
  'ALTER TABLE dim_sales_product_dashboard DROP COLUMN ProductGroupKey', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_dim_sales_product_dashboard' AND COLUMN_NAME = 'ProductGroupKey') = 1,
  'ALTER TABLE shd_dim_sales_product_dashboard DROP COLUMN ProductGroupKey', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

CREATE OR REPLACE VIEW v_sales_product_dashboard AS SELECT * FROM dim_sales_product_dashboard;
