-- Reverse of 0064_product_odoo_source_of_truth.sql: the *_deprecated sheet tables get their names back, the product marts
-- are re-created in their 0031 shape (empty until the previous release's ETL runs), the dropped fact_sales_lines columns
-- come back empty (the previous release's ETL refills them on its next full refresh), and the added Odoo attribute
-- columns are removed. Idempotent.

SET NAMES utf8mb4;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'raw_excel_products_deprecated') = 1
    AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'raw_excel_products') = 0,
  'RENAME TABLE raw_excel_products_deprecated TO raw_excel_products', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_product_master_deprecated') = 1
    AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_product_master') = 0,
  'RENAME TABLE dim_product_master_deprecated TO dim_product_master', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'map_product_master_deprecated') = 1
    AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'map_product_master') = 0,
  'RENAME TABLE map_product_master_deprecated TO map_product_master', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'qa_productunmapped_deprecated') = 1
    AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'qa_productunmapped') = 0,
  'RENAME TABLE qa_productunmapped_deprecated TO qa_productunmapped', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'qa_productdataquality_deprecated') = 1
    AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'qa_productdataquality') = 0,
  'RENAME TABLE qa_productdataquality_deprecated TO qa_productdataquality', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'raw_odoo_product_product') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'raw_odoo_product_product' AND COLUMN_NAME = 'brand') = 1,
  'ALTER TABLE raw_odoo_product_product DROP COLUMN brand', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'raw_odoo_product_product') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'raw_odoo_product_product' AND COLUMN_NAME = 'sub_brand') = 1,
  'ALTER TABLE raw_odoo_product_product DROP COLUMN sub_brand', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'raw_odoo_product_product') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'raw_odoo_product_product' AND COLUMN_NAME = 'family') = 1,
  'ALTER TABLE raw_odoo_product_product DROP COLUMN family', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'raw_odoo_product_product') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'raw_odoo_product_product' AND COLUMN_NAME = 'size') = 1,
  'ALTER TABLE raw_odoo_product_product DROP COLUMN size', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

