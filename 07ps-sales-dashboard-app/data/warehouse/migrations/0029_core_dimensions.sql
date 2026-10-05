-- 0029: core layer -- conformed dimensions shared by every department (docs/rename-map.md, docs/ETL.md).
--
-- Keys are deterministic and never renumbered:
--   CompanyKey / CustomerKey / ProductKey / CurrencyKey / PaymentTermKey = Odoo ids
--     (CustomerKey = the COMMERCIAL partner id; contacts/addresses roll up through map_partner_customer)
--   SalespersonKey / ChannelKey / SegmentKey = frozen codes in SalesTeam.xlsx (today's values)
--   SalesTeamKey = SalesTeam.xlsx org code; ProductMasterKey = frozen code in PRODUCTS.xlsx
--   DateKey = yyyymmdd
-- Every dimension has a -1 "Unknown"/"Unassigned" member (SalesTeamKey / ProductMasterKey: '-1'); facts
-- never hold NULL keys. No FK constraints (warehouse convention): etl_dq_result orphan checks enforce them.
-- These tables are owned by migrations and loaded only by upsert (etl_platform.load.upsert). The ETL never
-- drops or recreates them.
--
-- Order of operations in this file:
--   1. safety check on stored CompanyKey values (aborts before any change if they are ambiguous)
--   2. data migration of key values stored in app tables (Tika 2 -> 3, Unknown 0/1/5 -> -1), first run only
--   3. legacy dimensions renamed to zz_legacy_* (rollback copies; dropped by 0032 after the regression)
--   4. core raw tables (raw_odoo_* / raw_excel_*), dimensions and maps created, -1 members seeded
--
-- DEPLOY NOTE: apply 0029 and 0030 in the same window as the platform code, with the legacy sales pipeline
-- stopped. The legacy writer's drop_recreate would otherwise drop and recreate dim_company/dim_customer/...
-- with its own schema.
-- Idempotent. Reverse: data/warehouse/down/0029_core_dimensions_down.sql.

SET NAMES utf8mb4;

-- -----------------------------------------------------------------------------------------------------------
-- 1. Safety check. Before this migration Tika is stored as 2; after it, as 3. If BOTH values occur, the
--    stored data is in an unknown state: stop here (the SELECT from a non-existent table aborts the script).
-- -----------------------------------------------------------------------------------------------------------
SET @tika2 = (SELECT
      (SELECT COUNT(*) FROM admin_company WHERE etl_company_key = 2)
    + (SELECT COUNT(*) FROM salesperson_admin_profile WHERE company_key_override = 2)
    + (SELECT COUNT(*) FROM sales_team_admin_profile WHERE company_key_override = 2)
    + (SELECT COUNT(*) FROM role_data_scope WHERE dimension = 'companyKeys' AND value = '2'));
SET @tika3 = (SELECT
      (SELECT COUNT(*) FROM admin_company WHERE etl_company_key = 3)
    + (SELECT COUNT(*) FROM salesperson_admin_profile WHERE company_key_override = 3)
    + (SELECT COUNT(*) FROM sales_team_admin_profile WHERE company_key_override = 3)
    + (SELECT COUNT(*) FROM role_data_scope WHERE dimension = 'companyKeys' AND value = '3'));
SET @s = IF(@tika2 > 0 AND @tika3 > 0,
    'SELECT * FROM `ABORT_0029__stored_CompanyKey_values_2_and_3_both_present__check_manually`',
    'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- -----------------------------------------------------------------------------------------------------------
-- 2. Stored key values (first run only: while dim_company still has the legacy schema, i.e. no CurrencyKey)
-- -----------------------------------------------------------------------------------------------------------
SET @first_run = (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
                  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_company' AND COLUMN_NAME = 'CurrencyKey');

-- CompanyKey: Tika 2 -> 3 (Odoo res.company id). Majaal stays 1.
SET @s = IF(@first_run, 'UPDATE admin_company SET etl_company_key = 3 WHERE etl_company_key = 2', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = IF(@first_run, 'UPDATE admin_company_history SET etl_company_key = 3 WHERE etl_company_key = 2', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = IF(@first_run, 'UPDATE salesperson_admin_profile SET company_key_override = 3 WHERE company_key_override = 2', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = IF(@first_run, 'UPDATE salesperson_admin_profile_history SET company_key_override = 3 WHERE company_key_override = 2', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = IF(@first_run, 'UPDATE sales_team_admin_profile SET company_key_override = 3 WHERE company_key_override = 2', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = IF(@first_run, 'UPDATE sales_team_admin_profile_history SET company_key_override = 3 WHERE company_key_override = 2', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = IF(@first_run, 'UPDATE role_data_scope SET value = ''3'' WHERE dimension = ''companyKeys'' AND value = ''2''', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Unknown members -> -1: SalespersonKey 0, ChannelKey 1 ("Unknown"), SegmentKey 5 ("Unknown"). None are stored
-- today; kept so a value saved between this proposal and the deploy is still mapped.
SET @s = IF(@first_run, 'UPDATE app_user SET salesperson_key = -1 WHERE salesperson_key = 0', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = IF(@first_run, 'UPDATE salesperson_admin_profile SET channel_key_override = -1 WHERE channel_key_override = 1', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = IF(@first_run, 'UPDATE salesperson_admin_profile_history SET channel_key_override = -1 WHERE channel_key_override = 1', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = IF(@first_run, 'UPDATE salesperson_admin_profile SET segment_key_override = -1 WHERE segment_key_override = 5', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = IF(@first_run, 'UPDATE salesperson_admin_profile_history SET segment_key_override = -1 WHERE segment_key_override = 5', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = IF(@first_run, 'UPDATE sales_team_admin_profile SET segment_key_override = -1 WHERE segment_key_override = 5', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = IF(@first_run, 'UPDATE sales_team_admin_profile_history SET segment_key_override = -1 WHERE segment_key_override = 5', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = IF(@first_run, 'UPDATE role_data_scope SET value = ''-1'' WHERE (dimension = ''channelKeys'' AND value = ''1'') OR (dimension = ''segmentKeys'' AND value = ''5'') OR (dimension = ''salespersonKeys'' AND value = ''0'')', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- -----------------------------------------------------------------------------------------------------------
-- 3. Legacy dimensions -> zz_legacy_* (only if the legacy table exists and has not been renamed yet)
-- -----------------------------------------------------------------------------------------------------------
SET @s = (SELECT IF(COUNT(*) = 1 AND @first_run, 'RENAME TABLE dim_company TO zz_legacy_dim_company', 'DO 0') FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_company');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 1 AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_customer' AND COLUMN_NAME = 'is_customer') = 0, 'RENAME TABLE dim_customer TO zz_legacy_dim_customer', 'DO 0') FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_customer');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 1 AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_salesperson' AND COLUMN_NAME = 'assigned_team_key') = 0, 'RENAME TABLE dim_salesperson TO zz_legacy_dim_salesperson', 'DO 0') FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_salesperson');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 1, 'RENAME TABLE dim_salesteam TO zz_legacy_dim_salesteam', 'DO 0') FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_salesteam');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 1, 'RENAME TABLE dim_distributionchannel TO zz_legacy_dim_distributionchannel', 'DO 0') FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_distributionchannel');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 1 AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_segment' AND COLUMN_NAME = 'updated_at_utc') = 0, 'RENAME TABLE dim_segment TO zz_legacy_dim_segment', 'DO 0') FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_segment');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 1 AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_date' AND COLUMN_NAME = 'updated_at_utc') = 0, 'RENAME TABLE dim_date TO zz_legacy_dim_date', 'DO 0') FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_date');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 1 AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_product' AND COLUMN_NAME = 'product_tmpl_id') = 0, 'RENAME TABLE dim_product TO zz_legacy_dim_product', 'DO 0') FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dim_product');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) = 1, 'RENAME TABLE fact_offdays TO zz_legacy_fact_offdays', 'DO 0') FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_offdays');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- -----------------------------------------------------------------------------------------------------------
-- 4a. Raw: Odoo (incremental upsert by id). Meta columns on every raw table:
--     _extracted_at (UTC), _run_id (etl_run_log.run_uid), _source_write_date (Odoo write_date, UTC),
--     _deleted_at (set by the id reconciliation when the record no longer exists in Odoo).
-- -----------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw_odoo_res_company (
    id BIGINT NOT NULL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    currency_id BIGINT NULL,
    currency_name VARCHAR(16) NULL,
    _extracted_at DATETIME NOT NULL, _run_id CHAR(36) NOT NULL, _source_write_date DATETIME NULL, _deleted_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS raw_odoo_res_currency (
    id BIGINT NOT NULL PRIMARY KEY,
    name VARCHAR(16) NOT NULL,
    symbol VARCHAR(16) NULL,
    decimal_places INT NULL,
    active TINYINT(1) NOT NULL DEFAULT 1,
    _extracted_at DATETIME NOT NULL, _run_id CHAR(36) NOT NULL, _source_write_date DATETIME NULL, _deleted_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS raw_odoo_res_partner (
    id BIGINT NOT NULL PRIMARY KEY,
    name VARCHAR(512) NULL,
    display_name VARCHAR(1024) NULL,
    commercial_partner_id BIGINT NULL,
    parent_id BIGINT NULL,
    is_company TINYINT(1) NULL,
    customer_rank INT NULL,
    supplier_rank INT NULL,
    user_id BIGINT NULL COMMENT 'salesperson of record (res.users)',
    company_id BIGINT NULL,
    type VARCHAR(32) NULL,
    ref VARCHAR(255) NULL,
    active TINYINT(1) NULL,
    _extracted_at DATETIME NOT NULL, _run_id CHAR(36) NOT NULL, _source_write_date DATETIME NULL, _deleted_at DATETIME NULL,
    INDEX ix_raw_odoo_res_partner_commercial (commercial_partner_id),
    INDEX ix_raw_odoo_res_partner_write (_source_write_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- company-dependent partner properties: read once per in-scope company (context allowed_company_ids=[company])
CREATE TABLE IF NOT EXISTS raw_odoo_res_partner_company (
    partner_id BIGINT NOT NULL,
    company_id BIGINT NOT NULL,
    credit_limit DECIMAL(20,6) NULL,
    property_payment_term_id BIGINT NULL,
    _extracted_at DATETIME NOT NULL, _run_id CHAR(36) NOT NULL, _source_write_date DATETIME NULL, _deleted_at DATETIME NULL,
    PRIMARY KEY (partner_id, company_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS raw_odoo_res_users (
    id BIGINT NOT NULL PRIMARY KEY,
    name VARCHAR(255) NULL,
    partner_id BIGINT NULL,
    company_id BIGINT NULL,
    share TINYINT(1) NULL,
    active TINYINT(1) NULL,
    _extracted_at DATETIME NOT NULL, _run_id CHAR(36) NOT NULL, _source_write_date DATETIME NULL, _deleted_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS raw_odoo_product_product (
    id BIGINT NOT NULL PRIMARY KEY,
    product_tmpl_id BIGINT NULL,
    name VARCHAR(512) NULL,
    display_name VARCHAR(1024) NULL,
    default_code VARCHAR(255) NULL,
    company_id BIGINT NULL COMMENT 'NULL = shared by all companies',
    categ_id BIGINT NULL,
    categ_name VARCHAR(512) NULL,
    uom_id BIGINT NULL,
    uom_name VARCHAR(128) NULL,
    detailed_type VARCHAR(32) NULL,
    active TINYINT(1) NULL,
    _extracted_at DATETIME NOT NULL, _run_id CHAR(36) NOT NULL, _source_write_date DATETIME NULL, _deleted_at DATETIME NULL,
    INDEX ix_raw_odoo_product_product_tmpl (product_tmpl_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS raw_odoo_account_payment_term (
    id BIGINT NOT NULL PRIMARY KEY,
    name VARCHAR(255) NULL,
    company_id BIGINT NULL,
    active TINYINT(1) NULL,
    _extracted_at DATETIME NOT NULL, _run_id CHAR(36) NOT NULL, _source_write_date DATETIME NULL, _deleted_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS raw_odoo_account_payment_term_line (
    id BIGINT NOT NULL PRIMARY KEY,
    payment_id BIGINT NULL,
    value VARCHAR(32) NULL,
    value_amount DECIMAL(20,6) NULL,
    nb_days INT NULL,
    delay_type VARCHAR(64) NULL,
    _extracted_at DATETIME NOT NULL, _run_id CHAR(36) NOT NULL, _source_write_date DATETIME NULL, _deleted_at DATETIME NULL,
    INDEX ix_raw_odoo_apt_line_term (payment_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------------------------------------
-- 4b. Raw: Excel (replaced as a whole on every run, from the validated sheet). _excel_row = sheet row number,
--     _file_sha256 = hash of the file the rows came from.
-- -----------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw_excel_salesperson (
    SalespersonKey INT NOT NULL PRIMARY KEY,
    Name VARCHAR(255) NOT NULL,
    TeamKey VARCHAR(64) NULL,
    Status VARCHAR(32) NULL,
    DistributionChannel VARCHAR(64) NULL,
    ChannelKey INT NULL,
    _excel_row INT NOT NULL, _file_sha256 CHAR(64) NOT NULL, _extracted_at DATETIME NOT NULL, _run_id CHAR(36) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS raw_excel_sales_team (
    TeamKey VARCHAR(64) NOT NULL PRIMARY KEY,
    TeamName VARCHAR(255) NULL,
    Company VARCHAR(64) NULL,
    CompanyKey BIGINT NULL,
    City VARCHAR(128) NULL,
    Territory VARCHAR(128) NULL,
    Segment VARCHAR(64) NULL,
    SegmentKey INT NULL,
    Status VARCHAR(32) NULL,
    _excel_row INT NOT NULL, _file_sha256 CHAR(64) NOT NULL, _extracted_at DATETIME NOT NULL, _run_id CHAR(36) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS raw_excel_odoo_users (
    odoo_user_id BIGINT NOT NULL PRIMARY KEY,
    SalespersonKey INT NOT NULL,
    odoo_user_name VARCHAR(255) NULL,
    note VARCHAR(512) NULL,
    _excel_row INT NOT NULL, _file_sha256 CHAR(64) NOT NULL, _extracted_at DATETIME NOT NULL, _run_id CHAR(36) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS raw_excel_channel (
    ChannelKey INT NOT NULL PRIMARY KEY,
    DistributionChannel VARCHAR(64) NOT NULL,
    _excel_row INT NOT NULL, _file_sha256 CHAR(64) NOT NULL, _extracted_at DATETIME NOT NULL, _run_id CHAR(36) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS raw_excel_segment (
    SegmentKey INT NOT NULL PRIMARY KEY,
    Segment VARCHAR(64) NOT NULL,
    _excel_row INT NOT NULL, _file_sha256 CHAR(64) NOT NULL, _extracted_at DATETIME NOT NULL, _run_id CHAR(36) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS raw_excel_products (
    ProductMasterKey VARCHAR(191) NOT NULL PRIMARY KEY,
    SheetProductKey VARCHAR(191) NULL,
    Company VARCHAR(64) NOT NULL,
    Category VARCHAR(255) NULL,
    Brand VARCHAR(255) NULL,
    SubBrand VARCHAR(255) NULL,
    Family VARCHAR(255) NULL,
    ProductName VARCHAR(512) NULL,
    OdooProductName VARCHAR(512) NOT NULL,
    ProductLevel VARCHAR(64) NULL,
    SKU VARCHAR(255) NULL,
    Size VARCHAR(128) NULL,
    IsActive TINYINT(1) NULL,
    OdooProductID BIGINT NULL COMMENT 'optional column in the sheet; an id match wins over the name match',
    _excel_row INT NOT NULL, _file_sha256 CHAR(64) NOT NULL, _extracted_at DATETIME NOT NULL, _run_id CHAR(36) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS raw_excel_offdays (
    _excel_row INT NOT NULL PRIMARY KEY,
    Date DATE NULL,
    OffDayType VARCHAR(64) NULL,
    HolidayName VARCHAR(255) NULL,
    Reason VARCHAR(512) NULL,
    Country VARCHAR(64) NULL,
    Company VARCHAR(64) NULL,
    CompanyKey BIGINT NULL,
    Branch VARCHAR(64) NULL,
    IsActive TINYINT(1) NULL,
    Source VARCHAR(128) NULL,
    Notes VARCHAR(1024) NULL,
    _file_sha256 CHAR(64) NOT NULL, _extracted_at DATETIME NOT NULL, _run_id CHAR(36) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS raw_excel_blocked_customers (
    _excel_row INT NOT NULL PRIMARY KEY,
    CustomerKey BIGINT NULL COMMENT 'Odoo commercial partner id (column added to BlockedCustomers.xlsx)',
    CustomerID VARCHAR(64) NULL,
    CustomerName VARCHAR(512) NULL,
    IsBlocked TINYINT(1) NULL,
    BlockedDate DATE NULL,
    UnblockedDate DATE NULL,
    BlockedReason VARCHAR(1024) NULL,
    Notes VARCHAR(1024) NULL,
    _file_sha256 CHAR(64) NOT NULL, _extracted_at DATETIME NOT NULL, _run_id CHAR(36) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------------------------------------
-- 4c. Conformed dimensions and maps
-- -----------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dim_company (
    CompanyKey BIGINT NOT NULL PRIMARY KEY COMMENT 'Odoo res.company.id (Majaal 1, Tika 3)',
    Company VARCHAR(128) NOT NULL COMMENT 'display name as on the pages (Majaal, Tika)',
    odoo_name VARCHAR(255) NULL,
    CurrencyKey BIGINT NOT NULL DEFAULT -1,
    currency VARCHAR(16) NULL,
    is_in_scope TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'in ODOO_COMPANY_IDS',
    updated_at_utc DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS dim_currency (
    CurrencyKey BIGINT NOT NULL PRIMARY KEY COMMENT 'Odoo res.currency.id',
    currency VARCHAR(16) NOT NULL,
    symbol VARCHAR(16) NULL,
    decimal_places INT NULL,
    active TINYINT(1) NOT NULL DEFAULT 1,
    updated_at_utc DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS dim_payment_term (
    PaymentTermKey BIGINT NOT NULL PRIMARY KEY COMMENT 'Odoo account.payment.term.id',
    payment_term VARCHAR(255) NOT NULL,
    CompanyKey BIGINT NOT NULL DEFAULT -1,
    active TINYINT(1) NOT NULL DEFAULT 1,
    max_days INT NULL COMMENT 'largest nb_days over the term lines',
    is_instalment TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'more than one term line',
    line_count INT NOT NULL DEFAULT 0,
    updated_at_utc DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS dim_customer (
    CustomerKey BIGINT NOT NULL PRIMARY KEY COMMENT 'Odoo commercial partner id',
    customer VARCHAR(512) NOT NULL,
    CustomerID VARCHAR(64) NULL COMMENT 'DEPRECATED: legacy name hash (CUST-xxxxxxxx), kept one release',
    is_company TINYINT(1) NULL,
    is_customer TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'customer_rank > 0',
    SalespersonKey INT NOT NULL DEFAULT -1 COMMENT 'salesperson of record (partner.user_id via map_odoo_user_salesperson)',
    odoo_salesperson_user_id BIGINT NULL,
    ref VARCHAR(255) NULL,
    active TINYINT(1) NOT NULL DEFAULT 1,
    is_deleted TINYINT(1) NOT NULL DEFAULT 0,
    -- BlockedCustomers.xlsx (core)
    IsBlocked TINYINT(1) NOT NULL DEFAULT 0,
    BlockedDate DATE NULL,
    UnblockedDate DATE NULL,
    BlockedReason VARCHAR(1024) NULL,
    Notes VARCHAR(1024) NULL,
    -- Customer Growth profile: same columns as the legacy Dim_Customer, recomputed per commercial partner by the
    -- sales job (column-scoped upsert after the sales facts load; NULL until the first sales run)
    company VARCHAR(64) NULL,
    salesperson VARCHAR(255) NULL,
    SalesTeamKey VARCHAR(64) NULL,
    DistributionChannel VARCHAR(64) NULL,
    Branch VARCHAR(128) NULL,
    First_Purchase_Date DATE NULL,
    Last_Purchase_Date DATE NULL,
    LY_Value DECIMAL(20,6) NULL,
    YTD_Value DECIMAL(20,6) NULL,
    Full_2023_Value DECIMAL(20,6) NULL,
    Full_2024_Value DECIMAL(20,6) NULL,
    Full_2025_Value DECIMAL(20,6) NULL,
    HasHistoryBeforeLYTD TINYINT(1) NULL,
    HasHistoryPostLYTDLastYear TINYINT(1) NULL,
    IsLYTD TINYINT(1) NULL,
    IsYTD TINYINT(1) NULL,
    IsLYFullYear TINYINT(1) NULL,
    CustomerSegment VARCHAR(64) NULL,
    CustomerClass_LY VARCHAR(64) NULL,
    IsActiveYTD TINYINT(1) NULL,
    CustomerStatus VARCHAR(64) NULL,
    updated_at_utc DATETIME NOT NULL,
    INDEX ix_dim_customer_name (customer(64)),
    INDEX ix_dim_customer_salesperson (SalespersonKey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS map_partner_customer (
    partner_id BIGINT NOT NULL PRIMARY KEY COMMENT 'any res.partner id (company, contact, address)',
    CustomerKey BIGINT NOT NULL COMMENT 'its commercial partner',
    is_commercial TINYINT(1) NOT NULL,
    updated_at_utc DATETIME NOT NULL,
    INDEX ix_map_partner_customer_customer (CustomerKey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS dim_customer_company (
    CustomerKey BIGINT NOT NULL,
    CompanyKey BIGINT NOT NULL,
    credit_limit DECIMAL(20,6) NULL,
    PaymentTermKey BIGINT NOT NULL DEFAULT -1 COMMENT 'default payment term (company-dependent in Odoo 17)',
    updated_at_utc DATETIME NOT NULL,
    PRIMARY KEY (CustomerKey, CompanyKey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS dim_channel (
    ChannelKey INT NOT NULL PRIMARY KEY COMMENT 'frozen code (SalesTeam.xlsx sheet channel)',
    DistributionChannel VARCHAR(64) NOT NULL,
    updated_at_utc DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS dim_segment (
    SegmentKey INT NOT NULL PRIMARY KEY COMMENT 'frozen code (SalesTeam.xlsx sheet segment)',
    Segment VARCHAR(64) NOT NULL,
    updated_at_utc DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS dim_sales_team (
    SalesTeamKey VARCHAR(64) NOT NULL PRIMARY KEY COMMENT 'SalesTeam.xlsx org code; -1 Unknown, UNASSIGNED',
    SalesTeam VARCHAR(255) NOT NULL,
    CompanyKey BIGINT NOT NULL DEFAULT -1,
    SalesTeamCompany VARCHAR(64) NULL,
    SegmentKey INT NOT NULL DEFAULT -1,
    SalesSegment VARCHAR(64) NULL,
    SalesCity VARCHAR(128) NULL,
    Territory VARCHAR(128) NULL,
    SalesTeamStatus VARCHAR(32) NULL,
    updated_at_utc DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS dim_salesperson (
    SalespersonKey INT NOT NULL PRIMARY KEY COMMENT 'frozen code (SalesTeam.xlsx); never reused or renumbered',
    salesperson VARCHAR(255) NOT NULL,
    SalesTeamKey VARCHAR(64) NOT NULL DEFAULT '-1' COMMENT 'effective team: the sheet team when Status = Active, else -1 (same rule as the legacy pipeline)',
    ChannelKey INT NOT NULL DEFAULT -1 COMMENT 'effective channel, same Active rule',
    DistributionChannel VARCHAR(64) NULL,
    assigned_team_key VARCHAR(64) NULL COMMENT 'TeamKey as written in the sheet, whatever the Status',
    status VARCHAR(32) NULL,
    updated_at_utc DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS map_odoo_user_salesperson (
    odoo_user_id BIGINT NOT NULL PRIMARY KEY,
    SalespersonKey INT NOT NULL,
    odoo_user_name VARCHAR(255) NULL,
    updated_at_utc DATETIME NOT NULL,
    INDEX ix_map_odoo_user_salesperson_sp (SalespersonKey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS dim_date (
    DateKey INT NOT NULL PRIMARY KEY COMMENT 'yyyymmdd; -1 = unknown date',
    Date DATE NULL,
    Year INT NULL,
    Month INT NULL,
    MonthName VARCHAR(16) NULL,
    YearMonth VARCHAR(7) NULL,
    Quarter VARCHAR(8) NULL,
    DayOfMonth INT NULL,
    DayOfYear INT NULL,
    WeekdayNumber INT NULL COMMENT 'Monday = 0',
    WeekdayName VARCHAR(16) NULL,
    IsWeeklyRestDay TINYINT(1) NULL,
    updated_at_utc DATETIME NOT NULL,
    UNIQUE KEY uq_dim_date_date (Date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS dim_offday (
    DateKey INT NOT NULL,
    OffDayType VARCHAR(64) NOT NULL,
    CompanyKey BIGINT NOT NULL COMMENT '-1 = every company',
    SalesTeamKey VARCHAR(64) NOT NULL COMMENT 'branch; -1 = every branch',
    Date DATE NOT NULL,
    Country VARCHAR(64) NULL,
    Company VARCHAR(64) NULL,
    Branch VARCHAR(64) NULL,
    HolidayName VARCHAR(255) NULL,
    Reason VARCHAR(512) NULL,
    updated_at_utc DATETIME NOT NULL,
    PRIMARY KEY (DateKey, OffDayType, CompanyKey, SalesTeamKey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS dim_product (
    ProductKey BIGINT NOT NULL PRIMARY KEY COMMENT 'Odoo product.product.id (the variant)',
    product_tmpl_id BIGINT NULL,
    OdooProductName VARCHAR(1024) NULL COMMENT 'display name, e.g. [CODE] Name',
    product_name VARCHAR(512) NULL,
    default_code VARCHAR(255) NULL,
    CompanyKey BIGINT NOT NULL DEFAULT -1 COMMENT '-1 = shared by all companies',
    category VARCHAR(512) NULL,
    uom VARCHAR(128) NULL,
    product_type VARCHAR(32) NULL,
    active TINYINT(1) NOT NULL DEFAULT 1,
    is_deleted TINYINT(1) NOT NULL DEFAULT 0,
    updated_at_utc DATETIME NOT NULL,
    INDEX ix_dim_product_tmpl (product_tmpl_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS dim_product_master (
    ProductMasterKey VARCHAR(191) NOT NULL PRIMARY KEY COMMENT 'frozen PRODUCTS.xlsx code; -1 = unmatched',
    SheetProductKey VARCHAR(191) NULL COMMENT 'the sheet family/SKU code (not unique)',
    CompanyKey BIGINT NOT NULL DEFAULT -1,
    Company VARCHAR(64) NULL,
    ProductName VARCHAR(512) NULL,
    ProductNameClean VARCHAR(512) NULL,
    OdooProductName VARCHAR(512) NULL,
    ProductMatchKey VARCHAR(600) NULL COMMENT 'COMPANY|NORMALIZED ODOO NAME (product_matching.match_key)',
    Category VARCHAR(255) NULL,
    Brand VARCHAR(255) NULL,
    SubBrand VARCHAR(255) NULL,
    Family VARCHAR(255) NULL,
    ProductLevel VARCHAR(64) NULL,
    SKU VARCHAR(255) NULL,
    Size VARCHAR(128) NULL,
    IsActive TINYINT(1) NULL,
    updated_at_utc DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS map_product_master (
    ProductKey BIGINT NOT NULL,
    CompanyKey BIGINT NOT NULL,
    ProductMasterKey VARCHAR(191) NOT NULL COMMENT '-1 = no PRODUCTS.xlsx row for this product in this company',
    match_status VARCHAR(32) NOT NULL COMMENT 'MatchedByOdooProductID | MatchedByCompanyAndName | Unmatched',
    updated_at_utc DATETIME NOT NULL,
    PRIMARY KEY (ProductKey, CompanyKey),
    INDEX ix_map_product_master_master (ProductMasterKey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------------------------------------
-- 4d. -1 members (and the UNASSIGNED team). INSERT IGNORE: never overwrites, safe to re-run.
-- -----------------------------------------------------------------------------------------------------------
SET @now = UTC_TIMESTAMP();
INSERT IGNORE INTO dim_company (CompanyKey, Company, odoo_name, CurrencyKey, currency, is_in_scope, updated_at_utc) VALUES (-1, 'Unknown', NULL, -1, NULL, 0, @now);
INSERT IGNORE INTO dim_currency (CurrencyKey, currency, active, updated_at_utc) VALUES (-1, 'Unknown', 1, @now);
INSERT IGNORE INTO dim_payment_term (PaymentTermKey, payment_term, CompanyKey, active, max_days, is_instalment, line_count, updated_at_utc) VALUES (-1, '(none)', -1, 1, NULL, 0, 0, @now);
INSERT IGNORE INTO dim_customer (CustomerKey, customer, is_customer, SalespersonKey, active, updated_at_utc) VALUES (-1, 'Unknown', 0, -1, 1, @now);
INSERT IGNORE INTO map_partner_customer (partner_id, CustomerKey, is_commercial, updated_at_utc) VALUES (-1, -1, 1, @now);
INSERT IGNORE INTO dim_channel (ChannelKey, DistributionChannel, updated_at_utc) VALUES (-1, 'Unknown', @now);
INSERT IGNORE INTO dim_segment (SegmentKey, Segment, updated_at_utc) VALUES (-1, 'Unknown', @now);
INSERT IGNORE INTO dim_sales_team (SalesTeamKey, SalesTeam, CompanyKey, SalesTeamCompany, SegmentKey, SalesSegment, SalesTeamStatus, updated_at_utc) VALUES ('-1', 'Unknown', -1, 'Unknown', -1, 'Unknown', 'ACTIVE', @now);
INSERT IGNORE INTO dim_salesperson (SalespersonKey, salesperson, SalesTeamKey, ChannelKey, DistributionChannel, status, updated_at_utc) VALUES (-1, 'Unassigned', '-1', -1, 'Unknown', NULL, @now);
INSERT IGNORE INTO dim_date (DateKey, Date, updated_at_utc) VALUES (-1, NULL, @now);
INSERT IGNORE INTO dim_product (ProductKey, OdooProductName, product_name, CompanyKey, active, updated_at_utc) VALUES (-1, 'Unknown', 'Unknown', -1, 1, @now);
INSERT IGNORE INTO dim_product_master (ProductMasterKey, CompanyKey, ProductName, ProductNameClean, IsActive, updated_at_utc) VALUES ('-1', -1, 'Unmatched', 'Unmatched', 1, @now);
