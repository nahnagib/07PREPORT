-- Reverse of 0059_nps_followup_owner_text.sql: drops the free-text owner. Owners typed after 0059 (owner_user_id NULL)
-- are lost; owners chosen before it are still in owner_user_id.
SET NAMES utf8mb4;

SET @s = (SELECT IF(COUNT(*) > 0, 'DROP INDEX idx_nps_followup_case_owner_name ON nps_followup_case', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND INDEX_NAME = 'idx_nps_followup_case_owner_name');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE nps_followup_case DROP COLUMN owner_name', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND COLUMN_NAME = 'owner_name');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
