import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  NOT_SET,
  NO_FILTERS,
  addDays,
  applyFilters,
  buildFollowup,
  buildRoadmap,
  addMonths,
  kpiSets,
  UNASSIGNED_BRAND,
  computeKpis,
  daysBetween,
  familyStageMatrix,
  forcedHealth,
  isOverdue,
  isStale,
  isValidIsoDate,
  launchesByYear,
  nextCode,
  normaliseReadiness,
  openBlockers,
  productFlag,
  productProblems,
  stageSummary,
  withDaysInStage,
  type Blocker,
  type HealthCode,
  type PriorityCode,
  type Product,
  type StageCode,
} from '../rules';

const FAM = { 'Tile Fixing': 1, Waterproofing: 2, Flooring: 4 } as const;
type Fam = keyof typeof FAM;

function p(id: number, name: string, family: Fam, stage: StageCode, owner: string | null, priority: PriorityCode | null, health: HealthCode | null, readiness: number | null, target: string | null, actual: string | null = null): Product {
  return {
    productId: id, code: `XT-${String(id).padStart(3, '0')}`, name, familyId: FAM[family], family, subfamily: `${family} sub`, brand: id <= 3 ? 'Xtreme' : UNASSIGNED_BRAND, ownerUserId: null, ownerName: owner, priority, stage, health,
    readinessPct: readiness, targetLaunch: target, actualLaunch: actual, projectType: 'PLANNED', nextStep: null, nextStepDue: null, healthReviewRequired: false,
    stageSince: '2026-10-01', lastUpdateAt: '2026-11-10', createdOn: '2026-09-01',
  };
}

// A small pipeline shaped like the Excel file: launched with actual dates, Development / Idea with targets and blank health.
const SET: Product[] = [
  p(1, 'XtraCol One', 'Tile Fixing', 'LAUNCHED', null, null, 'ON_TRACK', 100, null, '2023-05-01'),
  p(2, 'XtraCol Pro', 'Tile Fixing', 'LAUNCHED', null, null, 'ON_TRACK', 100, null, '2024-02-01'),
  p(3, 'MonoSeal', 'Waterproofing', 'DEVELOPMENT', 'Omar Ali', 'HIGH', 'AT_RISK', 70, '2027-01-15'),
  p(4, 'FlexSeal', 'Waterproofing', 'DEVELOPMENT', null, null, null, null, '2026-06-01'), // target passed, health not set
  p(5, 'Epoxy Coat', 'Flooring', 'IDEA', null, null, null, null, '2026-12-10'),
  p(6, 'Self Level', 'Flooring', 'IDEA', null, null, 'ON_TRACK', null, '2028-03-01'),
  p(7, 'Grout Max', 'Tile Fixing', 'TESTING', 'Sara Ahmed', 'MEDIUM', 'BLOCKED', 60, '2026-12-20'),
];
const TODAY = '2026-11-18';

const blocker = (id: number, productId: number, kind: Blocker['kind'], due: string, status: Blocker['status'] = 'OPEN'): Blocker => ({
  blockerId: id, externalId: `BL-${String(id).padStart(3, '0')}`, productId, kind, title: `Item ${id}`, requiredAction: 'Act', ownerName: 'Omar Ali', dueDate: due, status,
});

describe('dates, codes, readiness', () => {
  it('adds and counts days across months and years', () => {
    expect(addDays('2026-11-15', 90)).toBe('2027-02-13');
    expect(daysBetween('2026-12-30', '2027-01-02')).toBe(3);
  });
  it('validates ISO dates', () => {
    expect(isValidIsoDate('2027-02-28')).toBe(true);
    expect(isValidIsoDate('2027-02-29')).toBe(false);
  });
  it('gives the next XT / BL code after the highest in use', () => {
    expect(nextCode('XT', ['XT-001', 'XT-055', 'xt-009', null, 'P-900'])).toBe('XT-056');
    expect(nextCode('BL', [])).toBe('BL-001');
    expect(nextCode('XT', ['XT-999'])).toBe('XT-1000');
  });
  it('normalises Excel readiness (0-1 or 0-100)', () => {
    expect(normaliseReadiness(0.45)).toBe(45);
    expect(normaliseReadiness(1)).toBe(100);
    expect(normaliseReadiness(70)).toBe(70);
    expect(normaliseReadiness('45%')).toBe(45);
    expect(normaliseReadiness(null)).toBeNull();
    expect(normaliseReadiness('')).toBeNull();
    expect(Number.isNaN(normaliseReadiness('soon'))).toBe(true);
  });
});

