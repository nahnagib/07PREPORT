import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import {
  asSqlCondition,
  bucketPaceDays,
  computeDailyCriticalNumber,
  computeTargetShare,
  computeDailyCriticalNumberSchedule,
  computeMissingSummary,
  type PaceDay,
  computeForcedClosuresYtd,
  computeOfficialHolidaysYtd,
  computeWorkingDaysYtd,
  computeYearlyCounter,
  computeMonthlyCounter,
} from '../criticalNumber';
import { dateOnlyUTC, type Filters } from '../filters';

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
    if (sql.includes('FROM dim_sales_team')) {
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
    // No matching dim_sales_team row -- falls back to the raw branch code (see
    // computeForcedClosuresYtd's branchNamesByKey.get(branch) ?? branch).
    expect(result.branches[0].branchName).toBe('TK-BEN-BC-03');
  });
});

/**
 * Daily Critical Number(scope, D) = base(D) x share(scope, year of D), share = the scope's part of that year's revenue
 * target in v_sales_targets (Input/sales_targets.xlsx), 2026-11-09. The mock answers the one v_sales_targets query with
 * per-year { scoped, total } rows and records its SQL and parameters, so each test pins both the clause the filters
 * produce and the arithmetic. 2026 figures from the real file: total 169,164,533; Tika + B2B 73,430,891 (43.408%).
 */
const BASE = 556_462.28;
const TOTAL_2026 = 169_164_533;
type TargetRow = { year: number; scoped: number; total: number };

function makeTargetsPool(targets: TargetRow[] | 'throw', history = [{ id: 1, valueLyd: BASE, effectiveFrom: '2026-01-01' }]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const newestFirst = [...history].reverse().map((r) => ({ ...r, createdBy: null, createdAt: new Date(), note: null }));
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM critical_number_history')) return [newestFirst];
    if (sql.includes('FROM v_sales_targets')) {
      calls.push({ sql, params });
      if (targets === 'throw') throw Object.assign(new Error("Table 'powerBI_Data.v_sales_targets' doesn't exist"), { code: 'ER_NO_SUCH_TABLE' });
      return [targets];
    }
    if (sql.includes('FROM official_holidays')) return [[]];
    if (sql.includes('FROM v_sales_lines')) return [sql.includes('GROUP BY') ? [] : [{ value: 0, volume: 0 }]];
    throw new Error(`Unexpected SQL in test mock: ${sql.slice(0, 120)}`);
  });
  return { pool: { query } as unknown as Pool, calls };
}

/** The condition inside SUM(CASE WHEN ... THEN): what the filters select. */
function scopedCondition(sql: string): string {
  const m = /SUM\(CASE WHEN ([\s\S]*?) THEN t\.Target_Revenue ELSE 0 END\) AS scoped/.exec(sql);
  if (!m) throw new Error(`no scoped CASE WHEN in: ${sql}`);
  return m[1];
}

const D = dateOnlyUTC(2026, 11, 9);