DROP TABLE IF EXISTS raw_odoo_product_supplierinfo;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_product') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_product' AND COLUMN_NAME = 'categ_id') = 1,
  'ALTER TABLE dim_product DROP COLUMN categ_id', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_product') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_product' AND COLUMN_NAME = 'brand') = 1,
  'ALTER TABLE dim_product DROP COLUMN brand', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_product') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_product' AND COLUMN_NAME = 'sub_brand') = 1,
  'ALTER TABLE dim_product DROP COLUMN sub_brand', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_product') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_product' AND COLUMN_NAME = 'family') = 1,
  'ALTER TABLE dim_product DROP COLUMN family', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_product') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_product' AND COLUMN_NAME = 'size') = 1,
  'ALTER TABLE dim_product DROP COLUMN size', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND COLUMN_NAME = 'ProductTemplateID') = 1,
  'ALTER TABLE fact_sales_lines DROP COLUMN ProductTemplateID', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND COLUMN_NAME = 'IsMappedProduct') = 0,
  'ALTER TABLE fact_sales_lines ADD COLUMN `IsMappedProduct` TINYINT(1) NULL', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND COLUMN_NAME = 'ProductMatchKey') = 0,
  'ALTER TABLE fact_sales_lines ADD COLUMN `ProductMatchKey` VARCHAR(255) NULL', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND COLUMN_NAME = 'ProductMappingReason') = 0,
  'ALTER TABLE fact_sales_lines ADD COLUMN `ProductMappingReason` TEXT NULL', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND COLUMN_NAME = 'ProductMappingStatus') = 0,
  'ALTER TABLE fact_sales_lines ADD COLUMN `ProductMappingStatus` TEXT NULL', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND COLUMN_NAME = 'ProductNameClean') = 0,
  'ALTER TABLE fact_sales_lines ADD COLUMN `ProductNameClean` TEXT NULL', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND COLUMN_NAME = 'ProductNameRaw') = 0,
  'ALTER TABLE fact_sales_lines ADD COLUMN `ProductNameRaw` TEXT NULL', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND COLUMN_NAME = 'product_name') = 0,
  'ALTER TABLE fact_sales_lines ADD COLUMN `product_name` TEXT NULL', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND COLUMN_NAME = 'product_name_clean') = 0,
  'ALTER TABLE fact_sales_lines ADD COLUMN `product_name_clean` TEXT NULL', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND COLUMN_NAME = 'product_name_raw') = 0,
  'ALTER TABLE fact_sales_lines ADD COLUMN `product_name_raw` TEXT NULL', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND COLUMN_NAME = 'ProductLevel') = 0,
  'ALTER TABLE fact_sales_lines ADD COLUMN `ProductLevel` TEXT NULL', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND COLUMN_NAME = 'ProductJoinKey') = 0,
  'ALTER TABLE fact_sales_lines ADD COLUMN `ProductJoinKey` VARCHAR(255) NULL', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND COLUMN_NAME = 'OdooProductNameClean') = 0,
  'ALTER TABLE fact_sales_lines ADD COLUMN `OdooProductNameClean` TEXT NULL', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND COLUMN_NAME = 'ProductMasterKey') = 0,
  'ALTER TABLE fact_sales_lines ADD COLUMN ProductMasterKey VARCHAR(191) NOT NULL DEFAULT ''-1''', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND INDEX_NAME = 'ix_fact_sales_lines_productmasterkey') = 0,
  'ALTER TABLE fact_sales_lines ADD INDEX ix_fact_sales_lines_productmasterkey (ProductMasterKey)', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines' AND COLUMN_NAME = 'ProductTemplateID') = 1,
  'ALTER TABLE shd_fact_sales_lines DROP COLUMN ProductTemplateID', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines' AND COLUMN_NAME = 'IsMappedProduct') = 0,
  'ALTER TABLE shd_fact_sales_lines ADD COLUMN `IsMappedProduct` TINYINT(1) NULL', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines' AND COLUMN_NAME = 'ProductMatchKey') = 0,
  'ALTER TABLE shd_fact_sales_lines ADD COLUMN `ProductMatchKey` VARCHAR(255) NULL', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines' AND COLUMN_NAME = 'ProductMappingReason') = 0,
  'ALTER TABLE shd_fact_sales_lines ADD COLUMN `ProductMappingReason` TEXT NULL', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines' AND COLUMN_NAME = 'ProductMappingStatus') = 0,
  'ALTER TABLE shd_fact_sales_lines ADD COLUMN `ProductMappingStatus` TEXT NULL', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines' AND COLUMN_NAME = 'ProductNameClean') = 0,
  'ALTER TABLE shd_fact_sales_lines ADD COLUMN `ProductNameClean` TEXT NULL', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines' AND COLUMN_NAME = 'ProductNameRaw') = 0,
  'ALTER TABLE shd_fact_sales_lines ADD COLUMN `ProductNameRaw` TEXT NULL', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines' AND COLUMN_NAME = 'product_name') = 0,
  'ALTER TABLE shd_fact_sales_lines ADD COLUMN `product_name` TEXT NULL', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines' AND COLUMN_NAME = 'product_name_clean') = 0,
  'ALTER TABLE shd_fact_sales_lines ADD COLUMN `product_name_clean` TEXT NULL', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines' AND COLUMN_NAME = 'product_name_raw') = 0,
  'ALTER TABLE shd_fact_sales_lines ADD COLUMN `product_name_raw` TEXT NULL', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines' AND COLUMN_NAME = 'ProductLevel') = 0,
  'ALTER TABLE shd_fact_sales_lines ADD COLUMN `ProductLevel` TEXT NULL', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines' AND COLUMN_NAME = 'ProductJoinKey') = 0,
  'ALTER TABLE shd_fact_sales_lines ADD COLUMN `ProductJoinKey` VARCHAR(255) NULL', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines' AND COLUMN_NAME = 'OdooProductNameClean') = 0,
  'ALTER TABLE shd_fact_sales_lines ADD COLUMN `OdooProductNameClean` TEXT NULL', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines' AND COLUMN_NAME = 'ProductMasterKey') = 0,
  'ALTER TABLE shd_fact_sales_lines ADD COLUMN ProductMasterKey VARCHAR(191) NOT NULL DEFAULT ''-1''', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines' AND INDEX_NAME = 'ix_fact_sales_lines_productmasterkey') = 0,
  'ALTER TABLE shd_fact_sales_lines ADD INDEX ix_fact_sales_lines_productmasterkey (ProductMasterKey)', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

