-- Reverses 0040_finance_collections.sql: drops the collections fact and the payment history, and forgets the finance
-- ETL's watermark for it (the next run after re-applying 0040 reads the full history again). Roll the backend and ETL
-- images back first: the new ones read and write these tables.

SET NAMES utf8mb4;

DROP TABLE IF EXISTS fact_finance_collection;
DROP TABLE IF EXISTS raw_odoo_customer_payment;
DELETE FROM etl_watermark WHERE dataset = 'raw_odoo_customer_payment';
DELETE FROM etl_dataset_registry WHERE dataset IN ('raw_odoo_customer_payment', 'fact_finance_collection');
