-- 0082: Product Development Plan tracker -- Brand (Product_Development_Input.xlsx, Products sheet, column "Brand").
--
--   pdt_product  + brand: free text from the Excel file, trimmed; a blank cell (or a file without the column) is
--                'Unassigned'. The dashboard's Brand filter lists the brands in use.
--
-- Idempotent: the ALTER checks information_schema first.
-- Reverse: data/warehouse/down/0082_pdt_brand_down.sql.

SET NAMES utf8mb4;

SET @stmt = (SELECT IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pdt_product' AND COLUMN_NAME = 'brand'),
  'DO 0',
  'ALTER TABLE pdt_product ADD COLUMN brand VARCHAR(100) NOT NULL DEFAULT ''Unassigned'' AFTER subfamily, ADD INDEX idx_pdt_product_brand (brand)'));
PREPARE st FROM @stmt; EXECUTE st; DEALLOCATE PREPARE st;
