-- 0034: Finance -- receivable scope (Debt page decisions A1/A2 of 2026-10-04) + the Debt Report page grants.
--
-- 1. fact_finance_receivable_snapshot.receivable_scope: customer_debt | other_receivable, decided from Odoo's technical
--    values by departments/finance/scope.py (the ONE place the rules live; the job writes the column on every run).
--    Inter-company stays the separate is_intercompany flag (own companies' partners + FINANCE_INTERCOMPANY_PARTNER_IDS).
-- 2. dim_finance_receivable_scope: the scopes with our own labels (en + ar) and is_default (what the Debt page and the
--    default views show). Loaded from scope.py by the job; seeded here so the views work before the first run.
-- 3. Views. v_finance_receivable_line = every snapshot, every scope, inter-company included, with Odoo's labels: what
--    the Debt page API reads (it filters scope / inter-company / snapshot itself). The three existing views keep their
--    names and now show the DEFAULT scope only (customer debt, inter-company excluded):
--    v_finance_receivable_latest, v_finance_customer_exposure, v_finance_receivable_trend.
--    With every scope and inter-company included, totals equal Odoo's Aged Receivable.
-- 4. Debt Report page (page_key debt_report, View + Export) granted to the full-access roles: ADMIN, GCEO, GCFO, GCCO,
--    GCTO, TIKA_CEO, B2B_DIRECTOR, B2C_DIRECTOR. Not SALESPERSON (an admin can enable it on the Roles screen; the API
--    then scopes a salesperson to their own SalespersonKey). Each role keeps its role_data_scope rules.
--
-- Requires 0033_finance_receivables. Idempotent. Reverse: data/warehouse/down/0034_finance_receivable_scope_down.sql.

SET NAMES utf8mb4;

-- 1. scope dimension ----------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dim_finance_receivable_scope (
    receivable_scope VARCHAR(32) NOT NULL PRIMARY KEY COMMENT 'customer_debt | other_receivable (departments/finance/scope.py)',
    label_en VARCHAR(64) NOT NULL COMMENT 'our own label (not an Odoo field)',
    label_ar VARCHAR(64) NOT NULL,
    description VARCHAR(255) NULL,
    is_default TINYINT(1) NOT NULL COMMENT '1 = shown by the Debt page and the default v_finance_* views',
    sort_order TINYINT NOT NULL,
    updated_at_utc DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @now = UTC_TIMESTAMP();
INSERT IGNORE INTO dim_finance_receivable_scope (receivable_scope, label_en, label_ar, description, is_default, sort_order, updated_at_utc) VALUES
  ('customer_debt', 'Customer debt', 'ديون العملاء', 'Customer invoices, credit notes, receipts and inbound customer payments', 1, 1, @now),
  ('other_receivable', 'Other receivable entries', 'قيود مدينة أخرى', 'Outbound customer payments, journal entries without an invoice, vendor payments', 0, 2, @now);

-- 2. fact column + index -----------------------------------------------------------------------------------------------
SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE fact_finance_receivable_snapshot ADD COLUMN receivable_scope VARCHAR(32) NOT NULL DEFAULT ''other_receivable'' COMMENT ''customer_debt | other_receivable (departments/finance/scope.py)'' AFTER is_intercompany', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_finance_receivable_snapshot' AND COLUMN_NAME = 'receivable_scope');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE fact_finance_receivable_snapshot ADD INDEX ix_ffrs_scope (SnapshotDateKey, receivable_scope, is_intercompany, CompanyKey)', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_finance_receivable_snapshot' AND INDEX_NAME = 'ix_ffrs_scope');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Backfill the snapshots loaded before this migration with the scope.py rules (a payment line by its payment, any other
-- line by its move_type). From now on the job writes the column itself.
UPDATE fact_finance_receivable_snapshot f
JOIN dim_finance_invoice i ON i.move_id = f.move_id
JOIN dim_finance_payment p ON p.PaymentKey = f.PaymentKey
SET f.receivable_scope = CASE
      WHEN f.PaymentKey <> -1 THEN IF(p.payment_type = 'inbound' AND p.partner_type = 'customer', 'customer_debt', 'other_receivable')
      WHEN i.move_type IN ('out_invoice', 'out_refund', 'out_receipt') THEN 'customer_debt'
      ELSE 'other_receivable' END;

