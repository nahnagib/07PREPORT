-- etl_run_log: the persistent, UTC-only source of truth for "Last Refresh" (docs/ETL.md section 9).
--
-- Why a new table instead of pipeline_run_log: that table stores naive DATETIMEs written with the
-- ETL process's own clock (UTC in the Docker container) while the backend read them as Africa/Tripoli,
-- so "Last Refresh" came out 2 hours early and tripped the "Refresh log looks wrong" banner. It also
-- had no data watermark, no run id shared with the pipeline, and was only written after the load, with
-- a failed write downgraded to a warning. pipeline_run_log/pipeline_run_audit stay (Admin -> ETL Runs
-- still reads them); nothing here changes them.
--
-- Conventions
--   * every *_utc column is a UTC wall-clock value, written explicitly by the pipeline from a tz-aware
--     datetime (never CURRENT_TIMESTAMP), so the DB session time_zone cannot skew it;
--   * a row is inserted as 'running' at the start of a run and flipped to 'success' only after the data
--     load and its validation passed, in the same transaction that stores the watermark read back from
--     the loaded Fact_Orders. 'Last Refresh' = MAX(finished_at_utc) WHERE status = 'success';
--   * legacy_backfill = 1 rows were derived from pipeline_run_log by data/etl/scripts/backfill_etl_run_log.py.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS etl_run_log (
    run_id                       BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    run_uid                      CHAR(36) NOT NULL,
    mode                         VARCHAR(20) NOT NULL COMMENT 'full | incremental',
    output_mode                  VARCHAR(10) NULL COMMENT 'sql | both (excel-only runs are not logged)',
    trigger_source               VARCHAR(64) NOT NULL DEFAULT 'unknown' COMMENT 'job label: scheduled-incremental, scheduled-full, manual, cli, ...',
    status                       VARCHAR(20) NOT NULL COMMENT 'running | success | failed',
    started_at_utc               DATETIME NOT NULL,
    finished_at_utc              DATETIME NULL,
    duration_seconds             DOUBLE NULL,
    watermark_order_date_utc     DATETIME NULL COMMENT 'MAX(Fact_Orders.OrderDateTime) after the load, converted to UTC',
    watermark_order_created_utc  DATETIME NULL COMMENT 'MAX(Fact_Orders.QuotationDate) (Odoo create_date) after the load, converted to UTC',
    watermark_order_number       VARCHAR(64) NULL,
    business_timezone            VARCHAR(64) NOT NULL COMMENT 'IANA zone the business fact columns were in when the watermark was converted',
    rows_processed               BIGINT NULL,
    odoo_extract_count           BIGINT NULL,
    qa_issues_count              BIGINT NULL,
    error_message                TEXT NULL,
    legacy_backfill              TINYINT(1) NOT NULL DEFAULT 0,
    pipeline_run_log_id          BIGINT NULL,
    host                         VARCHAR(128) NULL,
    created_at_utc               DATETIME NOT NULL,
    UNIQUE KEY uq_etl_run_log_uid (run_uid),
    INDEX idx_etl_run_log_status_finished (status, finished_at_utc),
    INDEX idx_etl_run_log_started (started_at_utc)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
