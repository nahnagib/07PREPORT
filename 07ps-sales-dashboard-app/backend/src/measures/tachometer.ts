/**
 * Tachometer page metric definitions.
 *
 * Ported 1:1 from data/warehouse/measures/tachometer.py (the validated Python reference, tested
 * against real historical data -- see data/ingestion/tachometer_kpi_validation.md).
 *
 * Every metric in the manual's KPI table, mapped to its exact warehouse source:
 *
 *   Metric                  | Source table(s)                        | How
 *   ------------------------|-----------------------------------------|---------------------------
 *   YTD/MTD Value           | Fact_SalesLines (value, filtered)                 | SUM over the date window,
 *   YTD/MTD Volume          | Fact_SalesLines (volume, filtered)                | joined to dim_date on
 *                           |                                           | date_key, filtered by the
 *                           |                                           | five filter columns
 *   ASP (YTD/MTD)           | derived                                  | Value / Volume (JS, not
 *                           |                                           | SQL -- avoids a
 *                           |                                           | divide-by-zero in SQL)
 *   LYTD/LMTD               | Fact_SalesLines (filtered)                                | same query, prior-year
 *                           |                                           | date window
 *   FLY/FLM                 | Fact_SalesLines (filtered)                                | same query, full prior
 *                           |                                           | calendar year/month window
 *   FY/FM Target             | fact_target_plan (target_revenue,        | SUM grouped by
 *                            | target_volume)                           | target_year/target_month
 *                            |                                          | (NOT date_key -- see
 *                            |                                          | KNOWN_ISSUES.md; date_key
 *                            |                                          | is broken for 12 rows)
 *   Target-to-date           | fact_target_plan, prorated in JS          | see filters.ts's
 *   (grey needle reference)  |                                          | prorateMtdTarget /
 *                            |                                          | prorateYtdTarget
 *
 * Fact_SalesLines (filtered) vs. Fact_SalesLines (filtered)_line for Value/Volume
 * --------------------------------------------------
 * Value/Volume use Fact_SalesLines (filtered), not Fact_SalesLines (filtered)_line. Fact_SalesLines (filtered) is the order-HEADER revenue fact
 * (one row per confirmed order); Fact_SalesLines (filtered)_line is invoice-LINE grain built for the Invoices
 * Engine page's per-invoice efficiency metrics -- using it here would double-count orders with
 * multiple lines.
 */

import type { Pool } from 'mysql2/promise';
import { classifyVsTarget, variancePct, TargetStatus } from './classify';
import {
  buildWhereClause,
  dateOnlyUTC,
  effectiveSalesTeamExpr,
  effectiveSegmentExpr,
  flmWindow,
  flyWindow,
  lmtdWindow,
  lytdWindow,
  monthElapsedFraction,
  mtdWindow,
  prorateMtdTarget,
  prorateYtdTarget,
  ytdWindow,
  type DateWindow,
  type Filters,
} from './filters';

export interface ValueVolume {
  value: number;
  volume: number;
}

export function asp(vv: ValueVolume): number | null {
  if (!vv.volume) {
    return null;
  }
  return vv.value / vv.volume;
}

export interface TargetFigures {
  targetRevenue: number;
  targetVolume: number;
}

function toDateOnlyString(d: Date): string {
  // MySQL DATE comparison against a 'YYYY-MM-DD' string works regardless of session timezone,
  // since dim_date.calendar_date is a DATE column (no time component).
  return d.toISOString().slice(0, 10);
}

/** Value/Volume summed from Fact_SalesLines (filtered) for a date window + filter selection. */
export async function fetchValueVolume(
  pool: Pool,
  window: DateWindow,
  filters: Filters,
): Promise<ValueVolume> {
  const { clause, params } = buildWhereClause(filters, 'fsl');
  const sql = `
    SELECT
      COALESCE(SUM(fsl.value), 0)  AS value,
      COALESCE(SUM(fsl.volume), 0) AS volume
    FROM Fact_SalesLines fsl
    JOIN Dim_Date dd ON fsl.DateKey = dd.DateKey
    WHERE dd.Date BETWEEN ? AND ?
      AND ${clause}
  `;
  const [rows] = await pool.query(sql, [
    toDateOnlyString(window.start),
    toDateOnlyString(window.end),
    ...params,
  ]);
  const row = (rows as any[])[0];
  return { value: Number(row.value), volume: Number(row.volume) };
}

