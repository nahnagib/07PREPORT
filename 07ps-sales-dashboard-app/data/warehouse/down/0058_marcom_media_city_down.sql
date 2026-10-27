-- Reverse of 0058_marcom_media_city.sql. Only safe while every campaign has at most one row per media type
-- (i.e. before any city-level upload); otherwise restoring the old unique key fails -- remove those batches first.
SET NAMES utf8mb4;

SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE marcom_campaign_media DROP INDEX uq_marcom_media_city', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_campaign_media' AND INDEX_NAME = 'uq_marcom_media_city');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE marcom_campaign_media ADD UNIQUE KEY uq_marcom_media (campaign_name, media_type, is_current)', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_campaign_media' AND INDEX_NAME = 'uq_marcom_media');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE marcom_campaign_media DROP COLUMN city', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_campaign_media' AND COLUMN_NAME = 'city');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
