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
import { bcgMatrixRouter } from './routes/bcgMatrix';
import { materialsAnalogyBrandPerformanceRouter } from './routes/materialsAnalogyBrandPerformance';
import { authRouter } from './routes/auth';
import { adminUsersRouter } from './routes/admin/users';
import { adminImportRouter } from './routes/admin/import';
import { adminRolesRouter } from './routes/admin/roles';
import { adminSalespersonsRouter } from './routes/admin/salespersons';
import { adminSalesTeamsRouter } from './routes/admin/salesteams';
import { adminCustomerGroupsRouter } from './routes/admin/customerGroups';
import { adminDistributionChannelsRouter } from './routes/admin/distributionChannels';
import { adminCompaniesRouter } from './routes/admin/companies';
import { adminHolidaysRouter } from './routes/admin/holidays';
import { adminClosuresRouter } from './routes/admin/closures';
import { adminLoginHistoryRouter } from './routes/admin/loginHistory';
import { adminEtlRunsRouter } from './routes/admin/etlRuns';
import { adminEtlControlRouter } from './routes/admin/etlControl';
import { marcomUploadRouter, marcomFreshnessRouter } from './routes/marcomUpload';
import { marcomKpiRouter } from './routes/marcomKpi';
import { cleanupExpiredStaged } from './marcom/staging';
import { registerEtlSchedules } from './etl/scheduler/registerSchedules';
import { reconcileOrphanedEtlRuns, reconcileStaleQueuedRuns } from './etl/services/etlReconciliation';
import { etlLogger } from './etl/services/etlLogger';
import { requestId } from './middleware/requestId';
import { isConnectionError, sendServiceUnavailable } from './lib/dbErrors';
import { runStartupChecks } from './startupChecks';

// Last-resort safety net: Express 4 does not catch a rejected Promise returned by an async
// middleware/handler it invoked directly (no wrapping try/catch or asyncHandler), and Node >= 15
// terminates the whole process on an unhandled rejection by default -- exactly what turned one
// unreachable-DB request into a full outage before requireAuth got its own try/catch (see
// middleware/auth.ts). Every route in this app is expected to catch its own errors and respond
// via res/next; if one doesn't, log it here instead of letting it kill the process.
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('Unhandled promise rejection (process kept alive):', reason);
});
process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('Uncaught exception (process kept alive):', err);
});

const app = express();
const allowedOrigins = (process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000').split(',');
// First, so every log line and error response below can carry the request's correlation ID.
app.use(requestId);
app.use(cors({ origin: allowedOrigins, exposedHeaders: ['X-Request-Id'] }));
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
app.use('/bcg-matrix', bcgMatrixRouter);
app.use('/pim-contribution', materialsAnalogyBrandPerformanceRouter);
app.use('/auth', authRouter);
app.use('/admin/users/import', adminImportRouter);
app.use('/admin/users', adminUsersRouter);
app.use('/admin/roles', adminRolesRouter);
app.use('/admin/salespersons', adminSalespersonsRouter);
app.use('/admin/salesteams', adminSalesTeamsRouter);
app.use('/admin/customer-groups', adminCustomerGroupsRouter);
app.use('/admin/distribution-channels', adminDistributionChannelsRouter);
app.use('/admin/companies', adminCompaniesRouter);
app.use('/admin/holidays', adminHolidaysRouter);
app.use('/admin/closures', adminClosuresRouter);
app.use('/admin/login-history', adminLoginHistoryRouter);
// Mounted before /admin/etl (a shorter prefix) to avoid any ambiguity in route matching.
app.use('/admin/etl-runs', adminEtlRunsRouter);
app.use('/admin/etl', adminEtlControlRouter);
// MARCOM Contribution (Promotion): Excel upload admin + freshness for the four report pages.
app.use('/marcom/upload', marcomUploadRouter);
app.use('/marcom/freshness', marcomFreshnessRouter);
app.use('/marcom/kpi', marcomKpiRouter);

// Section 5.9 - system-tier fallback: no stack traces, no raw DB errors, ever.
app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  // An unreachable data store is an outage, not a bug: 503 so clients (and monitors) can tell.
  if (isConnectionError(err)) {
    sendServiceUnavailable(req, res, err, `${req.method} ${req.originalUrl}`);
    return;
  }
  // eslint-disable-next-line no-console
  console.error(`[${req.id}] Unhandled error on ${req.method} ${req.originalUrl}`, err);
  res.status(500).json({
    error: `Something went wrong. Reference this request in support logs: ${req.id}`,
    requestId: req.id,
  });
});

const port = Number(process.env.PORT ?? 4000);
const STALE_QUEUED_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

async function start(): Promise<void> {
  // Probe every dependency BEFORE claiming to be up, so a dead DB is the first thing in the log
  // instead of a "listening" line followed by a wall of per-request ETIMEDOUT stack traces.
  const report = await runStartupChecks();
  const dbUp = report.database && report.authStore;

  if (!dbUp && process.env.NODE_ENV === 'production') {
    // Fail fast so the orchestrator (Docker restart policy / healthcheck) sees a crash-loop,
    // not a "healthy" container that 503s every request.
    // eslint-disable-next-line no-console
    console.error('[startup] FATAL: database/auth store unreachable in production -- exiting.');
    process.exit(1);
  }

  app.listen(port, '0.0.0.0', () => {
    if (dbUp) {
      // eslint-disable-next-line no-console
      console.log(`07 Ps API (Phase P1/P2 foundation) listening on :${port}`);
    } else {
      // eslint-disable-next-line no-console
      console.error(
        `07 Ps API listening on :${port} in DEGRADED mode: database unreachable, logins and data ` +
          'requests will return 503 until it is back. Check DB_HOST/DB_PORT in backend/.env, then restart.',
      );
    }
  });

  // The API process owns scheduling (cron ticks just enqueue BullMQ jobs, see
  // etl/scheduler/registerSchedules.ts); the etl:worker process is the one that actually executes
  // them, so this stays cheap even though it runs inside the request-serving process.
  registerEtlSchedules();

  // Runs once per process start, before any new run can be enqueued -- see
  // etlReconciliation.ts's header for why this has to happen here (a dead prior process can orphan
  // a queued/running row that nothing else will ever clean up). Skipped when the DB is down: it
  // could only fail, and the periodic sweep below still covers stale queued rows once it's back.
  if (dbUp) {
    reconcileOrphanedEtlRuns().catch((err) =>
      etlLogger.error('ETL reconciliation failed at startup', { error: err instanceof Error ? err.message : String(err) }),
    );
  } else {
    etlLogger.error('ETL reconciliation skipped at startup: database unreachable');
  }

  // Unlike the startup sweep above, this runs for as long as the API process does -- the etl:worker
  // process can die (or never come back up after a redeploy) at any point after startup, not just
  // before it, and nothing else would ever notice a run stuck 'queued' with no worker listening.
  // See reconcileStaleQueuedRuns's header for the exact failure mode this catches.
  setInterval(() => {
    reconcileStaleQueuedRuns().catch((err) =>
      etlLogger.error('ETL stale-queued reconciliation sweep failed', {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }, STALE_QUEUED_SWEEP_INTERVAL_MS);
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[startup] FATAL: startup failed', err);
  process.exit(1);
});

// Staged (dry-run) MARCOM uploads expire after an hour; sweep them (row + file) at startup and every 10 min.
cleanupExpiredStaged().catch(() => undefined);
setInterval(() => { cleanupExpiredStaged().catch(() => undefined); }, 10 * 60 * 1000);