/**
 * Admin target-override blending (Reports/Dashboards Honor Admin Salesperson Overrides, 2026-09,
 * companion to filters.ts's effectiveSegmentExpr/effectiveChannelExpr/effectiveSalesTeamExpr on the
 * revenue side). `salesperson_admin_profile.target_override_amount` is a single flat annual figure
 * -- Fact_Targets (and everything else in this system) has no granularity finer than a calendar
 * month, so rather than invent a new day-of-year precision nothing else uses, an override is
 * treated as an even 12-way monthly split and injected as if it were that salesperson's real
 * Fact_Targets data. That lets every existing consumer of fetchTargetForMonths/
 * fetchTargetForMonthsGrouped below (mtdTargetToDate/ytdTargetToDate's prorateMtdTarget/
 * prorateYtdTarget, fullPeriodTargetForMtd/Ytd, and criticalNumber.ts's FY-target/working-days
 * arithmetic) inherit correct override-aware figures with ZERO changes on their end -- the
 * substitution happens once, here, at the shared source both functions already were.
 *
 * `targetVolume` is NEVER touched by an override -- there is no volume-override column in the
 * schema, so volume-based targets stay 100% real Fact_Targets data, unconditionally, everywhere.
 *
 * Known, accepted limitation: a salesperson with an override but zero matching Fact_Targets rows
 * (e.g. no ETL target-plan data exists for them at all this year) never appears in the grouped
 * query below and so contributes nothing -- same as this system's pre-override behavior. Revisit
 * only if that turns out to matter in practice; not fixed here since it wasn't part of what was
 * asked for.
 */
async function fetchMonthlyOverrideAmounts(pool: Pool, salespersonKeys: number[]): Promise<Map<number, number>> {
  const uniqueKeys = Array.from(new Set(salespersonKeys));
  if (uniqueKeys.length === 0) return new Map();
  const [rows] = await pool.query(
    `SELECT salesperson_key, target_override_amount FROM salesperson_admin_profile
     WHERE salesperson_key IN (?) AND target_override_amount IS NOT NULL`,
    [uniqueKeys],
  );
  return new Map((rows as any[]).map((r) => [Number(r.salesperson_key), Number(r.target_override_amount) / 12]));
}

/** How many real months this fetchTargetForMonths(Grouped) call's opts represents -- an
 * overridden salesperson's flat per-month split is multiplied by this so it composes with the
 * caller's own proration math exactly as a real multi-month Fact_Targets sum would. */
function monthCountForOpts(opts: { month?: number; monthLt?: number }): number {
  if (opts.month !== undefined) return 1;
  if (opts.monthLt !== undefined) return Math.max(0, opts.monthLt - 1);
  return 12;
}

/**
 * Sum fact_target_plan.target_revenue/target_volume for a given target_year, optionally narrowed
 * to one target_month (month=) or "months strictly before" (monthLt=), used by the YTD proration
 * helper to sum already-completed months. Filters by target_year/target_month, NOT date_key -- see
 * module docstring and KNOWN_ISSUES.md for why.
 */
