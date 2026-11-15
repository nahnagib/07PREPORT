import type { Pool } from 'mysql2/promise';
import { variancePct } from './classify';
import { buildWhereClause, dateOnlyUTC, lytdWindow, monthElapsedFraction, type Filters } from './filters';
import { computeBreakdown, type BreakdownRow } from './tachometer';

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

export async function computeSalesPeoplePerformance(pool: Pool, anchor: Date, filters: Filters) {
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
  const months: { month: string; through: string; rows: BreakdownRow[] }[] = [];
  // Include December as January's MoM baseline; bound concurrency to the shared DB pool.
  for (let m = 0; m <= throughMonth; m++) {
    const end = m === throughMonth ? anchor : dateOnlyUTC(year, m + 1, 0);
    months.push({
      month: end.toISOString().slice(0, 7), through: end.toISOString().slice(0, 10),
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
  const people = [...roster].map(([key, person]) => ({
    key: Number(key), name: person.groupLabel,
    ...performanceFigures(current.get(key)?.actual ?? 0, current.get(key)?.targetToDate ?? null),
    lastYear: prior.get(key)?.actual ?? 0,
    fullYearTarget: full.get(key)?.targetToDate ?? null,
    months: months.slice(1).map((month, i) => {
      const row = monthlyIndexes[i + 1].get(key);
      const previous = monthlyIndexes[i].get(key);
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
  })).filter((p) => p.status !== 'no_target' && !isVacantSalesSeat(p.name)).sort((a, b) => b.actual - a.actual || a.name.localeCompare(b.name));
  // YTD actual and allocated target per person x company x segment x team, for the contribution pie.
  const kept = new Set(people.map((p) => p.key));
  const contributions = [...allocateAtoms(actualAtoms, targetAtoms, current).values()]
    .filter((a) => kept.has(a.personKey))
    .map(({ amount: _amount, ...a }) => a);
  // Months of the year elapsed at the anchor (the anchor month counts by its elapsed days), for monthly run-rates.
  const monthsElapsed = throughMonth - 1 + monthElapsedFraction(anchor);
  return { anchorDate: anchor.toISOString().slice(0, 10), monthsElapsed, statuses: PERFORMANCE_STATUSES, people, contributions };
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
  const dates = source === 'actual' ? 'dd.Date BETWEEN ? AND ?' : 'f.Year = ? AND f.Month BETWEEN 1 AND ?';
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
function allocateAtoms(actuals: ContributionAtom[], targetWeights: ContributionAtom[], personTotals: Map<string, BreakdownRow>) {
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
  return { personKey, rows: [...groups.values()].filter((r) => r.hasPerson).map(({ hasPerson: _hasPerson, ...r }) => ({
    ...r, revenueShare: r.totalRevenue > 0 ? r.revenue / r.totalRevenue : null,
    targetShare: r.totalTarget > 0 ? r.target / r.totalTarget : null,
  })) };
}
