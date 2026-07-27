import { NextFunction, Request, Response, Router } from 'express';
import { Job as BullJob } from 'bullmq';
import { requireAuth } from '../../middleware/auth';
import { requireAdminRole, requirePasswordChangeCleared } from '../../middleware/permission';
import { getEtlConfig } from '../../etl/config/etlConfig';
import { computeNextRunTime } from '../../etl/scheduler/nextRunTime';
import { EtlJobData, enqueuePipelineRun, getEtlQueue, hasActiveEtlRun, hasActiveWorker } from '../../etl/queue/etlQueue';
import { isQueueReachable } from '../../etl/queue/queueHealth';
import { publishCancelRequest } from '../../etl/queue/etlControlChannel';
import { etlLogger } from '../../etl/services/etlLogger';
import { resetEtlApi } from '../../etl/services/pythonRunner';
import {
  EtlMode,
  EtlRunStatus,
  forceResetActiveEtlRuns,
  getActiveRun,
  getLastFinishedRun,
  getRunById,
  listRunHistory,
  releaseOrphanedPipelineLock,
} from '../../etl/services/etlRunTracker';

/**
 * The ETL Control Center's API. Every route here is Admin-role-only (requireAdminRole), NOT the
 * customizable pages/role_permissions system every other admin route uses -- this surface can
 * trigger real Odoo extraction + MySQL rewrites, so it's intentionally not delegable.
 */
export const adminEtlControlRouter = Router();

adminEtlControlRouter.use(requireAuth, requirePasswordChangeCleared, requireAdminRole);

const LIVE_LOG_LINES = 50;

adminEtlControlRouter.get('/status', async (_req, res, next) => {
  try {
    const config = getEtlConfig();
    const nextIncremental = config.schedule.incrementalEnabled
      ? computeNextRunTime(config.schedule.incrementalCron)
      : null;
    const nextFull = config.schedule.fullEnabled ? computeNextRunTime(config.schedule.fullCron) : null;

    // Checked up front so the UI can tell "queue is genuinely unreachable" apart from "a run is
    // genuinely active" -- those used to be indistinguishable (any queued/running row read as
    // "already running" regardless of whether BullMQ could actually be reached), which is what
    // produced the misleading lock. See queueHealth.ts's header.
    const queueAvailable = await isQueueReachable();
    // Only meaningful once the queue itself is reachable -- if Redis is down, "is a worker
    // connected to it" isn't a separate question worth a second round-trip, and queueAvailable
    // already explains the situation. See hasActiveWorker's header for why this exists at all: a
    // dead/never-started worker process leaves jobs "Queued" forever with no other symptom.
    const workerAvailable = queueAvailable ? await hasActiveWorker() : false;

    const active = await getActiveRun();
    if (active) {
      let progress: unknown = null;
      let recentLog: string[] = [];
      if (active.job_id && queueAvailable) {
        try {
          const job = await BullJob.fromId<EtlJobData>(getEtlQueue(), active.job_id);
          if (job) {
            progress = job.progress;
            const { logs } = await getEtlQueue().getJobLogs(active.job_id, -LIVE_LOG_LINES, -1);
            recentLog = logs;
          }
        } catch {
          // BullMQ/Redis hiccup reading live progress shouldn't fail the whole status response --
          // the DB row (status/queued_at/started_at) is still accurate on its own.
        }
      }
      res.json({
        run: active,
        progress,
        recentLog,
        queueAvailable,
        workerAvailable,
        elapsedMs: Date.now() - (active.started_at ?? active.queued_at).getTime(),
        nextIncrementalRun: nextIncremental,
        nextFullRun: nextFull,
      });
      return;
    }

    const last = await getLastFinishedRun();
    res.json({
      run: last,
      progress: null,
      recentLog: [],
      queueAvailable,
      workerAvailable,
      elapsedMs: null,
      nextIncrementalRun: nextIncremental,
      nextFullRun: nextFull,
    });
  } catch (err) {
    next(err);
  }
});

const VALID_STATUSES: EtlRunStatus[] = ['queued', 'running', 'success', 'failed', 'cancelled'];
const VALID_MODES: EtlMode[] = ['incremental', 'full', 'sql', 'excel'];

