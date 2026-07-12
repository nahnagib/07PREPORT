/**
 * Revenue Trend page metric definitions.
 *
 * Reuses every primitive from measures/tachometer.ts unchanged (fetchValueVolume,
 * fetchTargetForMonths, asp, computeAspCard, computeMtdCard, computeYtdCard, monthWindow) --
 * this file adds exactly two things tachometer.ts doesn't already provide:
 *   1. A prior-year ("Y-1") figure alongside each month's actual/target in the monthly series
 *      (fetchMonthlySeries only carries actual + target, no Y-1).
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
  monthWindow,
} from './tachometer';
import { dateOnlyUTC, monthElapsedFraction, mtdWindow, ytdWindow, type DateWindow, type Filters } from './filters';

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Full (unclipped) calendar-month window -- used only for the prior-year figure, which is always
 * a fully-completed month regardless of where `anchor` falls in the current year. */
function monthWindowFull(year: number, month1to12: number): DateWindow {
  const start = dateOnlyUTC(year, month1to12, 1);
  const lastDay = new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
  return { start, end: dateOnlyUTC(year, month1to12, lastDay) };
}

export interface TrendMonthPoint {
  month: number; // 1-12
  year: number;
  label: string; // e.g. "Jan"
  value: number;
  lastYearValue: number;
  targetValue: number;
  volume: number;
  lastYearVolume: number;
  targetVolume: number;
  asp: number | null;
  lastYearAsp: number | null;
  targetAsp: number | null;
}

/**
 * Month-by-month Value/Volume/ASP series from the start of `anchor`'s year through `anchor`'s
 * own (possibly partial) month, each month carrying its actual, same-month-prior-year, and
 * target figures. Same current-year windowing/target-proration as tachometer.ts's
 * fetchMonthlySeries (monthWindow + monthElapsedFraction) -- this only adds the prior-year fetch
 * alongside it.
 */
export async function fetchRevenueTrendSeries(pool: Pool, anchor: Date, filters: Filters): Promise<TrendMonthPoint[]> {
  const year = anchor.getUTCFullYear();
  const throughMonth = anchor.getUTCMonth() + 1;
  const months = Array.from({ length: throughMonth }, (_, i) => i + 1);
  const fraction = monthElapsedFraction(anchor);

  return Promise.all(
    months.map(async (m): Promise<TrendMonthPoint> => {
      const window = monthWindow(year, m, anchor);
      const lastYearWindow = monthWindowFull(year - 1, m);
      const [vv, lastYearVv, fm] = await Promise.all([
        fetchValueVolume(pool, window, filters),
        fetchValueVolume(pool, lastYearWindow, filters),
        fetchTargetForMonths(pool, year, filters, { month: m }),
      ]);

      const monthFraction = m === throughMonth ? fraction : 1;
      const targetValue = fm.targetRevenue * monthFraction;
      const targetVolume = fm.targetVolume * monthFraction;
      const targetAspValue = targetVolume > 0 ? targetValue / targetVolume : null;

      return {
        month: m,
        year,
        label: MONTH_LABELS[m - 1],
        value: vv.value,
        lastYearValue: lastYearVv.value,
        targetValue,
        volume: vv.volume,
        lastYearVolume: lastYearVv.volume,
        targetVolume,
        asp: asp(vv),
        lastYearAsp: asp(lastYearVv),
        targetAsp: targetAspValue,
      };
    }),
  );
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

/**
 * The six MTD/YTD variance-to-target KPI cards. Built entirely from the same
 * computeYtdCard/computeMtdCard/computeAspCard functions that already power the Tachometer
 * page's own YTD/MTD Value/Volume/ASP cards -- so a Revenue Trend variance figure can never
 * disagree with the equivalent Tachometer card for the same anchor/filters.
 */
export async function computeRevenueTrendKpis(pool: Pool, anchor: Date, filters: Filters): Promise<RevenueTrendKpis> {
  const [ytdValueCard, ytdVolumeCard, mtdValueCard, mtdVolumeCard] = await Promise.all([
    computeYtdCard(pool, anchor, filters, 'value'),
    computeYtdCard(pool, anchor, filters, 'volume'),
    computeMtdCard(pool, anchor, filters, 'value'),
    computeMtdCard(pool, anchor, filters, 'volume'),
  ]);

  const [ytdVV, ytdTarget, mtdVV, mtdTarget] = await Promise.all([
    fetchValueVolume(pool, ytdWindow(anchor), filters),
    fetchTargetForMonths(pool, anchor.getUTCFullYear(), filters),
    fetchValueVolume(pool, mtdWindow(anchor), filters),
    fetchTargetForMonths(pool, anchor.getUTCFullYear(), filters, { month: anchor.getUTCMonth() + 1 }),
  ]);

  const aspYtd = computeAspCard(ytdVV, ytdTarget);
  const aspMtd = computeAspCard(mtdVV, mtdTarget);

  return {
    valueVarianceYtd: toVarianceCard(ytdValueCard.actual, ytdValueCard.targetToDate),
    volumeVarianceYtd: toVarianceCard(ytdVolumeCard.actual, ytdVolumeCard.targetToDate),
    aspVarianceYtd: toVarianceCard(aspYtd.actualAsp, aspYtd.targetAsp),
    valueVarianceMtd: toVarianceCard(mtdValueCard.actual, mtdValueCard.targetToDate),
    volumeVarianceMtd: toVarianceCard(mtdVolumeCard.actual, mtdVolumeCard.targetToDate),
    aspVarianceMtd: toVarianceCard(aspMtd.actualAsp, aspMtd.targetAsp),
  };
}
