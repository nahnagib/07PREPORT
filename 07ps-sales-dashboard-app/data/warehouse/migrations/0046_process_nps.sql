-- 0046: Process department -- NPS Score (decisions of 2026-10-18; docs/nps-etl.md).
--
-- Source: the MySQL database of the NPS developer (NPS_DB_NAME, default xtremech_nps_dashboard), read through an SSH
-- tunnel by the ETL job process_nps ONLY. The backend and the frontend never connect to it; they read the v_process_nps_*
-- views below.
--
-- 1. Raw (every source column; timestamps as stored there = UTC):
--      raw_nps_rating       <- nps_rating_full_data (every rating / comment message)
--      raw_nps_low_rating   <- low_rating_data (the messages of deliveries rated "below", copied by the developer's
--                              script; same ids as raw_nps_rating) + team_branch and the e-mail escalation columns
--      raw_nps_sync_state   <- sync_state (the developer's own sync bookkeeping; read for freshness, never written)
--    The source is reloaded as a whole by the developer's script (updated_at is the same on every row), so there is no
--    watermark: every run reads both tables completely (D7), upserts by id, and stamps _deleted_at on ids that are no
--    longer in the source (cleared again if they come back). Mobile numbers and e-mail addresses live here only (D6).
-- 2. Mart (rebuilt by every run, one transaction):
--      dim_process_nps_level      the 3 rating levels (our labels, en + ar; departments/process/nps.py)
--      fact_process_nps_response  one row per RATING message (one delivery's rating)
--      fact_process_nps_comment   one row per free-text message, linked to its delivery's rating (-1 when none);
--                                 phone numbers and e-mails masked
-- 3. Serving: v_process_nps_response, v_process_nps_comment, v_process_nps_summary (per day / company / team /
--    salesperson / customer), v_process_nps_trend (per month / company), v_process_nps_low_rating.
--    NPS-style (3-level) = (exceeded - below) / responses x 100, computed from COUNTS: sum the counts first, never
--    average the per-row score.
--
-- Requires 0029 (core dimensions), 0031 (dim_sales_order). Idempotent. Reverse: data/warehouse/down/0046_process_nps_down.sql.

SET NAMES utf8mb4;

-- 1. raw ------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw_nps_rating (
    id BIGINT NOT NULL PRIMARY KEY COMMENT 'nps_rating_full_data.id',
    create_date DATETIME NULL COMMENT 'UTC (as stored in the source)',
    company_id BIGINT NULL COMMENT 'NOT a res.company id: the WhatsApp account of the developer script; never used',
    company_name VARCHAR(255) NULL,
    created_id BIGINT NULL,
    created_name VARCHAR(255) NULL,
    mobile_number VARCHAR(50) NULL COMMENT 'personal data: raw layer only',
    delivery_code VARCHAR(100) NULL COMMENT 'the rated document (normally the delivery picking name)',
    body TEXT NULL COMMENT 'the rating answer or a free-text comment (HTML)',
    failure_type VARCHAR(100) NULL,
    failure_reason VARCHAR(255) NULL,
    order_id VARCHAR(50) NULL COMMENT 'sale.order name',
    scheduled_date DATETIME NULL COMMENT 'UTC; the delivery scheduled date',
    partner_id BIGINT NULL COMMENT 'Odoo res.partner id',
    partner_name VARCHAR(255) NULL,
    salesperson_id BIGINT NULL COMMENT 'Odoo res.users id',
    salesperson_name VARCHAR(255) NULL,
    team_id BIGINT NULL COMMENT 'Odoo crm.team id',
    team_name VARCHAR(255) NULL,
    _extracted_at DATETIME NOT NULL, _run_id CHAR(36) NOT NULL, _source_write_date DATETIME NULL, _deleted_at DATETIME NULL,
    INDEX ix_raw_nps_rating_create (create_date),
    INDEX ix_raw_nps_rating_delivery (delivery_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS raw_nps_low_rating (
    id BIGINT NOT NULL PRIMARY KEY COMMENT 'low_rating_data.id (= raw_nps_rating.id)',
    create_date DATETIME NULL COMMENT 'UTC',
    company_id BIGINT NULL COMMENT 'never used (see raw_nps_rating)',
    company_name VARCHAR(255) NULL,
    created_id BIGINT NULL,
    created_name VARCHAR(255) NULL,
    mobile_number VARCHAR(50) NULL COMMENT 'personal data: raw layer only',
    delivery_code VARCHAR(100) NULL,
    body TEXT NULL,
    failure_type VARCHAR(100) NULL,
    failure_reason VARCHAR(255) NULL,
    order_id VARCHAR(50) NULL,
    scheduled_date DATETIME NULL COMMENT 'UTC',
    partner_id BIGINT NULL,
    partner_name VARCHAR(255) NULL,
    salesperson_id BIGINT NULL,
    salesperson_name VARCHAR(255) NULL,
    team_id BIGINT NULL,
    team_name VARCHAR(255) NULL,
    team_branch VARCHAR(255) NULL COMMENT 'B2B / B2C',
    recipient_email VARCHAR(255) NULL COMMENT 'personal data: raw layer only',
    email_notification VARCHAR(50) NULL,
    notification_date DATETIME NULL,
    _extracted_at DATETIME NOT NULL, _run_id CHAR(36) NOT NULL, _source_write_date DATETIME NULL, _deleted_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS raw_nps_sync_state (
    source VARCHAR(255) NOT NULL PRIMARY KEY,
    last_successful_sync DATETIME NULL COMMENT 'as stored in the source',
    _extracted_at DATETIME NOT NULL, _run_id CHAR(36) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. mart -----------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dim_process_nps_level (
    nps_level TINYINT NOT NULL PRIMARY KEY COMMENT '3 exceeded, 2 met, 1 below (departments/process/nps.py)',
    level_key VARCHAR(16) NOT NULL,
    source_text VARCHAR(64) NOT NULL COMMENT 'the developer''s exact answer text',
    label_en VARCHAR(64) NOT NULL COMMENT 'our own label (not an Odoo field)',
    label_ar VARCHAR(64) NOT NULL,
    is_low_rating TINYINT(1) NOT NULL DEFAULT 0,
    sort_order SMALLINT NOT NULL,
    updated_at_utc DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @now = UTC_TIMESTAMP();
INSERT IGNORE INTO dim_process_nps_level (nps_level, level_key, source_text, label_en, label_ar, is_low_rating, sort_order, updated_at_utc) VALUES
  (3, 'exceeded', 'فاقت التوقعات', 'Exceeded expectations', 'فاقت التوقعات', 0, 1, @now),
  (2, 'met', 'في مستوى التوقعات', 'Met expectations', 'في مستوى التوقعات', 0, 2, @now),
  (1, 'below', 'أقل من المتوقع', 'Below expectations', 'أقل من المتوقع', 1, 3, @now);

CREATE TABLE IF NOT EXISTS fact_process_nps_response (
    response_id BIGINT NOT NULL PRIMARY KEY COMMENT 'raw_nps_rating.id of the rating message',
    delivery_code VARCHAR(100) NULL,
    order_ref VARCHAR(50) NULL COMMENT 'the source order_id text',
    rated_at_utc DATETIME NULL,
    rated_at_local DATETIME NULL COMMENT 'Africa/Tripoli',
    RatingDateKey INT NOT NULL COMMENT 'local date of the rating (create_date)',
    DeliveryDateKey INT NOT NULL COMMENT 'local date of scheduled_date; -1 none',
    CompanyKey BIGINT NOT NULL,
    company_source VARCHAR(16) NOT NULL COMMENT 'order | delivery | company_name | none',
    CustomerKey BIGINT NOT NULL,
    SalespersonKey INT NOT NULL,
    SalesTeamKey VARCHAR(64) NOT NULL,
    SegmentKey INT NOT NULL,
    ChannelKey INT NOT NULL,
    SalesOrderKey BIGINT NOT NULL COMMENT 'Odoo sale.order id; -1 no match',
    nps_level TINYINT NOT NULL,
    is_low_rating TINYINT(1) NOT NULL,
    in_low_rating_table TINYINT(1) NOT NULL COMMENT 'the id is in the source low_rating_data',
    team_branch VARCHAR(255) NULL COMMENT 'from low_rating_data',
    has_comment TINYINT(1) NOT NULL DEFAULT 0,
    loaded_at_utc DATETIME NOT NULL,
    _run_id CHAR(36) NOT NULL,
    INDEX ix_fact_process_nps_response_date (RatingDateKey),
    INDEX ix_fact_process_nps_response_company (CompanyKey, RatingDateKey),
    INDEX ix_fact_process_nps_response_salesperson (SalespersonKey, RatingDateKey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS fact_process_nps_comment (
    comment_id BIGINT NOT NULL PRIMARY KEY COMMENT 'raw_nps_rating.id of the comment message',
    response_id BIGINT NOT NULL COMMENT 'the rating of the same delivery; -1 none',
    delivery_code VARCHAR(100) NULL,
    commented_at_utc DATETIME NULL,
    commented_at_local DATETIME NULL,
    CommentDateKey INT NOT NULL,
    CompanyKey BIGINT NOT NULL,
    CustomerKey BIGINT NOT NULL,
    SalespersonKey INT NOT NULL,
    SalesTeamKey VARCHAR(64) NOT NULL,
    SegmentKey INT NOT NULL,
    ChannelKey INT NOT NULL,
    comment_text TEXT NOT NULL COMMENT 'plain text, phone numbers and e-mails masked',
    loaded_at_utc DATETIME NOT NULL,
    _run_id CHAR(36) NOT NULL,
    INDEX ix_fact_process_nps_comment_date (CommentDateKey),
    INDEX ix_fact_process_nps_comment_response (response_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. serving --------------------------------------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_process_nps_response AS
SELECT f.response_id, f.delivery_code, f.order_ref, f.rated_at_utc, f.rated_at_local, f.RatingDateKey,
       DATE(f.rated_at_local) AS rating_date, f.DeliveryDateKey,
       CASE WHEN f.DeliveryDateKey > 0 THEN STR_TO_DATE(CAST(f.DeliveryDateKey AS CHAR), '%Y%m%d') END AS delivery_date,
       f.CompanyKey, c.Company AS company, f.company_source, f.CustomerKey, cu.customer, f.SalespersonKey, sp.salesperson,
       f.SalesTeamKey, st.SalesTeam AS sales_team, f.SegmentKey, sg.Segment AS segment, f.ChannelKey, f.SalesOrderKey,
       f.nps_level, l.level_key, l.label_en, l.label_ar,
       CASE WHEN f.nps_level = 3 THEN 1 ELSE 0 END AS is_exceeded,
       CASE WHEN f.nps_level = 2 THEN 1 ELSE 0 END AS is_met,
       CASE WHEN f.nps_level = 1 THEN 1 ELSE 0 END AS is_below,
       f.is_low_rating, f.in_low_rating_table, f.team_branch, f.has_comment
FROM fact_process_nps_response f
JOIN dim_process_nps_level l ON l.nps_level = f.nps_level
LEFT JOIN dim_company c ON c.CompanyKey = f.CompanyKey
LEFT JOIN dim_customer cu ON cu.CustomerKey = f.CustomerKey
LEFT JOIN dim_salesperson sp ON sp.SalespersonKey = f.SalespersonKey
LEFT JOIN dim_sales_team st ON st.SalesTeamKey = f.SalesTeamKey
LEFT JOIN dim_segment sg ON sg.SegmentKey = f.SegmentKey;

-- comments (personal free text, phones and e-mails masked): whatever reads this view must show it only to permitted roles
CREATE OR REPLACE VIEW v_process_nps_comment AS
SELECT m.comment_id, m.response_id, m.delivery_code, m.commented_at_local, m.CommentDateKey,
       DATE(m.commented_at_local) AS comment_date, m.CompanyKey, c.Company AS company, m.CustomerKey, cu.customer,
       m.SalespersonKey, sp.salesperson, m.SalesTeamKey, st.SalesTeam AS sales_team, m.SegmentKey, m.ChannelKey,
       r.nps_level, l.level_key, l.label_en, l.label_ar, m.comment_text
FROM fact_process_nps_comment m
LEFT JOIN fact_process_nps_response r ON r.response_id = m.response_id
LEFT JOIN dim_process_nps_level l ON l.nps_level = r.nps_level
LEFT JOIN dim_company c ON c.CompanyKey = m.CompanyKey
LEFT JOIN dim_customer cu ON cu.CustomerKey = m.CustomerKey
LEFT JOIN dim_salesperson sp ON sp.SalespersonKey = m.SalespersonKey
LEFT JOIN dim_sales_team st ON st.SalesTeamKey = m.SalesTeamKey;

CREATE OR REPLACE VIEW v_process_nps_summary AS
SELECT f.RatingDateKey, f.CompanyKey, f.SalesTeamKey, f.SalespersonKey, f.SegmentKey, f.ChannelKey, f.CustomerKey,
       COUNT(*) AS responses,
       SUM(f.nps_level = 3) AS exceeded, SUM(f.nps_level = 2) AS met, SUM(f.nps_level = 1) AS below,
       SUM(f.has_comment) AS with_comment,
       ROUND(100 * (SUM(f.nps_level = 3) - SUM(f.nps_level = 1)) / COUNT(*), 1) AS nps_style
FROM fact_process_nps_response f
GROUP BY f.RatingDateKey, f.CompanyKey, f.SalesTeamKey, f.SalespersonKey, f.SegmentKey, f.ChannelKey, f.CustomerKey;

CREATE OR REPLACE VIEW v_process_nps_trend AS
SELECT FLOOR(f.RatingDateKey / 100) AS rating_month, f.CompanyKey,
       COUNT(*) AS responses,
       SUM(f.nps_level = 3) AS exceeded, SUM(f.nps_level = 2) AS met, SUM(f.nps_level = 1) AS below,
       ROUND(100 * (SUM(f.nps_level = 3) - SUM(f.nps_level = 1)) / COUNT(*), 1) AS nps_style
FROM fact_process_nps_response f
GROUP BY FLOOR(f.RatingDateKey / 100), f.CompanyKey;

CREATE OR REPLACE VIEW v_process_nps_low_rating AS
SELECT * FROM v_process_nps_response WHERE is_low_rating = 1;
