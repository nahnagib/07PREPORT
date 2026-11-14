-- Reverse of 0074_workbook_product_exclusions.sql (the Product dashboard table only).
SET NAMES utf8mb4;

SET @stmt = (SELECT IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_sales_product_dashboard' AND COLUMN_NAME = 'OdooProductID'), 'ALTER TABLE dim_sales_product_dashboard DROP COLUMN OdooProductID', 'DO 0'));
PREPARE st FROM @stmt; EXECUTE st; DEALLOCATE PREPARE st;
SET @stmt = (SELECT IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_sales_product_dashboard' AND COLUMN_NAME = 'ExcludedByProduct'), 'ALTER TABLE dim_sales_product_dashboard DROP COLUMN ExcludedByProduct', 'DO 0'));
PREPARE st FROM @stmt; EXECUTE st; DEALLOCATE PREPARE st;
SET @stmt = (SELECT IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_sales_product_dashboard' AND COLUMN_NAME = 'ExcludedByCategory'), 'ALTER TABLE dim_sales_product_dashboard DROP COLUMN ExcludedByCategory', 'DO 0'));
PREPARE st FROM @stmt; EXECUTE st; DEALLOCATE PREPARE st;
SET @stmt = (SELECT IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_dim_sales_product_dashboard' AND COLUMN_NAME = 'OdooProductID'), 'ALTER TABLE shd_dim_sales_product_dashboard DROP COLUMN OdooProductID', 'DO 0'));
PREPARE st FROM @stmt; EXECUTE st; DEALLOCATE PREPARE st;
SET @stmt = (SELECT IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_dim_sales_product_dashboard' AND COLUMN_NAME = 'ExcludedByProduct'), 'ALTER TABLE shd_dim_sales_product_dashboard DROP COLUMN ExcludedByProduct', 'DO 0'));
PREPARE st FROM @stmt; EXECUTE st; DEALLOCATE PREPARE st;
SET @stmt = (SELECT IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_dim_sales_product_dashboard' AND COLUMN_NAME = 'ExcludedByCategory'), 'ALTER TABLE shd_dim_sales_product_dashboard DROP COLUMN ExcludedByCategory', 'DO 0'));
PREPARE st FROM @stmt; EXECUTE st; DEALLOCATE PREPARE st;

CREATE OR REPLACE VIEW v_sales_product_dashboard AS SELECT * FROM dim_sales_product_dashboard;
