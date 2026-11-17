import type { Pool } from 'mysql2/promise';
import { variancePct } from './classify';
import {
  buildWhereClause, dateOnlyUTC, DIRECTOR_TARGETS, lytdWindow, monthElapsedFraction, PEOPLE_TARGETS, prorateMtdTarget, prorateYtdTarget,
  type Filters,
} from './filters';
import { computeBreakdown, computeMtdCard, computeYtdCard, type BreakdownRow } from './tachometer';

export const PERFORMANCE_STATUSES = [
  { key: 'critical', label: 'Critical', range: '≤50%', benchmark: 0.05, direction: 'max' },
  { key: 'need_attention', label: 'Need attention', range: '>50–90%', benchmark: 0.10, direction: 'max' },
  { key: 'behind_target', label: 'Behind target', range: '>90–<100%', benchmark: 0.15, direction: 'max' },
  { key: 'on_target', label: 'On target', range: '100–110%', benchmark: 0.50, direction: 'min' },
  { key: 'top_performer', label: 'Top performer', range: '>110%', benchmark: 0.20, direction: 'min' },
] as const;
/** 'no_target' only ever describes a month: people without a positive YTD target are left out of the page entirely. */
export type PerformanceStatus = typeof PERFORMANCE_STATUSES[number]['key'] | 'no_target';

export function performanceStatus(actual: number, target: number | null): PerformanceStatus {
  if (target == null || target <= 0) return 'no_target';
  if (actual <= target * 0.5) return 'critical';
  if (actual <= target * 0.9) return 'need_attention';
  if (actual < target) return 'behind_target';
  // Compare values, rather than a rounded display percentage, at every boundary.
  if (actual <= target * 1.1) return 'on_target';
  return 'top_performer';
}

export function performanceFigures(actual: number, target: number | null) {
  return {
    actual, target,
    achievement: target != null && target > 0 ? actual / target : null,
    variance: target != null && target > 0 ? actual - target : null,
    variancePct: variancePct(actual, target),
    status: performanceStatus(actual, target),
  };
}

