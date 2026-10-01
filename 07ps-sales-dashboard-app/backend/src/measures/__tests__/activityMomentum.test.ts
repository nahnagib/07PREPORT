import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Pool } from 'mysql2/promise';
import {
  computeActivityRates,
  activityStatusCaseSql,
  computeOpportunityActivityCounts,
  type OpportunityActivityCountsInternal,
} from '../activityMomentum';
import { dateOnlyUTC } from '../filters';

/**
 * Regression coverage for the 2026-09 fix described in activityMomentum.ts's module header
 * ("Cohort vs. snapshot scoping" / "Ratio double-counting") plus the 2026-09-17 correction (the
 * schema drift: #W/O Activity/#W/O Next Step/Inactive Deals Ratio are computed from
 * HasQuotation/LastQuotationDate/DaysSinceLastQuotation/OpportunityAge/SalesSegment, not the
 * never-deployed HasNextStep/HasRecentActivity/IsInactive columns). Mocks pool.query by inspecting
 * the SQL text, same convention as criticalNumber.test.ts's makeMockPool.
 */

describe('checkActivityColumnsAvailable', () => {
  // checkActivityColumnsAvailable caches its result at module scope (5-minute TTL) -- reset the
  // module registry so each case gets a fresh, un-cached import instead of the previous case's
  // cached answer.
  beforeEach(() => {
    vi.resetModules();
  });

  it('is available when DaysSinceLastQuotation and OpportunityAge both exist on Fact_Opportunity', async () => {
    const { checkActivityColumnsAvailable } = await import('../activityMomentum');
    const query = vi.fn(async () => [[{ cnt: 2 }]]);
    const pool = { query } as unknown as Pool;
    await expect(checkActivityColumnsAvailable(pool)).resolves.toBe(true);
  });

  it('is unavailable when the live schema is missing one or both columns (the actual pre-fix state)', async () => {
    const { checkActivityColumnsAvailable } = await import('../activityMomentum');
    const query = vi.fn(async () => [[{ cnt: 0 }]]);
    const pool = { query } as unknown as Pool;
    await expect(checkActivityColumnsAvailable(pool)).resolves.toBe(false);
  });
});

describe('computeOpportunityActivityCounts -- mutually exclusive statuses (2026-09-30 fix)', () => {
  it('classifies each YTD opportunity once, so the tiles add up to #YTD', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    // Live figures, 2026-01-01..2026-09-30, no filters (see activityMomentum.ts's module header).
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return [[{ totalYtd: 693, active: 127, won: 233, lost: 234, withoutActivity: 80, withoutNextStep: 19, unclassified: 0 }]];
    });
    const pool = { query } as unknown as Pool;

    const r = await computeOpportunityActivityCounts(pool, dateOnlyUTC(2026, 9, 30), {}, true);

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('DATE(fo.OpportunityCreatedDate) BETWEEN ? AND ?');
    expect(calls[0].params).toEqual(['2026-01-01', '2026-09-30']);
    expect(r.active + r.won + r.lost + r.withoutActivity! + r.withoutNextStep! + r.unclassified).toBe(r.totalYtd);
    // Lost is part of #YTD now, so Lost Deals Ratio's denominator is simply #YTD.
    expect(r.totalYtdAll).toBe(r.totalYtd);
  });

  it('keeps the stale opportunities in #Active when the activity columns are unavailable', async () => {
    let sentSql = '';
    const query = vi.fn(async (sql: string) => {
      sentSql = sql;
      return [[{ totalYtd: 5, active: 3, won: 1, lost: 1, withoutActivity: 0, withoutNextStep: 0, unclassified: 0 }]];
    });
    const pool = { query } as unknown as Pool;

    const r = await computeOpportunityActivityCounts(pool, dateOnlyUTC(2026, 6, 30), {}, false);
    expect(sentSql).not.toContain('HasQuotation');
    expect(r.active).toBe(3);
    expect(r.withoutActivity).toBeNull();
    expect(r.withoutNextStep).toBeNull();
  });
});

