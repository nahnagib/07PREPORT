-- Roles & permissions management: Create/Edit/Delete actions, several roles per user, and
-- admin-managed roles. Extends the 0009 model (roles / pages / permissions / role_permissions /
-- user_permissions); nothing is dropped or replaced.
--
-- Access is preserved exactly:
--   * Every user's current app_user.role_id becomes their (only) row in user_roles. role_id itself
--     stays and keeps meaning "primary role" -- the one that supplies the data-scope tier and the
--     role_data_scope rules -- so everything that still reads it behaves as before.
--   * Until now every admin write endpoint only checked View on its section. So wherever a role (or
--     a per-user override) has View on an admin section, it gets the new Create/Edit/Delete actions
--     with the same allowed value. Dashboards gain no new actions (View/Export only).
--   * The Admin role is evaluated as "every action on every page" by the backend; its rows below
--     are kept complete anyway.
--
-- The page list and which actions each page has are defined in
-- backend/src/config/permissionRegistry.ts; the backend syncs new registry entries into
-- pages/permissions at startup, so later pages need no migration. The rows inserted here are the
-- same ones that sync would create, so the database is correct even before the backend starts.
--
-- Idempotent: every ALTER is guarded by an information_schema check run through a prepared
-- statement (same pattern as 0023; the pymysql runner can't parse DELIMITER/procedures), and every
-- insert is INSERT IGNORE. Apply to an existing database with:
--   python data/warehouse/apply_migrations.py 0026_roles_permissions.sql

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------------
-- 1. New actions.
--
-- First remove any permission rows whose action is '' -- that is what a backend with the new
-- registry writes if it starts before this migration (a non-strict server stores an unknown ENUM
-- value as ''). The backend now refuses to sync until this migration has run, but clean up anyway.
-- ---------------------------------------------------------------------------
DELETE rp FROM role_permissions rp JOIN permissions p ON p.permission_id = rp.permission_id WHERE p.action = '';
DELETE up FROM user_permissions up JOIN permissions p ON p.permission_id = up.permission_id WHERE p.action = '';
DELETE FROM permissions WHERE action = '';

ALTER TABLE permissions MODIFY action ENUM('view', 'create', 'edit', 'delete', 'export') NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. roles: description, created_by, unique display name.
-- ---------------------------------------------------------------------------
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE roles ADD COLUMN description VARCHAR(500) NULL AFTER role_label', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'roles' AND COLUMN_NAME = 'description');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE roles ADD COLUMN created_by INT NULL', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'roles' AND COLUMN_NAME = 'created_by');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE roles ADD CONSTRAINT fk_roles_created_by FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL', 'DO 0')
  FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'roles' AND CONSTRAINT_NAME = 'fk_roles_created_by');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE roles ADD UNIQUE KEY uq_roles_label (role_label)', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'roles' AND INDEX_NAME = 'uq_roles_label');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Every role that exists today is a built-in (system) role.
UPDATE roles SET is_system = TRUE WHERE role_name IN
  ('ADMIN', 'GCEO', 'GCFO', 'GCCO', 'GCTO', 'TIKA_CEO', 'B2B_DIRECTOR', 'B2C_DIRECTOR', 'SALESPERSON');

UPDATE roles SET description = CASE role_name
    WHEN 'ADMIN'        THEN 'Super administrator: every page and every action. Cannot be renamed, deleted or restricted.'
    WHEN 'GCEO'         THEN 'Group CEO: all dashboards, all companies.'
    WHEN 'GCFO'         THEN 'Group CFO: all dashboards, all companies.'
    WHEN 'GCCO'         THEN 'Group CCO: all dashboards, all companies.'
    WHEN 'GCTO'         THEN 'Group CTO: all dashboards, all companies.'
    WHEN 'TIKA_CEO'     THEN 'Tika CEO: dashboards scoped to a single company.'
    WHEN 'B2B_DIRECTOR' THEN 'B2B Director: sales dashboards scoped to the B2B channel.'
    WHEN 'B2C_DIRECTOR' THEN 'B2C Director: sales dashboards scoped to the B2C channel.'
    WHEN 'SALESPERSON'  THEN 'Salesperson: own data only, view without export.'
  END
WHERE description IS NULL
  AND role_name IN ('ADMIN', 'GCEO', 'GCFO', 'GCCO', 'GCTO', 'TIKA_CEO', 'B2B_DIRECTOR', 'B2C_DIRECTOR', 'SALESPERSON');

-- ---------------------------------------------------------------------------
-- 3. user_roles: several business roles per user. (Not to be confused with 0009's user_role,
--    which holds data-scope tiers.)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_roles (
    user_id        INT NOT NULL,
    role_id        INT NOT NULL,
    assigned_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    assigned_by    INT NULL,
    PRIMARY KEY (user_id, role_id),
    INDEX idx_user_roles_role (role_id),
    FOREIGN KEY (user_id) REFERENCES app_user(user_id) ON DELETE CASCADE,
    FOREIGN KEY (role_id) REFERENCES roles(role_id),
    FOREIGN KEY (assigned_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO user_roles (user_id, role_id)
SELECT user_id, role_id FROM app_user WHERE role_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Create/Edit/Delete permission rows for the admin sections that have them (see the registry).
-- ---------------------------------------------------------------------------
INSERT IGNORE INTO permissions (page_id, action)
SELECT page_id, 'create' FROM pages WHERE page_key IN
  ('admin_users', 'admin_roles', 'admin_customer_groups', 'admin_distribution_channels', 'admin_companies',
   'admin_holidays', 'admin_closures', 'admin_marcom_upload');

INSERT IGNORE INTO permissions (page_id, action)
SELECT page_id, 'edit' FROM pages WHERE page_key IN
  ('admin_users', 'admin_roles', 'admin_salespersons', 'admin_salesteams', 'admin_customer_groups',
   'admin_distribution_channels', 'admin_companies', 'admin_holidays', 'admin_closures');

INSERT IGNORE INTO permissions (page_id, action)
SELECT page_id, 'delete' FROM pages WHERE page_key IN
  ('admin_roles', 'admin_customer_groups', 'admin_distribution_channels', 'admin_companies',
   'admin_holidays', 'admin_closures', 'admin_marcom_upload');

-- ---------------------------------------------------------------------------
-- 5. Carry today's access over: the new actions inherit the page's current View value, for role
--    defaults and for per-user overrides alike.
-- ---------------------------------------------------------------------------
INSERT IGNORE INTO role_permissions (role_id, permission_id, allowed)
SELECT rp.role_id, pn.permission_id, rp.allowed
FROM role_permissions rp
JOIN permissions pv ON pv.permission_id = rp.permission_id AND pv.action = 'view'
JOIN permissions pn ON pn.page_id = pv.page_id AND pn.action IN ('create', 'edit', 'delete');

INSERT IGNORE INTO user_permissions (user_id, permission_id, allowed)
SELECT up.user_id, pn.permission_id, up.allowed
FROM user_permissions up
JOIN permissions pv ON pv.permission_id = up.permission_id AND pv.action = 'view'
JOIN permissions pn ON pn.page_id = pv.page_id AND pn.action IN ('create', 'edit', 'delete');

-- The Admin role keeps a complete set of rows (it's also evaluated as all-access in code).
INSERT IGNORE INTO role_permissions (role_id, permission_id, allowed)
SELECT r.role_id, p.permission_id, TRUE
FROM roles r
JOIN permissions p ON TRUE
WHERE r.role_name = 'ADMIN';
