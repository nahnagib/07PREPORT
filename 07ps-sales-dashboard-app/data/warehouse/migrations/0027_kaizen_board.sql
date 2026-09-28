-- Kaizen Board (Process department): cards entered by the Excellence Manager, the admin-managed
-- dropdown lists they reference, the two permission pages, and the Excellence Manager role.
--
--   kaizen_dropdown_value  Department / Card Type / Card Priority values (EN + AR label, sort order,
--                          chart colour, active flag). A value used by a card can't be deleted: the
--                          FKs from kaizen_cards have no ON DELETE, so the database refuses it too.
--                          Deactivating hides it from the entry form only.
--   kaizen_cards           One row per accepted card. card_no is the "#7" shown to users: an
--                          AUTO_INCREMENT that is never reused (cards are soft-deleted via
--                          deleted_at, and MySQL 8 persists the counter across restarts).
--
-- Permissions (see backend/src/config/permissionRegistry.ts):
--   kaizen_board  dashboard + read-only card details (View, Export)
--   kaizen_cards  data entry (View = cards list, Create, Edit = edit/close, Delete = soft delete,
--                 Export = Excel)
-- No existing role gets either page; the Admin role gets everything, as for every page. The
-- Dropdown Values screen and the one-time import are Admin-role only (not in the registry).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS and INSERT IGNORE throughout. Apply to an existing
-- database with:
--   python data/warehouse/apply_migrations.py 0027_kaizen_board.sql

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------------
-- 1. Dropdown values.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kaizen_dropdown_value (
    value_id        INT AUTO_INCREMENT PRIMARY KEY,
    list_key        ENUM('department', 'card_type', 'card_priority') NOT NULL,
    label_en        VARCHAR(100) NOT NULL,
    label_ar        VARCHAR(100) NOT NULL,
    sort_order      INT NOT NULL DEFAULT 0,
    color           CHAR(7) NOT NULL DEFAULT '#4d88c4',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_by      INT NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by      INT NULL,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_kaizen_dd_en (list_key, label_en),
    UNIQUE KEY uq_kaizen_dd_ar (list_key, label_ar),
    INDEX idx_kaizen_dd_list (list_key, sort_order),
    CONSTRAINT chk_kaizen_dd_color CHECK (color REGEXP '^#[0-9A-Fa-f]{6}$'),
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO kaizen_dropdown_value (list_key, label_en, label_ar, sort_order, color) VALUES
    ('department',    'EXCO',                     'EXCO',                 1, '#4d88c4'),
    ('department',    'Operations & Warehouses',  'العمليات و المخازن',    2, '#c48a3f'),
    ('department',    'Sales',                    'المبيعات',             3, '#5a9e6f'),
    ('department',    'Tika',                     'تيكا',                 4, '#a06fc4'),
    ('card_type',     'System issue',             'مشكلة نظام',           1, '#3f9bc4'),
    ('card_type',     'Person issue',             'مشكلة شخص',            2, '#cc7a3f'),
    ('card_priority', 'Urgent card',              'بطاقة عاجلة',          1, '#d9534f'),
    ('card_priority', 'Task card',                'بطاقة مهام',           2, '#4d88c4');

-- ---------------------------------------------------------------------------
-- 2. Cards.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kaizen_cards (
    card_no             INT AUTO_INCREMENT PRIMARY KEY,
    creator_name        VARCHAR(150) NOT NULL,
    card_date           DATE NOT NULL,
    department_id       INT NOT NULL,
    card_name           VARCHAR(200) NOT NULL,
    card_type_id        INT NOT NULL,
    issue               TEXT NOT NULL,
    root_cause          TEXT NULL,
    impact              TEXT NULL,
    priority_id         INT NOT NULL,
    proposed_solution   TEXT NULL,
    expected_date       DATE NULL,
    closer_date         DATE NULL,
    responsible_party   VARCHAR(150) NULL,
    status              ENUM('OPEN', 'CLOSED') NOT NULL DEFAULT 'OPEN',
    source              ENUM('MANUAL', 'IMPORT') NOT NULL DEFAULT 'MANUAL',
    created_by          INT NULL,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by          INT NULL,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at          DATETIME NULL,
    deleted_by          INT NULL,
    INDEX idx_kaizen_cards_date (deleted_at, card_date),
    INDEX idx_kaizen_cards_department (department_id),
    INDEX idx_kaizen_cards_type (card_type_id),
    INDEX idx_kaizen_cards_priority (priority_id),
    -- The same rules the API validates, enforced once more by the database.
    CONSTRAINT chk_kaizen_closer_status CHECK (
        (status = 'CLOSED' AND closer_date IS NOT NULL) OR (status = 'OPEN' AND closer_date IS NULL)),
    CONSTRAINT chk_kaizen_closer_after CHECK (closer_date IS NULL OR closer_date >= card_date),
    CONSTRAINT chk_kaizen_expected_after CHECK (expected_date IS NULL OR expected_date >= card_date),
    CONSTRAINT fk_kaizen_cards_department FOREIGN KEY (department_id) REFERENCES kaizen_dropdown_value(value_id),
    CONSTRAINT fk_kaizen_cards_type FOREIGN KEY (card_type_id) REFERENCES kaizen_dropdown_value(value_id),
    CONSTRAINT fk_kaizen_cards_priority FOREIGN KEY (priority_id) REFERENCES kaizen_dropdown_value(value_id),
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (deleted_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 3. Permission pages (the backend's registry sync creates the same rows at startup; inserted here
--    so the role grants below have something to point at before it runs).
-- ---------------------------------------------------------------------------
INSERT IGNORE INTO pages (page_key, page_label, nav_group, sort_order) VALUES
    ('kaizen_board', 'Kaizen Board', 'Sales', 17),
    ('kaizen_cards', 'Kaizen Cards', 'Data Entry', 18);

INSERT IGNORE INTO permissions (page_id, action)
SELECT page_id, a.action FROM pages
JOIN (SELECT 'view' AS action UNION ALL SELECT 'export') a
WHERE page_key = 'kaizen_board';

INSERT IGNORE INTO permissions (page_id, action)
SELECT page_id, a.action FROM pages
JOIN (SELECT 'view' AS action UNION ALL SELECT 'create' UNION ALL SELECT 'edit'
      UNION ALL SELECT 'delete' UNION ALL SELECT 'export') a
WHERE page_key = 'kaizen_cards';

-- ---------------------------------------------------------------------------
-- 4. Excellence Manager role: every action on both Kaizen pages, nothing else. No data-scope tier
--    (it has no sales reports; if one is granted later the admin sets the tier on the Roles screen).
--    A regular (non-system) role, so the admin can edit or remove it like any other.
-- ---------------------------------------------------------------------------
INSERT IGNORE INTO roles (role_name, role_label, description, default_role_tier_code, is_system) VALUES
    ('EXCELLENCE_MANAGER', 'Excellence Manager',
     'Excellence Manager: enters, edits and closes Kaizen cards; views the Kaizen Board.', NULL, FALSE);

INSERT IGNORE INTO role_permissions (role_id, permission_id, allowed)
SELECT r.role_id, p.permission_id, TRUE
FROM roles r
JOIN pages pg ON pg.page_key IN ('kaizen_board', 'kaizen_cards')
JOIN permissions p ON p.page_id = pg.page_id
WHERE r.role_name = 'EXCELLENCE_MANAGER';

-- The Admin role keeps a complete set of rows (it's also evaluated as all-access in code).
INSERT IGNORE INTO role_permissions (role_id, permission_id, allowed)
SELECT r.role_id, p.permission_id, TRUE
FROM roles r
JOIN pages pg ON pg.page_key IN ('kaizen_board', 'kaizen_cards')
JOIN permissions p ON p.page_id = pg.page_id
WHERE r.role_name = 'ADMIN';
