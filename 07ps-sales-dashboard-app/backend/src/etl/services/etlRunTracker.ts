import { DateTime } from 'luxon';
import { pool } from '../../db/pool';
import { getAppTimezone, utcSqlDateTimeToDate } from '../../lib/timezone';
import { etlLogger } from './etlLogger';

/** 'sql'/'excel' only appear on runs recorded before the 2026-10 ETL platform; new runs use incremental/full/finance. */
export type EtlMode = 'incremental' | 'full' | 'sql' | 'excel' | 'finance' | 'nps' | 'refresh';
export type EtlLoadMode = 'full' | 'incremental';
export type EtlOutputMode = 'sql' | 'excel' | 'both';
export type EtlTriggerSource = 'scheduled' | 'manual' | 'api' | 'development';
/** partial = the run loaded but an optional step (the receivables snapshot) failed; skipped = refused because
 * another ETL run held the lock (nothing written). Both need migration 0038. */
export type EtlRunStatus = 'queued' | 'running' | 'success' | 'partial' | 'failed' | 'cancelled' | 'skipped';
export const FINISHED_RUN_STATUSES: EtlRunStatus[] = ['success', 'partial', 'failed', 'cancelled', 'skipped'];

/** One ETL platform step of a run: an etl_run_log row whose parent_run_uid is the run's top-level row (core_dims,
 * finance_receivables, sales_incremental under main). Times are UTC wall-clock strings. */
export interface EtlRunStep {
  runId: number;
  job: string;
  department: string | null;
  status: string;
  startedAtUtc: string | null;
  finishedAtUtc: string | null;
  durationSeconds: number | null;
  rowsLoaded: number | null;
  errorMessage: string | null;
}

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
  /** History rows only: the platform steps of this run (see EtlRunStep). */
  steps?: EtlRunStep[];
}

/**
 * Single writer for `etl_job_runs`, the Node-side complement to the vendored pipeline's own
 * etl_run_log / etl_task_log (see 0028_etl_platform_meta.sql; pipeline_run_log before). The row for a
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

/**
 * A failed attempt that BullMQ is about to retry (see enqueuePipelineRun's attempts/backoff): the
 * run goes back to 'queued' -- NOT 'failed' -- so hasActiveEtlRun() keeps holding the lock through
 * the backoff wait. Marking it failed here (what happened before) freed the lock for the whole
 * backoff window, letting a manual or scheduled run start alongside the pending retry, i.e. two
 * pipeline runs against the same warehouse. The last error stays visible in error_message.
 */
export async function markRunRetrying(runId: number, errorMessage: string): Promise<void> {
  await pool.query(
    `UPDATE etl_job_runs SET status = 'queued', started_at = NULL, error_message = ? WHERE id = ?`,
    [`Attempt failed, retrying: ${errorMessage}`.slice(0, 60_000), runId],
  );
}

