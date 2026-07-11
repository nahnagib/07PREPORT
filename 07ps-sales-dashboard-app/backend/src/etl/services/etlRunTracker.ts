import { pool } from '../../db/pool';

export type EtlMode = 'incremental' | 'full' | 'sql' | 'excel';
export type EtlLoadMode = 'full' | 'incremental';
export type EtlOutputMode = 'sql' | 'excel' | 'both';
export type EtlTriggerSource = 'scheduled' | 'manual' | 'api' | 'development';
export type EtlRunStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled';

export interface EtlJobRunRow {
  id: number;
  job_id: string | null;
  job_type: string;
  mode: EtlMode;
  load_mode: EtlLoadMode;
  output_mode: EtlOutputMode;
  trigger_source: EtlTriggerSource;
  triggered_by_user_id: number | null;
  triggered_by_user_name: string | null;
  status: EtlRunStatus;
  queued_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  duration_seconds: number | null;
  exit_code: number | null;
  error_message: string | null;
  odoo_extract_count: number | null;
  db_loaded_count: number | null;
  qa_issues_count: number | null;
  pipeline_run_log_id: number | null;
}

/**
 * Single writer for `etl_job_runs`, the Node-side complement to the vendored pipeline's own
 * pipeline_run_log/pipeline_run_audit (see 0011_etl_control_center.sql's header). The row for a
 * run is created here at *enqueue* time (not when the worker picks it up) so the concurrency
 * guard (`hasActiveEtlRun`) is correct even for a job that's still waiting because the worker
 * isn't running yet -- there's no gap where a second run could slip through.
 */
export interface CreateQueuedRunInput {
  jobType?: string;
  mode: EtlMode;
  loadMode: EtlLoadMode;
  outputMode: EtlOutputMode;
  triggerSource: EtlTriggerSource;
  triggeredByUserId?: number | null;
  triggeredByUserName?: string | null;
}

export async function createQueuedRun(input: CreateQueuedRunInput): Promise<number> {
  const [result] = await pool.query(
    `INSERT INTO etl_job_runs
       (job_type, mode, load_mode, output_mode, trigger_source, triggered_by_user_id, triggered_by_user_name, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')`,
    [
      input.jobType ?? 'odoo_sync',
      input.mode,
      input.loadMode,
      input.outputMode,
      input.triggerSource,
      input.triggeredByUserId ?? null,
      input.triggeredByUserName ?? null,
    ],
  );
  return (result as { insertId: number }).insertId;
}

/** Called once the BullMQ job id is known (immediately after `queue.add`) -- we ask BullMQ to
 * use the tracking row's own id as the job id (see etlQueue.ts), so this just confirms it. */
export async function setRunJobId(runId: number, jobId: string): Promise<void> {
  await pool.query('UPDATE etl_job_runs SET job_id = ? WHERE id = ?', [jobId, runId]);
}

