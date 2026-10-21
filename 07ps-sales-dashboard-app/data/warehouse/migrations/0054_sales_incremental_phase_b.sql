-- 0054: Phase B of the 30-minute refresh -- incremental sales (docs/etl-phase-b-sales-incremental.md).
--
--   raw_odoo_mirror          one row per Odoo record the sales build reads (sale.order, sale.order.line, stock.picking,
--                            stock.move, stock.quant, stock.location, crm.lead, crm.stage, crm.lost.reason,
--                            product.product per company, uom.uom, res.company): the search_read record as JSON text,
--                            exactly as Odoo returned it. Kept current by write_date every 30 minutes (job sales_mirror);
--                            deletions by the id checks. The sales build reads it instead of Odoo.
--   raw_odoo_mirror_meta     per mirrored model: the fields read and the fields_get answer the repositories ask for.
--   raw_odoo_names           current display name of every record a mirrored many2one points to (res.partner,
--                            res.users, crm.team, product.product, ...): a rename does not move the referring record's
--                            write_date, so the build takes names from here, not from the stored [id, name] pair.
--   shd_<sales mart>         shadow copies of the 17 sales mart tables (CREATE TABLE ... LIKE). ETL_SALES_MODE=shadow:
--                            the 30-minute build writes these; dashboards keep reading the live tables.
--   etl_shadow_compare       one row per live-vs-shadow comparison (job sales_shadow_compare, after the 02:00 refresh).
--   etl_shadow_diff          the cells of that comparison: per table row counts / row-level differences, and
--                            fact_sales_lines totals per company x currency x month x salesperson; DIFF rows only plus
--                            the table-level summary (MATCH cells are counted, not stored).
--   fact_sales_lines         + SalesLineGroupKey (SHA-1 of order|product|template UoM|discount, the stable row key) and
--                            Discount, filled by both the 02:00 build and the 30-minute build. The primary key stays
--                            SaleReportLineID for now (the build is a full rebuild, the key only has to be unique); it
--                            moves to SalesLineGroupKey in a later migration, once every row has one (Phase B step 2).
--
-- Requires 0031 (sales marts). Idempotent. Reverse: data/warehouse/down/0054_sales_incremental_phase_b_down.sql.

SET NAMES utf8mb4;

