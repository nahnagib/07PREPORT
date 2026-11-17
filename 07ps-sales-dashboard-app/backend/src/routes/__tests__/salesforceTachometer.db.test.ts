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
    // the directors (TargetLevel = Director rows, 2026-11-17) are the same measure per channel: B2B + B2C = the company
    // when both channels are in scope and nothing narrows below a channel
    if (query.endsWith('segmentKeys=1&segmentKeys=2')) {
      const directors = (people.people as Json[]).filter((p) => DIRECTOR_KEYS.includes(p.key));
      expect(directors).toHaveLength(2);
      expect(directors.reduce((t: number, d) => t + d.actual, 0)).toBeCloseTo(card.actual, 2);
    }
  });
});

/** sales_targets.xlsx 2026 (2026-11-17): Salesperson rows B2B 106,506,923 + B2C 62,657,610 = 169,164,533; the Director
 * rows (Mustapha Shaddad 54 = B2B, Mohamed Eljhawi 42 = B2C) repeat those sums and must never add to a total. */
const DIRECTOR_KEYS = [54, 42];
const DIRECTORS: [string, number, number, number][] = [['B2B', 54, 1, 106_506_923], ['B2C', 42, 2, 62_657_610]];

describe.skipIf(!RUN)('B2B / B2C Directors from the targets sheet, the company target unchanged', () => {
  type Json = Record<string, any>;
  const get = async (path: string) => (await fetch(`${base}${path}`)).json() as Promise<Json>;

  /** The company target the Tachometer must show: the sheet's 2026 Salesperson rows (never a Director row), each
   * salesperson counted once at their admin target override when they have one (Admin > Salespersons). */
  async function companyTarget() {
    const [rows] = await pool.query(
      `SELECT SUM(COALESCE(o.target_override_amount, p.rows_total)) AS total
       FROM (SELECT SalespersonKey, SUM(Target_Revenue) AS rows_total FROM fact_sales_targets
             WHERE Year = 2026 AND TargetLevel = 'Salesperson' GROUP BY SalespersonKey) p
       LEFT JOIN salesperson_admin_profile o ON o.salesperson_key = p.SalespersonKey`);
    return Number((rows as { total: string }[])[0].total);
  }

  it('the sheet: Salesperson rows B2B 106,506,923 + B2C 62,657,610 = 169,164,533; the Director rows repeat them', async () => {
    const [rows] = await pool.query(`SELECT TargetLevel AS level, SegmentKey AS seg, SUM(Target_Revenue) AS t
      FROM fact_sales_targets WHERE Year = 2026 GROUP BY TargetLevel, SegmentKey`);
    const by = Object.fromEntries((rows as { level: string; seg: number; t: string }[]).map((r) => [`${r.level}:${r.seg}`, Number(r.t)]));
    expect(by).toEqual({ 'Salesperson:1': 106_506_923, 'Salesperson:2': 62_657_610, 'Director:1': 106_506_923, 'Director:2': 62_657_610 });
  });

  it('the company target never counts a director: Salesperson rows only (with the admin target overrides)', async () => {
    const all = await get('/tachometer/overview?anchorDate=2026-11-15');
    expect(all.ytdValue.fullPeriodTarget).toBeCloseTo(await companyTarget(), 0);
  });

  it.each(DIRECTORS)('%s Director (key %s): actual = the channel sales, target = the Director rows, prorated', async (_c, key, segment, fullYear) => {
    const [people, channel, [months]] = await Promise.all([
      get('/sales-people-performance/overview?anchorDate=2026-11-15'),
      get(`/tachometer/overview?anchorDate=2026-11-15&segmentKeys=${segment}`),
      pool.query(`SELECT Month AS m, SUM(Target_Revenue) AS t FROM fact_sales_targets
        WHERE Year = 2026 AND TargetLevel = 'Director' AND SalespersonKey = ? GROUP BY Month`, [key]),
    ]);
    const monthly = new Map((months as { m: number; t: string }[]).map((r) => [Number(r.m), Number(r.t)]));
    const ytd = [...monthly].filter(([m]) => m < 11).reduce((t, [, v]) => t + v, 0) + monthly.get(11)! * 15 / 30;
    const director = (people.people as Json[]).find((p) => p.key === key)!;
    expect(director).toBeDefined();
    expect(director.fullYearTarget).toBeCloseTo(fullYear, 2);
    expect(director.target).toBeCloseTo(ytd, 2);
    expect(director.actual).toBeCloseTo(channel.ytdValue.actual, 2);
    // the company total is still the Tachometer card: the director is not added to it
    const all = await get('/tachometer/overview?anchorDate=2026-11-15');
    expect(people.company.fullYearTarget).toBeCloseTo(all.ytdValue.fullPeriodTarget, 2);
  });

  it('picking a director in the Salesperson filter shows the director alone, with the channel figures', async () => {
    const people = await get('/sales-people-performance/overview?anchorDate=2026-11-15&salespersonKeys=54');
    expect(people.people.map((p: Json) => p.key)).toEqual([54]);
    expect(people.company.fullYearTarget).toBeCloseTo(106_506_923, 2);
  });
});
