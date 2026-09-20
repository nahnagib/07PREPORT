import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import {
  DAILY_CRITICAL_NUMBER,
  computeDailyCriticalNumber,
  computeForcedClosuresYtd,
  computeOfficialHolidaysYtd,
  computeWorkingDaysYtd,
} from '../criticalNumber';
import { dateOnlyUTC } from '../filters';

/**
 * Covers the highest-risk new logic from the 2026-09 admin-panel revision pass:
 * official_holidays/forced_closures replaced fact_offdays as this page's off-day source (see
 * criticalNumber.ts's "Official Holidays / Forced Closures access" section), which introduced two
 * new expansion behaviors that didn't exist before -- a `recurring` holiday re-anchoring to every
 * year a query window spans, and a multi-day `duration_days` closure expanding into one occurrence
 * per covered day. Mocks pool.query by inspecting the SQL text, same convention as
 * tachometer.test.ts's makeMockPool.
 *
 * Dates are built with the LOCAL Date constructor (`new Date(y, m, d)`), not `Date.UTC(...)` --
 * this matches how fetchOfficialHolidayRows/fetchForcedClosureRows read a real mysql2 DATE value
 * back (local getters: `stored.getMonth()`/`.getDate()`), so the test stays correct regardless of
 * the test runner's own timezone.
 */
function makeMockPool(responses: {
  officialHolidays?: unknown[];
  forcedClosures?: unknown[];
  branchNames?: unknown[];
}): Pool {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM official_holidays')) {
      return [responses.officialHolidays ?? []];
    }
    if (sql.includes('FROM forced_closures')) {
      return [responses.forcedClosures ?? []];
    }
    if (sql.includes('FROM dim_salesteam')) {
      return [responses.branchNames ?? []];
    }
    throw new Error(`Unexpected SQL in test mock: ${sql.slice(0, 120)}`);
  });
  return { query } as unknown as Pool;
}

describe('official_holidays -- recurring holiday expansion', () => {
  it('a recurring holiday appears on the query-window year even though its stored date is a different year', async () => {
    const anchor = dateOnlyUTC(2026, 3, 10);
    const pool = makeMockPool({
      officialHolidays: [
        // Stored as 2020-03-03, but recurring=true -- fetchOfficialHolidayRows must re-anchor
        // (month=2 zero-based, day=3) onto 2026.
        { holidayName: 'Test Recurring Day', holidayDate: new Date(2020, 2, 3), recurring: 1, company: null },
      ],
    });
    const result = await computeOfficialHolidaysYtd(pool, anchor, {}, new Map());
    expect(result.value).toBe(1);
    expect(result.items).toEqual([{ date: '2026-03-03', company: null, branch: null, holidayName: 'Test Recurring Day' }]);
  });

  it('a one-time (non-recurring) holiday only appears in the year it was stored for', async () => {
    const anchor = dateOnlyUTC(2026, 3, 10);
    const pool = makeMockPool({
      officialHolidays: [{ holidayName: 'One-Off Day', holidayDate: new Date(2026, 2, 3), recurring: 0, company: null }],
    });
    const result = await computeOfficialHolidaysYtd(pool, anchor, {}, new Map());
    expect(result.value).toBe(1);
    expect(result.items[0].date).toBe('2026-03-03');
  });

  it('a recurring holiday reduces Working Days YTD by exactly one day', async () => {
    const anchor = dateOnlyUTC(2026, 3, 10);
    const companyNames = new Map<number, string>();
    const withHoliday = await computeWorkingDaysYtd(
      makeMockPool({ officialHolidays: [{ holidayName: 'Test Day', holidayDate: new Date(2020, 2, 3), recurring: 1, company: null }] }),
      anchor,
      {},
      companyNames,
    );
    const withoutHoliday = await computeWorkingDaysYtd(makeMockPool({ officialHolidays: [] }), anchor, {}, companyNames);
    // March 3 2026 is a Tuesday (not a weekly rest day), so it's a clean +1 working-day exclusion.
    expect(withoutHoliday.value - withHoliday.value).toBe(1);
  });
});

describe('forced_closures -- multi-day duration expansion', () => {
  it('a closure spanning multiple days expands into one occurrence per day, clipped to the query window', async () => {
    const anchor = dateOnlyUTC(2026, 1, 10); // YTD window = Jan 1-10
    const pool = makeMockPool({
      forcedClosures: [
        // Starts Jan 8, runs 5 days (Jan 8-12) -- only Jan 8/9/10 fall inside the Jan 1-10 window.
        { branch: 'TK-BEN-BC-03', company: 'Tika', closureDate: new Date(2026, 0, 8), durationDays: 5, reason: 'Storm' },
      ],
      branchNames: [{ branchKey: 'TK-BEN-BC-03', branchName: 'Benghazi Branch Code 03' }],
    });
    const result = await computeForcedClosuresYtd(pool, anchor, {}, new Map());
    expect(result.value).toBe(3);
    expect(result.branches).toHaveLength(1);
    expect(result.branches[0].branchName).toBe('Benghazi Branch Code 03');
    expect(result.branches[0].days).toBe(3);
    expect(result.branches[0].occurrences.map((o) => o.date)).toEqual(['2026-01-10', '2026-01-09', '2026-01-08']);
    expect(result.branches[0].occurrences.every((o) => o.reason === 'Storm')).toBe(true);
  });

  it('a single-day closure (duration_days defaults effectively to 1) produces exactly one occurrence', async () => {
    const anchor = dateOnlyUTC(2026, 1, 10);
    const pool = makeMockPool({
      forcedClosures: [{ branch: 'TK-BEN-BC-03', company: 'Tika', closureDate: new Date(2026, 0, 5), durationDays: 1, reason: null }],
      branchNames: [],
    });
    const result = await computeForcedClosuresYtd(pool, anchor, {}, new Map());
    expect(result.value).toBe(1);
    expect(result.branches[0].occurrences).toEqual([{ date: '2026-01-05', reason: null }]);
    // No matching dim_salesteam row -- falls back to the raw branch code (see
    // computeForcedClosuresYtd's branchNamesByKey.get(branch) ?? branch).
    expect(result.branches[0].branchName).toBe('TK-BEN-BC-03');
  });
});