describe('KPIs (portfolio row + status row)', () => {
  it('counts total, in market, active (target within 12 months), planned and the status row on not-launched products', () => {
    expect(computeKpis(SET, TODAY, DEFAULT_SETTINGS)).toEqual({
      // active: XT-005 (10 Dec), XT-007 (20 Dec), XT-003 (15 Jan 2027); planned: XT-006 (2028, beyond), XT-004 (June 2026, passed)
      total: 7, inMarket: 2, active: 3, planned: 2, plannedNoDate: 0, plannedBeyond: 1, plannedPassed: 1,
      // on track: XT-006 (planned, not launched); launched XT-001/002 are on track too but not counted
      onTrack: 1, needAttention: 2, upcomingLaunches: 3, healthNotSet: 2, targetPassed: 1,
    });
  });
  it('adds up: total = in market + active + planned, with and without filters', () => {
    const withNoDate = [...SET, p(8, 'No Date', 'Flooring', 'IDEA', null, null, null, null, null)];
    for (const set of [withNoDate, applyFilters(withNoDate, { ...NO_FILTERS, familyIds: [4] }), applyFilters(withNoDate, { ...NO_FILTERS, brands: ['xtreme'] })]) {
      const k = computeKpis(set, TODAY, DEFAULT_SETTINGS);
      expect(k.inMarket + k.active + k.planned).toBe(k.total);
      expect(k.plannedNoDate + k.plannedBeyond + k.plannedPassed).toBe(k.planned);
    }
    expect(computeKpis(withNoDate, TODAY, DEFAULT_SETTINGS).plannedNoDate).toBe(1);
  });
  it('lists the products behind each card', () => {
    const s = kpiSets(SET, TODAY, DEFAULT_SETTINGS);
    expect(s.active).toEqual(['XT-003', 'XT-005', 'XT-007']);
    expect(s.planned).toEqual(['XT-004', 'XT-006']);
    expect(s.needAttention).toEqual(['XT-003', 'XT-007']);
    expect(s.upcomingLaunches).toEqual(['XT-003', 'XT-005', 'XT-007']);
  });
  it('counts the 12-month boundary day as Active and the day after as Planned', () => {
    const bucketOf = (target: string) => kpiSets([p(1, 'A', 'Flooring', 'TESTING', null, null, 'ON_TRACK', 10, target)], TODAY, DEFAULT_SETTINGS);
    expect(addMonths(TODAY, 12)).toBe('2027-11-18');
    expect(bucketOf('2027-11-18').active).toHaveLength(1);
    expect(bucketOf('2027-11-19').planned).toHaveLength(1);
    expect(bucketOf(TODAY).active).toHaveLength(1);
    expect(addMonths('2027-01-31', 1)).toBe('2027-02-28');
  });
  it('counts the 90-day boundary day itself, not the day after', () => {
    const one = (target: string) => computeKpis([p(1, 'A', 'Flooring', 'TESTING', null, null, 'ON_TRACK', 10, target)], TODAY, DEFAULT_SETTINGS).upcomingLaunches;
    expect(one(addDays(TODAY, 90))).toBe(1);
    expect(one(addDays(TODAY, 91))).toBe(0);
    expect(one(TODAY)).toBe(1);
    expect(one(addDays(TODAY, -1))).toBe(0);
  });
});

