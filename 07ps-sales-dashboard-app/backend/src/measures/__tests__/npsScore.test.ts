import { DateTime } from 'luxon';
import { splitGap } from '../npsReachEstimate';
import { getAppTimezone } from '../../lib/timezone';
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
  completeMeasuredWeeks,
  fetchNpsReach,
  fetchNpsResponseRate,
  reachGap,
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
    // weeks: Saturday..Friday, named by their Saturday; the first week starts before the range
    expect(periodsBetween('2025-12-30', '2026-01-14', 'week')).toEqual([20251227, 20260103, 20260110]);
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

  it('trend by week: grouped by the Saturday of the rating date (the Collections week), labelled by that Saturday', async () => {
    const { pool, queries } = fakePool(() => [{ p: 20261003, promoters: 2, passives: 0, detractors: 0 }]);
    const t = await fetchNpsTrend(pool, parseNpsQuery({ dateFrom: '2026-10-01', dateTo: '2026-10-18', grain: 'week' }, NOW), {});
    expect(t.points.map((p) => [p.period, p.responders])).toEqual([['2026-10-03', 2], ['2026-10-10', 0], ['2026-10-17', 0]]);
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
  it('Saturday..Friday, named by the Saturday, for every day of two years', () => {
    expect(weekStartIso('2026-10-04')).toBe('2026-10-03'); // Sunday belongs to the preceding Saturday
    expect(weekStartIso('2026-10-10')).toBe('2026-10-10'); // Saturday starts its own week
    expect(weekStartIso('2026-01-01')).toBe('2025-12-27'); // across the year
    for (let d = new Date('2025-01-01T12:00:00Z'); d < new Date('2027-01-01T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      expect(weekStartIso(iso), iso).toBe(periodStart(iso, 'week'));
      expect(new Date(weekStartIso(iso) + 'T12:00:00Z').getUTCDay()).toBe(6);
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

/** The gap queries (measures/npsReachEstimate.ts): the companies with their first rating, each company's measured mix
 *  [Delivered, Read, Not Delivered] over the basis weeks, the gap's real errors [company, failure group, n], the gap's
 *  ratings, the load time (UTC). A query that names company keys gets only those companies. */
interface GapData {
  companies?: { key: number; first: string; name: string }[];
  mix?: Record<number, [number, number, number]>;
  errors?: [number, string, number][];
  gapResponders?: number;
  loadedAt?: string;
}
const COMPANIES = [{ key: 1, first: '2026-07-12', name: 'MAJAAL' }, { key: 3, first: '2026-08-08', name: 'TIKA' }];
function reachPool(reachStart: string | null, ratings: Record<string, number>, messages: Record<string, [number, number, number]>, gap: GapData = {}) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const named = (params: unknown[], key: number) => !params.some((x) => x === 1 || x === 3) || params.includes(key);
  const answer = (sql: string, params: unknown[]): unknown[] => {
    if (sql.includes('process_nps_reach_state')) {
      return [{ reach_start: reachStart, loaded_at_utc: gap.loadedAt ?? '2026-10-17 20:00:00', loaded_utc_text: gap.loadedAt ?? '2026-10-17 20:00:00' }];
    }
    if (sql.includes('MIN(f.RatingDateKey)')) {
      return (gap.companies ?? []).filter((c) => named(params, c.key)).map((c) => ({ company_key: c.key, first_key: Number(c.first.replace(/-/g, '')), company: c.name }));
    }
    if (sql.includes('FROM fact_process_nps_message m')) {
      return (gap.errors ?? []).filter(([k]) => params.includes(k)).map(([k, g, n]) => ({ company_key: k, failure_group: g, n }));
    }
    if (sql.includes('GROUP BY m.CompanyKey')) {
      return Object.entries(gap.mix ?? {}).filter(([k]) => params.includes(Number(k)))
        .map(([k, [d, r, nd]]) => ({ company_key: Number(k), delivered: d, read_count: r, not_delivered: nd }));
    }
    if (sql.includes('FROM dim_process_nps_failure_group')) {
      return [{ failure_group: 'phone_format', label_en: 'Phone format', is_fixable: 1, hint: 'Fix the number.', sort_order: 1 },
        { failure_group: 'undeliverable_131026', label_en: 'Undeliverable', is_fixable: 0, hint: 'No WhatsApp.', sort_order: 2 }];
    }
    if (sql.includes('FROM v_process_nps_message_error')) return [{ failure_group: 'phone_format', label_en: 'Phone format', is_fixable: 1, hint: 'Fix the number.', errors: 10 }];
    if (sql.includes('SUM(f.total_reach)')) return [{ total_reach: 135, delivered: 50, not_delivered: 5, read_count: 70, error_count: 10, other_state: 0 }];
    if (sql.includes('COUNT(*) AS n FROM v_process_nps_response')) return [{ n: gap.gapResponders ?? 0 }];
    if (sql.includes('FROM v_process_nps_response')) return Object.entries(ratings).map(([wk, n]) => ({ wk, n }));
    if (sql.includes('FROM v_process_nps_reach')) {
      return Object.entries(messages).map(([wk, [delivered, read, total]]) => ({ wk, delivered, read_count: read, total_reach: total }));
    }
    return [];
  };
  const p = { query: async (sql: string, params: unknown[] = []) => { queries.push({ sql, params }); return [answer(sql, params), []]; } };
  return { pool: p as unknown as Pool, queries };
}
const weeklyData = (queries: { sql: string; params: unknown[] }[]) => queries.filter((q) => q.sql.includes('GROUP BY wk'));

describe('response rate = responders / (Delivered + Read)', () => {
  it('the formula: unrounded, no value without a reached message', () => {
    expect(ratePct(30, 100)).toBe(30);
    expect(ratePct(1, 3)).toBeCloseTo(33.3333333, 6);
    expect(ratePct(5, 0)).toBeNull();
  });


  it('starts at NPS_REACH_START, sums both sides per Saturday week of the same period, band and variance from the target', async () => {
    const { pool: p, queries } = reachPool('2026-10-03', { '2026-10-03': 20, '2026-10-10': 10 }, { '2026-10-03': [40, 60, 140], '2026-10-10': [10, 10, 50] });
    const r = await fetchNpsResponseRate(p, parseNpsQuery({}, NOW), { companyKeys: [1] }, ADMIN);
    expect(r).toMatchObject({ status: 'ready', dateFrom: '2026-10-03', dateTo: '2026-10-18', reachStart: '2026-10-03', companyAndDateOnly: false,
      responders: 30, delivered: 50, read: 70, reached: 120, totalReach: 190, target: 30 });
    expect(r.rate).toBeCloseTo(25, 9); // 30 / 120 -> exactly the yellow boundary
    expect(r.band).toBe('yellow');
    expect(r.variancePts).toBeCloseTo(-5, 9);
    expect(r.rateOfReach).toBeCloseTo((30 / 190) * 100, 9);
    expect(r.weekly.map((w) => [w.weekStart, w.responders, w.reached])).toEqual([['2026-10-03', 20, 100], ['2026-10-10', 10, 20], ['2026-10-17', 0, 0]]);
    expect(r.weekly[2].rate).toBeNull();
    expect(r).toMatchObject({ isEstimated: false, estimateStatus: 'not_needed', estimate: null,
      measured: { from: '2026-10-03', responders: 30, reached: 120 } });
    // both sides: the same clamped period and the company only -- never a segment / salesperson condition
    const data = weeklyData(queries);
    expect(data).toHaveLength(2);
    for (const q of data) {
      expect(q.params).toEqual([20261003, 20261018, 1]);
      expect(q.sql).toContain('.CompanyKey IN (?)');
      expect(q.sql).not.toMatch(/SegmentKey|SalespersonKey|SalesTeamKey|CustomerKey|salesperson_admin_profile/);
    }
  });

  it('ignores the team / salesperson / segment / customer filters on BOTH sides and says so', async () => {
    const { pool: p, queries } = reachPool('2026-10-03', { '2026-10-03': 3 }, { '2026-10-03': [5, 5, 10] });
    const r = await fetchNpsResponseRate(p, parseNpsQuery({}, NOW), { segmentKeys: [1, 2], salespersonKeys: [49] }, ADMIN);
    expect(r).toMatchObject({ companyAndDateOnly: true, responders: 3, reached: 10, rate: 30, band: 'green', variancePts: 0 });
    for (const q of queries) expect(q.params).not.toContain(49);
  });

  it('without ratings before NPS_REACH_START a range that ends before it has no figure; no message load = waiting; non-company role scopes = restricted', async () => {
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
    expect(weeklyData(companyScoped.queries).filter((q) => q.params.includes(3))).toHaveLength(2);
  });
});

describe('the gap estimate 12 Jul – 02 Oct: Response Rate and Message reach from ONE calculation', () => {
  const ON = { enabled: true, fixedPerWeek: null, excludeWeeks: [] as string[] };
  // NOW = 18 Oct (Tripoli); loaded 17 Oct 22:00 Tripoli -> complete weeks 3-9 Oct and 10-16 Oct
  const RATINGS = { '2026-10-03': 20, '2026-10-10': 10 };
  // measured since 3 Oct: 50 Delivered + 70 Read + 5 Not Delivered + 10 Error = 135 Total Reach (the same on both endpoints)
  const MESSAGES: Record<string, [number, number, number]> = { '2026-10-03': [40, 60, 100], '2026-10-10': [10, 10, 35] };
  // over the 2 basis weeks: Majaal 60 delivered + 140 read (100 / week), Tika 30 + 70 (50 / week); Not Delivered 10 %
  const GAP: GapData = { companies: COMPANIES, mix: { 1: [60, 140, 20], 3: [30, 70, 10] },
    errors: [[1, 'phone_format', 30], [1, 'undeliverable_131026', 10], [3, 'phone_format', 10]], gapResponders: 400 };
  const ytd = parseNpsQuery({}, NOW); // 1 Jan .. 18 Oct
  const pools = (gap: GapData = GAP) => reachPool('2026-10-03', RATINGS, MESSAGES, gap);

  it('the gap and the complete measured weeks', () => {
    expect(reachGap('2026-01-01', '2026-10-18', '2026-07-12', '2026-10-03')).toEqual({ from: '2026-07-12', to: '2026-10-02', days: 83 });
    expect(reachGap('2026-09-01', '2026-09-30', '2026-07-12', '2026-10-03')).toEqual({ from: '2026-09-01', to: '2026-09-30', days: 30 });
    expect(reachGap('2026-10-03', '2026-10-18', '2026-07-12', '2026-10-03')).toBeNull(); // after the reach start
    expect(reachGap('2026-01-01', '2026-06-30', '2026-07-12', '2026-10-03')).toBeNull(); // before the first rating
    expect(reachGap('2026-01-01', '2026-10-18', null, '2026-10-03')).toBeNull();
    expect(completeMeasuredWeeks('2026-10-03', '2026-10-17')).toEqual(['2026-10-03', '2026-10-10']); // 17 Oct is the load day
    expect(completeMeasuredWeeks('2026-10-03', '2026-10-10')).toEqual(['2026-10-03']);
    expect(completeMeasuredWeeks('2026-10-03', '2026-10-09')).toEqual([]);
    expect(completeMeasuredWeeks('2026-10-05', '2026-10-25')).toEqual(['2026-10-10', '2026-10-17']); // a partial first week never counts
  });

  it('per company: reached = per week x gap days / 7; Delivered / Read by its measured mix (exact sum); Not Delivered by its ratio', () => {
    expect(splitGap(1186, 0.3, 0.1, 40)).toEqual({ reached: 1186, delivered: 356, read: 830, notDelivered: 119, error: 40, totalReach: 1186 + 119 + 40 });
    expect(splitGap(7, 0.5, 0, 0)).toMatchObject({ delivered: 4, read: 3 }); // read = reached - delivered, never off by one
  });

  it('a period fully after the reach start: identical to before (rate and cards), no estimate, no marks', async () => {
    const q = parseNpsQuery({ dateFrom: '2026-10-03', dateTo: '2026-10-18' }, NOW);
    const on = await fetchNpsResponseRate(pools().pool, q, {}, ADMIN, ON);
    const off = await fetchNpsResponseRate(pools().pool, q, {}, ADMIN, { ...ON, enabled: false });
    expect(on).toMatchObject({ isEstimated: false, estimateStatus: 'not_needed', estimate: null, responders: 30, reached: 120, rate: 25 });
    expect({ ...on, estimateStatus: 'x' }).toEqual({ ...off, estimateStatus: 'x' });
    const reach = await fetchNpsReach(pools().pool, q, {}, ADMIN, ON);
    expect(reach).toMatchObject({ isEstimated: false, estimateStatus: 'not_needed', estimate: null, measured: null, gap: null,
      totals: { totalReach: 135, delivered: 50, notDelivered: 5, read: 70, error: 10, otherState: 0 } });
    expect(reach.errors).toEqual([{ key: 'phone_format', label: 'Phone format', fixable: true, hint: 'Fix the number.', count: 10 }]);
  });

  it('a period spanning both: each company from its OWN first rating, summed; numerator = every responder; band on the headline', async () => {
    const { pool: p, queries } = pools();
    const r = await fetchNpsResponseRate(p, ytd, {}, ADMIN, ON);
    // Majaal 12 Jul .. 2 Oct = 83 days: 100 x 83 / 7 = 1185.7 -> 1186; Tika 8 Aug .. 2 Oct = 56 days: 50 x 8 = 400
    expect(r).toMatchObject({ status: 'ready', isEstimated: true, estimateStatus: 'applied', requestedDateFrom: '2026-01-01', dateFrom: '2026-07-12', responders: 430,
      reached: 120 + 1586, delivered: 50 + 356 + 120, read: 70 + 830 + 280,
      measured: { from: '2026-10-03', responders: 30, reached: 120, rate: 25 },
      estimate: { from: '2026-07-12', to: '2026-10-02', perWeek: 150, reached: 1586, basis: 'auto', basisWeeks: 2, basisFrom: '2026-10-03',
        basisTo: '2026-10-16', excludedWeeks: [],
        byCompany: [{ companyKey: 1, company: 'MAJAAL', from: '2026-07-12', perWeek: 100, reached: 1186 },
          { companyKey: 3, company: 'TIKA', from: '2026-08-08', perWeek: 50, reached: 400 }] } });
    expect(r.estimate!.weeks).toBeCloseTo(83 / 7, 9);
    expect(r.rate).toBeCloseTo((430 / 1706) * 100, 9);
    expect(r.band).toBe('yellow'); // 25.2 %: Behind Target
    expect(r.variancePts).toBeCloseTo(r.rate! - 30, 9);
    expect(r.weekly.map((w) => w.weekStart)).toEqual(['2026-10-03', '2026-10-10', '2026-10-17']); // the sparkline stays measured-only
    // never circular: the basis reads messages only, over the basis weeks
    const basis = queries.find((q) => q.sql.includes('GROUP BY m.CompanyKey'))!;
    expect(basis.params).toEqual([20261003, 20261009, 20261010, 20261016, 1, 3]);
    expect(basis.sql).not.toMatch(/v_process_nps_response|rating/i);
  });

  it('the Message reach cards = measured + the gap (Error REAL), Delivered + Read = the rate denominator, errors merged by group', async () => {
    const rate = await fetchNpsResponseRate(pools().pool, ytd, {}, ADMIN, ON);
    const reach = await fetchNpsReach(pools().pool, ytd, {}, ADMIN, ON);
    // gap: Majaal 1186 = 356 D + 830 R, 119 ND, 40 E; Tika 400 = 120 D + 280 R, 40 ND, 10 E
    expect(reach).toMatchObject({ isEstimated: true, estimateStatus: 'applied', estimate: { from: '2026-07-12', to: '2026-10-02' },
      measured: { totalReach: 135, delivered: 50, notDelivered: 5, read: 70, error: 10 },
      gap: { delivered: 476, read: 1110, notDelivered: 159, error: 50, totalReach: 1586 + 159 + 50, otherState: 0 },
      totals: { delivered: 526, read: 1180, notDelivered: 164, error: 60, totalReach: 135 + 1795, otherState: 0 } });
    const t = reach.totals!;
    expect(t.delivered + t.read).toBe(rate.reached);
    expect([t.delivered, t.read, t.totalReach]).toEqual([rate.delivered, rate.read, rate.totalReach]);
    expect(t.delivered + t.read + t.notDelivered + t.error + t.otherState).toBe(t.totalReach);
    expect(reach.errors.map((e) => [e.key, e.count])).toEqual([['phone_format', 50], ['undeliverable_131026', 10]]);
    expect(reach.errors.reduce((n, e) => n + e.count, 0)).toBe(t.error);
  });

  it('a period fully before the reach start: entirely estimated, clearly flagged, no measured part', async () => {
    const q = parseNpsQuery({ dateFrom: '2026-09-01', dateTo: '2026-09-30' }, NOW);
    const r = await fetchNpsResponseRate(pools({ ...GAP, gapResponders: 120 }).pool, q, {}, ADMIN, ON);
    // 30 days: Majaal 100 x 30 / 7 = 428.6 -> 429; Tika 50 x 30 / 7 = 214.3 -> 214
    expect(r).toMatchObject({ isEstimated: true, estimateStatus: 'applied', measured: null, dateFrom: '2026-09-01', responders: 120,
      reached: 643, weekly: [], estimate: { from: '2026-09-01', to: '2026-09-30', reached: 643 } });
    expect(r.rate).toBeCloseTo((120 / 643) * 100, 9);
  });

  it('the fixed override replaces the per-week volume (split by the companies\' measured share)', async () => {
    const { pool: p } = pools();
    const r = await fetchNpsResponseRate(p, ytd, {}, ADMIN, { ...ON, fixedPerWeek: 60 });
    // Majaal 2/3 x 60 = 40 / week x 83 / 7 = 474.3 -> 474; Tika 20 / week x 8 = 160
    expect(r.estimate).toMatchObject({ basis: 'fixed', basisWeeks: 0, basisFrom: null, reached: 634,
      byCompany: [{ companyKey: 1, reached: 474 }, { companyKey: 3, reached: 160 }] });
    expect(r.estimate!.perWeek).toBeCloseTo(60, 9);
  });

  it('the estimate disabled: exactly the measured rate and cards, without even looking for the gap', async () => {
    const { pool: p, queries } = pools();
    const r = await fetchNpsResponseRate(p, ytd, {}, ADMIN, { ...ON, enabled: false, fixedPerWeek: 70 });
    expect(r).toMatchObject({ isEstimated: false, estimateStatus: 'disabled', estimate: null, dateFrom: '2026-10-03', responders: 30, reached: 120, rate: 25 });
    expect(queries.some((q) => q.sql.includes('MIN(f.RatingDateKey)'))).toBe(false);
    const reach = await fetchNpsReach(pools().pool, ytd, {}, ADMIN, { ...ON, enabled: false });
    expect(reach).toMatchObject({ isEstimated: false, estimateStatus: 'disabled', totals: { delivered: 50, read: 70 } });
  });

  it('a company filter: only that company, from its own first rating, with its own per-week volume and errors', async () => {
    const three = pools();
    const r3 = await fetchNpsResponseRate(three.pool, ytd, { companyKeys: [3] }, ADMIN, ON);
    expect(r3.estimate).toMatchObject({ perWeek: 50, from: '2026-08-08', reached: 400, byCompany: [{ companyKey: 3 }] });
    for (const q of three.queries.filter((x) => /MIN\(f\.RatingDateKey\)|GROUP BY m\.CompanyKey|fact_process_nps_message/.test(x.sql))) expect(q.params).toContain(3);
    const reach = await fetchNpsReach(pools().pool, ytd, { companyKeys: [3] }, ADMIN, ON);
    expect(reach.gap).toMatchObject({ delivered: 120, read: 280, notDelivered: 40, error: 10 });
  });

  it('excluded weeks (the Meta outage) leave the basis; the per-week volume averages only the others', async () => {
    const { pool: p, queries } = pools({ ...GAP, mix: { 1: [30, 70, 10], 3: [15, 35, 5] } });
    const r = await fetchNpsResponseRate(p, ytd, {}, ADMIN, { ...ON, excludeWeeks: ['2026-10-10'] });
    expect(r.estimate).toMatchObject({ basisWeeks: 1, basisFrom: '2026-10-03', basisTo: '2026-10-09', excludedWeeks: ['2026-10-10'], perWeek: 150 });
    expect(queries.find((q) => q.sql.includes('GROUP BY m.CompanyKey'))!.params).toEqual([20261003, 20261009, 1, 3]);
  });

  it('no complete measured week yet: no estimate, status no_basis, the measured rate and cards as before', async () => {
    const r = await fetchNpsResponseRate(pools({ ...GAP, loadedAt: '2026-10-08 08:00:00' }).pool, ytd, {}, ADMIN, ON);
    expect(r).toMatchObject({ isEstimated: false, estimateStatus: 'no_basis', estimate: null, dateFrom: '2026-10-03', responders: 30, reached: 120, rate: 25 });
    const reach = await fetchNpsReach(pools({ ...GAP, loadedAt: '2026-10-08 08:00:00' }).pool, ytd, {}, ADMIN, ON);
    expect(reach).toMatchObject({ isEstimated: false, estimateStatus: 'no_basis', gap: null, totals: { delivered: 50, read: 70 } });
  });
});

/** A Tripoli (app zone) wall-clock time as the UTC DATETIME the database keeps in created_at. */
const utcOfLocal = (local: string) => DateTime.fromSQL(local, { zone: getAppTimezone() }).toUTC().toFormat('yyyy-MM-dd HH:mm:ss');

describe('follow-up summary (live from nps_followup_case)', () => {
  const NOW_LOCAL = '2026-10-20 12:00:00';
  const STATUS: Record<string, string | null> = { NEW: 'OPEN', CONTACTED: 'OPEN', IN_PROGRESS: 'OPEN', RESOLVED: 'CLOSE', REJECTED: 'DISPUTED', HISTORICAL: null };
  // 1 = Delivery › Late deliveries, 2 = Product Quality › Not specified (the category's own row), 3 = Delivery › Damaged goods
  const CAT: Record<number, [string, string, number, string | null]> = {
    1: ['delivery', 'Delivery & Logistics', 5, 'Late deliveries'], 2: ['quality', 'Product Quality', 1, null], 3: ['delivery', 'Delivery & Logistics', 5, 'Damaged goods'],
  };
  // created_at is UTC (the case was created at the rating time, in the app's zone)
  const utc = utcOfLocal;
  const row = (stage: string | null, rated: string, resolved: string | null, reasonId: number | null) => ({
    case_id: stage ? 1 : null, stage, status: stage ? STATUS[stage] : null, rated_at_local: rated, created_at: stage ? utc(rated) : null,
    contacted_at: null, resolved_at: resolved, reason_id: reasonId,
    category_key: reasonId ? CAT[reasonId][0] : null, category_en: reasonId ? CAT[reasonId][1] : null,
    category_ar: reasonId ? `${CAT[reasonId][1]}-ar` : null, category_sort: reasonId ? CAT[reasonId][2] : null,
    sub_reason_en: reasonId ? CAT[reasonId][3] : null, sub_reason_ar: reasonId && CAT[reasonId][3] ? `${CAT[reasonId][3]}-ar` : null,
    sort_order: reasonId, requires_note: 0,
  });

  it('Unresolved is counted as Disputed, appears in its stage drill-down, and is excluded from SLA ageing', async () => {
    const { pool: p } = pool(() => [{ ...row('REJECTED', '2026-10-05 10:00:00', null, null), stage: 'UNRESOLVED', status: 'DISPUTED' }]);
    const s = await fetchNpsFollowupSummary(p, parseNpsQuery({}, NOW), {}, NOW_LOCAL);
    expect(s).toMatchObject({ charted: 1, unresolved: 1, rejected: 0 });
    expect(s.byStatus.find(x => x.key === 'DISPUTED')).toMatchObject({ count: 1, stages: [{ stage: 'UNRESOLVED', count: 1 }, { stage: 'REJECTED', count: 0 }] });
    expect(s.ageing.buckets.every(b => b.resolved === 0 && b.open === 0)).toBe(true);
  });

  it('one total for every chart (cases with a status, Rejected included); resolved by time; status with its stages; Historical apart', async () => {
    const { pool: p, queries } = pool(() => [
      row('RESOLVED', '2026-10-01 10:00:00', '2026-10-02 09:00:00', 1),   // 23 h
      row('RESOLVED', '2026-10-01 10:00:00', '2026-10-03 10:00:00', 3),   // 48 h -> yellow
      row('RESOLVED', '2026-10-01 10:00:00', '2026-10-06 10:00:01', 2),   // > 5 days
      row('NEW', '2026-10-19 10:00:00', null, null),
      row('IN_PROGRESS', '2026-10-05 10:00:00', null, 2),
      row('REJECTED', '2026-10-05 10:00:00', null, 1),
      row('HISTORICAL', '2026-08-05 10:00:00', null, null),
      row('HISTORICAL', '2026-09-05 10:00:00', null, null),
      row(null, '2026-10-20 08:00:00', null, null), // rated after the last process_nps run: no case yet
    ]);
    const s = await fetchNpsFollowupSummary(p, parseNpsQuery({}, NOW), {}, NOW_LOCAL);
    // Resolved Ageing (from created_at): resolved 23 h / 48 h / 120 h+1 s; open 26 h (New) and 362 h (In progress); Rejected left out
    expect(Object.fromEntries(s.ageing.buckets.map((b) => [b.key, [b.resolved, b.open]]))).toEqual({
      d1: [1, 0], d2: [1, 1], d5: [0, 0], d10: [1, 0], d30: [0, 1], dmax: [0, 0] });
    expect(s.ageing.closedInSla).toEqual({ count: 2, of: 3 }); // 3 resolved (2 within 5 d)
    expect(s.ageing.contactedInSla).toEqual({ count: 0, of: 5 }); // nobody has a contacted_at
    // the status counts come from the status column: Rejected is Disputed, Historical has none; each with its stages
    expect(s.byStatus).toEqual([
      { key: 'OPEN', count: 2, stages: [{ stage: 'NEW', count: 1 }, { stage: 'CONTACTED', count: 0 }, { stage: 'IN_PROGRESS', count: 1 }] },
      { key: 'CLOSE', count: 3, stages: [{ stage: 'RESOLVED', count: 3 }] },
      { key: 'DISPUTED', count: 1, stages: [{ stage: 'UNRESOLVED', count: 0 }, { stage: 'REJECTED', count: 1 }] },
    ]);
    expect(s).toMatchObject({ detractors: 9, charted: 6, rejected: 1, historical: 2, noCase: 1 });
    expect(s.charted + s.historical + s.noCase).toBe(s.detractors);
    // the same total in the centre of every chart
    const sum = (xs: { count: number }[]) => xs.reduce((n, x) => n + x.count, 0);
    expect([sum(s.byReason), sum(s.byStatus)]).toEqual([s.charted, s.charted]);
    const ageingTotal = s.ageing.buckets.reduce((n, b) => n + b.resolved + b.open, 0);
    expect(ageingTotal).toBe(s.charted - s.rejected); // the ageing chart: every charted case but Rejected
    for (const st of s.byStatus) expect(sum(st.stages)).toBe(st.count);
    // by category, most cases first; a tie keeps the categories' order; "Not yet classified" for cases without a reason
    // each category carries its sub-reasons for the drill-down ("Not specified" = the category's own row); Rejected counted
    expect(s.byReason).toEqual([
      { categoryKey: 'delivery', label: 'Delivery & Logistics', labelAr: 'Delivery & Logistics-ar', count: 3,
        subReasons: [{ reasonId: 1, label: 'Late deliveries', labelAr: 'Late deliveries-ar', count: 2 },
          { reasonId: 3, label: 'Damaged goods', labelAr: 'Damaged goods-ar', count: 1 }] },
      { categoryKey: 'quality', label: 'Product Quality', labelAr: 'Product Quality-ar', count: 2,
        subReasons: [{ reasonId: 2, label: 'Not specified', labelAr: 'غير محدد', count: 2 }] },
      { categoryKey: null, label: 'Not yet classified', labelAr: null, count: 1, subReasons: [] },
    ]);
    for (const c of s.byReason) if (c.subReasons.length) expect(c.subReasons.reduce((n, x) => n + x.count, 0)).toBe(c.count);
    expect(s.byReason.reduce((n, r) => n + r.count, 0)).toBe(s.charted);
    expect(queries[0].sql).toContain('LEFT JOIN nps_followup_case fc');
    expect(queries[0].sql).toContain('LEFT JOIN dim_nps_reason r');
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

  it('detractor rows: stage / status / reason / owner / time open from the case; order and delivery link with and without a picking id', async () => {
    const old = process.env.ODOO_URL;
    process.env.ODOO_URL = 'https://erp.example.com';
    try {
      const { pool: p } = pool((sql) => (sql.includes('COUNT(*) AS n') ? [{ n: 2 }] : [
        { response_id: 1, rated_at_local: '2026-10-10 10:00:00', CompanyKey: 3, CustomerKey: 100, order_ref: 'S1', delivery_code: 'TIKA/OUT/1',
          SalesOrderKey: 4000, PickingID: 7001, case_id: 11, stage: 'NEW', status: 'OPEN', case_created_at: utcOfLocal('2026-10-10 10:00:00'), contacted_at: null, resolved_at: null,
          category_en: 'Delivery & Logistics', category_ar: 'التوصيل', sub_reason_en: 'Late deliveries', sub_reason_ar: 'تأخر التوصيل', requires_note: 0, owner_name: 'Amal' },
        { response_id: 2, rated_at_local: '2026-10-10 10:00:00', CompanyKey: 1, CustomerKey: 101, order_ref: 'S2', delivery_code: 'WH/OUT/2',
          SalesOrderKey: -1, PickingID: -1, case_id: 12, stage: 'RESOLVED', status: 'CLOSE', case_created_at: utcOfLocal('2026-10-10 10:00:00'), contacted_at: null, resolved_at: '2026-10-11 10:00:00',
          category_en: null, category_ar: null, sub_reason_en: null, sub_reason_ar: null, requires_note: null, owner_name: null },
      ]));
      const page = await fetchNpsDetractors(p, parseNpsQuery({}, NOW), {}, '2026-10-20 10:00:00');
      expect(page.rows[0]).toMatchObject({ caseId: 11, stage: 'NEW', status: 'OPEN', reason: 'Delivery & Logistics › Late deliveries',
        reasonAr: 'التوصيل › تأخر التوصيل', owner: 'Amal', hoursOpen: 240,
        sla: { band: 'red', rule: 'close_missed', overByHours: 120 },
        orderUrl: 'https://erp.example.com/web#id=4000&model=sale.order&view_type=form&cids=3',
        deliveryUrl: 'https://erp.example.com/web#id=7001&model=stock.picking&view_type=form&cids=3' });
      expect(page.rows[1]).toMatchObject({ caseId: 12, stage: 'RESOLVED', status: 'CLOSE', reason: null, hoursOpen: 24, sla: { band: 'green', rule: 'resolved_in_sla' }, orderUrl: null, deliveryUrl: null });
    } finally {
      if (old === undefined) delete process.env.ODOO_URL;
      else process.env.ODOO_URL = old;
    }
  });
});
