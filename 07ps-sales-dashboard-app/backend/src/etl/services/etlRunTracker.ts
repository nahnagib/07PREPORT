import { DateTime } from 'luxon';
import { pool } from '../../db/pool';
import { tripoliSqlDateTimeToDate } from '../../lib/timezone';
import { etlLogger } from './etlLogger';

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

/**
 * Admin-triggered override for a stuck "already running" lock (Force Reset ETL Lock) -- until
 * this existed, an orphaned queued/running row (see etlReconciliation.ts's header for how those
 * happen) required a manual DB fix every time. Marks every currently queued/running row 'failed'
 * with who did it and when recorded directly in error_message, so Run History carries a permanent,
 * honest audit trail of the override -- not just a transient log line.
 */
export async function forceResetActiveEtlRuns(
  triggeredByUserId: number,
  triggeredByUserName: string,
): Promise<{ id: number; jobId: string | null }[]> {
  const [rows] = await pool.query(
    `SELECT id, job_id FROM etl_job_runs WHERE status IN ('queued', 'running')`,
  );
  const activeRows = rows as { id: number; job_id: string | null }[];
  // Libya time, not raw UTC -- this is embedded as human-readable audit text (unlike the
  // queued_at/started_at/finished_at columns, which the frontend formats for display itself), so
  // it needs to already read correctly here, consistent with lib/timezone.ts's rule.
  const resetAt = DateTime.now().setZone('Africa/Tripoli').toFormat('yyyy-MM-dd HH:mm:ss');
  for (const row of activeRows) {
    await finishRun(row.id, {
      status: 'failed',
      exitCode: null,
      errorMessage: `Force-reset by ${triggeredByUserName} (user #${triggeredByUserId}) at ${resetAt}.`,
    });
  }
  return activeRows.map((r) => ({ id: r.id, jobId: r.job_id }));
}

/** Must match DatabaseExporter.PIPELINE_LOCK_NAME in
 * data/etl/src/sales_pipeline/export/database_exporter.py -- that's the GET_LOCK() name the
 * pipeline holds for the duration of a SQL table load. */
const PIPELINE_SQL_LOCK_NAME = 'sales_pipeline_full_load';

/**
 * Force-releases the pipeline's MySQL named lock (GET_LOCK/RELEASE_LOCK, see
 * DatabaseExporter._exclusive_run_lock) by killing whichever connection is holding it, if any.
 * Called from POST /admin/etl/force-reset alongside the etl_job_runs/BullMQ/Flask-tracker resets.
 *
 * RELEASE_LOCK() only works from the *same session* that acquired the lock (MySQL's own rule,
 * there is no "steal this named lock" statement) -- an orphaned session left by a crashed pipeline
 * process can't be told to release it from here. Killing the holding connection is the only way to
 * force it loose from outside that session, and also happens to be exactly right here: on a
 * genuinely orphaned lock, the connection is already dead in every way that matters, so there is no
 * live work to interrupt. `performance_schema.metadata_locks` is where MySQL 8 (see
 * docs/etl-deployment.md) exposes GET_LOCK()-acquired locks (OBJECT_TYPE = 'USER LEVEL LOCK'),
 * joined to `performance_schema.threads` for the PROCESSLIST id that KILL needs.
 *
 * Deliberately unconditional (no age/idle check) -- unlike the periodic background reconciliation
 * sweep, this only runs when an admin has explicitly clicked "Force Reset ETL Lock" after already
 * confirming a destructive-override dialog, so there is no ambiguity to be conservative about here.
 * (The automatic, unattended case is instead handled by DatabaseExporter capping its own session's
 * wait_timeout, so an orphaned lock is self-releasing within a bounded time without anything
 * outside that session needing to kill it.)
 */
