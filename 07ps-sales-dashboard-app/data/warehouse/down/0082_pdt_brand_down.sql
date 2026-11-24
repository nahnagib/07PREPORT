-- Reverses 0082_pdt_brand.sql: drops pdt_product.brand. Roll the backend back first.

SET NAMES utf8mb4;

SET @stmt = (SELECT IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pdt_product' AND COLUMN_NAME = 'brand'),
  'ALTER TABLE pdt_product DROP INDEX idx_pdt_product_brand, DROP COLUMN brand', 'DO 0'));
PREPARE st FROM @stmt; EXECUTE st; DEALLOCATE PREPARE st;
