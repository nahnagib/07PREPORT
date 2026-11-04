-- Reverse of 0065: the cross-company group table and the ProductGroupKey column come back (empty until the previous
-- release's ETL runs). Idempotent.

SET NAMES utf8mb4;

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

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_sales_product_dashboard' AND COLUMN_NAME = 'ProductGroupKey') = 0,
  'ALTER TABLE dim_sales_product_dashboard ADD COLUMN ProductGroupKey VARCHAR(255) NULL AFTER IsActive', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_dim_sales_product_dashboard' AND COLUMN_NAME = 'ProductGroupKey') = 0,
  'ALTER TABLE shd_dim_sales_product_dashboard ADD COLUMN ProductGroupKey VARCHAR(255) NULL AFTER IsActive', 'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

CREATE OR REPLACE VIEW v_sales_product_dashboard AS SELECT * FROM dim_sales_product_dashboard;
