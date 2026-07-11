-- Core Sales/Promotion facts, at their real (verified) grains - not the single "Fact_Sales"
-- grain implied by its name in the source export.
--
-- Corrected finding vs assumption: the export's "Fact_Sales" sheet is NOT a sales-revenue fact -
-- it is a Quotation-to-Order CRM funnel fact (63,743 rows = every quotation, whether or not it
-- converted; SalesDocumentType is 'Sales Order' or 'Quotation'). Renamed here to fact_quotation.
-- The real order-header revenue fact is Fact_Orders (36,969 rows, one per confirmed order) ->
-- fact_order. The real invoice-LINE grain needed for the Invoices Engine page is Fact_SalesLines
-- (131,895 rows) -> fact_order_line.
--
-- Corrected finding vs assumption: Dim_Invoice is a trivial 1:1 lookup of InvoiceKey <->
-- order_number against Fact_Orders (verified: both 36,969 rows, identical key sets) - it carries
-- no information Fact_Orders doesn't already have, so it is folded into fact_order.invoice_key
-- rather than kept as its own table.
--
-- opportunity_id / lead_id below are intentionally plain columns, not FK-constrained here -
-- fact_opportunity/fact_lead are created in 0005 (scalability facts, later in dependency order).
-- The FK constraints for these cross-tier links are added at the end of 0005 via ALTER TABLE.

SET NAMES utf8mb4;