export async function fetchTargetForMonths(
  pool: Pool,
  year: number,
  filters: Filters,
  opts: { month?: number; monthLt?: number } = {},
): Promise<TargetFigures> {
  const { clause, params } = buildWhereClause(filters, 'ftp');
  const conditions = ['ftp.Year = ?'];
  const queryParams: Array<string | number> = [year];

  if (opts.month !== undefined) {
    conditions.push('ftp.Month = ?');
    queryParams.push(opts.month);
  } else if (opts.monthLt !== undefined) {
    conditions.push('ftp.Month < ?');
    queryParams.push(opts.monthLt);
  }

  queryParams.push(...params);

  const sql = `
    SELECT
      ftp.SalespersonKey AS salespersonKey,
      COALESCE(SUM(ftp.Target_Revenue), 0) AS target_revenue,
      COALESCE(SUM(ftp.Target_Volume), 0)  AS target_volume
    FROM Fact_Targets ftp
    WHERE ${conditions.join(' AND ')} AND ${clause}
    GROUP BY ftp.SalespersonKey
  `;
  const [rows] = await pool.query(sql, queryParams);
  const perSalesperson = rows as { salespersonKey: number; target_revenue: number; target_volume: number }[];

  const overrides = await fetchMonthlyOverrideAmounts(pool, perSalesperson.map((r) => Number(r.salespersonKey)));
  const monthCount = monthCountForOpts(opts);

  let targetRevenue = 0;
  let targetVolume = 0;
  for (const row of perSalesperson) {
    const overrideMonthly = overrides.get(Number(row.salespersonKey));
    targetRevenue += overrideMonthly !== undefined ? overrideMonthly * monthCount : Number(row.target_revenue);
    targetVolume += Number(row.target_volume);
  }
  return { targetRevenue, targetVolume };
}

export type Metric = 'value' | 'volume';

/** Everything one tachometer/ASP card needs to render, for one metric family at one granularity. */
export interface TachometerCard {
  actual: number;
  targetToDate: number | null;
  status: TargetStatus;
  variancePct: number | null;
  lastYearSamePeriod: number;
  fullLastPeriodActual: number;
  fullPeriodTarget: number;
}

async function mtdTargetToDate(
  pool: Pool,
  anchor: Date,
  filters: Filters,
): Promise<TargetFigures> {
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth() + 1;
  const fm = await fetchTargetForMonths(pool, year, filters, { month });
  return {
    targetRevenue: prorateMtdTarget(fm.targetRevenue, anchor) ?? 0,
    targetVolume: prorateMtdTarget(fm.targetVolume, anchor) ?? 0,
  };
}

async function ytdTargetToDate(
  pool: Pool,
  anchor: Date,
  filters: Filters,
): Promise<TargetFigures> {
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth() + 1;
  const completed = await fetchTargetForMonths(pool, year, filters, { monthLt: month });
  const currentMonth = await fetchTargetForMonths(pool, year, filters, { month });
  return {
    targetRevenue: prorateYtdTarget(completed.targetRevenue, currentMonth.targetRevenue, anchor) ?? 0,
    targetVolume: prorateYtdTarget(completed.targetVolume, currentMonth.targetVolume, anchor) ?? 0,
  };
}

async function fullPeriodTargetForMtd(pool: Pool, anchor: Date, filters: Filters) {
  return fetchTargetForMonths(pool, anchor.getUTCFullYear(), filters, {
    month: anchor.getUTCMonth() + 1,
  });
}

async function fullPeriodTargetForYtd(pool: Pool, anchor: Date, filters: Filters) {
  return fetchTargetForMonths(pool, anchor.getUTCFullYear(), filters);
}

