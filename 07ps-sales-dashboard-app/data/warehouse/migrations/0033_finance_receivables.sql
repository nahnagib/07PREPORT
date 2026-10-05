-- 0033: Finance department -- receivables (Debt report). Conformed with sales through the core dimensions.
--
-- Grain of the fact: one row per OPEN receivable journal item (account.move.line: account_type = asset_receivable,
-- posted, not reconciled, residual != 0) per snapshot date -- the basis of Odoo's Aged Receivable report.
-- Snapshots are kept (history starts with the first run; no backfill). A re-run of the same day replaces that day.
-- Keys: <Entity>Key, conformed with sales (dim_customer, dim_company, dim_salesperson, dim_sales_team, dim_currency,
-- dim_payment_term, dim_date). Rules: docs/ETL.md section 1A and docs/receivables-etl.md.
-- Labels: facts and dimensions hold Odoo's TECHNICAL values (move_type, payment_type, partner_type, payment_state,
-- state, delivery_status); the views show Odoo's own labels from dim_odoo_selection_label (0032), en + ar.
-- Inter-company receivables (the customer is one of our own companies) carry is_intercompany = 1 and are left out
-- of every v_finance_* view; the fact keeps them.
-- Requires 0032_core_odoo_labels. Idempotent. Reverse: data/warehouse/down/0033_finance_receivables_down.sql.

SET NAMES utf8mb4;

