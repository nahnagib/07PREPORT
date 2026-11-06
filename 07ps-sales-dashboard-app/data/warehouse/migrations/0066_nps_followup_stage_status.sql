-- 0066: NPS detractor follow-up -- STAGE and STATUS become two separate things (2026-11-06; docs/nps-followup.md,
-- "Stage, status and reasons").
--
--   stage   the workflow step people move a case through (was the column `status`):
--             NEW -> CONTACTED -> IN_PROGRESS -> RESOLVED (was SOLVED), or REJECTED (was CANCELLED); HISTORICAL = rated
--             before NPS_FOLLOWUP_START (set by process_nps only).
--   status  the outcome group, a STORED generated column worked out from the stage -- nobody writes it, so it can never
--           disagree with the stage: NEW / CONTACTED / IN_PROGRESS -> OPEN, RESOLVED -> CLOSE, HISTORICAL -> NULL,
--           anything else (REJECTED) -> DISPUTED. backend/src/services/npsFollowupService.ts statusOfStage() is the same rule.
--
-- Changes on nps_followup_case:
--   status -> stage (values SOLVED -> RESOLVED, CANCELLED -> REJECTED); solved_at -> resolved_at;
--   new rejected_at (Tripoli wall-clock, set when the stage becomes REJECTED; no 30-day window on the board);
--   new generated `status`; CHECKs and the stage index renamed.
-- nps_followup_audit: the history only records STAGE changes -- field status -> stage, solved_at -> resolved_at, and the
--   old/new values SOLVED / CANCELLED rewritten, so no old value is left anywhere.
--
-- rejected_at of a case rejected before this migration = when it was cancelled (its last audit row to CANCELLED, else its
-- updated_at), converted from UTC to Africa/Tripoli wall-clock (UTC+2, no daylight saving since 2013).
--
-- Idempotent (prepared statements guarded by information_schema, no DELIMITER, for apply_migrations.py): a second run
-- changes nothing. Requires 0052 (and 0059). Reverse: down/0066_nps_followup_stage_status_down.sql.

SET NAMES utf8mb4;

-- 1. Drop the old CHECKs first (they name `status` / `solved_at` and the old values).
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE nps_followup_case DROP CHECK chk_nps_followup_status', 'DO 0')
  FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND CONSTRAINT_NAME = 'chk_nps_followup_status');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE nps_followup_case DROP CHECK chk_nps_followup_solved', 'DO 0')
  FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND CONSTRAINT_NAME = 'chk_nps_followup_solved');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE nps_followup_case DROP CHECK chk_nps_followup_solved_after', 'DO 0')
  FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND CONSTRAINT_NAME = 'chk_nps_followup_solved_after');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE nps_followup_case DROP INDEX idx_nps_followup_case_status', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND INDEX_NAME = 'idx_nps_followup_case_status');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 2. Renames (only while the old column is there and the new one is not).
SET @s = (SELECT IF(SUM(COLUMN_NAME = 'status') = 1 AND SUM(COLUMN_NAME = 'stage') = 0,
    'ALTER TABLE nps_followup_case RENAME COLUMN status TO stage', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(SUM(COLUMN_NAME = 'solved_at') = 1 AND SUM(COLUMN_NAME = 'resolved_at') = 0,
    'ALTER TABLE nps_followup_case RENAME COLUMN solved_at TO resolved_at', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE nps_followup_case ADD COLUMN rejected_at DATETIME NULL AFTER resolved_at', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND COLUMN_NAME = 'rejected_at');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 3. Stage values.
UPDATE nps_followup_case SET stage = 'RESOLVED' WHERE stage = 'SOLVED';
UPDATE nps_followup_case SET stage = 'REJECTED' WHERE stage = 'CANCELLED';
UPDATE nps_followup_case c
   SET c.rejected_at = DATE_ADD(COALESCE(
         (SELECT MAX(a.changed_at) FROM nps_followup_audit a
           WHERE a.case_id = c.case_id AND a.field IN ('status', 'stage') AND a.new_value IN ('CANCELLED', 'REJECTED')),
         c.updated_at), INTERVAL 2 HOUR)
 WHERE c.stage = 'REJECTED' AND c.rejected_at IS NULL;

-- 4. History: stage changes only, under the new names and values.
UPDATE nps_followup_audit SET field = 'stage' WHERE field = 'status';
UPDATE nps_followup_audit SET field = 'resolved_at' WHERE field = 'solved_at';
UPDATE nps_followup_audit SET old_value = 'RESOLVED' WHERE field = 'stage' AND old_value = 'SOLVED';
UPDATE nps_followup_audit SET new_value = 'RESOLVED' WHERE field = 'stage' AND new_value = 'SOLVED';
UPDATE nps_followup_audit SET old_value = 'REJECTED' WHERE field = 'stage' AND old_value = 'CANCELLED';
UPDATE nps_followup_audit SET new_value = 'REJECTED' WHERE field = 'stage' AND new_value = 'CANCELLED';

-- 5. The derived status (after the rename, so the name `status` is free).
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE nps_followup_case ADD COLUMN status VARCHAR(10) GENERATED ALWAYS AS (CASE WHEN stage IN (''NEW'', ''CONTACTED'', ''IN_PROGRESS'') THEN ''OPEN'' WHEN stage = ''RESOLVED'' THEN ''CLOSE'' WHEN stage = ''HISTORICAL'' THEN NULL ELSE ''DISPUTED'' END) STORED AFTER stage', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND COLUMN_NAME = 'status');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 6. CHECKs and indexes under the new names.
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE nps_followup_case ADD CONSTRAINT chk_nps_followup_stage CHECK (stage IN (''HISTORICAL'', ''NEW'', ''CONTACTED'', ''IN_PROGRESS'', ''RESOLVED'', ''REJECTED''))', 'DO 0')
  FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND CONSTRAINT_NAME = 'chk_nps_followup_stage');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE nps_followup_case ADD CONSTRAINT chk_nps_followup_resolved CHECK ((stage = ''RESOLVED'' AND resolved_at IS NOT NULL) OR (stage <> ''RESOLVED'' AND resolved_at IS NULL))', 'DO 0')
  FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND CONSTRAINT_NAME = 'chk_nps_followup_resolved');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE nps_followup_case ADD CONSTRAINT chk_nps_followup_rejected CHECK ((stage = ''REJECTED'' AND rejected_at IS NOT NULL) OR (stage <> ''REJECTED'' AND rejected_at IS NULL))', 'DO 0')
  FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND CONSTRAINT_NAME = 'chk_nps_followup_rejected');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE nps_followup_case ADD CONSTRAINT chk_nps_followup_resolved_after CHECK (resolved_at IS NULL OR rated_at_local IS NULL OR resolved_at >= rated_at_local)', 'DO 0')
  FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND CONSTRAINT_NAME = 'chk_nps_followup_resolved_after');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 0, 'CREATE INDEX idx_nps_followup_case_stage ON nps_followup_case (stage, resolved_at)', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND INDEX_NAME = 'idx_nps_followup_case_stage');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 0, 'CREATE INDEX idx_nps_followup_case_derived_status ON nps_followup_case (status)', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND INDEX_NAME = 'idx_nps_followup_case_derived_status');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