describe('Daily Critical Number share from sales_targets.xlsx', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('no filter: CASE WHEN 1=1, no parameters, share = 1, the base unchanged', async () => {
    const { pool, calls } = makeTargetsPool([{ year: 2026, scoped: TOTAL_2026, total: TOTAL_2026 }]);
    const schedule = await computeDailyCriticalNumberSchedule(pool, {});
    expect(scopedCondition(calls[0].sql)).toBe('1=1');
    expect(calls[0].params).toEqual([]);
    expect(calls[0].sql).not.toMatch(/\bWHERE\b/); // the denominator has no filter
    expect(schedule.shareFor(D)).toEqual({ share: 1, shareYear: 2026, shareSource: 'current' });
    expect(schedule(D)).toBe(BASE);
    await expect(computeTargetShare(pool, {}, 2026)).resolves.toEqual({ share: 1, shareYear: 2026, shareSource: 'current' });
  });

  it('asSqlCondition: an empty clause is 1=1, a leading WHERE / AND is dropped', () => {
    expect(asSqlCondition('')).toBe('1=1');
    expect(asSqlCondition('  ')).toBe('1=1');
    expect(asSqlCondition('1=1')).toBe('1=1');
    expect(asSqlCondition('WHERE t.CompanyKey IN (?)')).toBe('t.CompanyKey IN (?)');
    expect(asSqlCondition(' and t.CompanyKey IN (?)')).toBe('t.CompanyKey IN (?)');
  });

  it.each([
    ['Company', { companyKeys: [3] }, /^t\.CompanyKey IN \(\?\)$/, [3]],
    ['Customer Group (override-aware)', { segmentKeys: [1] }, /segment_key_override[\s\S]*t\.SegmentKey[\s\S]*IN \(\?\)$/, [1]],
    ['Distribution Channel (override-aware)', { channelKeys: [2] }, /channel_key_override[\s\S]*t\.ChannelKey[\s\S]*IN \(\?\)$/, [2]],
    ['Branch (override-aware)', { salesTeamKeys: ['TK-EST-BB'] }, /sales_team_key_override[\s\S]*t\.SalesTeamKey[\s\S]*IN \(\?\)$/, ['TK-EST-BB']],
    ['Salesperson', { salespersonKeys: [37] }, /^t\.SalespersonKey IN \(\?\)$/, [37]],
  ] as const)('%s filter: one condition on the targets, share = scoped / total', async (_label, filters, condition, params) => {
    const scoped = 38_039_885;
    const { pool, calls } = makeTargetsPool([{ year: 2026, scoped, total: TOTAL_2026 }]);
    const schedule = await computeDailyCriticalNumberSchedule(pool, filters as unknown as Filters);
    expect(scopedCondition(calls[0].sql)).toMatch(condition);
    expect(calls[0].params).toEqual(params);
    expect(schedule(D)).toBeCloseTo(BASE * (scoped / TOTAL_2026), 6);
  });

  it('a Customer filter is ignored: targets have no customer', async () => {
    const { pool, calls } = makeTargetsPool([{ year: 2026, scoped: TOTAL_2026, total: TOTAL_2026 }]);
    await computeDailyCriticalNumberSchedule(pool, { customerKeys: [42] });
    expect(scopedCondition(calls[0].sql)).toBe('1=1');
    expect(calls[0].params).toEqual([]);
  });

  it('Company x Customer Group is one joint share from the targets, not the product of two shares (Tika + B2B = 0.43408)', async () => {
    const { pool, calls } = makeTargetsPool([{ year: 2026, scoped: 73_430_891, total: TOTAL_2026 }]);
    const share = await computeTargetShare(pool, { companyKeys: [3], segmentKeys: [1] }, 2026);
    const cond = scopedCondition(calls[0].sql);
    expect(cond).toMatch(/^t\.CompanyKey IN \(\?\) AND [\s\S]*segment_key_override[\s\S]*IN \(\?\)$/);
    expect(calls[0].params).toEqual([3, 1]);
    expect(calls).toHaveLength(1);
    expect(share.share).toBeCloseTo(0.43408, 5);
    expect(share.share).not.toBeCloseTo(0.52622 * 0.62961, 3);
  });

  it('multi-select sums the selected members (IN with one parameter each)', async () => {
    const { pool, calls } = makeTargetsPool([{ year: 2026, scoped: 80_000_000, total: TOTAL_2026 }]);
    const schedule = await computeDailyCriticalNumberSchedule(pool, { salespersonKeys: [37, 19, 1] });
    expect(scopedCondition(calls[0].sql)).toBe('t.SalespersonKey IN (?, ?, ?)');
    expect(calls[0].params).toEqual([37, 19, 1]);
    expect(schedule(D)).toBeCloseTo(BASE * (80_000_000 / TOTAL_2026), 6);
  });

  it('a person whose target is 0 gets 0 -- not the full base', async () => {
    const { pool } = makeTargetsPool([{ year: 2026, scoped: 0, total: TOTAL_2026 }]);
    const schedule = await computeDailyCriticalNumberSchedule(pool, { salespersonKeys: [32] });
    expect(schedule(D)).toBe(0);
    expect(schedule.shareFor(D)).toEqual({ share: 0, shareYear: 2026, shareSource: 'current' });
  });

  it('a year with no targets (or a total of 0) uses the latest earlier year that has them, with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { pool } = makeTargetsPool([
      { year: 2024, scoped: 10, total: 100 },
      { year: 2025, scoped: 25, total: 100 },
      { year: 2027, scoped: 0, total: 0 },
    ]);
    const schedule = await computeDailyCriticalNumberSchedule(pool, { companyKeys: [1] });
    expect(schedule.shareFor(D)).toEqual({ share: 0.25, shareYear: 2025, shareSource: 'fallback' });
    expect(schedule(D)).toBeCloseTo(BASE * 0.25, 6);
    expect(schedule.shareFor(dateOnlyUTC(2027, 3, 1))).toEqual({ share: 0.25, shareYear: 2025, shareSource: 'fallback' });
    expect(schedule.shareFor(dateOnlyUTC(2025, 3, 1)).shareSource).toBe('current');
    expect(warn).toHaveBeenCalledTimes(2); // once per fallback year, not once per day
    expect(String(warn.mock.calls[0][0])).toContain('no targets for 2026');
  });

  it('no targets in any year up to the date: factor 1, flagged missing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { pool } = makeTargetsPool([{ year: 2027, scoped: 10, total: 100 }]);
    const schedule = await computeDailyCriticalNumberSchedule(pool, { companyKeys: [1] });
    expect(schedule(D)).toBe(BASE);
    expect(schedule.shareFor(D)).toEqual({ share: 1, shareYear: null, shareSource: 'missing' });
  });

  it('a failing targets query keeps the page up: logged, factor 1, flagged error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { pool } = makeTargetsPool('throw');
    const schedule = await computeDailyCriticalNumberSchedule(pool, { companyKeys: [1], segmentKeys: [1] });
    expect(schedule(D)).toBe(BASE);
    expect(schedule.shareFor(D)).toEqual({ share: 1, shareYear: null, shareSource: 'error' });
    expect(error).toHaveBeenCalledTimes(1);
    await expect(computeDailyCriticalNumber(pool, D, { companyKeys: [1] }, new Map())).resolves.toBe(BASE);
    await expect(computeTargetShare(pool, { companyKeys: [1] }, 2026)).rejects.toThrow(/v_sales_targets/);
  });

  it('a YTD / full-year walk queries the targets once, not once per day', async () => {
    const { pool, calls } = makeTargetsPool([{ year: 2026, scoped: 50, total: 100 }]);
    const schedule = await computeDailyCriticalNumberSchedule(pool, { companyKeys: [1] });
    const yearly = await computeYearlyCounter(pool, D, { companyKeys: [1] }, new Map(), schedule);
    await computeMonthlyCounter(pool, D, { companyKeys: [1] }, new Map(), schedule);
    await computeMissingSummary(pool, D, { companyKeys: [1] }, new Map(), schedule, null);
    expect(calls).toHaveLength(1);
    // 2026: 313 working days, every one at base x 0.5
    expect(yearly.periodTarget).toBeCloseTo(313 * BASE * 0.5, 4);
  });
});

