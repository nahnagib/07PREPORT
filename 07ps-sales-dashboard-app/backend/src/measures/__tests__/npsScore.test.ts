import { describe, expect, it } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { CSAT_SCALE, NPS_SCALE, RESPONSE_RATE_SCALE, bandOf, csatBand, minResponders, npsBand, responseRateBand } from '../../config/npsThresholds';
import { periodStart } from '../debtCollections';
import { weekStartIso } from '../../lib/businessWeek';
import {
  NpsQueryError,
  csatScore,
  fetchNpsDetractors,
  fetchNpsFollowupSummary,
  fetchNpsOverview,
  fetchNpsReach,
  fetchNpsResponseRate,
  fetchNpsTrend,
  ratePct,
  npsScore,
  npsWhere,
  parseNpsQuery,
  periodsBetween,
  toCounts,
  todayLocal,
} from '../npsScore';

const NOW = new Date('2026-10-17T23:30:00Z'); // 01:30 on 18 October in Tripoli
const round2 = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);

describe('formulas (the requirement examples)', () => {
  it('NPS = %promoters - %detractors from the unrounded percentages: 177 responders, 124 / 44 / 9 -> 64.97', () => {
    const nps = npsScore(124, 44, 9);
    expect(round2((124 / 177) * 100)).toBe(70.06);
    expect(round2((9 / 177) * 100)).toBe(5.08);
    expect(round2(nps)).toBe(64.97); // not 70.06 - 5.08 = 64.98: the rounding happens only at display time
    expect(nps).toBeCloseTo(6497.175141 / 100, 6);
  });

  it('CSAT = (passives + promoters) / responders: (124 + 44) / 177 -> 94.92, Yellow', () => {
    const csat = csatScore(124, 44, 9);
    expect(round2(csat)).toBe(94.92);
    expect(csatBand(csat)).toBe('yellow');
  });

  it('0 responders: no value, never 0', () => {
    expect(npsScore(0, 0, 0)).toBeNull();
    expect(csatScore(0, 0, 0)).toBeNull();
    expect(toCounts(undefined, 5)).toMatchObject({ responders: 0, nps: null, csat: null, promotersPct: null, npsBand: null, belowMinimum: false });
  });

  it('toCounts: counts from MySQL strings, percentages of responders, the minimum', () => {
    const c = toCounts({ promoters: '124', passives: '44', detractors: '9' }, 5);
    expect(c).toMatchObject({ responders: 177, promoters: 124, passives: 44, detractors: 9, belowMinimum: false, npsBand: 'yellow' });
    expect((c.promotersPct ?? 0) + (c.passivesPct ?? 0) + (c.detractorsPct ?? 0)).toBeCloseTo(100, 10);
    expect(toCounts({ promoters: 3, passives: 1, detractors: 0 }, 5).belowMinimum).toBe(true);
    expect(toCounts({ promoters: 3, passives: 1, detractors: 1 }, 5).belowMinimum).toBe(false);
  });

  it('groups add up by COUNTS, never by averaging their scores', () => {
    // two groups: 1 promoter (NPS +100) and 1 promoter + 3 detractors (NPS -50); together 2 / 0 / 3 -> -20, not +25
    expect(npsScore(1 + 1, 0, 0 + 3)).toBe(-20);
  });

  it('NPS_MIN_RESPONDERS, default 5', () => {
    expect(minResponders({})).toBe(5);
    expect(minResponders({ NPS_MIN_RESPONDERS: '10' })).toBe(10);
    expect(minResponders({ NPS_MIN_RESPONDERS: 'x' })).toBe(5);
  });
});

