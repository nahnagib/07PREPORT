-- Reverse of 0067_nps_reason_two_level.sql: the cases point to the old flat list (nps_followup_reason) again. Each case
-- gets back the old reason it was moved from (nps_reason_legacy_map); a reason chosen after 0067 has no old equivalent
-- and is cleared (its history row still names it). reason_note is dropped. Apply before down/0066.
SET NAMES utf8mb4;

SET @new_fk = (SELECT COUNT(*) FROM information_schema.REFERENTIAL_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND CONSTRAINT_NAME = 'fk_nps_followup_case_reason_dim');
SET @s = IF(@new_fk > 0, 'ALTER TABLE nps_followup_case DROP FOREIGN KEY fk_nps_followup_case_reason_dim', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

DROP TEMPORARY TABLE IF EXISTS tmp_nps_reason_back;
CREATE TEMPORARY TABLE tmp_nps_reason_back AS
  SELECT c.case_id,
         (SELECT MIN(m.legacy_reason_id) FROM nps_reason_legacy_map m WHERE m.reason_key = d.reason_key AND m.legacy_reason_id IS NOT NULL) AS old_reason_id
    FROM nps_followup_case c JOIN dim_nps_reason d ON d.reason_id = c.reason_id
   WHERE @new_fk > 0;
UPDATE nps_followup_case c JOIN tmp_nps_reason_back t ON t.case_id = c.case_id SET c.reason_id = t.old_reason_id;
DROP TEMPORARY TABLE tmp_nps_reason_back;

SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE nps_followup_case ADD CONSTRAINT fk_nps_followup_case_reason FOREIGN KEY (reason_id) REFERENCES nps_followup_reason(reason_id)', 'DO 0')
  FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND CONSTRAINT_NAME = 'fk_nps_followup_case_reason');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE nps_followup_case DROP COLUMN reason_note', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND COLUMN_NAME = 'reason_note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

DROP TABLE IF EXISTS nps_reason_legacy_map;
DROP TABLE IF EXISTS dim_nps_reason;
