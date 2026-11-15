-- 0078: the ProductExclusions.xlsx rule behind each Unclassified product (2026-11-15).
--   dim_sales_product_dashboard.ExclusionRule   e.g. "Categories sheet · All · Packaging · row 2 · Manufacturing packaging,
--                                                not sold" / "Products sheet · Tika · row 41 · Sample item" /
--                                                "Automatic · Raw Materials category"; NULL for every other product.
-- Shown in the BCG status table's Unclassified tab. Until this is applied the ETL leaves the column out (fit_to_table) and
-- the API falls back to "Products sheet" / "Categories sheet" from ExcludedByProduct / ExcludedByCategory.
-- Additive and idempotent. Requires 0074.
SET NAMES utf8mb4;

SET @stmt = (SELECT IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_sales_product_dashboard' AND COLUMN_NAME = 'ExclusionRule'),
  'DO 0', 'ALTER TABLE dim_sales_product_dashboard ADD COLUMN ExclusionRule VARCHAR(400) NULL'));
PREPARE st FROM @stmt; EXECUTE st; DEALLOCATE PREPARE st;

SET @stmt = (SELECT IF(NOT EXISTS(SELECT 1 FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_dim_sales_product_dashboard') OR EXISTS(SELECT 1 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_dim_sales_product_dashboard' AND COLUMN_NAME = 'ExclusionRule'),
  'DO 0', 'ALTER TABLE shd_dim_sales_product_dashboard ADD COLUMN ExclusionRule VARCHAR(400) NULL'));
PREPARE st FROM @stmt; EXECUTE st; DEALLOCATE PREPARE st;

-- SELECT * views keep their column list from creation time: recreate so the new column shows.
CREATE OR REPLACE VIEW v_sales_product_dashboard AS SELECT * FROM dim_sales_product_dashboard;
