import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { computeBreakdown, fetchTargetForMonths } from '../tachometer';
import { dateOnlyUTC } from '../filters';

/**
 * Covers the admin target-override blending added to fetchTargetForMonths/
 * fetchTargetForMonthsGrouped (see tachometer.ts's docstring above fetchMonthlyOverrideAmounts) --
 * Reports/Dashboards Honor Admin Salesperson Overrides, 2026-09. Mocks pool.query by inspecting
 * the SQL text rather than call order, so these stay robust to reordering within the functions
 * under test.
 */
function makeMockPool(responses: {
  factTargets?: unknown[];
  factTargetsGrouped?: unknown[];
  factSalesLinesGrouped?: unknown[];
  overrides?: unknown[];
}): Pool {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('salesperson_admin_profile') && sql.includes('target_override_amount IS NOT NULL')) {
      return [responses.overrides ?? []];
    }
    if (sql.includes('FROM Fact_Targets') && sql.includes('group_key')) {
      return [responses.factTargetsGrouped ?? []];
    }
    if (sql.includes('FROM Fact_Targets')) {
      return [responses.factTargets ?? []];
    }
    if (sql.includes('FROM Fact_SalesLines')) {
      return [responses.factSalesLinesGrouped ?? []];
    }
    throw new Error(`Unexpected SQL in test mock: ${sql.slice(0, 120)}`);
  });
  return { query } as unknown as Pool;
}

describe('fetchTargetForMonths (ungrouped) -- target-override blending', () => {
  it('no overrides present -> unchanged, real-data-only behavior (regression guard)', async () => {
    const pool = makeMockPool({
      factTargets: [
        { salespersonKey: 1, target_revenue: 1000, target_volume: 10 },
        { salespersonKey: 2, target_revenue: 2000, target_volume: 20 },
      ],
      overrides: [],
    });
    const result = await fetchTargetForMonths(pool, 2026, {}, { month: 7 });
    expect(result).toEqual({ targetRevenue: 3000, targetVolume: 30 });
  });

  it('one overridden salesperson alongside real-data salespeople replaces only their contribution', async () => {
    const pool = makeMockPool({
      factTargets: [
        { salespersonKey: 1, target_revenue: 1000, target_volume: 10 },
        { salespersonKey: 2, target_revenue: 2000, target_volume: 20 },
      ],
      // 1200 / 12 = 100/month
      overrides: [{ salesperson_key: 2, target_override_amount: 1200 }],
    });
    const result = await fetchTargetForMonths(pool, 2026, {}, { month: 7 });
    // salesperson 1 keeps their real 1000; salesperson 2's real 2000 is replaced by 100 * 1 month.
    expect(result.targetRevenue).toBe(1000 + 100);
    // targetVolume is NEVER touched by an override -- no volume-override column exists.
    expect(result.targetVolume).toBe(30);
  });

  it('monthCount scaling: a single month uses 1x the monthly split', async () => {
    const pool = makeMockPool({
      factTargets: [{ salespersonKey: 2, target_revenue: 999_999, target_volume: 1 }],
      overrides: [{ salesperson_key: 2, target_override_amount: 1200 }],
    });
    const result = await fetchTargetForMonths(pool, 2026, {}, { month: 7 });
    expect(result.targetRevenue).toBe(100); // 1200/12 * 1
  });

  it('monthCount scaling: monthLt sums (monthLt - 1) months', async () => {
    const pool = makeMockPool({
      factTargets: [{ salespersonKey: 2, target_revenue: 999_999, target_volume: 1 }],
      overrides: [{ salesperson_key: 2, target_override_amount: 1200 }],
    });
    const result = await fetchTargetForMonths(pool, 2026, {}, { monthLt: 4 }); // Jan-Mar = 3 months
    expect(result.targetRevenue).toBe(300); // 1200/12 * 3
  });

  it('monthCount scaling: no opts (full year) returns the override amount unscaled', async () => {
    const pool = makeMockPool({
      factTargets: [{ salespersonKey: 2, target_revenue: 999_999, target_volume: 1 }],
      overrides: [{ salesperson_key: 2, target_override_amount: 1200 }],
    });
    const result = await fetchTargetForMonths(pool, 2026, {});
    expect(result.targetRevenue).toBe(1200); // 1200/12 * 12 == 1200
  });

  it('a salesperson with an override but zero matching Fact_Targets rows contributes nothing (known, accepted limitation)', async () => {
    const pool = makeMockPool({
      factTargets: [{ salespersonKey: 1, target_revenue: 500, target_volume: 5 }],
      overrides: [{ salesperson_key: 999, target_override_amount: 1200 }], // never appears in factTargets
    });
    const result = await fetchTargetForMonths(pool, 2026, {}, { month: 7 });
    expect(result.targetRevenue).toBe(500);
  });
});

describe('computeBreakdown (grouped) -- target-override blending and re-aggregation', () => {
  it('two overridden salespeople who share a reclassified segment collapse into one summed group row', async () => {
    // Last day of July so monthElapsedFraction(anchor) === 1.0, keeping the expected math simple.
    const anchor = dateOnlyUTC(2026, 7, 31);
    const pool = makeMockPool({
      factSalesLinesGrouped: [{ group_key: '1', group_label: 'B2B', value: 500, volume: 5 }],
      // Raw per-salesperson-per-group rows BEFORE override blending -- both salespeople already
      // fall into effective segment group '1' (e.g. via segment_key_override), same as
      // fetchValueVolumeGrouped's revenue-side reclassification.
      factTargetsGrouped: [
        { salespersonKey: 10, group_key: '1', group_label: 'B2B', target_revenue: 400, target_volume: 4 },
        { salespersonKey: 20, group_key: '1', group_label: 'B2B', target_revenue: 300, target_volume: 3 },
      ],
      // 600/12 = 50/month; 960/12 = 80/month
      overrides: [
        { salesperson_key: 10, target_override_amount: 600 },
        { salesperson_key: 20, target_override_amount: 960 },
      ],
    });

    const rows = await computeBreakdown(pool, anchor, {}, 'mtd', 'value', 'segment');
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.groupKey).toBe('1');
    expect(row.actual).toBe(500);
    // (50*1 + 80*1) collapsed into the shared group, * monthElapsedFraction(anchor) === 1.0.
    expect(row.targetToDate).toBe(130);
  });

  it('targetVolume in the grouped path is never touched by an override', async () => {
    const anchor = dateOnlyUTC(2026, 7, 31);
    const pool = makeMockPool({
      factSalesLinesGrouped: [{ group_key: '1', group_label: 'B2B', value: 100, volume: 50 }],
      factTargetsGrouped: [
        { salespersonKey: 10, group_key: '1', group_label: 'B2B', target_revenue: 400, target_volume: 40 },
      ],
      overrides: [{ salesperson_key: 10, target_override_amount: 1200 }],
    });
    const rows = await computeBreakdown(pool, anchor, {}, 'mtd', 'volume', 'segment');
    // Volume metric's targetToDate comes from target_volume, which stays real (40) regardless of
    // the revenue-side override -- classified against the real, unmodified volume target.
    expect(rows[0].targetToDate).toBe(40);
  });
});
