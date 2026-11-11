import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { computeBreakdown } from '../tachometer';
import { computePersonContributions, computeSalesPeoplePerformance, performanceFigures, performanceStatus } from '../salesPeoplePerformance';
vi.mock('../tachometer', () => ({ computeBreakdown: vi.fn() }));
const pool = {} as Pool;
const row = (key: number | string, actual: number, target: number | null) => ({
  groupKey: key, groupLabel: `Person ${key}`, actual, targetToDate: target,
  status: 'green' as never, variancePct: null,
});
beforeEach(() => vi.resetAllMocks());

describe('achievement boundaries', () => {
  it.each([
    [-1, 'critical'], [0, 'critical'], [50, 'critical'], [50.01, 'need_attention'],
    [90, 'need_attention'], [90.01, 'behind_target'], [99.999, 'behind_target'],
    [100, 'on_target'], [110, 'on_target'], [110.001, 'top_performer'],
  ])('%s%% has exactly one status: %s', (actual, status) => expect(performanceStatus(actual, 100)).toBe(status));
  it.each([0, -1, null])('keeps missing or non-positive target %s out of achievement bands', (target) => {
    expect(performanceFigures(400, target)).toMatchObject({ status: 'no_target', achievement: null, variance: null, variancePct: null });
  });
});

it('keeps target-only and prior-year people, prorated monthly targets and January/December baseline', async () => {
  const filters = { companyKeys: [3], segmentKeys: [1] };
  vi.mocked(computeBreakdown).mockImplementation(async (_pool, anchor, _filters, period) => {
    if (period === 'ytd' && anchor.getUTCFullYear() === 2025) return [row(2, 30, 50)];
    if (period === 'ytd') return [row(1, 0, 100)];
    if (anchor.getUTCFullYear() === 2025) return [row(1, 40, 50)];
    return [row(1, 0, 25)];
  });
  const query = vi.fn(async () => [[]]);
  const result = await computeSalesPeoplePerformance({ query } as unknown as Pool, new Date('2026-01-15T00:00:00Z'), filters);
  // Person 2 only has last-year sales and no positive target this year: left out of the page.
  expect(result.people.map((p) => p.key)).toEqual([1]);
  expect(result.statuses.map((s) => s.key)).not.toContain('no_target');
  expect(result.people.find((p) => p.key === 1)).toMatchObject({ actual: 0, target: 100, status: 'critical',
    months: [{ month: '2026-01', through: '2026-01-15', target: 25, previousActual: 40, momVariancePct: -1, previousStatus: 'need_attention' }] });
  expect(vi.mocked(computeBreakdown).mock.calls.every((c) => c[2] === filters)).toBe(true);
  expect(vi.mocked(computeBreakdown).mock.calls.some((c) => c[1].toISOString().startsWith('2025-12-31'))).toBe(true);
});

it('uses level-specific person numerators and preserves authorized denominator filters', async () => {
  const scope = { companyKeys: [3], segmentKeys: [1], salespersonKeys: [1, 2] };
  vi.mocked(computeBreakdown).mockResolvedValue([row(1, 20, 50), row(2, 80, 150)]);
  const query = vi.fn(async () => [[
    { personKey: 1, companyKey: 3, companyName: 'Tika', segmentKey: 1, segmentName: 'B2B', amount: 20 },
    { personKey: 2, companyKey: 3, companyName: 'Tika', segmentKey: 1, segmentName: 'B2B', amount: 80 },
  ]]);
  const result = await computePersonContributions({ query } as unknown as Pool, new Date('2026-05-01Z'), scope, 1);
  expect(result.rows.map((r) => [r.level, r.revenueShare, r.targetShare])).toEqual([
    ['group', 0.2, 0.25], ['company', 0.2, 0.25], ['segment', 0.2, 0.25],
  ]);
  expect(vi.mocked(computeBreakdown).mock.calls.every((c) => c[2].companyKeys?.[0] === 3 && c[2].segmentKeys?.[0] === 1)).toBe(true);
});

