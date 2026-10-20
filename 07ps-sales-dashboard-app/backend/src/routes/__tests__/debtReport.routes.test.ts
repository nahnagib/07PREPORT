import { EXCLUDED_TEAMS_CONDITION } from '../../measures/debtReport';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Debt Report access over real HTTP: the real router, permission middleware and scope middleware; the signed-in
 * user, their grants / data-scope rules and the database are faked. The SQL each request sends is recorded, so the
 * test can see that the salesperson lock reaches every query (server-side, not only in the UI).
 */

type Grant = [pageKey: string, action: string];
interface TestUser {
  isAdmin?: boolean;
  tier: string;
  salespersonKey?: number | null;
  grants: Grant[];
  rules?: { dimension: string; value: string }[];
}
const DEBT: Grant[] = [['debt_report', 'view'], ['debt_report', 'export']];
const USERS: Record<string, TestUser> = {
  admin: { isAdmin: true, tier: 'BI00_EXECUTIVE', grants: [] },
  gcfo: { tier: 'BI00_EXECUTIVE', grants: DEBT },
  b2b: { tier: 'BI01_DIRECTOR_B2B', grants: DEBT, rules: [{ dimension: 'segmentKeys', value: '1' }] },
  // the Salesperson role as seeded: no Debt Report grant
  salesperson: { tier: 'SALESPERSON', salespersonKey: 49, grants: [['tachometer', 'view']] },
  // the Salesperson role after an admin enabled the Debt Report for it
  salespersonEnabled: { tier: 'SALESPERSON', salespersonKey: 49, grants: [['tachometer', 'view'], ['debt_report', 'view']] },
};

