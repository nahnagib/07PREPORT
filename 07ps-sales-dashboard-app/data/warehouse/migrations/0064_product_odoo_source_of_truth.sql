-- 0064: Odoo is the only source of products (2026-11-03). PRODUCTS.xlsx and every product-name rule are retired.
--
-- Product identity = the Odoo product.product id (ProductKey) with its product_tmpl_id and company; nothing is matched on
-- a product name any more. Product attributes come from Odoo as stored ('Unassigned' where Odoo has none):
--   Category = categ_id (full path)   Brand = manufacturer_id   SubBrand = sub_brand_id   Family = product_family_id
--   Size = size_dimensions_id         SKU = default_code         IsActive = active
--
-- 1. The sheet tables are kept one release as *_deprecated (nothing reads them; drop them in the next release):
--      raw_excel_products, dim_product_master, map_product_master, qa_productunmapped, qa_productdataquality
-- 2. raw_odoo_product_product + brand, sub_brand, family, size; dim_product + categ_id, brand, sub_brand, family, size.
-- 3. fact_sales_lines (+ shd_): the sheet key and every cleaned-name / mapping column are dropped; + ProductTemplateID.
-- 4. The product marts (product daily, inventory snapshot, BCG, product cost, product dashboard / group / meta, + their
--    shd_ copies) are rebuilt by every ETL run, so they are re-created with the new keys:
--      product daily / inventory / dashboard  ProductMatchKey (Company + normalized name) -> ProductCompanyKey (Company|id)
--      BCG                                    PK (CompanyKey, ProductMasterKey, ProductKey) -> (CompanyKey, ProductKey)
--      dashboard group (BMH view)             ProductGroupKey = 'T|<product_tmpl_id>' (was the sheet's ProductName)
--    They are EMPTY until the next ETL run: run the full refresh right after this migration.
-- 5. The SELECT * views over the changed tables are re-created (MySQL expands * when a view is created).
--
-- Apply BEFORE deploying the ETL that writes these columns, then run the full refresh. Back up first (mysqldump).
-- Idempotent (prepared statements, no DELIMITER, for apply_migrations.py). Reverse: down/0064_product_odoo_source_of_truth_down.sql.

SET NAMES utf8mb4;

-- 1. retired sheet tables -> *_deprecated -------------------------------------------------------------------------------

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'raw_excel_products') = 1
    AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'raw_excel_products_deprecated') = 0,
  'RENAME TABLE raw_excel_products TO raw_excel_products_deprecated', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_product_master') = 1
    AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_product_master_deprecated') = 0,
  'RENAME TABLE dim_product_master TO dim_product_master_deprecated', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'map_product_master') = 1
    AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'map_product_master_deprecated') = 0,
  'RENAME TABLE map_product_master TO map_product_master_deprecated', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'qa_productunmapped') = 1
    AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'qa_productunmapped_deprecated') = 0,
  'RENAME TABLE qa_productunmapped TO qa_productunmapped_deprecated', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'qa_productdataquality') = 1
    AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'qa_productdataquality_deprecated') = 0,
  'RENAME TABLE qa_productdataquality TO qa_productdataquality_deprecated', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;


-- 2. Odoo product attributes ---------------------------------------------------------------------------------------------

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'raw_odoo_product_product') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'raw_odoo_product_product' AND COLUMN_NAME = 'brand') = 0,
  'ALTER TABLE raw_odoo_product_product ADD COLUMN brand VARCHAR(512) NULL COMMENT ''display name of manufacturer_id''', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'raw_odoo_product_product') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'raw_odoo_product_product' AND COLUMN_NAME = 'sub_brand') = 0,
  'ALTER TABLE raw_odoo_product_product ADD COLUMN sub_brand VARCHAR(512) NULL COMMENT ''display name of sub_brand_id''', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'raw_odoo_product_product') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'raw_odoo_product_product' AND COLUMN_NAME = 'family') = 0,
  'ALTER TABLE raw_odoo_product_product ADD COLUMN family VARCHAR(512) NULL COMMENT ''display name of product_family_id''', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'raw_odoo_product_product') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'raw_odoo_product_product' AND COLUMN_NAME = 'size') = 0,
  'ALTER TABLE raw_odoo_product_product ADD COLUMN size VARCHAR(512) NULL COMMENT ''display name of size_dimensions_id''', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_product') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_product' AND COLUMN_NAME = 'categ_id') = 0,
  'ALTER TABLE dim_product ADD COLUMN categ_id BIGINT NULL COMMENT ''Odoo product.category id'' AFTER CompanyKey', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_product') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_product' AND COLUMN_NAME = 'brand') = 0,
  'ALTER TABLE dim_product ADD COLUMN brand VARCHAR(512) NULL COMMENT ''Odoo value as stored; Unassigned when empty'' AFTER category', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_product') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_product' AND COLUMN_NAME = 'sub_brand') = 0,
  'ALTER TABLE dim_product ADD COLUMN sub_brand VARCHAR(512) NULL COMMENT ''Odoo value as stored; Unassigned when empty'' AFTER brand', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_product') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_product' AND COLUMN_NAME = 'family') = 0,
  'ALTER TABLE dim_product ADD COLUMN family VARCHAR(512) NULL COMMENT ''Odoo value as stored; Unassigned when empty'' AFTER sub_brand', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_product') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_product' AND COLUMN_NAME = 'size') = 0,
  'ALTER TABLE dim_product ADD COLUMN size VARCHAR(512) NULL COMMENT ''Odoo value as stored; Unassigned when empty'' AFTER family', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;


