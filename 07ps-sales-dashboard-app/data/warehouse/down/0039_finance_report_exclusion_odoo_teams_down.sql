-- Reverses 0039_finance_report_exclusion_odoo_teams.sql: the 0036 exclusion list (segments Backoffice and Inter Company,
-- teams مبيعات BMH, مبيعات الادارة المالية, SALES), the 0036 rule types and the 0036 views, byte for byte. No snapshot row is
-- touched. The finance ETL's ODOO-TEAM-* sales team members stay in dim_sales_team (harmless; EXPORT invoices then show
-- under team EXPORT again, not excluded).

SET NAMES utf8mb4;

DELETE FROM cfg_finance_report_exclusion WHERE rule_type = 'invoice_team' OR (rule_type = 'sales_team' AND name = 'EXPORT');
SET @now = UTC_TIMESTAMP();
INSERT IGNORE INTO cfg_finance_report_exclusion (rule_type, name, note, updated_at_utc) VALUES
  ('segment', 'Backoffice', 'decision 2026-10-05', @now),
  ('segment', 'Inter Company', 'decision 2026-10-05', @now),
  ('sales_team', 'مبيعات BMH', 'decision 2026-10-05: BMH-ALL-00', @now),
  ('sales_team', 'مبيعات الادارة المالية', 'decision 2026-10-05: BMH-ALL-02 (asked as "مبيعات الادارة المالية - SALES")', @now),
  ('sales_team', 'SALES', 'decision 2026-10-05: MJ-ALL-03 and TK-ALL-03', @now);

ALTER TABLE cfg_finance_report_exclusion DROP CHECK ck_cfg_finance_report_exclusion_type;
ALTER TABLE cfg_finance_report_exclusion
  MODIFY COLUMN rule_type VARCHAR(16) NOT NULL COMMENT 'segment | sales_team',
  ADD CONSTRAINT ck_cfg_finance_report_exclusion_type CHECK (rule_type IN ('segment', 'sales_team'));

CREATE OR REPLACE VIEW v_finance_excluded_sales_team AS
SELECT st.SalesTeamKey, st.SalesTeam AS sales_team, sg.Segment AS segment,
       MAX(x.rule_type = 'segment') AS excluded_by_segment,
       MAX(x.rule_type = 'sales_team') AS excluded_by_team
FROM dim_sales_team st
LEFT JOIN dim_segment sg ON sg.SegmentKey = st.SegmentKey
JOIN cfg_finance_report_exclusion x
  ON (x.rule_type = 'segment' AND x.name = sg.Segment COLLATE utf8mb4_bin)
  OR (x.rule_type = 'sales_team' AND x.name = st.SalesTeam COLLATE utf8mb4_bin)
GROUP BY st.SalesTeamKey, st.SalesTeam, sg.Segment;

-- 3. views ------------------------------------------------------------------------------------------------------------
-- every snapshot, every scope, inter-company and excluded lines included (0034's columns, new ones at the end)
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
       cc.credit_limit AS customer_credit_limit, f.salesperson_source, f.loaded_at_utc,
       sg.Segment AS segment,
       COALESCE(xt.excluded_by_segment, 0) AS is_excluded_segment,
       COALESCE(xt.excluded_by_team, 0) AS is_excluded_team,
       (xt.SalesTeamKey IS NOT NULL) AS is_report_excluded,
       -- the document's original amount in its own currency, with the sign of its open balance (credit notes and
       -- inbound payments negative, as their residual)
       CASE WHEN f.residual_doc_ccy < 0 THEN -i.amount_total ELSE i.amount_total END AS invoice_total_signed
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
LEFT JOIN dim_segment sg ON sg.SegmentKey = st.SegmentKey
LEFT JOIN v_finance_excluded_sales_team xt ON xt.SalesTeamKey = f.SalesTeamKey
LEFT JOIN dim_customer_company cc ON cc.CustomerKey = f.CustomerKey AND cc.CompanyKey = f.CompanyKey
LEFT JOIN dim_odoo_selection_label mt ON mt.model = 'account.move' AND mt.field = 'move_type' AND mt.value = i.move_type
LEFT JOIN dim_odoo_selection_label ps ON ps.model = 'account.move' AND ps.field = 'payment_state' AND ps.value = i.payment_state
LEFT JOIN dim_odoo_selection_label pty ON pty.model = 'account.payment' AND pty.field = 'payment_type' AND pty.value = p.payment_type
LEFT JOIN dim_odoo_selection_label prt ON prt.model = 'account.payment' AND prt.field = 'partner_type' AND prt.value = p.partner_type
LEFT JOIN dim_odoo_selection_label ds ON ds.model = 'sale.order' AND ds.field = 'delivery_status' AND ds.value = f.delivery_status;

-- latest snapshot, DEFAULT scope, inter-company and excluded lines left out: the Debt page's default
CREATE OR REPLACE VIEW v_finance_receivable_latest AS
SELECT l.*
FROM v_finance_receivable_line l
WHERE l.SnapshotDateKey = (SELECT MAX(SnapshotDateKey) FROM fact_finance_receivable_snapshot)
  AND l.receivable_scope_is_default = 1
  AND l.is_intercompany = 0
  AND l.is_report_excluded = 0;

