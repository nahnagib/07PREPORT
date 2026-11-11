-- 0071: NPS Score -- OFFICIAL manual message reach for 12 Jul - 02 Oct 2026 (docs/nps-etl.md, "Manual reach").
--
-- The WhatsApp source kept no Delivered / Read / Not Delivered messages before NPS_REACH_START (03 Oct 2026), only
-- some of the failed ones. The business approved manual figures for that range (Meta exports + estimates), per
-- company and period; they replace the old automatic weekly estimate and EVERY state the source kept for those days.
--
--   process_nps_reach_manual           one row per company and period, seeded below (the same rows in every
--                                      environment). Written ONLY by migrations: the ETL never writes or
--                                      truncates it (guard: data/etl/tests/test_nps_reach_manual_guard.py).
--   v_process_nps_reach_manual_daily   each period spread evenly over its days, per state: day i of n gets
--                                      FLOOR(v*i/n) - FLOOR(v*(i-1)/n), i.e. FLOOR or CEIL of v/n with the extra units
--                                      spread through the period (largest remainder, equal remainders), so the days
--                                      of a period add up EXACTLY to the row.
--   v_process_nps_reach                + column source: 'etl' (fact_process_nps_message) | 'manual' (Meta export)
--                                      | 'estimate'. 13-31 Aug (meta_manual+estimate): Delivered / Read are the
--                                      estimate, Not Delivered / Error the Meta export. ETL rows of a company and day
--                                      a manual period covers are left out (no double counting).
--   v_process_nps_message_error        + the manual errors as group meta_manual "Unclassified (Meta manual)", + source.
--
-- Requires 0049 and 0051. Idempotent (re-running updates the seeded rows). Reverse:
-- data/warehouse/down/0071_process_nps_reach_manual_down.sql.

SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci; -- the views' text literals (source) in the tables' collation

