-- 0038: ETL Control Center -- two more run statuses for the one-pipeline ETL (2026-10-07).
--
-- Every trigger now runs one pipeline (ETL jobs `main` / `full_all`: core dims -> receivables snapshot -> sales):
--   partial  the run loaded, but an optional step failed (the receivables snapshot). The ETL exits with code 3 and
--            etl_run_log holds "finance failed: <error>" on the top-level row; the next scheduled run retries.
--   skipped  the trigger was refused because another ETL run held the ETL lock (exit code 4); nothing was written.
-- The worker (backend/src/etl/jobs/runPipelineJob.ts) writes these into etl_job_runs.status, an ENUM since 0011.
-- etl_run_log.status is a VARCHAR and needs no change ('partial' / 'skipped' rows are written there by the ETL).
--
-- Values are appended at the end of the ENUM, so MySQL changes only the table definition (no row is rewritten).
-- Idempotent (re-running sets the same definition). Requires 0011. Apply BEFORE deploying the new backend/worker:
-- without it, recording a partial run fails and the run stays 'running' until the stale-run sweep.
-- Reverse: data/warehouse/down/0038_etl_job_runs_partial_skipped_down.sql.

SET NAMES utf8mb4;

ALTER TABLE etl_job_runs
  MODIFY COLUMN status ENUM('queued', 'running', 'success', 'failed', 'cancelled', 'partial', 'skipped')
    NOT NULL DEFAULT 'queued';
