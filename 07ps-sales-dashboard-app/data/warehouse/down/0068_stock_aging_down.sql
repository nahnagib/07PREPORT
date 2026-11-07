-- Reverse of 0068_stock_aging.sql: drops InDate / StockAgeDays / StockAgeBucket and recreates the views.
SET NAMES utf8mb4;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_inventory_snapshot' AND COLUMN_NAME = 'InDate') = 1
  AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_inventory_snapshot') = 1, 'ALTER TABLE fact_sales_inventory_snapshot DROP COLUMN InDate', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_inventory_snapshot' AND COLUMN_NAME = 'InDate') = 1
  AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_inventory_snapshot') = 1, 'ALTER TABLE shd_fact_sales_inventory_snapshot DROP COLUMN InDate', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_sales_product_dashboard' AND COLUMN_NAME = 'StockAgeDays') = 1
  AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_sales_product_dashboard') = 1, 'ALTER TABLE dim_sales_product_dashboard DROP COLUMN StockAgeDays', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_sales_product_dashboard' AND COLUMN_NAME = 'StockAgeBucket') = 1
  AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_sales_product_dashboard') = 1, 'ALTER TABLE dim_sales_product_dashboard DROP COLUMN StockAgeBucket', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_dim_sales_product_dashboard' AND COLUMN_NAME = 'StockAgeDays') = 1
  AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_dim_sales_product_dashboard') = 1, 'ALTER TABLE shd_dim_sales_product_dashboard DROP COLUMN StockAgeDays', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_dim_sales_product_dashboard' AND COLUMN_NAME = 'StockAgeBucket') = 1
  AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_dim_sales_product_dashboard') = 1, 'ALTER TABLE shd_dim_sales_product_dashboard DROP COLUMN StockAgeBucket', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

CREATE OR REPLACE VIEW v_sales_inventory AS SELECT * FROM fact_sales_inventory_snapshot;
CREATE OR REPLACE VIEW v_sales_product_dashboard AS SELECT * FROM dim_sales_product_dashboard;
