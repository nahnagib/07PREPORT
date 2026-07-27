import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import { healthRouter } from './routes/health';
import { filtersRouter } from './routes/filters';
import { metaRouter } from './routes/meta';
import { tachometerRouter } from './routes/tachometer';
import { criticalNumberRouter } from './routes/criticalNumber';
import { revenueTrendRouter } from './routes/revenueTrend';
import { invoicesEngineRouter } from './routes/invoicesEngine';
import { customerGrowthRouter } from './routes/customerGrowth';
import { pipelineHealthRouter } from './routes/pipelineHealth';
import { pipelineTrendRouter } from './routes/pipelineTrend';
import { activityMomentumRouter } from './routes/activityMomentum';
import { reportsRouter } from './routes/reports';
import { authRouter } from './routes/auth';
import { adminUsersRouter } from './routes/admin/users';
import { adminImportRouter } from './routes/admin/import';
import { adminRolesRouter } from './routes/admin/roles';
import { adminLoginHistoryRouter } from './routes/admin/loginHistory';
import { adminEtlRunsRouter } from './routes/admin/etlRuns';
import { adminEtlControlRouter } from './routes/admin/etlControl';
import { registerEtlSchedules } from './etl/scheduler/registerSchedules';
import { reconcileOrphanedEtlRuns, reconcileStaleQueuedRuns } from './etl/services/etlReconciliation';
import { etlLogger } from './etl/services/etlLogger';

const app = express();
const allowedOrigins = (process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000').split(',');
app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

app.use(healthRouter);
// Mounted with explicit prefixes here (previously baked into each route's own path string) --
// external URL shape unchanged: /filters/*, /meta/*. /tachometer is new this session.
app.use('/filters', filtersRouter);
app.use('/meta', metaRouter);
app.use('/tachometer', tachometerRouter);
app.use('/critical-number', criticalNumberRouter);
app.use('/revenue-trend', revenueTrendRouter);
app.use('/invoices-engine', invoicesEngineRouter);
app.use('/customer-growth', customerGrowthRouter);
app.use('/pipeline-health', pipelineHealthRouter);
app.use('/pipeline-trend', pipelineTrendRouter);
app.use('/activity-momentum', activityMomentumRouter);
// Overview Report (PDF export) -- aggregates the 8 pages above; not the Python reporting/ pipeline.
app.use('/reports', reportsRouter);
app.use('/auth', authRouter);
app.use('/admin/users/import', adminImportRouter);
app.use('/admin/users', adminUsersRouter);
app.use('/admin/roles', adminRolesRouter);
app.use('/admin/login-history', adminLoginHistoryRouter);
// Mounted before /admin/etl (a shorter prefix) to avoid any ambiguity in route matching.
app.use('/admin/etl-runs', adminEtlRunsRouter);
app.use('/admin/etl', adminEtlControlRouter);

// Section 5.9 - system-tier fallback: no stack traces, no raw DB errors, ever.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Reference this request in support logs.' });
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`07 Ps API (Phase P1/P2 foundation) listening on :${port}`);
});

// The API process owns scheduling (cron ticks just enqueue BullMQ jobs, see
// etl/scheduler/registerSchedules.ts); the etl:worker process is the one that actually executes
// them, so this stays cheap even though it runs inside the request-serving process.
registerEtlSchedules();

// Runs once per process start, before any new run can be enqueued -- see
// etlReconciliation.ts's header for why this has to happen here (a dead prior process can orphan
// a queued/running row that nothing else will ever clean up).
reconcileOrphanedEtlRuns().catch((err) =>
  etlLogger.error('ETL reconciliation failed at startup', { error: err instanceof Error ? err.message : String(err) }),
);

// Unlike the startup sweep above, this runs for as long as the API process does -- the etl:worker
// process can die (or never come back up after a redeploy) at any point after startup, not just
// before it, and nothing else would ever notice a run stuck 'queued' with no worker listening.
// See reconcileStaleQueuedRuns's header for the exact failure mode this catches.
const STALE_QUEUED_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
setInterval(() => {
  reconcileStaleQueuedRuns().catch((err) =>
    etlLogger.error('ETL stale-queued reconciliation sweep failed', {
      error: err instanceof Error ? err.message : String(err),
    }),
  );
}, STALE_QUEUED_SWEEP_INTERVAL_MS);
