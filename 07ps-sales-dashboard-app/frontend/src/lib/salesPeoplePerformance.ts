import { apiRequest, type TachometerFilters } from './api';

/** The five YTD statuses. People without a positive YTD target are left out of the page by the API. */
export type PeopleStatus = 'critical' | 'need_attention' | 'behind_target' | 'on_target' | 'top_performer';
/** A month can still have no positive target for someone who has a YTD target: that month leaves them out. */
export type MonthStatus = PeopleStatus | 'no_target';
export interface PeopleFigures {
  actual: number; target: number | null; achievement: number | null;
  variance: number | null; variancePct: number | null;
}
export interface PeopleMonth extends PeopleFigures {
  month: string; through: string; status: MonthStatus; previousActual: number; momVariancePct: number | null;
  achievementChange: number | null; previousStatus: MonthStatus;
}
export interface SalesPersonPerformance extends PeopleFigures {
  key: number; name: string; status: PeopleStatus; lastYear: number; fullYearTarget: number | null; months: PeopleMonth[];
}
export interface PeopleStatusDefinition {
  key: PeopleStatus; label: string; range: string; benchmark: number | null; direction: 'min' | 'max' | null;
}
/** YTD actual and allocated YTD target of one person in one company / segment / team. */
export interface ContributionAtom {
  personKey: number; companyKey: number; companyName: string; segmentKey: number; segmentName: string;
  teamKey: string; teamName: string; revenue: number; target: number;
}
export interface PeopleOverview {
  anchorDate: string; monthsElapsed: number; statuses: PeopleStatusDefinition[]; people: SalesPersonPerformance[];
  contributions: ContributionAtom[];
}

/** Best first: the order of the status cards, the top-people cards, the chart axes and legends. */
export const STATUS_ORDER: readonly PeopleStatus[] = ['top_performer', 'on_target', 'behind_target', 'need_attention', 'critical'];
/** Statuses whose top card shows the best person; the others show the worst (the one needing the most attention). */
const GOOD_STATUSES: ReadonlySet<PeopleStatus> = new Set(['top_performer', 'on_target']);
export const showsBest = (status: PeopleStatus) => GOOD_STATUSES.has(status);

/** One colour per status, everywhere on the page. Only the app's semantic tokens (success / watch / alert):
 * On target is a lighter tint of success (towards the card background, so it stays distinct in light and dark mode) and
 * Need attention is watch mixed into alert. */
export const STATUS_COLOR: Record<PeopleStatus, string> = {
  top_performer: 'var(--ps-color-success)',
  on_target: 'color-mix(in srgb, var(--ps-color-success) 55%, var(--ps-card-bg))',
  behind_target: 'var(--ps-color-watch)',
  need_attention: 'color-mix(in srgb, var(--ps-color-watch) 45%, var(--ps-color-alert))',
  critical: 'var(--ps-color-alert)',
};

export function peopleSummary(people: PeopleFigures[]) {
  const actual = people.reduce((sum, p) => sum + p.actual, 0);
  const target = people.reduce((sum, p) => sum + (p.target ?? 0), 0);
  return { count: people.length, actual, target, variance: target > 0 ? actual - target : null,
    variancePct: target > 0 ? (actual - target) / target : null, achievement: target > 0 ? actual / target : null };
}

export function benchmarkMet(share: number, definition: PeopleStatusDefinition) {
  if (definition.benchmark == null) return null;
  return definition.direction === 'max' ? share <= definition.benchmark : share >= definition.benchmark;
}