async function computeCard(
  pool: Pool,
  anchor: Date,
  filters: Filters,
  metric: Metric,
  currentWindow: DateWindow,
  lastYearWindow: DateWindow,
  fullLastPeriodWindow: DateWindow,
  targetToDateFn: (pool: Pool, anchor: Date, filters: Filters) => Promise<TargetFigures>,
  fullPeriodTargetFn: (pool: Pool, anchor: Date, filters: Filters) => Promise<TargetFigures>,
): Promise<TachometerCard> {
  const [current, lastYear, fullLastPeriod, targetToDate, fullPeriodTarget] = await Promise.all([
    fetchValueVolume(pool, currentWindow, filters),
    fetchValueVolume(pool, lastYearWindow, filters),
    fetchValueVolume(pool, fullLastPeriodWindow, filters),
    targetToDateFn(pool, anchor, filters),
    fullPeriodTargetFn(pool, anchor, filters),
  ]);

  let actual: number;
  let targetToDateValue: number;
  let fullTargetValue: number;
  let lastYearValue: number;
  let fullLastValue: number;

  if (metric === 'value') {
    actual = current.value;
    targetToDateValue = targetToDate.targetRevenue;
    fullTargetValue = fullPeriodTarget.targetRevenue;
    lastYearValue = lastYear.value;
    fullLastValue = fullLastPeriod.value;
  } else {
    actual = current.volume;
    targetToDateValue = targetToDate.targetVolume;
    fullTargetValue = fullPeriodTarget.targetVolume;
    lastYearValue = lastYear.volume;
    fullLastValue = fullLastPeriod.volume;
  }

  return {
    actual,
    targetToDate: targetToDateValue,
    status: classifyVsTarget(actual, targetToDateValue),
    variancePct: variancePct(actual, targetToDateValue),
    lastYearSamePeriod: lastYearValue,
    fullLastPeriodActual: fullLastValue,
    fullPeriodTarget: fullTargetValue,
  };
}

export async function computeMtdCard(
  pool: Pool,
  anchor: Date,
  filters: Filters,
  metric: Metric,
): Promise<TachometerCard> {
  return computeCard(
    pool,
    anchor,
    filters,
    metric,
    mtdWindow(anchor),
    lmtdWindow(anchor),
    flmWindow(anchor),
    mtdTargetToDate,
    fullPeriodTargetForMtd,
  );
}

export async function computeYtdCard(
  pool: Pool,
  anchor: Date,
  filters: Filters,
  metric: Metric,
): Promise<TachometerCard> {
  return computeCard(
    pool,
    anchor,
    filters,
    metric,
    ytdWindow(anchor),
    lytdWindow(anchor),
    flyWindow(anchor),
    ytdTargetToDate,
    fullPeriodTargetForYtd,
  );
}

export interface AspCard {
  actualAsp: number | null;
  targetAsp: number | null;
  /** Same-period-last-year ASP (LYTD ASP for the YTD card, LMTD ASP for the MTD card) -- derived
   * the same way actualAsp is (value/volume, JS-side to avoid a SQL divide-by-zero), from a
   * last-year ValueVolume fetch the caller already needs to make (see routes/tachometer.ts). Powers
   * the "Variance vs LY" reference-metric tile, matching the Value/Volume gauge cards' own
   * lastYearSamePeriod-based variance. */
  lastYearAsp: number | null;
  status: TargetStatus;
}

/**
 * ASP cards use the same classifyVsTarget logic as the tachometers (manual: "ASP cards use the
 * same color logic as the tachometers"). Target ASP = Full Year/Month Target's own
 * target_revenue/target_volume ratio, i.e. the target's implied ASP, not the actual period's
 * volume mixed with the target's revenue.
 */
export function computeAspCard(
  valueVolume: ValueVolume,
  targetFigures: TargetFigures,
  lastYearValueVolume?: ValueVolume,
): AspCard {
  const actualAsp = asp(valueVolume);
  const targetAsp = targetFigures.targetVolume ? targetFigures.targetRevenue / targetFigures.targetVolume : null;
  return {
    actualAsp,
    targetAsp,
    lastYearAsp: lastYearValueVolume ? asp(lastYearValueVolume) : null,
    status: classifyVsTarget(actualAsp, targetAsp),
  };
}


// ---------------------------------------------------------------------------
// Breakdown-by-dimension (drill-down page) -- NEW this pass, not a port of the Python reference.
// The original data/warehouse/measures/tachometer.py never needed a grouped view (the manual's
// Tachometer spec is card-level totals only); this is new logic built for the drill-down feature,
// but it reuses every existing primitive (classifyVsTarget, variancePct, monthElapsedFraction,
// mtdWindow/ytdWindow) rather than inventing a second classification or proration scheme. Each
// breakdown row is classified by the exact same classifyVsTarget() the top-level card uses, so a
// row's color can never disagree with how the aggregate gauge itself would be classified.
// ---------------------------------------------------------------------------