export async function markRunStarted(runId: number): Promise<void> {
  await pool.query(
    `UPDATE etl_job_runs SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [runId],
  );
}

export interface FinishRunInput {
  status: 'success' | 'failed' | 'cancelled';
  exitCode: number | null;
  errorMessage?: string | null;
  odooExtractCount?: number | null;
  dbLoadedCount?: number | null;
  qaIssuesCount?: number | null;
  pipelineRunLogId?: number | null;
}

export async function finishRun(runId: number, input: FinishRunInput): Promise<void> {
  await pool.query(
    `UPDATE etl_job_runs
     SET status = ?, finished_at = CURRENT_TIMESTAMP,
         duration_seconds = TIMESTAMPDIFF(SECOND, COALESCE(started_at, queued_at), CURRENT_TIMESTAMP),
         exit_code = ?, error_message = ?, odoo_extract_count = ?, db_loaded_count = ?,
         qa_issues_count = ?, pipeline_run_log_id = ?
     WHERE id = ?`,
    [
      input.status,
      input.exitCode,
      input.errorMessage ?? null,
      input.odooExtractCount ?? null,
      input.dbLoadedCount ?? null,
      input.qaIssuesCount ?? null,
      input.pipelineRunLogId ?? null,
      runId,
    ],
  );
}

export async function hasActiveEtlRun(): Promise<boolean> {
  const [rows] = await pool.query(
    `SELECT 1 FROM etl_job_runs WHERE status IN ('queued', 'running') LIMIT 1`,
  );
  return (rows as unknown[]).length > 0;
}

/** The current queued/running row, if any -- what the status endpoint shows while a run is
 * in flight. */
export async function getActiveRun(): Promise<EtlJobRunRow | null> {
  const [rows] = await pool.query(
    `SELECT * FROM etl_job_runs WHERE status IN ('queued', 'running') ORDER BY id DESC LIMIT 1`,
  );
  return (rows as EtlJobRunRow[])[0] ?? null;
}

/** The most recently *finished* run -- what the status endpoint shows when nothing is running
 * (Success/Failed/Cancelled), or null for the true "Idle, never run" state. */
export async function getLastFinishedRun(): Promise<EtlJobRunRow | null> {
  const [rows] = await pool.query(
    `SELECT * FROM etl_job_runs WHERE status IN ('success', 'failed', 'cancelled')
     ORDER BY finished_at DESC LIMIT 1`,
  );
  return (rows as EtlJobRunRow[])[0] ?? null;
}

export async function getRunById(runId: number): Promise<EtlJobRunRow | null> {
  const [rows] = await pool.query('SELECT * FROM etl_job_runs WHERE id = ?', [runId]);
  return (rows as EtlJobRunRow[])[0] ?? null;
}

export interface RunHistoryFilters {
  status?: EtlRunStatus;
  mode?: EtlMode;
  fromDate?: string;
  toDate?: string;
  page: number;
  pageSize: number;
}

export async function listRunHistory(
  filters: RunHistoryFilters,
): Promise<{ rows: EtlJobRunRow[]; total: number }> {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filters.status) {
    clauses.push('status = ?');
    params.push(filters.status);
  }
  if (filters.mode) {
    clauses.push('mode = ?');
    params.push(filters.mode);
  }
  if (filters.fromDate) {
    clauses.push('queued_at >= ?');
    params.push(filters.fromDate);
  }
  if (filters.toDate) {
    clauses.push('queued_at <= ?');
    params.push(filters.toDate);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const [countRows] = await pool.query(`SELECT COUNT(*) AS total FROM etl_job_runs ${where}`, params);
  const total = (countRows as { total: number }[])[0]?.total ?? 0;

  const offset = Math.max(0, (filters.page - 1) * filters.pageSize);
  const [rows] = await pool.query(
    `SELECT * FROM etl_job_runs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, filters.pageSize, offset],
  );

  return { rows: rows as EtlJobRunRow[], total };
}

/** The current max `pipeline_run_log.run_id`, captured right before a subprocess starts -- the
 * baseline `correlateLatestPipelineRunLog` uses to tell "this run wrote a new row" apart from
 * "this run never got far enough to write one" (cancelled, or failed before the SQL phase). */
export async function getMaxPipelineRunLogId(): Promise<number> {
  const [rows] = await pool.query(`SELECT COALESCE(MAX(run_id), 0) AS maxId FROM pipeline_run_log`);
  return (rows as { maxId: number }[])[0]?.maxId ?? 0;
}

/**
 * Correlates a just-finished sql/both run with the pipeline's own pipeline_run_log, for the real
 * extract/load/QA counts. `baselineRunLogId` (from `getMaxPipelineRunLogId`, captured before the
 * subprocess started) guards against mis-attributing a stale row from a *previous* run: BullMQ
 * concurrency is 1, so a genuinely new row is always the latest one, but a run that never reached
 * the point of writing its own row (cancelled mid-extraction, or failed before the SQL phase)
 * must not be credited with whatever the latest pre-existing row happens to contain.
 */
export async function correlateLatestPipelineRunLog(baselineRunLogId: number): Promise<{
  pipelineRunLogId: number;
  odooExtractCount: number | null;
  dbLoadedCount: number | null;
  qaIssuesCount: number | null;
} | null> {
  const [rows] = await pool.query(
    `SELECT run_id, odoo_extract_count, db_loaded_count, qa_issues_count
     FROM pipeline_run_log ORDER BY run_id DESC LIMIT 1`,
  );
  const row = (rows as {
    run_id: number;
    odoo_extract_count: number | null;
    db_loaded_count: number | null;
    qa_issues_count: number | null;
  }[])[0];
  if (!row || row.run_id <= baselineRunLogId) return null;
  return {
    pipelineRunLogId: row.run_id,
    odooExtractCount: row.odoo_extract_count,
    dbLoadedCount: row.db_loaded_count,
    qaIssuesCount: row.qa_issues_count,
  };
}