describe('colour bands (config/npsThresholds.ts): inclusive at the lower end', () => {
  it.each([
    [49.99, 'red'], [50, 'yellow'], [89.99, 'yellow'], [90, 'green'], [100, 'green'], [-35, 'red'],
  ])('NPS %s -> %s', (v, band) => expect(npsBand(v as number)).toBe(band));

  it.each([
    [84.99, 'red'], [85, 'yellow'], [94.99, 'yellow'], [95, 'green'], [100, 'green'], [0, 'red'],
  ])('CSAT %s -> %s', (v, band) => expect(csatBand(v as number)).toBe(band));

  it.each([
    [24.99, 'red'], [25, 'yellow'], [29.99, 'yellow'], [30, 'green'], [0, 'red'], [100, 'green'],
  ])('response rate %s -> %s (Critical / Behind Target / On Track)', (v, band) => expect(responseRateBand(v as number)).toBe(band));

  it('targets and drawn scales', () => {
    expect(RESPONSE_RATE_SCALE).toMatchObject({ yellowFrom: 25, greenFrom: 30, target: 30 });
    expect(responseRateBand(null)).toBeNull();
    expect(NPS_SCALE).toMatchObject({ target: 90, min: 0, max: 100 });
    expect(CSAT_SCALE).toMatchObject({ target: 95, min: 0, max: 100 });
    expect(bandOf(null, NPS_SCALE)).toBeNull();
  });
});

describe('parseNpsQuery', () => {
  it('defaults to this year in Tripoli (1 January -> today), monthly', () => {
    expect(todayLocal(NOW)).toBe('2026-10-18');
    expect(parseNpsQuery({}, NOW)).toMatchObject({ dateFrom: '2026-01-01', dateTo: '2026-10-18', grain: 'month', page: 1, pageSize: 100 });
    // 31 December 22:30 UTC is already 1 January in Tripoli: the YTD starts over
    expect(parseNpsQuery({}, new Date('2026-12-31T22:30:00Z'))).toMatchObject({ dateFrom: '2027-01-01', dateTo: '2027-01-01' });
    expect(parseNpsQuery({ grain: 'week' }, NOW).grain).toBe('week');
  });

  it('400s on bad values', () => {
    for (const q of [{ dateFrom: '2026-13-01' }, { dateTo: '18/10/2026' }, { dateFrom: '2026-10-10', dateTo: '2026-10-01' },
      { page: '0' }, { pageSize: '1000' }, { grain: 'day' }]) {
      expect(() => parseNpsQuery(q, NOW), JSON.stringify(q)).toThrow(NpsQueryError);
    }
  });

  it('periods of a range at each grain', () => {
    expect(periodsBetween('2025-11-15', '2026-02-01', 'month')).toEqual([202511, 202512, 202601, 202602]);
    // weeks: Sunday..Saturday, named by their Sunday; the first week starts before the range
    expect(periodsBetween('2025-12-30', '2026-01-14', 'week')).toEqual([20251228, 20260104, 20260111]);
    expect(periodsBetween('2024-06-01', '2026-01-02', 'year')).toEqual([2024, 2025, 2026]);
  });
});

