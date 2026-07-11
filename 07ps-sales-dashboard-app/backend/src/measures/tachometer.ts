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
      COALESCE(SUM(ftp.Target_Revenue), 0) AS target_revenue,
      COALESCE(SUM(ftp.Target_Volume), 0)  AS target_volume
    FROM Fact_Targets ftp
    WHERE ${conditions.join(' AND ')} AND ${clause}
  `;
  const [rows] = await pool.query(sql, queryParams);
  const row = (rows as any[])[0];
  return { targetRevenue: Number(row.target_revenue), targetVolume: Number(row.target_volume) };
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
  status: TargetStatus;
}

/**
 * ASP cards use the same classifyVsTarget logic as the tachometers (manual: "ASP cards use the
 * same color logic as the tachometers"). Target ASP = Full Year/Month Target's own
 * target_revenue/target_volume ratio, i.e. the target's implied ASP, not the actual period's
 * volume mixed with the target's revenue.
 */
export function computeAspCard(valueVolume: ValueVolume, targetFigures: TargetFigures): AspCard {
  const actualAsp = asp(valueVolume);
  const targetAsp = targetFigures.targetVolume ? targetFigures.targetRevenue / targetFigures.targetVolume : null;
  return {
    actualAsp,
    targetAsp,
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

interface GroupConfig {
  column: string; // column name on Fact_SalesLines (filtered) / fact_target_plan
  joinTable: string;
  joinKeyColumn: string;
  labelColumn: string;
}

const GROUP_CONFIG: Record<GroupBy, GroupConfig> = {
  salesperson: {
    column: 'SalespersonKey',
    joinTable: 'dim_salesperson',
    joinKeyColumn: 'SalespersonKey',
    labelColumn: 'salesperson',
  },
  salesTeam: {
    column: 'SalesTeamKey',
    joinTable: 'dim_salesteam',
    joinKeyColumn: 'SalesTeamKey',
    labelColumn: 'SalesTeam',
  },
  segment: {
    column: 'SegmentKey',
    joinTable: 'dim_segment',
    joinKeyColumn: 'SegmentKey',
    labelColumn: 'Segment',
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
  const sql = `
    SELECT
      fsl.${cfg.column} AS group_key,
      COALESCE(dim.${cfg.labelColumn}, 'Unassigned') AS group_label,
      COALESCE(SUM(fsl.value), 0)  AS value,
      COALESCE(SUM(fsl.volume), 0) AS volume
    FROM Fact_SalesLines fsl
    JOIN Dim_Date dd ON fsl.DateKey = dd.DateKey
    LEFT JOIN ${cfg.joinTable} dim ON fsl.${cfg.column} = dim.${cfg.joinKeyColumn}
    WHERE dd.Date BETWEEN ? AND ?
      AND ${clause}
    GROUP BY fsl.${cfg.column}, dim.${cfg.labelColumn}
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

async function fetchTargetForMonthsGrouped(
  pool: Pool,
  year: number,
  filters: Filters,
  groupBy: GroupBy,
  opts: { month?: number; monthLt?: number } = {},
): Promise<GroupedTargetFigures[]> {
  const { clause, params } = buildWhereClause(filters, 'ftp');
  const cfg = GROUP_CONFIG[groupBy];
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
      ftp.${cfg.column} AS group_key,
      COALESCE(dim.${cfg.labelColumn}, 'Unassigned') AS group_label,
      COALESCE(SUM(ftp.Target_Revenue), 0) AS target_revenue,
      COALESCE(SUM(ftp.Target_Volume), 0)  AS target_volume
    FROM Fact_Targets ftp
    LEFT JOIN ${cfg.joinTable} dim ON ftp.${cfg.column} = dim.${cfg.joinKeyColumn}
    WHERE ${conditions.join(' AND ')} AND ${clause}
    GROUP BY ftp.${cfg.column}, dim.${cfg.labelColumn}
  `;
  const [rows] = await pool.query(sql, queryParams);
  return (rows as any[]).map((r) => ({
    groupKey: r.group_key,
    groupLabel: String(r.group_label),
    targetRevenue: Number(r.target_revenue),
    targetVolume: Number(r.target_volume),
  }));
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
 * partial) month -- consistent with mtdWindow/ytdWindow's "never look past anchor" semantics. */
function monthWindow(year: number, month: number, anchor: Date): DateWindow {
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