import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * NPS Score access over real HTTP: the real router, permission and scope middleware; the user, their grants / data
 * scope and the database are faked. The SQL of each request is recorded, so the test sees the scope reach every query.
 */

type Grant = [pageKey: string, action: string];
interface TestUser {
  isAdmin?: boolean;
  tier: string;
  salespersonKey?: number | null;
  grants: Grant[];
  rules?: { dimension: string; value: string }[];
}
const PAGE: Grant[] = [['nps_score', 'view'], ['nps_score', 'export']];
const USERS: Record<string, TestUser> = {
  admin: { isAdmin: true, tier: 'BI00_EXECUTIVE', grants: [] },
  viewer: { tier: 'BI00_EXECUTIVE', grants: PAGE },
  commentReader: { tier: 'BI00_EXECUTIVE', grants: [...PAGE, ['nps_comments', 'view']] },
  b2b: { tier: 'BI01_DIRECTOR_B2B', grants: PAGE, rules: [{ dimension: 'segmentKeys', value: '1' }] },
  company: { tier: 'BI00_EXECUTIVE', grants: PAGE, rules: [{ dimension: 'companyKeys', value: '3' }] },
  salesperson: { tier: 'SALESPERSON', salespersonKey: 49, grants: [['tachometer', 'view']] },
  salespersonEnabled: { tier: 'SALESPERSON', salespersonKey: 49, grants: [['tachometer', 'view'], ['nps_score', 'view']] },
  // comments alone, without the page: still nothing
  commentsOnly: { tier: 'BI00_EXECUTIVE', grants: [['nps_comments', 'view']] },
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
let reachLoaded = false;
vi.mock('../../db/pool', () => ({
  pool: {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (/FROM process_nps_reach_state/.test(sql)) return [reachLoaded ? [{ loaded_at_utc: '2026-10-18 10:00:00', reach_start: new Date('2026-10-03T00:00:00Z') }] : [], []];
      if (/FROM v_process_nps_reach /.test(sql)) return [[{ total_reach: '12', delivered: '3', not_delivered: '2', read_count: '4', error_count: '2', other_state: '1' }], []];
      if (/FROM v_process_nps_message_error /.test(sql)) return [[{ failure_group: 'phone_format', label_en: 'Phone format', is_fixable: 1, hint: 'Correct the number.', errors: '2' }], []];
      if (/COUNT\(\*\) AS n/.test(sql)) return [[{ n: 0 }], []];
      return [[], []];
    },
  },
}));

vi.mock('../../measures/departmentFreshness', () => ({
  fetchDepartmentFreshness: async (_pool: unknown, department: string) => ({ department, lastSuccessUtc: '2026-10-18T07:55:58.000Z', dataAsOf: null }),
}));

let server: Server;
let base = '';
type Res = Omit<Response, 'json'> & { json(): Promise<any> };
const get = (path: string, who: string): Promise<Res> => {
  currentUser = who;
  return fetch(`${base}${path}`, { headers: { 'x-test-user': who } }) as Promise<Res>;
};