export async function releaseOrphanedPipelineLock(): Promise<{ released: boolean; processId: number | null }> {
  try {
    const [rows] = await pool.query(
      `SELECT t.PROCESSLIST_ID AS processId
       FROM performance_schema.metadata_locks mdl
       JOIN performance_schema.threads t ON t.THREAD_ID = mdl.OWNER_THREAD_ID
       WHERE mdl.OBJECT_TYPE = 'USER LEVEL LOCK' AND mdl.OBJECT_NAME = ?`,
      [PIPELINE_SQL_LOCK_NAME],
    );
    const holders = rows as { processId: number | null }[];
    const holder = holders[0];
    if (!holder || holder.processId === null) {
      etlLogger.info('Force-reset: no MySQL session currently holds the pipeline SQL load lock');
      return { released: false, processId: null };
    }
    const processId = Number(holder.processId);
    // KILL does not accept a bound parameter for the connection id; processId is validated as a
    // number straight from PROCESSLIST_ID above, not user input, so this cannot be injected.
    await pool.query(`KILL ${processId}`);
    etlLogger.warn('Force-reset: killed MySQL connection holding the pipeline SQL load lock', { processId });
    return { released: true, processId };
  } catch (err) {
    etlLogger.error('Force-reset: could not release the MySQL pipeline SQL load lock', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { released: false, processId: null };
  }
}

/** queued_at/started_at/finished_at are naive DATETIME columns written via MySQL's own
 * CURRENT_TIMESTAMP, so they carry the DB server's local wall-clock time (Libya, same as every
 * other timestamp in this warehouse -- see lib/timezone.ts's header). `SELECT *` still returns
 * these 3 columns too (via mysql2's own 'local'-zone Date conversion, which depends on whatever
 * OS timezone the Node process happens to run under), but the `_raw` string aliases queried
 * alongside them are what this function actually uses to correct them, discarding the ambiguous
 * `SELECT *` versions of just those 3 fields. */
const RAW_TIMESTAMP_COLUMNS = `,
  DATE_FORMAT(queued_at, '%Y-%m-%d %H:%i:%s') AS queued_at_raw,
  DATE_FORMAT(started_at, '%Y-%m-%d %H:%i:%s') AS started_at_raw,
  DATE_FORMAT(finished_at, '%Y-%m-%d %H:%i:%s') AS finished_at_raw`;

interface RawTimestampFields {
  queued_at_raw: string | null;
  started_at_raw: string | null;
  finished_at_raw: string | null;
}

function normalizeEtlJobRunRow(row: EtlJobRunRow & RawTimestampFields): EtlJobRunRow {
  const { queued_at_raw, started_at_raw, finished_at_raw, ...rest } = row;
  return {
    ...rest,
    queued_at: tripoliSqlDateTimeToDate(queued_at_raw) as Date,
    started_at: tripoliSqlDateTimeToDate(started_at_raw),
    finished_at: tripoliSqlDateTimeToDate(finished_at_raw),
  };
}

/** The current queued/running row, if any -- what the status endpoint shows while a run is
 * in flight. */
export async function getActiveRun(): Promise<EtlJobRunRow | null> {
  const [rows] = await pool.query(
    `SELECT *${RAW_TIMESTAMP_COLUMNS} FROM etl_job_runs WHERE status IN ('queued', 'running') ORDER BY id DESC LIMIT 1`,
  );
  const row = (rows as (EtlJobRunRow & RawTimestampFields)[])[0];
  return row ? normalizeEtlJobRunRow(row) : null;
}

/** The most recently *finished* run -- what the status endpoint shows when nothing is running
 * (Success/Failed/Cancelled), or null for the true "Idle, never run" state. */
export async function getLastFinishedRun(): Promise<EtlJobRunRow | null> {
  const [rows] = await pool.query(
    `SELECT *${RAW_TIMESTAMP_COLUMNS} FROM etl_job_runs WHERE status IN ('success', 'failed', 'cancelled')
     ORDER BY finished_at DESC LIMIT 1`,
  );
  const row = (rows as (EtlJobRunRow & RawTimestampFields)[])[0];
  return row ? normalizeEtlJobRunRow(row) : null;
}

export async function getRunById(runId: number): Promise<EtlJobRunRow | null> {
  const [rows] = await pool.query(`SELECT *${RAW_TIMESTAMP_COLUMNS} FROM etl_job_runs WHERE id = ?`, [runId]);
  const row = (rows as (EtlJobRunRow & RawTimestampFields)[])[0];
  return row ? normalizeEtlJobRunRow(row) : null;
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
    `SELECT *${RAW_TIMESTAMP_COLUMNS} FROM etl_job_runs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, filters.pageSize, offset],
  );

  return { rows: (rows as (EtlJobRunRow & RawTimestampFields)[]).map(normalizeEtlJobRunRow), total };
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
