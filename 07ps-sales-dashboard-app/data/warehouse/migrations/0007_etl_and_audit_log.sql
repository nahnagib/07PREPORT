-- ETL refresh/audit logging (Standards Section 3.19/5.11 - Last Update / Last Refresh Time,
-- 5x-daily schedule; Section 5.12 - audit trail) + a data-quality-log replacement for the
-- source export's QA_* summary sheets (Section 5.11).
--
-- REVISED 2026-07-05 (Odoo + Manual Input ingestion session): the original version of this
-- file defined placeholder etl_refresh_log/data_quality_log tables designed blind, before the
-- existing powerbi_sales_pipeline codebase (the pipeline that actually produces
-- SalesModel_OneOutput.xlsx) had been read. That pipeline already has a working, in-production
-- run-log/audit design - pipeline_run_log + pipeline_run_audit + pipeline_load_metadata,
-- defined in database_exporter.py's _ensure_run_log_table/_ensure_run_audit_table/
-- _ensure_load_metadata_table (CREATE TABLE IF NOT EXISTS, so the pipeline itself can keep
-- creating them unmodified if ever pointed at this schema directly). Per this session's explicit
-- direction ("reuse this pipeline's logic rather than re-deriving already-proven rules"), those
-- three tables are adopted here VERBATIM (column-for-column) rather than kept as a
-- differently-shaped parallel design - two logging schemas for the same one pipeline would be
-- confusing and would fork which table dashboards/ops scripts should trust.
--
-- data_quality_log is retained (not part of the vendored pipeline's own schema) because it fills
-- a real gap: a governed home for the source export's CHECK-LEVEL QA summary sheets
-- (QA_CRM_DataQuality, QA_Inventory_DataQuality, QA_ProductMappingChecks - all three share an
-- identical CheckName/MetricValue/Status/Notes shape). Its foreign key now points at
-- pipeline_run_log.run_id instead of the removed etl_refresh_log.refresh_id.
--
-- Still excluded (see ../README.md for full reasoning): QA_CRM_MissingLinks,
-- QA_CRM_UnmappedKeys, QA_CRM_FieldAvailability, QA_Inventory_UnmappedProducts are ROW-LEVEL
-- pipeline diagnostics (thousands of individual unmapped-key incidents) - these belong in the
-- ETL tool's own logging/monitoring output, not the warehouse.

SET NAMES utf8mb4;

-- Adopted verbatim from sales_pipeline/export/database_exporter.py::_ensure_run_log_table.
-- One row per pipeline run (matches PipelineRunResult / run_context timing fields).
CREATE TABLE pipeline_run_log (
    run_id                       BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    scheduled_refresh_time       TEXT NULL,
    pipeline_start_time          DATETIME NULL,
    pipeline_end_time            DATETIME NULL,
    total_duration_minutes       DOUBLE NULL,
    status                       TEXT NOT NULL,
    error_message                TEXT NULL,
    odoo_extract_count           BIGINT NULL,
    db_loaded_count              BIGINT NULL,
    qa_issues_count              BIGINT NULL,
    created_at                   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Adopted verbatim from database_exporter.py::_ensure_run_audit_table. One row per SQL-load
-- run; tracks the incremental watermark (latest_order_number/datetime before/after) so the next
-- incremental run knows where it left off.
CREATE TABLE pipeline_run_audit (
    run_id                        BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    started_at                    DATETIME NULL,
    finished_at                   DATETIME NULL,
    load_mode                     TEXT NOT NULL,
    output_mode                   TEXT NOT NULL,
    odoo_cutoff_utc                TEXT NULL,
    latest_order_number_before      TEXT NULL,
    latest_order_datetime_before      DATETIME NULL,
    latest_order_number_after           TEXT NULL,
    latest_order_datetime_after           DATETIME NULL,
    status                                  TEXT NOT NULL,
    error_message                             TEXT NULL,
    row_counts_json                            TEXT NULL,
    created_at                                   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Adopted verbatim from database_exporter.py::_ensure_load_metadata_table. One row per source
-- file/feed (e.g. 'sale.report', 'PRODUCTS.xlsx') tracking freshness/checksum so incremental
-- runs can decide whether a manual-input sheet actually changed since the last successful load.
CREATE TABLE pipeline_load_metadata (
    source_name                   VARCHAR(255) NOT NULL PRIMARY KEY,
    source_type                   TEXT NOT NULL,
    source_path                   TEXT NULL,
    last_modified_time            DATETIME NULL,
    file_size                     BIGINT NULL,
    checksum                      TEXT NULL,
    last_successful_load_time     DATETIME NULL,
    load_mode                     TEXT NULL,
    status                        TEXT NOT NULL,
    updated_at                    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE data_quality_log (
    check_id               BIGINT AUTO_INCREMENT PRIMARY KEY,
    run_id                    BIGINT NULL,
    check_name                   VARCHAR(150) NOT NULL,
    table_name                     VARCHAR(100) NULL,
    metric_value                     DECIMAL(18, 4) NULL,
    status                              ENUM('PASS', 'FAIL', 'WARN', 'INFO') NOT NULL,
    notes                                 VARCHAR(500) NULL,
    checked_at                             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (run_id) REFERENCES pipeline_run_log(run_id),
    INDEX idx_data_quality_log_check (check_name, checked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Standards Section 5.12 - Audit Trail: "Changes to KPI definitions, filter defaults, access
-- roles, and dashboard structure are versioned with who/when/what-changed." Schema only.
CREATE TABLE audit_log (
    audit_id                BIGINT AUTO_INCREMENT PRIMARY KEY,
    entity_type                 VARCHAR(50) NOT NULL,
    entity_id                     VARCHAR(100) NOT NULL,
    action                           ENUM('CREATE', 'UPDATE', 'DELETE') NOT NULL,
    changed_by                        INT NULL,
    changed_at                          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    before_value                          JSON NULL,
    after_value                             JSON NULL,
    FOREIGN KEY (changed_by) REFERENCES app_user(user_id),
    INDEX idx_audit_log_entity (entity_type, entity_id, changed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
