-- Admin-controlled reference data layer for Customer Group / Distribution Channel / Company --
-- same overlay pattern as 0016_admin_salesperson_profile.sql (name + optional live-ETL link +
-- history), applied to Dim_Segment/Dim_DistributionChannel/Dim_Company instead of
-- Dim_Salesperson/Dim_SalesTeam.
--
-- SCOPE, deliberately narrower than the original ticket:
--   - Report MEASURES (Tachometer, Revenue Trend, BCG Matrix, etc.) are UNCHANGED -- they keep
--     filtering strictly by the live Dim_Segment/Dim_DistributionChannel/Dim_Company keys, exactly
--     as salesperson/team overlay overrides are reference-only and never fed into a measure (see
--     salespersonAdminService.ts's/salesTeamAdminService.ts's own header comments). This was an
--     explicit decision, not an oversight -- reversing it would change real reported figures and
--     needs its own design pass.
--   - Because of that, GET /filters/customer-groups /distribution-channels /business-units (which
--     feed the live report Filter Bar) only ever return admin_* rows that ARE linked to a live ETL
--     key (etl_*_key IS NOT NULL) -- a purely admin-invented group with no ETL link has nothing in
--     Fact_SalesLines/Fact_Targets to filter by, so surfacing it as a report filter option would be
--     a dead end (select it, get zero rows, with no indication why). Such rows still show up on
--     the admin management page itself, just not in the live report filter dropdowns.
--
-- SUPERSEDED (2026-09, "Reports/Dashboards Honor Admin Salesperson Overrides" -- this IS the
-- design pass the note above said reversing this would need): salesperson_admin_profile's
-- segment_key_override/channel_key_override/sales_team_key_override now DO reclassify revenue and
-- targets on every report measure (BCG Matrix/Brand Performance excepted). This table
-- (admin_customer_group/admin_distribution_channel/admin_company) itself is unchanged by that --
-- it still only supplies display names/ordering/active-state for the admin pages and the Filter
-- Bar, never which transactions land in which bucket. See
-- backend/src/measures/filters.ts's effectiveSegmentExpr docstring for the current mechanism.
--   - No hard-delete-user feature here -- app_user keeps its existing ACTIVE/INACTIVE/LOCKED
--     status model; login_history/revoked_tokens/every admin-profile history table's changed_by
--     all carry an unconditional FOREIGN KEY REFERENCES app_user(user_id) with no cascade, so a
--     real hard delete would either fail outright or require cascading through and destroying
--     every one of those audit trails. Out of scope for this migration.
--
-- Unlike 0016/0017 (salesperson/sales-team, keyed by a live ETL identifier that already exists on
-- every row), these three ARE seeded from live ETL data below -- Dim_Segment/DistributionChannel/
-- Company are tiny (5/4/2 rows) and the whole point is for the admin table to become the
-- authoritative source for the report Filter Bar from the start, not incidentally end up empty
-- (an empty admin_customer_group would mean "no customer groups on the report filter", not "fall
-- back to raw ETL" -- there is no such runtime fallback here, deliberately, to avoid the dropdown
-- silently losing every other option the moment an admin adds one custom item).
--
-- etl_*_key columns are BIGINT NULL (not VARCHAR, matching the real Dim_Segment.SegmentKey /
-- Dim_DistributionChannel.ChannelKey / Dim_Company.CompanyKey column types -- all raw-ETL BIGINT
-- with no PK/unique constraint, confirmed against the real warehouse, same "no enforced key on the
-- ETL side" situation 0009's header documents for Dim_Salesperson). UNIQUE on the etl key so at
-- most one admin row can claim a given live segment/channel/company -- MySQL's UNIQUE allows
-- multiple NULLs, so any number of purely custom (unlinked) rows are still fine.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS admin_customer_group (
    customer_group_id      INT AUTO_INCREMENT PRIMARY KEY,
    name                    VARCHAR(100) NOT NULL,
    definition              VARCHAR(500) NULL,
    etl_segment_key         BIGINT NULL,
    etl_segment_name        VARCHAR(100) NULL,
    display_order           INT NOT NULL DEFAULT 0,
    is_active               BOOLEAN NOT NULL DEFAULT TRUE,
    created_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by              INT NULL,
    updated_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    updated_by              INT NULL,
    FOREIGN KEY (created_by) REFERENCES app_user(user_id),
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id),
    UNIQUE KEY uk_admin_customer_group_name (name),
    UNIQUE KEY uk_admin_customer_group_etl_key (etl_segment_key),
    INDEX idx_admin_customer_group_active (is_active),
    INDEX idx_admin_customer_group_order (display_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_customer_group_history (
    history_id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    customer_group_id       INT NOT NULL,
    name                    VARCHAR(100) NULL,
    definition              VARCHAR(500) NULL,
    etl_segment_key         BIGINT NULL,
    etl_segment_name        VARCHAR(100) NULL,
    display_order           INT NULL,
    is_active               BOOLEAN NULL,
    action                  ENUM('CREATE', 'UPDATE', 'DEACTIVATE', 'REACTIVATE', 'DELETE') NOT NULL,
    changed_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    changed_by              INT NULL,
    FOREIGN KEY (changed_by) REFERENCES app_user(user_id),
    INDEX idx_admin_customer_group_history_row (customer_group_id, changed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_distribution_channel (
    distribution_channel_id INT AUTO_INCREMENT PRIMARY KEY,
    name                    VARCHAR(100) NOT NULL,
    definition              VARCHAR(500) NULL,
    etl_channel_key         BIGINT NULL,
    etl_channel_name        VARCHAR(100) NULL,
    display_order           INT NOT NULL DEFAULT 0,
    is_active               BOOLEAN NOT NULL DEFAULT TRUE,
    created_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by              INT NULL,
    updated_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    updated_by              INT NULL,
    FOREIGN KEY (created_by) REFERENCES app_user(user_id),
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id),
    UNIQUE KEY uk_admin_distribution_channel_name (name),
    UNIQUE KEY uk_admin_distribution_channel_etl_key (etl_channel_key),
    INDEX idx_admin_distribution_channel_active (is_active),
    INDEX idx_admin_distribution_channel_order (display_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_distribution_channel_history (
    history_id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    distribution_channel_id INT NOT NULL,
    name                    VARCHAR(100) NULL,
    definition              VARCHAR(500) NULL,
    etl_channel_key         BIGINT NULL,
    etl_channel_name        VARCHAR(100) NULL,
    display_order           INT NULL,
    is_active               BOOLEAN NULL,
    action                  ENUM('CREATE', 'UPDATE', 'DEACTIVATE', 'REACTIVATE', 'DELETE') NOT NULL,
    changed_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    changed_by              INT NULL,
    FOREIGN KEY (changed_by) REFERENCES app_user(user_id),
    INDEX idx_admin_distribution_channel_history_row (distribution_channel_id, changed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_company (
    company_id              INT AUTO_INCREMENT PRIMARY KEY,
    name                    VARCHAR(100) NOT NULL,
    definition              VARCHAR(500) NULL,
    etl_company_key         BIGINT NULL,
    etl_company_name        VARCHAR(100) NULL,
    display_order           INT NOT NULL DEFAULT 0,
    is_active               BOOLEAN NOT NULL DEFAULT TRUE,
    created_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by              INT NULL,
    updated_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    updated_by              INT NULL,
    FOREIGN KEY (created_by) REFERENCES app_user(user_id),
    FOREIGN KEY (updated_by) REFERENCES app_user(user_id),
    UNIQUE KEY uk_admin_company_name (name),
    UNIQUE KEY uk_admin_company_etl_key (etl_company_key),
    INDEX idx_admin_company_active (is_active),
    INDEX idx_admin_company_order (display_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_company_history (
    history_id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    company_id              INT NOT NULL,
    name                    VARCHAR(100) NULL,
    definition              VARCHAR(500) NULL,
    etl_company_key         BIGINT NULL,
    etl_company_name        VARCHAR(100) NULL,
    display_order           INT NULL,
    is_active               BOOLEAN NULL,
    action                  ENUM('CREATE', 'UPDATE', 'DEACTIVATE', 'REACTIVATE', 'DELETE') NOT NULL,
    changed_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    changed_by              INT NULL,
    FOREIGN KEY (changed_by) REFERENCES app_user(user_id),
    INDEX idx_admin_company_history_row (company_id, changed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed every live ETL value once, ordered by its own key -- see this file's header for why this is
-- mandatory (not the ticket's "optional"), and INSERT IGNORE (against the UNIQUE name/etl key)
-- so this stays safe to re-run: a name an admin has since edited, or a row an admin has since
-- deleted, is never silently recreated by a later run of this same file.
INSERT IGNORE INTO admin_customer_group (name, etl_segment_key, etl_segment_name, display_order)
SELECT Segment, SegmentKey, Segment, SegmentKey FROM Dim_Segment WHERE SegmentKey IS NOT NULL ORDER BY SegmentKey;

INSERT IGNORE INTO admin_distribution_channel (name, etl_channel_key, etl_channel_name, display_order)
SELECT DistributionChannel, ChannelKey, DistributionChannel, ChannelKey FROM Dim_DistributionChannel WHERE ChannelKey IS NOT NULL ORDER BY ChannelKey;

INSERT IGNORE INTO admin_company (name, etl_company_key, etl_company_name, display_order)
SELECT Company, CompanyKey, Company, CompanyKey FROM Dim_Company WHERE CompanyKey IS NOT NULL ORDER BY CompanyKey;

-- New Administration pages, same ADMIN-only pattern as 0016's Salesperson/Sales Team Management.
INSERT IGNORE INTO pages (page_key, page_label, nav_group, sort_order) VALUES
    ('admin_customer_groups', 'Customer Groups', 'Administration', 17),
    ('admin_distribution_channels', 'Distribution Channels', 'Administration', 18),
    ('admin_companies', 'Companies', 'Administration', 19);

INSERT IGNORE INTO permissions (page_id, action)
SELECT page_id, 'view' FROM pages WHERE page_key IN ('admin_customer_groups', 'admin_distribution_channels', 'admin_companies')
UNION ALL
SELECT page_id, 'export' FROM pages WHERE page_key IN ('admin_customer_groups', 'admin_distribution_channels', 'admin_companies');

INSERT IGNORE INTO role_permissions (role_id, permission_id, allowed)
SELECT r.role_id, p.permission_id, TRUE
FROM roles r
JOIN permissions p ON TRUE
JOIN pages pg ON pg.page_id = p.page_id
WHERE r.role_name = 'ADMIN'
  AND pg.page_key IN ('admin_customer_groups', 'admin_distribution_channels', 'admin_companies');
