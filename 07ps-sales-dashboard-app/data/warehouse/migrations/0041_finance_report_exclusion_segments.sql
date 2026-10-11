-- 0041: Receivables and Collections -- the report's exclusions = the segments Backoffice and Inter Company, nothing else
-- (decision of 2026-10-11, after the Odoo reconciliation data/etl/reconcile/odoo_vs_dashboard.py).
--
-- Replaces the 0039 list (teams مبيعات الادارة المالية, مبيعات BMH, EXPORT and invoices without an Odoo sales team):
--   segment Backoffice     covers BMH-ALL-02 مبيعات الادارة المالية (and BMH-ALL-04, MJ-ALL-03, TK-ALL-03: no receivable line)
--   segment Inter Company  covers BMH-ALL-00 مبيعات BMH
-- so those two teams stay out, while EXPORT (Odoo team 27) and invoices with no Odoo sales team (most Athena invoices
-- since 2026-07) come back into every number. Rule types and views are unchanged (0039).
--
-- Requires 0039. Idempotent. Reverse: data/warehouse/down/0041_finance_report_exclusion_segments_down.sql.

SET NAMES utf8mb4;
SET @now = UTC_TIMESTAMP();

DELETE FROM cfg_finance_report_exclusion WHERE rule_type IN ('sales_team', 'invoice_team');
INSERT INTO cfg_finance_report_exclusion (rule_type, name, note, updated_at_utc) VALUES
  ('segment', 'Backoffice', 'decision 2026-10-11: segment out of the report', @now),
  ('segment', 'Inter Company', 'decision 2026-10-11: segment out of the report', @now)
ON DUPLICATE KEY UPDATE note = VALUES(note), updated_at_utc = VALUES(updated_at_utc);
