-- Reverses 0041_finance_report_exclusion_segments.sql: back to the 0039 list (teams مبيعات الادارة المالية, مبيعات BMH,
-- EXPORT; invoices without an Odoo sales team). No snapshot row is touched.

SET NAMES utf8mb4;
SET @now = UTC_TIMESTAMP();

DELETE FROM cfg_finance_report_exclusion WHERE rule_type = 'segment' AND name IN ('Backoffice', 'Inter Company');
INSERT IGNORE INTO cfg_finance_report_exclusion (rule_type, name, note, updated_at_utc) VALUES
  ('sales_team', 'مبيعات الادارة المالية', 'decision 2026-10-08: Odoo team 8 (BMH-ALL-02)', @now),
  ('sales_team', 'مبيعات BMH', 'decision 2026-10-08: Odoo team 23 (BMH-ALL-00)', @now),
  ('sales_team', 'EXPORT', 'decision 2026-10-08: Odoo team 27 (ODOO-TEAM-27, finance ETL)', @now),
  ('invoice_team', 'Unknown', 'decision 2026-10-08: invoices with no Odoo sales team (-1); credits / payments kept', @now);
