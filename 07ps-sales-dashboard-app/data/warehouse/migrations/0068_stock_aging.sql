-- 0068: Stock Velocity -- Stock Aging (2026-11-07).
--
--   fact_sales_inventory_snapshot.InDate     Odoo stock.quant in_date: when the stock arrived (one row per quant).
--   dim_sales_product_dashboard.StockAgeDays  units-weighted average age (days) of the product's finished-goods stock on
--                                             hand at the as-of date: SUM(qty x (as-of - in_date)) / SUM(qty).
--   dim_sales_product_dashboard.StockAgeBucket the aging bucket of StockAgeDays (config/product_dashboard.json
--                                             stock.aging_buckets: 0-90, 91-180, 181-365, 1-2 years, > 2 years).
-- The shadow tables (shd_*) get the same columns. The views are SELECT * and MySQL fixes their column list when they
-- are created, so they are recreated.
--
-- Additive and idempotent (each column added only when missing; prepared statements, no DELIMITER, for
-- apply_migrations.py). Requires 0064. Reverse: down/0068_stock_aging_down.sql.

SET NAMES utf8mb4;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_inventory_snapshot' AND COLUMN_NAME = 'InDate') = 0
  AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_inventory_snapshot') = 1, 'ALTER TABLE fact_sales_inventory_snapshot ADD COLUMN InDate DATETIME NULL', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_inventory_snapshot' AND COLUMN_NAME = 'InDate') = 0
  AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_inventory_snapshot') = 1, 'ALTER TABLE shd_fact_sales_inventory_snapshot ADD COLUMN InDate DATETIME NULL', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_sales_product_dashboard' AND COLUMN_NAME = 'StockAgeDays') = 0
  AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_sales_product_dashboard') = 1, 'ALTER TABLE dim_sales_product_dashboard ADD COLUMN StockAgeDays DECIMAL(12,2) NULL', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_sales_product_dashboard' AND COLUMN_NAME = 'StockAgeBucket') = 0
  AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_sales_product_dashboard') = 1, 'ALTER TABLE dim_sales_product_dashboard ADD COLUMN StockAgeBucket VARCHAR(32) NULL', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_dim_sales_product_dashboard' AND COLUMN_NAME = 'StockAgeDays') = 0
  AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_dim_sales_product_dashboard') = 1, 'ALTER TABLE shd_dim_sales_product_dashboard ADD COLUMN StockAgeDays DECIMAL(12,2) NULL', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_dim_sales_product_dashboard' AND COLUMN_NAME = 'StockAgeBucket') = 0
  AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_dim_sales_product_dashboard') = 1, 'ALTER TABLE shd_dim_sales_product_dashboard ADD COLUMN StockAgeBucket VARCHAR(32) NULL', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

CREATE OR REPLACE VIEW v_sales_inventory AS SELECT * FROM fact_sales_inventory_snapshot;
CREATE OR REPLACE VIEW v_sales_product_dashboard AS SELECT * FROM dim_sales_product_dashboard;