describe('SQL', () => {
  it('the date range and every global filter are parameters, through the effective org expressions', () => {
    const w = npsWhere({ dateFrom: '2026-10-01', dateTo: '2026-10-31' }, { companyKeys: [3], segmentKeys: [1, 2], salespersonKeys: [49], customerKeys: [100] });
    expect(w.sql).toContain('f.RatingDateKey BETWEEN ? AND ?');
    expect(w.sql).toContain('f.CompanyKey IN (?)');
    expect(w.sql).toContain('salesperson_admin_profile'); // segment through the admin override, like the sales pages
    expect(w.sql).toContain('f.CustomerKey IN (?)');
    expect(w.params).toEqual([20261001, 20261031, 3, 1, 2, 49, 100]);
  });

  function fakePool(answer: (sql: string) => unknown[]) {
    const queries: { sql: string; params: unknown[] }[] = [];
    const pool = { query: async (sql: string, params: unknown[] = []) => { queries.push({ sql, params }); return [answer(sql), []]; } };
    return { pool: pool as unknown as Pool, queries };
  }

  it('overview: the figures of the summed counts of the filtered set', async () => {
    const { pool, queries } = fakePool(() => [{ promoters: '124', passives: '44', detractors: '9', with_comment: '3' }]);
    const o = await fetchNpsOverview(pool, parseNpsQuery({}, NOW), { companyKeys: [1] });
    expect(round2(o.totals.nps)).toBe(64.97);
    expect(round2(o.totals.csat)).toBe(94.92);
    expect(o.totals).toMatchObject({ responders: 177, withComment: 3, csatBand: 'yellow', npsBand: 'yellow' });
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain('FROM v_process_nps_response f');
    expect(queries[0].params).toContain(1);
  });

  it('trend: from the first period WITH ratings (no empty months before it), empty later periods kept, targets 90 / 95', async () => {
    const { pool, queries } = fakePool(() => [{ p: 202608, promoters: 5, passives: 3, detractors: 2 }, { p: 202610, promoters: 1, passives: 0, detractors: 0 }]);
    const t = await fetchNpsTrend(pool, parseNpsQuery({ dateFrom: '2026-01-01', dateTo: '2026-10-31' }, NOW), {});
    expect(t.points.map((p) => [p.period, p.responders, p.nps])).toEqual([['2026-08', 10, 30], ['2026-09', 0, null], ['2026-10', 1, 100]]);
    expect(t.points[0].csat).toBe(80);
    expect([t.target, t.csatTarget]).toEqual([90, 95]);
    expect(queries[0].sql).toContain('GROUP BY FLOOR(f.RatingDateKey / 100)');
    const none = await fetchNpsTrend(fakePool(() => []).pool, parseNpsQuery({}, NOW), {});
    expect(none.points).toEqual([]);
  });

  it('trend by week: grouped by the Sunday of the rating date (the Collections week), labelled by that Sunday', async () => {
    const { pool, queries } = fakePool(() => [{ p: 20261004, promoters: 2, passives: 0, detractors: 0 }]);
    const t = await fetchNpsTrend(pool, parseNpsQuery({ dateFrom: '2026-10-01', dateTo: '2026-10-18', grain: 'week' }, NOW), {});
    expect(t.points.map((p) => [p.period, p.responders])).toEqual([['2026-10-04', 2], ['2026-10-11', 0], ['2026-10-18', 0]]);
    expect(queries[0].sql).toContain('DAYOFWEEK(');
    await expect(fetchNpsTrend(pool, parseNpsQuery({ dateFrom: '2010-01-01', dateTo: '2026-10-31', grain: 'week' }, NOW), {})).rejects.toThrow(NpsQueryError);
  });

  it('detractors: level 1 only, with the comments of the same response, paged', async () => {
    const { pool, queries } = fakePool((sql) => (sql.includes('COUNT(*) AS n') ? [{ n: 1 }] : [{ response_id: 19566, CustomerKey: 100, comment: 'شكرا [phone]' }]));
    const page = await fetchNpsDetractors(pool, parseNpsQuery({ page: '2', pageSize: '10' }, NOW), {});
    expect(page).toMatchObject({ total: 1, page: 2, pageSize: 10 });
    expect(page.rows[0]).toMatchObject({ responseId: 19566, comment: 'شكرا [phone]', caseId: null, status: null, reason: null, orderUrl: null, deliveryUrl: null });
    expect(queries[1].sql).toContain('LEFT JOIN nps_followup_case fc ON fc.response_id = f.response_id');
    expect(queries[1].sql).toContain('f.nps_level = 1');
    expect(queries[1].sql).toContain('FROM fact_process_nps_comment c WHERE c.response_id = f.response_id');
    expect(queries[1].params.slice(-2)).toEqual([10, 10]);
  });

  it('reach: a successful empty snapshot returns real zeros, while an unfiltered request needs no filter label', async () => {
    const { pool } = fakePool((sql) => sql.includes('process_nps_reach_state') ? [{ loaded_at_utc: '2026-10-18 10:00:00' }] : []);
    const result = await fetchNpsReach(pool, parseNpsQuery({}, NOW), {}, { roleCode: 'BI00_EXECUTIVE' });
    expect(result).toMatchObject({ status: 'ready', companyAndDateOnly: false, errors: [], reachStart: null,
      totals: { totalReach: 0, delivered: 0, notDelivered: 0, read: 0, error: 0, otherState: 0 } });
  });
});