-- fact_sales_lines: the stable key and the discount ---------------------------------------------------------------------
SET @s = (SELECT IF(COUNT(*) = 0,
    'ALTER TABLE fact_sales_lines ADD COLUMN SalesLineGroupKey CHAR(40) NULL COMMENT ''SHA-1 of OdooOrderID|OdooProductID|template UoM id|discount (6 dp); stable across loads'' AFTER SaleReportLineID',
    'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND COLUMN_NAME = 'SalesLineGroupKey');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) = 0,
    'ALTER TABLE fact_sales_lines ADD COLUMN Discount DECIMAL(12,6) NULL COMMENT ''sale.order.line discount % of the group (part of the sale.report grouping)'' AFTER SalesLineGroupKey',
    'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND COLUMN_NAME = 'Discount');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) = 0,
    'ALTER TABLE fact_sales_lines ADD UNIQUE KEY ux_fact_sales_lines_group_key (SalesLineGroupKey)',
    'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_lines' AND INDEX_NAME = 'ux_fact_sales_lines_group_key');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- shadow copies of the sales marts (after the column change, so shd_fact_sales_lines has it) -----------------------------
CREATE TABLE IF NOT EXISTS shd_fact_sales_lines LIKE fact_sales_lines;
CREATE TABLE IF NOT EXISTS shd_fact_sales_orders LIKE fact_sales_orders;
CREATE TABLE IF NOT EXISTS shd_fact_sales_documents LIKE fact_sales_documents;
CREATE TABLE IF NOT EXISTS shd_fact_sales_targets LIKE fact_sales_targets;
CREATE TABLE IF NOT EXISTS shd_fact_sales_deliveries LIKE fact_sales_deliveries;
CREATE TABLE IF NOT EXISTS shd_fact_sales_leads LIKE fact_sales_leads;
CREATE TABLE IF NOT EXISTS shd_fact_sales_opportunities LIKE fact_sales_opportunities;
CREATE TABLE IF NOT EXISTS shd_fact_sales_product_daily LIKE fact_sales_product_daily;
CREATE TABLE IF NOT EXISTS shd_fact_sales_inventory_snapshot LIKE fact_sales_inventory_snapshot;
CREATE TABLE IF NOT EXISTS shd_fact_sales_bcg_matrix LIKE fact_sales_bcg_matrix;
CREATE TABLE IF NOT EXISTS shd_dim_sales_order LIKE dim_sales_order;
CREATE TABLE IF NOT EXISTS shd_dim_sales_crm_stage LIKE dim_sales_crm_stage;
CREATE TABLE IF NOT EXISTS shd_dim_sales_lost_reason LIKE dim_sales_lost_reason;
CREATE TABLE IF NOT EXISTS shd_dim_sales_product_cost LIKE dim_sales_product_cost;
CREATE TABLE IF NOT EXISTS shd_dim_sales_product_dashboard LIKE dim_sales_product_dashboard;
CREATE TABLE IF NOT EXISTS shd_dim_sales_product_group LIKE dim_sales_product_group;
CREATE TABLE IF NOT EXISTS shd_etl_sales_product_dashboard_meta LIKE etl_sales_product_dashboard_meta;

-- raw Odoo mirror ---------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw_odoo_mirror (
    model           VARCHAR(64)  NOT NULL COMMENT 'Odoo model, e.g. sale.order.line',
    company_ctx     INT          NOT NULL DEFAULT 0 COMMENT 'company of the read context (company-dependent fields, product.product); 0 = none',
    record_id       BIGINT       NOT NULL,
    parent_id       BIGINT       NULL COMMENT 'sale.order.line: its order; stock.move: its picking (children re-checked when the parent changes)',
    write_date      DATETIME     NULL COMMENT 'Odoo write_date (UTC) of the stored version',
    payload         MEDIUMTEXT   NOT NULL COMMENT 'the search_read record as JSON, as Odoo returned it',
    mirrored_at_utc DATETIME     NOT NULL,
    run_uid         CHAR(36)     NULL COMMENT 'etl_run_log.run_uid of the run that stored this version',
    PRIMARY KEY (model, company_ctx, record_id),
    KEY ix_raw_odoo_mirror_write_date (model, company_ctx, write_date),
    KEY ix_raw_odoo_mirror_parent (model, parent_id),
    KEY ix_raw_odoo_mirror_mirrored (mirrored_at_utc)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Odoo records the sales build reads, kept current by write_date (0054)';

CREATE TABLE IF NOT EXISTS raw_odoo_mirror_meta (
    model           VARCHAR(64)  NOT NULL,
    company_ctx     INT          NOT NULL DEFAULT 0,
    fields_json     MEDIUMTEXT   NOT NULL COMMENT 'JSON list: the fields read (requested by any repository and present in Odoo)',
    fields_get_json MEDIUMTEXT   NOT NULL COMMENT 'JSON: fields_get(attributes=string,type,relation) of the model',
    domain_json     TEXT         NOT NULL COMMENT 'JSON: the domain the mirror holds (the full refresh domain)',
    refreshed_at_utc DATETIME    NOT NULL,
    PRIMARY KEY (model, company_ctx)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='What raw_odoo_mirror holds per model (0054)';

CREATE TABLE IF NOT EXISTS raw_odoo_names (
    model           VARCHAR(64)  NOT NULL,
    record_id       BIGINT       NOT NULL,
    display_name    TEXT         NULL,
    write_date      DATETIME     NULL,
    mirrored_at_utc DATETIME     NOT NULL,
    PRIMARY KEY (model, record_id),
    KEY ix_raw_odoo_names_write_date (model, write_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Current display names of the records mirrored many2one fields point to (0054)';

-- live vs shadow comparison -----------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS etl_shadow_compare (
    compare_uid         CHAR(36)     NOT NULL,
    module              VARCHAR(32)  NOT NULL COMMENT 'sales (receivables / core later)',
    as_of_date          DATE         NOT NULL COMMENT 'business date (Africa/Tripoli) of the comparison',
    run_uid             CHAR(36)     NULL COMMENT 'etl_run_log.run_uid of the comparing run',
    live_run_uid        CHAR(36)     NULL COMMENT 'run that last loaded the live tables (the 02:00 full refresh)',
    shadow_run_uid      CHAR(36)     NULL COMMENT 'run that last wrote the shadow tables',
    started_at_utc      DATETIME     NOT NULL,
    finished_at_utc     DATETIME     NULL,
    status              ENUM('match','diff','failed') NOT NULL,
    tables_compared     INT          NOT NULL DEFAULT 0,
    rows_live           BIGINT       NOT NULL DEFAULT 0,
    rows_shadow         BIGINT       NOT NULL DEFAULT 0,
    rows_only_live      BIGINT       NOT NULL DEFAULT 0,
    rows_only_shadow    BIGINT       NOT NULL DEFAULT 0,
    rows_different      BIGINT       NOT NULL DEFAULT 0,
    cells_compared      INT          NOT NULL DEFAULT 0 COMMENT 'company x currency x month x salesperson cells of fact_sales_lines',
    cells_diff          INT          NOT NULL DEFAULT 0,
    excluded_orders     INT          NOT NULL DEFAULT 0 COMMENT 'orders changed in Odoo while the comparison ran (left out of the verdict, listed in summary_json)',
    summary_json        MEDIUMTEXT   NULL,
    error_message       TEXT         NULL,
    PRIMARY KEY (compare_uid),
    KEY ix_etl_shadow_compare_module_date (module, as_of_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Daily live-vs-shadow comparisons (0054)';

CREATE TABLE IF NOT EXISTS etl_shadow_diff (
    compare_uid     CHAR(36)     NOT NULL,
    table_name      VARCHAR(64)  NOT NULL,
    cell_key        VARCHAR(255) NOT NULL COMMENT 'company|currency|YYYY-MM|salesperson, or "*" for a table-level row',
    measure         VARCHAR(64)  NOT NULL,
    live_value      DECIMAL(24,6) NULL,
    shadow_value    DECIMAL(24,6) NULL,
    diff            DECIMAL(24,6) NULL,
    status          ENUM('MATCH','DIFF') NOT NULL,
    PRIMARY KEY (compare_uid, table_name, cell_key, measure)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Cells of a live-vs-shadow comparison: table-level rows and every DIFF cell (0054)';
