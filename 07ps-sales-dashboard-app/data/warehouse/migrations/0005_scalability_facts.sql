-- Scalability facts - beyond Sales/Promotion scope, mapping toward future 7P departments
-- (CRM Lead/Opportunity -> future Marketing/Sales-Ops depth; Delivery -> Supply Chain;
-- Inventory + BCG product performance -> Production/Product). Schema only, per instructions -
-- no API endpoints or dashboard pages are built against these in this session.
--
-- fact_lead and fact_opportunity reference each other (Fact_Lead.OpportunityID <->
-- Fact_Opportunity.LeadID in the source). Both tables are created first without that link, then
-- both FKs are added via ALTER TABLE at the end of this file, once both tables exist.
--
-- Corrected finding: fact_lead/fact_opportunity/fact_delivery all have the same broken
-- CustomerKey (100% null in source) + partially-resolving CustomerID pattern as fact_quotation.
-- Same fix applied: customer_key NOT NULL DEFAULT -1, falling back to the Unknown Customer row.
--
-- Corrected finding vs original design (found by loading real data, not visible from samples):
-- LeadID is NOT unique in Fact_Lead - 145 of 3,562 rows are duplicate LeadIDs. Root cause:
-- for every opportunity missing a real Odoo lead record, the source ETL synthesizes a second
-- "lead history" row with the SAME LeadID (LeadCreationSource='ETL', ~3,417 of 3,562 rows are
-- these synthetic placeholders; only 145 are real Odoo-sourced leads). PipelineRecordID is the
-- one column verified 100% unique (3,562/3,562) - that is the true grain, not LeadID. Fixed here:
-- pipeline_record_id is now the primary key, lead_id is a non-unique indexed attribute, and the
-- fact_opportunity.lead_id / fact_order.lead_id / fact_quotation.lead_id / fact_delivery.lead_id
-- columns are now documented soft links (no FK), since a LeadID alone can no longer uniquely
-- resolve to one fact_lead row. See ../README.md for the full explanation.

SET NAMES utf8mb4;