export type GroupBy = 'salesperson' | 'salesTeam' | 'segment';

/**
 * Reworked for admin-override reclassification (see filters.ts's effective*Expr docstring):
 * segment/salesTeam now group by a COMPUTED effective key (own override, falling back to the raw
 * column) rather than the raw column directly, and resolve their label against the relevant admin
 * overlay table first. salesperson keeps its raw, unambiguous key -- an override never changes
 * which salesperson a row belongs to -- but now prefers admin_name_override for its label too.
 *
 * `keyJoin`/`keyExpr` are evaluated inside an aggregated derived table aliased `gk` (see
 * fetchValueVolumeGrouped/fetchTargetForMonthsGrouped below); `labelJoins`/`labelExpr` then join
 * against `gk.group_key` (a plain column by that point, not a repeated correlated subquery) to
 * resolve the display name once per group, not once per underlying Fact_* row.
 *
 * `keyExpr` deliberately does NOT reuse filters.ts's effectiveSegmentExpr/effectiveSalesTeamExpr
 * (the correlated-subquery versions used by buildWhereClause) -- MySQL's ONLY_FULL_GROUP_BY
 * sql_mode rejects a GROUP BY expression containing a correlated subquery that references an
 * outer column, even when it's textually identical to the SELECT expression above it. `keyJoin`
 * instead joins salesperson_admin_profile directly into the inner aggregation query's FROM clause
 * (a plain 1:1-or-0 join on its PK), so keyExpr can reference a joined column instead.
 */
interface GroupConfig {
  keyJoin: (factAlias: string) => string;
  keyExpr: (factAlias: string) => string;
  labelJoins: string;
  labelExpr: string;
}

const GROUP_CONFIG: Record<GroupBy, GroupConfig> = {
  salesperson: {
    keyJoin: () => '',
    keyExpr: (alias) => `${alias}.SalespersonKey`,
    labelJoins: `
      LEFT JOIN dim_salesperson dsp ON gk.group_key = dsp.SalespersonKey
      LEFT JOIN salesperson_admin_profile sap ON gk.group_key = sap.salesperson_key
    `,
    labelExpr: 'COALESCE(sap.admin_name_override, dsp.salesperson)',
  },
  salesTeam: {
    keyJoin: (alias) => `LEFT JOIN salesperson_admin_profile sap_key ON sap_key.salesperson_key = ${alias}.SalespersonKey`,
    keyExpr: (alias) => `COALESCE(sap_key.sales_team_key_override, ${alias}.SalesTeamKey)`,
    labelJoins: `
      LEFT JOIN dim_salesteam dst ON gk.group_key = dst.SalesTeamKey
      LEFT JOIN sales_team_admin_profile stap ON gk.group_key = stap.sales_team_key
    `,
    labelExpr: 'COALESCE(stap.team_name_override, dst.SalesTeam)',
  },
  segment: {
    keyJoin: (alias) => `LEFT JOIN salesperson_admin_profile sap_key ON sap_key.salesperson_key = ${alias}.SalespersonKey`,
    keyExpr: (alias) => `COALESCE(sap_key.segment_key_override, ${alias}.SegmentKey)`,
    labelJoins: `
      LEFT JOIN dim_segment dsg ON gk.group_key = dsg.SegmentKey
      LEFT JOIN admin_customer_group acg ON gk.group_key = acg.etl_segment_key
    `,
    labelExpr: 'COALESCE(acg.name, dsg.Segment)',
  },
};

interface GroupedValueVolume {
  groupKey: string | number | null;
  groupLabel: string;
  value: number;
  volume: number;
}

interface GroupedTargetFigures {
  groupKey: string | number | null;
  groupLabel: string;
  targetRevenue: number;
  targetVolume: number;
}