-- 3. fact_sales_lines (+ shadow): Odoo product columns only -----------------------------------------------------------------

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND INDEX_NAME = 'ix_fact_sales_lines_productmasterkey') > 0,
  'ALTER TABLE fact_sales_lines DROP INDEX ix_fact_sales_lines_productmasterkey', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND COLUMN_NAME = 'ProductMasterKey') = 1,
  'ALTER TABLE fact_sales_lines DROP COLUMN `ProductMasterKey`', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND COLUMN_NAME = 'OdooProductNameClean') = 1,
  'ALTER TABLE fact_sales_lines DROP COLUMN `OdooProductNameClean`', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND COLUMN_NAME = 'ProductJoinKey') = 1,
  'ALTER TABLE fact_sales_lines DROP COLUMN `ProductJoinKey`', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND COLUMN_NAME = 'ProductLevel') = 1,
  'ALTER TABLE fact_sales_lines DROP COLUMN `ProductLevel`', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND COLUMN_NAME = 'product_name_raw') = 1,
  'ALTER TABLE fact_sales_lines DROP COLUMN `product_name_raw`', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND COLUMN_NAME = 'product_name_clean') = 1,
  'ALTER TABLE fact_sales_lines DROP COLUMN `product_name_clean`', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND COLUMN_NAME = 'product_name') = 1,
  'ALTER TABLE fact_sales_lines DROP COLUMN `product_name`', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND COLUMN_NAME = 'ProductNameRaw') = 1,
  'ALTER TABLE fact_sales_lines DROP COLUMN `ProductNameRaw`', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND COLUMN_NAME = 'ProductNameClean') = 1,
  'ALTER TABLE fact_sales_lines DROP COLUMN `ProductNameClean`', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND COLUMN_NAME = 'ProductMappingStatus') = 1,
  'ALTER TABLE fact_sales_lines DROP COLUMN `ProductMappingStatus`', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND COLUMN_NAME = 'ProductMappingReason') = 1,
  'ALTER TABLE fact_sales_lines DROP COLUMN `ProductMappingReason`', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND COLUMN_NAME = 'ProductMatchKey') = 1,
  'ALTER TABLE fact_sales_lines DROP COLUMN `ProductMatchKey`', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND COLUMN_NAME = 'IsMappedProduct') = 1,
  'ALTER TABLE fact_sales_lines DROP COLUMN `IsMappedProduct`', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND COLUMN_NAME = 'ProductTemplateID') = 0,
  'ALTER TABLE fact_sales_lines ADD COLUMN ProductTemplateID BIGINT NULL COMMENT ''Odoo product_tmpl_id'' AFTER OdooProductID', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines' AND INDEX_NAME = 'ix_fact_sales_lines_productmasterkey') > 0,
  'ALTER TABLE shd_fact_sales_lines DROP INDEX ix_fact_sales_lines_productmasterkey', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines' AND COLUMN_NAME = 'ProductMasterKey') = 1,
  'ALTER TABLE shd_fact_sales_lines DROP COLUMN `ProductMasterKey`', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines' AND COLUMN_NAME = 'OdooProductNameClean') = 1,
  'ALTER TABLE shd_fact_sales_lines DROP COLUMN `OdooProductNameClean`', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines' AND COLUMN_NAME = 'ProductJoinKey') = 1,
  'ALTER TABLE shd_fact_sales_lines DROP COLUMN `ProductJoinKey`', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines' AND COLUMN_NAME = 'ProductLevel') = 1,
  'ALTER TABLE shd_fact_sales_lines DROP COLUMN `ProductLevel`', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines' AND COLUMN_NAME = 'product_name_raw') = 1,
  'ALTER TABLE shd_fact_sales_lines DROP COLUMN `product_name_raw`', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines' AND COLUMN_NAME = 'product_name_clean') = 1,
  'ALTER TABLE shd_fact_sales_lines DROP COLUMN `product_name_clean`', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines' AND COLUMN_NAME = 'product_name') = 1,
  'ALTER TABLE shd_fact_sales_lines DROP COLUMN `product_name`', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines' AND COLUMN_NAME = 'ProductNameRaw') = 1,
  'ALTER TABLE shd_fact_sales_lines DROP COLUMN `ProductNameRaw`', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines' AND COLUMN_NAME = 'ProductNameClean') = 1,
  'ALTER TABLE shd_fact_sales_lines DROP COLUMN `ProductNameClean`', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines' AND COLUMN_NAME = 'ProductMappingStatus') = 1,
  'ALTER TABLE shd_fact_sales_lines DROP COLUMN `ProductMappingStatus`', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines' AND COLUMN_NAME = 'ProductMappingReason') = 1,
  'ALTER TABLE shd_fact_sales_lines DROP COLUMN `ProductMappingReason`', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines' AND COLUMN_NAME = 'ProductMatchKey') = 1,
  'ALTER TABLE shd_fact_sales_lines DROP COLUMN `ProductMatchKey`', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines' AND COLUMN_NAME = 'IsMappedProduct') = 1,
  'ALTER TABLE shd_fact_sales_lines DROP COLUMN `IsMappedProduct`', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_lines' AND COLUMN_NAME = 'ProductTemplateID') = 0,
  'ALTER TABLE shd_fact_sales_lines ADD COLUMN ProductTemplateID BIGINT NULL COMMENT ''Odoo product_tmpl_id'' AFTER OdooProductID', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;


