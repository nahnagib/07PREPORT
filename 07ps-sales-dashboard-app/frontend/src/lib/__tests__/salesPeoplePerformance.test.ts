import { describe, expect, it } from 'vitest';
import {
  STATUS_COLOR, STATUS_ORDER, benchmarkMet, contributionSlices, filterPeople, firstContributionLevel, monthlyStatusPerformance,
  peopleSummary, personPath, personShares, rankPeople, statusMix, teamPulse, topPerson, type ContributionAtom, type MonthStatus,
  type PeopleStatus,
  type SalesPersonPerformance,
} from '../salesPeoplePerformance';

const ranked = (key: number, name: string, actual: number, target: number, status: PeopleStatus,
  months: Array<[number, number | null, MonthStatus]> = []) => ({
  key, name, actual, target, status, fullYearTarget: target * 2,
  achievement: actual / target, variance: actual - target, variancePct: (actual - target) / target,
  months: months.map(([a, t, s], i) => ({ month: `2026-0${i + 1}`, actual: a, target: t, status: s })),
}) as SalesPersonPerformance;

describe('dynamic team benchmarks and filtering', () => {
  const people = [ranked(1, 'Amal', 50, 100, 'critical'), ranked(2, 'Omar', 150, 100, 'top_performer')];
  it('uses team shares for 20 or 500 people, including exact benchmark equality', () => {
    const definition = { key: 'critical', label: 'Critical', range: '≤50%', benchmark: 0.05, direction: 'max' } as const;
    expect(benchmarkMet(1 / 20, definition)).toBe(true);
    expect(benchmarkMet(25 / 500, definition)).toBe(true);
    expect(benchmarkMet(26 / 500, definition)).toBe(false);
    expect(benchmarkMet(250 / 500, { ...definition, benchmark: 0.5, direction: 'min' })).toBe(true);
  });
  it('combines status, name search and person selection', () => {
    expect(filterPeople(people, 'critical', null, 'AM')).toEqual([people[0]]);
    expect(filterPeople(people, 'critical', 2)).toEqual([]);
    expect(filterPeople(people, null)).toHaveLength(2);
  });
  it('computes % vs target from summed values, not average percentages', () => {
    expect(peopleSummary(people)).toMatchObject({ count: 2, actual: 200, target: 200, variance: 0, variancePct: 0, achievement: 1 });
    expect(peopleSummary([]).variancePct).toBeNull();
  });
});

describe('top person per status', () => {
  const team = [
    ranked(1, 'Low', 40, 100, 'critical'),
    ranked(2, 'Big', 300, 1000, 'critical'),
    ranked(3, 'High', 50, 100, 'critical'),
    ranked(6, 'Star', 300, 100, 'top_performer'),
    ranked(7, 'Good', 120, 100, 'top_performer'),
  ];
  it('good statuses show the best, the others the worst, always by variance % to YTD target', () => {
    expect(topPerson(team, 'top_performer')?.name).toBe('Star');
    // Big is LYD −700 but −70%; Low is LYD −60 but −60%; High −50%.
    expect(topPerson(team, 'critical')?.name).toBe('Big');
    expect(topPerson(team, 'on_target')).toBeNull();
    expect(rankPeople(team.filter((p) => p.status === 'critical')).map((p) => p.name)).toEqual(['High', 'Low', 'Big']);
  });
  it('team pulse: achievement, gap and the run-rate needed for the full-year target', () => {
    const pulse = teamPulse([ranked(1, 'A', 300, 400, 'behind_target'), ranked(2, 'B', 500, 400, 'top_performer')], 4);
    expect(pulse).toMatchObject({ actual: 800, target: 800, achievement: 1, gap: 0, fullYear: 1600, running: 200, progress: 0.5 });
    expect(pulse.required).toBe(100);
    expect(teamPulse([ranked(1, 'A', 2000, 400, 'top_performer')], 4).required).toBe(0);
  });
  it('gives each of the five statuses its own colour from the semantic tokens only', () => {
    expect(STATUS_ORDER).toEqual(['top_performer', 'on_target', 'behind_target', 'need_attention', 'critical']);
    const colors = Object.values(STATUS_COLOR);
    expect(new Set(colors).size).toBe(STATUS_ORDER.length);
    for (const c of colors) expect(c).toMatch(/--ps-color-(success|watch|alert)/);
  });
});

describe('status mix and monthly performance', () => {
  const team = [
    ranked(1, 'A', 300, 200, 'top_performer', [[100, 50, 'top_performer'], [60, 100, 'need_attention']]),
    ranked(2, 'B', 100, 200, 'need_attention', [[30, 100, 'critical'], [0, null, 'no_target']]),
    ranked(3, 'C', 200, 200, 'on_target', [[100, 100, 'on_target'], [100, 100, 'on_target']]),
  ];
  it('headcount shares sum to 100% and exclude people without a target for the month', () => {
    const feb = statusMix(team, 1);
    expect(feb.total).toBe(2);
    expect(feb.rows.find((r) => r.status === 'need_attention')).toMatchObject({ count: 1, share: 0.5 });
    for (const mix of [statusMix(team, 0), feb, statusMix(team, null)]) {
      expect(mix.rows.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1);
    }
    expect(statusMix(team, null).rows.find((r) => r.status === 'top_performer')).toMatchObject({ count: 1, share: 1 / 3 });
    expect(statusMix([team[1]], 1)).toEqual({ total: 0, rows: [] });
  });
  it('monthly achievement per status uses that month\'s status', () => {
    const [jan, feb] = monthlyStatusPerformance(team);
    expect(jan.statuses.top_performer).toMatchObject({ count: 1, achievement: 2 });
    expect(jan.statuses.critical).toMatchObject({ count: 1, achievement: 0.3 });
    expect(feb.statuses.need_attention).toMatchObject({ count: 1, achievement: 0.6 });
    expect(feb.statuses.critical).toMatchObject({ count: 0, achievement: null });
  });
});

