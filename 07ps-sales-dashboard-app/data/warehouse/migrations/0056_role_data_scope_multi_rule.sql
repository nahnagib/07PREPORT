-- 0056: Several data-scope rules on one dimension (2026-10-21).
--
-- Until now a role could hold one rule per dimension (every role_data_scope row of a role + dimension was that one
-- rule). A role can now hold several rules on the same dimension, all of which apply (AND), e.g.
--   Company is [Athena, Zeus]  AND  Company is not [Zeus-Retail]
-- Each rule is a group of rows sharing (role_id, dimension, rule_no); within one rule the values are OR'd as before.
--
-- Schema:
--   rule_no  -- numbers the rules of one role + dimension (1, 2, ...). Existing rows all get 1: every role keeps
--               exactly the one rule per dimension it has today, so it sees exactly the same data.
--   unique key (role_id, dimension, value) -> (role_id, dimension, rule_no, value): the same value may now appear in
--               two rules of one dimension ("is A or B" AND "is not B").
--
-- Read by backend/src/services/dataScopeService.ts. The backend reads every row as rule 1 while the column does not
-- exist, so code and migration may be deployed in either order; saving a second rule on a dimension needs it.
-- Idempotent (information_schema checks, prepared statements, no DELIMITER, for apply_migrations.py).
-- Reverse: data/warehouse/down/0056_role_data_scope_multi_rule_down.sql.

SET NAMES utf8mb4;

SET @s = (SELECT IF(COUNT(*) = 0,
    'ALTER TABLE role_data_scope ADD COLUMN rule_no INT NOT NULL DEFAULT 1 COMMENT ''numbers the rules of one role + dimension; all rules of a dimension apply (AND)'' AFTER dimension',
    'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'role_data_scope' AND COLUMN_NAME = 'rule_no');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- New unique key first: the role_id foreign key needs an index starting with role_id at every moment.
SET @s = (SELECT IF(COUNT(*) = 0,
    'ALTER TABLE role_data_scope ADD UNIQUE KEY uq_role_data_scope_rule (role_id, dimension, rule_no, value)',
    'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'role_data_scope' AND INDEX_NAME = 'uq_role_data_scope_rule');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE role_data_scope DROP INDEX uq_role_data_scope', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'role_data_scope' AND INDEX_NAME = 'uq_role_data_scope');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
