import type { LifecycleSegment } from '../api';
import type { ProductFact } from '../materialsAnalogy/shared';
import { portfolioOf } from './portfolio';

/**
 * Product Lifecycle definitions. Segments are computed by the backend (measures/productLifecycle.ts, 2026-11-24) for the
 * page's Date filter: Growing / Mature / Declining compare the units of the period with the prior period of the same
 * length (default the Last 12 Months vs the 12 months before); New and Discontinued keep their fixed day rules from the
 * ETL config. The first rule that matches wins: Never sold > Discontinued > New > Growing > Declining > Mature. The API
 * sends the benchmark (`lifecycleBenchmark`: its labels and the rule's values); every label on the page comes from it.
 * Only Active + Non Active products have a segment on the page (archived ones are Dormant, never listed).
 */
export interface LifecycleConfig {
  newDays: number;
  growthPct: number;
  noSalesDays: number;
  /** The benchmark period: "Last 12 months", "Last 90 days", or its dates ("1 Jan – 24 Nov 2026"). */
  label: string;
  /** "Prior 12 months", or "Prior period (7 Feb – 31 Dec 2025)". */
  priorLabel: string;
}

export interface LifecycleBenchmarkLabels {
  label: string;
  priorLabel: string;
  growthPct: number;
  newDays: number;
  noSalesDays: number;
}

/** The API's benchmark when sent; else the config values with the default Last 12 Months. */
export function lifecycleConfig(thresholds: Record<string, unknown> | undefined | null, benchmark?: LifecycleBenchmarkLabels | null): LifecycleConfig {
  if (benchmark) {
    return { newDays: benchmark.newDays, growthPct: benchmark.growthPct, noSalesDays: benchmark.noSalesDays, label: benchmark.label, priorLabel: benchmark.priorLabel };
  }
  const l = ((thresholds ?? {}).lifecycle ?? {}) as Record<string, unknown>;
  const n = (v: unknown, d: number) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Number(v) : d);
  return {
    newDays: n(l.new_first_sale_within_days, 180),
    growthPct: n(l.growth_threshold_pct, 20),
    noSalesDays: n(l.discontinued_no_sales_days, 365),
    label: 'Last 12 months',
    priorLabel: 'Prior 12 months',
  };
}

/** "Prior 12 months" -> "prior 12 months" (inside a sentence). */
export const inSentence = (label: string): string => label.charAt(0).toLowerCase() + label.slice(1);

/** Mature SKUs % (2026-11-15): Mature ÷ the portfolio (Active + Non Active) after the page filters. */
export function maturePct(rows: ProductFact[]): number | null {
  const portfolio = portfolioOf(rows);
  return portfolio.length ? (portfolio.filter((r) => r.lifecycle === 'Mature').length / portfolio.length) * 100 : null;
}

/** One line per segment: the benchmark period and the config values (the Pareto legend). */
export function segmentDefinitions(c: LifecycleConfig): Record<LifecycleSegment, string> {
  return {
    'Never sold': 'Never sold',
    Discontinued: `No sale in ${c.noSalesDays} d`,
    New: `First sale ≤ ${c.newDays} d`,
    Growing: `${c.label} > +${c.growthPct}%`,
    Declining: `${c.label} < −${c.growthPct}%`,
    Mature: `${c.label} within ±${c.growthPct}%`,
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

/** Portfolio Freshness targets per company, % (backend config/productTargets.ts, served as thresholds.freshness_targets). */
export function freshnessTargets(thresholds: Record<string, unknown> | undefined | null): Record<string, number> {
  const raw = ((thresholds ?? {}) as Record<string, unknown>).freshness_targets as Record<string, unknown> | undefined;
  const out: Record<string, number> = {};
  for (const [company, v] of Object.entries(raw ?? {})) if (Number.isFinite(Number(v))) out[company.trim().toUpperCase()] = Number(v);
  return out;
}

export interface CompanyFreshness {
  company: string;
  pct: number;
  fresh: number;
  portfolio: number;
  /** null = no target configured for the company */
  target: number | null;
  onTrack: boolean | null;
}

/** Portfolio Freshness per company against its own target (2026-11-15): one entry per company in the rows, sorted by
 * name. Company = "All" shows every company's own figure; a single company shows one entry. */
export function freshnessByCompany(rows: ProductFact[], targets: Record<string, number>): CompanyFreshness[] {
  const companies = [...new Set(rows.map((r) => String(r.Company ?? '')).filter(Boolean))].sort();
  return companies.map((company) => {
    const f = portfolioFreshness(rows.filter((r) => r.Company === company));
    const target = targets[company.toUpperCase()] ?? null;
    return { company, pct: f.pct, fresh: f.fresh, portfolio: f.portfolio, target, onTrack: target === null || f.portfolio === 0 ? null : f.pct >= target };
  });
}
