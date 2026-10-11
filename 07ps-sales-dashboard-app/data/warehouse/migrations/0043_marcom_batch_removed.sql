-- 0043: MARCOM upload -- "Remove batch" (2026-10-11): an admin can remove ANY successful batch, not only the latest
-- (backend/src/marcom/service.ts removeBatch). The batch row, its summary, its original file and its audit entries are
-- kept; the batch gets status REMOVED and who / when / why.
--
-- Idempotent: the ENUM change re-runs harmlessly, each column is added only when missing (prepared statements, no
-- DELIMITER, for apply_migrations.py). Reverse: data/warehouse/down/0043_marcom_batch_removed_down.sql.

SET NAMES utf8mb4;

ALTER TABLE marcom_upload_batch
  MODIFY COLUMN status ENUM('SUCCESS', 'FAILED', 'ROLLED_BACK', 'REMOVED') NOT NULL DEFAULT 'SUCCESS';

SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE marcom_upload_batch ADD COLUMN removed_by INT NULL', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_upload_batch' AND COLUMN_NAME = 'removed_by');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE marcom_upload_batch ADD COLUMN removed_at DATETIME NULL', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_upload_batch' AND COLUMN_NAME = 'removed_at');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE marcom_upload_batch ADD COLUMN remove_reason VARCHAR(500) NULL', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_upload_batch' AND COLUMN_NAME = 'remove_reason');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
