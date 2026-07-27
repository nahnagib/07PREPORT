import { Job as BullJob } from 'bullmq';
import { pool } from '../../db/pool';
import { getEtlQueue, hasActiveWorker, EtlJobData } from '../queue/etlQueue';
import { isQueueReachable } from '../queue/queueHealth';
import { finishRun } from './etlRunTracker';
import { etlLogger } from './etlLogger';

const PER_JOB_CHECK_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Runs once at API process startup. A queued/running etl_job_runs row is only ever cleaned up by
 * the process that created it -- enqueuePipelineRun's own 10s timeout (etlQueue.ts) marks it
 * 'failed' if BullMQ can't be reached, but only if that same process is still alive when the
 * timeout fires. If the process dies or restarts first (crash, redeploy, `tsx watch` reload,
 * Docker/host hiccup) between creating the row and the timeout completing, nothing is left running
 * to ever mark it 'failed' -- the row is orphaned permanently, and hasActiveEtlRun() then blocks
 * every future run forever. This is what actually happened in production: 4 scheduled runs queued
 * by a since-dead process, never failed, still blocking new runs a day later.
 *
 * This sweep closes that gap: on every fresh startup, check every queued/running row against the
 * real BullMQ queue and fail anything that isn't actually there. Deliberately conservative -- if
 * the queue itself can't be reached right now, this does nothing rather than mass-failing every
 * genuinely in-flight row; that ambiguity is exactly what /admin/etl/status's queueAvailable flag
 * (see queueHealth.ts) exists to report honestly instead of silently guessing here.
 */
export async function reconcileOrphanedEtlRuns(): Promise<void> {
  const [rows] = await pool.query(
    `SELECT id, job_id FROM etl_job_runs WHERE status IN ('queued', 'running')`,
  );
  const activeRows = rows as { id: number; job_id: string | null }[];
  if (activeRows.length === 0) {
    etlLogger.info('ETL reconciliation: no queued/running rows to check at startup');
    return;
  }

  const queueUp = await isQueueReachable();
  if (!queueUp) {
    etlLogger.info(
      'ETL reconciliation: queue is unreachable at startup, skipping -- leaving rows as-is rather than guessing',
      { candidateCount: activeRows.length },
    );
    return;
  }

  for (const row of activeRows) {
    if (!row.job_id) {
      await finishRun(row.id, {
        status: 'failed',
        exitCode: null,
        errorMessage: 'Orphaned at startup: this run has no job_id on record, so it could never have been picked up.',
      });
      etlLogger.info('ETL reconciliation: marked orphaned run as failed (no job_id)', { runId: row.id });
      continue;
    }

    try {
      const job = await withTimeout(BullJob.fromId<EtlJobData>(getEtlQueue(), row.job_id), PER_JOB_CHECK_TIMEOUT_MS);
      if (!job) {
        await finishRun(row.id, {
          status: 'failed',
          exitCode: null,
          errorMessage:
            'Orphaned at startup: no matching job found in the queue (the process that enqueued it likely died before it could be added, or before its own failure could be recorded).',
        });
        etlLogger.info('ETL reconciliation: marked orphaned run as failed (job missing from queue)', {
          runId: row.id, jobId: row.job_id,
        });
      }
      // Job exists -> BullMQ itself is the source of truth for its real state (queued, active,
      // delayed for retry); leave the row alone, a worker will pick it up or fail it on its own.
      //
      // ...*if* a worker is actually running. That's exactly what this function does not check --
      // "the job exists in Redis" and "something is consuming Redis" are different questions, and
      // conflating them is what let a run sit 'queued' with zero log lines for 34+ minutes with no
      // error anywhere. See reconcileStaleQueuedRuns below, which checks the second question on a
      // timer instead of only once at startup (a worker can die at any point after that, not just
      // before it).
    } catch (err) {
      etlLogger.error('ETL reconciliation: could not check run against the queue -- leaving as-is', {
        runId: row.id, jobId: row.job_id, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

const STALE_QUEUED_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * Runs on a timer (see server.ts), not just once at startup like reconcileOrphanedEtlRuns above --
 * the etl:worker process (worker.ts) is separate from this one and can die or never have been
 * deployed *after* startup already completed cleanly, and nothing else ever notices: the job is
 * genuinely sitting in Redis exactly as it should be, so the startup sweep's "job exists in the
 * queue -> leave it alone" logic never flags it. The result is a run stuck 'queued' forever with
 * zero log lines and no error anywhere -- not because anything failed, but because nothing was
 * left to notice nothing was happening.
 *
 * Deliberately narrow to avoid false positives: only acts on a row that is BOTH older than
 * STALE_QUEUED_THRESHOLD_MS (rules out "still waiting for the worker's next poll tick") AND has no
 * worker connected at all right now. A queued row sitting a while *with* a worker present is left
 * alone even if it's been a few minutes -- concurrency:1 means a legitimately long prior run can
 * make the next one wait, and that is not the failure this exists to catch.
 */
export async function reconcileStaleQueuedRuns(): Promise<void> {
  const [rows] = await pool.query(
    `SELECT id, job_id, queued_at FROM etl_job_runs
     WHERE status = 'queued' AND queued_at <= (NOW() - INTERVAL ? SECOND)`,
    [Math.floor(STALE_QUEUED_THRESHOLD_MS / 1000)],
  );
  const staleRows = rows as { id: number; job_id: string | null; queued_at: string }[];
  if (staleRows.length === 0) return;

  const queueUp = await isQueueReachable();
  if (!queueUp) {
    etlLogger.info('ETL reconciliation: queue unreachable, skipping stale-queued sweep', {
      candidateCount: staleRows.length,
    });
    return;
  }

  if (await hasActiveWorker()) {
    // A worker is connected; a stale row here means it's genuinely still working through a
    // backlog (concurrency:1), not that this row was abandoned.
    return;
  }

  for (const row of staleRows) {
    await finishRun(row.id, {
      status: 'failed',
      exitCode: null,
      errorMessage:
        `No ETL worker was consuming the queue after this run sat 'queued' for over ` +
        `${Math.round(STALE_QUEUED_THRESHOLD_MS / 60000)} minutes. The etl:worker process is ` +
        'likely down or was never started; check it before retrying.',
    });
    etlLogger.error('ETL reconciliation: failed a stale queued run -- no worker was connected', {
      runId: row.id, jobId: row.job_id, queuedAt: row.queued_at,
    });

    // Marking the DB row 'failed' above does not remove the underlying BullMQ job -- it's still
    // sitting in Redis exactly as it was. If a worker comes back online later, BullMQ will still
    // hand it that job, and processEtlJob's markRunStarted() would flip this row straight back to
    // 'running', resurrecting a run this sweep already gave up on (this is exactly what happened
    // to run ids 59/60: reconciled 'failed' here, then a worker that started minutes later picked
    // the still-queued BullMQ job back up anyway). Removing it here closes that gap, mirroring the
    // same cleanup POST /admin/etl/force-reset already does for the same reason.
    if (row.job_id) {
      try {
        const job = await getEtlQueue().getJob(row.job_id);
        await job?.remove();
      } catch (err) {
        etlLogger.error('ETL reconciliation: could not remove underlying queue job for stale run', {
          runId: row.id, jobId: row.job_id, error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