/**
 * Regression coverage for the Critical Number page crash: applying a Company or Customer Group
 * filter used to 500 the entire page because sumCompanyPct/sumSegmentPct's query against
 * admin_company/admin_customer_group.critical_number_pct threw (the column didn't exist on the
 * connected DB yet -- migration 0021_critical_number_allocation.sql shipped in code before it was
 * applied to the warehouse) and nothing caught it. These tests pin: (a) the scaling math itself,
 * and (b) that a failing percentage lookup degrades to unscaled (100%) instead of throwing, since
 * every widget on the page shares this one computation (routes/criticalNumber.ts's /overview).
 */
function makePctMockPool(opts: {
  companyRows?: { pct: number }[];
  segmentRows?: { pct: number }[];
  throwOnCompany?: boolean;
  throwOnSegment?: boolean;
}): Pool {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM admin_company')) {
      if (opts.throwOnCompany) throw Object.assign(new Error("Unknown column 'critical_number_pct' in 'field list'"), { code: 'ER_BAD_FIELD_ERROR' });
      return [opts.companyRows ?? []];
    }
    if (sql.includes('FROM admin_customer_group')) {
      if (opts.throwOnSegment) throw Object.assign(new Error("Unknown column 'critical_number_pct' in 'field list'"), { code: 'ER_BAD_FIELD_ERROR' });
      return [opts.segmentRows ?? []];
    }
    throw new Error(`Unexpected SQL in test mock: ${sql.slice(0, 120)}`);
  });
  return { query } as unknown as Pool;
}

describe('computeDailyCriticalNumber -- Company/Customer Group percentage scaling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('no Company or Customer Group filter leaves the base figure unscaled', async () => {
    const pool = makePctMockPool({});
    const result = await computeDailyCriticalNumber(pool, dateOnlyUTC(2026, 3, 10), {}, new Map());
    expect(result).toBe(DAILY_CRITICAL_NUMBER);
  });

  it('a Company filter alone scales by that company\'s pct (Majaal 47.44%)', async () => {
    const pool = makePctMockPool({ companyRows: [{ pct: 47.44 }] });
    const result = await computeDailyCriticalNumber(pool, dateOnlyUTC(2026, 3, 10), { companyKeys: [1] }, new Map());
    expect(result).toBeCloseTo(DAILY_CRITICAL_NUMBER * 0.4744, 6);
  });

  it('a Customer Group filter alone scales by that group\'s pct (B2B 62.88%)', async () => {
    const pool = makePctMockPool({ segmentRows: [{ pct: 62.88 }] });
    const result = await computeDailyCriticalNumber(pool, dateOnlyUTC(2026, 3, 10), { segmentKeys: [1] }, new Map());
    expect(result).toBeCloseTo(DAILY_CRITICAL_NUMBER * 0.6288, 6);
  });

  it('Company + Customer Group filters cascade (multiply), not add', async () => {
    const pool = makePctMockPool({ companyRows: [{ pct: 47.44 }], segmentRows: [{ pct: 62.88 }] });
    const result = await computeDailyCriticalNumber(
      pool,
      dateOnlyUTC(2026, 3, 10),
      { companyKeys: [1], segmentKeys: [1] },
      new Map(),
    );
    expect(result).toBeCloseTo(DAILY_CRITICAL_NUMBER * 0.4744 * 0.6288, 6);
  });

  it('a selected group with no percentage-config row (e.g. Backoffice/Inter Company) contributes 0, not an error', async () => {
    // Backoffice/Inter Company aren't seeded by migration 0021 -- the query legitimately returns no
    // rows for their etl_segment_key, which is the designed "default 0% until an admin sets a real
    // percentage" behavior, not a failure.
    const pool = makePctMockPool({ segmentRows: [] });
    const result = await computeDailyCriticalNumber(pool, dateOnlyUTC(2026, 3, 10), { segmentKeys: [3] }, new Map());
    expect(result).toBe(0);
  });

  it('a failing percentage lookup (e.g. critical_number_pct column missing) degrades to unscaled instead of throwing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const pool = makePctMockPool({ throwOnCompany: true, throwOnSegment: true });
    await expect(
      computeDailyCriticalNumber(pool, dateOnlyUTC(2026, 3, 10), { companyKeys: [1], segmentKeys: [1] }, new Map()),
    ).resolves.toBe(DAILY_CRITICAL_NUMBER);
  });
});
