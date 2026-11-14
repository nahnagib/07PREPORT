-- 0074: Workbook exclusion outputs of the Product pages build (2026-11-14).
--   dim_sales_product_dashboard.OdooProductID       the Odoo variant id (catalog membership even before the core product
--                                                    key exists); the SKU cards count distinct variants
--   ExcludedByProduct / ExcludedByCategory           the row's ProductExclusions.xlsx match (Products sheet / Categories
--                                                    sheet with sub-categories) -> ProductStatus = Unclassified
-- The Product pages only: the sales lines, the inventory and their views (v_sales_lines, v_sales_inventory) are NOT
-- changed, so every Sales page keeps matching Odoo. Additive and idempotent. Requires 0073.
SET NAMES utf8mb4;

SET @stmt = (SELECT IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_sales_product_dashboard' AND COLUMN_NAME = 'OdooProductID'),
  'DO 0', 'ALTER TABLE dim_sales_product_dashboard ADD COLUMN OdooProductID BIGINT NULL'));
PREPARE st FROM @stmt; EXECUTE st; DEALLOCATE PREPARE st;

SET @stmt = (SELECT IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_sales_product_dashboard' AND COLUMN_NAME = 'ExcludedByProduct'),
  'DO 0', 'ALTER TABLE dim_sales_product_dashboard ADD COLUMN ExcludedByProduct TINYINT(1) NULL'));
PREPARE st FROM @stmt; EXECUTE st; DEALLOCATE PREPARE st;

SET @stmt = (SELECT IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_sales_product_dashboard' AND COLUMN_NAME = 'ExcludedByCategory'),
  'DO 0', 'ALTER TABLE dim_sales_product_dashboard ADD COLUMN ExcludedByCategory TINYINT(1) NULL'));
PREPARE st FROM @stmt; EXECUTE st; DEALLOCATE PREPARE st;

SET @stmt = (SELECT IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_dim_sales_product_dashboard' AND COLUMN_NAME = 'OdooProductID'),
  'DO 0', 'ALTER TABLE shd_dim_sales_product_dashboard ADD COLUMN OdooProductID BIGINT NULL'));
PREPARE st FROM @stmt; EXECUTE st; DEALLOCATE PREPARE st;

SET @stmt = (SELECT IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_dim_sales_product_dashboard' AND COLUMN_NAME = 'ExcludedByProduct'),
  'DO 0', 'ALTER TABLE shd_dim_sales_product_dashboard ADD COLUMN ExcludedByProduct TINYINT(1) NULL'));
PREPARE st FROM @stmt; EXECUTE st; DEALLOCATE PREPARE st;

SET @stmt = (SELECT IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_dim_sales_product_dashboard' AND COLUMN_NAME = 'ExcludedByCategory'),
  'DO 0', 'ALTER TABLE shd_dim_sales_product_dashboard ADD COLUMN ExcludedByCategory TINYINT(1) NULL'));
PREPARE st FROM @stmt; EXECUTE st; DEALLOCATE PREPARE st;

CREATE OR REPLACE VIEW v_sales_product_dashboard AS SELECT * FROM dim_sales_product_dashboard;
