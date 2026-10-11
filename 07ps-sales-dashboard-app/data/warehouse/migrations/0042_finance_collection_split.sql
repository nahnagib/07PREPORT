-- 0042: Collections Trend -- where each collected amount went (decision of 2026-10-11), on top of 0040.
--
-- 1. fact_finance_collection gains the split of every allocation, in the PAYMENT currency (the rows of a payment still
--    add up to the payment: applied_overdue + applied_not_due + applied_other + unapplied = amount_doc_ccy):
--      applied_overdue_doc_ccy   matched (account.partial.reconcile) to customer invoice lines that were OVERDUE on the
--                                payment date (due date before the payment date; due on the day = not yet due)
--      applied_not_due_doc_ccy   matched to customer invoice lines not yet due on the payment date
--      applied_other_doc_ccy     matched to other receivable debits (opening balances, refunds paid out, exchange
--                                difference entries): collected, but not against an invoice
--      unapplied_doc_ccy         not matched yet (advance / open payment), as of the load
--    The allocation rule (departments/finance/collections.py): the invoice part is split by the invoices' salesperson
--    + branch (attribution 'invoice', in proportion to the amounts applied); the unapplied and "other" part is one row
--    for the customer's salesperson of record and that salesperson's branch (attribution 'customer', or 'none').
--    Credit notes, write-offs and exchange differences that settle invoices are never in this fact: it starts from cash
--    (posted inbound customer payments), never from reconciliations.
-- 2. fact_finance_collection_invoice: the payment -> invoice matches behind the split (one row per partial
--    reconciliation of a payment's receivable line), for the drill-down "applied to which invoices".
-- 3. v_finance_collection_trend: the allocation rows with every filter key (date, currency, company, customer,
--    salesperson, channel, team, segment) and the report's rules applied -- inter-company customers removed, the
--    report exclusions (cfg_finance_report_exclusion via v_finance_excluded_sales_team, the same condition as the Debt
--    Report) removed. Amounts per currency, never converted.
--
-- Requires 0040 (and 0039 for invoices_only). Idempotent. Reverse: data/warehouse/down/0042_finance_collection_split_down.sql.

SET NAMES utf8mb4;

-- 1. split columns (one prepared statement per column: idempotent, and readable by tests/sqlite_schema.py) ------------
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE fact_finance_collection ADD COLUMN applied_overdue_doc_ccy DECIMAL(20,6) NOT NULL DEFAULT 0 COMMENT ''matched to invoices overdue on the payment date (payment currency)'' AFTER amount_company_ccy', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_finance_collection' AND COLUMN_NAME = 'applied_overdue_doc_ccy');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE fact_finance_collection ADD COLUMN applied_not_due_doc_ccy DECIMAL(20,6) NOT NULL DEFAULT 0 COMMENT ''matched to invoices not yet due on the payment date'' AFTER applied_overdue_doc_ccy', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_finance_collection' AND COLUMN_NAME = 'applied_not_due_doc_ccy');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE fact_finance_collection ADD COLUMN applied_other_doc_ccy DECIMAL(20,6) NOT NULL DEFAULT 0 COMMENT ''matched to other receivable debits (not invoices)'' AFTER applied_not_due_doc_ccy', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_finance_collection' AND COLUMN_NAME = 'applied_other_doc_ccy');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE fact_finance_collection ADD COLUMN unapplied_doc_ccy DECIMAL(20,6) NOT NULL DEFAULT 0 COMMENT ''not matched yet, as of the load'' AFTER applied_other_doc_ccy', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_finance_collection' AND COLUMN_NAME = 'unapplied_doc_ccy');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE fact_finance_collection ADD INDEX ix_fact_finance_collection_ccy_date (CurrencyKey, PaymentDateKey)', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_finance_collection' AND INDEX_NAME = 'ix_fact_finance_collection_ccy_date');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 2. payment -> invoice matches --------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fact_finance_collection_invoice (
    partial_id BIGINT NOT NULL PRIMARY KEY COMMENT 'account.partial.reconcile id',
    payment_id BIGINT NOT NULL COMMENT 'account.payment id',
    allocation_no SMALLINT NOT NULL COMMENT 'fact_finance_collection row the amount is in',
    debit_line_id BIGINT NOT NULL COMMENT 'account.move.line matched (the invoice side)',
    move_id BIGINT NULL COMMENT 'account.move of the debit line',
    document VARCHAR(255) NULL,
    move_type VARCHAR(32) NULL,
    kind VARCHAR(16) NOT NULL COMMENT 'overdue | not_due | other',
    due_date DATE NULL COMMENT 'due date of the matched line (date_maturity, else invoice due date, else line date)',
    applied_doc_ccy DECIMAL(20,6) NOT NULL COMMENT 'payment currency (credit_amount_currency)',
    applied_invoice_ccy DECIMAL(20,6) NULL COMMENT 'invoice currency (debit_amount_currency)',
    reconciled_on DATE NULL COMMENT 'account.partial.reconcile max_date',
    loaded_at_utc DATETIME NOT NULL,
    _run_id CHAR(36) NOT NULL,
    INDEX ix_ffci_payment (payment_id, allocation_no),
    INDEX ix_ffci_move (move_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. the trend source ---------------------------------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_finance_collection_trend AS
SELECT c.payment_id, c.allocation_no, c.payment_name, c.PaymentDateKey, c.payment_date,
       c.CompanyKey, co.Company AS company, c.CustomerKey, cu.customer, c.CurrencyKey, cur.currency,
       c.SalespersonKey, sp.salesperson, sp.ChannelKey, c.SalesTeamKey, st.SalesTeam AS sales_team, st.SegmentKey,
       sg.Segment AS segment, c.attribution, c.share,
       c.amount_doc_ccy, c.amount_company_ccy, c.applied_overdue_doc_ccy, c.applied_not_due_doc_ccy,
       c.applied_other_doc_ccy, c.unapplied_doc_ccy
FROM fact_finance_collection c
JOIN dim_company co ON co.CompanyKey = c.CompanyKey
JOIN dim_customer cu ON cu.CustomerKey = c.CustomerKey
JOIN dim_currency cur ON cur.CurrencyKey = c.CurrencyKey
JOIN dim_salesperson sp ON sp.SalespersonKey = c.SalespersonKey
JOIN dim_sales_team st ON st.SalesTeamKey = c.SalesTeamKey
LEFT JOIN dim_segment sg ON sg.SegmentKey = st.SegmentKey
WHERE c.is_intercompany = 0
  AND NOT EXISTS (SELECT 1 FROM v_finance_excluded_sales_team x
                   WHERE x.SalesTeamKey = c.SalesTeamKey AND (x.invoices_only = 0 OR c.attribution = 'invoice'));
