-- 0049: NPS Score -- WhatsApp message reach and errors (step 2, section 4; docs/nps-etl.md, "Message reach").
--
-- Source: whatsapp_outbound_messages in the NPS MySQL database (the developer is adding it; it does NOT exist on
-- 2026-10-18). Loaded by process_nps only when NPS_REACH_ENABLED=true AND the source table exists; until then these
-- tables stay empty and the page shows "Waiting for the WhatsApp message data". Rules: departments/process/whatsapp.py.
--
--   raw_nps_whatsapp_message          every source column (UTC as stored); mobile_number stays HERE only
--   dim_process_nps_failure_group     the error groups of the developer's "WhatsApp Error Reference" (+ fixable flag)
--   fact_process_nps_message          one row per message: Tripoli date, company (company_name MAJAAL / TIKA, the same
--                                     mapping as the ratings), state, error group, feedback-template / test-number flags
--   v_process_nps_reach               per date x company: Total Reach / Delivered / Not Delivered (state sent) / Read /
--                                     Error / other states, in scope only (feedback template, not a test number, from
--                                     NPS_REACH_START)
--   v_process_nps_message_error       per date x company x error group, in scope only
-- The message table has no delivery, order or customer: reach can only be filtered by date and company.
--
-- Requires 0046. Idempotent. Reverse: data/warehouse/down/0049_process_nps_reach_down.sql.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS raw_nps_whatsapp_message (
    id BIGINT UNSIGNED NOT NULL PRIMARY KEY COMMENT 'whatsapp_outbound_messages.id',
    create_date DATETIME NULL COMMENT 'as stored in the source (UTC, to be verified on profiling)',
    company_name VARCHAR(100) NULL,
    template_name VARCHAR(255) NULL,
    state VARCHAR(30) NULL COMMENT 'delivered / read / sent / error / ...',
    mobile_number VARCHAR(40) NULL COMMENT 'personal data: raw layer only',
    failure_type VARCHAR(100) NULL,
    failure_reason TEXT NULL,
    first_seen_at DATETIME NULL,
    _extracted_at DATETIME NOT NULL, _run_id CHAR(36) NOT NULL, _source_write_date DATETIME NULL COMMENT 'source updated_at',
    _deleted_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS dim_process_nps_failure_group (
    failure_group VARCHAR(32) NOT NULL PRIMARY KEY COMMENT 'departments/process/whatsapp.py FAILURE_GROUPS',
    label_en VARCHAR(64) NOT NULL,
    is_fixable TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'something we can fix (number format, template)',
    hint VARCHAR(255) NOT NULL,
    sort_order SMALLINT NOT NULL,
    updated_at_utc DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS fact_process_nps_message (
    message_id BIGINT UNSIGNED NOT NULL PRIMARY KEY COMMENT 'raw_nps_whatsapp_message.id',
    sent_at_utc DATETIME NULL,
    sent_at_local DATETIME NULL COMMENT 'Africa/Tripoli',
    MessageDateKey INT NOT NULL COMMENT 'Tripoli date of create_date; -1 none',
    CompanyKey BIGINT NOT NULL COMMENT 'company_name MAJAAL -> 1, TIKA -> 3, else -1',
    state VARCHAR(30) NOT NULL COMMENT 'the source state, lower case; "" when empty',
    box VARCHAR(16) NOT NULL COMMENT 'delivered | read | not_delivered (sent) | error | other',
    failure_group VARCHAR(32) NOT NULL COMMENT 'error group for state error; "-" otherwise',
    template_name VARCHAR(255) NULL,
    is_feedback_template TINYINT(1) NOT NULL,
    is_test_number TINYINT(1) NOT NULL,
    in_reach_scope TINYINT(1) NOT NULL COMMENT 'feedback template, not a test number, from NPS_REACH_START',
    loaded_at_utc DATETIME NOT NULL,
    _run_id CHAR(36) NOT NULL,
    INDEX ix_fact_process_nps_message_date (MessageDateKey, CompanyKey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @now = UTC_TIMESTAMP();
INSERT IGNORE INTO dim_process_nps_failure_group (failure_group, label_en, is_fixable, hint, sort_order, updated_at_utc) VALUES
  ('undeliverable_131026', '131026 Undeliverable', 0, 'The number cannot receive the message (not on WhatsApp, old app version, or terms not accepted).', 1, @now),
  ('ecosystem_131049', '131049 Ecosystem engagement', 0, 'Meta did not deliver the marketing message to keep engagement healthy; it may succeed later.', 2, @now),
  ('template_quality', 'Template quality too low', 1, 'The template''s quality rating is too low: improve the template text.', 3, @now),
  ('phone_format', 'phone number wrong format', 1, 'The customer''s mobile number is not in a valid international format: correct it in Odoo.', 4, @now),
  ('meta_temporary', 'Meta temporary error', 0, 'A temporary error on Meta''s side; resending later usually works.', 5, @now),
  ('other', 'Other', 0, 'Any other failure value.', 6, @now),
  ('-', 'Not an error', 0, 'The message did not fail.', 99, @now);

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
