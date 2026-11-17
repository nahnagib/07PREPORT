import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { computeBreakdown, computeMtdCard, computeYtdCard } from '../tachometer';
import { computePersonContributions, computeSalesPeoplePerformance, performanceFigures, performanceStatus } from '../salesPeoplePerformance';
vi.mock('../tachometer', () => ({ computeBreakdown: vi.fn(), computeYtdCard: vi.fn(), computeMtdCard: vi.fn() }));
const row = (key: number | string, actual: number, target: number | null) => ({
  groupKey: key, groupLabel: `Person ${key}`, actual, targetToDate: target,
  status: 'green' as never, variancePct: null,
});
/** A Tachometer YTD Value card (measures/tachometer.ts computeYtdCard). */
const card = (actual: number, targetToDate: number, fullPeriodTarget: number) => ({
  actual, targetToDate, fullPeriodTarget, status: 'green' as never, variancePct: null, lastYearSamePeriod: 0,
  fullLastPeriodActual: 0, lastYearRange: { start: '', end: '' }, fullLastPeriodRange: { start: '', end: '' },
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(computeYtdCard).mockResolvedValue(card(0, 0, 0));
  vi.mocked(computeMtdCard).mockResolvedValue(card(0, 0, 0));
});

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


describe('company total, directors and reconciliation (2026-11-17: directors from the TargetLevel = Director rows)', () => {
  // two listed people (1, 2), the B2B Director's own invoices (3, no Salesperson target), a vacant seat (4), unassigned (-1)
  const breakdown = [row(1, 100, 80), row(2, 50, 100), row(3, 30, null), { ...row(4, 0, 20), groupLabel: 'Sales Person 1' }, row(-1, 5, null)];
  // sales_targets.xlsx: Mustapha Shaddad (key 3) = B2B Director, 20 a month (240 a year); no B2C Director rows
  const directorRows = Array.from({ length: 12 }, (_, i) => ({ personKey: 3, segmentKey: 1, month: i + 1, name: 'Mustapha Shaddad', target: 20 }));
  const isDirectorSql = (sql: string) => sql.includes("= 'director'");
  // a plain function: beforeEach's resetAllMocks would wipe a vi.fn implementation
  const query = async (sql: string) => (isDirectorSql(sql) ? [directorRows] : [[]]);
  const db = { query } as unknown as Pool;

  it('the company figures are the Tachometer YTD Value card (Salesperson targets only), not the sum of the people', async () => {
    vi.mocked(computeBreakdown).mockResolvedValue(breakdown);
    vi.mocked(computeYtdCard).mockResolvedValue(card(185, 200, 400));
    const out = await computeSalesPeoplePerformance(db, new Date('2026-06-30Z'), { segmentKeys: [1, 2] });
    expect(out.people.map((p) => p.key)).toEqual([1, 2]);
    expect(out.company).toMatchObject({ actual: 185, target: 200, fullYearTarget: 400, achievement: 0.925, status: 'behind_target' });
    expect(vi.mocked(computeYtdCard).mock.calls.every((c) => c[3] === 'value')).toBe(true);
    expect(out.directorVacancies).toEqual([]);
    expect(out.reconciliation).toBeNull();
  });

  it('a director is a person under their own key: the channel actual, their own Director-row target, same tiers and months', async () => {
    vi.mocked(computeBreakdown).mockResolvedValue(breakdown);
    vi.mocked(computeYtdCard).mockImplementation(async (_p, _a, f) =>
      (f.segmentKeys?.length === 1 && f.segmentKeys[0] === 1 ? { ...card(125, 100, 200), lastYearSamePeriod: 90 } : card(185, 200, 400)));
    vi.mocked(computeMtdCard).mockImplementation(async (_p, end) => card(end.getUTCMonth() === 5 ? 30 : 20, 999, 999));
    const out = await computeSalesPeoplePerformance(db, new Date('2026-06-30Z'), {}, {
      directorFilters: { B2B: { segmentKeys: [1] }, B2C: { segmentKeys: [2] } },
    });
    const director = out.people.find((p) => p.key === 3)!;
    // target = 6 months x 20 of the Director rows (not the channel card's 100); actual = the channel's 125
    expect(director).toMatchObject({ key: 3, name: 'Mustapha Shaddad', actual: 125, target: 120, status: 'on_target',
      lastYear: 90, fullYearTarget: 240 });
    // exactly the fields of a sales person: no director-only field
    expect(Object.keys(director).sort()).toEqual(Object.keys(out.people.find((p) => p.key === 1)!).sort());
    // each month: the channel's MTD actual, the director's own month target; December as January's baseline
    expect(director.months).toHaveLength(6);
    expect(director.months[5]).toMatchObject({ month: '2026-06', actual: 30, target: 20, previousActual: 20, status: 'top_performer' });
    // listed once (never also as a plain person with their own invoices), sorted with everyone by actual
    expect(out.people.map((p) => p.key)).toEqual([3, 1, 2]);
    // the company total never includes the director: the Tachometer card as is
    expect(out.company).toMatchObject({ actual: 185, target: 200 });
    expect(out.directorVacancies).toEqual(['B2C Director']);
  });

  it('under a company / channel / team filter the Director rows cannot be cut: the target is that slice of the Salesperson targets', async () => {
    vi.mocked(computeBreakdown).mockResolvedValue(breakdown);
    vi.mocked(computeYtdCard).mockResolvedValue(card(125, 100, 200));
    vi.mocked(computeMtdCard).mockResolvedValue(card(20, 15, 15));
    const out = await computeSalesPeoplePerformance(db, new Date('2026-06-30Z'), { companyKeys: [3] },
      { directorFilters: { B2B: { segmentKeys: [1], companyKeys: [3] }, B2C: null } });
    expect(out.people.find((p) => p.key === 3)).toMatchObject({ target: 100, fullYearTarget: 200 });
  });

  it('a director outside the filters is left out: a channel the caller may not see, another Customer Group, a Salesperson filter without them', async () => {
    vi.mocked(computeBreakdown).mockResolvedValue(breakdown);
    vi.mocked(computeYtdCard).mockResolvedValue(card(125, 100, 200));
    const keys = async (filters: object, b2b: object | null = { segmentKeys: [1] }) => (await computeSalesPeoplePerformance(db, new Date('2026-06-30Z'), filters,
      { directorFilters: { B2B: b2b as never, B2C: null } })).people.map((p) => p.key);
    expect(await keys({})).toContain(3);
    expect(await keys({}, null)).not.toContain(3);
    expect(await keys({ segmentKeys: [2] })).not.toContain(3);
    expect(await keys({ salespersonKeys: [1] })).not.toContain(3);
    // like anyone: a customer filter narrows the director's (channel) figures, it does not remove them
    expect(await keys({ customerKeys: [7] })).toContain(3);
  });

  it('the Salesperson filter can pick a director: the director alone, and the total is the picked people', async () => {
    vi.mocked(computeBreakdown).mockImplementation(async (_p, _a, f) =>
      breakdown.filter((r) => f.salespersonKeys?.includes(Number(r.groupKey)) ?? true));
    vi.mocked(computeYtdCard).mockImplementation(async (_p, _a, f) => (f.salespersonKeys?.length ? card(30, 0, 0) : card(125, 100, 200)));
    const out = await computeSalesPeoplePerformance(db, new Date('2026-06-30Z'), { salespersonKeys: [3] },
      { directorFilters: { B2B: { segmentKeys: [1] }, B2C: null } });
    expect(out.people.map((p) => [p.key, p.actual, p.target])).toEqual([[3, 125, 120]]);
    expect(out.company).toMatchObject({ actual: 125, target: 120, fullYearTarget: 240 });
    // no company total to reconcile: the admin Data Quality line is not sent
    const admin = await computeSalesPeoplePerformance(db, new Date('2026-06-30Z'), { salespersonKeys: [3] },
      { directorFilters: { B2B: { segmentKeys: [1] }, B2C: null }, withReconciliation: true });
    expect(admin.reconciliation).toBeNull();
  });

  it('the contribution rows of a director are the channel rows, summed per company / segment / team under the director key', async () => {
    vi.mocked(computeBreakdown).mockResolvedValue(breakdown);
    vi.mocked(computeYtdCard).mockResolvedValue(card(125, 100, 200));
    vi.mocked(computeMtdCard).mockResolvedValue(card(20, 20, 20));
    const atom = (personKey: number, teamKey: string, amount: number) => ({ personKey, companyKey: 3, companyName: 'Majaal',
      segmentKey: 1, segmentName: 'B2B', teamKey, teamName: `Team ${teamKey}`, amount });
    // the channel's rows of two people in team 10 and one in team 20 (actuals and target weights alike)
    const atomQuery = async (sql: string) => (isDirectorSql(sql) ? [directorRows]
      : sql.includes('v_sales_') ? [[atom(1, '10', 60), atom(2, '10', 40), atom(2, '20', 25)]] : [[]]);
    const out = await computeSalesPeoplePerformance({ query: atomQuery } as unknown as Pool, new Date('2026-06-30Z'), {},
      { directorFilters: { B2B: { segmentKeys: [1] }, B2C: null } });
    const director = out.contributions.filter((c) => c.personKey === 3);
    expect(director.map((c) => [c.teamKey, c.revenue])).toEqual([['10', 100], ['20', 25]]);
    // the director's own target allocated by the channel's target weights
    expect(director.reduce((t, c) => t + c.target, 0)).toBeCloseTo(120);
  });

  it('reconciliation: what is not on a listed person, by reason, adding up to company - people', async () => {
    vi.mocked(computeBreakdown).mockResolvedValue(breakdown);
    vi.mocked(computeYtdCard).mockResolvedValue(card(185, 200, 400));
    const out = await computeSalesPeoplePerformance(db, new Date('2026-06-30Z'), {}, { withReconciliation: true });
    const r = out.reconciliation!;
    expect(r.listed).toEqual({ actual: 150, target: 180 });
    expect(r.gap).toEqual({ actual: 35, target: 20 });
    const by = Object.fromEntries(r.rows.map((x) => [x.reason, { actual: x.actual, target: x.target }]));
    expect(by).toEqual({
      director: { actual: 30, target: 0 },       // key 3 = the B2B Director's own invoices (no Salesperson target)
      unassigned: { actual: 5, target: 0 },
      vacant_seat: { actual: 0, target: 20 },
    });
    expect(r.rows.reduce((t, x) => t + x.actual, 0)).toBe(r.gap.actual);
    expect(r.rows.reduce((t, x) => t + x.target, 0)).toBe(r.gap.target);
  });
});