describe('business week (lib/businessWeek.ts) = the Collections week', () => {
  it('Sunday..Saturday, named by the Sunday, for every day of two years', () => {
    expect(weekStartIso('2026-10-04')).toBe('2026-10-04'); // a Sunday
    expect(weekStartIso('2026-10-10')).toBe('2026-10-04'); // its Saturday
    expect(weekStartIso('2026-01-01')).toBe('2025-12-28'); // across the year
    for (let d = new Date('2025-01-01T12:00:00Z'); d < new Date('2027-01-01T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      expect(weekStartIso(iso), iso).toBe(periodStart(iso, 'week'));
    }
  });
});

// eslint-disable-next-line no-unused-vars -- parameter name in a function type, not a variable
function pool(answer: (query: string) => unknown[]) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const p = { query: async (sql: string, params: unknown[] = []) => { queries.push({ sql, params }); return [answer(sql), []]; } };
  return { pool: p as unknown as Pool, queries };
}
const ADMIN = { roleCode: 'BI00_EXECUTIVE' };

describe('response rate = responders / (Delivered + Read)', () => {
  it('the formula: unrounded, no value without a reached message', () => {
    expect(ratePct(30, 100)).toBe(30);
    expect(ratePct(1, 3)).toBeCloseTo(33.3333333, 6);
    expect(ratePct(5, 0)).toBeNull();
  });

  function reachPool(reachStart: string | null, ratings: Record<string, number>, messages: Record<string, [number, number, number]>) {
    return pool((sql) => {
      if (sql.includes('process_nps_reach_state')) return [{ reach_start: reachStart }];
      if (sql.includes('FROM v_process_nps_response')) return Object.entries(ratings).map(([wk, n]) => ({ wk, n }));
      if (sql.includes('FROM v_process_nps_reach')) {
        return Object.entries(messages).map(([wk, [delivered, read, total]]) => ({ wk, delivered, read_count: read, total_reach: total }));
      }
      return [];
    });
  }

  it('starts at NPS_REACH_START, sums both sides per Sunday week of the same period, band and variance from the target', async () => {
    const { pool: p, queries } = reachPool('2026-10-03', { '2026-10-04': 20, '2026-10-11': 10 }, { '2026-09-27': [10, 20, 40], '2026-10-04': [30, 40, 100], '2026-10-11': [10, 10, 50] });
    const r = await fetchNpsResponseRate(p, parseNpsQuery({}, NOW), { companyKeys: [1] }, ADMIN);
    expect(r).toMatchObject({ status: 'ready', dateFrom: '2026-10-03', dateTo: '2026-10-18', reachStart: '2026-10-03', companyAndDateOnly: false,
      responders: 30, delivered: 50, read: 70, reached: 120, totalReach: 190, target: 30 });
    expect(r.rate).toBeCloseTo(25, 9); // 30 / 120 -> exactly the yellow boundary
    expect(r.band).toBe('yellow');
    expect(r.variancePts).toBeCloseTo(-5, 9);
    expect(r.rateOfReach).toBeCloseTo((30 / 190) * 100, 9);
    expect(r.weekly.map((w) => [w.weekStart, w.responders, w.reached])).toEqual([['2026-09-27', 0, 30], ['2026-10-04', 20, 70], ['2026-10-11', 10, 20], ['2026-10-18', 0, 0]]);
    expect(r.weekly[3].rate).toBeNull();
    // both sides: the same clamped period and the company only -- never a segment / salesperson condition
    const data = queries.filter((q) => /FROM v_process_nps_(response|reach) /.test(q.sql));
    expect(data).toHaveLength(2);
    for (const q of data) {
      expect(q.params).toEqual([20261003, 20261018, 1]);
      expect(q.sql).toContain('.CompanyKey IN (?)');
      expect(q.sql).not.toMatch(/SegmentKey|SalespersonKey|SalesTeamKey|CustomerKey|salesperson_admin_profile/);
    }
  });

  it('ignores the team / salesperson / segment / customer filters on BOTH sides and says so', async () => {
    const { pool: p, queries } = reachPool('2026-10-03', { '2026-10-04': 3 }, { '2026-10-04': [5, 5, 10] });
    const r = await fetchNpsResponseRate(p, parseNpsQuery({}, NOW), { segmentKeys: [1, 2], salespersonKeys: [49] }, ADMIN);
    expect(r).toMatchObject({ companyAndDateOnly: true, responders: 3, reached: 10, rate: 30, band: 'green', variancePts: 0 });
    for (const q of queries) expect(q.params).not.toContain(49);
  });

  it('a range that ends before NPS_REACH_START has no figure; no message load = waiting; non-company role scopes = restricted', async () => {
    const before = await fetchNpsResponseRate(reachPool('2026-10-03', {}, {}).pool, parseNpsQuery({ dateFrom: '2026-07-01', dateTo: '2026-09-30' }, NOW), {}, ADMIN);
    expect(before).toMatchObject({ status: 'ready', rate: null, responders: 0, weekly: [] });
    const none = pool(() => []);
    expect((await fetchNpsResponseRate(none.pool, parseNpsQuery({}, NOW), {}, ADMIN)).status).toBe('waiting');
    for (const user of [{ roleCode: 'SALESPERSON' }, { roleCode: 'X', dataScopeRules: [{ dimension: 'segmentKeys', value: '1' }] }]) {
      const q = pool(() => []);
      expect((await fetchNpsResponseRate(q.pool, parseNpsQuery({}, NOW), {}, user as never)).status).toBe('restricted');
      expect(q.queries).toHaveLength(0);
    }
    const companyScoped = reachPool('2026-10-03', {}, {});
    await fetchNpsResponseRate(companyScoped.pool, parseNpsQuery({}, NOW), { companyKeys: [3] }, { roleCode: 'X', dataScopeRules: [{ dimension: 'companyKeys', value: '3' }] } as never);
    expect(companyScoped.queries.filter((q) => q.params.includes(3))).toHaveLength(2);
  });
});

