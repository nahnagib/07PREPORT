-- Enterprise ETL Control Center (backend/src/etl orchestration tracking).
--
-- pipeline_run_log/pipeline_run_audit (written by the vendored Python pipeline itself, see
-- 0007_etl_and_audit_log.sql's real-world equivalents) have no concept of BullMQ jobs, Node
-- users, or trigger source -- this table is the Node-side complement, tracking exactly that and
-- correlating with pipeline_run_log for the real extract/load counts once a run touches MySQL.
--
-- Deliberately no columns for inserted/updated/skipped row counts: the vendored pipeline loads
-- via REPLACE/upsert per table, not row-level insert-vs-update-vs-skip accounting, so those
-- numbers don't exist anywhere to store. The API returns null for them; the UI marks them "not
-- tracked by the pipeline" rather than fabricating a number.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS etl_job_runs (
    id                       BIGINT AUTO_INCREMENT PRIMARY KEY,
    job_id                   VARCHAR(64) NULL,
    -- Future-ready: only 'odoo_sync' exists today: a second job type (inventory_sync, crm_sync,
    -- ...) is a new set of buttons/filter values against this same table, not a schema change.
    job_type                 VARCHAR(50) NOT NULL DEFAULT 'odoo_sync',
    mode                     VARCHAR(30) NOT NULL,
    load_mode                VARCHAR(20) NOT NULL,
    output_mode              VARCHAR(10) NOT NULL,
    trigger_source           ENUM('scheduled', 'manual', 'api', 'development') NOT NULL,
    triggered_by_user_id     INT NULL,
    triggered_by_user_name   VARCHAR(150) NULL,
    status                   ENUM('queued', 'running', 'success', 'failed', 'cancelled') NOT NULL DEFAULT 'queued',
    queued_at                TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at               TIMESTAMP NULL,
    finished_at              TIMESTAMP NULL,
    duration_seconds         INT NULL,
    exit_code                INT NULL,
    error_message            TEXT NULL,
    odoo_extract_count       BIGINT NULL,
    db_loaded_count          BIGINT NULL,
    qa_issues_count          BIGINT NULL,
    pipeline_run_log_id      BIGINT NULL,
    FOREIGN KEY (triggered_by_user_id) REFERENCES app_user(user_id),
    INDEX idx_etl_job_runs_status (status, queued_at),
    INDEX idx_etl_job_runs_queued (queued_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