adminEtlControlRouter.get('/history', async (req: Request, res, next) => {
  try {
    const page = Number(req.query.page ?? 1) || 1;
    const pageSize = Math.min(Number(req.query.pageSize ?? 25) || 25, 100);
    const status = typeof req.query.status === 'string' && VALID_STATUSES.includes(req.query.status as EtlRunStatus)
      ? (req.query.status as EtlRunStatus)
      : undefined;
    const mode = typeof req.query.mode === 'string' && VALID_MODES.includes(req.query.mode as EtlMode)
      ? (req.query.mode as EtlMode)
      : undefined;
    const fromDate = typeof req.query.fromDate === 'string' ? req.query.fromDate : undefined;
    const toDate = typeof req.query.toDate === 'string' ? req.query.toDate : undefined;

    const result = await listRunHistory({ status, mode, fromDate, toDate, page, pageSize });
    res.json({ ...result, page, pageSize });
  } catch (err) {
    next(err);
  }
});

adminEtlControlRouter.get('/scheduler-config', async (_req, res, next) => {
  try {
    const config = getEtlConfig();
    res.json({
      incremental: {
        cron: config.schedule.incrementalCron,
        enabled: config.schedule.incrementalEnabled,
        nextRun: config.schedule.incrementalEnabled ? computeNextRunTime(config.schedule.incrementalCron) : null,
      },
      full: {
        cron: config.schedule.fullCron,
        enabled: config.schedule.fullEnabled,
        nextRun: config.schedule.fullEnabled ? computeNextRunTime(config.schedule.fullCron) : null,
      },
    });
  } catch (err) {
    next(err);
  }
});

interface StartConfig {
  mode: EtlMode;
  loadMode: 'full' | 'incremental';
  outputMode: 'sql' | 'excel' | 'both';
  fast?: boolean;
}

const START_CONFIGS: Record<'incremental' | 'full' | 'sql' | 'excel', StartConfig> = {
  incremental: { mode: 'incremental', loadMode: 'incremental', outputMode: 'sql', fast: true },
  full: { mode: 'full', loadMode: 'full', outputMode: 'sql' },
  sql: { mode: 'sql', loadMode: 'incremental', outputMode: 'sql' },
  excel: { mode: 'excel', loadMode: 'full', outputMode: 'excel' },
};

function makeStartHandler(key: keyof typeof START_CONFIGS) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Checked before hasActiveEtlRun so an unreachable queue is reported honestly rather than
      // as a false "already running" -- a stale queued/running row and a down queue used to be
      // indistinguishable from the caller's side.
      if (!(await isQueueReachable())) {
        res.status(503).json({
          error: 'ETL queue is currently unreachable. Cannot start a new run until connectivity is restored.',
        });
        return;
      }
      // Checked before enqueuing, not after: without this, a run enqueues fine, the DB row goes
      // 'queued', and then nothing ever happens to it -- no worker means no error, just an
      // indefinite "Queued" with zero log lines (see hasActiveWorker's header). Failing here
      // instead turns that silent hang into an honest, immediate error.
      if (!(await hasActiveWorker())) {
        res.status(503).json({
          error: 'No ETL worker process is currently consuming the queue. Starting a run now would '
            + 'queue it with nothing to pick it up. Check that the etl:worker process is running.',
        });
        return;
      }
      if (await hasActiveEtlRun()) {
        res.status(409).json({ error: 'An ETL process is already running.' });
        return;
      }
      const cfg = START_CONFIGS[key];
      const { job, runId } = await enqueuePipelineRun({
        mode: cfg.mode,
        loadMode: cfg.loadMode,
        outputMode: cfg.outputMode,
        fast: cfg.fast,
        label: `manual-${key}`,
        triggerSource: 'manual',
        triggeredByUserId: req.user!.id,
        triggeredByUserName: req.user!.fullName,
      });
      res.status(202).json({ ok: true, runId, jobId: job.id });
    } catch (err) {
      next(err);
    }
  };
}

adminEtlControlRouter.post('/start/incremental', makeStartHandler('incremental'));
adminEtlControlRouter.post('/start/full', makeStartHandler('full'));
adminEtlControlRouter.post('/start/sql', makeStartHandler('sql'));
adminEtlControlRouter.post('/start/excel', makeStartHandler('excel'));

