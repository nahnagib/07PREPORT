-- Reverse of 0066_nps_followup_stage_status.sql: back to one `status` column holding the stage values of 0052
-- (RESOLVED -> SOLVED, REJECTED -> CANCELLED), resolved_at -> solved_at, the history under field `status` again.
-- rejected_at is dropped (when a case was rejected is lost; the history keeps it). Apply 0067's down file first.
SET NAMES utf8mb4;

SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE nps_followup_case DROP CHECK chk_nps_followup_stage', 'DO 0')
  FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND CONSTRAINT_NAME = 'chk_nps_followup_stage');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE nps_followup_case DROP CHECK chk_nps_followup_resolved', 'DO 0')
  FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND CONSTRAINT_NAME = 'chk_nps_followup_resolved');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE nps_followup_case DROP CHECK chk_nps_followup_rejected', 'DO 0')
  FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND CONSTRAINT_NAME = 'chk_nps_followup_rejected');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE nps_followup_case DROP CHECK chk_nps_followup_resolved_after', 'DO 0')
  FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND CONSTRAINT_NAME = 'chk_nps_followup_resolved_after');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE nps_followup_case DROP INDEX idx_nps_followup_case_stage', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND INDEX_NAME = 'idx_nps_followup_case_stage');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE nps_followup_case DROP INDEX idx_nps_followup_case_derived_status', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND INDEX_NAME = 'idx_nps_followup_case_derived_status');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- the generated status goes first, so the stage column can take its old name back
SET @s = (SELECT IF(SUM(COLUMN_NAME = 'status') = 1 AND SUM(COLUMN_NAME = 'stage') = 1, 'ALTER TABLE nps_followup_case DROP COLUMN status', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE nps_followup_case DROP COLUMN rejected_at', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND COLUMN_NAME = 'rejected_at');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE nps_followup_case RENAME COLUMN stage TO status', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND COLUMN_NAME = 'stage');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE nps_followup_case RENAME COLUMN resolved_at TO solved_at', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND COLUMN_NAME = 'resolved_at');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

UPDATE nps_followup_case SET status = 'SOLVED' WHERE status = 'RESOLVED';
UPDATE nps_followup_case SET status = 'CANCELLED' WHERE status = 'REJECTED';
UPDATE nps_followup_audit SET old_value = 'SOLVED' WHERE field = 'stage' AND old_value = 'RESOLVED';
UPDATE nps_followup_audit SET new_value = 'SOLVED' WHERE field = 'stage' AND new_value = 'RESOLVED';
UPDATE nps_followup_audit SET old_value = 'CANCELLED' WHERE field = 'stage' AND old_value = 'REJECTED';
UPDATE nps_followup_audit SET new_value = 'CANCELLED' WHERE field = 'stage' AND new_value = 'REJECTED';
UPDATE nps_followup_audit SET field = 'status' WHERE field = 'stage';
UPDATE nps_followup_audit SET field = 'solved_at' WHERE field = 'resolved_at';
DELETE FROM nps_followup_audit WHERE field = 'rejected_at';

SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE nps_followup_case ADD CONSTRAINT chk_nps_followup_status CHECK (status IN (''HISTORICAL'', ''NEW'', ''CONTACTED'', ''IN_PROGRESS'', ''SOLVED'', ''CANCELLED''))', 'DO 0')
  FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND CONSTRAINT_NAME = 'chk_nps_followup_status');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE nps_followup_case ADD CONSTRAINT chk_nps_followup_solved CHECK ((status = ''SOLVED'' AND solved_at IS NOT NULL) OR (status <> ''SOLVED'' AND solved_at IS NULL))', 'DO 0')
  FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND CONSTRAINT_NAME = 'chk_nps_followup_solved');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE nps_followup_case ADD CONSTRAINT chk_nps_followup_solved_after CHECK (solved_at IS NULL OR rated_at_local IS NULL OR solved_at >= rated_at_local)', 'DO 0')
  FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND CONSTRAINT_NAME = 'chk_nps_followup_solved_after');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 0, 'CREATE INDEX idx_nps_followup_case_status ON nps_followup_case (status, solved_at)', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND INDEX_NAME = 'idx_nps_followup_case_status');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