// ---------------------------------------------------------------------------
// Missing Value / Missing Days -- in-progress day and expanded-view bucketing
// ---------------------------------------------------------------------------

function makeSalesMockPool(dailyValues: Record<number, number>): Pool {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM v_sales_lines')) {
      return [Object.entries(dailyValues).map(([dateKey, value]) => ({ dateKey: Number(dateKey), value }))];
    }
    if (sql.includes('FROM official_holidays')) return [[]];
    throw new Error(`Unexpected SQL in test mock: ${sql.slice(0, 120)}`);
  });
  return { query } as unknown as Pool;
}

describe('computeMissingSummary -- in-progress day', () => {
  // 2026-01-01 (Thu) .. 2026-01-05 (Mon): Jan 2 is a Friday (rest day), so 4 working days.
  // Every finished working day hits the Critical Number exactly; Jan 5 (the anchor, still
  // trading) has no sales loaded yet.
  const dcn = 100;
  const anchor = dateOnlyUTC(2026, 1, 5);
  const sales = { 20260101: 100, 20260103: 100, 20260104: 100 };

  it('keeps the in-progress day in the headline figures (matches the Yearly Counter gap)', async () => {
    const result = await computeMissingSummary(makeSalesMockPool(sales), anchor, {}, new Map(), dcn, anchor);
    expect(result.missingValue.value).toBe(100);
    expect(result.missingDays.value).toBe(1);
  });

  it('leaves the in-progress day out of the trend series, so it does not end in a false plunge', async () => {
    const withToday = await computeMissingSummary(makeSalesMockPool(sales), anchor, {}, new Map(), dcn, null);
    const withoutToday = await computeMissingSummary(makeSalesMockPool(sales), anchor, {}, new Map(), dcn, anchor);
    expect(withToday.missingDays.trendValues).toEqual([0, 0, 0, 0, 1]);
    expect(withoutToday.missingDays.trendValues).toEqual([0, 0, 0, 0]);
  });
});

