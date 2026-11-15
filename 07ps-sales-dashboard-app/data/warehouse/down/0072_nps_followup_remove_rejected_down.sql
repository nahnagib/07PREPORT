-- Reverses 0072_nps_followup_remove_rejected.sql: REJECTED is an allowed stage again, and the cases 0072 moved go back
-- to REJECTED with their old rejected_at -- found by 0072's own history rows (system, stage REJECTED -> UNRESOLVED), and
-- only while their last stage change is still that one and they are still UNRESOLVED. Roll the backend back first.

SET NAMES utf8mb4;

SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE nps_followup_case DROP CHECK chk_nps_followup_no_rejected_at', 'DO 0')
  FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND CONSTRAINT_NAME = 'chk_nps_followup_no_rejected_at');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

ALTER TABLE nps_followup_case
  DROP CHECK chk_nps_followup_stage,
  ADD CONSTRAINT chk_nps_followup_stage CHECK
    (stage IN ('HISTORICAL', 'NEW', 'CONTACTED', 'IN_PROGRESS', 'RESOLVED', 'UNRESOLVED', 'REJECTED'));

UPDATE nps_followup_case c
  JOIN nps_followup_audit a ON a.case_id = c.case_id AND a.changed_by IS NULL AND a.field = 'stage'
       AND a.old_value = 'REJECTED' AND a.new_value = 'UNRESOLVED'
   SET c.stage = 'REJECTED',
       c.rejected_at = COALESCE(
         (SELECT STR_TO_DATE(r.old_value, '%Y-%m-%d %H:%i:%s') FROM nps_followup_audit r
           WHERE r.case_id = c.case_id AND r.changed_by IS NULL AND r.field = 'rejected_at' ORDER BY r.audit_id DESC LIMIT 1),
         c.updated_at)
 WHERE c.stage = 'UNRESOLVED'
   AND a.audit_id = (SELECT MAX(l.audit_id) FROM nps_followup_audit l WHERE l.case_id = c.case_id AND l.field = 'stage');

SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE nps_followup_case ADD CONSTRAINT chk_nps_followup_rejected CHECK ((stage = ''REJECTED'' AND rejected_at IS NOT NULL) OR (stage <> ''REJECTED'' AND rejected_at IS NULL))', 'DO 0')
  FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND CONSTRAINT_NAME = 'chk_nps_followup_rejected');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

ALTER TABLE nps_followup_case
  DROP INDEX idx_nps_followup_case_derived_status,
  DROP COLUMN status,
  ADD COLUMN status VARCHAR(10) GENERATED ALWAYS AS (
    CASE WHEN stage IN ('NEW', 'CONTACTED', 'IN_PROGRESS') THEN 'OPEN'
         WHEN stage = 'RESOLVED' THEN 'CLOSE'
         WHEN stage = 'HISTORICAL' THEN NULL ELSE 'DISPUTED' END
  ) STORED AFTER stage,
  ADD INDEX idx_nps_followup_case_derived_status (status);
