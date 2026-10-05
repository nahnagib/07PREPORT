-- Reverses 0033_finance_receivables.sql: drops every finance object. Core and sales tables are untouched.
-- Snapshot history is lost; take a dump of fact_finance_receivable_snapshot first if it must be kept.

DROP VIEW IF EXISTS v_finance_customer_exposure;
DROP VIEW IF EXISTS v_finance_receivable_trend;
DROP VIEW IF EXISTS v_finance_receivable_latest;
DROP TABLE IF EXISTS fact_finance_receivable_snapshot;
DROP TABLE IF EXISTS bridge_finance_invoice_order;
DROP TABLE IF EXISTS dim_finance_payment;
DROP TABLE IF EXISTS dim_finance_invoice;
DROP TABLE IF EXISTS dim_finance_aging_bucket;
DROP TABLE IF EXISTS raw_odoo_sale_order_invoice;
DROP TABLE IF EXISTS raw_odoo_account_journal;
DROP TABLE IF EXISTS raw_odoo_account_payment;
DROP TABLE IF EXISTS raw_odoo_account_move;
DROP TABLE IF EXISTS raw_odoo_account_move_line;