it('allocates one override-aware target across multiple companies without duplication', async () => {
  vi.mocked(computeBreakdown).mockResolvedValue([row(1, 100, 1000)]);
  const query = vi.fn(async () => [[
    { personKey: 1, companyKey: 1, companyName: 'Majaal', segmentKey: 1, segmentName: 'B2B', amount: 25 },
    { personKey: 1, companyKey: 3, companyName: 'Tika', segmentKey: 2, segmentName: 'B2C', amount: 75 },
  ]]);
  const result = await computePersonContributions({ query } as unknown as Pool, new Date('2026-05-01Z'), {}, 1);
  expect(result.rows.find((r) => r.level === 'group')?.target).toBe(1000);
  expect(result.rows.filter((r) => r.level === 'company').map((r) => r.target)).toEqual([250, 750]);
  expect(result.rows.filter((r) => r.level === 'segment').map((r) => r.target)).toEqual([250, 750]);
});

it('returns team-level YTD contributions for people with a target only', async () => {
  vi.mocked(computeBreakdown).mockImplementation(async (_pool, _anchor, _filters, period) =>
    (period === 'ytd' ? [row(1, 60, 200), row(2, 40, null)] : []));
  const atom = (personKey: number, teamKey: string, amount: number) => ({ personKey, companyKey: 1, companyName: 'Majaal',
    segmentKey: 1, segmentName: 'B2B', teamKey, teamName: `Team ${teamKey}`, amount });
  const query = vi.fn()
    .mockResolvedValueOnce([[atom(1, 'A', 45), atom(1, 'B', 15), atom(2, 'A', 40)]])
    .mockResolvedValueOnce([[atom(1, 'A', 30), atom(1, 'B', 10)]]);
  const result = await computeSalesPeoplePerformance({ query } as unknown as Pool, new Date('2026-01-15T00:00:00Z'), {});
  expect(result.contributions.map((c) => [c.personKey, c.teamKey, c.revenue, c.target])).toEqual([
    [1, 'A', 45, 150], [1, 'B', 15, 50],
  ]);
});

it('leaves out placeholder seats and returns the full-year target and months elapsed', async () => {
  vi.mocked(computeBreakdown).mockImplementation(async (_pool, anchor, _filters, period) => {
    if (period !== 'ytd') return [];
    const full = anchor.getUTCMonth() === 11 && anchor.getUTCDate() === 31;
    return [
      { ...row(1, 0, full ? 1200 : 100), groupLabel: 'Marwan' },
      { ...row(2, 0, full ? 3000 : 2500), groupLabel: 'Sales Person 1' },
      { ...row(3, 0, 10), groupLabel: 'SalesPerson 12' },
      { ...row(4, 0, 5000), groupLabel: 'Salers Person 3' },
      { ...row(5, 0, 5000), groupLabel: '  SALES-PERSON #4 ' },
    ];
  });
  const query = vi.fn(async () => [[]]);
  const result = await computeSalesPeoplePerformance({ query } as unknown as Pool, new Date('2026-11-15T00:00:00Z'), {});
  expect(result.people.map((p) => p.name)).toEqual(['Marwan']);
  expect(result.people[0].status).toBe('critical');
  expect(result.people[0].fullYearTarget).toBe(1200);
  expect(result.monthsElapsed).toBeCloseTo(10.5);
});

it('omits vacant seats from contribution denominators and direct lookups', async () => {
  vi.mocked(computeBreakdown).mockResolvedValue([
    row(1, 20, 50), row(2, 80, 150), { ...row(3, 0, 1000), groupLabel: 'Salers Person 3' },
  ]);
  const atom = (personKey: number, amount: number) => ({
    personKey, companyKey: 1, companyName: 'Majaal', segmentKey: 1, segmentName: 'B2B', amount,
  });
  const query = vi.fn(async () => [[atom(1, 20), atom(2, 80), atom(3, 0)]]);
  const db = { query } as unknown as Pool;
  const anchor = new Date('2026-11-11T00:00:00Z');
  const active = await computePersonContributions(db, anchor, {}, 1);
  expect(active.rows).toHaveLength(3);
  expect(active.rows.every((r) => r.totalTarget === 200 && r.targetShare === 0.25)).toBe(true);
  expect((await computePersonContributions(db, anchor, {}, 3)).rows).toEqual([]);
});