CREATE TABLE IF NOT EXISTS process_nps_reach_manual (
    CompanyKey BIGINT NOT NULL COMMENT 'dim_company: MAJAAL 1, TIKA 3',
    date_from DATE NOT NULL COMMENT 'first day (Tripoli message date), inclusive',
    date_to DATE NOT NULL COMMENT 'last day, inclusive',
    source VARCHAR(32) NOT NULL COMMENT 'estimate | meta_manual | meta_manual+estimate (Delivered/Read estimated, the rest Meta)',
    delivered INT NOT NULL,
    not_delivered INT NOT NULL,
    read_count INT NOT NULL,
    error_count INT NOT NULL,
    total_reach INT NOT NULL COMMENT 'delivered + not_delivered + read_count + error_count',
    note VARCHAR(500) NULL,
    loaded_at_utc DATETIME NOT NULL,
    PRIMARY KEY (CompanyKey, date_from),
    CONSTRAINT chk_nps_reach_manual_source CHECK (source IN ('estimate', 'meta_manual', 'meta_manual+estimate')),
    CONSTRAINT chk_nps_reach_manual_dates CHECK (date_to >= date_from),
    CONSTRAINT chk_nps_reach_manual_counts CHECK (delivered >= 0 AND not_delivered >= 0 AND read_count >= 0 AND error_count >= 0),
    CONSTRAINT chk_nps_reach_manual_total CHECK (total_reach = delivered + not_delivered + read_count + error_count)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='NPS message reach before NPS_REACH_START, approved manual figures; migrations only, never the ETL';

-- Claude outputs/nps_reach_manual_2026-07-12_to_10-02.csv (approved 2026-11-11). Ratings in the period on the 09 Nov
-- data are in the note, for reconciliation only (the page counts the ratings live).
SET @now = UTC_TIMESTAMP();
INSERT INTO process_nps_reach_manual
  (CompanyKey, date_from, date_to, source, delivered, not_delivered, read_count, error_count, total_reach, note, loaded_at_utc) VALUES
  (1, '2026-07-12', '2026-08-12', 'estimate',             106, 2, 193,  48, 349, 'MAJAAL. Estimate (no Meta export). responders_in_db 67 (09 Nov data)', @now),
  (1, '2026-08-13', '2026-08-31', 'meta_manual+estimate',  74, 0, 136,  14, 224, 'MAJAAL. Meta export; Delivered/Read estimated. responders_in_db 47 (09 Nov data)', @now),
  (1, '2026-09-01', '2026-09-30', 'meta_manual',          126, 2, 231,  57, 416, 'MAJAAL. Meta export. responders_in_db 80 (09 Nov data)', @now),
  (1, '2026-10-01', '2026-10-02', 'meta_manual',            4, 0,   4,   0,   8, 'MAJAAL. Meta export. responders_in_db 4 (09 Nov data)', @now),
  (3, '2026-07-12', '2026-08-12', 'estimate',              47, 3, 107,  27, 184, 'TIKA. Estimate (no Meta export). responders_in_db 37 (09 Nov data)', @now),
  (3, '2026-08-13', '2026-08-31', 'meta_manual+estimate', 142, 4, 322, 206, 674, 'TIKA. Meta export; Delivered/Read estimated. responders_in_db 112 (09 Nov data)', @now),
  (3, '2026-09-01', '2026-09-30', 'meta_manual',          221, 14, 501, 125, 861, 'TIKA. Meta export. responders_in_db 174 (09 Nov data)', @now),
  (3, '2026-10-01', '2026-10-02', 'meta_manual',           10, 1,  30,   5,  46, 'TIKA. Meta export. responders_in_db 11 (09 Nov data)', @now)
ON DUPLICATE KEY UPDATE
  date_to = VALUES(date_to), source = VALUES(source), delivered = VALUES(delivered), not_delivered = VALUES(not_delivered),
  read_count = VALUES(read_count), error_count = VALUES(error_count), total_reach = VALUES(total_reach), note = VALUES(note),
  loaded_at_utc = VALUES(loaded_at_utc);

INSERT INTO dim_process_nps_failure_group (failure_group, label_en, is_fixable, hint, sort_order, updated_at_utc) VALUES
  ('meta_manual', 'Unclassified (Meta manual)', 0,
   'Failed messages from the approved manual reach figures before 03 Oct 2026 (Meta export or estimate): no reason per message.', 98, @now)
ON DUPLICATE KEY UPDATE label_en = VALUES(label_en), hint = VALUES(hint), sort_order = VALUES(sort_order), updated_at_utc = VALUES(updated_at_utc);

-- day i (1..n) of a period: FLOOR(v*i/n) - FLOOR(v*(i-1)/n); the days add up to v exactly
CREATE OR REPLACE VIEW v_process_nps_reach_manual_daily AS
WITH RECURSIVE day_offset (i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM day_offset WHERE i < 366),
spread AS (
  SELECT r.CompanyKey, r.source, DATE_ADD(r.date_from, INTERVAL o.i DAY) AS message_date,
         o.i + 1 AS day_no, DATEDIFF(r.date_to, r.date_from) + 1 AS days,
         r.delivered, r.not_delivered, r.read_count, r.error_count
  FROM process_nps_reach_manual r
  JOIN day_offset o ON o.i <= DATEDIFF(r.date_to, r.date_from)
)
SELECT CAST(DATE_FORMAT(s.message_date, '%Y%m%d') AS SIGNED) AS MessageDateKey, s.CompanyKey, s.source AS manual_source,
       CAST(FLOOR(s.delivered * s.day_no / s.days) - FLOOR(s.delivered * (s.day_no - 1) / s.days) AS SIGNED) AS delivered,
       CAST(FLOOR(s.not_delivered * s.day_no / s.days) - FLOOR(s.not_delivered * (s.day_no - 1) / s.days) AS SIGNED) AS not_delivered,
       CAST(FLOOR(s.read_count * s.day_no / s.days) - FLOOR(s.read_count * (s.day_no - 1) / s.days) AS SIGNED) AS read_count,
       CAST(FLOOR(s.error_count * s.day_no / s.days) - FLOOR(s.error_count * (s.day_no - 1) / s.days) AS SIGNED) AS error_count
FROM spread s;

CREATE OR REPLACE VIEW v_process_nps_reach AS
SELECT m.MessageDateKey, m.CompanyKey, 'etl' AS source,
       COUNT(*) AS total_reach,
       SUM(m.box = 'delivered') AS delivered,
       SUM(m.box = 'not_delivered') AS not_delivered,
       SUM(m.box = 'read') AS read_count,
       SUM(m.box = 'error') AS error_count,
       SUM(m.box = 'other') AS other_state
FROM fact_process_nps_message m
WHERE m.in_reach_scope = 1
  AND NOT EXISTS (SELECT 1 FROM process_nps_reach_manual r WHERE r.CompanyKey = m.CompanyKey
                    AND m.MessageDateKey BETWEEN CAST(DATE_FORMAT(r.date_from, '%Y%m%d') AS SIGNED) AND CAST(DATE_FORMAT(r.date_to, '%Y%m%d') AS SIGNED))
GROUP BY m.MessageDateKey, m.CompanyKey
UNION ALL
SELECT d.MessageDateKey, d.CompanyKey, CASE d.manual_source WHEN 'estimate' THEN 'estimate' ELSE 'manual' END,
       d.delivered + d.not_delivered + d.read_count + d.error_count, d.delivered, d.not_delivered, d.read_count, d.error_count, 0
FROM v_process_nps_reach_manual_daily d WHERE d.manual_source IN ('estimate', 'meta_manual')
UNION ALL
SELECT d.MessageDateKey, d.CompanyKey, 'estimate', d.delivered + d.read_count, d.delivered, 0, d.read_count, 0, 0
FROM v_process_nps_reach_manual_daily d WHERE d.manual_source = 'meta_manual+estimate'
UNION ALL
SELECT d.MessageDateKey, d.CompanyKey, 'manual', d.not_delivered + d.error_count, 0, d.not_delivered, 0, d.error_count, 0
FROM v_process_nps_reach_manual_daily d WHERE d.manual_source = 'meta_manual+estimate';

CREATE OR REPLACE VIEW v_process_nps_message_error AS
SELECT m.MessageDateKey, m.CompanyKey, 'etl' AS source, m.failure_group, g.label_en, g.is_fixable, g.hint, g.sort_order, COUNT(*) AS errors
FROM fact_process_nps_message m
JOIN dim_process_nps_failure_group g ON g.failure_group = m.failure_group
WHERE m.in_reach_scope = 1 AND m.box = 'error'
  AND NOT EXISTS (SELECT 1 FROM process_nps_reach_manual r WHERE r.CompanyKey = m.CompanyKey
                    AND m.MessageDateKey BETWEEN CAST(DATE_FORMAT(r.date_from, '%Y%m%d') AS SIGNED) AND CAST(DATE_FORMAT(r.date_to, '%Y%m%d') AS SIGNED))
GROUP BY m.MessageDateKey, m.CompanyKey, m.failure_group, g.label_en, g.is_fixable, g.hint, g.sort_order
UNION ALL
SELECT d.MessageDateKey, d.CompanyKey, CASE d.manual_source WHEN 'estimate' THEN 'estimate' ELSE 'manual' END,
       g.failure_group, g.label_en, g.is_fixable, g.hint, g.sort_order, d.error_count
FROM v_process_nps_reach_manual_daily d
JOIN dim_process_nps_failure_group g ON g.failure_group = 'meta_manual'
WHERE d.error_count > 0;