async function fetchValueVolumeGrouped(
  pool: Pool,
  window: DateWindow,
  filters: Filters,
  groupBy: GroupBy,
): Promise<GroupedValueVolume[]> {
  const { clause, params } = buildWhereClause(filters, 'fsl');
  const cfg = GROUP_CONFIG[groupBy];
  const keyExpr = cfg.keyExpr('fsl');
  const sql = `
    SELECT
      gk.group_key AS group_key,
      COALESCE(${cfg.labelExpr}, 'Unassigned') AS group_label,
      gk.value AS value,
      gk.volume AS volume
    FROM (
      SELECT
        ${keyExpr} AS group_key,
        COALESCE(SUM(fsl.value), 0)  AS value,
        COALESCE(SUM(fsl.volume), 0) AS volume
      FROM Fact_SalesLines fsl
      JOIN Dim_Date dd ON fsl.DateKey = dd.DateKey
      ${cfg.keyJoin('fsl')}
      WHERE dd.Date BETWEEN ? AND ?
        AND ${clause}
      GROUP BY ${keyExpr}
    ) gk
    ${cfg.labelJoins}
  `;
  const [rows] = await pool.query(sql, [
    toDateOnlyString(window.start),
    toDateOnlyString(window.end),
    ...params,
  ]);
  return (rows as any[]).map((r) => ({
    groupKey: r.group_key,
    groupLabel: String(r.group_label),
    value: Number(r.value),
    volume: Number(r.volume),
  }));
}

/**
 * Grouped by (SalespersonKey, effective group key) one level finer than the GroupedTargetFigures[]
 * the caller wants, so an overridden salesperson's flat target can be substituted in per-salesperson
 * before re-aggregating up to the group level -- same override-blending logic as the ungrouped
 * fetchTargetForMonths above, just re-aggregated by groupBy afterward instead of summed to one
 * total. Two overridden salespeople who share a reclassified segment/team correctly collapse into
 * one summed group row.
 */
async function fetchTargetForMonthsGrouped(
  pool: Pool,
  year: number,
  filters: Filters,
  groupBy: GroupBy,
  opts: { month?: number; monthLt?: number } = {},
): Promise<GroupedTargetFigures[]> {
  const { clause, params } = buildWhereClause(filters, 'ftp');
  const cfg = GROUP_CONFIG[groupBy];
  const keyExpr = cfg.keyExpr('ftp');
  const conditions = ['ftp.Year = ?'];
  const queryParams: Array<string | number> = [year];

  if (opts.month !== undefined) {
    conditions.push('ftp.Month = ?');
    queryParams.push(opts.month);
  } else if (opts.monthLt !== undefined) {
    conditions.push('ftp.Month < ?');
    queryParams.push(opts.monthLt);
  }
  queryParams.push(...params);

  const sql = `
    SELECT
      gk.salespersonKey AS salespersonKey,
      gk.group_key AS group_key,
      COALESCE(${cfg.labelExpr}, 'Unassigned') AS group_label,
      gk.target_revenue AS target_revenue,
      gk.target_volume AS target_volume
    FROM (
      SELECT
        ftp.SalespersonKey AS salespersonKey,
        ${keyExpr} AS group_key,
        COALESCE(SUM(ftp.Target_Revenue), 0) AS target_revenue,
        COALESCE(SUM(ftp.Target_Volume), 0)  AS target_volume
      FROM Fact_Targets ftp
      ${cfg.keyJoin('ftp')}
      WHERE ${conditions.join(' AND ')} AND ${clause}
      GROUP BY ftp.SalespersonKey, ${keyExpr}
    ) gk
    ${cfg.labelJoins}
  `;
  const [rows] = await pool.query(sql, queryParams);
  const perSalespersonGroup = rows as {
    salespersonKey: number;
    group_key: string | number | null;
    group_label: string;
    target_revenue: number;
    target_volume: number;
  }[];

  const overrides = await fetchMonthlyOverrideAmounts(pool, perSalespersonGroup.map((r) => Number(r.salespersonKey)));
  const monthCount = monthCountForOpts(opts);

  const byGroup = new Map<string, GroupedTargetFigures>();
  for (const row of perSalespersonGroup) {
    const key = String(row.group_key);
    const overrideMonthly = overrides.get(Number(row.salespersonKey));
    const targetRevenue = overrideMonthly !== undefined ? overrideMonthly * monthCount : Number(row.target_revenue);
    const targetVolume = Number(row.target_volume); // never overridden -- no volume-override column exists
    const existing = byGroup.get(key);
    if (existing) {
      existing.targetRevenue += targetRevenue;
      existing.targetVolume += targetVolume;
    } else {
      byGroup.set(key, { groupKey: row.group_key, groupLabel: row.group_label, targetRevenue, targetVolume });
    }
  }
  return Array.from(byGroup.values());
}

