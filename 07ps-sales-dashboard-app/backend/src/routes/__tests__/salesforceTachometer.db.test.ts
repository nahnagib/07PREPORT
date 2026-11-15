import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pool } from '../../db/pool';

/**
 * Salesforce Performance Team pulse = Tachometer YTD Value (2026-11-15), against a REAL warehouse, read-only. Opt-in:
 *
 *   DB_HOST=... DB_USER=... DB_PASSWORD=... DB_NAME=powerBI_Data npx vitest run -c vitest.salesforce-db.config.ts
 *
 * Calls both HTTP endpoints (the real routers, real measures, real DB; only the sign-in is stubbed) with the same
 * filters and anchor date and asserts the same YTD actual, target-to-date, achievement % and full-year target.
 */
const RUN = process.env.SALESFORCE_TEST_DB === '1';

vi.mock('../../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { id: 1, isAdmin: true, mustChangePassword: false, roleId: 1, roleTierCode: 'BI00_EXECUTIVE', salespersonKey: null } as express.Request['user'];
    next();
  },
}));
vi.mock('../../services/dataScopeService', () => ({ getRoleDataScopeRules: vi.fn(async () => []) }));

let server: Server;
let base: string;
beforeAll(async () => {
  if (!RUN) return;
  const { salesPeoplePerformanceRouter } = await import('../salesPeoplePerformance');
  const { tachometerRouter } = await import('../tachometer');
  const app = express();
  app.use('/sales-people-performance', salesPeoplePerformanceRouter);
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
  ['no filters', 'anchorDate=2026-11-15'],
  ['default B2B + B2C', 'anchorDate=2026-11-15&segmentKeys=1&segmentKeys=2'],
  ['B2B only', 'anchorDate=2026-11-15&segmentKeys=1'],
  ['B2C only', 'anchorDate=2026-11-15&segmentKeys=2'],
  ['one company (Majaal)', 'anchorDate=2026-11-15&segmentKeys=1&segmentKeys=2&companyKeys=1'],
  ['custom anchor date', 'anchorDate=2026-06-30&segmentKeys=1&segmentKeys=2'],
];

describe.skipIf(!RUN)('Team pulse = Tachometer YTD Value, same filters', () => {
  it.each(CASES)('%s', async (_name, query) => {
    type Json = Record<string, any>;
    const [people, tacho] = (await Promise.all([
      fetch(`${base}/sales-people-performance/overview?${query}`).then((r) => r.json()),
      fetch(`${base}/tachometer/overview?${query}`).then((r) => r.json()),
    ])) as [Json, Json];
    const card = tacho.ytdValue;
    expect(people.company.actual).toBeCloseTo(card.actual, 2);
    expect(people.company.target).toBeCloseTo(card.targetToDate, 2);
    expect(people.company.fullYearTarget).toBeCloseTo(card.fullPeriodTarget, 2);
    expect(people.company.achievement).toBeCloseTo(card.actual / card.targetToDate, 10);
    // the director cards are the same measure per channel: B2B + B2C = the company when both channels are in scope
    if (query.includes('segmentKeys=1&segmentKeys=2')) {
      const sum = people.directors.reduce((t: number, d: { actual: number }) => t + d.actual, 0);
      expect(sum).toBeCloseTo(card.actual, 2);
    }
  });
});