export interface FinishRunInput {
  status: 'success' | 'partial' | 'failed' | 'cancelled' | 'skipped';
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

/** job_type of every queued/running run (empty when idle): lets a scheduled full / sales tick queue behind a 30-minute
 * refresh instead of being dropped (etlQueue.ts enqueuePipelineRun `queueBehindRefresh`). */
export async function activeEtlRunJobTypes(): Promise<string[]> {
  const [rows] = await pool.query(`SELECT job_type FROM etl_job_runs WHERE status IN ('queued', 'running')`);
  return (rows as { job_type: string }[]).map((r) => r.job_type);
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
  const resetAt = DateTime.now().setZone(getAppTimezone()).toFormat('yyyy-MM-dd HH:mm:ss');
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

/** queued_at/started_at/finished_at are TIMESTAMP columns written via CURRENT_TIMESTAMP on the pool's
 * connections, whose session is pinned to UTC (db/pool.ts: `SET time_zone = '+00:00'`), so
 * DATE_FORMAT returns a UTC wall-clock string. (These used to be parsed as Libya time, which showed
 * every run 2 hours early.) `SELECT *` still returns these 3 columns too, but via mysql2's own Date
 * conversion, so the `_raw` string aliases queried alongside them are what this function uses,
 * discarding the `SELECT *` versions of just those 3 fields. */
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
    queued_at: utcSqlDateTimeToDate(queued_at_raw) as Date,
    started_at: utcSqlDateTimeToDate(started_at_raw),
    finished_at: utcSqlDateTimeToDate(finished_at_raw),
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
    `SELECT *${RAW_TIMESTAMP_COLUMNS} FROM etl_job_runs WHERE status IN (?)
     ORDER BY finished_at DESC LIMIT 1`,
    [FINISHED_RUN_STATUSES],
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

  const runs = (rows as (EtlJobRunRow & RawTimestampFields)[]).map(normalizeEtlJobRunRow);
  const steps = await fetchRunSteps(runs.map((r) => r.pipeline_run_log_id).filter((id): id is number => id !== null));
  return { rows: runs.map((r) => ({ ...r, steps: r.pipeline_run_log_id === null ? [] : steps.get(Number(r.pipeline_run_log_id)) ?? [] })), total };
}

const STEP_ERROR_CHARS = 2000;

/** The etl_run_log child rows (parent_run_uid = the top-level row's run_uid) of each given top-level run_id, in run
 * order. One level is enough: inside main/full_all every step's own core_dims dependency is the run's core_dims step. */
export async function fetchRunSteps(topLevelRunIds: number[]): Promise<Map<number, EtlRunStep[]>> {
  const out = new Map<number, EtlRunStep[]>();
  if (!topLevelRunIds.length) return out;
  try {
    const [rows] = await pool.query(
      `SELECT p.run_id AS parent_id, c.run_id, c.job_name, c.department, c.status,
              DATE_FORMAT(c.started_at_utc, '%Y-%m-%d %H:%i:%s') AS started_at_utc,
              DATE_FORMAT(c.finished_at_utc, '%Y-%m-%d %H:%i:%s') AS finished_at_utc,
              c.duration_seconds, c.rows_processed, LEFT(c.error_message, ?) AS error_message
         FROM etl_run_log p JOIN etl_run_log c ON c.parent_run_uid = p.run_uid
        WHERE p.run_id IN (?)
        ORDER BY c.run_id`,
      [STEP_ERROR_CHARS, topLevelRunIds],
    );
    for (const r of rows as any[]) {
      const list = out.get(Number(r.parent_id)) ?? [];
      list.push({
        runId: Number(r.run_id),
        job: r.job_name,
        department: r.department ?? null,
        status: r.status,
        startedAtUtc: r.started_at_utc ?? null,
        finishedAtUtc: r.finished_at_utc ?? null,
        durationSeconds: r.duration_seconds === null ? null : Number(r.duration_seconds),
        rowsLoaded: r.rows_processed === null ? null : Number(r.rows_processed),
        errorMessage: r.error_message ?? null,
      });
      out.set(Number(r.parent_id), list);
    }
  } catch (err) {
    // history must still load when etl_run_log is missing or unreadable; the steps are a detail
    etlLogger.error('Could not read the ETL steps of the run history', { error: err instanceof Error ? err.message : String(err) });
  }
  return out;
}

/** The current max `etl_run_log.run_id`, captured right before a run starts -- the baseline
 * `correlateLatestEtlRun` uses to tell "this run wrote its own row" apart from "this run never got far enough to
 * write one" (cancelled, or failed before the platform runner started). Replaces the legacy pipeline_run_log. */
export async function getMaxEtlRunId(): Promise<number> {
  const [rows] = await pool.query(`SELECT COALESCE(MAX(run_id), 0) AS maxId FROM etl_run_log`);
  return Number((rows as { maxId: number }[])[0]?.maxId ?? 0);
}

/**
 * Correlates a just-finished run with the ETL platform's own etl_run_log row, for the real extract/load/QA
 * counts. Only the invoked job's top-level row counts (parent_run_uid IS NULL; dependency jobs such as core_dims
 * have their own rows with parent_run_uid set). `baselineRunId` guards against crediting a run with a row written
 * by an earlier one (BullMQ concurrency is 1).
 */
export async function correlateLatestEtlRun(baselineRunId: number): Promise<{
  pipelineRunLogId: number;
  odooExtractCount: number | null;
  dbLoadedCount: number | null;
  qaIssuesCount: number | null;
  /** The platform's own summary ("finance failed: ..." on a partial run). */
  errorMessage: string | null;
} | null> {
  const [rows] = await pool.query(
    `SELECT run_id, odoo_extract_count, rows_processed, qa_issues_count, error_message
     FROM etl_run_log WHERE run_id > ? AND parent_run_uid IS NULL ORDER BY run_id DESC LIMIT 1`,
    [baselineRunId],
  );
  const row = (rows as {
    run_id: number;
    odoo_extract_count: number | null;
    rows_processed: number | null;
    qa_issues_count: number | null;
    error_message: string | null;
  }[])[0];
  if (!row) return null;
  return {
    pipelineRunLogId: Number(row.run_id), // stored in etl_job_runs.pipeline_run_log_id: now an etl_run_log.run_id
    odooExtractCount: row.odoo_extract_count,
    dbLoadedCount: row.rows_processed,
    qaIssuesCount: row.qa_issues_count,
    errorMessage: row.error_message,
  };
}
