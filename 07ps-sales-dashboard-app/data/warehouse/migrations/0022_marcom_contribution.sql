-- MARCOM Contribution pages (Promotion): manually-uploaded Excel data, NOT Odoo-driven.
-- Raw inputs only; every KPI is computed at query time (backend/src/marcom/kpi.ts).
--
-- Versioning: every data table is append-only per batch. `is_current` is 1 for the live row and
-- NULL for superseded ones, so UNIQUE(natural key, is_current) allows any number of history rows
-- but only one live row. Rolling back a batch deletes the rows it inserted (batch_id) and re-arms
-- the rows it superseded (superseded_by_batch), see marcom/service.ts rollbackLatestBatch.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS marcom_upload_batch (
    batch_id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    filename          VARCHAR(255) NOT NULL,
    file_hash         CHAR(64) NOT NULL,
    template_version  VARCHAR(20) NOT NULL,
    uploaded_by       INT NULL,
    uploaded_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status            ENUM('SUCCESS', 'FAILED', 'ROLLED_BACK') NOT NULL DEFAULT 'SUCCESS',
    summary_json      JSON NULL,
    period_from       DATE NULL,
    period_to         DATE NULL,
    original_file     LONGBLOB NULL,
    INDEX idx_marcom_batch_hash (file_hash),
    INDEX idx_marcom_batch_uploaded (uploaded_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS marcom_brand (
    brand_id          INT AUTO_INCREMENT PRIMARY KEY,
    name              VARCHAR(100) NOT NULL,
    created_batch_id  BIGINT NULL,
    UNIQUE KEY uq_marcom_brand_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS marcom_spend_monthly (
    id                        BIGINT AUTO_INCREMENT PRIMARY KEY,
    year                      SMALLINT NOT NULL,
    month                     TINYINT NOT NULL,
    brand_id                  INT NOT NULL,
    spend                     DECIMAL(18,2) NOT NULL,
    revenue_attributed        DECIMAL(18,2) NOT NULL,
    company_revenue_current   DECIMAL(18,2) NOT NULL,
    company_revenue_ly        DECIMAL(18,2) NOT NULL,
    budget                    DECIMAL(18,2) NOT NULL,
    new_customers             INT NOT NULL,
    avg_invoice               DECIMAL(18,2) NOT NULL,
    social_post_cost          DECIMAL(18,2) NOT NULL,
    clicks                    BIGINT NOT NULL,
    batch_id                  BIGINT NOT NULL,
    superseded_by_batch       BIGINT NULL,
    is_current                TINYINT NULL DEFAULT 1,
    created_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_marcom_spend (year, month, brand_id, is_current),
    INDEX idx_marcom_spend_batch (batch_id),
    INDEX idx_marcom_spend_super (superseded_by_batch),
    FOREIGN KEY (brand_id) REFERENCES marcom_brand(brand_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS marcom_campaign (
    id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
    name                VARCHAR(200) NOT NULL,
    brand_id            INT NOT NULL,
    start_date          DATE NOT NULL,
    end_date            DATE NOT NULL,
    status              ENUM('Planned', 'Ongoing', 'Completed', 'On Hold') NOT NULL,
    spend               DECIMAL(18,2) NOT NULL,
    revenue_attributed  DECIMAL(18,2) NOT NULL,
    batch_id            BIGINT NOT NULL,
    superseded_by_batch BIGINT NULL,
    is_current          TINYINT NULL DEFAULT 1,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_marcom_campaign (name, is_current),
    INDEX idx_marcom_campaign_batch (batch_id),
    INDEX idx_marcom_campaign_super (superseded_by_batch),
    FOREIGN KEY (brand_id) REFERENCES marcom_brand(brand_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS marcom_campaign_media (
    id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
    campaign_name       VARCHAR(200) NOT NULL,
    media_type          ENUM('1-Street Lights', '2-Mega Billboards', '3-Billboards', '4-Bridge Banners', '5-Light Screen') NOT NULL,
    units               INT NOT NULL,
    cost                DECIMAL(18,2) NOT NULL,
    batch_id            BIGINT NOT NULL,
    superseded_by_batch BIGINT NULL,
    is_current          TINYINT NULL DEFAULT 1,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_marcom_media (campaign_name, media_type, is_current),
    INDEX idx_marcom_media_batch (batch_id),
    INDEX idx_marcom_media_super (superseded_by_batch)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS marcom_social_monthly (
    id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
    year                SMALLINT NOT NULL,
    month               TINYINT NOT NULL,
    platform            ENUM('Facebook', 'Google', 'LinkedIn', 'Instagram', 'TikTok') NOT NULL,
    followers           BIGINT NOT NULL,
    impressions         BIGINT NOT NULL,
    clicks              BIGINT NOT NULL,
    engagement_paid     BIGINT NOT NULL,
    engagement_organic  BIGINT NOT NULL,
    batch_id            BIGINT NOT NULL,
    superseded_by_batch BIGINT NULL,
    is_current          TINYINT NULL DEFAULT 1,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_marcom_social (year, month, platform, is_current),
    INDEX idx_marcom_social_batch (batch_id),
    INDEX idx_marcom_social_super (superseded_by_batch)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS marcom_web_monthly (
    id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
    year                SMALLINT NOT NULL,
    month               TINYINT NOT NULL,
    bounce_visitors     BIGINT NOT NULL,
    total_visitors      BIGINT NOT NULL,
    sessions            BIGINT NOT NULL,
    total_minutes       DECIMAL(18,2) NOT NULL,
    batch_id            BIGINT NOT NULL,
    superseded_by_batch BIGINT NULL,
    is_current          TINYINT NULL DEFAULT 1,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_marcom_web (year, month, is_current),
    INDEX idx_marcom_web_batch (batch_id),
    INDEX idx_marcom_web_super (superseded_by_batch)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS marcom_trade_monthly (
    id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
    year                 SMALLINT NOT NULL,
    month                TINYINT NOT NULL,
    compliance_pct       DECIMAL(7,4) NOT NULL,
    giveaways_stock_pct  DECIMAL(7,4) NOT NULL,
    printed_stock_pct    DECIMAL(7,4) NOT NULL,
    attendees_actual     INT NOT NULL,
    attendees_expected   INT NOT NULL,
    batch_id             BIGINT NOT NULL,
    superseded_by_batch  BIGINT NULL,
    is_current           TINYINT NULL DEFAULT 1,
    created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_marcom_trade (year, month, is_current),
    INDEX idx_marcom_trade_batch (batch_id),
    INDEX idx_marcom_trade_super (superseded_by_batch)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS marcom_event (
    id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
    name                VARCHAR(200) NOT NULL,
    event_type          ENUM('1-Professionals', '2-Architects/Designers', '3-Corporate', '4-CSR',
                             '5-Entertainment', '6-Launch & Opening', '7-Internal/Trainings', '8-Exhibitions') NOT NULL,
    brand_id            INT NOT NULL,
    planned_date        DATE NOT NULL,
    completion_date     DATE NULL,
    status              ENUM('Planned', 'Completed', 'Postponed', 'Cancelled') NOT NULL,
    batch_id            BIGINT NOT NULL,
    superseded_by_batch BIGINT NULL,
    is_current          TINYINT NULL DEFAULT 1,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_marcom_event (name, brand_id, is_current),
    INDEX idx_marcom_event_batch (batch_id),
    INDEX idx_marcom_event_super (superseded_by_batch),
    INDEX idx_marcom_event_planned (planned_date),
    FOREIGN KEY (brand_id) REFERENCES marcom_brand(brand_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Pages / permissions. Four report pages follow the Promotion pattern (0012); the upload screen is
-- an ADMIN-only Administration page (0020 pattern).
INSERT IGNORE INTO pages (page_key, page_label, nav_group, sort_order) VALUES
    ('marcom_spending',        'MARCOM Spending',            'Sales', 20),
    ('marcom_media_campaigns', 'Media Campaign Performance', 'Sales', 21),
    ('marcom_digital',         'Digital Performance',        'Sales', 22),
    ('marcom_trade',           'Trade Marketing & Retail',   'Sales', 23),
    ('admin_marcom_upload',    'MARCOM Data Upload',         'Administration', 30);

INSERT IGNORE INTO permissions (page_id, action)
SELECT page_id, 'view' FROM pages WHERE page_key IN ('marcom_spending','marcom_media_campaigns','marcom_digital','marcom_trade','admin_marcom_upload')
UNION ALL
SELECT page_id, 'export' FROM pages WHERE page_key IN ('marcom_spending','marcom_media_campaigns','marcom_digital','marcom_trade','admin_marcom_upload');

INSERT IGNORE INTO role_permissions (role_id, permission_id, allowed)
SELECT r.role_id, p.permission_id, TRUE
FROM roles r
JOIN permissions p ON TRUE
JOIN pages pg ON pg.page_id = p.page_id
WHERE r.role_name = 'ADMIN'
  AND pg.page_key IN ('marcom_spending','marcom_media_campaigns','marcom_digital','marcom_trade','admin_marcom_upload');

INSERT IGNORE INTO role_permissions (role_id, permission_id, allowed)
SELECT r.role_id, p.permission_id, TRUE
FROM roles r
JOIN permissions p ON TRUE
JOIN pages pg ON pg.page_id = p.page_id
WHERE r.role_name IN ('GCEO', 'GCFO', 'GCCO', 'GCTO', 'TIKA_CEO', 'B2B_DIRECTOR', 'B2C_DIRECTOR')
  AND pg.page_key IN ('marcom_spending','marcom_media_campaigns','marcom_digital','marcom_trade');