/**
 * Manual override for a stuck "already running" lock (see forceResetActiveEtlRuns's header) --
 * the confirm dialog lives on the frontend (this is a destructive override, not a normal action);
 * this route just does the work and leaves a permanent audit trail in error_message plus a log
 * line, since silently unsticking a lock with no record of who/when would just trade one opaque
 * problem for another.
 *
 * Resets all FOUR places a "run in progress" can be stuck, not just the Node-side DB row this
 * route originally only touched -- a stuck run can be state left behind in any (or several) of:
 *   1. etl_job_runs (this DB's own tracking table)
 *   2. the BullMQ job in Redis
 *   3. job_tracker.py's in-memory tracker on the Flask ETL API process
 *   4. a MySQL GET_LOCK() session held by DatabaseExporter (data/etl's own pipeline)
 * Resetting only #1 (the original behavior) left #3/#4 free to keep blocking every run enqueued
 * afterward with no visible link back to "you already clicked Force Reset" -- each sub-reset below
 * is independent and best-effort so a failure/timeout in one (e.g. Flask API unreachable) doesn't
 * stop the others from running.
 */
adminEtlControlRouter.post('/force-reset', async (req, res, next) => {
  try {
    const reset = await forceResetActiveEtlRuns(req.user!.id, req.user!.fullName);
    etlLogger.info('ETL lock force-reset by admin', {
      userId: req.user!.id, userName: req.user!.fullName, resetRuns: reset,
    });

    const [, apiReset, lockReset] = await Promise.all([
      // Best-effort: if the underlying BullMQ job still exists (queue back up, worker hasn't
      // touched it yet), remove it too -- otherwise a worker could pick it up later and act on a
      // job whose tracking row now says 'failed', a confusing double state. Never lets a queue
      // hiccup here block the reset itself, which already succeeded at the DB level above.
      Promise.all(
        reset
          .filter((r): r is { id: number; jobId: string } => r.jobId !== null)
          .map(async ({ jobId }) => {
            try {
              const job = await getEtlQueue().getJob(jobId);
              await job?.remove();
            } catch (err) {
              etlLogger.error('Force-reset: could not remove underlying queue job (DB reset still applied)', {
                jobId, error: err instanceof Error ? err.message : String(err),
              });
            }
          }),
      ),
      // Clears job_tracker.py's in-memory "active job" slot -- see resetEtlApi's header for why
      // the DB-row reset above doesn't already cover this.
      resetEtlApi(),
      // Kills whatever MySQL connection currently holds DatabaseExporter's GET_LOCK, if any -- see
      // releaseOrphanedPipelineLock's header for why RELEASE_LOCK() itself can't do this from here.
      releaseOrphanedPipelineLock(),
    ]);

    res.json({
      ok: true,
      rowsReset: reset.length,
      etlApiJobReset: apiReset?.resetJobId ?? null,
      sqlLockReleased: lockReset.released,
    });
  } catch (err) {
    next(err);
  }
});

/** Full persisted log for a past (or current) run -- backs the Run History "click a row to view
 * its log" feature. Not live -- a plain GET returning whatever BullMQ still has for that job.
 * BullMQ evicts job data by count (removeOnComplete: 100, removeOnFail: 200, see etlQueue.ts), so
 * a sufficiently old run's logs may simply no longer exist; that's reported honestly, not as an
 * error. */
adminEtlControlRouter.get('/runs/:runId/log', async (req, res, next) => {
  try {
    const runId = Number(req.params.runId);
    if (!Number.isInteger(runId)) {
      res.status(400).json({ error: 'Invalid run id.' });
      return;
    }
    const run = await getRunById(runId);
    if (!run) {
      res.status(404).json({ error: 'Run not found.' });
      return;
    }
    if (!run.job_id) {
      res.json({ lines: [] });
      return;
    }
    try {
      const { logs } = await getEtlQueue().getJobLogs(run.job_id, 0, -1);
      res.json({ lines: logs });
    } catch (err) {
      etlLogger.error('Could not read persisted log for run (queue unreachable or job evicted)', {
        runId, jobId: run.job_id, error: err instanceof Error ? err.message : String(err),
      });
      res.json({ lines: [] });
    }
  } catch (err) {
    next(err);
  }
});