describe('flags (the Excel Flag column, first that applies)', () => {
  const s = DEFAULT_SETTINGS;
  it('open blocker > target passed > health not set > launch soon with low readiness; none when launched', () => {
    expect(productFlag(SET[3], 1, TODAY, s)).toBe('OPEN_BLOCKER');
    expect(productFlag(SET[3], 0, TODAY, s)).toBe('TARGET_PASSED');
    expect(productFlag(SET[4], 0, TODAY, s)).toBe('HEALTH_NOT_SET');
    expect(productFlag({ ...SET[4], health: 'ON_TRACK' }, 0, TODAY, s)).toBe('LAUNCH_SOON_LOW_READINESS');
    expect(productFlag({ ...SET[4], health: 'ON_TRACK', readinessPct: 85 }, 0, TODAY, s)).toBeNull();
    expect(productFlag(SET[0], 3, TODAY, s)).toBeNull();
  });
});

describe('stage summary tiles', () => {
  it('counts, splits health, averages set readiness, finds the next target and the warnings, per stage in order', () => {
    const s = stageSummary(SET, TODAY);
    expect(s.map((x) => [x.stage, x.count])).toEqual([['IDEA', 2], ['RESEARCH', 0], ['DEVELOPMENT', 2], ['TESTING', 1], ['LAUNCH_READY', 0], ['LAUNCHED', 2]]);
    const dev = s.find((x) => x.stage === 'DEVELOPMENT')!;
    expect(dev).toEqual({
      stage: 'DEVELOPMENT', count: 2, health: { onTrack: 0, atRisk: 1, blocked: 0, notSet: 1 }, avgReadiness: 70,
      nextTarget: '2026-06-01', nextTargetPassed: true, overdue: 1, blocked: 0,
    });
    expect(s.find((x) => x.stage === 'IDEA')).toMatchObject({ health: { onTrack: 1, atRisk: 0, blocked: 0, notSet: 1 }, avgReadiness: null, nextTarget: '2026-12-10', nextTargetPassed: false, overdue: 0 });
    expect(s.find((x) => x.stage === 'TESTING')).toMatchObject({ blocked: 1, health: { blocked: 1 } });
    expect(s.find((x) => x.stage === 'LAUNCHED')).toMatchObject({ count: 2, nextTarget: null, overdue: 0, avgReadiness: 100 });
    expect(s.find((x) => x.stage === 'RESEARCH')).toMatchObject({ count: 0, avgReadiness: null, nextTarget: null });
  });
});

describe('where we stand (family x stage)', () => {
  it('lists every family in list order, counts each stage and totals', () => {
    const m = familyStageMatrix(SET, [{ familyId: 1, family: 'Tile Fixing' }, { familyId: 2, family: 'Waterproofing' }, { familyId: 4, family: 'Flooring' }, { familyId: 9, family: 'Renders' }]);
    expect(m.rows.map((r) => [r.family, r.counts.IDEA, r.counts.DEVELOPMENT, r.counts.TESTING, r.counts.LAUNCHED, r.total])).toEqual([
      ['Tile Fixing', 0, 0, 1, 2, 3],
      ['Waterproofing', 0, 2, 0, 0, 2],
      ['Flooring', 2, 0, 0, 0, 2],
      ['Renders', 0, 0, 0, 0, 0],
    ]);
    expect(m.totals).toMatchObject({ IDEA: 2, DEVELOPMENT: 2, TESTING: 1, LAUNCHED: 2, RESEARCH: 0, LAUNCH_READY: 0 });
    expect(m.total).toBe(7);
  });
  it('adds a "Family not set" row for products without one', () => {
    const m = familyStageMatrix([{ ...SET[4], familyId: null, family: null }], []);
    expect(m.rows).toEqual([expect.objectContaining({ family: 'Family not set', total: 1 })]);
  });
});

describe('launches by year', () => {
  it('counts launched by actual year and planned by target year, 2023-2028 at least', () => {
    const y = launchesByYear(SET);
    expect(y.map((x) => x.year)).toEqual([2023, 2024, 2025, 2026, 2027, 2028]);
    expect(y.find((x) => x.year === 2023)).toEqual({ year: 2023, launched: 1, planned: 0 });
    expect(y.find((x) => x.year === 2026)).toEqual({ year: 2026, launched: 0, planned: 3 });
    expect(y.find((x) => x.year === 2028)).toEqual({ year: 2028, launched: 0, planned: 1 });
  });
});