describe('contribution drill-down', () => {
  const atom = (personKey: number, company: string, segment: string, teamKey: string, revenue: number, target = 50): ContributionAtom => ({
    personKey, companyKey: company.length, companyName: company, segmentKey: segment.length, segmentName: segment,
    teamKey, teamName: `Team ${teamKey}`, revenue, target,
  });
  const atoms = [
    atom(1, 'Tika', 'B2B', 'T1', 60), atom(2, 'Tika', 'B2B', 'T2', 20), atom(2, 'Tika', 'Retail', 'T3', 20),
    atom(3, 'Majaal', 'B2B', 'M1', 100), atom(4, 'Majaal', 'B2B', 'M1', -10),
  ];
  const everyone = new Set([1, 2, 3, 4]);
  it('starts at company when there is a single group', () => {
    expect(firstContributionLevel(atoms)).toBe('company');
    const { level, slices } = contributionSlices(atoms, [], everyone);
    expect(level).toBe('company');
    expect(slices.map((s) => [s.label, s.actual, s.people])).toEqual([['Tika', 100, 2], ['Majaal', 90, 2]]);
    expect(slices[0].share).toBeCloseTo(100 / 190);
  });
  it('drills company > segment > team, and only counts the given people', () => {
    const tika = { level: 'company' as const, key: '4', label: 'Tika' };
    expect(contributionSlices(atoms, [tika], everyone).slices.map((s) => s.label)).toEqual(['B2B', 'Retail']);
    const b2b = { level: 'segment' as const, key: '3', label: 'B2B' };
    const teams = contributionSlices(atoms, [tika, b2b], everyone);
    expect(teams.level).toBe('team');
    expect(teams.slices.map((s) => [s.label, s.share])).toEqual([['Team T1', 0.75], ['Team T2', 0.25]]);
    const t1 = { level: 'team' as const, key: 'T1', label: 'Team T1' };
    expect(contributionSlices(atoms, [tika, b2b, t1], everyone).level).toBe('person');
    expect(contributionSlices(atoms, [tika, b2b, t1, { level: 'person', key: '1', label: '#1' }], everyone).level).toBeNull();
    expect(contributionSlices(atoms, [], new Set([3])).slices.map((s) => [s.label, s.share])).toEqual([['Majaal', 1]]);
  });
  it('gives a net-negative slice no share', () => {
    const majaal = { level: 'company' as const, key: '6', label: 'Majaal' };
    const b2b = { level: 'segment' as const, key: '3', label: 'B2B' };
    expect(contributionSlices(atoms, [majaal, b2b], new Set([4])).slices[0]).toMatchObject({ actual: -10, share: null });
  });
});

describe('selected person in the contribution donut', () => {
  const atom = (personKey: number, company: string, segment: string, teamKey: string, revenue: number): ContributionAtom => ({
    personKey, companyKey: company.length, companyName: company, segmentKey: segment.length, segmentName: segment,
    teamKey, teamName: `Team ${teamKey}`, revenue, target: 10,
  });
  const atoms = [
    atom(1, 'Tika', 'B2B', 'T1', 60), atom(1, 'Majaal', 'B2B', 'M1', 5), atom(2, 'Tika', 'B2B', 'T1', 20),
    atom(3, 'Tika', 'Retail', 'T3', 20), atom(4, 'Majaal', 'B2B', 'M1', 95),
  ];
  const everyone = new Set([1, 2, 3, 4]);
  it('opens on the team with most of the person\'s actual, with person slices named', () => {
    const path = personPath(atoms, 1)!;
    expect(path.map((s) => s.label)).toEqual(['Tika', 'B2B', 'Team T1']);
    const { level, slices } = contributionSlices(atoms, path, everyone, new Map([[1, 'Marwan'], [2, 'Huda']]));
    expect(level).toBe('person');
    expect(slices.map((s) => [s.label, s.share, s.members])).toEqual([['Marwan', 0.75, [1]], ['Huda', 0.25, [2]]]);
    expect(personPath(atoms, 99)).toBeNull();
  });
  it('gives the share at team, segment, company, group and total', () => {
    const shares = personShares(atoms, 1, personPath(atoms, 1)!, everyone);
    expect(shares.map((s) => s.level)).toEqual(['team', 'segment', 'company', 'group', 'total']);
    expect(shares.map((s) => s.share)).toEqual([0.75, 0.75, 0.6, 65 / 200, 65 / 200]);
  });
});
