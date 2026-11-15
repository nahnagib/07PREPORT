-- 0072: replace Rejected with Unresolved and keep the old stage and timestamp in case history.
-- Requires 0066 and 0069. Reverse: down/0072_nps_followup_remove_rejected_down.sql.

SET NAMES utf8mb4;

-- The old timestamp constraint must go before the move. DDL commits independently of the data transaction.
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE nps_followup_case DROP CHECK chk_nps_followup_rejected', 'DO 0')
  FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'nps_followup_case' AND CONSTRAINT_NAME = 'chk_nps_followup_rejected');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

START TRANSACTION;
-- Lock the rows being moved so the audit and edit use the same cases.
SELECT case_id FROM nps_followup_case WHERE stage = 'REJECTED' FOR UPDATE;
SET @moved_at = UTC_TIMESTAMP();
INSERT INTO nps_followup_audit (case_id, changed_by, changed_at, field, old_value, new_value)
SELECT case_id, NULL, @moved_at, 'stage', 'REJECTED', 'UNRESOLVED'
  FROM nps_followup_case WHERE stage = 'REJECTED';
INSERT INTO nps_followup_audit (case_id, changed_by, changed_at, field, old_value, new_value)
SELECT case_id, NULL, @moved_at, 'rejected_at', DATE_FORMAT(rejected_at, '%Y-%m-%d %H:%i:%s'), NULL
  FROM nps_followup_case WHERE stage = 'REJECTED' AND rejected_at IS NOT NULL;
UPDATE nps_followup_case
   SET stage = 'UNRESOLVED', rejected_at = NULL, version = version + 1, updated_by = NULL, updated_at = @moved_at
 WHERE stage = 'REJECTED';
COMMIT;

ALTER TABLE nps_followup_case
  DROP CHECK chk_nps_followup_stage,
  ADD CONSTRAINT chk_nps_followup_stage CHECK
    (stage IN ('HISTORICAL', 'NEW', 'CONTACTED', 'IN_PROGRESS', 'RESOLVED', 'UNRESOLVED'));

-- Keep the old column empty so the down migration can restore it from the audit.
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE nps_followup_case ADD CONSTRAINT chk_nps_followup_no_rejected_at CHECK (rejected_at IS NULL)', 'DO 0')
  FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'nps_followup_case' AND CONSTRAINT_NAME = 'chk_nps_followup_no_rejected_at');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

ALTER TABLE nps_followup_case
  DROP INDEX idx_nps_followup_case_derived_status,
  DROP COLUMN status,
  ADD COLUMN status VARCHAR(10) GENERATED ALWAYS AS (
    CASE WHEN stage IN ('NEW', 'CONTACTED', 'IN_PROGRESS') THEN 'OPEN' WHEN stage = 'RESOLVED' THEN 'CLOSED'
         WHEN stage = 'UNRESOLVED' THEN 'DISPUTED' END
  ) STORED AFTER stage,
  ADD INDEX idx_nps_followup_case_derived_status (status);
