-- 0073: Product pages SKU status (2026-11-14).
--
--   dim_sales_product_dashboard now holds EVERY product of the Product pages' companies (Majaal, Tika): the pages' own rows
--   (OnProductPages = 1) plus the archived, excluded and catalog-only products (OnProductPages = 0), so the BCG Matrix
--   page can count Total SKUs. ProductStatus = Unclassified (ProductExclusions.xlsx category / Raw Materials) > Dormant
--   (archived in Odoo) > Active (sold in the last 12 months) > NonActive. The pages' visuals read OnProductPages = 1 only.
--   Since this release the *YTD / *LYTD columns hold the last 12 months / the 12 months before (names unchanged).
-- The shadow table (shd_*) gets the same columns; the view (SELECT *) is recreated so it lists them.
--
-- Additive and idempotent (each column added only when missing; prepared statements, no DELIMITER, for
-- apply_migrations.py). Requires 0070. Apply BEFORE the ETL image that writes these columns.
-- Reverse: down/0073_product_sku_status_down.sql.

SET NAMES utf8mb4;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_sales_product_dashboard' AND COLUMN_NAME = 'ProductStatus') = 0
  AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_sales_product_dashboard') = 1, 'ALTER TABLE dim_sales_product_dashboard ADD COLUMN ProductStatus VARCHAR(16) NULL', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_sales_product_dashboard' AND COLUMN_NAME = 'OnProductPages') = 0
  AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_sales_product_dashboard') = 1, 'ALTER TABLE dim_sales_product_dashboard ADD COLUMN OnProductPages TINYINT(1) NULL', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_dim_sales_product_dashboard' AND COLUMN_NAME = 'ProductStatus') = 0
  AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_dim_sales_product_dashboard') = 1, 'ALTER TABLE shd_dim_sales_product_dashboard ADD COLUMN ProductStatus VARCHAR(16) NULL', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_dim_sales_product_dashboard' AND COLUMN_NAME = 'OnProductPages') = 0
  AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_dim_sales_product_dashboard') = 1, 'ALTER TABLE shd_dim_sales_product_dashboard ADD COLUMN OnProductPages TINYINT(1) NULL', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

CREATE OR REPLACE VIEW v_sales_product_dashboard AS SELECT * FROM dim_sales_product_dashboard;
