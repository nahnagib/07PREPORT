import { NextFunction, Request, Response, Router } from 'express';
import { Job as BullJob } from 'bullmq';
import { requireAuth } from '../../middleware/auth';
import { requireAdminRole, requirePasswordChangeCleared } from '../../middleware/permission';
import { getEtlConfig } from '../../etl/config/etlConfig';
import { computeNextRunTime } from '../../etl/scheduler/nextRunTime';
import { EtlJobData, enqueuePipelineRun, getEtlQueue, hasActiveEtlRun } from '../../etl/queue/etlQueue';
import { publishCancelRequest } from '../../etl/queue/etlControlChannel';
import {
  EtlMode,
  EtlRunStatus,
  getActiveRun,
  getLastFinishedRun,
  listRunHistory,
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

    const active = await getActiveRun();
    if (active) {
      let progress: unknown = null;
      let recentLog: string[] = [];
      if (active.job_id) {
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
