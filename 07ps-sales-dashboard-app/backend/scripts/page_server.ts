// Read-only page API for local regression checks (Phase 4, scripts/page_check.mjs).
//
//   PORT=4100 DB_HOST=127.0.0.1 ... JWT_SECRET=<a test secret made for this run> npx tsx scripts/page_server.ts
//
// Mounts ONLY the dashboard page routers (+ /auth/me) of src/server.ts, and refuses every method but GET/HEAD -- except
// POST /exports/authorize, the read-only Export permission check the pages ask before a download (Phase 7 browser run).
// CORS_ORIGIN (e.g. http://localhost:3100) lets a local frontend dev server call it from the browser.
// Unlike src/server.ts it does NOT sync the permission registry, register ETL schedules, reconcile ETL runs or
// touch Redis, so pointing it at a live database changes nothing there.
import cors from 'cors';
import express from 'express';
import { requestId } from '../src/middleware/requestId';
import { isConnectionError, sendServiceUnavailable } from '../src/lib/dbErrors';
import { filtersRouter } from '../src/routes/filters';
import { metaRouter } from '../src/routes/meta';
import { tachometerRouter } from '../src/routes/tachometer';
import { criticalNumberRouter } from '../src/routes/criticalNumber';
import { revenueTrendRouter } from '../src/routes/revenueTrend';
import { invoicesEngineRouter } from '../src/routes/invoicesEngine';
import { customerGrowthRouter } from '../src/routes/customerGrowth';
import { pipelineHealthRouter } from '../src/routes/pipelineHealth';
import { pipelineTrendRouter } from '../src/routes/pipelineTrend';
import { activityMomentumRouter } from '../src/routes/activityMomentum';
import { PRODUCT_DASHBOARD_PAGES, productDashboardRouter } from '../src/routes/productDashboard';
import { authRouter } from '../src/routes/auth';
import { debtReportRouter } from '../src/routes/debtReport';
import { exportsRouter } from '../src/routes/exports';

const app = express();
if (process.env.CORS_ORIGIN) app.use(cors({ origin: process.env.CORS_ORIGIN.split(',') }));
app.use((req, res, next) => {
  if (req.method === 'OPTIONS' || (req.method === 'POST' && req.path === '/exports/authorize')) {
    next();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).json({ error: 'read-only page server' });
    return;
  }
  next();
});
app.use(requestId);
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
for (const [path, pageKey] of Object.entries(PRODUCT_DASHBOARD_PAGES)) {
  app.use(`/product-dashboard/${path}`, productDashboardRouter(pageKey));
}
app.use('/debt-report', debtReportRouter);
app.use('/auth', authRouter); // GET /auth/me only (the gate above blocks login/logout/password routes)
app.use('/exports', express.json(), exportsRouter); // POST /exports/authorize: blocked by the GET-only gate except that one check (below)
app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (isConnectionError(err)) {
    sendServiceUnavailable(req, res, err, `${req.method} ${req.originalUrl}`);
    return;
  }
  // eslint-disable-next-line no-console
  console.error(`[${req.id}] ${req.method} ${req.originalUrl}`, err);
  res.status(500).json({ error: String(err instanceof Error ? err.message : err), requestId: req.id });
});

const port = Number(process.env.PORT ?? 4100);
app.listen(port, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`read-only page server on http://127.0.0.1:${port}`);
});
