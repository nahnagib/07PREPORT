-- Closes the two gaps the Phase 1 Database Review (Standards Section 6.3/6.4) flagged as
-- blocking for Tachometer and Critical Number - Target/Plan and Calendar - now built from the
-- REAL export rather than assumed-missing. See ../README.md "Corrected findings" section for
-- the full explanation; short version:
--
--   1. Target/Plan: Fact_Targets ALREADY EXISTS in the real system as a governed, monthly,
--      salesperson-grain fact (616 rows, Year/Month/Company/SalesTeam/Salesperson/Segment/
--      Channel + Target_Revenue/Target_Volume/ASP_LY/ASP_ThisYear). The Standards doc's
--      assumption that targets "live in Excel inputs" is WRONG as of this export - this is a
--      structured fact table already. Renamed/conformed here to fact_target_plan; no new
--      modeling work was actually required to close this gap, just adoption.
--
--   2. Calendar: PARTIALLY already closed. dim_date (0001) already carries is_weekly_rest_day
--      straight from the source Dim_Date sheet. What's still genuinely missing is the
--      company/branch-specific holiday and forced-closure exceptions - Fact_OffDays (21 rows)
--      covers this, but at a grain dim_date can't hold directly (a date can be a working day for
--      Majaal and a forced closure for Tika's branch). Modeled here as its own exception table
--      rather than flattened into dim_date, which is the grain-correct design.
--
-- Corrected finding: Fact_OffDays' "Branch" column contains sales_team_key-formatted values
-- (e.g. 'TK-BEN-BC-03'), not a distinct Branch/Location entity - there is no separate
-- Branch/Location dimension anywhere in this export. FK'd to dim_sales_team, not a new dimension.

SET NAMES utf8mb4;

CREATE TABLE fact_target_plan (
    target_id                INT AUTO_INCREMENT PRIMARY KEY,
    date_key                    INT NOT NULL,
    target_grain                 ENUM('SALESPERSON') NOT NULL DEFAULT 'SALESPERSON',
    company_key                    SMALLINT NULL,
    sales_team_key                   VARCHAR(20) NULL,
    salesperson_key                    INT NOT NULL,
    segment_key                          SMALLINT NOT NULL,
    channel_key                            SMALLINT NOT NULL,
    currency                                CHAR(3) NOT NULL DEFAULT 'LYD',
    target_revenue                           DECIMAL(16, 2) NOT NULL,
    target_volume                             DECIMAL(16, 3) NULL,
    asp_last_year                              DECIMAL(14, 4) NULL,
    asp_this_year                               DECIMAL(14, 4) NULL,
    FOREIGN KEY (date_key) REFERENCES dim_date(date_key),
    FOREIGN KEY (company_key) REFERENCES dim_company(company_key),
    FOREIGN KEY (sales_team_key) REFERENCES dim_sales_team(sales_team_key),
    FOREIGN KEY (salesperson_key) REFERENCES dim_salesperson(salesperson_key),
    FOREIGN KEY (segment_key) REFERENCES dim_segment(segment_key),
    FOREIGN KEY (channel_key) REFERENCES dim_distribution_channel(channel_key),
    -- REMOVED 2026-07-05 (checked directly against the real SalesModel_OneOutput.xlsx
    -- Fact_Targets sheet, 616 rows - not the mocked-Odoo test load): the original
    -- uq_target_grain (date_key, salesperson_key, segment_key, channel_key) unique key assumed
    -- salesperson_key discriminates rows. Correction to an earlier draft of this note - real
    -- SalespersonKey is NOT uniformly 0; it takes 34 distinct values across the 616 rows and
    -- resolves to a real individual salesperson most of the time. The constraint still doesn't
    -- hold, for a narrower reason: 0 ("unresolved") is a shared fallback bucket that multiple
    -- DIFFERENT named salespeople collapse into in the same month (e.g. 'Ahmed Mrajea', 'Yousef
    -- Misrata', 'Sales Person 4' all carry SalespersonKey=0 for 2026-01), producing 12 real
    -- (date_key, 0, segment_key, channel_key) collisions. A 13th collision is unrelated: 12 rows
    -- for team TK-WST-BB / salesperson 'Mohamed Abdulhady' (a real, resolved SalespersonKey=40)
    -- all carry TargetDate = 1970-01-01 (Unix epoch) despite valid, distinct Year/Month values -
    -- a source-data quality defect in sales_targets.xlsx (the date field never got computed for
    -- that team), not a modeling issue; flagged in ../ingestion/README.md for the data owner.
    -- Even (date_key, sales_team_key, segment_key, channel_key) only reduces 616 rows to 337
    -- distinct combinations, so there is genuinely no natural key available in this source data.
    -- Loading relies on target_id as the only key; a full-refresh load (delete-then-insert, this
    -- table's documented loading strategy) is what keeps this table from silently accumulating
    -- duplicates run over run, not a uniqueness constraint at the database layer.
    INDEX idx_fact_target_plan_date (date_key),
    INDEX idx_fact_target_plan_team (sales_team_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE fact_calendar_exception (
    exception_id             INT AUTO_INCREMENT PRIMARY KEY,
    date_key                    INT NOT NULL,
    off_day_type                 ENUM('official', 'unexpected') NOT NULL,
    country                        VARCHAR(50) NOT NULL DEFAULT 'Libya',
    company_key                     SMALLINT NULL,
    sales_team_key                   VARCHAR(20) NULL,
    is_active                       BOOLEAN NOT NULL DEFAULT TRUE,
    holiday_name                      VARCHAR(255) NULL,
    reason                              VARCHAR(255) NULL,
    source                                VARCHAR(100) NULL,
    notes                                   VARCHAR(500) NULL,
    FOREIGN KEY (date_key) REFERENCES dim_date(date_key),
    FOREIGN KEY (company_key) REFERENCES dim_company(company_key),
    FOREIGN KEY (sales_team_key) REFERENCES dim_sales_team(sales_team_key),
    INDEX idx_fact_calendar_exception_date (date_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
