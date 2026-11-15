-- 0074: Product Development Plan (Product department, TIKA only) -- schema.
-- Design and workflow: docs/product-development-plan.md. Config seed: 0075. Permissions: 0076.
--
-- Rules every table follows:
--   * company_key BIGINT NOT NULL -> dim_company.CompanyKey (the core, Odoo-id table; the ETL only upserts it). The API
--     resolves TIKA by name and writes/reads only that key; Majaal is refused (services/pdp/company.ts).
--   * created_by/at, updated_by/at on every row; soft delete (deleted_at/deleted_by) where rows can be removed.
--     `alive` (1, or NULL once deleted) lets a UNIQUE key ignore deleted rows.
--   * *_history and pdp_gate_decision / pdp_score_round / pdp_project_score are append-only: the API only INSERTs them.
--   * No FK to dim_product / dim_customer: the ETL's sync mode may delete rows there, and an FK would block it.
--     The API validates those keys (TIKA or shared products, TIKA customers) instead.
--   * utf8mb4 everywhere, so Arabic text in any data field is stored as typed.
-- Idempotent (CREATE TABLE IF NOT EXISTS). Reverse: data/warehouse/down/0074_pdp_schema_down.sql.

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------------- product tree
CREATE TABLE IF NOT EXISTS pdp_brand (
    brand_id     INT AUTO_INCREMENT PRIMARY KEY,
    company_key  BIGINT NOT NULL,
    name         VARCHAR(100) NOT NULL,
    sort_order   INT NOT NULL DEFAULT 0,
    created_by   INT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by   INT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at   DATETIME NULL, deleted_by INT NULL,
    alive        TINYINT AS (IF(deleted_at IS NULL, 1, NULL)) STORED,
    UNIQUE KEY uq_pdp_brand (company_key, name, alive),
    CONSTRAINT fk_pdp_brand_company FOREIGN KEY (company_key) REFERENCES dim_company(CompanyKey),
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (deleted_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pdp_product_family (
    family_id    INT AUTO_INCREMENT PRIMARY KEY,
    company_key  BIGINT NOT NULL,
    brand_id     INT NOT NULL,
    name         VARCHAR(150) NOT NULL,
    description  TEXT NULL,
    sort_order   INT NOT NULL DEFAULT 0,
    created_by   INT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by   INT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at   DATETIME NULL, deleted_by INT NULL,
    alive        TINYINT AS (IF(deleted_at IS NULL, 1, NULL)) STORED,
    UNIQUE KEY uq_pdp_family (company_key, brand_id, name, alive),
    CONSTRAINT fk_pdp_family_company FOREIGN KEY (company_key) REFERENCES dim_company(CompanyKey),
    CONSTRAINT fk_pdp_family_brand FOREIGN KEY (brand_id) REFERENCES pdp_brand(brand_id),
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (deleted_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pdp_product_subfamily (
    subfamily_id INT AUTO_INCREMENT PRIMARY KEY,
    company_key  BIGINT NOT NULL,
    family_id    INT NOT NULL,
    name         VARCHAR(150) NOT NULL,
    sort_order   INT NOT NULL DEFAULT 0,
    created_by   INT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by   INT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at   DATETIME NULL, deleted_by INT NULL,
    alive        TINYINT AS (IF(deleted_at IS NULL, 1, NULL)) STORED,
    UNIQUE KEY uq_pdp_subfamily (family_id, name, alive),
    CONSTRAINT fk_pdp_subfamily_company FOREIGN KEY (company_key) REFERENCES dim_company(CompanyKey),
    CONSTRAINT fk_pdp_subfamily_family FOREIGN KEY (family_id) REFERENCES pdp_product_family(family_id),
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (deleted_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pdp_product (
    product_id            INT AUTO_INCREMENT PRIMARY KEY,
    company_key           BIGINT NOT NULL,
    subfamily_id          INT NOT NULL,
    name                  VARCHAR(200) NOT NULL,
    description           TEXT NULL,
    status                ENUM('in_market', 'planned', 'under_development', 'discontinued') NOT NULL DEFAULT 'planned',
    planned_launch_date   DATE NULL,
    actual_launch_date    DATE NULL,
    launch_date_flexible  BOOLEAN NOT NULL DEFAULT FALSE COMMENT '"As market needs"',
    comment               VARCHAR(500) NULL,
    dim_product_key       BIGINT NULL COMMENT 'Odoo product.product id (dim_product.ProductKey); validated by the API, no FK',
    sort_order            INT NOT NULL DEFAULT 0,
    source                ENUM('MANUAL', 'IMPORT', 'PROJECT') NOT NULL DEFAULT 'MANUAL',
    created_by INT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at DATETIME NULL, deleted_by INT NULL,
    alive      TINYINT AS (IF(deleted_at IS NULL, 1, NULL)) STORED,
    -- one name = one product across the whole tree (also the import's natural key), so a move keeps its identity
    UNIQUE KEY uq_pdp_product_name (company_key, name, alive),
    INDEX idx_pdp_product_subfamily (subfamily_id),
    INDEX idx_pdp_product_dim (dim_product_key),
    CONSTRAINT fk_pdp_product_company FOREIGN KEY (company_key) REFERENCES dim_company(CompanyKey),
    CONSTRAINT fk_pdp_product_subfamily FOREIGN KEY (subfamily_id) REFERENCES pdp_product_subfamily(subfamily_id),
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (deleted_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only: every status / launch date / move / Odoo link change, with its reason.
CREATE TABLE IF NOT EXISTS pdp_product_history (
    history_id   BIGINT AUTO_INCREMENT PRIMARY KEY,
    company_key  BIGINT NOT NULL,
    product_id   INT NOT NULL,
    field        VARCHAR(40) NOT NULL,
    from_value   VARCHAR(500) NULL,
    to_value     VARCHAR(500) NULL,
    reason       VARCHAR(1000) NULL,
    changed_by   INT NULL,
    changed_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_pdp_product_history (product_id, changed_at),
    CONSTRAINT fk_pdp_phist_company FOREIGN KEY (company_key) REFERENCES dim_company(CompanyKey),
    CONSTRAINT fk_pdp_phist_product FOREIGN KEY (product_id) REFERENCES pdp_product(product_id),
    FOREIGN KEY (changed_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------- plan reference
CREATE TABLE IF NOT EXISTS pdp_roadmap_year (
    roadmap_year_id INT AUTO_INCREMENT PRIMARY KEY,
    company_key  BIGINT NOT NULL,
    year         SMALLINT NOT NULL,
    theme        VARCHAR(150) NOT NULL,
    notes        TEXT NULL,
    created_by INT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at DATETIME NULL, deleted_by INT NULL,
    alive      TINYINT AS (IF(deleted_at IS NULL, 1, NULL)) STORED,
    UNIQUE KEY uq_pdp_roadmap_year (company_key, year, alive),
    CONSTRAINT chk_pdp_roadmap_year CHECK (year BETWEEN 2000 AND 2100),
    CONSTRAINT fk_pdp_roadmap_company FOREIGN KEY (company_key) REFERENCES dim_company(CompanyKey),
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (deleted_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pdp_gap_item (
    gap_id       INT AUTO_INCREMENT PRIMARY KEY,
    company_key  BIGINT NOT NULL,
    category     ENUM('MANPOWER', 'MACHINE', 'MATERIALS', 'METHODS', 'MEASUREMENTS') NOT NULL,
    item         VARCHAR(300) NOT NULL,
    owner_user_id INT NULL,
    status       ENUM('open', 'in_progress', 'done') NOT NULL DEFAULT 'open',
    due_date     DATE NULL,
    notes        TEXT NULL,
    sort_order   INT NOT NULL DEFAULT 0,
    created_by INT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at DATETIME NULL, deleted_by INT NULL,
    alive      TINYINT AS (IF(deleted_at IS NULL, 1, NULL)) STORED,
    UNIQUE KEY uq_pdp_gap (company_key, category, item(191), alive),
    CONSTRAINT fk_pdp_gap_company FOREIGN KEY (company_key) REFERENCES dim_company(CompanyKey),
    FOREIGN KEY (owner_user_id) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (deleted_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Policy text: versions of sections. One draft at a time; a published version is never edited again.
CREATE TABLE IF NOT EXISTS pdp_policy_version (
    version_id    INT AUTO_INCREMENT PRIMARY KEY,
    company_key   BIGINT NOT NULL,
    version_label VARCHAR(20) NOT NULL,
    status        ENUM('draft', 'published') NOT NULL DEFAULT 'draft',
    title         VARCHAR(200) NOT NULL DEFAULT 'TIKA R&D Policy',
    notes         TEXT NULL,
    source        ENUM('IMPORT', 'APP') NOT NULL DEFAULT 'APP',
    published_at  DATETIME NULL,
    published_by  INT NULL,
    created_by INT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at DATETIME NULL, deleted_by INT NULL,
    alive      TINYINT AS (IF(deleted_at IS NULL, 1, NULL)) STORED,
    UNIQUE KEY uq_pdp_policy_version (company_key, version_label, alive),
    CONSTRAINT chk_pdp_policy_published CHECK ((status = 'published') = (published_at IS NOT NULL)),
    CONSTRAINT fk_pdp_policy_company FOREIGN KEY (company_key) REFERENCES dim_company(CompanyKey),
    FOREIGN KEY (published_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (deleted_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pdp_policy_section (
    section_id   INT AUTO_INCREMENT PRIMARY KEY,
    company_key  BIGINT NOT NULL,
    version_id   INT NOT NULL,
    section_no   INT NOT NULL,
    title        VARCHAR(200) NOT NULL,
    body         MEDIUMTEXT NOT NULL,
    created_by INT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at DATETIME NULL, deleted_by INT NULL,
    alive      TINYINT AS (IF(deleted_at IS NULL, 1, NULL)) STORED,
    UNIQUE KEY uq_pdp_policy_section (version_id, section_no, alive),
    CONSTRAINT fk_pdp_psec_company FOREIGN KEY (company_key) REFERENCES dim_company(CompanyKey),
    CONSTRAINT fk_pdp_psec_version FOREIGN KEY (version_id) REFERENCES pdp_policy_version(version_id),
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (deleted_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Governance: the policy's roles, and the app users holding them (assigned on the admin screen, none seeded).
CREATE TABLE IF NOT EXISTS pdp_governance_role (
    role_id        INT AUTO_INCREMENT PRIMARY KEY,
    company_key    BIGINT NOT NULL,
    code           VARCHAR(30) NOT NULL,
    label          VARCHAR(100) NOT NULL,
    responsibility VARCHAR(500) NULL,
    sort_order     INT NOT NULL DEFAULT 0,
    created_by INT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_pdp_gov_role (company_key, code),
    CONSTRAINT fk_pdp_grole_company FOREIGN KEY (company_key) REFERENCES dim_company(CompanyKey),
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pdp_governance_member (
    member_id    INT AUTO_INCREMENT PRIMARY KEY,
    company_key  BIGINT NOT NULL,
    role_id      INT NOT NULL,
    user_id      INT NOT NULL,
    created_by INT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at DATETIME NULL, deleted_by INT NULL,
    alive      TINYINT AS (IF(deleted_at IS NULL, 1, NULL)) STORED,
    UNIQUE KEY uq_pdp_gov_member (role_id, user_id, alive),
    INDEX idx_pdp_gov_member_user (user_id),
    CONSTRAINT fk_pdp_gmem_company FOREIGN KEY (company_key) REFERENCES dim_company(CompanyKey),
    CONSTRAINT fk_pdp_gmem_role FOREIGN KEY (role_id) REFERENCES pdp_governance_role(role_id),
    CONSTRAINT fk_pdp_gmem_user FOREIGN KEY (user_id) REFERENCES app_user(user_id),
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (deleted_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------- configuration
CREATE TABLE IF NOT EXISTS pdp_setting (
    company_key   BIGINT NOT NULL,
    setting_key   VARCHAR(60) NOT NULL,
    setting_value VARCHAR(200) NOT NULL DEFAULT '',
    created_by INT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (company_key, setting_key),
    CONSTRAINT fk_pdp_setting_company FOREIGN KEY (company_key) REFERENCES dim_company(CompanyKey),
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pdp_kpi_target (
    kpi_id       INT AUTO_INCREMENT PRIMARY KEY,
    company_key  BIGINT NOT NULL,
    kpi_code     VARCHAR(40) NOT NULL,
    label        VARCHAR(100) NOT NULL,
    target       DECIMAL(10,2) NOT NULL,
    comparator   ENUM('gte', 'lte', 'eq') NOT NULL,
    unit         ENUM('count', 'pct', 'days') NOT NULL,
    period_type  ENUM('QUARTER') NOT NULL DEFAULT 'QUARTER',
    sort_order   INT NOT NULL DEFAULT 0,
    created_by INT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_pdp_kpi (company_key, kpi_code),
    CONSTRAINT fk_pdp_kpi_company FOREIGN KEY (company_key) REFERENCES dim_company(CompanyKey),
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pdp_scoring_criterion (
    criterion_id INT AUTO_INCREMENT PRIMARY KEY,
    company_key  BIGINT NOT NULL,
    code         VARCHAR(40) NOT NULL,
    name         VARCHAR(100) NOT NULL,
    weight       INT NOT NULL,
    meaning_0    VARCHAR(200) NOT NULL,
    meaning_1    VARCHAR(200) NOT NULL,
    meaning_2    VARCHAR(200) NOT NULL,
    meaning_3    VARCHAR(200) NOT NULL,
    meaning_4    VARCHAR(200) NOT NULL,
    meaning_5    VARCHAR(200) NOT NULL,
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order   INT NOT NULL DEFAULT 0,
    created_by INT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_pdp_criterion (company_key, code),
    CONSTRAINT chk_pdp_criterion_weight CHECK (weight BETWEEN 0 AND 100),
    CONSTRAINT fk_pdp_crit_company FOREIGN KEY (company_key) REFERENCES dim_company(CompanyKey),
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Sign-offs a gate needs: roles_json = governance role codes; ALL = one approval per role, ANY = one approval by any.
CREATE TABLE IF NOT EXISTS pdp_gate_rule (
    rule_id      INT AUTO_INCREMENT PRIMARY KEY,
    company_key  BIGINT NOT NULL,
    gate         ENUM('G1', 'G2', 'G3', 'G4', 'G5') NOT NULL,
    signoff_code VARCHAR(40) NOT NULL,
    label        VARCHAR(150) NOT NULL,
    roles_json   JSON NOT NULL,
    mode         ENUM('ALL', 'ANY') NOT NULL DEFAULT 'ANY',
    applies_to   ENUM('ALL', 'UNPLANNED') NOT NULL DEFAULT 'ALL',
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order   INT NOT NULL DEFAULT 0,
    created_by INT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_pdp_gate_rule (company_key, signoff_code),
    CONSTRAINT fk_pdp_grule_company FOREIGN KEY (company_key) REFERENCES dim_company(CompanyKey),
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Gate checklist items (feasibility G1, raw material G4, documentation package G5). `required` is the gate rule:
-- a required item must be done (and, with needs_evidence, carry an attachment or link) before the gate is approved.
CREATE TABLE IF NOT EXISTS pdp_checklist_template (
    template_id    INT AUTO_INCREMENT PRIMARY KEY,
    company_key    BIGINT NOT NULL,
    list_code      ENUM('FEASIBILITY', 'RAW_MATERIAL', 'DOCUMENTATION') NOT NULL,
    item_code      VARCHAR(40) NOT NULL,
    label          VARCHAR(200) NOT NULL,
    hint           VARCHAR(300) NULL,
    gate           ENUM('G1', 'G2', 'G3', 'G4', 'G5') NOT NULL,
    required       BOOLEAN NOT NULL DEFAULT TRUE,
    needs_evidence BOOLEAN NOT NULL DEFAULT FALSE,
    owner_role_code VARCHAR(30) NULL,
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order     INT NOT NULL DEFAULT 0,
    created_by INT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_pdp_checklist_tpl (company_key, item_code),
    CONSTRAINT fk_pdp_ctpl_company FOREIGN KEY (company_key) REFERENCES dim_company(CompanyKey),
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pdp_dropdown_value (
    value_id     INT AUTO_INCREMENT PRIMARY KEY,
    company_key  BIGINT NOT NULL,
    list_key     ENUM('project_type', 'request_source', 'competitor', 'lab_property', 'feedback_channel', 'feedback_category') NOT NULL,
    label        VARCHAR(100) NOT NULL,
    sort_order   INT NOT NULL DEFAULT 0,
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    created_by INT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_pdp_dropdown (company_key, list_key, label),
    CONSTRAINT fk_pdp_dd_company FOREIGN KEY (company_key) REFERENCES dim_company(CompanyKey),
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------- projects
-- RD-YYYY-NNN counter per company and year (never reused, also after a soft delete).
CREATE TABLE IF NOT EXISTS pdp_project_seq (
    company_key BIGINT NOT NULL,
    year        SMALLINT NOT NULL,
    last_no     INT NOT NULL DEFAULT 0,
    PRIMARY KEY (company_key, year),
    CONSTRAINT fk_pdp_seq_company FOREIGN KEY (company_key) REFERENCES dim_company(CompanyKey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pdp_project (
    project_id            INT AUTO_INCREMENT PRIMARY KEY,
    company_key           BIGINT NOT NULL,
    code                  VARCHAR(20) NOT NULL,
    title                 VARCHAR(200) NOT NULL,
    description           TEXT NULL,
    product_id            INT NULL,
    proposed_product_name VARCHAR(200) NULL,
    proposed_subfamily_id INT NULL,
    classification        ENUM('planned', 'unplanned', 'innovation', 'reformulation') NOT NULL,
    project_type_id       INT NOT NULL,
    innovation_category   ENUM('quick_win', 'commercial_driven', 'technical_enhancement', 'strategic_long_term') NULL,
    requested_by          VARCHAR(150) NOT NULL,
    request_source_id     INT NOT NULL,
    fast_track            BOOLEAN NOT NULL DEFAULT FALSE,
    owner_user_id         INT NULL,
    current_gate          ENUM('G0', 'G1', 'G2', 'G3', 'G4', 'G5') NOT NULL DEFAULT 'G0',
    gate_round            INT NOT NULL DEFAULT 1 COMMENT 'decision round at current_gate; a revise starts the next one',
    state                 ENUM('draft', 'submitted', 'active', 'on_hold', 'rejected', 'launched', 'closed') NOT NULL DEFAULT 'draft',
    submitted_at          DATETIME NULL,
    target_launch_date    DATE NULL,
    start_date            DATE NULL COMMENT 'G1 approval (kick-off)',
    launched_at           DATETIME NULL COMMENT 'G5 approval',
    closed_date           DATE NULL,
    objectives            TEXT NULL,
    closure_report        TEXT NULL,
    created_by INT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at DATETIME NULL, deleted_by INT NULL,
    UNIQUE KEY uq_pdp_project_code (company_key, code),
    INDEX idx_pdp_project_state (company_key, deleted_at, state),
    INDEX idx_pdp_project_product (product_id),
    CONSTRAINT chk_pdp_project_tree_link CHECK (product_id IS NOT NULL OR (proposed_product_name IS NOT NULL AND proposed_subfamily_id IS NOT NULL)),
    CONSTRAINT chk_pdp_project_innovation CHECK (innovation_category IS NULL OR classification = 'innovation'),
    CONSTRAINT chk_pdp_project_closed CHECK ((state = 'closed') = (closed_date IS NOT NULL)),
    CONSTRAINT fk_pdp_project_company FOREIGN KEY (company_key) REFERENCES dim_company(CompanyKey),
    CONSTRAINT fk_pdp_project_product FOREIGN KEY (product_id) REFERENCES pdp_product(product_id),
    CONSTRAINT fk_pdp_project_proposed_sub FOREIGN KEY (proposed_subfamily_id) REFERENCES pdp_product_subfamily(subfamily_id),
    CONSTRAINT fk_pdp_project_type FOREIGN KEY (project_type_id) REFERENCES pdp_dropdown_value(value_id),
    CONSTRAINT fk_pdp_project_source FOREIGN KEY (request_source_id) REFERENCES pdp_dropdown_value(value_id),
    FOREIGN KEY (owner_user_id) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (deleted_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pdp_project_member (
    member_id    INT AUTO_INCREMENT PRIMARY KEY,
    company_key  BIGINT NOT NULL,
    project_id   INT NOT NULL,
    user_id      INT NOT NULL,
    role_label   VARCHAR(100) NOT NULL,
    created_by INT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at DATETIME NULL, deleted_by INT NULL,
    alive      TINYINT AS (IF(deleted_at IS NULL, 1, NULL)) STORED,
    UNIQUE KEY uq_pdp_project_member (project_id, user_id, alive),
    CONSTRAINT fk_pdp_pmem_company FOREIGN KEY (company_key) REFERENCES dim_company(CompanyKey),
    CONSTRAINT fk_pdp_pmem_project FOREIGN KEY (project_id) REFERENCES pdp_project(project_id),
    CONSTRAINT fk_pdp_pmem_user FOREIGN KEY (user_id) REFERENCES app_user(user_id),
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (deleted_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only timeline of a project: creation, submission, decisions, state changes, edits, overrides.
CREATE TABLE IF NOT EXISTS pdp_project_history (
    history_id   BIGINT AUTO_INCREMENT PRIMARY KEY,
    company_key  BIGINT NOT NULL,
    project_id   INT NOT NULL,
    event        VARCHAR(40) NOT NULL,
    from_value   VARCHAR(500) NULL,
    to_value     VARCHAR(500) NULL,
    comment      TEXT NULL,
    changed_by   INT NULL,
    changed_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_pdp_project_history (project_id, changed_at),
    CONSTRAINT fk_pdp_prhist_company FOREIGN KEY (company_key) REFERENCES dim_company(CompanyKey),
    CONSTRAINT fk_pdp_prhist_project FOREIGN KEY (project_id) REFERENCES pdp_project(project_id),
    FOREIGN KEY (changed_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- G1 scoring rounds (append-only; the latest round counts). Criterion name/weight are snapshots, so an old round keeps
-- its total after an admin changes the weights.
CREATE TABLE IF NOT EXISTS pdp_score_round (
    round_id     INT AUTO_INCREMENT PRIMARY KEY,
    company_key  BIGINT NOT NULL,
    project_id   INT NOT NULL,
    round_no     INT NOT NULL,
    total        DECIMAL(6,2) NOT NULL,
    min_score    INT NOT NULL,
    passed       BOOLEAN NOT NULL,
    scored_by    INT NULL,
    scored_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_pdp_score_round (project_id, round_no),
    CONSTRAINT fk_pdp_sround_company FOREIGN KEY (company_key) REFERENCES dim_company(CompanyKey),
    CONSTRAINT fk_pdp_sround_project FOREIGN KEY (project_id) REFERENCES pdp_project(project_id),
    FOREIGN KEY (scored_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pdp_project_score (
    score_id       INT AUTO_INCREMENT PRIMARY KEY,
    company_key    BIGINT NOT NULL,
    round_id       INT NOT NULL,
    criterion_id   INT NOT NULL,
    criterion_name VARCHAR(100) NOT NULL,
    weight         INT NOT NULL,
    score          TINYINT NOT NULL,
    weighted       DECIMAL(6,2) NOT NULL,
    meaning        VARCHAR(200) NOT NULL,
    evidence       TEXT NOT NULL,
    UNIQUE KEY uq_pdp_project_score (round_id, criterion_id),
    CONSTRAINT chk_pdp_score_range CHECK (score BETWEEN 0 AND 5),
    CONSTRAINT fk_pdp_score_company FOREIGN KEY (company_key) REFERENCES dim_company(CompanyKey),
    CONSTRAINT fk_pdp_score_round FOREIGN KEY (round_id) REFERENCES pdp_score_round(round_id),
    CONSTRAINT fk_pdp_score_criterion FOREIGN KEY (criterion_id) REFERENCES pdp_scoring_criterion(criterion_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only gate decisions. gate_round: a revise moves the project to the next round, which needs fresh approvals.
CREATE TABLE IF NOT EXISTS pdp_gate_decision (
    decision_id        INT AUTO_INCREMENT PRIMARY KEY,
    company_key        BIGINT NOT NULL,
    project_id         INT NOT NULL,
    gate               ENUM('G1', 'G2', 'G3', 'G4', 'G5') NOT NULL,
    gate_round         INT NOT NULL,
    decision           ENUM('approve', 'reject', 'revise') NOT NULL,
    approver_user_id   INT NULL,
    approver_role_code VARCHAR(30) NOT NULL,
    comment            TEXT NULL,
    override_reason    TEXT NULL COMMENT 'capacity override (CEO/EXCO only)',
    decided_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_pdp_decision_project (project_id, gate, gate_round),
    CONSTRAINT fk_pdp_dec_company FOREIGN KEY (company_key) REFERENCES dim_company(CompanyKey),
    CONSTRAINT fk_pdp_dec_project FOREIGN KEY (project_id) REFERENCES pdp_project(project_id),
    FOREIGN KEY (approver_user_id) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Files, stored in MySQL like MARCOM's original uploads (marcom_upload_batch.original_file). 10 MB max; PDF, images,
-- DOCX, XLSX only (checked by the API, including the file signature).
CREATE TABLE IF NOT EXISTS pdp_attachment (
    attachment_id BIGINT AUTO_INCREMENT PRIMARY KEY,
    company_key   BIGINT NOT NULL,
    owner_type    ENUM('checklist', 'field_trial', 'project', 'launch', 'feedback', 'doc_error') NOT NULL,
    owner_id      BIGINT NOT NULL,
    file_name     VARCHAR(255) NOT NULL,
    mime_type     VARCHAR(100) NOT NULL,
    size_bytes    INT NOT NULL,
    sha256        CHAR(64) NOT NULL,
    content       LONGBLOB NOT NULL,
    created_by INT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at DATETIME NULL, deleted_by INT NULL,
    INDEX idx_pdp_attachment_owner (owner_type, owner_id),
    CONSTRAINT chk_pdp_attachment_size CHECK (size_bytes BETWEEN 1 AND 10485760),
    CONSTRAINT fk_pdp_att_company FOREIGN KEY (company_key) REFERENCES dim_company(CompanyKey),
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (deleted_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pdp_project_checklist (
    item_id       INT AUTO_INCREMENT PRIMARY KEY,
    company_key   BIGINT NOT NULL,
    project_id    INT NOT NULL,
    template_id   INT NOT NULL,
    status        ENUM('open', 'done') NOT NULL DEFAULT 'open',
    owner_user_id INT NULL,
    done_date     DATE NULL,
    link_url      VARCHAR(500) NULL,
    note          TEXT NULL,
    created_by INT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_pdp_project_checklist (project_id, template_id),
    CONSTRAINT chk_pdp_checklist_done CHECK ((status = 'done') = (done_date IS NOT NULL)),
    CONSTRAINT fk_pdp_pcl_company FOREIGN KEY (company_key) REFERENCES dim_company(CompanyKey),
    CONSTRAINT fk_pdp_pcl_project FOREIGN KEY (project_id) REFERENCES pdp_project(project_id),
    CONSTRAINT fk_pdp_pcl_template FOREIGN KEY (template_id) REFERENCES pdp_checklist_template(template_id),
    FOREIGN KEY (owner_user_id) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pdp_lab_test (
    test_id       INT AUTO_INCREMENT PRIMARY KEY,
    company_key   BIGINT NOT NULL,
    project_id    INT NOT NULL,
    trial_no      INT NOT NULL,
    test_date     DATE NOT NULL,
    competitor_id INT NULL,
    property_id   INT NOT NULL,
    target        VARCHAR(100) NOT NULL,
    result        VARCHAR(100) NOT NULL,
    unit          VARCHAR(30) NULL,
    passed        BOOLEAN NOT NULL,
    notes         TEXT NULL,
    created_by INT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at DATETIME NULL, deleted_by INT NULL,
    INDEX idx_pdp_lab_project (project_id, trial_no),
    CONSTRAINT chk_pdp_lab_trial CHECK (trial_no >= 1),
    CONSTRAINT fk_pdp_lab_company FOREIGN KEY (company_key) REFERENCES dim_company(CompanyKey),
    CONSTRAINT fk_pdp_lab_project FOREIGN KEY (project_id) REFERENCES pdp_project(project_id),
    CONSTRAINT fk_pdp_lab_competitor FOREIGN KEY (competitor_id) REFERENCES pdp_dropdown_value(value_id),
    CONSTRAINT fk_pdp_lab_property FOREIGN KEY (property_id) REFERENCES pdp_dropdown_value(value_id),
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (deleted_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pdp_field_trial (
    trial_id           INT AUTO_INCREMENT PRIMARY KEY,
    company_key        BIGINT NOT NULL,
    project_id         INT NOT NULL,
    trial_date         DATE NOT NULL,
    site               VARCHAR(200) NOT NULL,
    customer_key       BIGINT NULL COMMENT 'Odoo partner (dim_customer), TIKA customers only; validated by the API',
    customer_name      VARCHAR(200) NULL,
    score_setting      TINYINT NOT NULL,
    score_bonding      TINYINT NOT NULL,
    score_flexibility  TINYINT NOT NULL,
    score_coverage     TINYINT NOT NULL,
    score_satisfaction TINYINT NOT NULL,
    passed             BOOLEAN NOT NULL,
    ts_lead_user_id    INT NULL,
    notes              TEXT NULL,
    created_by INT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at DATETIME NULL, deleted_by INT NULL,
    INDEX idx_pdp_trial_project (project_id),
    CONSTRAINT chk_pdp_trial_scores CHECK (score_setting BETWEEN 1 AND 5 AND score_bonding BETWEEN 1 AND 5
        AND score_flexibility BETWEEN 1 AND 5 AND score_coverage BETWEEN 1 AND 5 AND score_satisfaction BETWEEN 1 AND 5),
    CONSTRAINT fk_pdp_trial_company FOREIGN KEY (company_key) REFERENCES dim_company(CompanyKey),
    CONSTRAINT fk_pdp_trial_project FOREIGN KEY (project_id) REFERENCES pdp_project(project_id),
    FOREIGN KEY (ts_lead_user_id) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (deleted_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Pilot batches (G4). Weight limits come from pdp_setting (500-1500 kg), checked by the API.
CREATE TABLE IF NOT EXISTS pdp_pilot_batch (
    batch_id      INT AUTO_INCREMENT PRIMARY KEY,
    company_key   BIGINT NOT NULL,
    project_id    INT NOT NULL,
    batch_no      INT NOT NULL,
    batch_date    DATE NOT NULL,
    batch_kg      DECIMAL(8,2) NOT NULL,
    qc_ok         BOOLEAN NOT NULL DEFAULT FALSE, qc_by INT NULL, qc_at DATETIME NULL,
    rnd_ok        BOOLEAN NOT NULL DEFAULT FALSE, rnd_by INT NULL, rnd_at DATETIME NULL,
    production_ok BOOLEAN NOT NULL DEFAULT FALSE, production_by INT NULL, production_at DATETIME NULL,
    notes         TEXT NULL,
    created_by INT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at DATETIME NULL, deleted_by INT NULL,
    INDEX idx_pdp_batch_project (project_id),
    CONSTRAINT chk_pdp_batch_kg CHECK (batch_kg > 0),
    CONSTRAINT fk_pdp_batch_company FOREIGN KEY (company_key) REFERENCES dim_company(CompanyKey),
    CONSTRAINT fk_pdp_batch_project FOREIGN KEY (project_id) REFERENCES pdp_project(project_id),
    FOREIGN KEY (qc_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (rnd_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (production_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (deleted_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Documentation errors found by QC/QA (KPI: 0 critical errors).
CREATE TABLE IF NOT EXISTS pdp_documentation_error (
    error_id     INT AUTO_INCREMENT PRIMARY KEY,
    company_key  BIGINT NOT NULL,
    project_id   INT NOT NULL,
    document     VARCHAR(150) NOT NULL,
    severity     ENUM('critical', 'minor') NOT NULL,
    found_date   DATE NOT NULL,
    description  TEXT NOT NULL,
    fixed_date   DATE NULL,
    created_by INT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at DATETIME NULL, deleted_by INT NULL,
    INDEX idx_pdp_docerr_project (project_id),
    CONSTRAINT fk_pdp_docerr_company FOREIGN KEY (company_key) REFERENCES dim_company(CompanyKey),
    CONSTRAINT fk_pdp_docerr_project FOREIGN KEY (project_id) REFERENCES pdp_project(project_id),
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (deleted_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------- monitoring
CREATE TABLE IF NOT EXISTS pdp_launch (
    launch_id          INT AUTO_INCREMENT PRIMARY KEY,
    company_key        BIGINT NOT NULL,
    product_id         INT NOT NULL,
    project_id         INT NULL,
    launch_date        DATE NULL,
    training_done      BOOLEAN NOT NULL DEFAULT FALSE,
    communication_done BOOLEAN NOT NULL DEFAULT FALSE,
    exco_decision_id   INT NULL,
    status             ENUM('planned', 'ready', 'launched') NOT NULL DEFAULT 'planned',
    notes              TEXT NULL,
    created_by INT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at DATETIME NULL, deleted_by INT NULL,
    alive      TINYINT AS (IF(deleted_at IS NULL, 1, NULL)) STORED,
    UNIQUE KEY uq_pdp_launch_product (product_id, alive),
    CONSTRAINT fk_pdp_launch_company FOREIGN KEY (company_key) REFERENCES dim_company(CompanyKey),
    CONSTRAINT fk_pdp_launch_product FOREIGN KEY (product_id) REFERENCES pdp_product(product_id),
    CONSTRAINT fk_pdp_launch_project FOREIGN KEY (project_id) REFERENCES pdp_project(project_id),
    CONSTRAINT fk_pdp_launch_decision FOREIGN KEY (exco_decision_id) REFERENCES pdp_gate_decision(decision_id),
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (deleted_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Customer feedback on Xtreme products, with a follow-up (open -> in progress -> resolved -> closed), like the NPS
-- detractor follow-up case + audit tables (0052/0066).
CREATE TABLE IF NOT EXISTS pdp_customer_feedback (
    feedback_id            INT AUTO_INCREMENT PRIMARY KEY,
    company_key            BIGINT NOT NULL,
    product_id             INT NOT NULL,
    customer_key           BIGINT NULL COMMENT 'Odoo partner (dim_customer), TIKA customers only; validated by the API',
    customer_name          VARCHAR(200) NULL,
    feedback_date          DATE NOT NULL,
    channel_id             INT NOT NULL,
    rating                 TINYINT NOT NULL,
    category_id            INT NOT NULL,
    comment                TEXT NULL,
    followup_owner_user_id INT NULL,
    followup_status        ENUM('open', 'in_progress', 'resolved', 'closed') NOT NULL DEFAULT 'open',
    due_date               DATE NULL,
    resolution             TEXT NULL,
    resolved_at            DATETIME NULL,
    created_by INT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at DATETIME NULL, deleted_by INT NULL,
    INDEX idx_pdp_feedback_product (product_id, feedback_date),
    CONSTRAINT chk_pdp_feedback_rating CHECK (rating BETWEEN 1 AND 5),
    CONSTRAINT chk_pdp_feedback_customer CHECK (customer_key IS NOT NULL OR customer_name IS NOT NULL),
    CONSTRAINT fk_pdp_fb_company FOREIGN KEY (company_key) REFERENCES dim_company(CompanyKey),
    CONSTRAINT fk_pdp_fb_product FOREIGN KEY (product_id) REFERENCES pdp_product(product_id),
    CONSTRAINT fk_pdp_fb_channel FOREIGN KEY (channel_id) REFERENCES pdp_dropdown_value(value_id),
    CONSTRAINT fk_pdp_fb_category FOREIGN KEY (category_id) REFERENCES pdp_dropdown_value(value_id),
    FOREIGN KEY (followup_owner_user_id) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id) ON DELETE SET NULL,
    FOREIGN KEY (deleted_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pdp_feedback_history (
    history_id   BIGINT AUTO_INCREMENT PRIMARY KEY,
    company_key  BIGINT NOT NULL,
    feedback_id  INT NOT NULL,
    field        VARCHAR(40) NOT NULL,
    from_value   VARCHAR(500) NULL,
    to_value     VARCHAR(500) NULL,
    comment      TEXT NULL,
    changed_by   INT NULL,
    changed_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_pdp_feedback_history (feedback_id, changed_at),
    CONSTRAINT fk_pdp_fbhist_company FOREIGN KEY (company_key) REFERENCES dim_company(CompanyKey),
    CONSTRAINT fk_pdp_fbhist_feedback FOREIGN KEY (feedback_id) REFERENCES pdp_customer_feedback(feedback_id),
    FOREIGN KEY (changed_by) REFERENCES app_user(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