describe('roadmap', () => {
  it('groups the next-90-days launches by target month and counts the rest', () => {
    const r = buildRoadmap(SET, TODAY, 90);
    expect(r.windowEnd).toBe('2027-02-16');
    expect(r.months.map((m) => m.month)).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
    expect(r.months.map((m) => m.products.map((x) => x.code))).toEqual([[], ['XT-005', 'XT-007'], ['XT-003'], []]);
    expect(r.outsideWindow).toBe(2); // XT-004 (June 2026, passed) and XT-006 (2028)
    expect(r.months.reduce((n, m) => n + m.products.length, 0)).toBe(computeKpis(SET, TODAY, DEFAULT_SETTINGS).upcomingLaunches);
  });
  it('leaves out a launch on day 91', () => {
    const r = buildRoadmap([p(1, 'A', 'Flooring', 'TESTING', null, null, 'ON_TRACK', 10, addDays(TODAY, 91))], TODAY, 90);
    expect(r.months.flatMap((m) => m.products)).toHaveLength(0);
    expect(r.outsideWindow).toBe(1);
  });
});

describe('filters', () => {
  it('filters by family, subfamily, stage and "not set" values', () => {
    expect(applyFilters(SET, { ...NO_FILTERS, familyIds: [2] }).map((x) => x.code)).toEqual(['XT-003', 'XT-004']);
    expect(applyFilters(SET, { ...NO_FILTERS, subfamilies: ['flooring sub'] })).toHaveLength(2);
    expect(applyFilters(SET, { ...NO_FILTERS, health: [NOT_SET] }).map((x) => x.code)).toEqual(['XT-004', 'XT-005']);
    expect(applyFilters(SET, { ...NO_FILTERS, health: ['BLOCKED', NOT_SET] })).toHaveLength(3);
    expect(applyFilters(SET, { ...NO_FILTERS, owners: [NOT_SET] })).toHaveLength(5);
    expect(applyFilters(SET, { ...NO_FILTERS, owners: ['omar ali'] }).map((x) => x.code)).toEqual(['XT-003']);
    expect(applyFilters(SET, { ...NO_FILTERS, priorities: ['HIGH'] })).toHaveLength(1);
    expect(applyFilters(SET, { ...NO_FILTERS, brands: ['Xtreme'] }).map((x) => x.code)).toEqual(['XT-001', 'XT-002', 'XT-003']);
    expect(applyFilters(SET, { ...NO_FILTERS, brands: [UNASSIGNED_BRAND] })).toHaveLength(4);
    expect(applyFilters(SET, { ...NO_FILTERS, search: 'xt-00' })).toHaveLength(7);
    expect(applyFilters(SET, { ...NO_FILTERS, launchFrom: '2026-12-01', launchTo: '2027-01-31' }).map((x) => x.code)).toEqual(['XT-003', 'XT-005', 'XT-007']);
  });
});

describe('product validation', () => {
  const ok: Parameters<typeof productProblems>[0] = { name: 'X', stage: 'DEVELOPMENT', readinessPct: 40, targetLaunch: '2027-01-01', actualLaunch: null };
  const codes = (x: Partial<typeof ok>) => productProblems({ ...ok, ...x }).map((e) => e.code);
  it('accepts a normal product and a blank readiness', () => {
    expect(codes({})).toEqual([]);
    expect(codes({ readinessPct: null })).toEqual([]);
  });
  it('allows 100% only in Launch ready or Launched', () => {
    expect(codes({ readinessPct: 100 })).toEqual(['product.readinessFull']);
    expect(codes({ readinessPct: 100, stage: 'LAUNCH_READY' })).toEqual([]);
  });
  it('needs a target from Research to Launch ready, an actual date when Launched', () => {
    expect(codes({ targetLaunch: null })).toEqual(['product.targetRequired']);
    expect(codes({ targetLaunch: null, stage: 'IDEA' })).toEqual([]);
    expect(codes({ targetLaunch: null, stage: 'LAUNCHED', readinessPct: 100, actualLaunch: '2023-05-01' })).toEqual([]);
    expect(codes({ stage: 'LAUNCHED', readinessPct: 100 })).toEqual(['product.actualRequired']);
  });
});

