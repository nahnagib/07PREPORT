/**
 * Revenue Trend page metric definitions.
 *
 * Reuses every primitive from measures/tachometer.ts unchanged (fetchValueVolume,
 * fetchTargetForMonths, asp, computeAspCard, computeMtdCard, computeYtdCard, monthWindow) --
 * this file adds exactly two things tachometer.ts doesn't already provide:
 *   1. The Value / Volume / ASP trends per Daily / Weekly / Monthly / Yearly period (lib/periods.ts), with the same
 *      period last year and (Monthly / Yearly) the target.
 *   2. A binary good/bad "flag" view of the same MTD/YTD variance-to-target figures that already
 *      back the Tachometer's own YTD/MTD Value/Volume/ASP cards -- flag=1 iff actual >= target,
 *      which is exactly classifyVsTarget's GREEN condition. No new threshold/formula is
 *      introduced; this only re-packages the existing classification as a boolean for the
 *      Revenue Trend page's pass/fail KPI cards.
 */

import type { Pool } from 'mysql2/promise';
import { classifyVsTarget, variancePct, TargetStatus } from './classify';
import {
  asp,
  computeAspCard,
  computeMtdCard,
  computeYtdCard,
  fetchTargetForMonths,
  fetchValueVolume,
  type TargetFigures,
  type ValueVolume,
} from './tachometer';
import { buildWhereClause, dateOnlyUTC, lmtdWindow, lytdWindow, monthElapsedFraction, mtdWindow, ytdWindow, type Filters } from './filters';
import {
  anchorToday,
  byPeriod,
  changePct,
  fillPeriods,
  lastYearInterval,
  lastYearIso,
  periodBucketSql,
  periodRangeSql,
  periodWindow,
  type PeriodGranularity,
  type TrendPeriod,
} from '../lib/periods';

const isoToDate = (iso: string): Date => dateOnlyUTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), Number(iso.slice(8, 10)));


/** One period of the Value / Volume / ASP trends (lib/periods.ts window). ASP = the period's value / volume (never an
 * average of daily ASPs); null when the period sold nothing (a gap, not 0). */
export interface RevenueTrendPeriodPoint {
  start: string;
  end: string;
  inProgress: boolean;
  value: number;
  volume: number;
  asp: number | null;
  /** the same period one year earlier (lib/periods.ts lastYearShift); for the current period only up to the same day */
  lastYearValue: number;
  lastYearVolume: number;
  lastYearAsp: number | null;
  /** Monthly and Yearly only (targets are monthly; the current month is prorated by the days elapsed); null on Daily / Weekly */
  targetValue: number | null;
  targetVolume: number | null;
  targetAsp: number | null;
  /** against the previous period of the same granularity (DoD / WoW / MoM / YoY) */
  valueChangePct: number | null;
  volumeChangePct: number | null;
  aspChangePct: number | null;
}

export interface RevenueTrendPeriods {
  granularity: PeriodGranularity;
  from: string;
  to: string;
  hasTarget: boolean;
  points: RevenueTrendPeriodPoint[];
  /** the window's totals from the same fetchValueVolume as the page's KPI cards: the points always add up to them */
  totals: { value: number; volume: number; asp: number | null };
}

async function valueVolumeByPeriod(pool: Pool, g: PeriodGranularity, from: string, to: string, filters: Filters, interval?: string) {
  const { clause, params } = buildWhereClause(filters, 'fsl', true);
  const dateExpr = interval ? `DATE_ADD(dd.Date, ${interval})` : 'dd.Date';
  const range = periodRangeSql('dd.Date', from, to);
  const [rows] = await pool.query(
    `SELECT ${periodBucketSql(g, dateExpr)} AS p, COALESCE(SUM(fsl.value), 0) AS value, COALESCE(SUM(fsl.volume), 0) AS volume
     FROM v_sales_lines fsl
     JOIN dim_date dd ON fsl.DateKey = dd.DateKey
     WHERE ${range.sql} AND ${clause}
     GROUP BY p`,
    [...range.params, ...params],
  );
  return byPeriod(rows as Record<string, unknown>[]);
}