export interface BreakdownRow {
  groupKey: string | number | null;
  groupLabel: string;
  actual: number;
  targetToDate: number | null;
  status: TargetStatus;
  variancePct: number | null;
}

export type Period = 'mtd' | 'ytd';

/**
 * Per-group breakdown for one metric/period, sorted descending by actual. Reuses mtdWindow/
 * ytdWindow, monthElapsedFraction, classifyVsTarget, and variancePct unchanged -- the only new
 * code here is the GROUP BY plumbing itself.
 */
export async function computeBreakdown(
  pool: Pool,
  anchor: Date,
  filters: Filters,
  period: Period,
  metric: Metric,
  groupBy: GroupBy,
): Promise<BreakdownRow[]> {
  const window = period === 'mtd' ? mtdWindow(anchor) : ytdWindow(anchor);
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth() + 1;
  const fraction = monthElapsedFraction(anchor);

  const [valueVolumeRows, targetRowsRaw] = await Promise.all([
    fetchValueVolumeGrouped(pool, window, filters, groupBy),
    period === 'mtd'
      ? fetchTargetForMonthsGrouped(pool, year, filters, groupBy, { month })
      : Promise.all([
          fetchTargetForMonthsGrouped(pool, year, filters, groupBy, { monthLt: month }),
          fetchTargetForMonthsGrouped(pool, year, filters, groupBy, { month }),
        ]),
  ]);

  // Build a groupKey -> prorated target-figures map, identical proration math to the top-level
  // card (mtdTargetToDate/ytdTargetToDate above), just repeated per group instead of once overall.
  const targetByGroup = new Map<string, GroupedTargetFigures>();
  if (period === 'mtd') {
    for (const r of targetRowsRaw as GroupedTargetFigures[]) {
      targetByGroup.set(String(r.groupKey), {
        ...r,
        targetRevenue: r.targetRevenue * fraction,
        targetVolume: r.targetVolume * fraction,
      });
    }
  } else {
    const [completed, current] = targetRowsRaw as [GroupedTargetFigures[], GroupedTargetFigures[]];
    for (const r of completed) {
      targetByGroup.set(String(r.groupKey), { ...r });
    }
    for (const r of current) {
      const key = String(r.groupKey);
      const existing = targetByGroup.get(key) ?? {
        groupKey: r.groupKey,
        groupLabel: r.groupLabel,
        targetRevenue: 0,
        targetVolume: 0,
      };
      existing.targetRevenue += r.targetRevenue * fraction;
      existing.targetVolume += r.targetVolume * fraction;
      targetByGroup.set(key, existing);
    }
  }

  const rows = new Map<string, BreakdownRow>();
  for (const r of valueVolumeRows) {
    const key = String(r.groupKey);
    rows.set(key, {
      groupKey: r.groupKey,
      groupLabel: r.groupLabel,
      actual: metric === 'value' ? r.value : r.volume,
      targetToDate: null,
      status: TargetStatus.NO_TARGET,
      variancePct: null,
    });
  }
  for (const [key, t] of targetByGroup) {
    const targetVal = metric === 'value' ? t.targetRevenue : t.targetVolume;
    const existing = rows.get(key);
    if (existing) {
      existing.targetToDate = targetVal;
    } else {
      rows.set(key, {
        groupKey: t.groupKey,
        groupLabel: t.groupLabel,
        actual: 0,
        targetToDate: targetVal,
        status: TargetStatus.NO_TARGET,
        variancePct: null,
      });
    }
  }

  const result = Array.from(rows.values()).map((r) => ({
    ...r,
    status: classifyVsTarget(r.actual, r.targetToDate),
    variancePct: variancePct(r.actual, r.targetToDate),
  }));
  result.sort((a, b) => b.actual - a.actual);
  return result;
}