describe('blocker rule', () => {
  it('forces Blocked only for an unresolved Blocker, never for a decision', () => {
    expect(forcedHealth([{ kind: 'BLOCKER', status: 'OPEN' }])).toBe('BLOCKED');
    expect(forcedHealth([{ kind: 'BLOCKER', status: 'IN_PROGRESS' }])).toBe('BLOCKED');
    expect(forcedHealth([{ kind: 'BLOCKER', status: 'RESOLVED' }, { kind: 'DECISION', status: 'OPEN' }])).toBeNull();
  });
});

describe('stale and overdue', () => {
  it('is stale from the 14th day without an update, never when launched', () => {
    expect(isStale({ ...SET[2], lastUpdateAt: '2026-11-05' }, TODAY, 14)).toBe(false);
    expect(isStale({ ...SET[2], lastUpdateAt: '2026-11-04' }, TODAY, 14)).toBe(true);
    expect(isStale({ ...SET[2], lastUpdateAt: null, createdOn: '2026-11-10' }, TODAY, 14)).toBe(false);
    expect(isStale({ ...SET[0], lastUpdateAt: '2026-01-01' }, TODAY, 14)).toBe(false);
  });
  it('is overdue only after the due day and while unresolved; open items overdue first', () => {
    expect(isOverdue({ status: 'OPEN', dueDate: TODAY }, TODAY)).toBe(false);
    expect(isOverdue({ status: 'OPEN', dueDate: '2026-11-17' }, TODAY)).toBe(true);
    const list = openBlockers([blocker(1, 7, 'BLOCKER', '2026-11-27'), blocker(2, 3, 'DECISION', '2026-11-10'), blocker(3, 3, 'DECISION', '2026-11-01', 'RESOLVED')], TODAY);
    expect(list.map((b) => [b.blockerId, b.overdue])).toEqual([[2, true], [1, false]]);
  });
});

describe('follow-up board', () => {
  it('collects overdue / due-soon items, overdue next steps, stale products and launches at risk', () => {
    const products = [{ ...SET[4], health: 'ON_TRACK' as const }, { ...SET[2], lastUpdateAt: '2026-10-01' }, SET[6]];
    const items = buildFollowup(
      products,
      [blocker(1, 7, 'BLOCKER', '2026-11-17'), blocker(2, 3, 'DECISION', '2026-11-24')],
      [{ updateId: null, productId: 3, nextStep: 'Field trial', nextStepDue: '2026-11-16', ownerName: 'Omar Ali' }],
      TODAY,
      DEFAULT_SETTINGS,
    );
    expect(items.map((i) => [i.kind, i.productCode])).toEqual([
      ['BLOCKER_OVERDUE', 'XT-007'],
      ['NEXT_STEP_OVERDUE', 'XT-003'],
      ['BLOCKER_DUE_SOON', 'XT-003'],
      ['LAUNCH_AT_RISK', 'XT-005'],
      ['STALE', 'XT-003'],
    ]);
    expect(items.find((i) => i.kind === 'LAUNCH_AT_RISK')!.title).toBe('Launch in 22 days at readiness not set');
  });
});

describe('stage timeline', () => {
  it('gives the days spent in each stage, the last one up to today', () => {
    const t = withDaysInStage(
      [
        { historyId: 2, fromStage: 'IDEA', toStage: 'RESEARCH', changedOn: '2026-10-11', changedAt: null, changedBy: null, comment: 'b' },
        { historyId: 1, fromStage: null, toStage: 'IDEA', changedOn: '2026-10-01', changedAt: null, changedBy: null, comment: 'a' },
      ],
      '2026-11-15',
    );
    expect(t.map((x) => [x.toStage, x.days, x.current])).toEqual([['IDEA', 10, false], ['RESEARCH', 35, true]]);
  });
});
