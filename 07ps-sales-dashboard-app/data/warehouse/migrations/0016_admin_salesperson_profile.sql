-- Admin Salesperson Management page -- an admin-owned overlay for Dim_Salesperson.
--
-- Why an overlay table rather than editing Dim_Salesperson/Dim_SalesTeam/Fact_Targets directly:
-- those three (plus Dim_Company) are all fully dropped-and-reloaded by the ETL on every refresh
-- cycle (if_exists="replace" in data/etl/src/sales_pipeline/export/database_exporter.py -- see
-- that file's DATAFRAME_TO_TABLE handling for Dim_Salesperson/Dim_SalesTeam/Dim_Company, and its
-- "full_table_replaced"/"skipped_unchanged_full_table" validation scopes for Fact_Targets). Any
-- admin edit written directly into those tables would be silently wiped on the next ETL run, and
-- Dim_Salesperson has no enforced PK/unique key in the live warehouse to reliably UPDATE against
-- anyway. This table is admin-owned, survives ETL refreshes, and is read ALONGSIDE (never merged
-- into) the live dims by backend/src/services/salespersonAdminService.ts.
--
-- IMPORTANT scope note (true as of this migration, 2026): this does NOT feed tachometer.ts,
-- materialsAnalogyBcg.ts, or any other measure. Channel/Segment/Target for every existing
-- dashboard are still derived entirely from Fact_SalesLines/Fact_Targets per transaction, exactly
-- as before this table existed -- the admin page surfaces that live data read-only and lets an
-- admin record an intended channel/segment/team/target as a reference annotation. See the page's
-- own banner copy (frontend/src/app/admin/salespersons/page.tsx) for the user-facing version of
-- this caveat.
--
-- SUPERSEDED (2026-09, "Reports/Dashboards Honor Admin Salesperson Overrides"): the scope note
-- above is no longer true. channel_key_override/segment_key_override/sales_team_key_override/
-- target_override_amount now DO feed every dashboard/report measure (BCG Matrix/Brand Performance
-- excepted -- those classify products, not salesperson revenue). See
-- backend/src/services/salespersonAdminService.ts's header comment and
-- backend/src/measures/filters.ts's effectiveSegmentExpr docstring for the current mechanism.
--
-- salesperson_key is a plain BIGINT with no FK to Dim_Salesperson -- Dim_Salesperson.SalespersonKey
-- has no enforced PK/unique key in the live warehouse (same reasoning as app_user.salesperson_key
-- having no FK there either, see 0009_auth_identity.sql's header comment). Existence is validated
-- in application code instead (salespersonAdminService.ts checks against a live Dim_Salesperson
-- query before every upsert), not by the database.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS salesperson_admin_profile (
    salesperson_key         BIGINT NOT NULL PRIMARY KEY,
    channel_key_override    INT NULL,
    segment_key_override    INT NULL,
    sales_team_key_override VARCHAR(64) NULL,
    target_override_amount  DECIMAL(18, 2) NULL,
    note                    VARCHAR(500) NULL,
    updated_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    updated_by              INT NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only change history -- one row per successful update, powers the "Last Modified"
-- column + history popover without a generic audit_log framework. (0007_etl_and_audit_log.sql's
-- audit_log table targets the dead ps_warehouse schema and nothing in the app reads/writes it --
-- confirmed via a repo-wide grep -- so it is not reused here.)
CREATE TABLE IF NOT EXISTS salesperson_admin_profile_history (
    history_id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    salesperson_key         BIGINT NOT NULL,
    channel_key_override    INT NULL,
    segment_key_override    INT NULL,
    sales_team_key_override VARCHAR(64) NULL,
    target_override_amount  DECIMAL(18, 2) NULL,
    note                    VARCHAR(500) NULL,
    changed_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    changed_by              INT NULL,
    FOREIGN KEY (changed_by) REFERENCES app_user(user_id),
    INDEX idx_sapf_history_salesperson (salesperson_key, changed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- New Administration page, same pattern as admin_users/admin_roles/admin_login_history in
-- 0009_auth_identity.sql: ADMIN-only by default (no Sales-group role-loop like 0014/0015 use,
-- since this is an Administration page, not a report page).
--
-- sort_order 15 (not 13) -- admin_etl already claims 13 (seeded by 0011_etl_control_center.sql,
-- not one of the migrations this file's original draft cross-checked against). sort_order isn't
-- a unique column so 13 wouldn't have errored, just left two pages tied for the same order.
INSERT IGNORE INTO pages (page_key, page_label, nav_group, sort_order) VALUES
    ('admin_salespersons', 'Salesperson Management', 'Administration', 15);

INSERT IGNORE INTO permissions (page_id, action)
SELECT page_id, 'view' FROM pages WHERE page_key = 'admin_salespersons'
UNION ALL
SELECT page_id, 'export' FROM pages WHERE page_key = 'admin_salespersons';

INSERT IGNORE INTO role_permissions (role_id, permission_id, allowed)
SELECT r.role_id, p.permission_id, TRUE
FROM roles r
JOIN permissions p ON TRUE
JOIN pages pg ON pg.page_id = p.page_id
WHERE r.role_name = 'ADMIN' AND pg.page_key = 'admin_salespersons';

-- ---------------------------------------------------------------------------------------------
-- Sales Team Management -- same overlay pattern, keyed by Dim_SalesTeam.SalesTeamKey.
--
-- team_name_override exists for the same reason channel_key_override/segment_key_override do:
-- Dim_SalesTeam.SalesTeamName is ETL-owned (full-replace every refresh, see this file's header
-- comment) -- an admin edit written straight into Dim_SalesTeam.SalesTeamName would be wiped on
-- the next run. Display falls back to the live name when this is NULL (no override recorded).
--
-- team_code is intentionally admin-owned and independent of anything ETL-sourced -- there is no
-- live "team code" column anywhere in Dim_SalesTeam to conflict with. NOT NULL + UNIQUE because
-- it's the one field on this table meant to function as a real business identifier, not just an
-- annotation -- the frontend defaults a new team's code to its sales_team_key so the NOT NULL
-- constraint never blocks a first save (see EditPanel in
-- frontend/src/app/admin/salesteams/page.tsx).
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sales_team_admin_profile (
    sales_team_key          VARCHAR(64) NOT NULL PRIMARY KEY,
    team_name_override      VARCHAR(150) NULL,
    team_code               VARCHAR(50) NOT NULL,
    segment_key_override    INT NULL,
    target_override_amount  DECIMAL(18, 2) NULL,
    note                    VARCHAR(500) NULL,
    updated_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    updated_by              INT NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id),
    UNIQUE KEY uk_sales_team_admin_profile_team_code (team_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sales_team_admin_profile_history (
    history_id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    sales_team_key          VARCHAR(64) NOT NULL,
    team_name_override      VARCHAR(150) NULL,
    team_code               VARCHAR(50) NULL,
    segment_key_override    INT NULL,
    target_override_amount  DECIMAL(18, 2) NULL,
    note                    VARCHAR(500) NULL,
    changed_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    changed_by              INT NULL,
    FOREIGN KEY (changed_by) REFERENCES app_user(user_id),
    INDEX idx_stap_history_team (sales_team_key, changed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO pages (page_key, page_label, nav_group, sort_order) VALUES
    ('admin_salesteams', 'Sales Team Management', 'Administration', 16);

INSERT IGNORE INTO permissions (page_id, action)
SELECT page_id, 'view' FROM pages WHERE page_key = 'admin_salesteams'
UNION ALL
SELECT page_id, 'export' FROM pages WHERE page_key = 'admin_salesteams';

INSERT IGNORE INTO role_permissions (role_id, permission_id, allowed)
SELECT r.role_id, p.permission_id, TRUE
FROM roles r
JOIN permissions p ON TRUE
JOIN pages pg ON pg.page_id = p.page_id
WHERE r.role_name = 'ADMIN' AND pg.page_key = 'admin_salesteams';
