-- Reverses 0034_finance_receivable_scope.sql: removes the Debt Report page grants, the scope column/index/dimension
-- and v_finance_receivable_line, and restores the three v_finance_* views exactly as 0033 created them
-- (inter-company excluded, every scope). Snapshot rows are kept; only their receivable_scope column goes.

SET NAMES utf8mb4;

-- 4. page grants (the backend's registry sync re-creates the pages/permissions rows if the new backend still runs)
DELETE rp FROM role_permissions rp
JOIN permissions p ON p.permission_id = rp.permission_id
JOIN pages pg ON pg.page_id = p.page_id
WHERE pg.page_key = 'debt_report';
DELETE uprm FROM user_permissions uprm
JOIN permissions p ON p.permission_id = uprm.permission_id
JOIN pages pg ON pg.page_id = p.page_id
WHERE pg.page_key = 'debt_report';
DELETE p FROM permissions p JOIN pages pg ON pg.page_id = p.page_id WHERE pg.page_key = 'debt_report';
DELETE FROM pages WHERE page_key = 'debt_report';

-- 3. views
DROP VIEW IF EXISTS v_finance_receivable_line;

CREATE OR REPLACE VIEW v_finance_receivable_latest AS
SELECT f.SnapshotDateKey, f.line_id, f.move_id, i.document,
       i.move_type, mt.label_en AS move_type_label_en, mt.label_ar AS move_type_label_ar,
       f.PaymentKey, p.payment_reference, p.payment_type, pty.label_en AS payment_type_label_en, pty.label_ar AS payment_type_label_ar,
       p.partner_type, prt.label_en AS partner_type_label_en, prt.label_ar AS partner_type_label_ar,
       p.journal_name_en AS payment_journal_en, p.journal_name_ar AS payment_journal_ar, p.memo AS payment_memo,
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

-- 2. column + index
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE fact_finance_receivable_snapshot DROP INDEX ix_ffrs_scope', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_finance_receivable_snapshot' AND INDEX_NAME = 'ix_ffrs_scope');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE fact_finance_receivable_snapshot DROP COLUMN receivable_scope', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_finance_receivable_snapshot' AND COLUMN_NAME = 'receivable_scope');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 1. dimension
DROP TABLE IF EXISTS dim_finance_receivable_scope;