vi.mock('../../middleware/auth', () => ({
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const who = req.header('x-test-user');
    if (!who || !USERS[who]) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const u = USERS[who];
    req.user = {
      id: 100, email: `${who}@test.local`, fullName: who, status: 'ACTIVE', mustChangePassword: false,
      roleId: 7, roleName: null, roleLabel: null, roles: [], isAdmin: u.isAdmin === true,
      roleTierCode: u.tier, salespersonKey: u.salespersonKey ?? null, companyScope: 'ALL', jti: 'j',
    } as express.Request['user'];
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

let currentUser = '';
vi.mock('../../services/dataScopeService', () => ({
  getRoleDataScopeRules: async () => USERS[currentUser]?.rules ?? [],
}));

const queries: { sql: string; params: unknown[] }[] = [];
vi.mock('../../db/pool', () => ({
  pool: {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (/MAX\(SnapshotDateKey\) AS k/.test(sql) || /MIN\(SnapshotDateKey\) AS k/.test(sql)) return [[{ k: 20261004 }], []];
      if (/SELECT 1 AS ok/.test(sql)) return [[{ ok: 1 }], []];
      if (/FROM cfg_finance_aging_zone/.test(sql)) {
        return [[
          { zone_key: 'green', label_en: 'Green', upper_multiplier: '1.000', owner_en: 'Sales rep', action_en: 'a' },
          { zone_key: 'black', label_en: 'Black', upper_multiplier: null, owner_en: 'Legal', action_en: 'b' },
        ], []];
      }
      if (/GROUP BY SnapshotDateKey ORDER BY SnapshotDateKey/.test(sql)) return [[{ k: 20261004, n: 1 }], []];
      return [[], []];
    },
  },
}));

vi.mock('../../measures/departmentFreshness', () => ({
  fetchDepartmentFreshness: async () => ({
    department: 'finance', lastSuccessUtc: '2026-10-04T04:30:00.000Z', lastSuccessJob: 'finance_receivables',
    lastFailureUtc: '2026-10-04T05:00:00.000Z', lastFailureJob: 'finance_receivables', dataAsOf: '2026-10-04',
  }),
}));

let server: Server;
let base = '';
type Res = Omit<Response, 'json'> & { json(): Promise<any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
const get = (path: string, who: string): Promise<Res> => {
  currentUser = who;
  return fetch(`${base}${path}`, { headers: { 'x-test-user': who } }) as Promise<Res>;
};

beforeAll(async () => {
  const { debtReportRouter } = await import('../debtReport');
  const app = express();
  app.use('/debt-report', debtReportRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  queries.length = 0;
});

const ENDPOINTS = ['/meta', '/overview', '/trend', '/customers', '/drilldown?kind=customer&key=100&currency=LYD', '/aging?currency=LYD&term=4'];

describe('Debt Report access', () => {
  it.each(ENDPOINTS)('%s: 200 for the full-access roles (Admin implicitly, GCFO by grant)', async (path) => {
    expect((await get(`/debt-report${path}`, 'admin')).status).toBe(200);
    expect((await get(`/debt-report${path}`, 'gcfo')).status).toBe(200);
  });

  it.each(ENDPOINTS)('%s: 403 for a salesperson while the role is not enabled', async (path) => {
    const res = await get(`/debt-report${path}`, 'salesperson');
    expect(res.status).toBe(403);
    expect(queries).toHaveLength(0); // refused before any query
  });

  it.each(ENDPOINTS)("%s: once enabled, every query is locked to the salesperson's own SalespersonKey", async (path) => {
    const res = await get(`/debt-report${path}`, 'salespersonEnabled');
    expect(res.status).toBe(200);
    const lineQueries = queries.filter((q) => q.sql.includes('FROM fact_finance_receivable_snapshot f'));
    expect(lineQueries.length).toBeGreaterThan(0);
    for (const q of lineQueries) {
      // every pass over the receivable lines carries the lock, before the tiers and every aggregation
      expect(q.sql).toContain('f.SalespersonKey IN (?)');
      expect(q.params).toContain(49);
    }
  });

  it("refuses a salesperson asking for another salesperson's customers (403, no query)", async () => {
    const res = await get('/debt-report/customers?salespersonKeys=60', 'salespersonEnabled');
    expect(res.status).toBe(403);
    expect(queries.filter((q) => q.sql.includes('fact_finance_receivable_snapshot f'))).toHaveLength(0);
  });

  it.each(ENDPOINTS)('%s: every pass over the lines leaves out the excluded segments and teams, whatever is asked', async (path) => {
    const sep = path.includes('?') ? '&' : '?';
    // both scope toggles on, and the excluded team / segments explicitly requested
    const res = await get(`/debt-report${path}${sep}includeOther=true&includeIntercompany=true&salesTeamKeys=BMH-ALL-00&segmentKeys=3&segmentKeys=4`, 'admin');
    expect(res.status).toBe(200);
    const lineQueries = queries.filter((q) => q.sql.includes('FROM fact_finance_receivable_snapshot f'));
    expect(lineQueries.length).toBeGreaterThan(0);
    for (const q of lineQueries) expect(q.sql).toContain(EXCLUDED_TEAMS_CONDITION);
  });

  it("keeps a role's data scope (B2B Director: segment 1) on every query", async () => {
    await get('/debt-report/overview', 'b2b');
    const lineQueries = queries.filter((q) => q.sql.includes('FROM fact_finance_receivable_snapshot f'));
    expect(lineQueries.length).toBeGreaterThan(0);
    for (const q of lineQueries) expect(q.sql).toContain('st.SegmentKey IN (?)');
    expect((await get('/debt-report/overview?segmentKeys=2', 'b2b')).status).toBe(403);
  });

  it('400 on a bad parameter, 400 on an incomplete drill-down', async () => {
    expect((await get('/debt-report/overview?overdueStatus=late', 'gcfo')).status).toBe(400);
    expect((await get('/debt-report/drilldown', 'gcfo')).status).toBe(400);
    expect((await get('/debt-report/drilldown?kind=aging&key=5&currency=DOLLARS', 'gcfo')).status).toBe(400);
    expect((await get('/debt-report/drilldown?kind=team&key=a%27b&currency=LYD', 'gcfo')).status).toBe(400);
    expect((await get('/debt-report/aging?currency=LYDX', 'gcfo')).status).toBe(400);
    expect((await get('/debt-report/aging?term=x', 'gcfo')).status).toBe(400);
  });

  it('the escalation chart ignores the line-level page filters (they would change which invoice decides)', async () => {
    const res = await get('/debt-report/aging?overdueStatus=overdue&agingBucketKeys=3&deliveryStatuses=full&paymentTermKeys=4&customerCategories=B', 'gcfo');
    expect(res.status).toBe(200);
    const q = queries.find((x) => x.sql.includes("WHERE x.line_kind = 'invoice'"));
    expect(q).toBeTruthy();
    expect(q!.sql).not.toMatch(/l\.days_past_due > 0|l\.AgingBucketKey IN|l\.delivery_status IN|l\.PaymentTermKey IN/);
    expect(q!.sql).toContain('l.customer_category IN (?)'); // a customer-level filter still applies
    expect(q!.params).toContain('B');
  });

  it('meta carries the finance freshness, never the sales refresh', async () => {
    const body = await (await get('/debt-report/meta', 'gcfo')).json();
    expect(body.freshness.department).toBe('finance');
    expect(body.options.sizeTiers.map((t: { value: string }) => t.value)).toEqual(['large', 'medium', 'small']);
  });

  it('meta: the Admin role gets the data context (report exclusions, failed finance run)', async () => {
    const body = await (await get('/debt-report/meta', 'admin')).json();
    expect(body.exclusions).toMatchObject({ segments: expect.any(Array), salesTeams: expect.any(Array) });
    expect(body.freshness).toMatchObject({ lastSuccessUtc: '2026-10-04T04:30:00.000Z', lastFailureUtc: '2026-10-04T05:00:00.000Z', lastFailureJob: 'finance_receivables' });
  });

  it.each(['gcfo', 'b2b', 'salespersonEnabled'])('meta: %s (not Admin) never receives the admin-only fields, only the refresh time', async (who) => {
    const res = await get('/debt-report/meta', who);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).not.toHaveProperty('exclusions');
    expect(body.freshness).not.toHaveProperty('lastFailureUtc');
    expect(body.freshness).not.toHaveProperty('lastFailureJob');
    expect(body.freshness.lastSuccessUtc).toBe('2026-10-04T04:30:00.000Z');
    expect(body.snapshotDate).toBeTruthy(); // the page still needs it (Date filter, header band)
  });

  it('every number still leaves out the report exclusions for a non-admin', async () => {
    await get('/debt-report/overview', 'gcfo');
    expect(queries.some((q) => q.sql.includes(EXCLUDED_TEAMS_CONDITION))).toBe(true);
  });
});
