-- 0058: MARCOM media rows get a CITY (2026-10-26). Template 1.1 adds a City column to P2 Table B, so a campaign's
-- OOH coverage is one row per campaign + media type + city; the Media Campaign Performance page draws it as a
-- city map (bubble size = cost).
--
-- city is NOT NULL DEFAULT '' rather than NULL so the unique key still works (MySQL allows repeated NULLs in a
-- UNIQUE index). Rows uploaded before this change keep city = '' ("no city"); once a campaign is re-uploaded with
-- city rows, the KPI layer ignores that campaign's old city-less rows so nothing is counted twice
-- (backend/src/marcomKpi/campaigns.ts). Allowed values are checked by the parser (templateConfig.ts CITIES).
--
-- Idempotent (prepared statements, no DELIMITER, for apply_migrations.py). Reverse: down/0058_marcom_media_city_down.sql.

SET NAMES utf8mb4;

SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE marcom_campaign_media ADD COLUMN city VARCHAR(60) NOT NULL DEFAULT '''' AFTER media_type', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_campaign_media' AND COLUMN_NAME = 'city');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Old unique key (campaign, type) -> new (campaign, type, city).
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE marcom_campaign_media DROP INDEX uq_marcom_media', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_campaign_media' AND INDEX_NAME = 'uq_marcom_media');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE marcom_campaign_media ADD UNIQUE KEY uq_marcom_media_city (campaign_name, media_type, city, is_current)', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_campaign_media' AND INDEX_NAME = 'uq_marcom_media_city');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