CREATE TABLE fact_lead (
    pipeline_record_id           VARCHAR(30) PRIMARY KEY,     -- true grain, verified 100% unique
    lead_id                     VARCHAR(30) NOT NULL,        -- NOT unique - see header note
    journey_key                    VARCHAR(30) NOT NULL,
    lead_name                        VARCHAR(255) NOT NULL,
    lead_type                          VARCHAR(30) NOT NULL,
    lead_created_date                    DATETIME NOT NULL,
    lead_created_date_key                  INT NOT NULL,
    lead_source                              VARCHAR(100) NULL,
    salesperson_key                            INT NULL,        -- 10 nulls in source
    sales_team_key                               VARCHAR(20) NULL,  -- 33 nulls in source
    segment_key                                    SMALLINT NOT NULL,
    company_key                                     SMALLINT NOT NULL,
    customer_key                                      INT NOT NULL DEFAULT -1,
    is_odoo_created_lead                                BOOLEAN NOT NULL DEFAULT FALSE,
    is_etl_created_lead                                   BOOLEAN NOT NULL DEFAULT FALSE,
    lead_creation_source                                    VARCHAR(20) NOT NULL,
    is_active_lead                                            BOOLEAN NOT NULL DEFAULT FALSE,
    is_converted_to_opportunity                                 BOOLEAN NOT NULL DEFAULT FALSE,
    opportunity_id                                                INT NULL,  -- FK added below (circular ref)
    lead_age_days                                                   DECIMAL(10, 2) NULL,
    FOREIGN KEY (lead_created_date_key) REFERENCES dim_date(date_key),
    FOREIGN KEY (salesperson_key) REFERENCES dim_salesperson(salesperson_key),
    FOREIGN KEY (sales_team_key) REFERENCES dim_sales_team(sales_team_key),
    FOREIGN KEY (segment_key) REFERENCES dim_segment(segment_key),
    FOREIGN KEY (company_key) REFERENCES dim_company(company_key),
    FOREIGN KEY (customer_key) REFERENCES dim_customer(customer_key),
    INDEX idx_fact_lead_created (lead_created_date_key),
    INDEX idx_fact_lead_lead_id (lead_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE fact_opportunity (
    opportunity_id              INT PRIMARY KEY,
    -- Soft link, NOT an FK: LeadID is not unique in fact_lead (see 0005 header note), so it
    -- cannot be a stable FK target. Resolve to a specific fact_lead row via pipeline_record_id
    -- (also present in Fact_Opportunity's source data) if a hard join is ever needed.
    lead_id                        VARCHAR(30) NULL,
    journey_key                      VARCHAR(30) NOT NULL,
    pipeline_record_id                 VARCHAR(30) NOT NULL,
    opportunity_name                     VARCHAR(255) NOT NULL,
    opportunity_created_date               DATETIME NOT NULL,
    opportunity_created_date_key             INT NOT NULL,
    expected_close_date                        DATE NULL,
    expected_close_date_key                      INT NULL,
    stage_id                                      INT NOT NULL,
    probability                                     DECIMAL(6, 2) NOT NULL,
    expected_revenue                                  DECIMAL(16, 2) NOT NULL,
    prorated_revenue                                    DECIMAL(16, 2) NOT NULL,
    is_active_opportunity                                 BOOLEAN NOT NULL DEFAULT FALSE,
    is_won                                                  BOOLEAN NOT NULL DEFAULT FALSE,
    is_lost                                                   BOOLEAN NOT NULL DEFAULT FALSE,
    is_open                                                     BOOLEAN NOT NULL DEFAULT FALSE,
    lost_reason_id                                                INT NULL,
    salesperson_key                                                 INT NULL,
    sales_team_key                                                    VARCHAR(20) NULL,
    segment_key                                                         SMALLINT NOT NULL,
    company_key                                                           SMALLINT NOT NULL,
    customer_key                                                            INT NOT NULL DEFAULT -1,
    has_quotation                                                             BOOLEAN NOT NULL DEFAULT FALSE,
    first_quotation_date                                                        DATETIME NULL,
    last_quotation_id                                                             INT NULL,
    last_quotation_date                                                             DATETIME NULL,
    last_quotation_value                                                              DECIMAL(16, 2) NULL,
    last_quotation_status                                                               VARCHAR(20) NULL,
    days_since_last_quotation                                                             DECIMAL(10, 2) NULL,
    opportunity_age_days                                                                    INT NOT NULL,
    FOREIGN KEY (opportunity_created_date_key) REFERENCES dim_date(date_key),
    FOREIGN KEY (expected_close_date_key) REFERENCES dim_date(date_key),
    FOREIGN KEY (stage_id) REFERENCES dim_crm_stage(stage_id),
    FOREIGN KEY (lost_reason_id) REFERENCES dim_lost_reason(lost_reason_id),
    FOREIGN KEY (salesperson_key) REFERENCES dim_salesperson(salesperson_key),
    FOREIGN KEY (sales_team_key) REFERENCES dim_sales_team(sales_team_key),
    FOREIGN KEY (segment_key) REFERENCES dim_segment(segment_key),
    FOREIGN KEY (company_key) REFERENCES dim_company(company_key),
    FOREIGN KEY (customer_key) REFERENCES dim_customer(customer_key),
    INDEX idx_fact_opportunity_stage (stage_id),
    INDEX idx_fact_opportunity_created (opportunity_created_date_key),
    INDEX idx_fact_opportunity_lead (lead_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Close the circular Lead <-> Opportunity reference now that both tables exist.
ALTER TABLE fact_lead ADD FOREIGN KEY fk_fact_lead_opportunity (opportunity_id) REFERENCES fact_opportunity(opportunity_id);

-- Fulfillment/logistics grain. order_key is nullable - 1,083 of 38,052 distinct delivery order
-- numbers don't correspond to any fact_order row (system-generated/non-CRM deliveries per the
-- source's own DeliveryClassification field) - confirmed programmatically, not a data error.
CREATE TABLE fact_delivery (
    delivery_fact_id            VARCHAR(20) PRIMARY KEY,   -- e.g. 'PICK-2'
    picking_id                     INT NULL,
    delivery_reference               VARCHAR(30) NULL,
    order_key                          VARCHAR(20) NULL,
    quotation_id                         INT NULL,
    opportunity_id                         INT NULL,
    lead_id                                  VARCHAR(30) NULL,  -- soft link, not FK - see 0005 header note
    customer_key                               INT NOT NULL DEFAULT -1,
    salesperson_key                              INT NULL,
    sales_team_key                                 VARCHAR(20) NULL,
    segment_key                                      SMALLINT NULL,
    company_key                                        SMALLINT NULL,
    order_date_key                                       INT NULL,
    scheduled_datetime                                     DATETIME NULL,
    scheduled_date_key                                       INT NULL,
    done_datetime                                              DATETIME NULL,
    done_date_key                                                INT NULL,
    delivery_datetime                                              DATETIME NULL,
    delivery_status                                                  VARCHAR(30) NOT NULL,
    is_real_delivery                                                   BOOLEAN NOT NULL DEFAULT FALSE,
    delivery_classification                                              VARCHAR(60) NOT NULL,
    picking_state                                                          VARCHAR(20) NULL,
    ordered_quantity                                                         DECIMAL(16, 3) NULL,
    delivered_quantity                                                         DECIMAL(16, 3) NULL,
    remaining_quantity                                                           DECIMAL(16, 3) NULL,
    delivery_progress_percent                                                      DECIMAL(6, 2) NULL,
    FOREIGN KEY (order_key) REFERENCES fact_order(order_key),
    FOREIGN KEY (quotation_id) REFERENCES fact_quotation(quotation_id),
    FOREIGN KEY (opportunity_id) REFERENCES fact_opportunity(opportunity_id),
    FOREIGN KEY (customer_key) REFERENCES dim_customer(customer_key),
    FOREIGN KEY (salesperson_key) REFERENCES dim_salesperson(salesperson_key),
    FOREIGN KEY (sales_team_key) REFERENCES dim_sales_team(sales_team_key),
    FOREIGN KEY (segment_key) REFERENCES dim_segment(segment_key),
    FOREIGN KEY (company_key) REFERENCES dim_company(company_key),
    FOREIGN KEY (order_date_key) REFERENCES dim_date(date_key),
    FOREIGN KEY (scheduled_date_key) REFERENCES dim_date(date_key),
    FOREIGN KEY (done_date_key) REFERENCES dim_date(date_key),
    INDEX idx_fact_delivery_order (order_key),
    INDEX idx_fact_delivery_status (delivery_status),
    INDEX idx_fact_delivery_lead (lead_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Snapshot fact (source is already a single full stock-take, SnapshotDate constant across all
-- rows) - shaped to accumulate one set of rows per future refresh. No separate Location/
-- Warehouse dimension exists anywhere in this export, so location/warehouse are kept as
-- degenerate fact attributes rather than an invented dimension (Section 6.5 "don't over-build" -
-- promote to a real dim_location only if/when a Supply Chain phase needs to conform it elsewhere).
CREATE TABLE fact_inventory_snapshot (
    snapshot_date               DATE NOT NULL,
    product_key                    VARCHAR(64) NOT NULL,
    location_id                      INT NOT NULL,
    company_key                        SMALLINT NOT NULL,
    location_name                        VARCHAR(100) NOT NULL,
    warehouse_name                         VARCHAR(100) NOT NULL,
    on_hand_qty                              DECIMAL(16, 3) NOT NULL,
    reserved_qty                               DECIMAL(16, 3) NOT NULL,
    available_qty                                DECIMAL(16, 3) NOT NULL,
    product_cost                                   DECIMAL(14, 4) NULL,
    inventory_value                                  DECIMAL(16, 2) NOT NULL,
    inventory_status                                   VARCHAR(30) NOT NULL,
    days_on_hand                                         DECIMAL(12, 2) NULL,
    avg_daily_sales                                        DECIMAL(14, 6) NULL,
    velocity_class                                           VARCHAR(20) NULL,
    PRIMARY KEY (snapshot_date, product_key, location_id),
    FOREIGN KEY (product_key) REFERENCES dim_product(product_key),
    FOREIGN KEY (company_key) REFERENCES dim_company(company_key),
    INDEX idx_fact_inventory_snapshot_product (product_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Renamed from source "Fact_BCGMatrix" - refresh-computed product portfolio classification
-- (Stars/Cash Cows/Dogs/Question Marks-style), same entity-status-history pattern as
-- fact_customer_status_snapshot: point-in-time computed values, never baked into dim_product.
CREATE TABLE fact_product_performance_snapshot (
    snapshot_date                DATE NOT NULL,
    product_key                     VARCHAR(64) NOT NULL,
    company_key                        SMALLINT NOT NULL,
    total_quantity_ytd                   DECIMAL(16, 3) NULL,
    total_quantity_lytd                    DECIMAL(16, 3) NULL,
    total_value_ytd                          DECIMAL(16, 2) NULL,
    total_value_lytd                           DECIMAL(16, 2) NULL,
    avg_unit_price_ytd                           DECIMAL(14, 4) NULL,
    avg_unit_price_lytd                            DECIMAL(14, 4) NULL,
    avg_product_cost_ytd                             DECIMAL(14, 4) NULL,
    avg_product_cost_lytd                              DECIMAL(14, 4) NULL,
    -- DECIMAL(10,4), not (8,6): low-volume products produce extreme gross-profit-% outliers (a
    -- near-zero quantity denominator) - real values as low as -391.0345 seen in the source, which
    -- overflowed the tighter precision originally assumed. Found by loading real data.
    perc_gross_profit_ytd                                DECIMAL(10, 4) NULL,
    perc_gross_profit_lytd                                 DECIMAL(10, 4) NULL,
    volume_class_ytd                                         VARCHAR(10) NULL,   -- HV / LV
    volume_class_lytd                                          VARCHAR(10) NULL,
    profit_class_ytd                                             VARCHAR(10) NULL,  -- HP / LP / Unknown
    profit_class_lytd                                              VARCHAR(10) NULL,
    bcg_code_ytd                                                     VARCHAR(10) NULL,  -- e.g. 'HV/LP'
    bcg_code_lytd                                                      VARCHAR(10) NULL,
    bcg_class_ytd                                                        VARCHAR(20) NULL,  -- Stars/Cash Cows/Dogs/...
    bcg_class_lytd                                                         VARCHAR(20) NULL,
    quantity_growth_pct                                                      DECIMAL(10, 6) NULL,
    gross_profit_change_pp                                                     DECIMAL(10, 6) NULL,
    bcg_movement                                                                 VARCHAR(20) NULL,  -- Improved/Stable/New/Declined/Lost
    PRIMARY KEY (snapshot_date, product_key, company_key),
    FOREIGN KEY (product_key) REFERENCES dim_product(product_key),
    FOREIGN KEY (company_key) REFERENCES dim_company(company_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Close the soft cross-tier links deferred from 0002 (core sales facts referencing
-- fact_opportunity, which didn't exist yet at that point in dependency order).
-- fact_order.lead_id / fact_quotation.lead_id stay unconstrained (no FK) - LeadID is not unique
-- in fact_lead (see header note above), so it cannot be a hard FK target from any table.
ALTER TABLE fact_order ADD FOREIGN KEY fk_fact_order_opportunity (opportunity_id) REFERENCES fact_opportunity(opportunity_id);
ALTER TABLE fact_quotation ADD FOREIGN KEY fk_fact_quotation_opportunity (opportunity_id) REFERENCES fact_opportunity(opportunity_id);
ALTER TABLE fact_order ADD INDEX idx_fact_order_lead (lead_id);
ALTER TABLE fact_quotation ADD INDEX idx_fact_quotation_lead (lead_id);
