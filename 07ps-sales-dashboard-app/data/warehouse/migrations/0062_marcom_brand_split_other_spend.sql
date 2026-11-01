-- 0062: MARCOM change request from the Marketing review (2026-10-29), template 2.0.
--
--  1. Digital Performance per brand: marcom_social_monthly / marcom_web_monthly get brand_id (FK marcom_brand) and the
--     social table an optional account_name (a brand with two pages on one platform). New natural keys:
--       social (year, month, brand_id, platform, account_name)   web (year, month, brand_id)
--     Rows uploaded before this change have no brand. They are NOT guessed: brand_id stays NULL and needs_review = 1.
--     The KPI layer shows them only under "All" (as "No brand - needs review") and drops them for a (year, month,
--     platform) once branded rows exist for it, so nothing is counted twice (backend/src/marcomKpi/digital.ts).
--
--  2. Non-campaign MARCOM spend: lookup marcom_spend_category + versioned table marcom_other_spend (one row per expense
--     line). Total MARCOM Spend = campaign spend (prorated by active days) + other spend, computed at query time.
--
--  3. P1 revenue inputs are brand-level and monthly:
--       spend                   -> finance_booked_total    (the old "Total Marketing Spend" input is now the optional
--                                                           finance-booked figure; Total MARCOM Spend is calculated)
--       company_revenue_current -> legacy_company_revenue_current  } kept for review only; the old headers asked for the
--       company_revenue_ly      -> legacy_company_revenue_ly       } COMPANY total, the new inputs are per BRAND
--       + brand_revenue_current, brand_revenue_ly, company_revenue_total (all NULL), revenue_needs_review
--     Existing rows get revenue_needs_review = 1 and NULL brand revenue (no guessing). revenue_attributed becomes NULL-able
--     (group rows such as BMH have no revenue).
--
--  4. marcom_brand.kind: 'GROUP' marks group-level activity that is not a brand (BMH = group events). Group rows carry
--     spend but no brand revenue. BMH is created as GROUP here so the first 2.0 upload treats it correctly.
--
-- Idempotent (prepared statements, no DELIMITER, for apply_migrations.py). Reverse: down/0062_marcom_brand_split_other_spend_down.sql.

SET NAMES utf8mb4;

-- ------------------------------------------------------------------ 4. brand kind
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE marcom_brand ADD COLUMN kind ENUM(''BRAND'',''GROUP'') NOT NULL DEFAULT ''BRAND'' AFTER company_key', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_brand' AND COLUMN_NAME = 'kind');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

INSERT INTO marcom_brand (name, kind) VALUES ('BMH', 'GROUP') ON DUPLICATE KEY UPDATE kind = 'GROUP';