describe('activityStatusCaseSql -- precedence', () => {
  it('checks Lost, then Won, then the two stale buckets, then Active', () => {
    const sql = activityStatusCaseSql(true);
    const order = ["THEN 'lost'", "THEN 'won'", "THEN 'withoutActivity'", "THEN 'withoutNextStep'", "THEN 'active'", "ELSE 'unclassified'"].map((t) =>
      sql.indexOf(t),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('computeActivityRates -- no double-counting in Inactive Deals Ratio', () => {
  /** Simulates the SQL's `SUM(CASE WHEN fo.IsOpen = 1 AND (<W/O Activity> OR <W/O Next Step>) ...)`
   * against fixture rows, the same way a real MySQL aggregate would -- used so this test's
   * expectation is derived from the fixture, not hand-computed separately. */
  function atRiskCountFor(rows: Array<{ isWithoutActivity: number; isWithoutNextStep: number }>): number {
    return rows.filter((r) => r.isWithoutActivity === 1 || r.isWithoutNextStep === 1).length;
  }

  it('counts an opportunity that is both W/O Activity and W/O Next Step once, not twice', async () => {
    // Row A: without-activity only. Row B: without-next-step only. Row C: BOTH (the overlap case
    // that used to be double-counted by `inactiveCount + withoutNextStepCount`; kept as a
    // hypothetical here even though HasQuotation=0/1 makes the two conditions mutually exclusive
    // under the current schema -- see module header's "Ratio double-counting" note).
    const openRows = [
      { isWithoutActivity: 1, isWithoutNextStep: 0 },
      { isWithoutActivity: 0, isWithoutNextStep: 1 },
      { isWithoutActivity: 1, isWithoutNextStep: 1 },
    ];
    const openCount = openRows.length;
    const atRiskCount = atRiskCountFor(openRows);
    expect(atRiskCount).toBe(3); // distinct at-risk opportunities: A, B, C

    // What the old buggy formula would have produced, for contrast:
    const oldInactiveCount = openRows.filter((r) => r.isWithoutActivity === 1).length; // A, C = 2
    const oldWithoutNextStepCount = openRows.filter((r) => r.isWithoutNextStep === 1).length; // B, C = 2
    expect(oldInactiveCount + oldWithoutNextStepCount).toBe(4); // > openCount: an impossible ratio

    const query = vi.fn(async () => [[{ openCount, atRiskCount }]]);
    const pool = { query } as unknown as Pool;
    const counts: OpportunityActivityCountsInternal = {
      totalYtdAll: 10,
      totalYtd: 8,
      won: 3,
      lost: 2,
      active: 1,
      withoutActivity: 0,
      withoutNextStep: 0,
      unclassified: 0,
    };

    const rates = await computeActivityRates(pool, {}, true, counts);

    expect(rates.inactiveDealsRatio).toBe(1); // 3/3, not 4/3
    expect(rates.inactiveDealsRatio!).toBeLessThanOrEqual(1);
  });

  it('lostDealsRatio stays Lost / totalYtdAll (unaffected by the snapshot fix)', async () => {
    const query = vi.fn(async () => [[{ openCount: 10, atRiskCount: 2 }]]);
    const pool = { query } as unknown as Pool;
    const counts: OpportunityActivityCountsInternal = {
      totalYtdAll: 619,
      totalYtd: 389,
      won: 0,
      lost: 230,
      active: 0,
      withoutActivity: 0,
      withoutNextStep: 0,
      unclassified: 0,
    };
    const rates = await computeActivityRates(pool, {}, true, counts);
    expect(rates.lostDealsRatio).toBeCloseTo(230 / 619, 5);
  });

  it('returns null inactiveDealsRatio and skips the snapshot query when activity columns are unavailable', async () => {
    const query = vi.fn(async () => {
      throw new Error('should not query when activity columns are unavailable');
    });
    const pool = { query } as unknown as Pool;
    const counts: OpportunityActivityCountsInternal = {
      totalYtdAll: 619,
      totalYtd: 389,
      won: 0,
      lost: 230,
      active: 0,
      withoutActivity: null,
      withoutNextStep: null,
      unclassified: 0,
    };
    const rates = await computeActivityRates(pool, {}, false, counts);
    expect(rates.inactiveDealsRatio).toBeNull();
    expect(rates.lostDealsRatio).toBeCloseTo(230 / 619, 5);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('computeActivityRates -- queries the real, live Fact_Opportunity columns', () => {
  /**
   * Guards against reintroducing the 2026-09-17 bug: the SQL must reference the columns that
   * actually exist on the live table (HasQuotation/LastQuotationDate/DaysSinceLastQuotation/
   * OpportunityAge/SalesSegment) and must NOT reference the never-deployed
   * HasNextStep/HasRecentActivity/IsInactive/DaysSinceUpdate columns, which would throw
   * ER_BAD_FIELD_ERROR against the real database.
   */
  it('sends SQL built from the real quotation-staleness columns, not the phantom activity-log ones', async () => {
    let sentSql = '';
    const query = vi.fn(async (sql: string) => {
      sentSql = sql;
      return [[{ openCount: 0, atRiskCount: 0 }]];
    });
    const pool = { query } as unknown as Pool;
    const counts: OpportunityActivityCountsInternal = {
      totalYtdAll: 1, totalYtd: 1, won: 0, lost: 0, active: 0, withoutActivity: 0, withoutNextStep: 0, unclassified: 0,
    };

    await computeActivityRates(pool, {}, true, counts);

    for (const realColumn of ['HasQuotation', 'LastQuotationDate', 'DaysSinceLastQuotation', 'OpportunityAge', "SalesSegment = 'B2B'"]) {
      expect(sentSql).toContain(realColumn);
    }
    for (const phantomColumn of ['HasNextStep', 'HasRecentActivity', 'IsInactive', 'DaysSinceUpdate']) {
      expect(sentSql).not.toContain(phantomColumn);
    }
  });
});