describe('bucketPaceDays', () => {
  const dcn = 100;
  // 2026-01-01 (Thu) .. 2026-01-10 (Sat). Fridays (Jan 2, Jan 9) are rest days.
  const days: PaceDay[] = Array.from({ length: 10 }, (_, i) => {
    const date = dateOnlyUTC(2026, 1, i + 1);
    return { date, isWorkingDay: date.getUTCDay() !== 5, actual: 80 };
  });

  it('daily: one row per calendar day, gap signed as Actual - Target, running totals carried', () => {
    const rows = bucketPaceDays(days, dcn, 'daily', null);
    expect(rows).toHaveLength(10);
    expect(rows[0]).toMatchObject({ start: '2026-01-01', workingDays: 1, target: 100, actual: 80, gapValue: -20, gapDays: -0.2 });
    // Friday: no target, the day's sales count as pure surplus.
    expect(rows[1]).toMatchObject({ start: '2026-01-02', workingDays: 0, target: 0, gapValue: 80 });
    expect(rows[9].cumulativeTarget).toBe(800);
    expect(rows[9].cumulativeActual).toBe(800);
    expect(rows[9].cumulativeGap).toBe(0);
  });

  it('weekly: Saturday-to-Friday weeks, first week clipped to Jan 1', () => {
    const rows = bucketPaceDays(days, dcn, 'weekly', null);
    expect(rows.map((r) => [r.start, r.end, r.workingDays])).toEqual([
      ['2026-01-01', '2026-01-02', 1],
      ['2026-01-03', '2026-01-09', 6],
      ['2026-01-10', '2026-01-10', 1],
    ]);
    expect(rows[1].target).toBe(600);
    expect(rows[1].actual).toBe(560);
  });

  it('monthly: one row per month; the period holding the in-progress day is flagged', () => {
    const rows = bucketPaceDays(days, dcn, 'monthly', dateOnlyUTC(2026, 1, 10));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ start: '2026-01-01', end: '2026-01-10', workingDays: 8, inProgress: true });
  });

  it('per-period gaps sum to the final cumulative gap', () => {
    for (const granularity of ['daily', 'weekly', 'monthly'] as const) {
      const rows = bucketPaceDays(days, dcn, granularity, null);
      const summed = rows.reduce((acc, r) => acc + r.gapValue, 0);
      expect(summed).toBeCloseTo(rows[rows.length - 1].cumulativeGap, 9);
    }
  });

  it('a dated target: each day at its own value, gap days at the period end value', () => {
    const target = (d: Date) => (d.getUTCDate() >= 5 ? 200 : 100);
    const rows = bucketPaceDays(days, target, 'monthly', null);
    // working days: Jan 1, 3, 4 at 100; Jan 5, 6, 7, 8, 10 at 200
    expect(rows[0].target).toBe(3 * 100 + 5 * 200);
    expect(rows[0].gapDays).toBeCloseTo((800 - 1300) / 200, 9);
  });
});

// ---------------------------------------------------------------------------
// Dated Daily Critical Number (critical_number_history, 2026-10-21)
// ---------------------------------------------------------------------------

/** No holidays, no filters (share 1), the given history; every period sales query returns `value`, the daily query nothing. */
function makeHistoryMockPool(history: { id: number; valueLyd: number; effectiveFrom: string }[], value = 0): Pool {
  const newestFirst = [...history]
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.id - a.id)
    .map((r) => ({ ...r, createdBy: null, createdAt: new Date(), note: null }));
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM critical_number_history')) return [newestFirst];
    if (sql.includes('FROM v_sales_targets')) return [[{ year: 2026, scoped: 100, total: 100 }]];
    if (sql.includes('FROM official_holidays')) return [[]];
    if (sql.includes('FROM v_sales_lines')) return [sql.includes('GROUP BY') ? [] : [{ value, volume: 0 }]];
    throw new Error(`Unexpected SQL in test mock: ${sql.slice(0, 120)}`);
  });
  return { query } as unknown as Pool;
}

