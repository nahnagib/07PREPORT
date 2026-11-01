-- 0063: opportunity STATUS (the outcome) next to the STAGE (the kanban column), Pipeline Health 2026-11-01.
--
-- fact_sales_opportunities (+ its shadow shd_fact_sales_opportunities) get:
--   OpportunityStatus  Pending / Won / Lost / Archived  (data/etl/src/sales_pipeline/crm/crm_status_classifier.py)
--   WonStatus          Odoo crm.lead.won_status as read (won / lost / pending)
--   ClosedDate         Odoo crm.lead.date_closed (local time)
-- Status = Odoo won_status when present; otherwise active AND stage.is_won -> Won, archived AND probability 0 -> Lost,
-- archived AND probability > 0 -> Archived (excluded from every figure), any other active record -> Pending. Stage names
-- are never used. IsWon / IsLost / IsOpen are derived from it by the ETL (Won / Lost / Pending).
--
-- Existing rows are backfilled from the stored flags so the pages keep working until the next ETL run rewrites every
-- row with the new classifier (the old flags read stage names; the next run corrects them).
-- v_sales_opportunities is SELECT * and MySQL expands * when a view is created, so it is recreated here.
--
-- Apply BEFORE deploying the ETL that writes these columns (its loader rejects columns the table does not have).
-- Idempotent (prepared statements, no DELIMITER, for apply_migrations.py). Reverse: down/0063_opportunity_status_down.sql.

SET NAMES utf8mb4;

SET @s = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE fact_sales_opportunities ADD COLUMN OpportunityStatus VARCHAR(16) NULL AFTER IsOpen, ADD COLUMN WonStatus VARCHAR(16) NULL AFTER OpportunityStatus, ADD COLUMN ClosedDate DATETIME NULL AFTER WonStatus, ADD INDEX ix_fact_sales_opportunities_status (OpportunityStatus)', 'DO 0')
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fact_sales_opportunities' AND COLUMN_NAME = 'OpportunityStatus');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = (SELECT IF(
    (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_opportunities') = 1
    AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shd_fact_sales_opportunities' AND COLUMN_NAME = 'OpportunityStatus') = 0,
  'ALTER TABLE shd_fact_sales_opportunities ADD COLUMN OpportunityStatus VARCHAR(16) NULL AFTER IsOpen, ADD COLUMN WonStatus VARCHAR(16) NULL AFTER OpportunityStatus, ADD COLUMN ClosedDate DATETIME NULL AFTER WonStatus, ADD INDEX ix_fact_sales_opportunities_status (OpportunityStatus)',
  'DO 0'));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

UPDATE fact_sales_opportunities
   SET OpportunityStatus = CASE WHEN IsWon = 1 AND COALESCE(IsLost, 0) = 0 THEN 'Won' WHEN IsLost = 1 THEN 'Lost' WHEN IsOpen = 1 THEN 'Pending' ELSE 'Archived' END
 WHERE OpportunityStatus IS NULL;

-- an earlier draft of this migration wrote 'New' for open records: Odoo's own word is 'pending'
UPDATE fact_sales_opportunities SET OpportunityStatus = 'Pending' WHERE OpportunityStatus = 'New';

CREATE OR REPLACE VIEW v_sales_opportunities AS SELECT * FROM fact_sales_opportunities;
