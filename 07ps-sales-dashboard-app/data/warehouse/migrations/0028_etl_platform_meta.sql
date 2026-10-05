-- 0028: meta layer of the ETL platform (data/etl/src/etl_platform, docs/ETL.md).
--
--   etl_run_log           (0022) + job_name, department, parent_run_uid   one row per job run
--   etl_task_log          one row per task: rows extracted/loaded, -1 key fallbacks, watermarks
--   etl_dq_result         one row per data-quality check per run
--   etl_watermark         incremental extraction state per dataset (Odoo write_date + id)
--   etl_dataset_registry  catalogue of registered datasets (synced by the runner at every run)
--
-- Compatibility: etl_run_log only GAINS nullable columns; nothing is renamed or dropped. Existing readers
-- (backend measures/refreshStatus.ts "Last Refresh", data/etl/scripts/backfill_etl_run_log.py, the legacy
-- sales_pipeline writer) keep working unchanged. Rows written before this migration are backfilled as
-- department 'sales' with job_name sales_full / sales_incremental from their mode.
--
-- Idempotent: safe to apply more than once (CREATE ... IF NOT EXISTS, guarded ALTERs, backfill only touches
-- rows whose department is still NULL). Reverse: data/warehouse/down/0028_etl_platform_meta_down.sql.
-- Timestamps: every *_utc column is UTC, written explicitly by the platform (never CURRENT_TIMESTAMP).

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------------------------------------------
-- etl_run_log: job_name / department / parent_run_uid
-- ---------------------------------------------------------------------------------------------------------
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE etl_run_log ADD COLUMN job_name VARCHAR(64) NULL COMMENT ''registered job (etl_platform), e.g. core_dims, sales_incremental, finance_receivables''', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'etl_run_log' AND COLUMN_NAME = 'job_name');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE etl_run_log ADD COLUMN department VARCHAR(32) NULL COMMENT ''core | sales | finance | ... (freshness is reported per department)''', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'etl_run_log' AND COLUMN_NAME = 'department');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE etl_run_log ADD COLUMN parent_run_uid CHAR(36) NULL COMMENT ''run_uid of the job that ran this one as a dependency''', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'etl_run_log' AND COLUMN_NAME = 'parent_run_uid');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE etl_run_log ADD INDEX idx_etl_run_log_dept_status_finished (department, status, finished_at_utc)', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'etl_run_log' AND INDEX_NAME = 'idx_etl_run_log_dept_status_finished');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE etl_run_log ADD INDEX idx_etl_run_log_job_status_finished (job_name, status, finished_at_utc)', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'etl_run_log' AND INDEX_NAME = 'idx_etl_run_log_job_status_finished');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

UPDATE etl_run_log
   SET department = 'sales',
       job_name = CASE WHEN mode = 'full' THEN 'sales_full' ELSE 'sales_incremental' END
 WHERE department IS NULL;

-- ---------------------------------------------------------------------------------------------------------
-- etl_task_log
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS etl_task_log (
    task_log_id            BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    run_uid                CHAR(36) NOT NULL COMMENT 'etl_run_log.run_uid (no row there for diagnostic jobs)',
    job_name               VARCHAR(64) NOT NULL,
    task_name              VARCHAR(128) NOT NULL,
    status                 VARCHAR(20) NOT NULL COMMENT 'running | success | failed',
    started_at_utc         DATETIME NOT NULL,
    finished_at_utc        DATETIME NULL,
    duration_seconds       DOUBLE NULL,
    rows_extracted         BIGINT NULL,
    rows_loaded            BIGINT NULL,
    unknown_key_fallbacks  BIGINT NULL COMMENT 'fact rows that fell back to a -1 dimension member',
    fallback_detail        JSON NULL COMMENT '{key: {count, sample_ids}}',
    watermark_before       JSON NULL,
    watermark_after        JSON NULL,
    details                JSON NULL,
    error_message          TEXT NULL,
    INDEX idx_etl_task_log_run (run_uid),
    INDEX idx_etl_task_log_task_started (task_name, started_at_utc)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------------------------------------
-- etl_dq_result
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS etl_dq_result (
    dq_result_id    BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    run_uid         CHAR(36) NOT NULL,
    job_name        VARCHAR(64) NOT NULL,
    task_name       VARCHAR(128) NULL,
    check_name      VARCHAR(160) NOT NULL,
    check_type      VARCHAR(32) NOT NULL COMMENT 'not_null | unique | orphan | min_rows | row_count_change | metric_change | reconciliation | custom_sql',
    severity        VARCHAR(8) NOT NULL COMMENT 'warn | fail',
    target_table    VARCHAR(128) NULL,
    status          VARCHAR(8) NOT NULL COMMENT 'pass | warn | fail',
    observed_value  DOUBLE NULL,
    threshold       DOUBLE NULL,
    failing_rows    BIGINT NULL,
    sample          JSON NULL COMMENT 'up to 20 offending keys/rows',
    message         TEXT NULL,
    checked_at_utc  DATETIME NOT NULL,
    INDEX idx_etl_dq_result_run (run_uid),
    INDEX idx_etl_dq_result_check_time (check_name, checked_at_utc),
    INDEX idx_etl_dq_result_status_time (status, checked_at_utc)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------------------------------------
-- etl_watermark
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS etl_watermark (
    dataset                VARCHAR(128) NOT NULL PRIMARY KEY,
    last_write_date_utc    DATETIME NULL COMMENT 'max source write_date loaded (Odoo stores UTC)',
    last_id                BIGINT NULL COMMENT 'tie-breaker: max id at last_write_date_utc',
    last_full_refresh_utc  DATETIME NULL,
    last_reconciled_utc    DATETIME NULL COMMENT 'last deleted/archived-id reconciliation',
    updated_at_utc         DATETIME NOT NULL,
    updated_by_run_uid     CHAR(36) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------------------------------------
-- etl_dataset_registry
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS etl_dataset_registry (
    dataset               VARCHAR(128) NOT NULL PRIMARY KEY,
    department            VARCHAR(32) NOT NULL,
    layer                 VARCHAR(16) NOT NULL COMMENT 'raw | core | mart | serving',
    source                VARCHAR(16) NOT NULL COMMENT 'odoo | excel | sql',
    source_object         VARCHAR(255) NULL COMMENT 'Odoo model or file:sheet',
    target_table          VARCHAR(128) NOT NULL,
    load_pattern          VARCHAR(32) NOT NULL COMMENT 'upsert | replace | swap | snapshot_replace | append',
    natural_key           JSON NOT NULL,
    incremental_field     VARCHAR(64) NULL,
    definition_hash       CHAR(64) NOT NULL,
    first_registered_utc  DATETIME NOT NULL,
    updated_at_utc        DATETIME NOT NULL,
    INDEX idx_etl_dataset_registry_dept (department)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
