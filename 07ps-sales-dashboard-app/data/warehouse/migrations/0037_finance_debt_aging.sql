-- 0037: Finance -- Debt Report "Aging Map" settings (decisions of 2026-10-06).
--
-- The Aging Map (backend measures/debtAging.ts, GET /debt-report/aging) places each customer by the age of its oldest
-- open invoice measured against that invoice's own payment term. Everything it needs to know that is not in Odoo lives
-- in these three tables; edit the rows to change the map, no code change:
--
-- 1. cfg_finance_payment_term_days: the term length in days per Odoo payment term (PaymentTermKey = Odoo
--    account.payment.term.id). Never parsed from the label (labels are inconsistent: "180 Day", "90 days", Arabic).
--    A term without a row here counts as "no term": the map then falls back to the invoice's own due date
--    (due_date - invoice_date), and only without that to "Missing term" (0 days).
-- 2. cfg_finance_aging_zone: the zones in order. Zone i runs up to upper_multiplier x W days of invoice age, where
--    W = max(term_days, min_step); the last zone (upper_multiplier NULL) is everything beyond. Owner and action are
--    the texts the page shows.
-- 3. cfg_finance_aging_setting: min_step (W for short / zero terms, e.g. Immediate Payment) and
--    escalation_window_days (a customer this close to the next zone is "about to escalate").
--
-- Seeded keys are the Odoo ids in dim_payment_term (one Odoo database for every environment). Idempotent (INSERT
-- IGNORE keeps edited rows). Reverse: data/warehouse/down/0037_finance_debt_aging_down.sql.

SET NAMES utf8mb4;

-- 1. term length per payment term -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cfg_finance_payment_term_days (
    PaymentTermKey BIGINT NOT NULL PRIMARY KEY COMMENT 'dim_payment_term (Odoo account.payment.term.id)',
    term_days INT NOT NULL COMMENT 'days from the invoice date to the due date',
    note VARCHAR(255) NULL COMMENT 'the Odoo label when seeded, for whoever edits the row',
    updated_at_utc DATETIME NOT NULL,
    CONSTRAINT ck_cfg_finance_payment_term_days CHECK (term_days >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @now = UTC_TIMESTAMP();
INSERT IGNORE INTO cfg_finance_payment_term_days (PaymentTermKey, term_days, note, updated_at_utc) VALUES
  (1, 0, 'Immediate Payment', @now),
  (9, 7, 'خلال اسبوع', @now),
  (2, 15, '15 Days', @now),
  (3, 21, '21 Days', @now),
  (4, 30, '30 Days', @now),
  (5, 45, '45 Days', @now),
  (6, 60, '60 Days', @now),
  (14, 90, '90 days', @now),
  (13, 180, '180 Day', @now),
  (7, 45, 'End of Following Month (decision 2026-10-06)', @now),
  (10, 0, 'سداد 50 % مقدما و 50% قبل الشحن (decision 2026-10-06)', @now),
  (11, 40, '30 days End of Month on the 10th (decision 2026-10-06)', @now),
  (12, 30, '2/7 Net 30 (decision 2026-10-06)', @now),
  (8, 60, '30% Now, Balance 60 Days (decision 2026-10-06)', @now);

-- 2. zones -------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cfg_finance_aging_zone (
    zone_key VARCHAR(16) NOT NULL PRIMARY KEY COMMENT 'green | yellow | red | black (the page colours by key)',
    sort_order TINYINT NOT NULL,
    label_en VARCHAR(64) NOT NULL,
    upper_multiplier DECIMAL(6,3) NULL COMMENT 'zone ends at this x W days of invoice age; NULL = the last zone, no end',
    owner_en VARCHAR(128) NOT NULL,
    action_en VARCHAR(255) NOT NULL,
    updated_at_utc DATETIME NOT NULL,
    UNIQUE KEY uq_cfg_finance_aging_zone_order (sort_order),
    CONSTRAINT ck_cfg_finance_aging_zone_mult CHECK (upper_multiplier IS NULL OR upper_multiplier > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO cfg_finance_aging_zone (zone_key, sort_order, label_en, upper_multiplier, owner_en, action_en, updated_at_utc) VALUES
  ('green', 1, 'Green', 1, 'Sales rep', 'Within term. Remind the customer before the due date', @now),
  ('yellow', 2, 'Yellow', 2, 'Sales director', 'Director call. New sales on hold', @now),
  ('red', 3, 'Red', 3, 'Management', 'Formal demand letter. Credit stopped', @now),
  ('black', 4, 'Black', NULL, 'Legal', 'Case handed to the lawyer', @now);

-- 3. scalar settings ---------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cfg_finance_aging_setting (
    setting_key VARCHAR(64) NOT NULL PRIMARY KEY,
    value_num DECIMAL(12,3) NOT NULL,
    note VARCHAR(255) NULL,
    updated_at_utc DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO cfg_finance_aging_setting (setting_key, value_num, note, updated_at_utc) VALUES
  ('min_step', 7, 'W = max(term_days, min_step): the zone length for short or zero terms (Immediate Payment)', @now),
  ('escalation_window_days', 7, 'a customer reaching the next zone within this many days is "about to escalate"', @now);
