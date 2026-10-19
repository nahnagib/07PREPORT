import { describe, expect, it } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { CSAT_SCALE, NPS_SCALE, bandOf, csatBand, minResponders, npsBand } from '../../config/npsThresholds';
import {
  NpsQueryError,
  csatScore,
  fetchNpsDetractors,
  fetchNpsOverview,
  fetchNpsReach,
  fetchNpsTrend,
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

  it('targets and drawn scales', () => {
    expect(NPS_SCALE).toMatchObject({ target: 90, min: 0, max: 100 });
    expect(CSAT_SCALE).toMatchObject({ target: 95, min: 0, max: 100 });
    expect(bandOf(null, NPS_SCALE)).toBeNull();
  });
});

describe('parseNpsQuery', () => {
  it('defaults to this year in Tripoli (1 January -> today), monthly', () => {
    expect(todayLocal(NOW)).toBe('2026-10-18');
    expect(parseNpsQuery({}, NOW)).toMatchObject({ dateFrom: '2026-01-01', dateTo: '2026-10-18', grain: 'month', page: 1, pageSize: 100 });
  });

  it('400s on bad values', () => {
    for (const q of [{ dateFrom: '2026-13-01' }, { dateTo: '18/10/2026' }, { dateFrom: '2026-10-10', dateTo: '2026-10-01' },
      { page: '0' }, { pageSize: '1000' }, { grain: 'week' }]) {
      expect(() => parseNpsQuery(q, NOW), JSON.stringify(q)).toThrow(NpsQueryError);
    }
  });

  it('periods of a range at each grain', () => {
    expect(periodsBetween('2025-11-15', '2026-02-01', 'month')).toEqual([202511, 202512, 202601, 202602]);
    expect(periodsBetween('2025-12-30', '2026-01-02', 'day')).toEqual([20251230, 20251231, 20260101, 20260102]);
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

  it('trend: every period of the range (empty = no value), grouped at the grain, target 90', async () => {
    const { pool, queries } = fakePool(() => [{ p: 202610, promoters: 5, passives: 3, detractors: 2 }]);
    const t = await fetchNpsTrend(pool, parseNpsQuery({ dateFrom: '2026-09-01', dateTo: '2026-10-31' }, NOW), {});
    expect(t.points.map((p) => [p.period, p.responders, p.nps])).toEqual([['2026-09', 0, null], ['2026-10', 10, 30]]);
    expect(t.target).toBe(90);
    expect(queries[0].sql).toContain('GROUP BY FLOOR(f.RatingDateKey / 100)');
    await expect(fetchNpsTrend(pool, parseNpsQuery({ dateFrom: '2020-01-01', dateTo: '2026-10-31', grain: 'day' }, NOW), {})).rejects.toThrow(NpsQueryError);
  });

  it('detractors: level 1 only, with the comments of the same response, paged', async () => {
    const { pool, queries } = fakePool((sql) => (sql.includes('COUNT(*) AS n') ? [{ n: 1 }] : [{ response_id: 19566, CustomerKey: 100, comment: 'شكرا [phone]' }]));
    const page = await fetchNpsDetractors(pool, parseNpsQuery({ page: '2', pageSize: '10' }, NOW), {});
    expect(page).toMatchObject({ total: 1, page: 2, pageSize: 10 });
    expect(page.rows[0]).toMatchObject({ responseId: 19566, comment: 'شكرا [phone]', status: null, reason: null });
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