describe('follow-up summary (live from nps_followup_case)', () => {
  const NOW_LOCAL = '2026-10-20 12:00:00';
  const row = (status: string | null, rated: string, solved: string | null, reasonId: number | null, name: string | null = null) =>
    ({ case_id: status ? 1 : null, status, rated_at_local: rated, solved_at: solved, reason_id: reasonId, name_en: name, name_ar: name ? `${name}-ar` : null, sort_order: reasonId });

  it('buckets: solved < 48 h green, 48 h - 5 d yellow, > 5 d red, pending black; Historical / Cancelled counted apart', async () => {
    const { pool: p, queries } = pool(() => [
      row('SOLVED', '2026-10-01 10:00:00', '2026-10-02 09:00:00', 1, 'Late delivery'),   // 23 h
      row('SOLVED', '2026-10-01 10:00:00', '2026-10-03 10:00:00', 1, 'Late delivery'),   // 48 h -> yellow
      row('SOLVED', '2026-10-01 10:00:00', '2026-10-06 10:00:01', 2, 'Damaged product'), // > 5 days
      row('NEW', '2026-10-19 10:00:00', null, null),
      row('IN_PROGRESS', '2026-10-05 10:00:00', null, 2, 'Damaged product'),
      row('CANCELLED', '2026-10-05 10:00:00', null, 1, 'Late delivery'),
      row('HISTORICAL', '2026-08-05 10:00:00', null, null),
      row('HISTORICAL', '2026-09-05 10:00:00', null, null),
      row(null, '2026-10-20 08:00:00', null, null), // rated after the last process_nps run: no case yet
    ]);
    const s = await fetchNpsFollowupSummary(p, parseNpsQuery({}, NOW), {}, NOW_LOCAL);
    expect(Object.fromEntries(s.byStatus.map((b) => [b.key, b.count]))).toEqual({ solved_48h: 1, solved_5d: 1, solved_late: 1, pending: 2 });
    expect(s).toMatchObject({ detractors: 9, charted: 5, cancelled: 1, historical: 2, noCase: 1 });
    expect(s.charted + s.cancelled + s.historical + s.noCase).toBe(s.detractors);
    // most cases first; a tie keeps the reason list's order; "Not yet classified" for cases without a reason
    expect(s.byReason).toEqual([
      { reasonId: 1, label: 'Late delivery', labelAr: 'Late delivery-ar', count: 2 },
      { reasonId: 2, label: 'Damaged product', labelAr: 'Damaged product-ar', count: 2 },
      { reasonId: null, label: 'Not yet classified', labelAr: null, count: 1 },
    ]);
    expect(s.byReason.reduce((n, r) => n + r.count, 0)).toBe(s.charted);
    expect(queries[0].sql).toContain('LEFT JOIN nps_followup_case fc');
    expect(queries[0].sql).toContain('f.nps_level = 1');
    expect(queries[0].sql).toContain('f.RatingDateKey BETWEEN ? AND ?');
  });
});