CREATE TABLE fact_order (
    order_key                 VARCHAR(20) PRIMARY KEY,     -- source order_number, e.g. 'S00001'
    invoice_key                INT NOT NULL UNIQUE,          -- source InvoiceKey (formerly Dim_Invoice)
    date_key                    INT NOT NULL,
    order_datetime               DATETIME NOT NULL,
    customer_key                 INT NOT NULL,               -- always populated in source (verified)
    salesperson_key               INT NOT NULL,
    sales_team_key                 VARCHAR(20) NULL,
    segment_key                    SMALLINT NOT NULL,
    channel_key                     SMALLINT NOT NULL,
    company_key                     SMALLINT NOT NULL,
    order_value                      DECIMAL(16, 2) NOT NULL,
    order_volume                      DECIMAL(16, 3) NOT NULL,
    invoice_status                    VARCHAR(20) NOT NULL,     -- invoiced / to invoice / upselling
    order_state                        VARCHAR(20) NOT NULL,     -- source only has 'sale' today
    -- Nullable (2026-07-05 finding, ingestion-layer validation run): a plain walk-in
    -- sales order with no CRM quotation history at all (no opportunity_id, never a
    -- 'draft'/'sent' quotation state) has no quotation date - the original NOT NULL
    -- assumed every real order always passes through a quotation first, which isn't
    -- universally true.
    quotation_date                      DATETIME NULL,
    quotation_age_minutes                 INT NULL,
    is_real_quotation                      BOOLEAN NOT NULL DEFAULT FALSE,
    is_real_sales_order                     BOOLEAN NOT NULL DEFAULT FALSE,
    is_linked_to_opportunity                 BOOLEAN NOT NULL DEFAULT FALSE,
    opportunity_id                            INT NULL,          -- soft link, FK added in 0005
    lead_id                                    VARCHAR(30) NULL,  -- soft link, FK added in 0005
    FOREIGN KEY (date_key) REFERENCES dim_date(date_key),
    FOREIGN KEY (customer_key) REFERENCES dim_customer(customer_key),
    FOREIGN KEY (salesperson_key) REFERENCES dim_salesperson(salesperson_key),
    FOREIGN KEY (sales_team_key) REFERENCES dim_sales_team(sales_team_key),
    FOREIGN KEY (segment_key) REFERENCES dim_segment(segment_key),
    FOREIGN KEY (channel_key) REFERENCES dim_distribution_channel(channel_key),
    FOREIGN KEY (company_key) REFERENCES dim_company(company_key),
    INDEX idx_fact_order_date (date_key),
    INDEX idx_fact_order_customer (customer_key),
    INDEX idx_fact_order_salesperson (salesperson_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Invoice-LINE grain - backs the Invoices Engine page's per-invoice efficiency metrics
-- (avg lines/volume/value per invoice) per Standards Section 6.3/Migration Plan 6.2.
CREATE TABLE fact_order_line (
    order_line_id               BIGINT AUTO_INCREMENT PRIMARY KEY,  -- source has no natural line id
    order_key                     VARCHAR(20) NOT NULL,
    invoice_key                    INT NOT NULL,
    date_key                        INT NOT NULL,
    customer_key                     INT NOT NULL,
    salesperson_key                   INT NOT NULL,
    sales_team_key                     VARCHAR(20) NULL,
    segment_key                         SMALLINT NOT NULL,
    channel_key                          SMALLINT NOT NULL,
    company_key                           SMALLINT NOT NULL,
    product_key                            VARCHAR(64) NOT NULL,
    quantity                                 DECIMAL(16, 3) NOT NULL,   -- source quantity / Volume (identical columns)
    line_value                                DECIMAL(16, 2) NOT NULL,   -- source line_total / Value / untaxed_total (identical columns)
    invoice_value                              DECIMAL(16, 2) NULL,       -- null for a small number of source rows (367)
    invoice_class                               ENUM('A', 'B', 'C', 'D') NULL,  -- already computed in source; kept as-is
    is_discount                                  BOOLEAN NOT NULL DEFAULT FALSE,
    invoice_status                                VARCHAR(20) NOT NULL,
    -- Point-in-time value describing the customer's status AT THE TIME of this specific
    -- historical line (Active Retained/Non Active/Reactivated/Blocked/Other/New) - this is a
    -- legitimate transaction-scoped fact attribute, NOT the same problem as Dim_Customer's
    -- refresh-dependent CustomerStatus (which changes for the same customer_key on every
    -- refresh and was moved to fact_customer_status_snapshot instead, see 0003).
    customer_status_at_sale                        VARCHAR(30) NULL,
    FOREIGN KEY (order_key) REFERENCES fact_order(order_key),
    FOREIGN KEY (date_key) REFERENCES dim_date(date_key),
    FOREIGN KEY (customer_key) REFERENCES dim_customer(customer_key),
    FOREIGN KEY (salesperson_key) REFERENCES dim_salesperson(salesperson_key),
    FOREIGN KEY (sales_team_key) REFERENCES dim_sales_team(sales_team_key),
    FOREIGN KEY (segment_key) REFERENCES dim_segment(segment_key),
    FOREIGN KEY (channel_key) REFERENCES dim_distribution_channel(channel_key),
    FOREIGN KEY (company_key) REFERENCES dim_company(company_key),
    FOREIGN KEY (product_key) REFERENCES dim_product(product_key),
    INDEX idx_fact_order_line_order (order_key),
    INDEX idx_fact_order_line_date (date_key),
    INDEX idx_fact_order_line_product (product_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Quotation-to-Order funnel grain (renamed from source "Fact_Sales" - see header note).
-- One row per quotation; order_key is NULL for quotations that never converted to a real order.
CREATE TABLE fact_quotation (
    quotation_id                 INT PRIMARY KEY,          -- source SalesDocumentID/QuotationID
    sales_document_type            ENUM('Sales Order', 'Quotation') NOT NULL,
    order_key                        VARCHAR(20) NULL,       -- NULL if never converted
    invoice_key                       INT NULL,
    journey_key                        VARCHAR(30) NOT NULL,
    quotation_date                      DATETIME NOT NULL,
    sales_order_date                     DATETIME NULL,
    quotation_age_minutes                  INT NOT NULL,
    date_key                                INT NOT NULL,       -- source OrderDate (see README caveat)
    -- customer_key = -1 (Unknown Customer) when the source CustomerID doesn't resolve against
    -- dim_customer - confirmed ~37% of rows fall into this bucket (see 0001 header note and
    -- ../README.md). Never left NULL so joins/aggregations always have a valid FK target.
    customer_key                              INT NOT NULL DEFAULT -1,
    salesperson_key                             INT NOT NULL,
    sales_team_key                               VARCHAR(20) NULL,
    segment_key                                   SMALLINT NOT NULL,
    channel_key                                    SMALLINT NOT NULL,
    company_key                                     SMALLINT NOT NULL,
    opportunity_id                                   INT NULL,      -- soft link, FK added in 0005
    lead_id                                           VARCHAR(30) NULL, -- soft link, FK added in 0005
    is_real_quotation                                  BOOLEAN NOT NULL,
    is_won_quotation                                    BOOLEAN NOT NULL DEFAULT FALSE,
    quotation_classification                              VARCHAR(60) NOT NULL,
    is_real_sales_order                                    BOOLEAN NOT NULL,
    sales_order_classification                               VARCHAR(60) NOT NULL,
    is_linked_to_opportunity                                  BOOLEAN NOT NULL DEFAULT FALSE,
    order_value                                                DECIMAL(16, 2) NULL,
    order_volume                                                 DECIMAL(16, 3) NULL,
    invoice_status                                                VARCHAR(20) NULL,
    order_state                                                    VARCHAR(20) NULL,
    FOREIGN KEY (order_key) REFERENCES fact_order(order_key),
    FOREIGN KEY (date_key) REFERENCES dim_date(date_key),
    FOREIGN KEY (customer_key) REFERENCES dim_customer(customer_key),
    FOREIGN KEY (salesperson_key) REFERENCES dim_salesperson(salesperson_key),
    FOREIGN KEY (sales_team_key) REFERENCES dim_sales_team(sales_team_key),
    FOREIGN KEY (segment_key) REFERENCES dim_segment(segment_key),
    FOREIGN KEY (channel_key) REFERENCES dim_distribution_channel(channel_key),
    FOREIGN KEY (company_key) REFERENCES dim_company(company_key),
    INDEX idx_fact_quotation_order (order_key),
    INDEX idx_fact_quotation_customer (customer_key),
    INDEX idx_fact_quotation_date (date_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
