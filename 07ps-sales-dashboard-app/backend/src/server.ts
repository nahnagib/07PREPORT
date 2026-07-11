import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import { healthRouter } from './routes/health';
import { filtersRouter } from './routes/filters';
import { metaRouter } from './routes/meta';
import { tachometerRouter } from './routes/tachometer';
import { authRouter } from './routes/auth';
import { adminUsersRouter } from './routes/admin/users';
import { adminImportRouter } from './routes/admin/import';
import { adminRolesRouter } from './routes/admin/roles';
import { adminLoginHistoryRouter } from './routes/admin/loginHistory';
import { adminEtlRunsRouter } from './routes/admin/etlRuns';
import { adminEtlControlRouter } from './routes/admin/etlControl';
import { registerEtlSchedules } from './etl/scheduler/registerSchedules';

const app = express();
app.use(cors({ origin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000' }));
app.use(express.json());

app.use(healthRouter);
// Mounted with explicit prefixes here (previously baked into each route's own path string) --
// external URL shape unchanged: /filters/*, /meta/*. /tachometer is new this session.
app.use('/filters', filtersRouter);
app.use('/meta', metaRouter);
app.use('/tachometer', tachometerRouter);
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
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`07 Ps API (Phase P1/P2 foundation) listening on :${port}`);
});

// The API process owns scheduling (cron ticks just enqueue BullMQ jobs, see
// etl/scheduler/registerSchedules.ts); the etl:worker process is the one that actually executes
// them, so this stays cheap even though it runs inside the request-serving process.
registerEtlSchedules();