beforeAll(async () => {
  const { npsScoreRouter } = await import('../npsScore');
  const app = express();
  app.use('/nps-score', npsScoreRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  queries.length = 0;
  reachLoaded = false;
});

const npsQueries = () => queries.filter((q) => /FROM v_process_nps_response /.test(q.sql));

describe('NPS Score access', () => {
  it.each(['/meta', '/overview', '/trend', '/reach', '/response-rate', '/followup-summary'])('%s: 200 with the page (Admin implicitly, a role by grant)', async (path) => {
    expect((await get(`/nps-score${path}`, 'admin')).status).toBe(200);
    expect((await get(`/nps-score${path}`, 'viewer')).status).toBe(200);
  });

  it.each(['/meta', '/overview', '/trend', '/detractors', '/reach', '/response-rate', '/followup-summary'])('%s: 403 without the page, before any query', async (path) => {
    for (const who of ['salesperson', 'commentsOnly']) {
      expect((await get(`/nps-score${path}`, who)).status).toBe(403);
    }
    expect(queries).toHaveLength(0);
  });

  it('the detractor list (with comments) needs nps_comments; meta tells the page whether to show it', async () => {
    expect((await get('/nps-score/detractors', 'viewer')).status).toBe(403);
    expect(npsQueries()).toHaveLength(0);
    expect((await get('/nps-score/detractors', 'commentReader')).status).toBe(200);
    expect((await get('/nps-score/detractors', 'admin')).status).toBe(200);
    expect((await (await get('/nps-score/meta', 'viewer')).json()).canSeeDetractors).toBe(false);
    expect((await (await get('/nps-score/meta', 'commentReader')).json()).canSeeDetractors).toBe(true);
  });

  it.each(['/overview', '/trend', '/followup-summary'])("%s: a salesperson's queries are all locked to their own SalespersonKey", async (path) => {
    expect((await get(`/nps-score${path}`, 'salespersonEnabled')).status).toBe(200);
    expect(npsQueries().length).toBeGreaterThan(0);
    for (const q of npsQueries()) {
      expect(q.sql).toContain('f.SalespersonKey IN (?)');
      expect(q.params).toContain(49);
    }
    expect((await get(`/nps-score${path}?salespersonKeys=60`, 'salespersonEnabled')).status).toBe(403);
  });

  it("keeps a role's data scope (B2B Director: segment 1) on every query", async () => {
    await get('/nps-score/overview', 'b2b');
    expect(npsQueries().length).toBeGreaterThan(0);
    for (const q of npsQueries()) expect(q.sql).toContain('salesperson_admin_profile');
    expect((await get('/nps-score/overview?segmentKeys=2', 'b2b')).status).toBe(403);
  });

  it('400 on a bad parameter', async () => {
    expect((await get('/nps-score/overview?dateFrom=2026-02-30', 'viewer')).status).toBe(400);
    expect((await get('/nps-score/trend?grain=day', 'viewer')).status).toBe(400);
    expect((await get('/nps-score/trend?grain=week', 'viewer')).status).toBe(200);
    expect((await get('/nps-score/detractors?pageSize=1000', 'commentReader')).status).toBe(400);
    expect((await get('/nps-score/reach?dateFrom=bad', 'viewer')).status).toBe(400);
  });

  it('meta carries the bands from config/npsThresholds.ts and the process freshness, from warehouse tables only', async () => {
    const body = await (await get('/nps-score/meta', 'viewer')).json();
    expect(body.freshness.department).toBe('process');
    expect(body.minResponders).toBe(5);
    expect(body.thresholds.nps).toMatchObject({ yellowFrom: 50, greenFrom: 90, target: 90 });
    expect(body.thresholds.csat).toMatchObject({ yellowFrom: 85, greenFrom: 95, target: 95 });
    for (const q of queries) expect(q.sql).toMatch(/dim_process_nps_level|v_process_nps_response|raw_nps_sync_state/);
  });
});

describe('WhatsApp reach', () => {
  it('returns waiting without fabricated zeros before a successful message load', async () => {
    const body = await (await get('/nps-score/reach', 'viewer')).json();
    expect(body).toMatchObject({ status: 'waiting', totals: null, errors: [], loadedAt: null, reachStart: null });
    expect(queries).toHaveLength(1);
  });

  it('keeps company/date filters, labels unsupported UI filters, and exposes only aggregate error groups', async () => {
    reachLoaded = true;
    const body = await (await get('/nps-score/reach?dateFrom=2026-10-01&dateTo=2026-10-18&companyKeys=1&segmentKeys=1&segmentKeys=2&salesTeamKeys=9', 'viewer')).json();
    expect(body).toMatchObject({ status: 'ready', companyAndDateOnly: true, reachStart: '2026-10-03',
      totals: { totalReach: 12, delivered: 3, notDelivered: 2, read: 4, error: 2, otherState: 1 },
      errors: [{ key: 'phone_format', fixable: true, count: 2 }] });
    const aggregates = queries.filter((q) => /FROM v_process_nps_/.test(q.sql));
    expect(aggregates).toHaveLength(2);
    for (const q of aggregates) {
      expect(q.params).toEqual([20261001, 20261018, 1]);
      expect(q.sql).toContain('f.CompanyKey IN (?)');
      expect(q.sql).not.toMatch(/SegmentKey|SalesTeamKey|mobile_number|failure_reason/);
    }
  });

  it.each(['b2b', 'salespersonEnabled'])('%s: never broadens mandatory role scope to company totals', async (who) => {
    reachLoaded = true;
    const body = await (await get('/nps-score/reach', who)).json();
    expect(body).toMatchObject({ status: 'restricted', totals: null, errors: [] });
    expect(queries).toHaveLength(0);
  });

  it('honors an enforced company scope and rejects company escapes', async () => {
    reachLoaded = true;
    expect((await (await get('/nps-score/reach', 'company')).json()).status).toBe('ready');
    for (const q of queries.filter((q) => /FROM v_process_nps_/.test(q.sql))) expect(q.params.slice(-1)).toEqual([3]);
    expect((await get('/nps-score/reach?companyKeys=1', 'company')).status).toBe(403);
  });
});

describe('Response rate', () => {
  it('company and date only on both sides, from NPS_REACH_START; the other filters are labelled, never applied', async () => {
    reachLoaded = true;
    const body = await (await get('/nps-score/response-rate?dateFrom=2026-01-01&dateTo=2026-10-18&companyKeys=1&segmentKeys=1&salespersonKeys=49', 'viewer')).json();
    expect(body).toMatchObject({ status: 'ready', dateFrom: '2026-10-03', reachStart: '2026-10-03', companyAndDateOnly: true, target: 30 });
    const data = queries.filter((q) => /FROM v_process_nps_(response|reach) /.test(q.sql));
    expect(data).toHaveLength(2);
    for (const q of data) {
      expect(q.params).toEqual([20261003, 20261018, 1]);
      expect(q.sql).not.toMatch(/SegmentKey|SalespersonKey|salesperson_admin_profile/);
    }
  });

  it.each(['b2b', 'salespersonEnabled'])('%s: no figure for a non-company role scope (never filtered ratings / unfiltered messages)', async (who) => {
    reachLoaded = true;
    expect(await (await get('/nps-score/response-rate', who)).json()).toMatchObject({ status: 'restricted', rate: null });
    expect(queries).toHaveLength(0);
  });
});
