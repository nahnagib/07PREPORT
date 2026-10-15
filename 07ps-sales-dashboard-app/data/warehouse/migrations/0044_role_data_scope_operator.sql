-- 0044: Role data scope operators (2026-10-15). A data-scope rule becomes { dimension, operator, values }:
--   in      "is any of"  -- users of the role see ONLY these values (the only behaviour before this migration);
--   not_in  "is none of" -- users of the role see everything EXCEPT these values; resolved on every request against
--                           the dimension's current keys (backend/src/services/dataScopeService.ts), so a value added
--                           later (a new company) is visible without editing the role.
-- One rule per role + dimension = every role_data_scope row of that role + dimension, all with the same operator
-- (the Roles page saves a whole rule at once: backend setRoleScopeRule).
--
-- Existing rows: every one becomes operator 'in' (the column default), so every role sees exactly what it saw
-- before. Several rows on one dimension already are one "is any of" rule holding all their values (the backend
-- groups a role's rows per dimension) -- nothing to merge in the data.
--
-- Idempotent: the column is added only when missing (prepared statement, no DELIMITER, for apply_migrations.py).
-- The backend reads every row as 'in' while this column does not exist, so code and migration may be deployed in
-- either order; saving an exclusion needs the column. Reverse: data/warehouse/down/0044_role_data_scope_operator_down.sql.

SET NAMES utf8mb4;

SET @s = (SELECT IF(COUNT(*) = 0,
    'ALTER TABLE role_data_scope ADD COLUMN operator ENUM(''in'', ''not_in'') NOT NULL DEFAULT ''in'' COMMENT ''in = is any of (only these values); not_in = is none of (every value except these)'' AFTER dimension',
    'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'role_data_scope' AND COLUMN_NAME = 'operator');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Rows saved before the column existed got the default; this keeps any NULL-like gap impossible on re-runs.
UPDATE role_data_scope SET operator = 'in' WHERE operator IS NULL OR operator = '';