/** Target of one Monthly / Yearly period; the period in progress is prorated to the anchor day (same rule as the cards). */
async function periodTarget(pool: Pool, g: PeriodGranularity, p: TrendPeriod, anchor: Date, filters: Filters): Promise<TargetFigures> {
  const year = Number(p.start.slice(0, 4));
  if (g === 'month') {
    const fm = await fetchTargetForMonths(pool, year, filters, { month: Number(p.start.slice(5, 7)) });
    const f = p.inProgress ? monthElapsedFraction(anchor) : 1;
    return { targetRevenue: fm.targetRevenue * f, targetVolume: fm.targetVolume * f };
  }
  if (!p.inProgress) return fetchTargetForMonths(pool, year, filters);
  const month = anchor.getUTCMonth() + 1;
  const [before, current] = await Promise.all([
    fetchTargetForMonths(pool, year, filters, { monthLt: month }),
    fetchTargetForMonths(pool, year, filters, { month }),
  ]);
  const f = monthElapsedFraction(anchor);
  return { targetRevenue: before.targetRevenue + current.targetRevenue * f, targetVolume: before.targetVolume + current.targetVolume * f };
}

const vv = (row: Record<string, unknown> | undefined): ValueVolume => ({ value: Number(row?.value ?? 0), volume: Number(row?.volume ?? 0) });

/**
 * Value / Volume / ASP per period of the selected granularity (lib/periods.ts: last 30 days / 12 weeks / 12 months /
 * 5 years, ending with the anchor's period), bucketed in SQL, with the same period last year and, on Monthly / Yearly,
 * the target. Every period is present (0 when nothing was sold). The same scoped filters as every other figure.
 */
export async function fetchRevenueTrendPeriods(pool: Pool, anchor: Date, g: PeriodGranularity, filters: Filters): Promise<RevenueTrendPeriods> {
  const w = periodWindow(g, anchorToday(anchor));
  const hasTarget = g === 'month' || g === 'year';
  const [current, lastYear, total, targets] = await Promise.all([
    valueVolumeByPeriod(pool, g, w.previous.start, w.to, filters),
    valueVolumeByPeriod(pool, g, lastYearIso(w.from, g), lastYearIso(w.to, g), filters, lastYearInterval(g)),
    fetchValueVolume(pool, { start: isoToDate(w.from), end: isoToDate(w.to) }, filters),
    hasTarget ? Promise.all(w.periods.map((p) => periodTarget(pool, g, p, anchor, filters))) : Promise.resolve(null),
  ]);
  let prev = vv(current.get(w.previous.start));
  const points = fillPeriods(w, current, (p, row): RevenueTrendPeriodPoint => {
    const now = vv(row);
    const last = vv(lastYear.get(p.start));
    const t = targets ? targets[w.periods.indexOf(p)] : null;
    const point: RevenueTrendPeriodPoint = {
      start: p.start,
      end: p.end,
      inProgress: p.inProgress,
      value: now.value,
      volume: now.volume,
      asp: asp(now),
      lastYearValue: last.value,
      lastYearVolume: last.volume,
      lastYearAsp: asp(last),
      targetValue: t ? t.targetRevenue : null,
      targetVolume: t ? t.targetVolume : null,
      targetAsp: t && t.targetVolume > 0 ? t.targetRevenue / t.targetVolume : null,
      valueChangePct: changePct(now.value, prev.value),
      volumeChangePct: changePct(now.volume, prev.volume),
      aspChangePct: changePct(asp(now), asp(prev)),
    };
    prev = now;
    return point;
  });
  return { granularity: g, from: w.from, to: w.to, hasTarget, points, totals: { value: total.value, volume: total.volume, asp: asp(total) } };
}

export interface VarianceCard {
  variancePct: number | null;
  /** 1 = actual meets or exceeds target ("good"), 0 = actual is below target ("bad"). Identical
   * condition to classifyVsTarget's GREEN boundary (actual >= target) -- not a second threshold. */
  flag: 0 | 1;
  status: TargetStatus;
}

function toVarianceCard(actual: number | null, target: number | null): VarianceCard {
  const status = classifyVsTarget(actual, target);
  return {
    variancePct: variancePct(actual, target),
    flag: status === TargetStatus.GREEN ? 1 : 0,
    status,
  };
}

export interface RevenueTrendKpis {
  valueVarianceYtd: VarianceCard;
  volumeVarianceYtd: VarianceCard;
  aspVarianceYtd: VarianceCard;
  valueVarianceMtd: VarianceCard;
  volumeVarianceMtd: VarianceCard;
  aspVarianceMtd: VarianceCard;
}

/** One row of the Performance Details table: a metric over one period, with its prior-year
 * same-period figure. `last` is LYTD for a YTD row and LMTD for an MTD row -- in this app both are
 * the same window shifted back one year (see filters.ts's lytdWindow/lmtdWindow), exactly as on the
 * Tachometer. */