DROP TABLE IF EXISTS shd_fact_sales_product_daily;
DROP TABLE IF EXISTS fact_sales_product_daily;
CREATE TABLE IF NOT EXISTS fact_sales_product_daily (
    `Company` TEXT NULL,
    CompanyKey BIGINT NOT NULL DEFAULT -1,
    `ProductMatchKey` VARCHAR(255) NULL,
    `OrderDate` DATE NULL,
    DateKey INT NOT NULL DEFAULT -1,
    SalespersonKey INT NOT NULL DEFAULT -1,
    SegmentKey INT NOT NULL DEFAULT -1,
    ChannelKey INT NOT NULL DEFAULT -1,
    SalesTeamKey VARCHAR(64) NOT NULL DEFAULT '-1',
    `IsIntercompany` TINYINT(1) NULL,
    `IsMappedProduct` TINYINT(1) NULL,
    `UoM` TEXT NULL,
    `Value` DECIMAL(20,6) NULL,
    `Qty` DECIMAL(20,6) NULL,
    `QtyOrdered` DECIMAL(20,6) NULL,
    `QtyDelivered` DECIMAL(20,6) NULL,
    `CostValue` DECIMAL(20,6) NULL,
    `CostedQty` DECIMAL(20,6) NULL,
    `UncostedQty` DECIMAL(20,6) NULL,
    `Lines` BIGINT NULL,
    row_key CHAR(40) NOT NULL COMMENT 'sha1 of the grain (date, company, product match key, salesperson, team, channel, segment, intercompany, uom)',
    _run_id CHAR(36) NULL COMMENT 'etl_run_log.run_uid of the load',
    PRIMARY KEY (row_key),
    INDEX ix_fact_sales_product_daily_datekey (DateKey),
    INDEX ix_fact_sales_product_daily_companykey (CompanyKey),
    INDEX ix_fact_sales_product_daily_salespersonkey (SalespersonKey),
    INDEX ix_fact_sales_product_daily_salesteamkey (SalesTeamKey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE shd_fact_sales_product_daily LIKE fact_sales_product_daily;

DROP TABLE IF EXISTS shd_fact_sales_inventory_snapshot;
DROP TABLE IF EXISTS fact_sales_inventory_snapshot;
CREATE TABLE IF NOT EXISTS fact_sales_inventory_snapshot (
    `SnapshotDate` DATE NULL,
    SnapshotDateKey INT NOT NULL,
    `Company` TEXT NULL,
    CompanyKey BIGINT NOT NULL DEFAULT -1,
    ProductMasterKey VARCHAR(191) NOT NULL DEFAULT '-1',
    `ProductName` TEXT NULL,
    `ProductNameClean` TEXT NULL,
    `OdooProductID` BIGINT NULL,
    `OdooProductName` TEXT NULL,
    `OdooProductNameClean` TEXT NULL,
    `SKU` TEXT NULL,
    LocationID BIGINT NOT NULL,
    `LocationName` TEXT NULL,
    `WarehouseName` TEXT NULL,
    `OnHandQty` DECIMAL(20,6) NULL,
    `ReservedQty` DECIMAL(20,6) NULL,
    `AvailableQty` DECIMAL(20,6) NULL,
    `ProductCost` DECIMAL(20,6) NULL,
    `InventoryValue` DECIMAL(20,6) NULL,
    `InventoryStatus` TEXT NULL,
    `DOH` DECIMAL(20,6) NULL,
    `Avg_Daily_Sales` DECIMAL(20,6) NULL,
    `Velocity_Class` TEXT NULL,
    `ProductMatchKey` VARCHAR(255) NULL,
    `StockClass` TEXT NULL,
    ProductKey BIGINT NOT NULL DEFAULT -1,
    _run_id CHAR(36) NULL COMMENT 'etl_run_log.run_uid of the load',
    PRIMARY KEY (SnapshotDateKey, CompanyKey, ProductKey, LocationID)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE shd_fact_sales_inventory_snapshot LIKE fact_sales_inventory_snapshot;

DROP TABLE IF EXISTS shd_fact_sales_bcg_matrix;
DROP TABLE IF EXISTS fact_sales_bcg_matrix;
CREATE TABLE IF NOT EXISTS fact_sales_bcg_matrix (
    `Company` TEXT NULL,
    ProductMasterKey VARCHAR(191) NOT NULL DEFAULT '-1',
    `ProductName` TEXT NULL,
    `ProductNameClean` TEXT NULL,
    `total_quantity_YTD` DECIMAL(20,6) NULL,
    `total_quantity_LYTD` DECIMAL(20,6) NULL,
    `total_value_YTD` DECIMAL(20,6) NULL,
    `total_value_LYTD` DECIMAL(20,6) NULL,
    `avg_unit_price_YTD` DECIMAL(20,6) NULL,
    `avg_unit_price_LYTD` DECIMAL(20,6) NULL,
    `avg_product_cost_YTD` DECIMAL(20,6) NULL,
    `avg_product_cost_LYTD` DECIMAL(20,6) NULL,
    `perc_gross_profit_YTD` DECIMAL(20,6) NULL,
    `perc_gross_profit_LYTD` DECIMAL(20,6) NULL,
    `volume_class_YTD` TEXT NULL,
    `volume_class_LYTD` TEXT NULL,
    `profit_class_YTD` TEXT NULL,
    `profit_class_LYTD` TEXT NULL,
    `bcg_code_YTD` TEXT NULL,
    `bcg_code_LYTD` TEXT NULL,
    `bcg_class_YTD` TEXT NULL,
    `bcg_class_LYTD` TEXT NULL,
    `quantity_growth_pct` DECIMAL(20,6) NULL,
    `gross_profit_change_pp` DECIMAL(20,6) NULL,
    `bcg_movement` TEXT NULL,
    CompanyKey BIGINT NOT NULL DEFAULT -1,
    ProductKey BIGINT NOT NULL DEFAULT -1 COMMENT 'Odoo product id for a product with no PRODUCTS.xlsx row, else -1',
    _run_id CHAR(36) NULL COMMENT 'etl_run_log.run_uid of the load',
    PRIMARY KEY (CompanyKey, ProductMasterKey, ProductKey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE shd_fact_sales_bcg_matrix LIKE fact_sales_bcg_matrix;

DROP TABLE IF EXISTS shd_dim_sales_product_cost;
DROP TABLE IF EXISTS dim_sales_product_cost;
CREATE TABLE IF NOT EXISTS dim_sales_product_cost (
    `OdooProductID` BIGINT NULL,
    `OdooProductTemplateID` BIGINT NULL,
    `Company` TEXT NULL,
    ProductMasterKey VARCHAR(191) NOT NULL DEFAULT '-1',
    `ProductNameRaw` TEXT NULL,
    `ProductName` TEXT NULL,
    `ProductNameClean` TEXT NULL,
    `OdooProductName` TEXT NULL,
    `OdooProductNameClean` TEXT NULL,
    `SKU` TEXT NULL,
    `ProductCost` DECIMAL(20,6) NULL,
    `IsActive` TINYINT(1) NULL,
    ProductKey BIGINT NOT NULL DEFAULT -1,
    CompanyKey BIGINT NOT NULL DEFAULT -1,
    _run_id CHAR(36) NULL COMMENT 'etl_run_log.run_uid of the load',
    PRIMARY KEY (ProductKey, CompanyKey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE shd_dim_sales_product_cost LIKE dim_sales_product_cost;

DROP TABLE IF EXISTS shd_dim_sales_product_dashboard;
DROP TABLE IF EXISTS dim_sales_product_dashboard;
CREATE TABLE IF NOT EXISTS dim_sales_product_dashboard (
    ProductMatchKey VARCHAR(600) NOT NULL,
    `Company` TEXT NULL,
    ProductMasterKey VARCHAR(191) NOT NULL DEFAULT '-1',
    `SheetProductKey` VARCHAR(255) NULL,
    `ProductName` TEXT NULL,
    `OdooProductName` TEXT NULL,
    `Category` TEXT NULL,
    `Brand` TEXT NULL,
    `SubBrand` TEXT NULL,
    `Family` TEXT NULL,
    `Size` TEXT NULL,
    `SKU` TEXT NULL,
    `ProductLevel` TEXT NULL,
    `IsActive` TINYINT(1) NULL,
    `IsMapped` TINYINT(1) NULL,
    `ProductGroupKey` VARCHAR(255) NULL,
    `ThresholdCompany` TEXT NULL,
    `FirstSaleDate` DATE NULL,
    `LastSaleDate` DATE NULL,
    `UoM` TEXT NULL,
    `UoMCount` BIGINT NULL,
    `UoMList` TEXT NULL,
    `QtyLookback` DECIMAL(20,6) NULL,
    `AvgDailySales` DECIMAL(20,6) NULL,
    `StockQty` DECIMAL(20,6) NULL,
    `StockValue` DECIMAL(20,6) NULL,
    `InTransitQty` DECIMAL(20,6) NULL,
    `InTransitValue` DECIMAL(20,6) NULL,
    `NegativeStockRows` BIGINT NULL,
    `NegativeStockQty` DECIMAL(20,6) NULL,
    `DaysOfInventory` DECIMAL(20,6) NULL,
    `StockBand` TEXT NULL,
    `LifecycleSegment` TEXT NULL,
    `ValueYTD` DECIMAL(20,6) NULL,
    `QtyYTD` DECIMAL(20,6) NULL,
    `GrossProfitPctYTD` DECIMAL(20,6) NULL,
    `BcgClassYTD` TEXT NULL,
    `NoCostYTD` TINYINT(1) NULL,
    `ValueLYTD` DECIMAL(20,6) NULL,
    `QtyLYTD` DECIMAL(20,6) NULL,
    `GrossProfitPctLYTD` DECIMAL(20,6) NULL,
    `BcgClassLYTD` TEXT NULL,
    `NoCostLYTD` TINYINT(1) NULL,
    `BcgExcludedCategory` TINYINT(1) NULL,
    `BcgMovement` TEXT NULL,
    `AsOfDate` DATE NULL,
    CompanyKey BIGINT NOT NULL DEFAULT -1,
    _run_id CHAR(36) NULL COMMENT 'etl_run_log.run_uid of the load',
    PRIMARY KEY (ProductMatchKey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE shd_dim_sales_product_dashboard LIKE dim_sales_product_dashboard;

DROP TABLE IF EXISTS shd_dim_sales_product_group;
DROP TABLE IF EXISTS dim_sales_product_group;
CREATE TABLE IF NOT EXISTS dim_sales_product_group (
    ProductGroupKey VARCHAR(600) NOT NULL,
    `Companies` TEXT NULL,
    `CompanyCount` BIGINT NULL,
    `ThresholdCompany` TEXT NULL,
    `MemberKeys` TEXT NULL,
    `IsMapped` TINYINT(1) NULL,
    `IsActive` TINYINT(1) NULL,
    ProductMasterKey VARCHAR(191) NOT NULL DEFAULT '-1',
    `SheetProductKey` VARCHAR(255) NULL,
    `ProductName` TEXT NULL,
    `OdooProductName` TEXT NULL,
    `Category` TEXT NULL,
    `Brand` TEXT NULL,
    `SubBrand` TEXT NULL,
    `Family` TEXT NULL,
    `Size` TEXT NULL,
    `SKU` TEXT NULL,
    `ProductLevel` TEXT NULL,
    `Company` TEXT NULL,
    `FirstSaleDate` DATE NULL,
    `LastSaleDate` DATE NULL,
    `UoM` TEXT NULL,
    `UoMCount` BIGINT NULL,
    `UoMList` TEXT NULL,
    `QtyLookback` DECIMAL(20,6) NULL,
    `AvgDailySales` DECIMAL(20,6) NULL,
    `StockQty` DECIMAL(20,6) NULL,
    `StockValue` DECIMAL(20,6) NULL,
    `InTransitQty` DECIMAL(20,6) NULL,
    `InTransitValue` DECIMAL(20,6) NULL,
    `NegativeStockRows` BIGINT NULL,
    `NegativeStockQty` DECIMAL(20,6) NULL,
    `DaysOfInventory` DECIMAL(20,6) NULL,
    `StockBand` TEXT NULL,
    `LifecycleSegment` TEXT NULL,
    `ValueYTD` DECIMAL(20,6) NULL,
    `QtyYTD` DECIMAL(20,6) NULL,
    `GrossProfitPctYTD` DECIMAL(20,6) NULL,
    `BcgClassYTD` TEXT NULL,
    `NoCostYTD` TINYINT(1) NULL,
    `ValueLYTD` DECIMAL(20,6) NULL,
    `QtyLYTD` DECIMAL(20,6) NULL,
    `GrossProfitPctLYTD` DECIMAL(20,6) NULL,
    `BcgClassLYTD` TEXT NULL,
    `NoCostLYTD` TINYINT(1) NULL,
    `BcgExcludedCategory` TINYINT(1) NULL,
    `BcgMovement` TEXT NULL,
    `AsOfDate` DATE NULL,
    _run_id CHAR(36) NULL COMMENT 'etl_run_log.run_uid of the load',
    PRIMARY KEY (ProductGroupKey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE shd_dim_sales_product_group LIKE dim_sales_product_group;

DROP TABLE IF EXISTS shd_etl_sales_product_dashboard_meta;
DROP TABLE IF EXISTS etl_sales_product_dashboard_meta;
CREATE TABLE IF NOT EXISTS etl_sales_product_dashboard_meta (
    AsOfDate DATE NOT NULL,
    `BuiltAtUtc` DATETIME NULL,
    `ConfigFingerprint` TEXT NULL,
    `ConfigJson` TEXT NULL,
    `LookbackDays` BIGINT NULL,
    `SalesLinesValue` DECIMAL(20,6) NULL,
    `SalesLinesQty` DECIMAL(20,6) NULL,
    `SalesLinesCount` BIGINT NULL,
    `DailyValue` DECIMAL(20,6) NULL,
    `UnmappedValue` DECIMAL(20,6) NULL,
    `MasterProducts` BIGINT NULL,
    `UnmappedProducts` BIGINT NULL,
    _run_id CHAR(36) NULL COMMENT 'etl_run_log.run_uid of the load',
    PRIMARY KEY (AsOfDate)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE shd_etl_sales_product_dashboard_meta LIKE etl_sales_product_dashboard_meta;

CREATE OR REPLACE VIEW v_sales_lines AS SELECT * FROM fact_sales_lines;

CREATE OR REPLACE VIEW v_sales_product_daily AS SELECT * FROM fact_sales_product_daily;

CREATE OR REPLACE VIEW v_sales_inventory AS SELECT * FROM fact_sales_inventory_snapshot;

CREATE OR REPLACE VIEW v_sales_bcg_matrix AS SELECT * FROM fact_sales_bcg_matrix;

CREATE OR REPLACE VIEW v_sales_product_dashboard AS SELECT * FROM dim_sales_product_dashboard;