describe('dated Daily Critical Number', () => {
  // 2026: 365 days, 52 Fridays -> 313 working days. Nov: 4 Fridays -> 26; Dec: 4 Fridays -> 27.
  const seed = { id: 1, valueLyd: 560_000, effectiveFrom: '2026-01-01' };

  it('a change with a future effective date leaves today and every past month unchanged', async () => {
    const today = dateOnlyUTC(2026, 10, 21);
    const before = makeHistoryMockPool([seed]);
    const after = makeHistoryMockPool([seed, { id: 2, valueLyd: 600_000, effectiveFrom: '2026-11-01' }]);
    const scheduleBefore = await computeDailyCriticalNumberSchedule(before, {});
    const scheduleAfter = await computeDailyCriticalNumberSchedule(after, {});

    expect(await computeDailyCriticalNumber(after, today, {}, new Map())).toBe(560_000);
    expect(scheduleAfter(dateOnlyUTC(2026, 11, 1))).toBe(600_000);

    // The current month and a past month: identical targets before and after the change.
    for (const anchor of [today, dateOnlyUTC(2026, 3, 31)]) {
      const mBefore = await computeMonthlyCounter(before, anchor, {}, new Map(), scheduleBefore);
      const mAfter = await computeMonthlyCounter(after, anchor, {}, new Map(), scheduleAfter);
      expect(mAfter.periodTarget).toBe(mBefore.periodTarget);
      expect(mAfter.expectedValue).toBe(mBefore.expectedValue);
    }
    // Yearly: the elapsed (to-date) target is unchanged; the full-year target picks up Nov + Dec at the new value.
    const yBefore = await computeYearlyCounter(before, today, {}, new Map(), scheduleBefore);
    const yAfter = await computeYearlyCounter(after, today, {}, new Map(), scheduleAfter);
    expect(yAfter.expectedValue).toBe(yBefore.expectedValue);
    expect(yBefore.periodTarget).toBe(313 * 560_000);
    expect(yAfter.periodTarget).toBe((313 - 53) * 560_000 + 53 * 600_000);
  });

  it("monthly target sums each working day at its own value, not today's value x days", async () => {
    const pool = makeHistoryMockPool([seed, { id: 2, valueLyd: 600_000, effectiveFrom: '2026-01-15' }]);
    const schedule = await computeDailyCriticalNumberSchedule(pool, {});
    const jan = await computeMonthlyCounter(pool, dateOnlyUTC(2026, 1, 31), {}, new Map(), schedule);
    // Jan 1-14: Fridays 2, 9 -> 12 working days at 560K; Jan 15-31: Fridays 16, 23, 30 -> 14 at 600K.
    expect(jan.workingDaysTotal).toBe(26);
    expect(jan.periodTarget).toBe(12 * 560_000 + 14 * 600_000);
  });

  it("the scope's target share scales every day's own base value", async () => {
    const newestFirst = [
      { id: 2, valueLyd: 600_000, effectiveFrom: '2026-06-01' },
      { ...seed },
    ].map((r) => ({ ...r, createdBy: null, createdAt: new Date(), note: null }));
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM critical_number_history')) return [newestFirst];
      if (sql.includes('FROM v_sales_targets')) return [[{ year: 2026, scoped: 50, total: 100 }]];
      throw new Error(`Unexpected SQL in test mock: ${sql.slice(0, 120)}`);
    });
    const schedule = await computeDailyCriticalNumberSchedule({ query } as unknown as Pool, { companyKeys: [1] });
    expect(schedule(dateOnlyUTC(2026, 5, 31))).toBe(280_000);
    expect(schedule(dateOnlyUTC(2026, 6, 1))).toBe(300_000);
  });

  it("Missing Value YTD sums the dated targets; Missing Days divides by the anchor day's value", async () => {
    // Jan 1 (Thu) and Jan 3 (Sat) at 560K, Jan 2 is a Friday, Jan 4 and Jan 5 at 200. No sales.
    const pool = makeHistoryMockPool([seed, { id: 2, valueLyd: 200, effectiveFrom: '2026-01-04' }]);
    const schedule = await computeDailyCriticalNumberSchedule(pool, {});
    const result = await computeMissingSummary(pool, dateOnlyUTC(2026, 1, 5), {}, new Map(), schedule, null);
    expect(result.missingValue.expectedValue).toBe(2 * 560_000 + 2 * 200);
    expect(result.missingDays.value).toBe(Math.round((2 * 560_000 + 400) / 200));
  });
});
