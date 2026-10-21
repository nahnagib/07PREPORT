-- Reverses 0056_role_data_scope_multi_rule.sql: drops role_data_scope.rule_no and restores the
-- (role_id, dimension, value) unique key.
--
-- Refuses while any role holds a second rule on a dimension (rule_no > 1): without the column those rows would merge
-- into the first rule and change what the role sees. Merge or remove those rules on the Roles page first, then run
-- this again.

SET NAMES utf8mb4;

SET @has_rule_no = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'role_data_scope' AND COLUMN_NAME = 'rule_no');
SET @s = IF(@has_rule_no > 0, 'SELECT COUNT(*) INTO @extra FROM role_data_scope WHERE rule_no > 1', 'SET @extra = 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = IF(@extra > 0, 'SELECT * FROM `ABORT_0056_down__second_rules_exist__merge_or_remove_them_first`', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE role_data_scope ADD UNIQUE KEY uq_role_data_scope (role_id, dimension, value)', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'role_data_scope' AND INDEX_NAME = 'uq_role_data_scope');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE role_data_scope DROP INDEX uq_role_data_scope_rule', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'role_data_scope' AND INDEX_NAME = 'uq_role_data_scope_rule');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = IF(@has_rule_no > 0, 'ALTER TABLE role_data_scope DROP COLUMN rule_no', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