// ---------------------------------------------------------------------------
// Monthly trend series (Revenue/Volume/ASP/Monthly Achievement charts) -- NEW this pass. Deferred
// in an earlier session ("sparkline skipped - needs new endpoint, out of scope this pass") and now
// picked back up per an explicit request for real trend charts, which genuinely cannot be built
// without month-by-month data. Reuses fetchValueVolume/fetchTargetForMonths/classifyVsTarget/asp
// unchanged -- this is one more grouped-fetch pattern (grouped by calendar month instead of by
// filter dimension, the same shape as computeBreakdown's grouped-by-dimension approach), not a new
// query strategy.
// ---------------------------------------------------------------------------

const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** One calendar month's window, clipped to `anchor` if this is the anchor's own (possibly
 * partial) month -- consistent with mtdWindow/ytdWindow's "never look past anchor" semantics.
 * Exported for revenueTrend.ts, which needs the identical current-year month-window logic (only
 * the prior-year window differs there -- see that file's monthWindowFull). */
export function monthWindow(year: number, month: number, anchor: Date): DateWindow {
  const start = dateOnlyUTC(year, month, 1);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const naturalEnd = dateOnlyUTC(year, month, lastDay);
  const end = naturalEnd.getTime() < anchor.getTime() ? naturalEnd : anchor;
  return { start, end };
}

export interface MonthlyPoint {
  month: number; // 1-12
  year: number;
  label: string; // e.g. "Jan"
  value: number;
  volume: number;
  targetValue: number;
  targetVolume: number;
  valueStatus: TargetStatus;
  volumeStatus: TargetStatus;
  asp: number | null;
  targetAsp: number | null;
  aspStatus: TargetStatus;
}

/**
 * Month-by-month series from the start of `anchor`'s year through `anchor`'s own (possibly
 * partial) month. The current month's target is prorated by the same monthElapsedFraction used
 * everywhere else in this file; completed months use their full target. Every status field is
 * still classifyVsTarget -- no second classification scheme for the trend view.
 */
export async function fetchMonthlySeries(
  pool: Pool,
  anchor: Date,
  filters: Filters,
): Promise<MonthlyPoint[]> {
  const year = anchor.getUTCFullYear();
  const throughMonth = anchor.getUTCMonth() + 1;
  const months = Array.from({ length: throughMonth }, (_, i) => i + 1);
  const fraction = monthElapsedFraction(anchor);

  return Promise.all(
    months.map(async (m): Promise<MonthlyPoint> => {
      const window = monthWindow(year, m, anchor);
      const [vv, fm] = await Promise.all([
        fetchValueVolume(pool, window, filters),
        fetchTargetForMonths(pool, year, filters, { month: m }),
      ]);

      const monthFraction = m === throughMonth ? fraction : 1;
      const targetValue = fm.targetRevenue * monthFraction;
      const targetVolume = fm.targetVolume * monthFraction;
      const aspActual = asp(vv);
      const targetAspValue = targetVolume > 0 ? targetValue / targetVolume : null;

      return {
        month: m,
        year,
        label: MONTH_LABELS[m - 1],
        value: vv.value,
        volume: vv.volume,
        targetValue,
        targetVolume,
        valueStatus: classifyVsTarget(vv.value, targetValue),
        volumeStatus: classifyVsTarget(vv.volume, targetVolume),
        asp: aspActual,
        targetAsp: targetAspValue,
        aspStatus: classifyVsTarget(aspActual, targetAspValue),
      };
    }),
  );
}