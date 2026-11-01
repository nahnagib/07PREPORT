-- Reverse of 0063_opportunity_status.sql. Deploy the previous ETL first (the 0063 ETL writes these columns).

SET NAMES utf8mb4;

SET @s = (SELECT IF(COUNT(*) = 1, 'ALTER TABLE fact_sales_opportunities DROP INDEX ix_fact_sales_opportunities_status, DROP COLUMN OpportunityStatus, DROP COLUMN WonStatus, DROP COLUMN ClosedDate', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_opportunities' AND COLUMN_NAME = 'OpportunityStatus');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(COUNT(*) = 1, 'ALTER TABLE shd_fact_sales_opportunities DROP INDEX ix_fact_sales_opportunities_status, DROP COLUMN OpportunityStatus, DROP COLUMN WonStatus, DROP COLUMN ClosedDate', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_opportunities' AND COLUMN_NAME = 'OpportunityStatus');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

CREATE OR REPLACE VIEW v_sales_opportunities AS SELECT * FROM fact_sales_opportunities;
