import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Product pages against a REAL warehouse (read-only: SELECT only). Opt-in:
 *
 *   PRODUCT_TEST_DB=1 DB_HOST=127.0.0.1 DB_USER=... DB_PASSWORD=... DB_NAME=powerBI_Data npx vitest run -c vitest.product-db.config.ts
 *
 * The real routers (one per page, routes/productDashboard.ts), scope middleware (resolveScopedFilters, the SAME parser
 * the Promotion routes use) and pool; only the signed-in admin is faked. Filter matrix, for EVERY Product page and
 * EVERY filter (company, Customer Group, Distribution Channel, Branch = sales team, Salesperson, date range):
 *   - a single value narrows the totals (value, lines, Volume YTD) below the unfiltered ones;
 *   - two values sent as repeated params (what the frontend sends) give exactly the sum of the two single values --
 *     each filter partitions the sales rows, so this proves both values reached the SQL (a value dropped by the parser
 *     would break the sum);
 *   - the old comma-joined form ("1,2") is NOT a valid multi-value request (it must never be what the client sends).
 * Stock-only numbers (stock, days of inventory, band) have no customer: they are not compared, as agreed.
 */
const RUN = process.env.PRODUCT_TEST_DB === '1';

vi.mock('../../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = {
      id: 100, email: 't@test.local', fullName: 't', status: 'ACTIVE', mustChangePassword: false, roleId: null, roleName: null,
      roleLabel: null, roles: [], isAdmin: true, roleTierCode: 'BI00_EXECUTIVE', salespersonKey: null, companyScope: 'ALL', jti: 'j',
    } as unknown as express.Request['user'];
    next();
  },
}));
vi.mock('../../services/permissionService', async () => {
  const actual = await vi.importActual<typeof import('../../services/permissionService')>('../../services/permissionService');
  return {
    ...actual,
    getRequestPermissions: async () => actual.computeEffectivePermissions({ isAdmin: true, roleGrants: [], overrides: [] }),
  };
});

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let server: Server;
let base = '';
let pool: typeof import('../../db/pool').pool;
const PAGES = ['bcg-matrix', 'stock-velocity', 'pim-contribution', 'product-lifecycle'] as const;

interface Totals { value: number; lines: number; volumeYTD: number; products: number }
async function totals(page: string, qs: string): Promise<Totals> {
  const res = await fetch(`${base}/product-dashboard/${page}/overview${qs ? `?${qs}` : ''}`);
  expect(res.status, `${page}?${qs}`).toBe(200);
  const body: Json = await res.json();
  return {
    value: Number(body.totals.value),
    lines: Number(body.totals.lines),
    volumeYTD: (body.products as Json[]).reduce((t, p) => t + Number(p.volumeYTD), 0),
    products: (body.products as Json[]).length,
  };
}
const many = (key: string, values: (string | number)[]) => values.map((v) => `${key}=${encodeURIComponent(String(v))}`).join('&');
const close = (a: number, b: number, what: string) => expect(Math.abs(a - b), what).toBeLessThan(0.01 + Math.abs(b) * 1e-9);

/** The two biggest values of a filter key in the period (so both narrow the data and neither is empty). */
async function topTwo(column: string): Promise<(string | number)[]> {
  const [rows] = await pool.query(
    `SELECT ${column} AS k, SUM(d.Lines) n FROM v_sales_product_daily d WHERE OrderDate >= MAKEDATE(YEAR(CURDATE()), 1) AND ${column} IS NOT NULL
       AND Company <> 'Athena' GROUP BY ${column} ORDER BY n DESC LIMIT 2`,
  );
  return (rows as Json[]).map((r) => (typeof r.k === 'string' ? r.k : Number(r.k)));
}

describe.skipIf(!RUN)('Product pages filter matrix (real warehouse, read-only)', () => {
  const filters: Record<string, (string | number)[]> = {};
  beforeAll(async () => {
    ({ pool } = await import('../../db/pool'));
    const { productDashboardRouter, PRODUCT_DASHBOARD_PAGES } = await import('../productDashboard');
    const app = express();
    for (const [page, key] of Object.entries(PRODUCT_DASHBOARD_PAGES)) app.use(`/product-dashboard/${page}`, productDashboardRouter(key));
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    filters.segmentKeys = await topTwo('SegmentKey');
    filters.channelKeys = await topTwo('ChannelKey');
    filters.salesTeamKeys = await topTwo('SalesTeamKey');
    filters.salespersonKeys = await topTwo('SalespersonKey');
  });
  afterAll(async () => {
    server?.close();
  });

  for (const page of PAGES) {
    describe(page, () => {
      for (const key of ['segmentKeys', 'channelKeys', 'salesTeamKeys', 'salespersonKeys'] as const) {
        it(`${key}: one value narrows the totals, two values = the sum of both`, async () => {
          const [a, b] = filters[key];
          expect(b, `${key} needs two values in the data`).toBeDefined();
          const all = await totals(page, '');
          const ta = await totals(page, many(key, [a]));
          const tb = await totals(page, many(key, [b]));
          const tab = await totals(page, many(key, [a, b]));
          expect(ta.value, `${key}=${a} narrows value`).toBeLessThan(all.value);
          expect(ta.lines, `${key}=${a} narrows lines`).toBeLessThan(all.lines);
          expect(tb.lines).toBeLessThan(all.lines);
          close(tab.value, ta.value + tb.value, `${key}=[${a},${b}] value = sum`);
          expect(tab.lines, `${key}=[${a},${b}] lines = sum`).toBe(ta.lines + tb.lines);
          close(tab.volumeYTD, ta.volumeYTD + tb.volumeYTD, `${key}=[${a},${b}] Volume YTD = sum`);
          expect(tab.lines).toBeGreaterThan(ta.lines);
        });
      }

      it('company: Majaal and Tika each narrow the totals; together they are the whole', async () => {
        const all = await totals(page, '');
        const m = await totals(page, 'company=Majaal');
        const t = await totals(page, 'company=Tika');
        expect(m.lines).toBeLessThan(all.lines);
        expect(t.lines).toBeLessThan(all.lines);
        close(m.value + t.value, all.value, 'Majaal + Tika = all');
        expect(m.products + t.products).toBe(all.products);
      });

      it('date range: a shorter range has fewer sales lines than calendar YTD', async () => {
        const all = await totals(page, '');
        const year = new Date().getFullYear();
        const q1 = await totals(page, `fromDate=${year}-01-01&toDate=${year}-03-31`);
        expect(q1.lines).toBeGreaterThan(0);
        expect(q1.lines).toBeLessThan(all.lines);
      });

      it('the comma-joined form is not a multi-value request (the client never sends it)', async () => {
        const [a, b] = filters.segmentKeys;
        const joined = await totals(page, `segmentKeys=${a},${b}`);
        const both = await totals(page, many('segmentKeys', [a, b]));
        expect(joined.lines).not.toBe(both.lines);
      });
    });
  }
});
