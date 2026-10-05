-- 0030: Odoo sales team (crm.team) -> Excel org team (SalesTeamKey). Core, shared by every department.
--
-- Team rule (docs/adding-a-department.md, docs/ETL.md): a fact's team is the DOCUMENT's Odoo team (order, lead,
-- invoice ...), mapped by id through sheet OdooTeams of SalesTeam.xlsx to the Excel org code. crm.team is used only
-- as a lookup id, never by name. The team dimension stays dim_sales_team (the Excel org).
--   * SalesTeamKey = 'SALESPERSON' in the sheet -> follows_salesperson = 1: the document's team is its salesperson's
--     effective team (kept for Odoo teams with no Excel team, e.g. EXPORT, exactly as the legacy pipeline did).
--   * a document with no Odoo team -> its salesperson's effective team (legacy behaviour).
--   * an Odoo team missing from the sheet -> '-1' Unknown, reported as a warning with ids and value.
-- Idempotent. Reverse: data/warehouse/down/0030_core_team_map_down.sql.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS raw_odoo_crm_team (
    id BIGINT NOT NULL PRIMARY KEY,
    name VARCHAR(255) NULL,
    company_id BIGINT NULL,
    active TINYINT(1) NULL,
    _extracted_at DATETIME NOT NULL, _run_id CHAR(36) NOT NULL, _source_write_date DATETIME NULL, _deleted_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS raw_excel_odoo_teams (
    odoo_team_id BIGINT NOT NULL PRIMARY KEY,
    SalesTeamKey VARCHAR(64) NOT NULL COMMENT 'Excel org code, or SALESPERSON',
    odoo_team_name VARCHAR(255) NULL,
    note VARCHAR(512) NULL,
    _excel_row INT NOT NULL, _file_sha256 CHAR(64) NOT NULL, _extracted_at DATETIME NOT NULL, _run_id CHAR(36) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS map_odoo_team_sales_team (
    odoo_team_id BIGINT NOT NULL PRIMARY KEY,
    SalesTeamKey VARCHAR(64) NOT NULL COMMENT '-1 when follows_salesperson = 1',
    follows_salesperson TINYINT(1) NOT NULL DEFAULT 0,
    odoo_team_name VARCHAR(255) NULL,
    updated_at_utc DATETIME NOT NULL,
    INDEX ix_map_odoo_team_sales_team_key (SalesTeamKey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