-- 3. views -------------------------------------------------------------------------------------------------------------
-- every snapshot, every scope, inter-company included; Odoo labels en + ar; segment from the line's sales team and
-- channel from its salesperson (the same rule the sales lines use), for role data-scope rules
CREATE OR REPLACE VIEW v_finance_receivable_line AS
SELECT f.SnapshotDateKey, f.line_id, f.move_id, i.document,
       f.receivable_scope, rs.label_en AS receivable_scope_label_en, rs.label_ar AS receivable_scope_label_ar, rs.is_default AS receivable_scope_is_default,
       f.is_intercompany,
       CASE WHEN f.PaymentKey <> -1 THEN CONCAT('payment:', COALESCE(p.payment_type, '?'), ':', COALESCE(p.partner_type, '?'))
            ELSE CONCAT('move:', COALESCE(i.move_type, '?')) END AS document_type_key,
       CASE WHEN f.PaymentKey <> -1 THEN CONCAT_WS(' / ', pty.label_en, prt.label_en) ELSE mt.label_en END AS document_type_label_en,
       CASE WHEN f.PaymentKey <> -1 THEN CONCAT_WS(' / ', pty.label_ar, prt.label_ar) ELSE mt.label_ar END AS document_type_label_ar,
       i.move_type, mt.label_en AS move_type_label_en, mt.label_ar AS move_type_label_ar,
       f.PaymentKey, p.payment_reference, p.payment_type, pty.label_en AS payment_type_label_en, pty.label_ar AS payment_type_label_ar,
       p.partner_type, prt.label_en AS partner_type_label_en, prt.label_ar AS partner_type_label_ar,
       p.journal_name_en AS payment_journal_en, p.journal_name_ar AS payment_journal_ar, p.memo AS payment_memo,
       CASE WHEN f.PaymentKey <> -1 THEN CONCAT_WS(' / ', pty.label_en, prt.label_en, p.journal_name_en) ELSE mt.label_en END AS document_label_en,
       CASE WHEN f.PaymentKey <> -1 THEN CONCAT_WS(' / ', pty.label_ar, prt.label_ar, p.journal_name_ar) ELSE mt.label_ar END AS document_label_ar,
       i.payment_state, ps.label_en AS payment_state_label_en, ps.label_ar AS payment_state_label_ar,
       f.CustomerKey, cu.customer, f.CompanyKey, co.Company AS company, f.SalespersonKey, sp.salesperson, sp.ChannelKey,
       f.SalesTeamKey, st.SalesTeam AS sales_team, st.SegmentKey, f.PaymentTermKey, pt.payment_term,
       f.CurrencyKey, cur.currency AS doc_currency, co.currency AS company_currency,
       f.InvoiceDateKey, i.invoice_date, f.DueDateKey, f.due_date, i.invoice_final_due_date,
       f.days_past_due, f.AgingBucketKey, b.aging_bucket, b.is_overdue,
       f.residual_company_ccy, f.residual_doc_ccy, i.amount_total AS invoice_total,
       f.delivery_status, ds.label_en AS delivery_status_label_en, ds.label_ar AS delivery_status_label_ar, i.has_sales_order,
       cc.credit_limit AS customer_credit_limit, f.salesperson_source, f.loaded_at_utc
FROM fact_finance_receivable_snapshot f
JOIN dim_finance_receivable_scope rs ON rs.receivable_scope = f.receivable_scope
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
LEFT JOIN dim_odoo_selection_label ds ON ds.model = 'sale.order' AND ds.field = 'delivery_status' AND ds.value = f.delivery_status;

-- latest snapshot, DEFAULT scope (customer debt), inter-company excluded: the Debt page's default
CREATE OR REPLACE VIEW v_finance_receivable_latest AS
SELECT l.*
FROM v_finance_receivable_line l
WHERE l.SnapshotDateKey = (SELECT MAX(SnapshotDateKey) FROM fact_finance_receivable_snapshot)
  AND l.receivable_scope_is_default = 1
  AND l.is_intercompany = 0;

