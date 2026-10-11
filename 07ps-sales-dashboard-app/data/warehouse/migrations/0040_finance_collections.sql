-- 0040: Receivables and Collections -- the Collections Trend (decision of 2026-10-08): money collected, day by day.
--
-- 1. raw_odoo_customer_payment: EVERY inbound customer payment of Odoo (account.payment payment_type 'inbound',
--    partner_type 'customer', companies ODOO_COMPANY_IDS), every state, full history on the first finance run
--    (about 62,000 since 2021), then incremental on write_date. Unlike raw_odoo_account_payment (0033), which only holds
--    the payments behind today's open receivable lines and is replaced every run, this keeps the history.
--    reconciled_invoice_ids = Odoo's reconciled_invoice_ids (computed, read at extraction), JSON array of move ids.
-- 2. fact_finance_collection: one row per POSTED inbound customer payment that is not an internal transfer, per
--    salesperson + branch it is attributed to:
--      attribution 'invoice'  the reconciled customer invoices' own salesperson (invoice_user_id) and branch (team_id);
--                             a payment of invoices of several salespersons / branches is split in proportion to those
--                             invoices' amounts (share), so the rows of a payment always add up to the payment;
--      attribution 'customer' not reconciled yet: the customer's salesperson of record and that salesperson's branch;
--      attribution 'none'     not reconciled and the customer has no salesperson.
--    Odoo itself leaves account.payment's Salesperson empty (checked 2026-10-08: 1,492 of 1,492 September payments),
--    so this is the only salesperson a payment has. Unreconciled payments are re-read every run until they are matched.
--    amount_company_ccy = Odoo amount_company_currency_signed (LYD, Odoo's own rate) x share;
--    amount_doc_ccy = amount (payment currency) x share. is_intercompany = an inter-company partner
--    (FINANCE_INTERCOMPANY_PARTNER_IDS or one of our own companies); the report leaves those out.
--
-- Requires 0033 (finance), 0029 (core dimensions). Idempotent. Reverse: data/warehouse/down/0040_finance_collections_down.sql.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS raw_odoo_customer_payment (
    id BIGINT NOT NULL PRIMARY KEY COMMENT 'account.payment id',
    move_id BIGINT NULL,
    name VARCHAR(255) NULL,
    date DATE NULL COMMENT 'payment date',
    state VARCHAR(16) NULL,
    partner_id BIGINT NULL,
    company_id BIGINT NULL,
    currency_id BIGINT NULL,
    journal_id BIGINT NULL,
    amount DECIMAL(20,6) NULL COMMENT 'payment currency',
    amount_company_currency_signed DECIMAL(20,6) NULL COMMENT 'company currency (LYD)',
    is_internal_transfer TINYINT(1) NULL,
    is_reconciled TINYINT(1) NULL,
    reconciled_invoice_ids JSON NULL COMMENT 'account.move ids (Odoo reconciled_invoice_ids)',
    _extracted_at DATETIME NOT NULL, _run_id CHAR(36) NOT NULL, _source_write_date DATETIME NULL,
    INDEX ix_raw_odoo_customer_payment_date (date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS fact_finance_collection (
    payment_id BIGINT NOT NULL COMMENT 'account.payment id',
    allocation_no SMALLINT NOT NULL COMMENT '1.. per payment (one per salesperson + branch it is split over)',
    payment_name VARCHAR(255) NULL,
    PaymentDateKey INT NOT NULL,
    payment_date DATE NOT NULL,
    CompanyKey BIGINT NOT NULL,
    CustomerKey BIGINT NOT NULL,
    CurrencyKey BIGINT NOT NULL,
    SalespersonKey INT NOT NULL,
    SalesTeamKey VARCHAR(64) NOT NULL,
    attribution VARCHAR(16) NOT NULL COMMENT 'invoice | customer | none',
    share DECIMAL(12,10) NOT NULL,
    amount_doc_ccy DECIMAL(20,6) NOT NULL,
    amount_company_ccy DECIMAL(20,6) NOT NULL,
    is_intercompany TINYINT(1) NOT NULL DEFAULT 0,
    loaded_at_utc DATETIME NOT NULL,
    _run_id CHAR(36) NOT NULL,
    PRIMARY KEY (payment_id, allocation_no),
    INDEX ix_fact_finance_collection_date (PaymentDateKey),
    INDEX ix_fact_finance_collection_salesperson (SalespersonKey, PaymentDateKey),
    INDEX ix_fact_finance_collection_customer (CustomerKey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
