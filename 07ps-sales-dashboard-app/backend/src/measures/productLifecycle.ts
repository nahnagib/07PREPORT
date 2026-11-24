import { DateTime } from 'luxon';
import type { ProductPeriod } from '../lib/last12Months';

/**
 * Product Lifecycle segments (2026-11-24): computed here, per request, from the page's Date filter -- no longer the ETL's
 * fixed 90-day trend window.
 *
 *   benchmark   the period of the Date filter (default the Last 12 Months, lib/last12Months.ts) against the prior
 *               period of the same number of days right before it (period.priorFrom .. priorTo).
 *   rule        the first that matches wins (the ETL's order, data/etl/src/sales_pipeline/product_dashboard.py _lifecycle):
 *     Never sold     no sale ever
 *     Discontinued   no sale in the last `noSalesDays` days before the as-of date      (fixed: config, not the Date filter)
 *     New            first sale within `newDays` days of the as-of date                  (fixed: config, not the Date filter)
 *     Growing        nothing sold in the prior period and something in the period (no divide by zero), or units > +growth%
 *     Declining      units < -growth%
 *     Mature         otherwise (within ±growth%, or nothing sold in either period)
 *   Units = the invoiced quantity of the period / prior period (ProductDashboardRow.volume / volumePrior), as the ETL did.
 *   As-of date = the ETL run's date (the dates New / Discontinued were always measured from); today when unknown.
 * Config: data/etl/config/product_dashboard.json "lifecycle" (trend_window_days is no longer used).
 */

export const LIFECYCLE_SEGMENTS = ['New', 'Growing', 'Mature', 'Declining', 'Discontinued', 'Never sold'] as const;
export type LifecycleSegment = (typeof LIFECYCLE_SEGMENTS)[number];

export interface LifecycleRule {
  newDays: number;
  growthPct: number;
  noSalesDays: number;
}

export function lifecycleRule(thresholds: Record<string, unknown>): LifecycleRule {
  const l = (thresholds.lifecycle ?? {}) as Record<string, unknown>;
  const n = (v: unknown, d: number) => (v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    newDays: n(l.new_first_sale_within_days, 180),
    growthPct: n(l.growth_threshold_pct, 20),
    noSalesDays: n(l.discontinued_no_sales_days, 365),
  };
}

export interface LifecycleInput {
  firstSaleDate: string | null;
  lastSaleDate: string | null;
  /** Units sold in the period / in the prior period. */
  volume: number;
  volumePrior: number;
}

const days = (from: string, to: string) => Math.round(DateTime.fromISO(to).diff(DateTime.fromISO(from), 'days').days);

export function lifecycleSegmentOf(r: LifecycleInput, rule: LifecycleRule, asOf: string): LifecycleSegment {
  if (!r.firstSaleDate && !r.lastSaleDate) return 'Never sold';
  if (r.lastSaleDate && days(r.lastSaleDate, asOf) >= rule.noSalesDays) return 'Discontinued';
  if (r.firstSaleDate && days(r.firstSaleDate, asOf) < rule.newDays) return 'New';
  if (r.volumePrior <= 0) return r.volume > 0 ? 'Growing' : 'Mature';
  const change = ((r.volume - r.volumePrior) / r.volumePrior) * 100;
  if (change > rule.growthPct) return 'Growing';
  if (change < -rule.growthPct) return 'Declining';
  return 'Mature';
}

const fmt = (iso: string, year = true) => DateTime.fromISO(iso).toFormat(year ? 'd LLL yyyy' : 'd LLL');

/** "1 Jan – 24 Nov 2026", "3 – 24 Nov 2026", "1 Dec 2025 – 30 Nov 2026". */
export function rangeText(from: string, to: string): string {
  if (from.slice(0, 7) === to.slice(0, 7)) return `${Number(from.slice(8, 10))} – ${fmt(to)}`;
  return `${fmt(from, from.slice(0, 4) !== to.slice(0, 4))} – ${fmt(to)}`;
}

/** The period's length in words when it is a whole number of months ("12 months", "6 months": from = to - N months, or
 * the day after) or of 30-day / 7-day blocks ("90 days", "14 days"); null otherwise (shown as its dates). */
export function lengthText(period: Pick<ProductPeriod, 'from' | 'to' | 'days'>): string | null {
  const to = DateTime.fromISO(period.to);
  for (let m = 1; m <= 60; m += 1) {
    const back = to.minus({ months: m }).toISODate();
    const backPlusOne = to.minus({ months: m }).plus({ days: 1 }).toISODate();
    if (period.from === back || period.from === backPlusOne) return `${m} month${m === 1 ? '' : 's'}`;
  }
  if (period.days % 30 === 0 || period.days % 7 === 0) return `${period.days} days`;
  return null;
}

export interface LifecycleBenchmark {
  from: string;
  to: string;
  priorFrom: string;
  priorTo: string;
  days: number;
  /** "Last 12 months" (ends today, a readable length), else the dates ("1 Jan – 24 Nov 2026"). */
  label: string;
  /** "Prior 12 months", else "Prior period (1 Feb – 31 Dec 2025)". */
  priorLabel: string;
  growthPct: number;
  newDays: number;
  noSalesDays: number;
  /** The date New / Discontinued are measured from (the ETL run). */
  asOf: string;
}

export function lifecycleBenchmark(period: ProductPeriod, rule: LifecycleRule, asOf: string, today: string): LifecycleBenchmark {
  const length = lengthText(period);
  return {
    from: period.from,
    to: period.to,
    priorFrom: period.priorFrom,
    priorTo: period.priorTo,
    days: period.days,
    label: length && period.to === today ? `Last ${length}` : rangeText(period.from, period.to),
    priorLabel: length ? `Prior ${length}` : `Prior period (${rangeText(period.priorFrom, period.priorTo)})`,
    growthPct: rule.growthPct,
    newDays: rule.newDays,
    noSalesDays: rule.noSalesDays,
    asOf,
  };
}
