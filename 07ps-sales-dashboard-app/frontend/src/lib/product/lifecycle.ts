import type { LifecycleSegment } from '../api';
import type { ProductFact } from '../materialsAnalogy/shared';
import { portfolioOf } from './portfolio';

/**
 * Product Lifecycle definitions (2026-11-15), written from the ETL rule (data/etl/src/sales_pipeline/product_dashboard.py
 * ProductDashboardBuilder._lifecycle) and its config (data/etl/config/product_dashboard.json "lifecycle"), which the API
 * sends in `thresholds.lifecycle`. Segments are computed by the ETL as of its run date (not the page's Date filter), in
 * this order -- the first rule that matches wins: Never sold > Discontinued > New > Growing > Declining > Mature.
 * Only Active + Non Active products have a segment on the page (archived ones are Dormant, never listed).
 */
export interface LifecycleConfig {
  newDays: number;
  windowDays: number;
  growthPct: number;
  noSalesDays: number;
}

export function lifecycleConfig(thresholds: Record<string, unknown> | undefined | null): LifecycleConfig {
  const l = ((thresholds ?? {}).lifecycle ?? {}) as Record<string, unknown>;
  const n = (v: unknown, d: number) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Number(v) : d);
  return {
    newDays: n(l.new_first_sale_within_days, 180),
    windowDays: n(l.trend_window_days, 90),
    growthPct: n(l.growth_threshold_pct, 20),
    noSalesDays: n(l.discontinued_no_sales_days, 365),
  };
}

/** Mature SKUs % (2026-11-15): Mature ÷ the portfolio (Active + Non Active) after the page filters. */
export function maturePct(rows: ProductFact[]): number | null {
  const portfolio = portfolioOf(rows);
  return portfolio.length ? (portfolio.filter((r) => r.lifecycle === 'Mature').length / portfolio.length) * 100 : null;
}

/** One line per segment, from the config values. */
export function segmentDefinitions(c: LifecycleConfig): Record<LifecycleSegment, string> {
  return {
    'Never sold': 'No sale in the whole sales history.',
    Discontinued: `No sale in the last ${c.noSalesDays} days.`,
    New: `First sale within the last ${c.newDays} days.`,
    Growing: `Units of the last ${c.windowDays} days more than ${c.growthPct}% above the ${c.windowDays} days before (or none sold before).`,
    Declining: `Units of the last ${c.windowDays} days more than ${c.growthPct}% below the ${c.windowDays} days before.`,
    Mature: `Sold, and the last ${c.windowDays} days within ±${c.growthPct}% of the ${c.windowDays} days before.`,
  };
}

/** Portfolio Freshness (2026-11-15): the real portfolio is Active + Non Active (Dormant and Unclassified left out).
 * Freshness % = SKUs first sold in the last `newDays` days (segment New) ÷ Active + Non Active SKUs after the page filters. */
export function portfolioFreshness(rows: ProductFact[]) {
  const portfolio = portfolioOf(rows);
  const fresh = portfolio.filter((r) => r.lifecycle === 'New');
  const active = fresh.filter((r) => r.productStatus === 'Active').length;
  return {
    pct: portfolio.length ? (fresh.length / portfolio.length) * 100 : 0,
    fresh: fresh.length,
    active,
    nonActive: fresh.length - active,
    portfolio: portfolio.length,
    portfolioActive: portfolio.filter((r) => r.productStatus === 'Active').length,
    portfolioNonActive: portfolio.filter((r) => r.productStatus === 'NonActive').length,
  };
}