const SSE_POLL_INTERVAL_MS = 1500;
const SSE_HEARTBEAT_INTERVAL_MS = 15000;
const TERMINAL_STATUSES: EtlRunStatus[] = ['success', 'failed', 'cancelled'];

/**
 * Live log/progress/status stream for one run, via Server-Sent Events. Chosen over a WebSocket:
 * this is a strictly one-directional server->browser feed (Cancel already has its own POST route),
 * runs over plain HTTP with no new dependency, and native EventSource-style clients get
 * reconnection for free -- see the root-cause writeup for the full reasoning. The frontend here
 * uses `fetch` + a stream reader instead of the native EventSource API specifically because
 * EventSource cannot send an Authorization header, and this app has no cookie-based session to
 * fall back on (see middleware/auth.ts) -- this route is protected by the exact same
 * requireAuth/requireAdminRole chain as every other route in this router, not a query-string token.
 *
 * There is no BullMQ pub/sub for job.log() calls specifically (QueueEvents covers lifecycle/
 * progress events, not arbitrary log lines), so this polls getJobLogs/job.progress server-side on
 * an interval and pushes only the delta -- the same information the old 5s-polling frontend
 * already fetched, just polled faster and pushed instead of re-fetched from a cold start each time.
 */
adminEtlControlRouter.get('/stream/:runId', async (req, res, next) => {
  const runId = Number(req.params.runId);
  if (!Number.isInteger(runId)) {
    res.status(400).json({ error: 'Invalid run id.' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  let closed = false;
  const send = (event: string, data: unknown) => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let seenLineCount = 0;
  let lastProgressJson = '';
  let lastStatus: EtlRunStatus | null = null;

  async function tick() {
    if (closed) return;
    try {
      const run = await getRunById(runId);
      if (!run) {
        send('error', { message: 'Run not found.' });
        endStream();
        return;
      }
      if (run.status !== lastStatus) {
        lastStatus = run.status;
        send('status', { status: run.status });
      }
      if (run.job_id) {
        try {
          const job = await BullJob.fromId<EtlJobData>(getEtlQueue(), run.job_id);
          if (job) {
            const progressJson = JSON.stringify(job.progress ?? null);
            if (progressJson !== lastProgressJson) {
              lastProgressJson = progressJson;
              send('progress', job.progress ?? null);
            }
            const { logs, count } = await getEtlQueue().getJobLogs(run.job_id, seenLineCount, -1);
            logs.forEach((line) => send('log', { line, ts: new Date().toISOString() }));
            seenLineCount = count;
          }
        } catch (err) {
          // A transient queue hiccup mid-stream shouldn't tear down the connection -- surface it
          // as a one-off notice and keep polling; the client's own reconnect logic (fetch retry)
          // handles a connection that's actually dead.
          send('queue-warning', { message: err instanceof Error ? err.message : String(err) });
        }
      }
      if (TERMINAL_STATUSES.includes(run.status)) {
        send('done', { status: run.status });
        endStream();
      }
    } catch (err) {
      send('error', { message: err instanceof Error ? err.message : String(err) });
      endStream();
    }
  }

  function endStream() {
    if (closed) return;
    closed = true;
    clearInterval(poll);
    clearInterval(heartbeat);
    res.end();
  }

  req.on('close', endStream);

  const poll = setInterval(() => void tick(), SSE_POLL_INTERVAL_MS);
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': heartbeat\n\n');
  }, SSE_HEARTBEAT_INTERVAL_MS);

  void tick();
});

adminEtlControlRouter.post('/cancel', async (_req, res, next) => {
  try {
    const active = await getActiveRun();
    if (!active?.job_id) {
      // job_id is set at the same time the row is created (see enqueuePipelineRun), so a
      // tracked active run always has one -- this is just "nothing to cancel."
      res.status(400).json({ error: 'No ETL process is currently running.' });
      return;
    }
    await publishCancelRequest(active.job_id);
    res.json({ ok: true, message: 'Cancellation requested.' });
  } catch (err) {
    next(err);
  }
});
