-- Reverse of 0078_product_exclusion_rule.sql.
SET NAMES utf8mb4;
SET @stmt = (SELECT IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_sales_product_dashboard' AND COLUMN_NAME = 'ExclusionRule'), 'ALTER TABLE dim_sales_product_dashboard DROP COLUMN ExclusionRule', 'DO 0'));
PREPARE st FROM @stmt; EXECUTE st; DEALLOCATE PREPARE st;
SET @stmt = (SELECT IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_dim_sales_product_dashboard' AND COLUMN_NAME = 'ExclusionRule'), 'ALTER TABLE shd_dim_sales_product_dashboard DROP COLUMN ExclusionRule', 'DO 0'));
PREPARE st FROM @stmt; EXECUTE st; DEALLOCATE PREPARE st;
CREATE OR REPLACE VIEW v_sales_product_dashboard AS SELECT * FROM dim_sales_product_dashboard;