-- per snapshot, company, currency and bucket; amounts in the line's own currency (overdue = days_past_due > 0)
CREATE OR REPLACE VIEW v_finance_receivable_trend AS
SELECT f.SnapshotDateKey, f.CompanyKey, f.CurrencyKey, cur.currency, f.AgingBucketKey, b.aging_bucket, b.is_overdue,
       SUM(f.residual_doc_ccy) AS open_amount,
       SUM(CASE WHEN f.days_past_due > 0 THEN f.residual_doc_ccy ELSE 0 END) AS overdue_amount,
       SUM(CASE WHEN f.days_past_due <= 0 THEN f.residual_doc_ccy ELSE 0 END) AS not_due_amount,
       COUNT(*) AS line_count
FROM fact_finance_receivable_snapshot f
JOIN dim_finance_aging_bucket b ON b.AgingBucketKey = f.AgingBucketKey
JOIN dim_finance_receivable_scope rs ON rs.receivable_scope = f.receivable_scope
JOIN dim_currency cur ON cur.CurrencyKey = f.CurrencyKey
WHERE f.is_intercompany = 0 AND rs.is_default = 1
  AND f.SalesTeamKey NOT IN (SELECT x.SalesTeamKey FROM v_finance_excluded_sales_team x)
GROUP BY f.SnapshotDateKey, f.CompanyKey, f.CurrencyKey, cur.currency, f.AgingBucketKey, b.aging_bucket, b.is_overdue;

-- one row per company + customer + currency on the latest snapshot (default scope, no inter-company, no excluded line).
-- open_documents = distinct documents with an open line (invoices, credit notes, unreconciled payments);
-- invoice_amount = their original amounts (invoice_total_signed), each document once.
CREATE OR REPLACE VIEW v_finance_customer_exposure AS
SELECT r.SnapshotDateKey, r.CompanyKey, co.Company AS company, r.CustomerKey, cu.customer, r.CurrencyKey, cur.currency,
       r.open_documents, r.invoice_amount, r.open_amount, r.overdue_amount, r.not_due_amount, r.overdue_90_plus,
       r.oldest_overdue_days, r.line_count, r.salespersons, r.sales_teams, r.segments
FROM (
    SELECT l.SnapshotDateKey, l.CompanyKey, l.CustomerKey, l.CurrencyKey,
           COUNT(DISTINCT l.move_id) AS open_documents,
           SUM(CASE WHEN l.first_line_of_move = 1 THEN l.invoice_total_signed ELSE 0 END) AS invoice_amount,
           SUM(l.residual_doc_ccy) AS open_amount,
           SUM(CASE WHEN l.days_past_due > 0 THEN l.residual_doc_ccy ELSE 0 END) AS overdue_amount,
           SUM(CASE WHEN l.days_past_due <= 0 THEN l.residual_doc_ccy ELSE 0 END) AS not_due_amount,
           SUM(CASE WHEN l.days_past_due > 90 THEN l.residual_doc_ccy ELSE 0 END) AS overdue_90_plus,
           MAX(CASE WHEN l.days_past_due > 0 THEN l.days_past_due END) AS oldest_overdue_days,
           COUNT(*) AS line_count,
           GROUP_CONCAT(DISTINCT l.salesperson ORDER BY l.salesperson SEPARATOR ', ') AS salespersons,
           GROUP_CONCAT(DISTINCT l.sales_team ORDER BY l.sales_team SEPARATOR ', ') AS sales_teams,
           GROUP_CONCAT(DISTINCT l.segment ORDER BY l.segment SEPARATOR ', ') AS segments
    FROM (
        SELECT f.SnapshotDateKey, f.CompanyKey, f.CustomerKey, f.CurrencyKey, f.move_id, f.days_past_due, f.residual_doc_ccy,
               CASE WHEN f.residual_doc_ccy < 0 THEN -i.amount_total ELSE i.amount_total END AS invoice_total_signed,
               ROW_NUMBER() OVER (PARTITION BY f.move_id ORDER BY f.line_id) AS first_line_of_move,
               sp.salesperson, st.SalesTeam AS sales_team, sg.Segment AS segment
        FROM fact_finance_receivable_snapshot f
        JOIN dim_finance_receivable_scope rs ON rs.receivable_scope = f.receivable_scope
        JOIN dim_finance_invoice i ON i.move_id = f.move_id
        JOIN dim_salesperson sp ON sp.SalespersonKey = f.SalespersonKey
        JOIN dim_sales_team st ON st.SalesTeamKey = f.SalesTeamKey
        LEFT JOIN dim_segment sg ON sg.SegmentKey = st.SegmentKey
        WHERE f.SnapshotDateKey = (SELECT MAX(SnapshotDateKey) FROM fact_finance_receivable_snapshot)
          AND f.is_intercompany = 0 AND rs.is_default = 1
          AND f.SalesTeamKey NOT IN (SELECT x.SalesTeamKey FROM v_finance_excluded_sales_team x)
    ) l
    GROUP BY l.SnapshotDateKey, l.CompanyKey, l.CustomerKey, l.CurrencyKey
) r
JOIN dim_company co ON co.CompanyKey = r.CompanyKey
JOIN dim_customer cu ON cu.CustomerKey = r.CustomerKey
JOIN dim_currency cur ON cur.CurrencyKey = r.CurrencyKey;