describe('Odoo links (lib/odooLinks.ts)', () => {
  it('the form of the record in its own company; no id or no setting = no link, never a guessed host', async () => {
    const { odooConfiguredBaseUrl, odooFormUrl } = await import('../../lib/odooLinks');
    expect(odooConfiguredBaseUrl({ ODOO_URL: 'https://erp.example.com/' })).toBe('https://erp.example.com');
    expect(odooConfiguredBaseUrl({ ODOO_WEB_BASE_URL: 'https://web.example.com', ODOO_URL: 'https://erp.example.com' })).toBe('https://web.example.com');
    expect(odooConfiguredBaseUrl({})).toBeNull();
    expect(odooFormUrl('https://erp.example.com', 'stock.picking', 7001, 3)).toBe('https://erp.example.com/web#id=7001&model=stock.picking&view_type=form&cids=3');
    expect(odooFormUrl('https://erp.example.com', 'sale.order', 4000, -1)).toBe('https://erp.example.com/web#id=4000&model=sale.order&view_type=form');
    expect(odooFormUrl('https://erp.example.com', 'stock.picking', -1, 3)).toBeNull();
    expect(odooFormUrl('https://erp.example.com', 'stock.picking', null, 3)).toBeNull();
    expect(odooFormUrl(null, 'stock.picking', 7001, 3)).toBeNull();
  });

  it('detractor rows: status / reason / owner / time open from the case; order and delivery link with and without a picking id', async () => {
    const old = process.env.ODOO_URL;
    process.env.ODOO_URL = 'https://erp.example.com';
    try {
      const { pool: p } = pool((sql) => (sql.includes('COUNT(*) AS n') ? [{ n: 2 }] : [
        { response_id: 1, rated_at_local: '2026-10-10 10:00:00', CompanyKey: 3, CustomerKey: 100, order_ref: 'S1', delivery_code: 'TIKA/OUT/1',
          SalesOrderKey: 4000, PickingID: 7001, case_id: 11, status: 'NEW', case_rated_at: '2026-10-10 10:00:00', solved_at: null,
          reason_en: 'Late delivery', reason_ar: 'تأخر التوصيل', owner_name: 'Amal' },
        { response_id: 2, rated_at_local: '2026-10-10 10:00:00', CompanyKey: 1, CustomerKey: 101, order_ref: 'S2', delivery_code: 'WH/OUT/2',
          SalesOrderKey: -1, PickingID: -1, case_id: 12, status: 'SOLVED', case_rated_at: '2026-10-10 10:00:00', solved_at: '2026-10-11 10:00:00',
          reason_en: null, reason_ar: null, owner_name: null },
      ]));
      const page = await fetchNpsDetractors(p, parseNpsQuery({}, NOW), {}, '2026-10-20 10:00:00');
      expect(page.rows[0]).toMatchObject({ caseId: 11, status: 'NEW', reason: 'Late delivery', owner: 'Amal', hoursOpen: 240, timeBand: 'red',
        orderUrl: 'https://erp.example.com/web#id=4000&model=sale.order&view_type=form&cids=3',
        deliveryUrl: 'https://erp.example.com/web#id=7001&model=stock.picking&view_type=form&cids=3' });
      expect(page.rows[1]).toMatchObject({ caseId: 12, status: 'SOLVED', reason: null, hoursOpen: 24, timeBand: 'green', orderUrl: null, deliveryUrl: null });
    } finally {
      if (old === undefined) delete process.env.ODOO_URL;
      else process.env.ODOO_URL = old;
    }
  });
});