-- raw: the latest extraction of the open set (replaced each run; history lives in the snapshot fact) -------------
CREATE TABLE IF NOT EXISTS raw_odoo_account_move_line (
    id BIGINT NOT NULL PRIMARY KEY,
    move_id BIGINT NULL,
    move_name VARCHAR(255) NULL,
    partner_id BIGINT NULL,
    company_id BIGINT NULL,
    company_currency_id BIGINT NULL,
    currency_id BIGINT NULL,
    date DATE NULL,
    date_maturity DATE NULL,
    amount_residual DECIMAL(20,6) NULL,
    amount_residual_currency DECIMAL(20,6) NULL,
    payment_id BIGINT NULL,
    _extracted_at DATETIME NOT NULL, _run_id CHAR(36) NOT NULL, _source_write_date DATETIME NULL, _deleted_at DATETIME NULL,
    INDEX ix_raw_aml_move (move_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS raw_odoo_account_move (
    id BIGINT NOT NULL PRIMARY KEY,
    name VARCHAR(255) NULL,
    move_type VARCHAR(32) NULL,
    state VARCHAR(16) NULL,
    invoice_date DATE NULL,
    invoice_date_due DATE NULL,
    invoice_user_id BIGINT NULL,
    team_id BIGINT NULL,
    invoice_origin VARCHAR(1024) NULL,
    invoice_payment_term_id BIGINT NULL,
    partner_id BIGINT NULL,
    commercial_partner_id BIGINT NULL,
    company_id BIGINT NULL,
    currency_id BIGINT NULL,
    journal_id BIGINT NULL,
    amount_total DECIMAL(20,6) NULL,
    amount_total_signed DECIMAL(20,6) NULL,
    payment_state VARCHAR(32) NULL,
    _extracted_at DATETIME NOT NULL, _run_id CHAR(36) NOT NULL, _source_write_date DATETIME NULL, _deleted_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS raw_odoo_account_payment (
    id BIGINT NOT NULL PRIMARY KEY,
    move_id BIGINT NULL,
    name VARCHAR(255) NULL,
    payment_type VARCHAR(16) NULL,
    partner_type VARCHAR(16) NULL,
    state VARCHAR(16) NULL,
    journal_id BIGINT NULL,
    partner_id BIGINT NULL,
    company_id BIGINT NULL,
    currency_id BIGINT NULL,
    date DATE NULL,
    amount DECIMAL(20,6) NULL,
    ref VARCHAR(1024) NULL COMMENT 'memo / reference',
    is_reconciled TINYINT(1) NULL,
    is_matched TINYINT(1) NULL,
    create_uid BIGINT NULL,
    create_date DATETIME NULL,
    _extracted_at DATETIME NOT NULL, _run_id CHAR(36) NOT NULL, _source_write_date DATETIME NULL, _deleted_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS raw_odoo_account_journal (
    id BIGINT NOT NULL PRIMARY KEY,
    name_en VARCHAR(255) NULL,
    name_ar VARCHAR(255) NULL,
    code VARCHAR(32) NULL,
    type VARCHAR(16) NULL,
    company_id BIGINT NULL,
    _extracted_at DATETIME NOT NULL, _run_id CHAR(36) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS raw_odoo_sale_order_invoice (
    sale_order_id BIGINT NOT NULL,
    move_id BIGINT NOT NULL,
    order_name VARCHAR(255) NULL,
    company_id BIGINT NULL,
    delivery_status VARCHAR(32) NULL,
    _extracted_at DATETIME NOT NULL, _run_id CHAR(36) NOT NULL,
    PRIMARY KEY (sale_order_id, move_id),
    INDEX ix_raw_soi_move (move_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- dimensions -------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dim_finance_aging_bucket (
    AgingBucketKey TINYINT NOT NULL PRIMARY KEY COMMENT 'aging sort 1-8 (departments/finance/aging.py); -1 Unknown',
    aging_bucket VARCHAR(32) NOT NULL COMMENT 'our own bucket name (not an Odoo field)',
    min_days_past_due INT NULL COMMENT 'inclusive; NULL = open-ended',
    max_days_past_due INT NULL COMMENT 'inclusive; NULL = open-ended',
    is_overdue TINYINT(1) NOT NULL,
    updated_at_utc DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS dim_finance_invoice (
    move_id BIGINT NOT NULL PRIMARY KEY COMMENT 'Odoo account.move.id; -1 Unknown',
    document VARCHAR(255) NULL COMMENT 'account.move.name',
    move_type VARCHAR(32) NULL COMMENT 'technical; label: dim_odoo_selection_label account.move/move_type',
    state VARCHAR(16) NULL,
    payment_state VARCHAR(32) NULL COMMENT 'technical; label: account.move/payment_state',
    journal_id BIGINT NULL,
    invoice_date DATE NULL,
    invoice_final_due_date DATE NULL COMMENT 'account.move.invoice_date_due (the LAST instalment); never used for aging',
    invoice_origin VARCHAR(1024) NULL,
    amount_total DECIMAL(20,6) NULL,
    amount_total_signed DECIMAL(20,6) NULL,
    delivery_status VARCHAR(16) NULL COMMENT 'invoices: Odoo sale.order.delivery_status value rolled up over the invoice orders (full | partial | pending); NULL when not an invoice or no order',
    has_sales_order TINYINT(1) NOT NULL DEFAULT 0,
    CustomerKey BIGINT NOT NULL DEFAULT -1,
    CompanyKey BIGINT NOT NULL DEFAULT -1,
    SalespersonKey INT NOT NULL DEFAULT -1,
    SalesTeamKey VARCHAR(64) NOT NULL DEFAULT '-1',
    PaymentTermKey BIGINT NOT NULL DEFAULT -1,
    CurrencyKey BIGINT NOT NULL DEFAULT -1 COMMENT 'document currency',
    is_intercompany TINYINT(1) NOT NULL DEFAULT 0,
    updated_at_utc DATETIME NOT NULL,
    INDEX ix_dfi_customer (CustomerKey, CompanyKey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS dim_finance_payment (
    PaymentKey BIGINT NOT NULL PRIMARY KEY COMMENT 'Odoo account.payment.id; -1 = the line is not a payment',
    payment_reference VARCHAR(255) NULL COMMENT 'account.payment.name',
    payment_type VARCHAR(16) NULL COMMENT 'technical (inbound | outbound); label: account.payment/payment_type',
    partner_type VARCHAR(16) NULL COMMENT 'technical (customer | supplier); label: account.payment/partner_type',
    state VARCHAR(16) NULL COMMENT 'technical; label: account.payment/state',
    journal_id BIGINT NULL,
    journal_name_en VARCHAR(255) NULL,
    journal_name_ar VARCHAR(255) NULL,
    payment_date DATE NULL,
    amount DECIMAL(20,6) NULL,
    memo VARCHAR(1024) NULL COMMENT 'account.payment.ref',
    is_reconciled TINYINT(1) NULL,
    is_matched TINYINT(1) NULL,
    created_by_user_id BIGINT NULL,
    CompanyKey BIGINT NOT NULL DEFAULT -1,
    CurrencyKey BIGINT NOT NULL DEFAULT -1,
    updated_at_utc DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bridge_finance_invoice_order (
    move_id BIGINT NOT NULL,
    SalesOrderKey BIGINT NOT NULL COMMENT 'Odoo sale.order.id (dim_sales_order)',
    order_name VARCHAR(255) NULL,
    delivery_status VARCHAR(16) NULL COMMENT 'Odoo sale.order.delivery_status (technical) as read',
    updated_at_utc DATETIME NOT NULL,
    PRIMARY KEY (move_id, SalesOrderKey),
    INDEX ix_bfio_order (SalesOrderKey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- fact: keys and technical values only --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fact_finance_receivable_snapshot (
    SnapshotDateKey INT NOT NULL COMMENT 'yyyymmdd, Africa/Tripoli',
    line_id BIGINT NOT NULL COMMENT 'Odoo account.move.line.id',
    move_id BIGINT NOT NULL COMMENT 'dim_finance_invoice',
    PaymentKey BIGINT NOT NULL DEFAULT -1 COMMENT 'dim_finance_payment; -1 = not a payment line',
    DueDateKey INT NOT NULL COMMENT 'date_maturity, else invoice_date_due, else line date',
    InvoiceDateKey INT NOT NULL COMMENT 'invoice_date, else line date',
    CustomerKey BIGINT NOT NULL,
    CompanyKey BIGINT NOT NULL,
    SalespersonKey INT NOT NULL,
    SalesTeamKey VARCHAR(64) NOT NULL,
    CurrencyKey BIGINT NOT NULL COMMENT 'document currency of residual_doc_ccy; residual_company_ccy is in dim_company.CurrencyKey',
    PaymentTermKey BIGINT NOT NULL,
    AgingBucketKey TINYINT NOT NULL,
    due_date DATE NOT NULL,
    days_past_due INT NOT NULL COMMENT 'snapshot date - due date; due today = 0 = not overdue',
    residual_company_ccy DECIMAL(20,6) NOT NULL COMMENT 'amount_residual; credit notes and inbound payments negative',
    residual_doc_ccy DECIMAL(20,6) NULL COMMENT 'amount_residual_currency',
    delivery_status VARCHAR(16) NULL COMMENT 'technical, from the invoice (see dim_finance_invoice)',
    is_intercompany TINYINT(1) NOT NULL DEFAULT 0,
    salesperson_source VARCHAR(16) NOT NULL COMMENT 'invoice_user | customer | none',
    _run_id CHAR(36) NOT NULL,
    loaded_at_utc DATETIME NOT NULL,
    PRIMARY KEY (SnapshotDateKey, line_id),
    INDEX ix_ffrs_customer (SnapshotDateKey, CompanyKey, CustomerKey),
    INDEX ix_ffrs_salesperson (SnapshotDateKey, SalespersonKey),
    INDEX ix_ffrs_bucket (SnapshotDateKey, AgingBucketKey),
    INDEX ix_ffrs_move (move_id),
    INDEX ix_ffrs_payment (PaymentKey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -1 members ---------------------------------------------------------------------------------------------------------
SET @now = UTC_TIMESTAMP();
INSERT IGNORE INTO dim_finance_aging_bucket (AgingBucketKey, aging_bucket, min_days_past_due, max_days_past_due, is_overdue, updated_at_utc)
VALUES (-1, 'Unknown', NULL, NULL, 0, @now);
INSERT IGNORE INTO dim_finance_invoice (move_id, document, updated_at_utc) VALUES (-1, 'Unknown', @now);
INSERT IGNORE INTO dim_finance_payment (PaymentKey, payment_reference, updated_at_utc) VALUES (-1, NULL, @now);

-- views: Odoo labels (en + ar), inter-company excluded --------------------------------------------------------------
CREATE OR REPLACE VIEW v_finance_receivable_latest AS
SELECT f.SnapshotDateKey, f.line_id, f.move_id, i.document,
       i.move_type, mt.label_en AS move_type_label_en, mt.label_ar AS move_type_label_ar,
       f.PaymentKey, p.payment_reference, p.payment_type, pty.label_en AS payment_type_label_en, pty.label_ar AS payment_type_label_ar,
       p.partner_type, prt.label_en AS partner_type_label_en, prt.label_ar AS partner_type_label_ar,
       p.journal_name_en AS payment_journal_en, p.journal_name_ar AS payment_journal_ar, p.memo AS payment_memo,
       -- document label: an invoice/credit note shows Odoo's move_type label; a payment shows Send/Receive + Customer/Vendor + journal
       CASE WHEN f.PaymentKey <> -1 THEN CONCAT_WS(' / ', pty.label_en, prt.label_en, p.journal_name_en) ELSE mt.label_en END AS document_label_en,
       CASE WHEN f.PaymentKey <> -1 THEN CONCAT_WS(' / ', pty.label_ar, prt.label_ar, p.journal_name_ar) ELSE mt.label_ar END AS document_label_ar,
       i.payment_state, ps.label_en AS payment_state_label_en, ps.label_ar AS payment_state_label_ar,
       f.CustomerKey, cu.customer, f.CompanyKey, co.Company AS company, f.SalespersonKey, sp.salesperson,
       f.SalesTeamKey, st.SalesTeam AS sales_team, f.PaymentTermKey, pt.payment_term, f.CurrencyKey, cur.currency AS doc_currency,
       co.currency AS company_currency, f.InvoiceDateKey, i.invoice_date, f.DueDateKey, f.due_date, i.invoice_final_due_date,
       f.days_past_due, f.AgingBucketKey, b.aging_bucket, b.is_overdue,
       f.residual_company_ccy, f.residual_doc_ccy, i.amount_total AS invoice_total,
       f.delivery_status, ds.label_en AS delivery_status_label_en, ds.label_ar AS delivery_status_label_ar, i.has_sales_order,
       cc.credit_limit AS customer_credit_limit, f.salesperson_source, f.loaded_at_utc
FROM fact_finance_receivable_snapshot f
JOIN dim_finance_invoice i ON i.move_id = f.move_id
JOIN dim_finance_payment p ON p.PaymentKey = f.PaymentKey
JOIN dim_customer cu ON cu.CustomerKey = f.CustomerKey
JOIN dim_company co ON co.CompanyKey = f.CompanyKey
JOIN dim_salesperson sp ON sp.SalespersonKey = f.SalespersonKey
JOIN dim_sales_team st ON st.SalesTeamKey = f.SalesTeamKey
JOIN dim_payment_term pt ON pt.PaymentTermKey = f.PaymentTermKey
JOIN dim_currency cur ON cur.CurrencyKey = f.CurrencyKey
JOIN dim_finance_aging_bucket b ON b.AgingBucketKey = f.AgingBucketKey
LEFT JOIN dim_customer_company cc ON cc.CustomerKey = f.CustomerKey AND cc.CompanyKey = f.CompanyKey
LEFT JOIN dim_odoo_selection_label mt ON mt.model = 'account.move' AND mt.field = 'move_type' AND mt.value = i.move_type
LEFT JOIN dim_odoo_selection_label ps ON ps.model = 'account.move' AND ps.field = 'payment_state' AND ps.value = i.payment_state
LEFT JOIN dim_odoo_selection_label pty ON pty.model = 'account.payment' AND pty.field = 'payment_type' AND pty.value = p.payment_type
LEFT JOIN dim_odoo_selection_label prt ON prt.model = 'account.payment' AND prt.field = 'partner_type' AND prt.value = p.partner_type
LEFT JOIN dim_odoo_selection_label ds ON ds.model = 'sale.order' AND ds.field = 'delivery_status' AND ds.value = f.delivery_status
WHERE f.SnapshotDateKey = (SELECT MAX(SnapshotDateKey) FROM fact_finance_receivable_snapshot)
  AND f.is_intercompany = 0;

CREATE OR REPLACE VIEW v_finance_receivable_trend AS
SELECT f.SnapshotDateKey, f.CompanyKey, f.AgingBucketKey, b.aging_bucket, b.is_overdue,
       SUM(f.residual_company_ccy) AS open_amount,
       SUM(CASE WHEN b.is_overdue = 1 THEN f.residual_company_ccy ELSE 0 END) AS overdue_amount,
       COUNT(*) AS line_count
FROM fact_finance_receivable_snapshot f
JOIN dim_finance_aging_bucket b ON b.AgingBucketKey = f.AgingBucketKey
WHERE f.is_intercompany = 0
GROUP BY f.SnapshotDateKey, f.CompanyKey, f.AgingBucketKey, b.aging_bucket, b.is_overdue;

-- one row per company + customer on the latest snapshot; sales_last_90d / DSO from the sales lines of the same
-- CustomerKey + CompanyKey in the 90 days up to the snapshot date (DSO = open / sales_last_90d * 90)
CREATE OR REPLACE VIEW v_finance_customer_exposure AS
SELECT r.SnapshotDateKey, r.CompanyKey, co.Company AS company, r.CustomerKey, cu.customer, cu.SalespersonKey AS customer_salesperson_key,
       r.open_amount, r.overdue_amount, r.not_due_amount, r.overdue_90_plus, r.line_count,
       cc.credit_limit,
       CASE WHEN cc.credit_limit > 0 THEN r.open_amount / cc.credit_limit END AS credit_used_ratio,
       COALESCE(s.sales_last_90d, 0) AS sales_last_90d,
       CASE WHEN s.sales_last_90d > 0 THEN r.open_amount / s.sales_last_90d * 90 END AS dso_days
FROM (
    SELECT f.SnapshotDateKey, f.CompanyKey, f.CustomerKey,
           SUM(f.residual_company_ccy) AS open_amount,
           SUM(CASE WHEN f.days_past_due > 0 THEN f.residual_company_ccy ELSE 0 END) AS overdue_amount,
           SUM(CASE WHEN f.days_past_due <= 0 THEN f.residual_company_ccy ELSE 0 END) AS not_due_amount,
           SUM(CASE WHEN f.days_past_due > 90 THEN f.residual_company_ccy ELSE 0 END) AS overdue_90_plus,
           COUNT(*) AS line_count
    FROM fact_finance_receivable_snapshot f
    WHERE f.SnapshotDateKey = (SELECT MAX(SnapshotDateKey) FROM fact_finance_receivable_snapshot)
      AND f.is_intercompany = 0
    GROUP BY f.SnapshotDateKey, f.CompanyKey, f.CustomerKey
) r
JOIN dim_company co ON co.CompanyKey = r.CompanyKey
JOIN dim_customer cu ON cu.CustomerKey = r.CustomerKey
LEFT JOIN dim_customer_company cc ON cc.CustomerKey = r.CustomerKey AND cc.CompanyKey = r.CompanyKey
LEFT JOIN (
    SELECT l.CustomerKey, l.CompanyKey, SUM(l.Value) AS sales_last_90d
    FROM fact_sales_lines l
    WHERE l.order_date_date > DATE_SUB(STR_TO_DATE((SELECT MAX(SnapshotDateKey) FROM fact_finance_receivable_snapshot), '%Y%m%d'), INTERVAL 90 DAY)
      AND l.order_date_date <= STR_TO_DATE((SELECT MAX(SnapshotDateKey) FROM fact_finance_receivable_snapshot), '%Y%m%d')
    GROUP BY l.CustomerKey, l.CompanyKey
) s ON s.CustomerKey = r.CustomerKey AND s.CompanyKey = r.CompanyKey;
