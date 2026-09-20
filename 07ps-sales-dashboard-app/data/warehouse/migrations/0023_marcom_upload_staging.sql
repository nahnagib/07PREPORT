-- MARCOM upload flow: staged (dry-run) uploads, rollback bookkeeping, extra indexes.
-- Idempotent (safe to re-run under apply_migrations.py, which replays every file): each ALTER is
-- guarded by an information_schema check run through a prepared statement (no DELIMITER/procedures,
-- which the pymysql-based runner can't parse). 0022 is intentionally not edited.
--
-- NOTE on "unique WHERE is_current": MySQL 8 has no partial indexes. 0022's UNIQUE(natural key,
-- is_current) is the equivalent -- is_current is 1 for the live row and NULL for history rows,
-- and NULLs never collide in a unique index, so only one live row per key can exist.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS marcom_staged_upload (
    staged_id         CHAR(36) PRIMARY KEY,
    user_id           INT NOT NULL,
    original_filename VARCHAR(255) NOT NULL,
    file_hash         CHAR(64) NOT NULL,
    file_size         INT NOT NULL,
    preview_json      LONGTEXT NULL,
    created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at        DATETIME NOT NULL,
    consumed_at       DATETIME NULL,
    INDEX idx_marcom_staged_expires (expires_at),
    INDEX idx_marcom_staged_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE marcom_upload_batch ADD COLUMN rolled_back_by INT NULL', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_upload_batch' AND COLUMN_NAME = 'rolled_back_by');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE marcom_upload_batch ADD COLUMN rolled_back_at DATETIME NULL', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_upload_batch' AND COLUMN_NAME = 'rolled_back_at');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE marcom_upload_batch ADD COLUMN rollback_reason VARCHAR(500) NULL', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_upload_batch' AND COLUMN_NAME = 'rollback_reason');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE marcom_upload_batch ADD COLUMN error_message VARCHAR(500) NULL', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_upload_batch' AND COLUMN_NAME = 'error_message');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Query-shaped indexes for the pages (filters are year/month/brand and campaign/event dates).
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE marcom_spend_monthly ADD INDEX idx_marcom_spend_brand_period (brand_id, year, month)', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_spend_monthly' AND INDEX_NAME = 'idx_marcom_spend_brand_period');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE marcom_spend_monthly ADD INDEX idx_marcom_spend_current (is_current, year, month)', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_spend_monthly' AND INDEX_NAME = 'idx_marcom_spend_current');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE marcom_social_monthly ADD INDEX idx_marcom_social_current (is_current, year, month)', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_social_monthly' AND INDEX_NAME = 'idx_marcom_social_current');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE marcom_web_monthly ADD INDEX idx_marcom_web_current (is_current, year, month)', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_web_monthly' AND INDEX_NAME = 'idx_marcom_web_current');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE marcom_trade_monthly ADD INDEX idx_marcom_trade_current (is_current, year, month)', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_trade_monthly' AND INDEX_NAME = 'idx_marcom_trade_current');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE marcom_campaign ADD INDEX idx_marcom_campaign_dates (start_date, end_date)', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_campaign' AND INDEX_NAME = 'idx_marcom_campaign_dates');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE marcom_event ADD INDEX idx_marcom_event_brand_planned (brand_id, planned_date)', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_event' AND INDEX_NAME = 'idx_marcom_event_brand_planned');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
