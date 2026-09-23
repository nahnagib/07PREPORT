-- audit_log on the live database. 0007_etl_and_audit_log.sql defined this table, but for the retired
-- ps_warehouse schema, so it was never created on powerBI_Data (see 0016's header) -- and every
-- audit write since (marcom/service.ts's audit(), the ETL input-file uploads in
-- routes/admin/etlInputFiles.ts) failed and was only logged to the console.
--
-- Same definition as 0007, unchanged, so nothing that already targets it needs to change. Read by
-- the admin Audit Log screen (routes/admin/auditLog.ts). Idempotent: CREATE TABLE IF NOT EXISTS.
--
-- Apply to an existing database with:
--   python data/warehouse/apply_migrations.py 0025_audit_log.sql

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS audit_log (
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
