import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * The Daily / Weekly / Monthly / Yearly trends (lib/periods.ts) against a REAL warehouse (read-only: SELECT only). Opt-in:
 *
 *   npx vitest run -c vitest.trend-db.config.ts      (DB_* in the environment, e.g. the local powerBI_Data)
 *
 * The real routers, scope middleware and pool; only the user is faked. For every granularity:
 *   - 30 / 12 / 12 / 5 points, the last one in progress;
 *   - Revenue Trend: the points add up to the page's KPI figure for the same window (fetchValueVolume, the function behind
 *     the KPI cards) AND to an independent SUM on v_sales_lines written here;
 *   - Invoices Engine, Customer Growth, Pipeline Trend, Activity Momentum: the points add up to the window total;
 *   - a salesperson sees exactly what an admin sees with the filter on that salesperson (role scope still applies).
 */
const RUN = process.env.TREND_TEST_DB === '1';

type Grant = [string, string];
const PAGES = ['revenue_trend', 'invoices_engine', 'customer_growth', 'pipeline_trend', 'activity_momentum'];
const USERS: Record<string, { isAdmin?: boolean; tier: string; salespersonKey?: number | null; grants: Grant[] }> = {
  admin: { isAdmin: true, tier: 'BI00_EXECUTIVE', grants: [] },
  salesperson: { tier: 'SALESPERSON', salespersonKey: null, grants: PAGES.map((p) => [p, 'view'] as Grant) },
};

vi.mock('../../middleware/auth', () => ({
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const u = USERS[req.header('x-test-user') ?? ''];
    if (!u) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    req.user = {
      id: 100, email: 't@test.local', fullName: 't', status: 'ACTIVE', mustChangePassword: false, roleId: null, roleName: null,
      roleLabel: null, roles: [], isAdmin: u.isAdmin === true, roleTierCode: u.tier, salespersonKey: u.salespersonKey ?? null,
      companyScope: 'ALL', jti: 'j',
    } as unknown as express.Request['user'];
    next();
  },
}));
vi.mock('../../services/permissionService', async () => {
  const actual = await vi.importActual<typeof import('../../services/permissionService')>('../../services/permissionService');
  return {
    ...actual,
    getRequestPermissions: async (req: express.Request) => {
      const u = USERS[req.header('x-test-user') ?? ''];
      return actual.computeEffectivePermissions({
        isAdmin: u?.isAdmin === true,
        roleGrants: (u?.grants ?? []).map(([page_key, action]) => ({ page_key, action: action as never, allowed: 1 })),
        overrides: [],
      });
    },
  };
});

let server: Server;
let base = '';
let pool: typeof import('../../db/pool').pool;
type Json = any;
const get = async (path: string, who = 'admin'): Promise<Json> => {
  const res = await fetch(`${base}${path}`, { headers: { 'x-test-user': who } });
  expect(res.status, path).toBe(200);
  return res.json();
};
const n = (v: unknown) => Number(v ?? 0);
const sum = (rows: Json[], k: string) => rows.reduce((s, r) => s + n(r[k]), 0);
const close = (a: number, b: number, what: string) => expect(Math.abs(a - b), `${what}: ${a} vs ${b}`).toBeLessThan(Math.max(1e-6, Math.abs(b) * 1e-9));
const GRANULARITIES = [['day', 30], ['week', 12], ['month', 12], ['year', 5]] as const;

