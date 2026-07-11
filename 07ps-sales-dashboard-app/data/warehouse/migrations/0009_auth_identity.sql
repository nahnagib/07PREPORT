-- Real authentication & authorization identity layer (Standards Section 5.2/5.9), replacing the
-- dev-only devAuth.ts token issuance.
--
-- IMPORTANT CONTEXT (see DATABASE_MIGRATION_COMPLETE.md in the repo root): this backend was
-- deliberately migrated off a `ps_warehouse` database (the one 0001-0008 in this folder target)
-- onto directly querying the real, already-populated `powerBI_Data` warehouse instead.
-- 0006_platform_rbac.sql's role_tier/app_user/dashboard/role_dashboard_access/user_role were
-- therefore NEVER actually created in the database this app runs against today. This migration
-- creates a corrected, self-sufficient version of what 0006 needed (role_tier, app_user,
-- user_role -- all CREATE TABLE IF NOT EXISTS, so this is safe to run whether or not some other
-- environment already has them) plus the new business-facing roles/pages/permissions model, in
-- one migration, rather than depending on a 0006 run that never actually happened here.
--
-- One deliberate deviation from 0006's original design: app_user.salesperson_key has NO foreign
-- key to dim_salesperson. The real dim_salesperson table in powerBI_Data is a raw ETL dump
-- (`SalespersonKey BIGINT`, no primary/unique key at all), so an FK there is not just
-- differently-cased but structurally impossible. salesperson_key is kept as a plain, unenforced
-- integer -- exactly how the rest of the app (scopeContext.ts/filters.ts) already treats it, with
-- no other code path relying on referential integrity for it either.
--
-- role_tier keeps driving data-scope locking (applySalespersonLock in
-- backend/src/measures/filters.ts) exactly as it was designed to; the new `roles` table drives
-- page-level View/Export permissions and the admin UI. Each business role has a
-- default_role_tier_code so creating/importing a user auto-assigns its data-scope tier via
-- user_role, without touching scope-lock logic itself.

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------------
-- role_tier / user_role: data-scope tiers (Standards Section 5.2/4.10). Same shape as
-- 0006_platform_rbac.sql's role_tier table; recreated here (IF NOT EXISTS) since 0006 was never
-- actually applied to this database.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS role_tier (
    role_code            VARCHAR(30) PRIMARY KEY,
    role_label              VARCHAR(60) NOT NULL,
    scope_description          VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO role_tier (role_code, role_label, scope_description) VALUES
    ('BI00_EXECUTIVE',    'Executive (BI 00)',        'All departments, all companies, ExCo dashboard'),
    ('BI01_DIRECTOR_B2B', 'Director (BI 01)',          'Sales-related dashboards scoped to B2B channel'),
    ('BI02_DIRECTOR_B2C', 'Director (BI 02)',           'Sales-related dashboards scoped to B2C channel'),
    ('BI03_COMPANY_EXEC', 'Company Executive (BI 03)',   'All dashboards scoped to a single company'),
    ('DEPARTMENT_HEAD',   'Department Head',              'Their own department dashboard only'),
    ('SALESPERSON',       'Individual Contributor',         'Own data only, all other filters locked');

-- ---------------------------------------------------------------------------
-- Business-facing roles (distinct from role_tier - see header comment).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
    role_id                  INT AUTO_INCREMENT PRIMARY KEY,
    role_name                VARCHAR(30) NOT NULL UNIQUE,
    role_label                  VARCHAR(60) NOT NULL,
    default_role_tier_code         VARCHAR(30) NULL,
    is_system                         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at                           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (default_role_tier_code) REFERENCES role_tier(role_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO roles (role_name, role_label, default_role_tier_code) VALUES
    ('ADMIN',        'Admin',           'BI00_EXECUTIVE'),
    ('GCEO',         'GCEO',            'BI00_EXECUTIVE'),
    ('GCFO',         'GCFO',            'BI00_EXECUTIVE'),
    ('GCCO',         'GCCO',            'BI00_EXECUTIVE'),
    ('GCTO',         'GCTO',            'BI00_EXECUTIVE'),
    ('TIKA_CEO',     'Tika CEO',        'BI03_COMPANY_EXEC'),
    ('B2B_DIRECTOR', 'B2B Director',    'BI01_DIRECTOR_B2B'),
    ('B2C_DIRECTOR', 'B2C Director',    'BI02_DIRECTOR_B2C'),
    ('SALESPERSON',  'Salesperson',     'SALESPERSON');

-- ---------------------------------------------------------------------------
-- app_user: the real identity table (was previously going to be an ALTER onto 0006's app_user --
-- rewritten as a full CREATE since that table never existed here). Same core columns
-- 0006_platform_rbac.sql defined (email/display_name/company_scope/salesperson_key/is_active/
-- created_at) plus every real-auth column this module needs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_user (
    user_id                     INT AUTO_INCREMENT PRIMARY KEY,
    email                          VARCHAR(255) NOT NULL UNIQUE,
    display_name                      VARCHAR(150) NOT NULL,
    company_scope                        ENUM('ALL', 'MAJAAL', 'TIKA') NOT NULL DEFAULT 'ALL',
    -- No FK to dim_salesperson -- see migration header.
    salesperson_key                         INT NULL,
    is_active                                  BOOLEAN NOT NULL DEFAULT TRUE,
    created_at                                    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    password_hash                                    VARCHAR(255) NOT NULL,
    status                                              ENUM('ACTIVE', 'INACTIVE', 'LOCKED', 'PENDING_PASSWORD_CHANGE')
                                                             NOT NULL DEFAULT 'PENDING_PASSWORD_CHANGE',
    must_change_password                                    BOOLEAN NOT NULL DEFAULT TRUE,
    last_login_at                                              TIMESTAMP NULL,
    updated_at                                                    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    failed_login_count                                               INT NOT NULL DEFAULT 0,
    password_changed_at                                                 TIMESTAMP NULL,
    password_reset_token_hash                                              VARCHAR(255) NULL,
    password_reset_expires_at                                                 TIMESTAMP NULL,
    -- Bulk session-revoke marker: any token with iat < sessions_revoked_at is rejected by
    -- requireAuth. Cheaper than enumerating every issued jti for "revoke all sessions"/password
    -- reset/admin lock, and is how a 1-year JWT is made instantly revocable (see plan doc).
    sessions_revoked_at                                                          TIMESTAMP NULL,
    role_id                                                                         INT NULL,
    FOREIGN KEY (role_id) REFERENCES roles(role_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Many-to-many: a user can hold more than one role tier without changing this schema.
CREATE TABLE IF NOT EXISTS user_role (
    user_id               INT NOT NULL,
    role_code                VARCHAR(30) NOT NULL,
    PRIMARY KEY (user_id, role_code),
    FOREIGN KEY (user_id) REFERENCES app_user(user_id),
    FOREIGN KEY (role_code) REFERENCES role_tier(role_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Pages, permissions (View/Export only - Standards: this is a reporting system, no CRUD on
-- business data), role defaults, and per-user overrides.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pages (
    page_id             INT AUTO_INCREMENT PRIMARY KEY,
    page_key               VARCHAR(60) NOT NULL UNIQUE,
    page_label                VARCHAR(100) NOT NULL,
    nav_group                    VARCHAR(60) NULL,
    sort_order                      INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Report pages (tachometer is live today; the rest are Phase P3, not built yet, but their
-- permission rows exist now so nothing needs a schema change when they ship) + admin pages.
INSERT IGNORE INTO pages (page_key, page_label, nav_group, sort_order) VALUES
    ('tachometer',        'Tachometer',            'Sales', 1),
    ('critical_number',   'Critical Number',       'Sales', 2),
    ('revenue_trend',     'Revenue Trend',         'Sales', 3),
    ('invoices_engine',   'Invoices Engine',       'Sales', 4),
    ('customer_growth',   'Customer Growth',       'Sales', 5),
    ('admin_users',       'User Management',       'Administration', 10),
    ('admin_roles',       'Role & Permissions',    'Administration', 11),
    ('admin_login_history','Login History',        'Administration', 12);

CREATE TABLE IF NOT EXISTS permissions (
    permission_id     INT AUTO_INCREMENT PRIMARY KEY,
    page_id               INT NOT NULL,
    action                   ENUM('view', 'export') NOT NULL,
    UNIQUE KEY uq_permissions_page_action (page_id, action),
    FOREIGN KEY (page_id) REFERENCES pages(page_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO permissions (page_id, action)
SELECT page_id, 'view' FROM pages
UNION ALL
SELECT page_id, 'export' FROM pages;

CREATE TABLE IF NOT EXISTS role_permissions (
    role_id            INT NOT NULL,
    permission_id          INT NOT NULL,
    allowed                    BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (role_id, permission_id),
    FOREIGN KEY (role_id) REFERENCES roles(role_id),
    FOREIGN KEY (permission_id) REFERENCES permissions(permission_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Default matrix: Admin gets every page (incl. Administration). Every other business role gets
-- view+export on every report page but no Administration page, EXCEPT Salesperson, which starts
-- view-only (no export) on report pages per the "own data only" spirit of that role - all of
-- this is just the seeded default, an Administrator can customize any of it later per-role or
-- per-user without touching this table's shape.
INSERT IGNORE INTO role_permissions (role_id, permission_id, allowed)
SELECT r.role_id, p.permission_id, TRUE
FROM roles r
JOIN permissions p ON TRUE
JOIN pages pg ON pg.page_id = p.page_id
WHERE r.role_name = 'ADMIN';

INSERT IGNORE INTO role_permissions (role_id, permission_id, allowed)
SELECT r.role_id, p.permission_id, TRUE
FROM roles r
JOIN permissions p ON TRUE
JOIN pages pg ON pg.page_id = p.page_id
WHERE r.role_name IN ('GCEO', 'GCFO', 'GCCO', 'GCTO', 'TIKA_CEO', 'B2B_DIRECTOR', 'B2C_DIRECTOR')
  AND pg.nav_group = 'Sales';

INSERT IGNORE INTO role_permissions (role_id, permission_id, allowed)
SELECT r.role_id, p.permission_id, TRUE
FROM roles r
JOIN permissions p ON TRUE
JOIN pages pg ON pg.page_id = p.page_id
WHERE r.role_name = 'SALESPERSON'
  AND pg.nav_group = 'Sales'
  AND p.action = 'view';

CREATE TABLE IF NOT EXISTS user_permissions (
    user_id            INT NOT NULL,
    permission_id          INT NOT NULL,
    allowed                    BOOLEAN NOT NULL,
    PRIMARY KEY (user_id, permission_id),
    FOREIGN KEY (user_id) REFERENCES app_user(user_id),
    FOREIGN KEY (permission_id) REFERENCES permissions(permission_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Login history / audit trail.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS login_history (
    id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id                INT NULL,
    email_attempted           VARCHAR(255) NOT NULL,
    event_type                   ENUM(
                                      'LOGIN_SUCCESS',
                                      'LOGIN_FAILED_PASSWORD',
                                      'LOGIN_FAILED_LOCKED',
                                      'LOGIN_FAILED_INACTIVE',
                                      'LOGOUT',
                                      'PASSWORD_RESET_REQUESTED',
                                      'PASSWORD_RESET_COMPLETED',
                                      'PASSWORD_CHANGED',
                                      'FORCE_PASSWORD_CHANGE_SET',
                                      'ACCOUNT_LOCKED_AUTO',
                                      'ACCOUNT_STATUS_CHANGED',
                                      'SESSIONS_REVOKED'
                                  ) NOT NULL,
    ip_address                      VARCHAR(45) NULL,
    user_agent                         VARCHAR(255) NULL,
    created_at                            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES app_user(user_id),
    INDEX idx_login_history_user (user_id, created_at),
    INDEX idx_login_history_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Session revocation for single-token logout. Bulk "revoke all sessions" uses
-- app_user.sessions_revoked_at instead (no need to enumerate every jti ever issued).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS revoked_tokens (
    jti                CHAR(36) PRIMARY KEY,
    user_id                INT NOT NULL,
    revoked_at                TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reason                       VARCHAR(100) NOT NULL,
    expires_at                     TIMESTAMP NOT NULL,
    FOREIGN KEY (user_id) REFERENCES app_user(user_id),
    INDEX idx_revoked_tokens_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
