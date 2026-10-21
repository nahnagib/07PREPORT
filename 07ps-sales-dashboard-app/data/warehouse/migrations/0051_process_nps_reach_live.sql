-- 0051: NPS Score -- WhatsApp reach goes live (docs/nps-etl.md, "Message reach"; profile of 2026-10-19).
--
--   fact_process_nps_message.deleted_in_source_at   a message that left whatsapp_outbound_messages keeps being counted
--                                                   (business rule 2026-10-19); this says since when it is gone
--   process_nps_reach_state.reach_start             NPS_REACH_START of the last successful load, for the page's
--                                                   "Reach data from <date>" label (the setting lives in the ETL only)
--   dim_process_nps_failure_group                   the agreed groups: 131049 + 130472 = "Meta held back", new group
--                                                   131050 "Customer opted out of marketing", phone_format renamed.
--                                                   process_nps upserts the same rows from whatsapp.py on every run.
--
-- Requires 0049 and 0050. Idempotent. Reverse: data/warehouse/down/0051_process_nps_reach_live_down.sql.

SET NAMES utf8mb4;

SET @s = (SELECT IF(COUNT(*) = 0,
    'ALTER TABLE fact_process_nps_message ADD COLUMN deleted_in_source_at DATETIME NULL COMMENT ''UTC; set when the message left the source -- still counted'' AFTER in_reach_scope',
    'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_process_nps_message' AND COLUMN_NAME = 'deleted_in_source_at');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) = 0,
    'ALTER TABLE process_nps_reach_state ADD COLUMN reach_start DATE NULL COMMENT ''NPS_REACH_START of this load (Tripoli date); NULL = all history'' AFTER messages_loaded',
    'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'process_nps_reach_state' AND COLUMN_NAME = 'reach_start');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @now = UTC_TIMESTAMP();
INSERT IGNORE INTO dim_process_nps_failure_group (failure_group, label_en, is_fixable, hint, sort_order, updated_at_utc) VALUES
  ('opted_out_131050', 'Customer opted out of marketing (131050)', 0, 'The customer chose to stop receiving marketing messages from the business on WhatsApp.', 3, @now);

UPDATE dim_process_nps_failure_group SET label_en = 'Meta held back (131049/130472)',
       hint = 'Meta did not deliver the message (healthy ecosystem engagement, or the number is in a Meta experiment); it may succeed later.',
       sort_order = 2, updated_at_utc = @now WHERE failure_group = 'ecosystem_131049';
UPDATE dim_process_nps_failure_group SET sort_order = 4, updated_at_utc = @now WHERE failure_group = 'template_quality';
UPDATE dim_process_nps_failure_group SET label_en = 'Phone number missing or invalid', is_fixable = 1,
       hint = 'The customer has no valid mobile number: add or correct the phone number on the Odoo contact.',
       sort_order = 5, updated_at_utc = @now WHERE failure_group = 'phone_format';
UPDATE dim_process_nps_failure_group SET sort_order = 6, updated_at_utc = @now WHERE failure_group = 'meta_temporary';
UPDATE dim_process_nps_failure_group SET sort_order = 7, updated_at_utc = @now WHERE failure_group = 'other';
