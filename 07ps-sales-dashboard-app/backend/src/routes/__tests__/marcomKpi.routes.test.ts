import '../../marcom/__tests__/helpers/env';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { resetMarcom } from '../../marcom/__tests__/helpers/db';
import { goldenFile, spendFile } from '../../marcom/__tests__/helpers/workbooks';

const RUN_DB = process.env.MARCOM_TEST_DB === '1';

let server: Server;
let base = '';
let pool: typeof import('../../db/pool').pool;
let svc: typeof import('../../marcom/service');
const tokens: Record<string, string> = {};
const ids: Record<string, number> = {};

// The repo's tsconfig has no DOM lib, so Response.json() is `unknown`; tests want loose JSON.
type Res = Omit<Response, 'json'> & { json(): Promise<any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
const get = (path: string, who: string | null): Promise<Res> =>
  fetch(`${base}${path}`, { headers: who ? { Authorization: `Bearer ${tokens[who]}` } : {} }) as Promise<Res>;

async function mkUser(email: string, role: string) {
  const [ex] = (await pool.query('SELECT user_id FROM app_user WHERE email = ?', [email])) as [{ user_id: number }[], unknown];
  if (ex[0]) return ex[0].user_id;
  const [r] = await pool.query(
    `INSERT INTO app_user (email, display_name, role_id, status, must_change_password, password_hash)
     VALUES (?, ?, (SELECT role_id FROM roles WHERE role_name = ?), 'ACTIVE', 0, 'x')`,
    [email, email.split('@')[0], role],
  );
  return (r as { insertId: number }).insertId;
}

async function upload(buf: Buffer) {
  const actor = { id: ids.admin };
  const p = await svc.validateUpload({ buffer: buf, filename: 'k.xlsx', actor });
  return svc.commitUpload({ stagedUploadId: p.stagedUploadId, actor, confirmNewBrands: true });
}

const PAGES = ['spending', 'campaigns', 'digital', 'trade'] as const;

describe.skipIf(!RUN_DB)('/marcom/kpi/* (HTTP, DB-backed)', () => {
  beforeAll(async () => {
    ({ pool } = await import('../../db/pool'));
    svc = await import('../../marcom/service');
    const { issueAccessToken } = await import('../../lib/token');
    const { marcomKpiRouter } = await import('../marcomKpi');
    const { marcomFreshnessRouter } = await import('../marcomUpload');
    for (const [who, role] of [['admin', 'ADMIN'], ['director', 'B2B_DIRECTOR'], ['sales', 'SALESPERSON'], ['trader', 'B2C_DIRECTOR']] as const) {
      ids[who] = await mkUser(`marcom.kpi.${who}@test.local`, role);
      tokens[who] = issueAccessToken(ids[who]).token;
    }
    const app = express();
    app.use('/marcom/kpi', marcomKpiRouter);
    app.use('/marcom/freshness', marcomFreshnessRouter);
    app.use((err: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => {
      console.error('unhandled in test app:', err);
      res.status(500).json({ error: 'Something went wrong.' });
    });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM user_permissions WHERE user_id = ?', [ids.trader]);
    await resetMarcom(pool);
    await new Promise((r) => server?.close(r));
    fs.rmSync(process.env.MARCOM_STAGING_DIR!, { recursive: true, force: true });
    await pool.end();
  });

  beforeEach(async () => {
    await resetMarcom(pool);
    await pool.query('DELETE FROM user_permissions WHERE user_id = ?', [ids.trader]);
  });

  describe('authorization (server-side, every route)', () => {
    it.each(PAGES)('%s -> 401 anonymous, 403 without the page permission, 200 with it', async (page) => {
      expect((await get(`/marcom/kpi/${page}`, null)).status).toBe(401);
      expect((await get(`/marcom/kpi/${page}`, 'sales')).status).toBe(403);
      expect((await get(`/marcom/kpi/${page}`, 'director')).status).toBe(200);
      expect((await get(`/marcom/kpi/${page}`, 'admin')).status).toBe(200);
    });

    it('each route is gated by its OWN page permission (a per-user deny on one page leaves the others open)', async () => {
      await pool.query(
        `INSERT INTO user_permissions (user_id, permission_id, allowed)
         SELECT ?, p.permission_id, FALSE FROM permissions p JOIN pages pg ON pg.page_id = p.page_id
          WHERE pg.page_key = 'marcom_trade' AND p.action = 'view'`,
        [ids.trader],
      );
      expect((await get('/marcom/kpi/trade', 'trader')).status).toBe(403);
      for (const p of ['spending', 'campaigns', 'digital'] as const) expect((await get(`/marcom/kpi/${p}`, 'trader')).status).toBe(200);
    });

    it('a denied view permission is not rescued by the upload permission', async () => {
      // ADMIN holds admin_marcom_upload; deny it the spending view and the KPI route must still refuse.
      await pool.query(
        `INSERT INTO user_permissions (user_id, permission_id, allowed)
         SELECT ?, p.permission_id, FALSE FROM permissions p JOIN pages pg ON pg.page_id = p.page_id
          WHERE pg.page_key = 'marcom_spending' AND p.action = 'view'`,
        [ids.trader],
      );
      await pool.query(
        `INSERT INTO user_permissions (user_id, permission_id, allowed)
         SELECT ?, p.permission_id, TRUE FROM permissions p JOIN pages pg ON pg.page_id = p.page_id
          WHERE pg.page_key = 'admin_marcom_upload' AND p.action = 'view'`,
        [ids.trader],
      );
      expect((await get('/marcom/kpi/spending', 'trader')).status).toBe(403);
    });
  });

  describe('no data at all', () => {
    it.each(PAGES)('%s -> 200, hasData false, complete empty structure, meta.missing includes data', async (page) => {
      const res = await get(`/marcom/kpi/${page}`, 'director');
      expect(res.status).toBe(200);
      const b = await res.json();
      expect(b).toMatchObject({ page, hasData: false, freshness: { hasData: false } });
      expect(b.meta.missing).toContain('data');
      expect(JSON.stringify(b)).not.toMatch(/NaN|Infinity/);
    });
    it('spending also says lastYearData is missing; trade lists all 8 event types; campaigns all 5 media types', async () => {
      const s = await (await get('/marcom/kpi/spending', 'director')).json();
      expect(s.meta.missing).toEqual(['lastYearData', 'data']);
      expect(s.roi.ytd).toMatchObject({ value: null, status: 'na' });
      const t = await (await get('/marcom/kpi/trade?fromMonth=1&toMonth=2', 'director')).json();
      expect(Object.keys(t.eventsByTypeMonthly[0].byType)).toHaveLength(8);
      const c = await (await get('/marcom/kpi/campaigns', 'director')).json();
      expect(c.coverageByType.types).toHaveLength(5);
      expect(c.costByType.types).toHaveLength(5);
    });
  });

  describe('golden values over HTTP (the template example rows as real data)', () => {
    beforeEach(async () => { await upload(await goldenFile()); });

    it('defaults to the latest uploaded period and reports freshness', async () => {
      const b = await (await get('/marcom/kpi/spending', 'director')).json();
      expect(b.filters).toMatchObject({ year: 2026, fromMonth: 1, toMonth: 8 });
      expect(b.freshness).toMatchObject({ hasData: true, latestPeriod: { year: 2026, month: 8, label: 'August 2026' }, uploadedBy: 'marcom.kpi.admin' });
      expect(b.hasData).toBe(true);
    });

    it('page 1', async () => {
      const b = await (await get('/marcom/kpi/spending?year=2026&fromMonth=8&toMonth=8', 'director')).json();
      expect(b.roi.ytd).toMatchObject({ value: 5.6, status: 'green', unit: 'ratio' });
      expect(b.roi.lytd).toBeNull();
      expect(b.meta.missing).toEqual(['lastYearData']);
      expect(b.budgetUtilization.brands[0].value).toBeCloseTo(90.909, 2);
      expect(b.brandGrowth.brands[0].value).toBeCloseTo(14.2857, 3);
      expect(b.cac.overall.value).toBeCloseTo(416.6667, 3);
      expect(b.cac.overall.pctOfInvoice).toMatchObject({ status: 'red' });
      expect(b.cac.overall.pctOfInvoice.value).toBeCloseTo(46.2963, 3);
      expect(b.cpc.overall).toMatchObject({ status: 'green' });
      expect(b.cpc.overall.value).toBeCloseTo(2.2857, 3);
      expect(b.totals.spend).toMatchObject({ total: 50000 });
    });

    it('page 2', async () => {
      const b = await (await get('/marcom/kpi/campaigns?year=2026&fromMonth=1&toMonth=12', 'director')).json();
      expect(b.timeline[0]).toMatchObject({ name: 'Ramadan Lighting Campaign', durationDays: 42, start: '2026-02-01', end: '2026-03-15', roiStatus: 'green' });
      expect(b.totals.rate.value).toBeCloseTo(541.6667, 3);
      expect(b.roiByCampaign.campaigns[0].roi.value).toBeCloseTo(5.4167, 3);
      expect(b.coverageByType.types.find((t: { mediaType: string }) => t.mediaType === '1-Street Lights')).toMatchObject({ units: 45 });
      expect(b.costByType.types.find((t: { mediaType: string }) => t.mediaType === '1-Street Lights')).toMatchObject({ cost: 30000, units: 45, costPerUnit: 30000 / 45 });
      expect(b.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('page 2 overlap rule: a Feb-Mar campaign is out of an Aug-only period, in for Mar', async () => {
      expect((await (await get('/marcom/kpi/campaigns?year=2026&fromMonth=8&toMonth=8', 'director')).json()).timeline).toHaveLength(0);
      expect((await (await get('/marcom/kpi/campaigns?year=2026&fromMonth=3&toMonth=3', 'director')).json()).timeline).toHaveLength(1);
      expect((await (await get('/marcom/kpi/campaigns?year=2026&status=Ongoing', 'director')).json()).timeline).toHaveLength(0);
      expect((await (await get('/marcom/kpi/campaigns?year=2026&status=Completed', 'director')).json()).timeline).toHaveLength(1);
    });

    it('page 3', async () => {
      const b = await (await get('/marcom/kpi/digital?year=2026&fromMonth=8&toMonth=8&platforms=Instagram', 'director')).json();
      expect(b.ctr.overall).toMatchObject({ status: 'green' });
      expect(b.ctr.overall.value).toBeCloseTo(5.2778, 3);
      expect(b.engagementRate.overall).toMatchObject({ status: 'yellow' });
      expect(b.engagementRate.overall.value).toBeCloseTo(4.0556, 3);
      expect(b.bounceRate.kpi.value).toBeCloseTo(28.3333, 3);
      expect(b.avgSession.kpi).toMatchObject({ value: 3.5, status: 'green' });
      expect(b.followers.platforms).toEqual([{ platform: 'Instagram', value: 52000, asOf: { year: 2026, month: 8 } }]);
    });

    it('page 4', async () => {
      const b = await (await get('/marcom/kpi/trade?year=2026&fromMonth=8&toMonth=8', 'director')).json();
      expect(b.compliance.headline).toMatchObject({ value: 94, status: 'green' });
      expect(b.giveawaysStock.headline).toMatchObject({ value: 88, status: 'yellow' });
      expect(b.printedStock.headline).toMatchObject({ value: 91, status: 'green' });
      expect(b.attendance.kpi).toMatchObject({ value: 92, status: 'green' });
      expect(b.eventsByTypeMonthly[0].byType['6-Launch & Opening']).toBe(1);
      const only = await (await get('/marcom/kpi/trade?year=2026&fromMonth=8&toMonth=8&completedOnly=true', 'director')).json();
      expect(only.eventsByTypeMonthly[0].total).toBe(1);
      expect(only.meta.eventsFilter).toBe('completedOnly');
    });

    it('brand filter narrows the data; an existing brand with no rows in range yields na, not an error', async () => {
      const [brands] = (await pool.query('SELECT brand_id FROM marcom_brand')) as [{ brand_id: number }[], unknown];
      const id = brands[0].brand_id;
      const b = await (await get(`/marcom/kpi/spending?brandIds=${id}`, 'director')).json();
      expect(b.filters.brands).toHaveLength(1);
      expect(b.roi.ytd.value).toBe(5.6);
      const t = await (await get(`/marcom/kpi/trade?brandIds[]=${id}`, 'director')).json();
      expect(t.eventsTimeline).toHaveLength(1);
    });
  });

  describe('only is_current rows are ever read', () => {
    const rowA = (spend: number) => [2026, 'August', 'Brand A', spend, 280000, 1200000, 1050000, 55000, 120, 900, 8000, 3500];

    it('an update supersedes the old row (no double counting) and rollback restores the earlier value', async () => {
      await upload(await spendFile([rowA(50000)]));
      const first = await (await get('/marcom/kpi/spending?year=2026&fromMonth=8&toMonth=8', 'director')).json();
      expect(first.totals.spend.total).toBe(50000);

      const second = await upload(await spendFile([rowA(60000)]));
      const after = await (await get('/marcom/kpi/spending?year=2026&fromMonth=8&toMonth=8', 'director')).json();
      expect(after.totals.spend.total).toBe(60000); // not 110000
      const [hist] = (await pool.query('SELECT COUNT(*) AS n FROM marcom_spend_monthly')) as [{ n: number }[], unknown];
      expect(hist[0].n).toBe(2); // the superseded row still exists...

      await svc.rollbackBatch({ batchId: second.batchId, actor: { id: ids.admin }, reason: 'back it out' });
      const back = await (await get('/marcom/kpi/spending?year=2026&fromMonth=8&toMonth=8', 'director')).json();
      expect(back.totals.spend.total).toBe(50000); // ...but never leaks into a KPI
    });

    it('LYTD appears once prior-year rows are uploaded, and the ratio is the ratio of sums', async () => {
      await upload(await spendFile([rowA(50000)]));
      let b = await (await get('/marcom/kpi/spending?year=2026&fromMonth=8&toMonth=8', 'director')).json();
      expect(b.roi.lytd).toBeNull();
      await upload(await spendFile([[2025, 'August', 'Brand A', 100000, 300000, 1, 1, 1, 1, 1, 1, 1]]));
      b = await (await get('/marcom/kpi/spending?year=2026&fromMonth=8&toMonth=8', 'director')).json();
      expect(b.roi.lytd).toMatchObject({ value: 3, status: 'yellow' });
      expect(b.roi.ytd).toMatchObject({ value: 5.6, previous: 3 });
      expect(b.roi.ytd.delta).toBeCloseTo(2.6, 10);
      expect(b.meta.missing).not.toContain('lastYearData');
      expect(b.roi.monthly[0]).toMatchObject({ month: 8, current: 5.6, lastYear: 3 });
    });

    it('two months with very different ratios aggregate as ratio of sums (through the database)', async () => {
      const r = (m: string, spend: number, rev: number) => [2026, m, 'Brand A', spend, rev, 1, 1, 1, 1, 1, 1, 1];
      await upload(await spendFile([r('January', 100, 1000), r('February', 900, 900)]));
      const b = await (await get('/marcom/kpi/spending?year=2026&fromMonth=1&toMonth=2', 'director')).json();
      expect(b.roi.ytd.value).toBe(1.9);
      expect(b.roi.monthly.map((m: { current: number }) => m.current)).toEqual([10, 1]);
    });
  });

  describe('parameter validation (400 with a clear message, never a 500)', () => {
    it.each([
      ['spending?year=abc', /year must be a whole number/],
      ['spending?year=1999', /year must be between/],
      ['spending?fromMonth=0', /fromMonth must be between/],
      ['spending?toMonth=13', /toMonth must be between/],
      ['spending?fromMonth=6&toMonth=3', /fromMonth must not be after toMonth/],
      ['spending?brandIds=999', /Unknown brand id/],
      ['spending?brandIds=1%20OR%201=1', /brandIds must be whole numbers/],
      ['trade?brandIds=abc', /brandIds must be whole numbers/],
      ['digital?platforms=Myspace', /Unknown platforms/],
      ['campaigns?status=Bogus', /Unknown status/],
      ['trade?completedOnly=maybe', /completedOnly must be true or false/],
      ['spending?year=2026&year=2027', /year must be a whole number/],
      ["campaigns?status=Planned'%3B%20DROP%20TABLE%20marcom_campaign%3B--", /Unknown status/],
    ])('/%s -> 400', async (qs, msg) => {
      const res = await get(`/marcom/kpi/${qs}`, 'director');
      expect(res.status).toBe(400);
      const b = await res.json();
      expect(b.code).toBe('BAD_PARAMS');
      expect(b.error).toMatch(msg);
    });

    it('the injection attempt did not touch the data', async () => {
      await upload(await goldenFile());
      await get("/marcom/kpi/campaigns?status=Planned'%3B%20DROP%20TABLE%20marcom_campaign%3B--", 'director');
      const [n] = (await pool.query('SELECT COUNT(*) AS n FROM marcom_campaign')) as [{ n: number }[], unknown];
      expect(n[0].n).toBe(1);
    });
  });

  describe('performance shape', () => {
    beforeEach(async () => { await upload(await goldenFile()); });
    it.each(PAGES)('%s issues a small, fixed number of queries', async (page) => {
      const spy = vi.spyOn(pool, 'query');
      const res = await get(`/marcom/kpi/${page}?year=2026&fromMonth=1&toMonth=8`, 'director');
      expect(res.status).toBe(200);
      // Auth (revoked-token check, user load, permission lookup) is a fixed overhead; the KPI work itself is
      // brand list + 1-3 data queries + freshness (2) -- independent of how many brands/months/campaigns exist.
      const sqls = spy.mock.calls.map((c) => String(c[0]));
      const marcomQueries = sqls.filter((s) => /marcom_/.test(s));
      expect(marcomQueries.length).toBeLessThanOrEqual(8);
      expect(marcomQueries.every((s) => !/marcom_[a-z_]+ t /.test(s) || /is_current = 1/.test(s))).toBe(true);
      spy.mockRestore();
    });
  });
});
