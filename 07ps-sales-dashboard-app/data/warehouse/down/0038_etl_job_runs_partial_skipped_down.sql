-- Reverses 0038_etl_job_runs_partial_skipped.sql: etl_job_runs.status back to the five 0011 values.
--
-- Rows already recorded as 'partial' become 'success' (the run did load; etl_run_log keeps the real 'partial' status and
-- the "finance failed: ..." message) and 'skipped' rows become 'failed' (they never ran), so the ENUM can shrink without
-- MySQL rejecting or blanking values. Roll the backend/worker back to the previous image first: the new worker writes
-- 'partial' / 'skipped'.

SET NAMES utf8mb4;

UPDATE etl_job_runs SET status = 'success' WHERE status = 'partial';
UPDATE etl_job_runs SET status = 'failed' WHERE status = 'skipped';

ALTER TABLE etl_job_runs
  MODIFY COLUMN status ENUM('queued', 'running', 'success', 'failed', 'cancelled') NOT NULL DEFAULT 'queued';