export interface RevenueTrendPerformanceRow {
  key: string; // e.g. 'valueYtd'
  metric: 'value' | 'volume' | 'asp';
  period: 'ytd' | 'mtd';
  actual: number | null;
  target: number | null;
  last: number | null;
  variancePct: number | null; // Actual vs Target
  varianceLastPct: number | null; // Actual vs Last
  status: TargetStatus;
}

function toPerformanceRow(
  metric: RevenueTrendPerformanceRow['metric'],
  period: RevenueTrendPerformanceRow['period'],
  actual: number | null,
  target: number | null,
  last: number | null,
): RevenueTrendPerformanceRow {
  return {
    key: `${metric}${period === 'ytd' ? 'Ytd' : 'Mtd'}`,
    metric,
    period,
    actual,
    target,
    last,
    variancePct: variancePct(actual, target),
    varianceLastPct: variancePct(actual, last),
    status: classifyVsTarget(actual, target),
  };
}

export interface RevenueTrendFigures {
  kpis: RevenueTrendKpis;
  performanceDetails: RevenueTrendPerformanceRow[];
}

/**
 * The six MTD/YTD variance-to-target KPI cards plus the six Performance Details rows. Built
 * entirely from the same computeYtdCard/computeMtdCard/computeAspCard functions that already power
 * the Tachometer page's own YTD/MTD Value/Volume/ASP cards -- so a Revenue Trend figure can never
 * disagree with the equivalent Tachometer card for the same anchor/filters. The Last (LYTD/LMTD)
 * figures are the cards' own lastYearSamePeriod, and ASP's are derived from the same last-year
 * ValueVolume fetch the Tachometer route makes.
 */
export async function computeRevenueTrendFigures(pool: Pool, anchor: Date, filters: Filters): Promise<RevenueTrendFigures> {
  const [ytdValueCard, ytdVolumeCard, mtdValueCard, mtdVolumeCard] = await Promise.all([
    computeYtdCard(pool, anchor, filters, 'value'),
    computeYtdCard(pool, anchor, filters, 'volume'),
    computeMtdCard(pool, anchor, filters, 'value'),
    computeMtdCard(pool, anchor, filters, 'volume'),
  ]);

  const [ytdVV, ytdTarget, mtdVV, mtdTarget, lytdVV, lmtdVV] = await Promise.all([
    fetchValueVolume(pool, ytdWindow(anchor), filters),
    fetchTargetForMonths(pool, anchor.getUTCFullYear(), filters),
    fetchValueVolume(pool, mtdWindow(anchor), filters),
    fetchTargetForMonths(pool, anchor.getUTCFullYear(), filters, { month: anchor.getUTCMonth() + 1 }),
    fetchValueVolume(pool, lytdWindow(anchor), filters),
    fetchValueVolume(pool, lmtdWindow(anchor), filters),
  ]);

  const aspYtd = computeAspCard(ytdVV, ytdTarget, lytdVV);
  const aspMtd = computeAspCard(mtdVV, mtdTarget, lmtdVV);

  return {
    kpis: {
      valueVarianceYtd: toVarianceCard(ytdValueCard.actual, ytdValueCard.targetToDate),
      volumeVarianceYtd: toVarianceCard(ytdVolumeCard.actual, ytdVolumeCard.targetToDate),
      aspVarianceYtd: toVarianceCard(aspYtd.actualAsp, aspYtd.targetAsp),
      valueVarianceMtd: toVarianceCard(mtdValueCard.actual, mtdValueCard.targetToDate),
      volumeVarianceMtd: toVarianceCard(mtdVolumeCard.actual, mtdVolumeCard.targetToDate),
      aspVarianceMtd: toVarianceCard(aspMtd.actualAsp, aspMtd.targetAsp),
    },
    performanceDetails: [
      toPerformanceRow('value', 'ytd', ytdValueCard.actual, ytdValueCard.targetToDate, ytdValueCard.lastYearSamePeriod),
      toPerformanceRow('volume', 'ytd', ytdVolumeCard.actual, ytdVolumeCard.targetToDate, ytdVolumeCard.lastYearSamePeriod),
      toPerformanceRow('asp', 'ytd', aspYtd.actualAsp, aspYtd.targetAsp, aspYtd.lastYearAsp),
      toPerformanceRow('value', 'mtd', mtdValueCard.actual, mtdValueCard.targetToDate, mtdValueCard.lastYearSamePeriod),
      toPerformanceRow('volume', 'mtd', mtdVolumeCard.actual, mtdVolumeCard.targetToDate, mtdVolumeCard.lastYearSamePeriod),
      toPerformanceRow('asp', 'mtd', aspMtd.actualAsp, aspMtd.targetAsp, aspMtd.lastYearAsp),
    ],
  };
}
