-- 0052: NPS Detractor Follow-up (Process department; docs/nps-followup.md). Application tables, like Kaizen's
-- (0027): the ETL's mart reload never replaces them. process_nps only ADDS missing cases and flags source changes; it
-- never writes a manual field.
--
--   nps_followup_reason  the reason list (English + Arabic), managed on the follow-up's Reasons screen. A reason used
--                        by a case can't be deleted (FK without ON DELETE); deactivating hides it from the form only.
--   nps_followup_case    one case per detractor rating (response_id unique, so creation is idempotent). The rating's
--                        facts (customer, company, order, salesperson, comment) are read live from
--                        v_process_nps_response; the case keeps a copy of the rating time only. Status:
--                          HISTORICAL   rated before NPS_FOLLOWUP_START (the cut-over; ETL setting): List view only
--                          NEW -> CONTACTED -> IN_PROGRESS -> SOLVED, or CANCELLED
--                        source_changed: the rating left the source or is no longer a detractor (set by process_nps,
--                        which also warns warn:nps_followup_source_changed); the case and its manual fields stay.
--                        Times: rated_at_local, contacted_at and solved_at are Africa/Tripoli wall-clock times (so
--                        they compare); created_at / updated_at / source_changed_at are UTC.
--                        version: optimistic lock -- an edit made on an older version is refused (409), so two people
--                        never overwrite each other.
--   nps_followup_audit   one row per changed field: who, when, old value, new value (changed_by NULL = process_nps).
--
-- Permissions (backend/src/config/permissionRegistry.ts):
--   nps_followup          the board and list (View), editing a case (Edit), the Excel download (Export)
--   nps_followup_reasons  the reason list (View / Create / Edit / Delete)
-- Granted to ADMIN (everything) and EXCELLENCE_MANAGER (0027): both pages, plus View on nps_score and nps_comments.
--
-- Idempotent. Requires 0009 (app_user), 0027 (EXCELLENCE_MANAGER), 0046 and 0048. Reverse:
-- data/warehouse/down/0052_nps_detractor_followup_down.sql.

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------------
-- 1. Reasons.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nps_followup_reason (
    reason_id       BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name_en         VARCHAR(100) NOT NULL,
    name_ar         VARCHAR(100) NOT NULL,
    sort_order      INT NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_by      INT NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by      INT NULL,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_nps_followup_reason_en (name_en),
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO nps_followup_reason (name_en, name_ar, sort_order) VALUES
    ('Late delivery', 'تأخر التوصيل', 1),
    ('Damaged product', 'منتج تالف', 2),
    ('Wrong or missing item', 'صنف خاطئ أو ناقص', 3),
    ('Driver behaviour', 'سلوك السائق', 4),
    ('Product quality', 'جودة المنتج', 5),
    ('Price or invoice issue', 'مشكلة في السعر أو الفاتورة', 6),
    ('Customer service', 'خدمة العملاء', 7),
    ('Other', 'أخرى', 8);

-- ---------------------------------------------------------------------------
-- 2. Cases. (Constraints kept on one line each; status is a checked VARCHAR, not an ENUM, so the ETL's SQLite tests
--    build the same table from this file.)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nps_followup_case (
    case_id                 BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    response_id             BIGINT NOT NULL,
    rated_at_local          DATETIME NULL,
    status                  VARCHAR(20) NOT NULL DEFAULT 'NEW',
    reason_id               BIGINT NULL,
    owner_user_id           INT NULL,
    contacted_at            DATETIME NULL,
    solved_at               DATETIME NULL,
    root_cause              TEXT NULL,
    action_taken            TEXT NULL,
    notes                   TEXT NULL,
    source_changed          BOOLEAN NOT NULL DEFAULT FALSE,
    source_changed_at       DATETIME NULL,
    source_change_reason    VARCHAR(200) NULL,
    version                 INT NOT NULL DEFAULT 1,
    created_by              INT NULL,
    created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by              INT NULL,
    updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_nps_followup_case_response (response_id),
    INDEX idx_nps_followup_case_status (status, solved_at),
    INDEX idx_nps_followup_case_reason (reason_id),
    INDEX idx_nps_followup_case_owner (owner_user_id),
    CONSTRAINT chk_nps_followup_status CHECK (status IN ('HISTORICAL', 'NEW', 'CONTACTED', 'IN_PROGRESS', 'SOLVED', 'CANCELLED')),
    CONSTRAINT chk_nps_followup_solved CHECK ((status = 'SOLVED' AND solved_at IS NOT NULL) OR (status <> 'SOLVED' AND solved_at IS NULL)),
    CONSTRAINT chk_nps_followup_solved_after CHECK (solved_at IS NULL OR rated_at_local IS NULL OR solved_at >= rated_at_local),
    CONSTRAINT chk_nps_followup_contacted_after CHECK (contacted_at IS NULL OR rated_at_local IS NULL OR contacted_at >= rated_at_local),
    CONSTRAINT fk_nps_followup_case_reason FOREIGN KEY (reason_id) REFERENCES nps_followup_reason(reason_id),
    FOREIGN KEY (owner_user_id) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 3. Audit trail (one row per changed field).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nps_followup_audit (
    audit_id        BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    case_id         BIGINT NOT NULL,
    changed_by      INT NULL,
    changed_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    field           VARCHAR(40) NOT NULL,
    old_value       TEXT NULL,
    new_value       TEXT NULL,
    INDEX idx_nps_followup_audit_case (case_id, changed_at),
    CONSTRAINT fk_nps_followup_audit_case FOREIGN KEY (case_id) REFERENCES nps_followup_case(case_id) ON DELETE CASCADE,
    FOREIGN KEY (changed_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 4. Permission pages (also synced from the backend registry at startup; inserted here so the grants below have rows).
-- ---------------------------------------------------------------------------
INSERT INTO pages (page_key, page_label, nav_group, sort_order) VALUES ('nps_followup', 'Detractor Follow-up', 'Data Entry', 21)
  ON DUPLICATE KEY UPDATE page_label = VALUES(page_label);
INSERT INTO pages (page_key, page_label, nav_group, sort_order) VALUES ('nps_followup_reasons', 'Detractor Follow-up reasons', 'Data Entry', 22)
  ON DUPLICATE KEY UPDATE page_label = VALUES(page_label);

INSERT IGNORE INTO permissions (page_id, action)
SELECT page_id, a.action FROM pages
JOIN (SELECT 'view' AS action UNION ALL SELECT 'edit' UNION ALL SELECT 'export') a
WHERE page_key = 'nps_followup';

INSERT IGNORE INTO permissions (page_id, action)
SELECT page_id, a.action FROM pages
JOIN (SELECT 'view' AS action UNION ALL SELECT 'create' UNION ALL SELECT 'edit' UNION ALL SELECT 'delete') a
WHERE page_key = 'nps_followup_reasons';

-- Admin: everything (also all-access in code).
INSERT IGNORE INTO role_permissions (role_id, permission_id, allowed)
SELECT r.role_id, p.permission_id, TRUE
FROM roles r
JOIN pages pg ON pg.page_key IN ('nps_followup', 'nps_followup_reasons')
JOIN permissions p ON p.page_id = pg.page_id
WHERE r.role_name = 'ADMIN';

-- Excellence Manager (decision 2026-10-19): the follow-up (View / Edit / Export), the reason list, and View on the NPS
-- Score page and its detractor comments -- not their Export.
INSERT IGNORE INTO role_permissions (role_id, permission_id, allowed)
SELECT r.role_id, p.permission_id, TRUE
FROM roles r
JOIN pages pg ON pg.page_key IN ('nps_followup', 'nps_followup_reasons')
JOIN permissions p ON p.page_id = pg.page_id
WHERE r.role_name = 'EXCELLENCE_MANAGER';

INSERT IGNORE INTO role_permissions (role_id, permission_id, allowed)
SELECT r.role_id, p.permission_id, TRUE
FROM roles r
JOIN pages pg ON pg.page_key IN ('nps_score', 'nps_comments')
JOIN permissions p ON p.page_id = pg.page_id AND p.action = 'view'
WHERE r.role_name = 'EXCELLENCE_MANAGER';