describe.skipIf(!RUN)('period trends on the real warehouse (read-only)', () => {
  beforeAll(async () => {
    ({ pool } = await import('../../db/pool'));
    const app = express();
    app.use('/revenue-trend', (await import('../revenueTrend')).revenueTrendRouter);
    app.use('/invoices-engine', (await import('../invoicesEngine')).invoicesEngineRouter);
    app.use('/customer-growth', (await import('../customerGrowth')).customerGrowthRouter);
    app.use('/pipeline-trend', (await import('../pipelineTrend')).pipelineTrendRouter);
    app.use('/activity-momentum', (await import('../activityMomentum')).activityMomentumRouter);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const [rows] = await pool.query(
      `SELECT fsl.SalespersonKey AS k FROM v_sales_lines fsl JOIN dim_date dd ON fsl.DateKey = dd.DateKey
       WHERE dd.Date >= CURDATE() - INTERVAL 1 YEAR AND fsl.SalespersonKey > 0 GROUP BY fsl.SalespersonKey ORDER BY COUNT(*) DESC LIMIT 1`);
    const top = (rows as Json[])[0];
    USERS.salesperson.salespersonKey = top ? n(top.k) : null;
  });
  afterAll(async () => {
    server?.close();
    await pool?.end();
  });

  it.each(GRANULARITIES)('Revenue Trend %s: %i points that add up to the KPI figure of the window', async (g, count) => {
    const t = await get(`/revenue-trend/trend?granularity=${g}`);
    expect(t.points).toHaveLength(count);
    expect(t.points.map((p: Json) => p.inProgress)).toEqual(t.points.map((_: Json, i: number) => i === count - 1));
    close(sum(t.points, 'value'), t.totals.value, `${g} value`);
    close(sum(t.points, 'volume'), t.totals.volume, `${g} volume`);
    const [rows] = await pool.query(
      `SELECT COALESCE(SUM(fsl.value), 0) AS v, COALESCE(SUM(fsl.volume), 0) AS q FROM v_sales_lines fsl JOIN dim_date dd ON fsl.DateKey = dd.DateKey
       WHERE dd.Date BETWEEN ? AND ?`, [t.from, t.to]);
    const independent = (rows as Json[])[0];
    close(sum(t.points, 'value'), n(independent.v), `${g} value vs SQL`);
    close(sum(t.points, 'volume'), n(independent.q), `${g} volume vs SQL`);
    // ASP = the period's value / volume, never an average of daily ASPs
    for (const p of t.points) expect(p.asp).toBe(p.volume ? p.value / p.volume : null);
    expect(t.hasTarget).toBe(g === 'month' || g === 'year');
    if (!t.hasTarget) expect(t.points.every((p: Json) => p.targetValue === null)).toBe(true);
  });

  it.each(GRANULARITIES)('the other pages, %s: %i points that add up to the window total', async (g, count) => {
    const inv = await get(`/invoices-engine/trend?granularity=${g}`);
    expect(inv.salesTrend.byPeriod).toHaveLength(count);
    expect(inv.invoicesTrend).toHaveLength(count);
    close(sum(inv.salesTrend.byPeriod, 'invoiceSalesValue'), inv.totals.invoiceSalesValue, `${g} invoices`);
    const cg = await get(`/customer-growth/trend?granularity=${g}`);
    expect(cg.points).toHaveLength(count);
    close(sum(cg.points, 'totalSalesValue'), cg.totals.totalSalesValue, `${g} customer sales`);
    const pt = await get(`/pipeline-trend/trend?granularity=${g}`);
    for (const k of ['opportunities', 'quotations', 'salesOrders']) {
      expect(pt[k].points).toHaveLength(count);
      close(sum(pt[k].points, 'count'), pt[k].totals.count, `${g} ${k} count`);
      close(sum(pt[k].points, 'value'), pt[k].totals.value, `${g} ${k} value`);
    }
    const am = await get(`/activity-momentum/trend?granularity=${g}`);
    expect(am.points).toHaveLength(count);
    expect(sum(am.points, 'count')).toBe(am.total);
  });

  it('a salesperson sees what an admin sees filtered on them (role scope still applies)', async () => {
    const key = USERS.salesperson.salespersonKey;
    expect(key, 'a salesperson with sales in the last year').not.toBeNull();
    for (const path of ['/revenue-trend/trend?granularity=month', '/customer-growth/trend?granularity=week']) {
      const own = await get(path, 'salesperson');
      const filtered = await get(`${path}&salespersonKeys=${key}`);
      expect(own.points, path).toEqual(filtered.points);
    }
    const all = await get('/revenue-trend/trend?granularity=year');
    const own = await get('/revenue-trend/trend?granularity=year', 'salesperson');
    expect(own.totals.value).toBeLessThan(all.totals.value);
  });
});
