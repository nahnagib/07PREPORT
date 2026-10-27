-- Reverse of 0057_marcom_brand_company.sql: drops the brand -> company link.
SET NAMES utf8mb4;

SET @s = (SELECT IF(COUNT(*) > 0, 'DROP INDEX idx_marcom_brand_company ON marcom_brand', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_brand' AND INDEX_NAME = 'idx_marcom_brand_company');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE marcom_brand DROP COLUMN company_key', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_brand' AND COLUMN_NAME = 'company_key');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
