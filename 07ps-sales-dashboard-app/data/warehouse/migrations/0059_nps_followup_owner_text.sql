-- 0059: NPS detractor follow-up -- the case OWNER becomes free text (2026-10-26). Owners are often people without a
-- dashboard login (a branch manager, a driver supervisor), so the Owner field on the case is typed, not picked from
-- app users.
--
-- Adds nps_followup_case.owner_name and copies the current owner's display name into it, so no case loses its owner.
-- owner_user_id stays (history, FK) but is no longer written: an edit of the owner writes owner_name and clears
-- owner_user_id (backend/src/services/npsFollowupService.ts). Reads use COALESCE(owner_name, the user's name).
--
-- Idempotent (prepared statements, no DELIMITER, for apply_migrations.py). Reverse: down/0059_nps_followup_owner_text_down.sql.

SET NAMES utf8mb4;

SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE nps_followup_case ADD COLUMN owner_name VARCHAR(120) NULL AFTER owner_user_id', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND COLUMN_NAME = 'owner_name');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) = 0, 'CREATE INDEX idx_nps_followup_case_owner_name ON nps_followup_case (owner_name)', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nps_followup_case' AND INDEX_NAME = 'idx_nps_followup_case_owner_name');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Keep every existing owner: copy the user's name (only where no text owner is set yet, so re-running is harmless).
UPDATE nps_followup_case c
  JOIN app_user u ON u.user_id = c.owner_user_id
   SET c.owner_name = u.display_name
 WHERE c.owner_name IS NULL AND c.owner_user_id IS NOT NULL;
