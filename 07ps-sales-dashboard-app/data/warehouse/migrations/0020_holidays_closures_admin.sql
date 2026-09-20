-- Admin-managed Official Holidays / Forced Closures (Critical Number page redesign, 2026-09).
--
-- These replace fact_offdays as the Critical Number page's off-day source (see
-- backend/src/measures/criticalNumber.ts's fetchOfficialHolidayRows/fetchForcedClosureRows).
-- fact_offdays is ETL-owned -- resynced wholesale from OffDays.xlsx on every pipeline run -- so an
-- admin-added row there would be silently overwritten by the next run. These two tables are plain
-- admin-owned reference data instead (same overlay pattern as 0018_reference_data_admin.sql's
-- admin_customer_group/admin_distribution_channel/admin_company: INT AUTO_INCREMENT PK, audit
-- columns FK'd to app_user, a parallel append-only _history table), which the ETL never touches --
-- Admin Panel edits take effect on the very next page load, not the next pipeline run.
--
-- Column notes:
--   - official_holidays.company / forced_closures.company, forced_closures.branch_key: plain text,
--     matching fact_offdays' own Company/Branch columns (not FKs -- Company is free text, Branch is
--     an unenforced reference to Dim_SalesTeam.SalesTeamKey, same "no enforced key on the ETL side"
--     situation 0009's header documents for Dim_Salesperson). NULL company = country-wide, matching
--     fact_offdays' existing convention (see criticalNumber.ts's offDayMatchesScope).
--   - official_holidays.recurring: when TRUE, holiday_date's YEAR is just a reference year --
--     fetchOfficialHolidayRows re-anchors the (month, day) to every year a query window spans.
--   - forced_closures.duration_days: a closure spanning multiple days is one row, expanded into one
--     occurrence per covered day by fetchForcedClosureRows (same per-day granularity the old
--     fact_offdays rows had, one row per day).

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS official_holidays (
    holiday_id      INT AUTO_INCREMENT PRIMARY KEY,
    holiday_name    VARCHAR(255) NOT NULL,
    holiday_date    DATE NOT NULL,
    recurring       BOOLEAN NOT NULL DEFAULT FALSE,
    company         VARCHAR(100) NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by      INT NULL,
    updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    updated_by      INT NULL,
    FOREIGN KEY (created_by) REFERENCES app_user(user_id),
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id),
    INDEX idx_official_holidays_date (holiday_date),
    INDEX idx_official_holidays_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS official_holidays_history (
    history_id      BIGINT AUTO_INCREMENT PRIMARY KEY,
    holiday_id      INT NOT NULL,
    holiday_name    VARCHAR(255) NULL,
    holiday_date    DATE NULL,
    recurring       BOOLEAN NULL,
    company         VARCHAR(100) NULL,
    is_active       BOOLEAN NULL,
    action          ENUM('CREATE', 'UPDATE', 'DEACTIVATE', 'REACTIVATE', 'DELETE') NOT NULL,
    changed_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    changed_by      INT NULL,
    FOREIGN KEY (changed_by) REFERENCES app_user(user_id),
    INDEX idx_official_holidays_history_row (holiday_id, changed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS forced_closures (
    closure_id      INT AUTO_INCREMENT PRIMARY KEY,
    branch_key      VARCHAR(50) NOT NULL,
    company         VARCHAR(100) NULL,
    closure_date    DATE NOT NULL,
    duration_days   INT NOT NULL DEFAULT 1,
    reason          VARCHAR(255) NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by      INT NULL,
    updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    updated_by      INT NULL,
    FOREIGN KEY (created_by) REFERENCES app_user(user_id),
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id),
    INDEX idx_forced_closures_date (closure_date),
    INDEX idx_forced_closures_branch (branch_key),
    INDEX idx_forced_closures_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS forced_closures_history (
    history_id      BIGINT AUTO_INCREMENT PRIMARY KEY,
    closure_id      INT NOT NULL,
    branch_key      VARCHAR(50) NULL,
    company         VARCHAR(100) NULL,
    closure_date    DATE NULL,
    duration_days   INT NULL,
    reason          VARCHAR(255) NULL,
    is_active       BOOLEAN NULL,
    action          ENUM('CREATE', 'UPDATE', 'DEACTIVATE', 'REACTIVATE', 'DELETE') NOT NULL,
    changed_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    changed_by      INT NULL,
    FOREIGN KEY (changed_by) REFERENCES app_user(user_id),
    INDEX idx_forced_closures_history_row (closure_id, changed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One-time backfill from fact_offdays so nothing already on the page disappears the moment
-- criticalNumber.ts switches its read source. Guarded on "table is still empty" (rather than
-- INSERT IGNORE against a UNIQUE key, since neither table has one that would naturally dedupe this
-- shape of row) so re-running this migration file never resurrects a row an admin has since edited
-- or deleted.
--
-- Deliberately does NOT select fact_offdays.HolidayName/Reason: those columns exist on some
-- deployments' fact_offdays (per criticalNumber.ts's now-superseded fetchOffDayRows comment) but
-- not on every one -- confirmed absent on this deployment's live table (SHOW COLUMNS: DateKey,
-- Date, OffDayType, Country, Company, Branch, IsActive only). Backfilled rows get the generic
-- 'Public Holiday' label / a null reason either way; an admin can fill in the real name/reason
-- afterward from the new Admin Panel pages.
INSERT INTO official_holidays (holiday_name, holiday_date, recurring, company, is_active)
SELECT 'Public Holiday', Date, FALSE, Company, TRUE
FROM fact_offdays
WHERE OffDayType = 'official' AND IsActive = 1
  AND NOT EXISTS (SELECT 1 FROM official_holidays);

INSERT INTO forced_closures (branch_key, company, closure_date, duration_days, reason, is_active)
SELECT Branch, Company, Date, 1, NULL, TRUE
FROM fact_offdays
WHERE OffDayType = 'unexpected' AND IsActive = 1 AND Branch IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM forced_closures);

-- New Administration pages, same ADMIN-only pattern as 0018_reference_data_admin.sql.
INSERT IGNORE INTO pages (page_key, page_label, nav_group, sort_order) VALUES
    ('admin_holidays', 'Official Holidays', 'Administration', 20),
    ('admin_closures', 'Forced Closures', 'Administration', 21);

INSERT IGNORE INTO permissions (page_id, action)
SELECT page_id, 'view' FROM pages WHERE page_key IN ('admin_holidays', 'admin_closures')
UNION ALL
SELECT page_id, 'export' FROM pages WHERE page_key IN ('admin_holidays', 'admin_closures');

INSERT IGNORE INTO role_permissions (role_id, permission_id, allowed)
SELECT r.role_id, p.permission_id, TRUE
FROM roles r
JOIN permissions p ON TRUE
JOIN pages pg ON pg.page_id = p.page_id
WHERE r.role_name = 'ADMIN'
  AND pg.page_key IN ('admin_holidays', 'admin_closures');
