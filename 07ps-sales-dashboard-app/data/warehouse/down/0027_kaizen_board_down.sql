-- Manual down-migration for 0027_kaizen_board.sql (the repo has no down-migration convention; same
-- style as 0022_0023_marcom_down.sql). DESTROYS every Kaizen card and dropdown value.
--
-- Before running it, take the Kaizen code out of the backend (switch back to a branch without it)
-- and restart: at startup the backend re-syncs config/permissionRegistry.ts into pages/permissions,
-- so while the kaizen_* registry entries exist it would recreate the rows deleted below.
--
-- There is no migration record to remove: apply_migrations.py doesn't track applied files.
-- Audit history (audit_log rows with entity_type 'kaizen_card' / 'kaizen_dropdown_value') is kept.
--
-- Run it with the same runner as the migrations, pointing at this folder's file, e.g. from a Python
-- shell with pymysql, or copy it into your SQL client. It is NOT in migrations/, so
-- apply_migrations.py never picks it up by itself.

SET NAMES utf8mb4;

-- 1. The Excellence Manager role. Its DELETE fails (FK error) if any user still has it as their
--    primary role (app_user.role_id) -- reassign those users first. It runs first so that such a
--    failure stops the script before anything else is removed.
DELETE ur FROM user_roles ur JOIN roles r ON r.role_id = ur.role_id WHERE r.role_name = 'EXCELLENCE_MANAGER';
DELETE rp FROM role_permissions rp JOIN roles r ON r.role_id = rp.role_id WHERE r.role_name = 'EXCELLENCE_MANAGER';
DELETE FROM roles WHERE role_name = 'EXCELLENCE_MANAGER';

-- 2. The two permission pages, their actions, and every grant/override on them.
DELETE rp FROM role_permissions rp JOIN permissions p ON p.permission_id = rp.permission_id
  JOIN pages pg ON pg.page_id = p.page_id
  WHERE pg.page_key IN ('kaizen_board', 'kaizen_cards');
DELETE up FROM user_permissions up JOIN permissions p ON p.permission_id = up.permission_id
  JOIN pages pg ON pg.page_id = p.page_id
  WHERE pg.page_key IN ('kaizen_board', 'kaizen_cards');
DELETE p FROM permissions p JOIN pages pg ON pg.page_id = p.page_id
  WHERE pg.page_key IN ('kaizen_board', 'kaizen_cards');
DELETE FROM pages WHERE page_key IN ('kaizen_board', 'kaizen_cards');

-- 3. The tables (cards first: they reference the dropdown values).
DROP TABLE IF EXISTS kaizen_cards;
DROP TABLE IF EXISTS kaizen_dropdown_value;
