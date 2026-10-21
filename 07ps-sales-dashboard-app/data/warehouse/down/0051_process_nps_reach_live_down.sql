-- Reverses 0051_process_nps_reach_live.sql: drops fact_process_nps_message.deleted_in_source_at and
-- process_nps_reach_state.reach_start, removes the 131050 group and restores the 0049 labels. Roll the backend and ETL
-- back first (the 0051 ETL writes both columns and maps 131050 to its own group). The source table is not touched.

SET NAMES utf8mb4;

SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE fact_process_nps_message DROP COLUMN deleted_in_source_at', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_process_nps_message' AND COLUMN_NAME = 'deleted_in_source_at');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE process_nps_reach_state DROP COLUMN reach_start', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'process_nps_reach_state' AND COLUMN_NAME = 'reach_start');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- messages of the removed group fall back to Other until the old ETL reloads the fact
UPDATE fact_process_nps_message SET failure_group = 'other' WHERE failure_group = 'opted_out_131050';
DELETE FROM dim_process_nps_failure_group WHERE failure_group = 'opted_out_131050';

SET @now = UTC_TIMESTAMP();
UPDATE dim_process_nps_failure_group SET label_en = '131049 Ecosystem engagement',
       hint = 'Meta did not deliver the marketing message to keep engagement healthy; it may succeed later.', sort_order = 2,
       updated_at_utc = @now WHERE failure_group = 'ecosystem_131049';
UPDATE dim_process_nps_failure_group SET sort_order = 3, updated_at_utc = @now WHERE failure_group = 'template_quality';
UPDATE dim_process_nps_failure_group SET label_en = 'phone number wrong format', is_fixable = 1,
       hint = 'The customer''s mobile number is not in a valid international format: correct it in Odoo.', sort_order = 4,
       updated_at_utc = @now WHERE failure_group = 'phone_format';
UPDATE dim_process_nps_failure_group SET sort_order = 5, updated_at_utc = @now WHERE failure_group = 'meta_temporary';
UPDATE dim_process_nps_failure_group SET sort_order = 6, updated_at_utc = @now WHERE failure_group = 'other';