-- ------------------------------------------------------------------ 2. other spend
CREATE TABLE IF NOT EXISTS marcom_spend_category (
    category_id  INT AUTO_INCREMENT PRIMARY KEY,
    name         VARCHAR(100) NOT NULL,
    sort_order   INT NOT NULL DEFAULT 0,
    is_active    TINYINT NOT NULL DEFAULT 1,
    UNIQUE KEY uq_marcom_spend_category_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO marcom_spend_category (name, sort_order) VALUES
    ('Uniforms', 10), ('Printing & Printouts', 20), ('Gifts & Giveaways', 30), ('Events & Sponsorships', 40),
    ('Branding & Signage', 50), ('POS / Merchandising Materials', 60), ('Photography & Production', 70),
    ('Agency / Freelancer Fees', 80), ('Other', 90);

CREATE TABLE IF NOT EXISTS marcom_other_spend (
    id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
    year                SMALLINT NOT NULL,
    month               TINYINT NOT NULL,
    brand_id            INT NOT NULL,
    category_id         INT NOT NULL,
    description         VARCHAR(200) NOT NULL,
    vendor              VARCHAR(200) NULL,
    amount_lyd          DECIMAL(18,2) NOT NULL,
    notes               VARCHAR(200) NULL,
    batch_id            BIGINT NOT NULL,
    superseded_by_batch BIGINT NULL,
    is_current          TINYINT NULL DEFAULT 1,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_marcom_other_spend (year, month, brand_id, category_id, description, is_current),
    INDEX idx_marcom_other_batch (batch_id),
    INDEX idx_marcom_other_super (superseded_by_batch),
    FOREIGN KEY (brand_id) REFERENCES marcom_brand(brand_id),
    FOREIGN KEY (category_id) REFERENCES marcom_spend_category(category_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------ 3. P1 revenue columns
SET @s = (SELECT IF(COUNT(*) = 1, 'ALTER TABLE marcom_spend_monthly CHANGE COLUMN spend finance_booked_total DECIMAL(18,2) NULL', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_spend_monthly' AND COLUMN_NAME = 'spend');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) = 1, 'ALTER TABLE marcom_spend_monthly CHANGE COLUMN company_revenue_current legacy_company_revenue_current DECIMAL(18,2) NULL', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_spend_monthly' AND COLUMN_NAME = 'company_revenue_current');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) = 1, 'ALTER TABLE marcom_spend_monthly CHANGE COLUMN company_revenue_ly legacy_company_revenue_ly DECIMAL(18,2) NULL', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_spend_monthly' AND COLUMN_NAME = 'company_revenue_ly');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE marcom_spend_monthly
    ADD COLUMN brand_revenue_current DECIMAL(18,2) NULL AFTER brand_id,
    ADD COLUMN brand_revenue_ly DECIMAL(18,2) NULL AFTER brand_revenue_current,
    ADD COLUMN company_revenue_total DECIMAL(18,2) NULL AFTER revenue_attributed,
    ADD COLUMN revenue_needs_review TINYINT NOT NULL DEFAULT 0 AFTER clicks', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_spend_monthly' AND COLUMN_NAME = 'brand_revenue_current');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

ALTER TABLE marcom_spend_monthly MODIFY COLUMN revenue_attributed DECIMAL(18,2) NULL;

-- Rows from template 1.x: the revenue they hold was asked as a COMPANY total -> flag, never copy into brand revenue.
UPDATE marcom_spend_monthly SET revenue_needs_review = 1
 WHERE brand_revenue_current IS NULL AND (legacy_company_revenue_current IS NOT NULL OR legacy_company_revenue_ly IS NOT NULL);

-- ------------------------------------------------------------------ 1. social + web per brand
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE marcom_social_monthly
    ADD COLUMN brand_id INT NULL AFTER month,
    ADD COLUMN account_name VARCHAR(100) NOT NULL DEFAULT '''' AFTER platform,
    ADD COLUMN needs_review TINYINT NOT NULL DEFAULT 0 AFTER engagement_organic,
    ADD CONSTRAINT fk_marcom_social_brand FOREIGN KEY (brand_id) REFERENCES marcom_brand(brand_id)', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_social_monthly' AND COLUMN_NAME = 'brand_id');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE marcom_social_monthly DROP INDEX uq_marcom_social', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_social_monthly' AND INDEX_NAME = 'uq_marcom_social');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE marcom_social_monthly ADD UNIQUE KEY uq_marcom_social_brand (year, month, brand_id, platform, account_name, is_current)', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_social_monthly' AND INDEX_NAME = 'uq_marcom_social_brand');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE marcom_web_monthly
    ADD COLUMN brand_id INT NULL AFTER month,
    ADD COLUMN needs_review TINYINT NOT NULL DEFAULT 0 AFTER total_minutes,
    ADD CONSTRAINT fk_marcom_web_brand FOREIGN KEY (brand_id) REFERENCES marcom_brand(brand_id)', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_web_monthly' AND COLUMN_NAME = 'brand_id');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE marcom_web_monthly DROP INDEX uq_marcom_web', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_web_monthly' AND INDEX_NAME = 'uq_marcom_web');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE marcom_web_monthly ADD UNIQUE KEY uq_marcom_web_brand (year, month, brand_id, is_current)', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_web_monthly' AND INDEX_NAME = 'uq_marcom_web_brand');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Brand-less rows from template 1.x: flag for review, never assign a brand.
UPDATE marcom_social_monthly SET needs_review = 1 WHERE brand_id IS NULL;
UPDATE marcom_web_monthly SET needs_review = 1 WHERE brand_id IS NULL;
