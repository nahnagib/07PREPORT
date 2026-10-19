import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * NPS Score against a REAL warehouse (read-only: SELECT only). Opt-in, after migration 0046 and one process_nps run:
 *
 *   npx vitest run -c vitest.nps-db.config.ts      (DB_* in the environment, e.g. the local powerBI_Data)
 *
 * The real router, scope middleware and pool; only the user is faked. Every expectation is computed here with its own
 * SQL on the fact, independently of measures/npsScore.ts:
 *   - the overview = the fact's counts per group over the range; NPS and CSAT from those counts;
 *   - the daily / monthly / yearly trend adds up to the overview, and each period's NPS is its own counts;
 *   - every filter = the same condition on the fact; the detractor list = the level-1 responses;
 *   - a salesperson (page enabled) sees exactly their own responses.
 */
const RUN = process.env.NPS_TEST_DB === '1';

type Grant = [string, string];
const USERS: Record<string, { isAdmin?: boolean; tier: string; salespersonKey?: number | null; grants: Grant[] }> = {
  admin: { isAdmin: true, tier: 'BI00_EXECUTIVE', grants: [] },
  salespersonEnabled: { tier: 'SALESPERSON', salespersonKey: null, grants: [['nps_score', 'view']] },
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
const get = async (path: string, who = 'admin'): Promise<{ status: number; body: Json }> => {
  const res = await fetch(`${base}${path}`, { headers: { 'x-test-user': who } });
  return { status: res.status, body: await res.json() };
};
const qa = async (sql: string, params: unknown[] = []): Promise<Json[]> => (await pool.query(sql, params))[0] as Json[];
const n = (v: unknown) => Number(v ?? 0);
const RANGE = 'dateFrom=2020-01-01&dateTo=2030-12-31';

async function factCounts(where = '1 = 1', params: unknown[] = []) {
  const [r] = await qa(
    `SELECT SUM(nps_level = 3) AS p, SUM(nps_level = 2) AS m, SUM(nps_level = 1) AS d FROM fact_process_nps_response WHERE ${where}`,
    params);
  const c = { promoters: n(r.p), passives: n(r.m), detractors: n(r.d) };
  return { ...c, responders: c.promoters + c.passives + c.detractors };
}
const sum = (rows: Json[], k: string) => rows.reduce((s, r) => s + n(r[k]), 0);
/** NPS and CSAT written here independently of measures/npsScore.ts */
const nps = (c: { promoters: number; detractors: number; responders: number }) => (100 * c.promoters) / c.responders - (100 * c.detractors) / c.responders;
const csat = (c: { promoters: number; passives: number; responders: number }) => (100 * (c.promoters + c.passives)) / c.responders;

describe.skipIf(!RUN)('NPS Score on the real warehouse (read-only)', () => {
  beforeAll(async () => {
    ({ pool } = await import('../../db/pool'));
    const { npsScoreRouter } = await import('../npsScore');
    const app = express();
    app.use('/nps-score', npsScoreRouter);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const [s] = await qa('SELECT SalespersonKey AS k FROM fact_process_nps_response WHERE SalespersonKey <> -1 GROUP BY SalespersonKey ORDER BY COUNT(*) DESC LIMIT 1');
    USERS.salespersonEnabled.salespersonKey = s ? n(s.k) : null;
  });
  afterAll(async () => {
    server?.close();
    await pool?.end();
  });

  it('there is data to check (run process_nps first)', async () => {
    expect((await factCounts()).responders).toBeGreaterThan(0);
  });

  it('overview = the fact counts; NPS and CSAT from those counts', async () => {
    const want = await factCounts();
    const { status, body } = await get(`/nps-score/overview?${RANGE}`);
    expect(status).toBe(200);
    expect(body.totals).toMatchObject(want);
    expect(body.totals.nps).toBeCloseTo(nps(want), 9);
    expect(body.totals.csat).toBeCloseTo(csat(want), 9);
  });

  it.each(['day', 'month', 'year'])('the %s trend adds up to the overview, and each period is its own counts', async (grain) => {
    const want = await factCounts();
    const { status, body } = await get(`/nps-score/trend?dateFrom=2026-01-01&dateTo=2026-12-31&grain=${grain}`);
    expect(status).toBe(200);
    for (const k of ['promoters', 'passives', 'detractors', 'responders']) expect(sum(body.points, k), k).toBe(want[k as keyof typeof want]);
    for (const p of body.points.filter((x: Json) => x.responders > 0)) expect(p.nps).toBeCloseTo(nps(p), 9);
  });

  it('every filter = the same condition on the fact', async () => {
    const [c] = await qa('SELECT CompanyKey AS k FROM fact_process_nps_response GROUP BY CompanyKey ORDER BY COUNT(*) DESC LIMIT 1');
    const { body } = await get(`/nps-score/overview?${RANGE}&companyKeys=${c.k}`);
    expect(body.totals).toMatchObject(await factCounts('CompanyKey = ?', [c.k]));
    const [d] = await qa('SELECT MIN(rating_date) AS f, MAX(rating_date) AS t FROM v_process_nps_response');
    const mid = new Date((new Date(d.f).getTime() + new Date(d.t).getTime()) / 2).toISOString().slice(0, 10);
    const { body: half } = await get(`/nps-score/overview?dateFrom=2020-01-01&dateTo=${mid}`);
    expect(half.totals).toMatchObject(await factCounts('RatingDateKey <= ?', [Number(mid.replace(/-/g, ''))]));
  });

  it('the detractor list = the level-1 responses, newest first', async () => {
    const want = (await factCounts()).detractors;
    const { body } = await get(`/nps-score/detractors?${RANGE}&pageSize=500`);
    expect(body.total).toBe(want);
    expect(body.rows).toHaveLength(Math.min(want, 500));
    const at = body.rows.map((r: Json) => r.ratedAt);
    expect([...at].sort().reverse()).toEqual(at);
  });

  it('a salesperson sees exactly their own responses', async () => {
    const key = USERS.salespersonEnabled.salespersonKey;
    expect(key).not.toBeNull();
    const { status, body } = await get(`/nps-score/overview?${RANGE}`, 'salespersonEnabled');
    expect(status).toBe(200);
    expect(body.totals).toMatchObject(await factCounts('SalespersonKey = ?', [key]));
  });

  it('reach is waiting before the first load; its aggregate SQL agrees with the message fact', async () => {
    const { fetchNpsReach, parseNpsQuery } = await import('../../measures/npsScore');
    const { status, body } = await get(`/nps-score/reach?${RANGE}`);
    expect(status).toBe(200);
    const loaded = await qa('SELECT loaded_at_utc FROM process_nps_reach_state WHERE singleton_id = 1');
    if (!loaded.length) expect(body).toMatchObject({ status: 'waiting', totals: null, errors: [] });
    // Exercise real MySQL aggregation even before real message data arrives, without writing a readiness marker.
    const queryPool = {
      query: (sql: string, params: unknown[]) => sql.includes('FROM process_nps_reach_state')
        ? Promise.resolve([[{ loaded_at_utc: '2026-10-18 00:00:00' }], []]) : pool.query(sql, params),
    } as unknown as typeof pool;
    const reach = await fetchNpsReach(queryPool, parseNpsQuery({ dateFrom: '2020-01-01', dateTo: '2030-12-31' }), {}, { roleCode: 'BI00_EXECUTIVE' });
    const [want] = await qa(`SELECT COUNT(*) AS total, SUM(box = 'delivered') AS delivered, SUM(box = 'read') AS read_count,
      SUM(box = 'not_delivered') AS not_delivered, SUM(box = 'error') AS error_count, SUM(box = 'other') AS other_state
      FROM fact_process_nps_message WHERE in_reach_scope = 1 AND MessageDateKey BETWEEN 20200101 AND 20301231`);
    expect(reach.totals).toEqual({ totalReach: n(want.total), delivered: n(want.delivered), read: n(want.read_count),
      notDelivered: n(want.not_delivered), error: n(want.error_count), otherState: n(want.other_state) });
    expect(reach.errors.reduce((sum, e) => sum + e.count, 0)).toBe(n(want.error_count));
  });

  it('reach API = the message fact for each company and date filter (after a message load)', async () => {
    const loaded = await qa('SELECT reach_start FROM process_nps_reach_state WHERE singleton_id = 1');
    if (!loaded.length) return;
    const [d] = await qa('SELECT MIN(MessageDateKey) AS f, MAX(MessageDateKey) AS t FROM fact_process_nps_message WHERE in_reach_scope = 1');
    const iso = (k: number) => `${String(k).slice(0, 4)}-${String(k).slice(4, 6)}-${String(k).slice(6, 8)}`;
    const weekBefore = new Date(Date.parse(`${iso(n(d.t))}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
    const ranges: [string, string][] = [['2020-01-01', '2030-12-31'], [weekBefore, iso(n(d.t))], [iso(n(d.f)), iso(n(d.f))]];
    for (const company of [null, 1, 3]) {
      for (const [from, to] of ranges) {
        const where = `in_reach_scope = 1 AND MessageDateKey BETWEEN ? AND ?${company ? ' AND CompanyKey = ?' : ''}`;
        const params = [Number(from.replace(/-/g, '')), Number(to.replace(/-/g, '')), ...(company ? [company] : [])];
        const [want] = await qa(`SELECT COUNT(*) AS total, SUM(box = 'delivered') AS delivered, SUM(box = 'read') AS read_count,
          SUM(box = 'not_delivered') AS not_delivered, SUM(box = 'error') AS error_count, SUM(box = 'other') AS other_state
          FROM fact_process_nps_message WHERE ${where}`, params);
        const groups = await qa(`SELECT failure_group, COUNT(*) AS c FROM fact_process_nps_message WHERE ${where} AND box = 'error'
          GROUP BY failure_group`, params);
        const { status, body } = await get(`/nps-score/reach?dateFrom=${from}&dateTo=${to}${company ? `&companyKeys=${company}` : ''}`);
        expect(status).toBe(200);
        expect(body.reachStart).toBe(loaded[0].reach_start ? new Date(loaded[0].reach_start).toISOString().slice(0, 10) : null);
        expect(body.totals, `${company} ${from}..${to}`).toEqual({ totalReach: n(want.total), delivered: n(want.delivered),
          read: n(want.read_count), notDelivered: n(want.not_delivered), error: n(want.error_count), otherState: n(want.other_state) });
        expect(Object.fromEntries(body.errors.map((e: Json) => [e.key, e.count])))
          .toEqual(Object.fromEntries(groups.map((g: Json) => [g.failure_group, n(g.c)])));
      }
    }
  });
});
