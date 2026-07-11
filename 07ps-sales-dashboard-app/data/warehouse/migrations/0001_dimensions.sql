-- MySQL 8 star schema - conformed dimensions.
-- Source: SalesModel_OneOutput.xlsx (28-sheet BI export). See ../README.md for the full
-- sheet -> table mapping and what was deliberately excluded/restructured.
--
-- Corrected assumption vs Standards Section 6.4: dim_product keys are a genuine mix of two
-- source schemes (an "official master list" key like TIKA-sku-n and a raw-Odoo-derived key
-- like ODOO-id or RAW_FROM_ODOO-hash), by design of the source ETL's product-mastering
-- process (see ProductMappingStatus). This was verified programmatically: 100% of
-- Fact_SalesLines.ProductKey values (2,572 distinct) resolve against Dim_Product - there is no
-- real product-key gap, despite the two visually different key formats.

SET NAMES utf8mb4;

CREATE TABLE dim_date (
    date_key            INT PRIMARY KEY,
    calendar_date       DATE NOT NULL UNIQUE,
    year                SMALLINT NOT NULL,
    month               TINYINT NOT NULL,
    month_name          VARCHAR(10) NOT NULL,
    year_month_label    VARCHAR(7) NOT NULL,
    quarter_label       VARCHAR(6) NOT NULL,
    day_of_month        TINYINT NOT NULL,
    day_of_year         SMALLINT NOT NULL,
    weekday_number      TINYINT NOT NULL,
    weekday_name        VARCHAR(10) NOT NULL,
    is_weekly_rest_day  BOOLEAN NOT NULL DEFAULT FALSE,
    INDEX idx_dim_date_year_month (year, month)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE dim_company (
    company_key         SMALLINT PRIMARY KEY,
    company_name        VARCHAR(50) NOT NULL UNIQUE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE dim_segment (
    segment_key         SMALLINT PRIMARY KEY,
    segment_name        VARCHAR(30) NOT NULL UNIQUE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE dim_distribution_channel (
    channel_key         SMALLINT PRIMARY KEY,
    channel_name        VARCHAR(30) NOT NULL UNIQUE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE dim_sales_team (
    sales_team_key      VARCHAR(20) PRIMARY KEY,
    sales_team_name     VARCHAR(150) NOT NULL,
    segment_key         SMALLINT NULL,
    city                VARCHAR(50) NULL,
    company_key         SMALLINT NULL,
    sales_team_status       ENUM('ACTIVE', 'INACTIVE', 'UNKNOWN') NOT NULL DEFAULT 'UNKNOWN',
    sales_team_status_raw   VARCHAR(20) NULL,
    FOREIGN KEY (segment_key) REFERENCES dim_segment(segment_key),
    FOREIGN KEY (company_key) REFERENCES dim_company(company_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE dim_salesperson (
    salesperson_key     INT PRIMARY KEY,
    salesperson_name    VARCHAR(150) NOT NULL,
    sales_team_key       VARCHAR(20) NULL,
    distribution_channel_key SMALLINT NULL,
    FOREIGN KEY (sales_team_key) REFERENCES dim_sales_team(sales_team_key),
    FOREIGN KEY (distribution_channel_key) REFERENCES dim_distribution_channel(channel_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE dim_customer (
    customer_key         INT PRIMARY KEY,
    customer_business_id VARCHAR(20) NULL UNIQUE,
    customer_name        VARCHAR(255) NOT NULL,
    company_key          SMALLINT NULL,
    sales_team_key        VARCHAR(20) NULL,
    distribution_channel_key SMALLINT NULL,
    customer_segment      VARCHAR(20) NULL,
    first_purchase_date   DATE NULL,
    FOREIGN KEY (company_key) REFERENCES dim_company(company_key),
    FOREIGN KEY (sales_team_key) REFERENCES dim_sales_team(sales_team_key),
    FOREIGN KEY (distribution_channel_key) REFERENCES dim_distribution_channel(channel_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE dim_product (
    product_key           VARCHAR(64) PRIMARY KEY,
    company_key            SMALLINT NULL,
    category                VARCHAR(100) NULL,
    brand                   VARCHAR(100) NULL,
    family                  VARCHAR(100) NULL,
    sku                      VARCHAR(255) NULL,
    size_label                VARCHAR(30) NULL,
    product_name             VARCHAR(512) NOT NULL,
    product_name_clean        VARCHAR(512) NULL,
    is_active                 BOOLEAN NOT NULL DEFAULT TRUE,
    product_mapping_status    VARCHAR(30) NULL,
    standard_cost             DECIMAL(14, 4) NULL,
    FOREIGN KEY (company_key) REFERENCES dim_company(company_key),
    INDEX idx_dim_product_sku (sku)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE dim_crm_stage (
    stage_id            INT PRIMARY KEY,
    stage_name           VARCHAR(100) NOT NULL,
    sequence_order        TINYINT NOT NULL,
    is_won_stage           BOOLEAN NOT NULL DEFAULT FALSE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE dim_lost_reason (
    lost_reason_id        INT PRIMARY KEY,
    lost_reason            VARCHAR(255) NOT NULL,
    lost_reason_english     VARCHAR(255) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
