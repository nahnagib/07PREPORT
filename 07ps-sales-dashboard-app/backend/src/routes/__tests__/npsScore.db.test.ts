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
 *   - the weekly / monthly / yearly trend adds up to the overview, and each period's NPS is its own counts;
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

/**
 * The reach of a period in plain SQL + JS, independently of the views and of measures/npsReachCounts.ts: the message
 * fact in scope on the days no manual period covers, plus each process_nps_reach_manual row spread evenly over its days
 * (day i of n gets floor(v*i/n) - floor(v*(i-1)/n)); 13-31 Aug (meta_manual+estimate): Delivered / Read = estimate.
 */
type Boxes = { totalReach: number; delivered: number; notDelivered: number; read: number; error: number; otherState: number };
const zero = (): Boxes => ({ totalReach: 0, delivered: 0, notDelivered: 0, read: 0, error: 0, otherState: 0 });
const isoDay = (iso: string, d: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
const dayKey = (iso: string) => Number(iso.replace(/-/g, ''));
async function plainReach(from: string, to: string, company: number | null) {
  const c = company ? ' AND m.CompanyKey = ?' : '';
  const p = company ? [company] : [];
  const [etl] = await qa(`SELECT COUNT(*) AS total, SUM(m.box = 'delivered') AS d, SUM(m.box = 'read') AS r, SUM(m.box = 'not_delivered') AS nd,
      SUM(m.box = 'error') AS e, SUM(m.box = 'other') AS o FROM fact_process_nps_message m
    WHERE m.in_reach_scope = 1 AND m.MessageDateKey BETWEEN ? AND ?${c}
      AND NOT EXISTS (SELECT 1 FROM process_nps_reach_manual r WHERE r.CompanyKey = m.CompanyKey
        AND m.MessageDateKey BETWEEN DATE_FORMAT(r.date_from, '%Y%m%d') + 0 AND DATE_FORMAT(r.date_to, '%Y%m%d') + 0)`, [dayKey(from), dayKey(to), ...p]);
  const etlGroups = await qa(`SELECT m.failure_group AS g, COUNT(*) AS n FROM fact_process_nps_message m
    WHERE m.in_reach_scope = 1 AND m.box = 'error' AND m.MessageDateKey BETWEEN ? AND ?${c}
      AND NOT EXISTS (SELECT 1 FROM process_nps_reach_manual r WHERE r.CompanyKey = m.CompanyKey
        AND m.MessageDateKey BETWEEN DATE_FORMAT(r.date_from, '%Y%m%d') + 0 AND DATE_FORMAT(r.date_to, '%Y%m%d') + 0)
    GROUP BY m.failure_group`, [dayKey(from), dayKey(to), ...p]);
  const bySource = { etl: { totalReach: n(etl.total), delivered: n(etl.d), notDelivered: n(etl.nd), read: n(etl.r), error: n(etl.e), otherState: n(etl.o) },
    manual: zero(), estimate: zero() };
  const manualRows = await qa(`SELECT DATE_FORMAT(date_from, '%Y-%m-%d') AS f, DATE_FORMAT(date_to, '%Y-%m-%d') AS t, source, delivered, not_delivered,
      read_count, error_count FROM process_nps_reach_manual m WHERE 1 = 1${c}`, p);
  let firstManual: string | null = null;
  for (const row of manualRows) {
    if (!firstManual || row.f < firstManual) firstManual = row.f;
    const days = Math.round((Date.parse(`${row.t}T12:00:00Z`) - Date.parse(`${row.f}T12:00:00Z`)) / 86_400_000) + 1;
    const share = (v: number, i: number) => Math.floor((v * i) / days) - Math.floor((v * (i - 1)) / days);
    for (let i = 1; i <= days; i++) {
      const day = isoDay(row.f, i - 1);
      if (day < from || day > to) continue;
      const dr = { d: share(n(row.delivered), i), r: share(n(row.read_count), i), nd: share(n(row.not_delivered), i), e: share(n(row.error_count), i) };
      const dSrc = row.source === 'meta_manual' ? bySource.manual : bySource.estimate;
      const restSrc = row.source === 'estimate' ? bySource.estimate : bySource.manual;
      dSrc.delivered += dr.d; dSrc.read += dr.r; dSrc.totalReach += dr.d + dr.r;
      restSrc.notDelivered += dr.nd; restSrc.error += dr.e; restSrc.totalReach += dr.nd + dr.e;
    }
  }
  const totals = zero();
  for (const s of Object.values(bySource)) for (const k of Object.keys(totals) as (keyof Boxes)[]) totals[k] += s[k];
  const groups: Record<string, number> = Object.fromEntries(etlGroups.map((g: Json) => [g.g, n(g.n)]));
  const manualErrors = bySource.manual.error + bySource.estimate.error;
  if (manualErrors > 0) groups.meta_manual = (groups.meta_manual ?? 0) + manualErrors;
  const [firstEtl] = await qa(`SELECT MIN(m.MessageDateKey) AS f FROM fact_process_nps_message m WHERE m.in_reach_scope = 1${c}`, p);
  const etlFirst = firstEtl?.f ? String(firstEtl.f).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') : null;
  const first = [firstManual, etlFirst].filter((x): x is string => !!x).sort()[0] ?? null;
  return { totals, bySource, groups, first };
}

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

  it.each(['week', 'month', 'year'])('the %s trend adds up to the overview, and each period is its own counts', async (grain) => {
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

  it('reach is waiting before the first load; its aggregate SQL agrees with plain SQL on the fact + the manual reach', async () => {
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
    const want = await plainReach('2020-01-01', '2030-12-31', null);
    expect(reach.totals).toEqual(want.totals);
    expect(reach.bySource).toEqual(want.bySource);
    expect(reach.errors.reduce((s, e) => s + e.count, 0)).toBe(want.totals.error);
  });

  it('the manual reach (migration 0071): the approved rows, each spread over its days to the exact row total, no ETL row under it', async () => {
    const rows = await qa(`SELECT CompanyKey AS k, DATE_FORMAT(date_from, '%Y-%m-%d') AS f, delivered, not_delivered, read_count, error_count, total_reach
      FROM process_nps_reach_manual ORDER BY CompanyKey, date_from`);
    expect(rows.length, 'migration 0071 seeds 8 rows').toBe(8);
    const all = { d: sum(rows, 'delivered'), nd: sum(rows, 'not_delivered'), r: sum(rows, 'read_count'), e: sum(rows, 'error_count'), t: sum(rows, 'total_reach') };
    expect(all).toEqual({ d: 730, nd: 26, r: 1524, e: 482, t: 2762 }); // the CSV of 2026-11-11
    for (const row of rows) {
      const [spread] = await qa(`SELECT SUM(d.delivered) AS d, SUM(d.not_delivered) AS nd, SUM(d.read_count) AS r, SUM(d.error_count) AS e, COUNT(*) AS days,
          MAX(d.delivered) - MIN(d.delivered) AS dd FROM v_process_nps_reach_manual_daily d
        JOIN process_nps_reach_manual m ON m.CompanyKey = d.CompanyKey AND d.MessageDateKey BETWEEN DATE_FORMAT(m.date_from, '%Y%m%d') + 0 AND DATE_FORMAT(m.date_to, '%Y%m%d') + 0
        WHERE m.CompanyKey = ? AND m.date_from = ?`, [row.k, row.f]);
      expect([n(spread.d), n(spread.nd), n(spread.r), n(spread.e)], `${row.k} ${row.f}`).toEqual([n(row.delivered), n(row.not_delivered), n(row.read_count), n(row.error_count)]);
      expect(n(spread.dd), 'even: every day floor or ceil').toBeLessThanOrEqual(1);
    }
    const [under] = await qa(`SELECT COUNT(*) AS n FROM v_process_nps_reach v WHERE v.source = 'etl' AND EXISTS (SELECT 1 FROM process_nps_reach_manual m
      WHERE m.CompanyKey = v.CompanyKey AND v.MessageDateKey BETWEEN DATE_FORMAT(m.date_from, '%Y%m%d') + 0 AND DATE_FORMAT(m.date_to, '%Y%m%d') + 0)`);
    expect(n(under.n)).toBe(0);
    // the cards of 12 Jul – 02 Oct = the CSV exactly
    const { body } = await get('/nps-score/reach?dateFrom=2026-07-12&dateTo=2026-10-02');
    if (body.status === 'ready') {
      expect(body).toMatchObject({ includesManual: true, totals: { delivered: 730, notDelivered: 26, read: 1524, error: 482, totalReach: 2762, otherState: 0 } });
      expect(body.errors).toEqual([expect.objectContaining({ key: 'meta_manual', label: 'Unclassified (Meta manual)', count: 482 })]);
    }
  });

  it('reach API = plain SQL for each company and date filter, inside and outside the manual range', async () => {
    const loaded = await qa('SELECT reach_start FROM process_nps_reach_state WHERE singleton_id = 1');
    if (!loaded.length) return;
    const [d] = await qa('SELECT MIN(MessageDateKey) AS f, MAX(MessageDateKey) AS t FROM fact_process_nps_message WHERE in_reach_scope = 1');
    const iso = (k: number) => `${String(k).slice(0, 4)}-${String(k).slice(4, 6)}-${String(k).slice(6, 8)}`;
    const weekBefore = new Date(Date.parse(`${iso(n(d.t))}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
    const ranges: [string, string][] = [['2020-01-01', '2030-12-31'], [weekBefore, iso(n(d.t))], [iso(n(d.f)), iso(n(d.f))],
      ['2026-07-12', '2026-10-02'], ['2026-09-01', '2026-09-30'], ['2026-08-20', '2026-08-25'], ['2026-09-28', '2026-10-05']];
    for (const company of [null, 1, 3]) {
      for (const [from, to] of ranges) {
        const want = await plainReach(from, to, company);
        const { status, body } = await get(`/nps-score/reach?dateFrom=${from}&dateTo=${to}${company ? `&companyKeys=${company}` : ''}`);
        expect(status).toBe(200);
        expect(body.reachStart).toBe(loaded[0].reach_start ? new Date(loaded[0].reach_start).toISOString().slice(0, 10) : null);
        expect(body.totals, `${company} ${from}..${to}`).toEqual(want.totals);
        expect(body.bySource, `${company} ${from}..${to}`).toEqual(want.bySource);
        expect(body.includesManual).toBe(want.bySource.manual.totalReach + want.bySource.estimate.totalReach > 0);
        expect(Object.fromEntries(body.errors.map((e: Json) => [e.key, e.count])), `${company} ${from}..${to}`).toEqual(want.groups);
      }
    }
  });
});

describe.skipIf(!RUN)('NPS page consistency, YTD, default B2B + B2C filter and all filters cleared (real warehouse)', () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tripoli', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const ytd = `dateFrom=${today.slice(0, 4)}-01-01&dateTo=${today}`;
  const key = (iso: string) => Number(iso.replace(/-/g, ''));

  it.each([['default B2B + B2C', '&segmentKeys=1&segmentKeys=2'], ['all filters cleared', '']])('%s: every visual agrees', async (_label, filters) => {
    const q = `${ytd}${filters}`;
    const o = (await get(`/nps-score/overview?${q}`)).body.totals;
    // responders box = tachometer denominator = sum of the trend bars; P + Pa + D = R; satisfied + D = R
    expect(o.promoters + o.passives + o.detractors).toBe(o.responders);
    expect(o.promoters + o.passives + o.detractors - o.detractors).toBe(o.promoters + o.passives);
    expect(o.nps).toBeCloseTo((100 * o.promoters) / o.responders - (100 * o.detractors) / o.responders, 9);
    for (const grain of ['week', 'month', 'year']) {
      const t = (await get(`/nps-score/trend?${q}&grain=${grain}`)).body;
      expect(sum(t.points, 'responders'), grain).toBe(o.responders);
      expect(t.points[0]?.responders ?? 0, `${grain} starts at the first period with ratings`).toBeGreaterThan(0);
    }
    // Detractors box = detractor list = follow-up cases (+ Historical shown apart)
    const list = (await get(`/nps-score/detractors?${q}&pageSize=500`)).body;
    const fu = (await get(`/nps-score/followup-summary?${q}`)).body;
    expect(list.total).toBe(o.detractors);
    expect(fu.detractors).toBe(o.detractors);
    // one total for every follow-up chart: the cases with a status (Rejected included); Historical apart
    expect(fu.charted + fu.historical + fu.noCase).toBe(o.detractors);
    // by status: every case but Historical (and the detractors without a case yet)
    expect(sum(fu.byStatus, 'count')).toBe(fu.charted);
    expect(sum(fu.ageing.buckets, 'resolved') + sum(fu.ageing.buckets, 'open')).toBe(fu.charted - fu.rejected);
    expect(sum(fu.byReason, 'count')).toBe(fu.charted);
    const [hist] = await qa(`SELECT COUNT(*) AS n FROM nps_followup_case c JOIN fact_process_nps_response f ON f.response_id = c.response_id
      WHERE c.stage = 'HISTORICAL' AND f.nps_level = 1 AND f.RatingDateKey BETWEEN ? AND ?${filters ? ' AND f.SegmentKey IN (1, 2)' : ''}`,
    [key(`${today.slice(0, 4)}-01-01`), key(today)]);
    expect(fu.historical).toBe(n(hist.n));
    // the reach boxes add up; errors by reason = the Error box
    const r = (await get(`/nps-score/reach?${q}`)).body;
    if (r.status === 'ready') {
      const t = r.totals;
      expect(t.delivered + t.read + t.notDelivered + t.error + t.otherState).toBe(t.totalReach);
      expect(t.otherState).toBe(0);
      expect(sum(r.errors, 'count')).toBe(t.error);
    }
  });

  it('response rate and Survey Reach = plain SQL: every responder from the first reach day / Delivered + Read of every source; cards Delivered + Read = the rate denominator', async () => {
    const [state] = await qa(`SELECT DATE_FORMAT(reach_start, '%Y-%m-%d') AS reach_start FROM process_nps_reach_state WHERE singleton_id = 1`);
    if (!state) return;
    const start = String(state.reach_start);
    const ranges: [string, string][] = [[`${today.slice(0, 4)}-01-01`, today], ['2026-07-12', '2026-10-02'], ['2026-09-01', '2026-09-30'], [start, today]];
    for (const company of [null, 1, 3]) {
      for (const [from, to] of ranges) {
        const want = await plainReach(from, to, company);
        const counted = want.first && want.first > from ? want.first : from;
        const [ratings] = await qa(`SELECT COUNT(*) AS n FROM fact_process_nps_response WHERE RatingDateKey BETWEEN ? AND ?${company ? ' AND CompanyKey = ?' : ''}`,
          [key(counted), key(to), ...(company ? [company] : [])]);
        const q = `dateFrom=${from}&dateTo=${to}&segmentKeys=1&segmentKeys=2${company ? `&companyKeys=${company}` : ''}`;
        const body = (await get(`/nps-score/response-rate?${q}`)).body;
        const reach = (await get(`/nps-score/reach?${q}`)).body;
        const reached = want.totals.delivered + want.totals.read;
        const label = `${company} ${from}..${to}`;
        expect(body, label).toMatchObject({ status: 'ready', requestedDateFrom: from, dateFrom: counted, companyAndDateOnly: true,
          responders: n(ratings.n), delivered: want.totals.delivered, read: want.totals.read, reached, totalReach: want.totals.totalReach,
          reachedBySource: {
            etl: want.bySource.etl.delivered + want.bySource.etl.read,
            manual: want.bySource.manual.delivered + want.bySource.manual.read,
            estimate: want.bySource.estimate.delivered + want.bySource.estimate.read,
          } });
        if (reached > 0) expect(body.rate, label).toBeCloseTo((100 * n(ratings.n)) / reached, 9);
        // Rate of reach = Responders ÷ Total Reach (every state); never above the Response Rate or 100 %
        if (want.totals.totalReach > 0) {
          expect(body.rateOfReach, label).toBeCloseTo(Math.min((100 * n(ratings.n)) / want.totals.totalReach, 100), 9);
          expect(body.rateOfReach, label).toBeLessThanOrEqual(body.rate);
          expect(body.rateOfReach, label).toBeLessThanOrEqual(100);
        }
        expect(sum(body.weekly, 'reached'), label).toBe(reached);
        expect(sum(body.weekly, 'responders'), label).toBe(n(ratings.n));
        // the cards: the same read
        expect(reach.totals.delivered + reach.totals.read, label).toBe(body.reached);
        expect(reach.totals.totalReach, label).toBe(body.totalReach);
        expect(sum(reach.errors, 'count'), label).toBe(reach.totals.error);
      }
    }
  });
});

// one server and one pool for both blocks, closed after the last test
afterAll(async () => {
  server?.close();
  await pool?.end();
});