CREATE OR REPLACE VIEW v_finance_receivable_trend AS
SELECT f.SnapshotDateKey, f.CompanyKey, f.AgingBucketKey, b.aging_bucket, b.is_overdue,
       SUM(f.residual_company_ccy) AS open_amount,
       SUM(CASE WHEN b.is_overdue = 1 THEN f.residual_company_ccy ELSE 0 END) AS overdue_amount,
       COUNT(*) AS line_count
FROM fact_finance_receivable_snapshot f
JOIN dim_finance_aging_bucket b ON b.AgingBucketKey = f.AgingBucketKey
JOIN dim_finance_receivable_scope rs ON rs.receivable_scope = f.receivable_scope
WHERE f.is_intercompany = 0 AND rs.is_default = 1
GROUP BY f.SnapshotDateKey, f.CompanyKey, f.AgingBucketKey, b.aging_bucket, b.is_overdue;

-- one row per company + customer on the latest snapshot, default scope, inter-company excluded; sales_last_90d / DSO
-- from the sales lines of the same CustomerKey + CompanyKey in the 90 days up to the snapshot date
-- (DSO = open / sales_last_90d * 90)
CREATE OR REPLACE VIEW v_finance_customer_exposure AS
SELECT r.SnapshotDateKey, r.CompanyKey, co.Company AS company, r.CustomerKey, cu.customer, cu.SalespersonKey AS customer_salesperson_key,
       r.open_amount, r.overdue_amount, r.not_due_amount, r.overdue_90_plus, r.line_count, r.oldest_overdue_days,
       cc.credit_limit,
       CASE WHEN cc.credit_limit > 0 THEN r.open_amount / cc.credit_limit END AS credit_used_ratio,
       CASE WHEN cc.credit_limit > 0 THEN (r.open_amount > cc.credit_limit) END AS over_credit_limit,
       COALESCE(s.sales_last_90d, 0) AS sales_last_90d,
       CASE WHEN s.sales_last_90d > 0 THEN r.open_amount / s.sales_last_90d * 90 END AS dso_days
FROM (
    SELECT f.SnapshotDateKey, f.CompanyKey, f.CustomerKey,
           SUM(f.residual_company_ccy) AS open_amount,
           SUM(CASE WHEN f.days_past_due > 0 THEN f.residual_company_ccy ELSE 0 END) AS overdue_amount,
           SUM(CASE WHEN f.days_past_due <= 0 THEN f.residual_company_ccy ELSE 0 END) AS not_due_amount,
           SUM(CASE WHEN f.days_past_due > 90 THEN f.residual_company_ccy ELSE 0 END) AS overdue_90_plus,
           MAX(CASE WHEN f.days_past_due > 0 THEN f.days_past_due END) AS oldest_overdue_days,
           COUNT(*) AS line_count
    FROM fact_finance_receivable_snapshot f
    JOIN dim_finance_receivable_scope rs ON rs.receivable_scope = f.receivable_scope
    WHERE f.SnapshotDateKey = (SELECT MAX(SnapshotDateKey) FROM fact_finance_receivable_snapshot)
      AND f.is_intercompany = 0 AND rs.is_default = 1
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

-- 4. Debt Report page grants -------------------------------------------------------------------------------------------
-- pages / permissions rows are also kept by the backend's registry sync at startup (permissionRegistry.ts); inserting
-- them here lets the grants exist before the new backend first starts.
INSERT INTO pages (page_key, page_label, nav_group, sort_order) VALUES ('debt_report', 'Debt Report', 'Sales', 19)
  ON DUPLICATE KEY UPDATE page_label = VALUES(page_label);
INSERT IGNORE INTO permissions (page_id, action) SELECT page_id, 'view' FROM pages WHERE page_key = 'debt_report';
INSERT IGNORE INTO permissions (page_id, action) SELECT page_id, 'export' FROM pages WHERE page_key = 'debt_report';
INSERT IGNORE INTO role_permissions (role_id, permission_id, allowed)
SELECT r.role_id, p.permission_id, 1
FROM roles r
JOIN pages pg ON pg.page_key = 'debt_report'
JOIN permissions p ON p.page_id = pg.page_id AND p.action IN ('view', 'export')
WHERE r.role_name IN ('ADMIN', 'GCEO', 'GCFO', 'GCCO', 'GCTO', 'TIKA_CEO', 'B2B_DIRECTOR', 'B2C_DIRECTOR');