// Keep in sync with the salesperson picker on the Salesforce Performance page.
function isVacantSalesSeat(name: string) {
  return /^sale(?:s|rs)[\s._-]*person(?:[\s._#-]*\d+)?$/i.test(name.trim());
}

function index(rows: BreakdownRow[]) {
  return new Map(rows.map((row) => [String(row.groupKey), row]));
}

/** The two channel owners. A director IS a sales person (2026-11-16): the same row (personRow), the same tiers, ranking
 * and drill-down; only the numbers differ -- actual = the channel's sales, target = the director's own target. Who the
 * director is and that target come from sales_targets.xlsx (2026-11-17): its TargetLevel = Director rows (fetchDirectors). */
export const DIRECTOR_CHANNELS = [
  { channel: 'B2B', segmentKey: 1, roleLabel: 'B2B Director' },
  { channel: 'B2C', segmentKey: 2, roleLabel: 'B2C Director' },
] as const;
export type DirectorChannel = (typeof DIRECTOR_CHANNELS)[number]['channel'];

export interface SalesforceOptions {
  /** Per channel, the filters a director is computed with: the page filters with Customer Group = that channel,
   * narrowed by the caller's role scope (null = the caller may not see that channel: no director). Absent = no directors. */
  directorFilters?: Partial<Record<DirectorChannel, Filters | null>>;
  /** The reconciliation of the company total with the listed people (admins only). */
  withReconciliation?: boolean;
}

/** YTD figures of a total from the Tachometer YTD Value card (measures/tachometer.ts computeYtdCard): the same actual,
 * the same prorated target-to-date with the same overrides and the same filters -- the Team pulse never drifts from it. */
function totalFigures(card: Awaited<ReturnType<typeof computeYtdCard>>) {
  return { ...performanceFigures(card.actual, card.targetToDate), fullYearTarget: card.fullPeriodTarget };
}

/** The total of the people a Salesperson filter picked (used when it picks a director). */
function pickedTotal(people: { actual: number; target: number | null; fullYearTarget: number | null }[]) {
  const sum = people.reduce((t, p) => ({ actual: t.actual + p.actual, target: t.target + (p.target ?? 0),
    full: t.full + (p.fullYearTarget ?? 0) }), { actual: 0, target: 0, full: 0 });
  return { ...performanceFigures(sum.actual, sum.target), fullYearTarget: sum.full };
}

/** A director of the year: the TargetLevel = Director rows of sales_targets.xlsx for one salesperson and segment. */
export interface Director {
  key: number; name: string; segmentKey: number;
  /** The director's own target per month, January first (index 0). */
  monthly: number[];
}

/**
 * The year's directors (2026-11-17): every SalespersonKey with TargetLevel = Director rows of SalesSegment B2B / B2C, with
 * the name of the Salesperson filter (dim_salesperson, admin name override first). The raw SegmentKey of the row decides
 * the channel -- an admin segment override of the director's own invoices never moves the director's target.
 */
export async function fetchDirectors(pool: Pool, year: number): Promise<Director[]> {
  const [rows] = await pool.query(
    `SELECT f.SalespersonKey AS personKey, f.SegmentKey AS segmentKey, f.Month AS month,
       MAX(COALESCE(sap.admin_name_override, ds.salesperson, f.Salesperson)) AS name,
       SUM(f.Target_Revenue) AS target
     FROM v_sales_targets f
     LEFT JOIN dim_salesperson ds ON ds.SalespersonKey = f.SalespersonKey
     LEFT JOIN salesperson_admin_profile sap ON sap.salesperson_key = f.SalespersonKey
     WHERE f.Year = ? AND ${DIRECTOR_TARGETS('f')} AND f.SalespersonKey > 0 AND f.SegmentKey IN (?)
     GROUP BY f.SalespersonKey, f.SegmentKey, f.Month`,
    [year, DIRECTOR_CHANNELS.map((d) => d.segmentKey)],
  );
  const out = new Map<string, Director>();
  for (const r of rows as { personKey: number; segmentKey: number; month: number; name: string | null; target: number }[]) {
    const id = `${r.personKey}:${r.segmentKey}`;
    const d = out.get(id) ?? { key: Number(r.personKey), name: r.name ?? `Salesperson ${r.personKey}`,
      segmentKey: Number(r.segmentKey), monthly: Array(12).fill(0) };
    if (r.month >= 1 && r.month <= 12) d.monthly[r.month - 1] += Number(r.target);
    out.set(id, d);
  }
  return [...out.values()].sort((a, b) => a.segmentKey - b.segmentKey || a.name.localeCompare(b.name));
}

/** A director's own target, the Tachometer's way (filters.ts proration, no admin override): YTD target-to-date at
 * `anchor` and the full year. */
export function directorTargets(monthly: number[], anchor: Date) {
  const month = anchor.getUTCMonth() + 1;
  return {
    ytd: prorateYtdTarget(monthly.slice(0, month - 1).reduce((t, v) => t + v, 0), monthly[month - 1], anchor) ?? 0,
    fullYear: monthly.reduce((t, v) => t + v, 0),
  };
}

/** A director's own MTD target-to-date at a month end (null for December of last year: no director rows read). */
function directorMtdTarget(monthly: number[], end: Date, year: number) {
  return end.getUTCFullYear() === year ? prorateMtdTarget(monthly[end.getUTCMonth()], end) ?? 0 : null;
}

/** The director rows hold one target per segment: they cannot be cut by company, distribution channel or team. Under
 * such a filter the director's target is the channel's Salesperson targets for the same slice instead. */
function narrowsBelowSegment(f: Filters) {
  return !!(f.companyKeys?.length || f.channelKeys?.length || f.salesTeamKeys?.length);
}

/** Actual and target-to-date of one person in one period (a breakdown row, or a Tachometer card for a director). */
type PeriodFigures = { actual: number; targetToDate: number | null } | undefined;

/** One row of the people list -- every sales person and every director, the same fields from the same inputs: YTD, the
 * full year (its target), the same period last year (its actual) and each month end, December first (January's MoM
 * baseline). */
function personRow(key: number, name: string, ytd: PeriodFigures, fullYear: PeriodFigures, lastYear: PeriodFigures,
  months: { month: string; through: string }[], monthFigures: PeriodFigures[]) {
  return {
    key, name,
    ...performanceFigures(ytd?.actual ?? 0, ytd?.targetToDate ?? null),
    lastYear: lastYear?.actual ?? 0,
    fullYearTarget: fullYear?.targetToDate ?? null,
    months: months.slice(1).map((month, i) => {
      const row = monthFigures[i + 1];
      const previous = monthFigures[i];
      const figures = performanceFigures(row?.actual ?? 0, row?.targetToDate ?? null);
      const previousFigures = performanceFigures(previous?.actual ?? 0, previous?.targetToDate ?? null);
      return {
        month: month.month, through: month.through, ...figures,
        previousActual: previousFigures.actual,
        momVariancePct: variancePct(figures.actual, previousFigures.actual),
        achievementChange: figures.achievement != null && previousFigures.achievement != null
          ? figures.achievement - previousFigures.achievement : null,
        previousStatus: previousFigures.status,
      };
    }),
  };
}

/**
 * A director as a person: personRow with key = the director's own SalespersonKey (2026-11-17) and the channel's figures.
 * Actual = the Tachometer's own cards with Customer Group = the channel and the page's other filters (the segment's total
 * sales, the same period last year, each month's MTD at the month end). Target = the director's TargetLevel = Director
 * rows, prorated like any target -- or, under a company / channel / team filter, the channel's Salesperson targets of
 * that slice (narrowsBelowSegment). The channel's contribution rows (company / segment / team) are the director's own.
 */
export async function directorPerson(pool: Pool, anchor: Date, filters: Filters, d: Director,
  monthEnds: { month: string; through: string; end: Date }[]) {
  const [ytd, actualAtoms, targetAtoms, ...monthCards] = await Promise.all([
    computeYtdCard(pool, anchor, filters, 'value'),
    fetchContributionAtoms(pool, anchor, filters, 'actual'),
    fetchContributionAtoms(pool, anchor, filters, 'target'),
    ...monthEnds.map((m) => computeMtdCard(pool, m.end, filters, 'value')),
  ]);
  const own = !narrowsBelowSegment(filters);
  const year = anchor.getUTCFullYear();
  const targets = directorTargets(d.monthly, anchor);
  const key = d.key;
  const person = personRow(key, d.name,
    { actual: ytd.actual, targetToDate: own ? targets.ytd : ytd.targetToDate },
    { actual: 0, targetToDate: own ? targets.fullYear : ytd.fullPeriodTarget },
    { actual: ytd.lastYearSamePeriod, targetToDate: null },
    monthEnds, monthCards.map((c, i) => ({ actual: c.actual,
      targetToDate: own ? directorMtdTarget(d.monthly, monthEnds[i].end, year) : c.targetToDate })));
  const atoms = allocateAtoms(asOnePerson(actualAtoms, key), asOnePerson(targetAtoms, key),
    new Map([[String(key), { targetToDate: person.target }]]));
  // eslint-disable-next-line no-unused-vars -- the amount is dropped from the response on purpose
  return { person, contributions: [...atoms.values()].map(({ amount: _amount, ...a }) => a) };
}

/** The channel's contribution rows as one person's: summed per company / segment / team under `key`. */
function asOnePerson(atoms: ContributionAtom[], key: number) {
  const out = new Map<string, ContributionAtom>();
  for (const a of atoms) {
    const id = `${a.companyKey}:${a.segmentKey}:${a.teamKey}`;
    out.set(id, { ...a, personKey: key, amount: (out.get(id)?.amount ?? 0) + a.amount });
  }
  return [...out.values()];
}

export type ReconciliationReason = 'no_target' | 'vacant_seat' | 'director' | 'unassigned' | 'other';

export async function computeSalesPeoplePerformance(pool: Pool, anchor: Date, filters: Filters, options: SalesforceOptions = {}) {
  const year = anchor.getUTCFullYear();
  const throughMonth = anchor.getUTCMonth() + 1;
  const [ytd, fullYear, lastYear, actualAtoms, targetAtoms] = await Promise.all([
    computeBreakdown(pool, anchor, filters, 'ytd', 'value', 'salesperson'),
    // YTD through 31 Dec = the full-year, override-aware target (no sales exist after the anchor yet).
    computeBreakdown(pool, dateOnlyUTC(year, 12, 31), filters, 'ytd', 'value', 'salesperson'),
    computeBreakdown(pool, lytdWindow(anchor).end, filters, 'ytd', 'value', 'salesperson'),
    fetchContributionAtoms(pool, anchor, filters, 'actual'),
    fetchContributionAtoms(pool, anchor, filters, 'target'),
  ]);
  const months: { month: string; through: string; end: Date; rows: BreakdownRow[] }[] = [];
  // Include December as January's MoM baseline; bound concurrency to the shared DB pool.
  for (let m = 0; m <= throughMonth; m++) {
    const end = m === throughMonth ? anchor : dateOnlyUTC(year, m + 1, 0);
    months.push({
      month: end.toISOString().slice(0, 7), through: end.toISOString().slice(0, 10), end,
      rows: await computeBreakdown(pool, end, filters, 'mtd', 'value', 'salesperson'),
    });
  }
  const current = index(ytd);
  const prior = index(lastYear);
  const full = index(fullYear);
  // Include target-only people and those with prior-year activity, even if current sales are zero.
  const roster = new Map([...lastYear.filter((r) => r.actual !== 0), ...months.slice(1).flatMap((m) => m.rows), ...ytd]
    .filter((r) => r.groupKey != null && Number(r.groupKey) > 0)
    .map((r) => [String(r.groupKey), r]));
  const monthlyIndexes = months.map((m) => index(m.rows));
  const people = [...roster].map(([key, person]) => personRow(Number(key), person.groupLabel, current.get(key), full.get(key),
    prior.get(key), months, monthlyIndexes.map((m) => m.get(key))))
    .filter((p) => p.status !== 'no_target' && !isVacantSalesSeat(p.name));
  // YTD actual and allocated target per person x company x segment x team, for the contribution pie.
  const kept = new Set(people.map((p) => p.key));
  const contributions = [...allocateAtoms(actualAtoms, targetAtoms, current).values()]
    .filter((a) => kept.has(a.personKey))
    // eslint-disable-next-line no-unused-vars -- the amount is dropped from the response on purpose
    .map(({ amount: _amount, ...a }) => a);
  // Months of the year elapsed at the anchor (the anchor month counts by its elapsed days), for monthly run-rates.
  const monthsElapsed = throughMonth - 1 + monthElapsedFraction(anchor);

  // Directors (2026-11-17): the TargetLevel = Director rows of sales_targets.xlsx name them (fetchDirectors); people like
  // any other when the caller may see the whole channel and the page's filters keep them: a Customer Group filter without
  // the channel, or a Salesperson filter that does not pick the director, leaves them out; every other filter (company,
  // team, customer ...) narrows their channel figures like anyone's. A channel with no Director rows this year is named in
  // directorVacancies ("B2C Director") for the page's info line.
  const allDirectors = options.directorFilters || options.withReconciliation ? await fetchDirectors(pool, year) : [];
  const directorKeys = new Set(allDirectors.map((d) => d.key));
  const directorVacancies: string[] = [];
  const picked = filters.salespersonKeys;
  const companyCard = await computeYtdCard(pool, anchor, filters, 'value');
  const directorRows: Awaited<ReturnType<typeof directorPerson>>[] = [];
  for (const channel of DIRECTOR_CHANNELS) {
    const f = options.directorFilters?.[channel.channel];
    if (!f) continue;
    const held = allDirectors.filter((d) => d.segmentKey === channel.segmentKey);
    if (!held.length) directorVacancies.push(channel.roleLabel);
    const requested = filters.segmentKeys;
    if (requested?.length && !requested.includes(channel.segmentKey)) continue;
    // one director at a time: each runs ~60 queries at once (12 month cards), two together overflow the pool's queue
    for (const d of held.filter((x) => !picked?.length || picked.includes(x.key))) {
      directorRows.push(await directorPerson(pool, anchor, f, d, months));
    }
  }
  // same rule as the people: no positive YTD target = not on the page
  const directors = directorRows.filter((d) => d.person.status !== 'no_target');
  // A director is listed once, as the director: a plain row of the same key (own invoices) never doubles them.
  const listedPeople = people.filter((p) => !directorKeys.has(p.key));
  const listed = [...listedPeople, ...directors.map((d) => d.person)];
  // The company total = the Tachometer's YTD Value card for the same filters (2026-11-15) -- Salesperson targets only.
  // A Salesperson filter that picks a director has no such total (the card would hold the director's own invoices and no
  // target): the total is then the picked people's sum.
  const pickedDirector = !!picked?.some((k) => directorKeys.has(k));
  const company = pickedDirector ? pickedTotal(listed) : totalFigures(companyCard);

  let reconciliation = null;
  // no company total to reconcile when the total is the picked people (a director picked)
  if (options.withReconciliation && !pickedDirector) {
    const rows = ytd.filter((r) => r.groupKey == null || !kept.has(Number(r.groupKey))).map((r) => {
      const key = r.groupKey == null ? null : Number(r.groupKey);
      const reason: ReconciliationReason = key == null || !(key > 0) ? 'unassigned'
        : directorKeys.has(key) ? 'director'
          : isVacantSalesSeat(r.groupLabel) ? 'vacant_seat'
            : r.targetToDate == null || r.targetToDate <= 0 ? 'no_target' : 'other';
      return { key, name: r.groupLabel, reason, actual: r.actual, target: r.targetToDate ?? 0 };
    }).filter((r) => r.actual !== 0 || r.target !== 0);
    // the sales people's own invoices: a director's figures are the channel's, already on its people (admin check only)
    const sums = listedPeople.reduce((t, p) => ({ actual: t.actual + p.actual, target: t.target + (p.target ?? 0) }), { actual: 0, target: 0 });
    const gap = { actual: company.actual - sums.actual, target: (company.target ?? 0) - sums.target };
    const explained = rows.reduce((t, r) => ({ actual: t.actual + r.actual, target: t.target + r.target }), { actual: 0, target: 0 });
    // anything the per-person rows do not explain is shown, never hidden
    if (Math.abs(gap.actual - explained.actual) > 1 || Math.abs(gap.target - explained.target) > 1) {
      rows.push({ key: null, name: 'Not explained by a salesperson row', reason: 'other',
        actual: gap.actual - explained.actual, target: gap.target - explained.target });
    }
    rows.sort((a, b) => Math.abs(b.actual) - Math.abs(a.actual) || Math.abs(b.target) - Math.abs(a.target));
    reconciliation = { listed: sums, gap, rows };
  }

  return {
    anchorDate: anchor.toISOString().slice(0, 10), monthsElapsed, statuses: PERFORMANCE_STATUSES,
    // a director is a person: everywhere on the page, in every count and sum
    people: listed.sort((a, b) => b.actual - a.actual || a.name.localeCompare(b.name)),
    contributions: [...contributions, ...directors.flatMap((d) => d.contributions)], company, directorVacancies, reconciliation,
  };
}

interface ContributionAtom {
  personKey: number; companyKey: number; companyName: string; segmentKey: number; segmentName: string;
  teamKey: string; teamName: string; amount: number;
}

async function fetchContributionAtoms(pool: Pool, anchor: Date, filters: Filters, source: 'actual' | 'target') {
  const { clause, params } = buildWhereClause(filters, 'f', source === 'actual');
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth() + 1;
  const from = source === 'actual' ? 'v_sales_lines f JOIN dim_date dd ON dd.DateKey = f.DateKey' : 'v_sales_targets f';
  const amount = source === 'actual' ? 'f.value' : 'f.Target_Revenue * (CASE WHEN f.Month = ? THEN ? ELSE 1 END)';
  const dates = source === 'actual' ? 'dd.Date BETWEEN ? AND ?' : `f.Year = ? AND f.Month BETWEEN 1 AND ? AND ${PEOPLE_TARGETS('f')}`;
  const queryParams = source === 'actual'
    ? [`${year}-01-01`, anchor.toISOString().slice(0, 10), ...params]
    : [month, monthElapsedFraction(anchor), year, month, ...params];
  const [rows] = await pool.query(`
    SELECT g.*, COALESCE(dc.Company, 'Unassigned') AS companyName,
      COALESCE(acg.name, ds.Segment, 'Unassigned') AS segmentName,
      COALESCE(stap.team_name_override, dst.SalesTeam, 'Unassigned') AS teamName
    FROM (
      SELECT f.SalespersonKey AS personKey, f.CompanyKey AS companyKey,
        COALESCE(sap.segment_key_override, f.SegmentKey) AS segmentKey,
        COALESCE(sap.sales_team_key_override, f.SalesTeamKey) AS teamKey,
        SUM(${amount}) AS amount
      FROM ${from}
      LEFT JOIN salesperson_admin_profile sap ON sap.salesperson_key = f.SalespersonKey
      WHERE ${dates} AND ${clause}
      GROUP BY f.SalespersonKey, f.CompanyKey, COALESCE(sap.segment_key_override, f.SegmentKey),
        COALESCE(sap.sales_team_key_override, f.SalesTeamKey)
    ) g
    LEFT JOIN dim_company dc ON dc.CompanyKey = g.companyKey
    LEFT JOIN dim_segment ds ON ds.SegmentKey = g.segmentKey
    LEFT JOIN admin_customer_group acg ON acg.etl_segment_key = g.segmentKey
    LEFT JOIN dim_sales_team dst ON dst.SalesTeamKey = g.teamKey
    LEFT JOIN sales_team_admin_profile stap ON stap.sales_team_key = g.teamKey`, queryParams);
  return (rows as ContributionAtom[]).map((r) => ({ ...r, personKey: Number(r.personKey),
    companyKey: Number(r.companyKey), segmentKey: Number(r.segmentKey), teamKey: String(r.teamKey ?? '-1'),
    teamName: r.teamName ?? 'Unassigned', amount: Number(r.amount) }));
}

/** Revenue per atom, plus each person's override-aware YTD target allocated once, using the source plan's YTD
 * proportions. A person serving several companies/segments/teams must not get their full annual override in each. */
function allocateAtoms(actuals: ContributionAtom[], targetWeights: ContributionAtom[],
  personTotals: Map<string, { targetToDate: number | null }>) {
  const weights = new Map<number, { total: number; count: number }>();
  for (const atom of targetWeights) {
    const weight = weights.get(atom.personKey) ?? { total: 0, count: 0 };
    weight.total += Math.max(0, atom.amount); weight.count++;
    weights.set(atom.personKey, weight);
  }
  const atoms = new Map<string, ContributionAtom & { revenue: number; target: number }>();
  const atomKey = (r: ContributionAtom) => `${r.personKey}:${r.companyKey}:${r.segmentKey}:${r.teamKey}`;
  for (const r of actuals) atoms.set(atomKey(r), { ...r, revenue: r.amount, target: 0 });
  for (const r of targetWeights) {
    const weight = weights.get(r.personKey)!;
    const fraction = weight.total > 0 ? Math.max(0, r.amount) / weight.total : 1 / weight.count;
    const target = (personTotals.get(String(r.personKey))?.targetToDate ?? 0) * fraction;
    const previous = atoms.get(atomKey(r));
    atoms.set(atomKey(r), { ...r, revenue: previous?.revenue ?? 0, target });
  }
  return atoms;
}

export async function computePersonContributions(pool: Pool, anchor: Date, authorized: Filters, personKey: number) {
  const [people, actuals, targetWeights] = await Promise.all([
    computeBreakdown(pool, anchor, authorized, 'ytd', 'value', 'salesperson'),
    fetchContributionAtoms(pool, anchor, authorized, 'actual'),
    fetchContributionAtoms(pool, anchor, authorized, 'target'),
  ]);
  const vacantKeys = new Set(people.filter((p) => isVacantSalesSeat(p.groupLabel)).map((p) => Number(p.groupKey)));
  const atoms = allocateAtoms(actuals, targetWeights, index(people));
  const groups = new Map<string, { level: string; key: string; label: string;
    revenue: number; target: number; totalRevenue: number; totalTarget: number; hasPerson: boolean }>();
  for (const r of atoms.values()) {
    if (vacantKeys.has(r.personKey)) continue;
    for (const [level, key, label] of [
      ['group', 'group', 'Holding group (authorized scope)'],
      ['company', String(r.companyKey), r.companyName], ['segment', String(r.segmentKey), r.segmentName],
    ]) {
      const id = `${level}:${key}`;
      const group = groups.get(id) ?? { level, key, label, revenue: 0, target: 0, totalRevenue: 0, totalTarget: 0, hasPerson: false };
      group.totalRevenue += r.revenue; group.totalTarget += r.target;
      if (r.personKey === personKey) { group.revenue += r.revenue; group.target += r.target; group.hasPerson = true; }
      groups.set(id, group);
    }
  }
  // eslint-disable-next-line no-unused-vars -- hasPerson is dropped from the response on purpose
  return { personKey, rows: [...groups.values()].filter((r) => r.hasPerson).map(({ hasPerson: _hasPerson, ...r }) => ({
    ...r, revenueShare: r.totalRevenue > 0 ? r.revenue / r.totalRevenue : null,
    targetShare: r.totalTarget > 0 ? r.target / r.totalTarget : null,
  })) };
}
