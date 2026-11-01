-- Reverse of 0061_marcom_brand_split_other_spend.sql. Only safe BEFORE any template 2.0 upload:
--  - branded social/web rows would collide on the old (year, month[, platform]) unique keys -> remove those batches first;
--  - marcom_other_spend and the new revenue columns are dropped (their data is lost);
--  - the old NOT NULL spend / company revenue columns are restored from finance_booked_total / legacy_* (rows where those
--    are NULL get 0).
-- The BMH brand row is kept (it may be referenced); only its kind column goes.
SET NAMES utf8mb4;

DROP TABLE IF EXISTS marcom_other_spend;
DROP TABLE IF EXISTS marcom_spend_category;

-- social
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE marcom_social_monthly DROP INDEX uq_marcom_social_brand', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_social_monthly' AND INDEX_NAME = 'uq_marcom_social_brand');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE marcom_social_monthly DROP FOREIGN KEY fk_marcom_social_brand', 'DO 0')
  FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_social_monthly' AND CONSTRAINT_NAME = 'fk_marcom_social_brand');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE marcom_social_monthly DROP COLUMN brand_id, DROP COLUMN account_name, DROP COLUMN needs_review', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_social_monthly' AND COLUMN_NAME = 'brand_id');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE marcom_social_monthly ADD UNIQUE KEY uq_marcom_social (year, month, platform, is_current)', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_social_monthly' AND INDEX_NAME = 'uq_marcom_social');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- web
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE marcom_web_monthly DROP INDEX uq_marcom_web_brand', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_web_monthly' AND INDEX_NAME = 'uq_marcom_web_brand');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE marcom_web_monthly DROP FOREIGN KEY fk_marcom_web_brand', 'DO 0')
  FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_web_monthly' AND CONSTRAINT_NAME = 'fk_marcom_web_brand');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE marcom_web_monthly DROP COLUMN brand_id, DROP COLUMN needs_review', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_web_monthly' AND COLUMN_NAME = 'brand_id');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE marcom_web_monthly ADD UNIQUE KEY uq_marcom_web (year, month, is_current)', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_web_monthly' AND INDEX_NAME = 'uq_marcom_web');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- spend
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE marcom_spend_monthly DROP COLUMN brand_revenue_current, DROP COLUMN brand_revenue_ly, DROP COLUMN company_revenue_total, DROP COLUMN revenue_needs_review', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_spend_monthly' AND COLUMN_NAME = 'brand_revenue_current');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 1, 'UPDATE marcom_spend_monthly SET finance_booked_total = COALESCE(finance_booked_total, 0), legacy_company_revenue_current = COALESCE(legacy_company_revenue_current, 0), legacy_company_revenue_ly = COALESCE(legacy_company_revenue_ly, 0), revenue_attributed = COALESCE(revenue_attributed, 0)', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_spend_monthly' AND COLUMN_NAME = 'finance_booked_total');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 1, 'ALTER TABLE marcom_spend_monthly CHANGE COLUMN finance_booked_total spend DECIMAL(18,2) NOT NULL, CHANGE COLUMN legacy_company_revenue_current company_revenue_current DECIMAL(18,2) NOT NULL, CHANGE COLUMN legacy_company_revenue_ly company_revenue_ly DECIMAL(18,2) NOT NULL, MODIFY COLUMN revenue_attributed DECIMAL(18,2) NOT NULL', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_spend_monthly' AND COLUMN_NAME = 'finance_booked_total');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- brand kind
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE marcom_brand DROP COLUMN kind', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_brand' AND COLUMN_NAME = 'kind');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
