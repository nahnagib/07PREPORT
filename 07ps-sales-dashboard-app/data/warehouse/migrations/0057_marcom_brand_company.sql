-- 0057: MARCOM brand -> company link (2026-10-26). MARCOM data is uploaded per BRAND; the report pages now also filter
-- and group by COMPANY (Company filter, "By Company" view of Budget utilization / Brand growth).
--
-- company_key holds the raw Dim_Company.CompanyKey (= admin_company.etl_company_key) -- same convention as 0019's
-- company_key_override: reference the raw ETL key, never admin_company.company_id. No FK (Dim_Company has no enforced key);
-- existence is validated in application code (backend/src/marcom/brandCompany.ts) before every write.
-- NULL = not assigned yet; such brands show as "Unassigned" in the By Company views and are excluded when a company is
-- selected in the filter. Set by an admin on /admin/marcom-upload ("Brand -> Company").
--
-- Idempotent (column/index added only when missing; prepared statements, no DELIMITER, for apply_migrations.py).
-- Reverse: data/warehouse/down/0057_marcom_brand_company_down.sql.

SET NAMES utf8mb4;

SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE marcom_brand ADD COLUMN company_key BIGINT NULL AFTER name', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_brand' AND COLUMN_NAME = 'company_key');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) = 0, 'CREATE INDEX idx_marcom_brand_company ON marcom_brand (company_key)', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_brand' AND INDEX_NAME = 'idx_marcom_brand_company');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
