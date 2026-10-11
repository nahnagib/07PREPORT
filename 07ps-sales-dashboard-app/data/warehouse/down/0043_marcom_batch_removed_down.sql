-- Reverses 0043_marcom_batch_removed.sql. A REMOVED batch becomes ROLLED_BACK (its data rows are gone either way; who /
-- when / why move to the rollback columns), then the REMOVED status and the remove columns are dropped.

SET NAMES utf8mb4;

UPDATE marcom_upload_batch
   SET status = 'ROLLED_BACK', rolled_back_by = removed_by, rolled_back_at = removed_at, rollback_reason = remove_reason
 WHERE status = 'REMOVED';

ALTER TABLE marcom_upload_batch
  MODIFY COLUMN status ENUM('SUCCESS', 'FAILED', 'ROLLED_BACK') NOT NULL DEFAULT 'SUCCESS';

SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE marcom_upload_batch DROP COLUMN removed_by, DROP COLUMN removed_at, DROP COLUMN remove_reason', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marcom_upload_batch' AND COLUMN_NAME = 'removed_by');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
