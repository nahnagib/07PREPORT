import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pool } from '../../db/pool';

/**
 * Receivables "Debt to YTD Sales %" YTD sales = Tachometer YTD Value (2026-11-15), against a REAL warehouse, read-only.
 * Opt-in: DB_* in the environment, then  npx vitest run -c vitest.salesforce-db.config.ts
 * Both real routers (only the sign-in is stubbed), the same filters and anchor date: the same number, to the cent.
 */
const RUN = process.env.SALESFORCE_TEST_DB === '1';

vi.mock('../../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { id: 1, isAdmin: true, mustChangePassword: false, roleId: 1, roleTierCode: 'BI00_EXECUTIVE', salespersonKey: null } as express.Request['user'];
    next();
  },
}));
vi.mock('../../services/dataScopeService', () => ({ getRoleDataScopeRules: vi.fn(async () => []) }));
vi.mock('../../middleware/permission', () => ({
  requirePasswordChangeCleared: (_q: unknown, _s: unknown, next: () => void) => next(),
  requirePermission: () => (_q: unknown, _s: unknown, next: () => void) => next(),
}));

let server: Server;
let base: string;
beforeAll(async () => {
  if (!RUN) return;
  const { debtReportRouter } = await import('../debtReport');
  const { tachometerRouter } = await import('../tachometer');
  const app = express();
  app.use('/debt-report', debtReportRouter);
  app.use('/tachometer', tachometerRouter);
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  if (!RUN) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

const CASES: [string, string][] = [
  ['all companies', 'anchorDate=2026-11-15'],
  ['all companies, B2B + B2C (Tachometer default)', 'anchorDate=2026-11-15&segmentKeys=1&segmentKeys=2'],
  ['Majaal', 'anchorDate=2026-11-15&companyKeys=1'],
  ['Tika', 'anchorDate=2026-11-15&companyKeys=3'],
  ['earlier anchor', 'anchorDate=2026-10-15&segmentKeys=1&segmentKeys=2'],
];

describe.skipIf(!RUN)('Receivables YTD sales = Tachometer YTD Value, same filters', () => {
  it.each(CASES)('%s', async (_name, query) => {
    type Json = Record<string, any>;
    const [debt, tacho] = (await Promise.all([
      fetch(`${base}/debt-report/overview?${query}`).then((r) => r.json()),
      fetch(`${base}/tachometer/overview?${query}`).then((r) => r.json()),
    ])) as [Json, Json];
    expect(debt.ytdSales.value).toBeCloseTo(tacho.ytdValue.actual, 2);
    expect(debt.ytdSales.to).toBe(query.slice('anchorDate='.length, 'anchorDate='.length + 10));
  });
});