-- 4. product marts (rebuilt by every ETL run) with the Odoo-id keys --------------------------------------------------------

DROP TABLE IF EXISTS shd_fact_sales_product_daily;
DROP TABLE IF EXISTS fact_sales_product_daily;
CREATE TABLE IF NOT EXISTS fact_sales_product_daily (
    `Company` TEXT NULL,
    CompanyKey BIGINT NOT NULL DEFAULT -1,
    `ProductCompanyKey` VARCHAR(255) NULL COMMENT 'Company|Odoo product id (sales_pipeline.odoo_products)',
    ProductKey BIGINT NOT NULL DEFAULT -1 COMMENT 'Odoo product.product id',
    `OrderDate` DATE NULL,
    DateKey INT NOT NULL DEFAULT -1,
    SalespersonKey INT NOT NULL DEFAULT -1,
    SegmentKey INT NOT NULL DEFAULT -1,
    ChannelKey INT NOT NULL DEFAULT -1,
    SalesTeamKey VARCHAR(64) NOT NULL DEFAULT '-1',
    `IsIntercompany` TINYINT(1) NULL,
    `UoM` TEXT NULL,
    `Value` DECIMAL(20,6) NULL,
    `Qty` DECIMAL(20,6) NULL,
    `QtyOrdered` DECIMAL(20,6) NULL,
    `QtyDelivered` DECIMAL(20,6) NULL,
    `CostValue` DECIMAL(20,6) NULL,
    `CostedQty` DECIMAL(20,6) NULL,
    `UncostedQty` DECIMAL(20,6) NULL,
    `Lines` BIGINT NULL,
    row_key CHAR(40) NOT NULL COMMENT 'sha1 of the grain (date, company, Odoo product id, salesperson, team, channel, segment, intercompany, uom)',
    _run_id CHAR(36) NULL COMMENT 'etl_run_log.run_uid of the load',
    PRIMARY KEY (row_key),
    INDEX ix_fact_sales_product_daily_datekey (DateKey),
    INDEX ix_fact_sales_product_daily_companykey (CompanyKey),
    INDEX ix_fact_sales_product_daily_salespersonkey (SalespersonKey),
    INDEX ix_fact_sales_product_daily_salesteamkey (SalesTeamKey),
    INDEX ix_fact_sales_product_daily_productkey (ProductKey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE shd_fact_sales_product_daily LIKE fact_sales_product_daily;

DROP TABLE IF EXISTS shd_fact_sales_inventory_snapshot;
DROP TABLE IF EXISTS fact_sales_inventory_snapshot;
CREATE TABLE IF NOT EXISTS fact_sales_inventory_snapshot (
    `SnapshotDate` DATE NULL,
    SnapshotDateKey INT NOT NULL,
    `Company` TEXT NULL,
    CompanyKey BIGINT NOT NULL DEFAULT -1,
    `ProductName` TEXT NULL,
    `OdooProductID` BIGINT NULL,
    `OdooProductName` TEXT NULL,
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
    `ProductCompanyKey` VARCHAR(255) NULL COMMENT 'Company|Odoo product id',
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
    `ProductName` TEXT NULL,
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
    ProductKey BIGINT NOT NULL DEFAULT -1 COMMENT 'Odoo product.product id (-1 = lines without a product)',
    _run_id CHAR(36) NULL COMMENT 'etl_run_log.run_uid of the load',
    PRIMARY KEY (CompanyKey, ProductKey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE shd_fact_sales_bcg_matrix LIKE fact_sales_bcg_matrix;

DROP TABLE IF EXISTS shd_dim_sales_product_cost;
DROP TABLE IF EXISTS dim_sales_product_cost;
CREATE TABLE IF NOT EXISTS dim_sales_product_cost (
    `OdooProductID` BIGINT NULL,
    `OdooProductTemplateID` BIGINT NULL,
    `Company` TEXT NULL,
    `ProductName` TEXT NULL,
    `OdooProductName` TEXT NULL,
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
    ProductCompanyKey VARCHAR(600) NOT NULL COMMENT 'Company|Odoo product id',
    `Company` TEXT NULL,
    `ProductKey` BIGINT NOT NULL DEFAULT -1 COMMENT 'Odoo product.product id',
    `ProductTemplateID` BIGINT NULL COMMENT 'Odoo product_tmpl_id',
    `ProductName` TEXT NULL,
    `OdooProductName` TEXT NULL,
    `Category` TEXT NULL,
    `CategoryID` BIGINT NULL COMMENT 'Odoo categ_id (BCG exclusion)',
    `Brand` TEXT NULL,
    `SubBrand` TEXT NULL,
    `Family` TEXT NULL,
    `Size` TEXT NULL,
    `SKU` TEXT NULL,
    `IsActive` TINYINT(1) NULL,
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
    PRIMARY KEY (ProductCompanyKey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE shd_dim_sales_product_dashboard LIKE dim_sales_product_dashboard;

DROP TABLE IF EXISTS shd_dim_sales_product_group;
DROP TABLE IF EXISTS dim_sales_product_group;
CREATE TABLE IF NOT EXISTS dim_sales_product_group (
    ProductGroupKey VARCHAR(600) NOT NULL COMMENT 'T|<Odoo product_tmpl_id>',
    `Companies` TEXT NULL,
    `CompanyCount` BIGINT NULL,
    `ThresholdCompany` TEXT NULL,
    `MemberKeys` TEXT NULL,
    `IsActive` TINYINT(1) NULL,
    `ProductKey` BIGINT NULL COMMENT 'Odoo product.product id',
    `ProductTemplateID` BIGINT NULL COMMENT 'Odoo product_tmpl_id',
    `ProductName` TEXT NULL,
    `OdooProductName` TEXT NULL,
    `Category` TEXT NULL,
    `CategoryID` BIGINT NULL COMMENT 'Odoo categ_id (BCG exclusion)',
    `Brand` TEXT NULL,
    `SubBrand` TEXT NULL,
    `Family` TEXT NULL,
    `Size` TEXT NULL,
    `SKU` TEXT NULL,
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
    `Products` BIGINT NULL,
    `UnassignedBrandProducts` BIGINT NULL,
    `UnassignedCategoryProducts` BIGINT NULL,
    _run_id CHAR(36) NULL COMMENT 'etl_run_log.run_uid of the load',
    PRIMARY KEY (AsOfDate)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE shd_etl_sales_product_dashboard_meta LIKE etl_sales_product_dashboard_meta;


-- 5. serving views ------------------------------------------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_sales_lines AS SELECT * FROM fact_sales_lines;

CREATE OR REPLACE VIEW v_sales_product_daily AS SELECT * FROM fact_sales_product_daily;

CREATE OR REPLACE VIEW v_sales_inventory AS SELECT * FROM fact_sales_inventory_snapshot;

CREATE OR REPLACE VIEW v_sales_bcg_matrix AS SELECT * FROM fact_sales_bcg_matrix;

CREATE OR REPLACE VIEW v_sales_product_dashboard AS SELECT * FROM dim_sales_product_dashboard;
