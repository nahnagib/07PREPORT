-- Reverses 0044_role_data_scope_operator.sql: drops role_data_scope.operator.
--
-- Refuses while any "is none of" (not_in) rule exists: without the column those rows would read as "is any of" --
-- the excluded values would become the ONLY values the role sees, the opposite of the rule. Replace or remove those
-- rules on the Roles page first (or decide per role), then run this again. "is any of" rows need nothing: they are
-- exactly the rows the old code reads.

SET NAMES utf8mb4;

SET @has_operator = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'role_data_scope' AND COLUMN_NAME = 'operator');
SET @s = IF(@has_operator > 0, 'SELECT COUNT(*) INTO @not_in FROM role_data_scope WHERE operator = ''not_in''', 'SET @not_in = 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = IF(@not_in > 0, 'SELECT * FROM `ABORT_0044_down__not_in_rules_exist__remove_them_first`', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = IF(@has_operator > 0, 'ALTER TABLE role_data_scope DROP COLUMN operator', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
