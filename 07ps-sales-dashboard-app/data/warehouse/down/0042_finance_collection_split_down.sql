-- Reverses 0042_finance_collection_split.sql: drops the trend view, the payment -> invoice table and the split columns.
-- fact_finance_collection keeps its 0040 columns and rows.

SET NAMES utf8mb4;

DROP VIEW IF EXISTS v_finance_collection_trend;
DROP TABLE IF EXISTS fact_finance_collection_invoice;

SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE fact_finance_collection DROP INDEX ix_fact_finance_collection_ccy_date', 'DO 0')
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_finance_collection' AND INDEX_NAME = 'ix_fact_finance_collection_ccy_date');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE fact_finance_collection DROP COLUMN applied_overdue_doc_ccy, DROP COLUMN applied_not_due_doc_ccy,
    DROP COLUMN applied_other_doc_ccy, DROP COLUMN unapplied_doc_ccy', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_finance_collection' AND COLUMN_NAME = 'applied_overdue_doc_ccy');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
