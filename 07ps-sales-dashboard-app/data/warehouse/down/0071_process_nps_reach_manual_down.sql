-- Reverses 0071_process_nps_reach_manual.sql: the reach views go back to their 0049 definition (ETL messages only),
-- the manual reach table, its daily view and the meta_manual error group are dropped. Roll the backend back first.

SET NAMES utf8mb4;

CREATE OR REPLACE VIEW v_process_nps_reach AS
SELECT m.MessageDateKey, m.CompanyKey,
       COUNT(*) AS total_reach,
       SUM(m.box = 'delivered') AS delivered,
       SUM(m.box = 'not_delivered') AS not_delivered,
       SUM(m.box = 'read') AS read_count,
       SUM(m.box = 'error') AS error_count,
       SUM(m.box = 'other') AS other_state
FROM fact_process_nps_message m
WHERE m.in_reach_scope = 1
GROUP BY m.MessageDateKey, m.CompanyKey;

CREATE OR REPLACE VIEW v_process_nps_message_error AS
SELECT m.MessageDateKey, m.CompanyKey, m.failure_group, g.label_en, g.is_fixable, g.hint, g.sort_order, COUNT(*) AS errors
FROM fact_process_nps_message m
JOIN dim_process_nps_failure_group g ON g.failure_group = m.failure_group
WHERE m.in_reach_scope = 1 AND m.box = 'error'
GROUP BY m.MessageDateKey, m.CompanyKey, m.failure_group, g.label_en, g.is_fixable, g.hint, g.sort_order;

DROP VIEW IF EXISTS v_process_nps_reach_manual_daily;
DROP TABLE IF EXISTS process_nps_reach_manual;
DELETE FROM dim_process_nps_failure_group WHERE failure_group = 'meta_manual';