export function filterPeople(people: SalesPersonPerformance[], status: PeopleStatus | null, personKey: number | null = null, search = '') {
  return people.filter((person) => (!status || person.status === status) &&
    (personKey == null || person.key === personKey) && person.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
}

/** Highest variance % to YTD target first; ties go to the higher actual, then the name. */
export function rankPeople(people: SalesPersonPerformance[]): SalesPersonPerformance[] {
  return [...people].sort((a, b) => (b.variancePct ?? -Infinity) - (a.variancePct ?? -Infinity)
    || b.actual - a.actual || a.name.localeCompare(b.name));
}

/** The one person shown for a status, by variance % to YTD target: Top performer / On target = the best; Behind target,
 * Need attention and Critical = the worst, i.e. the person who needs the most attention. */
export function topPerson(people: SalesPersonPerformance[], status: PeopleStatus): SalesPersonPerformance | null {
  const ranked = rankPeople(people.filter((p) => p.status === status));
  return (showsBest(status) ? ranked[0] : ranked[ranked.length - 1]) ?? null;
}

/** Team pulse: YTD achievement and gap, and the monthly run-rate needed for the full-year target against the current one. */
export function teamPulse(people: SalesPersonPerformance[], monthsElapsed: number) {
  const sums = peopleSummary(people);
  const fullYear = people.reduce((sum, p) => sum + (p.fullYearTarget ?? 0), 0);
  const monthsLeft = 12 - monthsElapsed;
  return {
    ...sums, fullYear, gap: sums.target > 0 ? sums.actual - sums.target : null,
    required: fullYear > 0 && monthsLeft > 0 ? Math.max(0, fullYear - sums.actual) / monthsLeft : null,
    running: monthsElapsed > 0 ? sums.actual / monthsElapsed : null,
    progress: fullYear > 0 ? sums.actual / fullYear : null,
  };
}

/** Headcount and share of people with a target in the selected month or YTD. */
export function statusMix(people: SalesPersonPerformance[], monthIndex: number | null) {
  const statuses = people.map((p) => monthIndex == null ? p.status : p.months[monthIndex]?.status)
    .filter((status) => status != null && status !== 'no_target');
  const total = statuses.length;
  const rows = total === 0 ? [] : STATUS_ORDER.map((status) => {
    const count = statuses.filter((value) => value === status).length;
    return { status, count, share: count / total };
  });
  return { total, rows };
}

/** Per month, per status (that month's status): Σ actual ÷ Σ target of the people in it, plus the sums and headcount. */
export function monthlyStatusPerformance(people: SalesPersonPerformance[]) {
  const months = people[0]?.months.map((m) => m.month) ?? [];
  return months.map((month, i) => ({
    month,
    statuses: Object.fromEntries(STATUS_ORDER.map((status) => {
      const sums = peopleSummary(people.map((p) => p.months[i]).filter((m) => m.status === status));
      return [status, sums];
    })) as Record<PeopleStatus, ReturnType<typeof peopleSummary>>,
  }));
}

/** Pie drill-down levels, top to bottom. Group = the holding group; it is only shown when there is more than one. */
export type ContributionLevel = 'group' | 'company' | 'segment' | 'team' | 'person';
export const CONTRIBUTION_LEVELS: readonly ContributionLevel[] = ['group', 'company', 'segment', 'team', 'person'];
export const CONTRIBUTION_LEVEL_LABEL: Record<ContributionLevel, string> = {
  group: 'Group', company: 'Company', segment: 'Segment', team: 'Team', person: 'Person',
};
const HOLDING_GROUP = { key: 'group', label: 'Holding group' };
const levelOf = (atom: ContributionAtom, level: ContributionLevel, names?: ReadonlyMap<number, string>) => (
  level === 'group' ? HOLDING_GROUP
    : level === 'company' ? { key: String(atom.companyKey), label: atom.companyName }
      : level === 'segment' ? { key: String(atom.segmentKey), label: atom.segmentName }
        : level === 'team' ? { key: atom.teamKey, label: atom.teamName }
          : { key: String(atom.personKey), label: names?.get(atom.personKey) ?? `#${atom.personKey}` });
export interface DrillStep { level: ContributionLevel; key: string; label: string }

/** The level the pie starts at: Group when the atoms span more than one group, else Company. */
export function firstContributionLevel(atoms: ContributionAtom[]): ContributionLevel {
  return new Set(atoms.map((a) => levelOf(a, 'group').key)).size > 1 ? 'group' : 'company';
}

/** Slices of the level below `path` (inside every step of the path), biggest actual first. `share` = slice actual ÷ the
 * sum of the positive actuals (a net-negative slice cannot be drawn in a pie). */
export function contributionSlices(atoms: ContributionAtom[], path: DrillStep[], personKeys: ReadonlySet<number>,
  names?: ReadonlyMap<number, string>) {
  const start = CONTRIBUTION_LEVELS.indexOf(firstContributionLevel(atoms));
  const level = CONTRIBUTION_LEVELS[start + path.length] ?? null;
  if (!level) return { level: null, slices: [] };
  const inside = atoms.filter((a) => personKeys.has(a.personKey) && path.every((s) => levelOf(a, s.level).key === s.key));
  const slices = new Map<string, { key: string; label: string; actual: number; target: number; people: Set<number> }>();
  for (const atom of inside) {
    const { key, label } = levelOf(atom, level, names);
    const slice = slices.get(key) ?? { key, label, actual: 0, target: 0, people: new Set<number>() };
    slice.actual += atom.revenue; slice.target += atom.target; slice.people.add(atom.personKey);
    slices.set(key, slice);
  }
  const positive = [...slices.values()].reduce((sum, s) => sum + Math.max(0, s.actual), 0);
  return {
    level,
    slices: [...slices.values()].map(({ people, ...s }) => ({
      ...s, people: people.size, members: [...people], share: positive > 0 && s.actual > 0 ? s.actual / positive : null,
      achievement: s.target > 0 ? s.actual / s.target : null,
    })).sort((a, b) => b.actual - a.actual || a.label.localeCompare(b.label)),
  };
}

/** The path to a person's main team (where most of their YTD actual, else target, is): Group (when shown) > Company >
 * Segment > Team. Null when the person has no contribution rows. */
export function personPath(atoms: ContributionAtom[], personKey: number): DrillStep[] | null {
  const main = atoms.filter((a) => a.personKey === personKey)
    .sort((a, b) => b.revenue - a.revenue || b.target - a.target)[0];
  if (!main) return null;
  const start = CONTRIBUTION_LEVELS.indexOf(firstContributionLevel(atoms));
  return CONTRIBUTION_LEVELS.slice(start, CONTRIBUTION_LEVELS.indexOf('person'))
    .map((level) => ({ level, ...levelOf(main, level) }));
}

/** The person's share of YTD actual at each level of `path` (deepest first), then of the whole `personKeys` total.
 * Group (the holding group) is always listed, even when the pie does not show it. */
export function personShares(atoms: ContributionAtom[], personKey: number, path: DrillStep[], personKeys: ReadonlySet<number>) {
  const scope = atoms.filter((a) => personKeys.has(a.personKey));
  const share = (inside: (a: ContributionAtom) => boolean) => {
    const node = scope.filter(inside);
    const total = node.reduce((sum, a) => sum + a.revenue, 0);
    const own = node.filter((a) => a.personKey === personKey).reduce((sum, a) => sum + a.revenue, 0);
    return total > 0 ? own / total : null;
  };
  const steps: DrillStep[] = path.some((s) => s.level === 'group') ? path : [{ level: 'group', ...HOLDING_GROUP }, ...path];
  const within = (a: ContributionAtom, depth: number) => steps.slice(0, depth + 1).every((s) => levelOf(a, s.level).key === s.key);
  return [
    ...steps.map((step, depth) => ({ level: step.level as ContributionLevel | 'total', label: step.label,
      share: share((a) => within(a, depth)) })).reverse(),
    { level: 'total' as const, label: 'Total', share: share(() => true) },
  ];
}

export function fetchPeopleOverview(token: string, anchorDate: string, filters: TachometerFilters, signal?: AbortSignal) {
  const query = new URLSearchParams({ anchorDate });
  Object.entries(filters).forEach(([key, values]) => values?.forEach((v: string | number) => query.append(key, String(v))));
  return apiRequest<PeopleOverview>(`/sales-people-performance/overview?${query}`, token, { signal });
}
