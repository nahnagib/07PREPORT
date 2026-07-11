-- Found during the Tachometer KPI measures/validation session (2026-07-05), while wiring
-- FY/FM Target queries against fact_target_plan.
--
-- fact_target_plan only persisted date_key as its period identifier (see 0004). FY/FM Target
-- aggregation needs to filter by calendar year/month, which was being done via date_key ranges or
-- a dim_date join. That silently breaks for the 12 known-bad TK-WST-BB rows documented in
-- ../../ingestion/KNOWN_ISSUES.md: their date_key is 19700101 (source TargetDate defect), so any
-- year/month filter driven by date_key resolves them to year 1970 and drops them from every real
-- calendar year's FY/FM Target total - even though their Target_Revenue/Target_Volume figures and
-- their Year/Month source columns are completely valid and distinct per month.
--
-- The source Fact_Targets sheet already carries valid Year/Month columns for every row, including
-- these 12 - they just weren't persisted alongside date_key. Adding them here so period-based
-- target aggregation has a source that doesn't depend on the one column known to be broken for
-- this team. This is not a workaround for the bad date (that stays broken, unpatched, as decided) -
-- it's persisting a second, independently-valid column that was already being read out of the
-- sheet and simply wasn't kept. date_key is left as-is and still used for calendar FK integrity/
-- dim_date joins where that's actually needed (e.g. a specific-day drill-down), just not for
-- year/month period filtering.

SET NAMES utf8mb4;

ALTER TABLE fact_target_plan
    ADD COLUMN target_year  SMALLINT NOT NULL AFTER date_key,
    ADD COLUMN target_month TINYINT  NOT NULL AFTER target_year,
    ADD INDEX idx_fact_target_plan_year_month (target_year, target_month);
