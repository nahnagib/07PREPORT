-- 0080: Product Development Plan dashboard + data entry & follow-up (the standalone "tracker"; docs/product-development-standalone.md).
-- Lives next to the TIKA R&D gate module (pdp_*, 0075-0077) without touching it: every table here is pdt_*.
--
--   pdt_dropdown_value  stage / health / priority / category lists. stage, health and priority rows carry a fixed `code`
--                       the rules use (services/pdt/rules.ts); admins edit label, colour, order and the active flag.
--                       Categories have no code and can be added or removed (removal refused while a product uses one).
--   pdt_setting         follow-up settings (stale days, roadmap months, upcoming-launch window, ...).
--   pdt_product         the register. code = 'P-' + 3-digit product_id, written by the API right after the insert; ids are
--                       never reused (soft delete via deleted_at).
--   pdt_stage_history   one row per stage change (from NULL on creation), with the required comment.
--   pdt_status_update   the owners' weekly updates; the latest one's health/readiness are copied onto the product.
--   pdt_blocker         blockers and decisions; an unresolved BLOCKER forces the product's health to Blocked (API rule).
--
-- Permissions: none added. The dashboard reads with product_development_plan View, the forms use
-- product_development_entry (both created by 0077); the settings screen is Admin-role only.
-- Production starts empty: the 8 demo products are a local seed script (backend/scripts/pdtDemoSeed.ts), not this file.
-- Idempotent (CREATE TABLE IF NOT EXISTS, INSERT IGNORE). Reverse: data/warehouse/down/0080_pdt_schema_down.sql.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS pdt_dropdown_value (
    value_id        INT AUTO_INCREMENT PRIMARY KEY,
    list_key        ENUM('stage', 'health', 'priority', 'category') NOT NULL,
    code            VARCHAR(30) NULL,
    label           VARCHAR(100) NOT NULL,
    color           CHAR(7) NOT NULL DEFAULT '#8a94a6',
    sort_order      INT NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_by      INT NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by      INT NULL,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_pdt_dd_label (list_key, label),
    UNIQUE KEY uq_pdt_dd_code (list_key, code),
    INDEX idx_pdt_dd_list (list_key, sort_order),
    CONSTRAINT chk_pdt_dd_color CHECK (color REGEXP '^#[0-9A-Fa-f]{6}$'),
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO pdt_dropdown_value (list_key, code, label, color, sort_order) VALUES
    ('stage',    'IDEA',         'Idea',          '#a3abb9', 1),
    ('stage',    'RESEARCH',     'Research',      '#a99be0', 2),
    ('stage',    'DEVELOPMENT',  'Development',   '#8a6fdf', 3),
    ('stage',    'TESTING',      'Testing',       '#6a9fd8', 4),
    ('stage',    'LAUNCH_READY', 'Launch ready',  '#5bb79a', 5),
    ('stage',    'LAUNCHED',     'Launched',      '#2e9a73', 6),
    ('health',   'ON_TRACK',     'On track',      '#2e9a73', 1),
    ('health',   'AT_RISK',      'At risk',       '#c4892f', 2),
    ('health',   'BLOCKED',      'Blocked',       '#d0504a', 3),
    ('priority', 'HIGH',         'High',          '#c4892f', 1),
    ('priority', 'MEDIUM',       'Medium',        '#8a94a6', 2),
    ('priority', 'LOW',          'Low',           '#8a94a6', 3),
    ('category', NULL,           'Skincare',      '#8a6fdf', 1),
    ('category', NULL,           'Sun care',      '#c4892f', 2),
    ('category', NULL,           'Sets & kits',   '#6a9fd8', 3),
    ('category', NULL,           'Sustainability','#2e9a73', 4),
    ('category', NULL,           'Body care',     '#d07a9a', 5);

CREATE TABLE IF NOT EXISTS pdt_setting (
    setting_key     VARCHAR(50) PRIMARY KEY,
    setting_value   INT NOT NULL,
    updated_by      INT NULL,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO pdt_setting (setting_key, setting_value) VALUES
    ('stale_days', 14),
    ('roadmap_months', 4),
    ('upcoming_window_days', 90),
    ('followup_due_soon_days', 7),
    ('launch_soon_days', 30),
    ('launch_soon_min_readiness', 80);

CREATE TABLE IF NOT EXISTS pdt_product (
    product_id              INT AUTO_INCREMENT PRIMARY KEY,
    code                    VARCHAR(12) NULL,
    name                    VARCHAR(150) NOT NULL,
    category_id             INT NOT NULL,
    owner_user_id           INT NULL,
    owner_name              VARCHAR(150) NOT NULL,
    priority_id             INT NOT NULL,
    stage_id                INT NOT NULL,
    health_id               INT NOT NULL,
    readiness_pct           TINYINT UNSIGNED NOT NULL DEFAULT 0,
    target_launch           DATE NULL,
    actual_launch           DATE NULL,
    description             TEXT NULL,
    notes                   TEXT NULL,
    health_review_required  BOOLEAN NOT NULL DEFAULT FALSE,
    stage_since             DATE NOT NULL,
    last_update_at          DATE NULL,
    created_by              INT NULL,
    created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by              INT NULL,
    updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at              DATETIME NULL,
    deleted_by              INT NULL,
    UNIQUE KEY uq_pdt_product_code (code),
    INDEX idx_pdt_product_live (deleted_at, stage_id),
    INDEX idx_pdt_product_owner (owner_name),
    CONSTRAINT chk_pdt_product_readiness CHECK (readiness_pct <= 100),
    CONSTRAINT fk_pdt_product_category FOREIGN KEY (category_id) REFERENCES pdt_dropdown_value(value_id),
    CONSTRAINT fk_pdt_product_priority FOREIGN KEY (priority_id) REFERENCES pdt_dropdown_value(value_id),
    CONSTRAINT fk_pdt_product_stage FOREIGN KEY (stage_id) REFERENCES pdt_dropdown_value(value_id),
    CONSTRAINT fk_pdt_product_health FOREIGN KEY (health_id) REFERENCES pdt_dropdown_value(value_id),
    FOREIGN KEY (owner_user_id) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (deleted_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pdt_stage_history (
    history_id      INT AUTO_INCREMENT PRIMARY KEY,
    product_id      INT NOT NULL,
    from_stage_id   INT NULL,
    to_stage_id     INT NOT NULL,
    changed_on      DATE NOT NULL,
    changed_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    changed_by      INT NULL,
    comment         VARCHAR(500) NOT NULL,
    INDEX idx_pdt_history_product (product_id, changed_at),
    FOREIGN KEY (product_id) REFERENCES pdt_product(product_id),
    FOREIGN KEY (from_stage_id) REFERENCES pdt_dropdown_value(value_id),
    FOREIGN KEY (to_stage_id) REFERENCES pdt_dropdown_value(value_id),
    FOREIGN KEY (changed_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pdt_status_update (
    update_id           INT AUTO_INCREMENT PRIMARY KEY,
    product_id          INT NOT NULL,
    update_date         DATE NOT NULL,
    health_id           INT NOT NULL,
    readiness_pct       TINYINT UNSIGNED NOT NULL,
    summary             TEXT NOT NULL,
    next_step           VARCHAR(300) NULL,
    next_step_due       DATE NULL,
    next_step_done_at   DATE NULL,
    created_by          INT NULL,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by          INT NULL,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at          DATETIME NULL,
    deleted_by          INT NULL,
    INDEX idx_pdt_update_product (product_id, deleted_at, update_date),
    CONSTRAINT chk_pdt_update_readiness CHECK (readiness_pct <= 100),
    FOREIGN KEY (product_id) REFERENCES pdt_product(product_id),
    FOREIGN KEY (health_id) REFERENCES pdt_dropdown_value(value_id),
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (deleted_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pdt_blocker (
    blocker_id          INT AUTO_INCREMENT PRIMARY KEY,
    product_id          INT NOT NULL,
    kind                ENUM('BLOCKER', 'DECISION') NOT NULL,
    title               VARCHAR(200) NOT NULL,
    required_action     VARCHAR(500) NOT NULL,
    owner_user_id       INT NULL,
    owner_name          VARCHAR(150) NOT NULL,
    due_date            DATE NOT NULL,
    status              ENUM('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CANCELLED') NOT NULL DEFAULT 'OPEN',
    resolution_note     VARCHAR(1000) NULL,
    resolved_at         DATE NULL,
    created_by          INT NULL,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by          INT NULL,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at          DATETIME NULL,
    deleted_by          INT NULL,
    INDEX idx_pdt_blocker_product (product_id, deleted_at, status),
    INDEX idx_pdt_blocker_due (deleted_at, status, due_date),
    -- Resolved needs a note and a date; an unresolved item has neither date.
    CONSTRAINT chk_pdt_blocker_resolved CHECK (
        (status = 'RESOLVED' AND resolution_note IS NOT NULL AND resolved_at IS NOT NULL)
        OR (status = 'CANCELLED')
        OR (status IN ('OPEN', 'IN_PROGRESS') AND resolved_at IS NULL)),
    FOREIGN KEY (product_id) REFERENCES pdt_product(product_id),
    FOREIGN KEY (owner_user_id) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (deleted_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
