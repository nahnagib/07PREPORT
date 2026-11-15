import { describe, expect, it } from 'vitest';
import type { ProductFact } from '../../materialsAnalogy/shared';
import { lifecycleConfig, maturePct, portfolioFreshness, segmentDefinitions } from '../lifecycle';

const fact = (id: number, productStatus: ProductFact['productStatus'], lifecycle: ProductFact['lifecycle']) =>
  ({ id: String(id), productStatus, lifecycle }) as unknown as ProductFact;

describe('Portfolio Freshness (2026-11-15): Active + Non Active only', () => {
  it('Dormant and Unclassified are out of both the numerator and the denominator', () => {
    const rows = [
      fact(1, 'Active', 'New'), fact(2, 'Active', 'New'), fact(3, 'NonActive', 'New'),
      fact(4, 'Active', 'Mature'), fact(5, 'NonActive', 'Never sold'),
      fact(6, 'Dormant', 'New'), fact(7, 'Unclassified', 'New'), fact(8, 'Dormant', 'Discontinued'),
    ];
    expect(portfolioFreshness(rows)).toEqual({ pct: 60, fresh: 3, active: 2, nonActive: 1, portfolio: 5, portfolioActive: 3, portfolioNonActive: 2 });
    expect(portfolioFreshness([]).pct).toBe(0);
  });
});

describe('lifecycle definitions come from the ETL config', () => {
  it('uses the config values (defaults = config/product_dashboard.json)', () => {
    expect(lifecycleConfig(undefined)).toEqual({ newDays: 180, windowDays: 90, growthPct: 20, noSalesDays: 365 });
    const c = lifecycleConfig({ lifecycle: { new_first_sale_within_days: 120, trend_window_days: 60, growth_threshold_pct: 15, discontinued_no_sales_days: 300 } });
    const d = segmentDefinitions(c);
    expect(d.New).toBe('First sale ≤ 120 d');
    expect(d.Discontinued).toBe('No sale in 300 d');
    expect(d.Growing).toBe('Last 60 d > +15%');
    expect(d.Mature).toBe('Last 60 d within ±15%');
  });
});

describe('Mature SKUs % (2026-11-15): over the portfolio only', () => {
  it('Dormant / Unclassified rows never enter the denominator', () => {
    const rows = [fact(1, 'Active', 'Mature'), fact(2, 'NonActive', 'Never sold'), fact(3, 'Dormant', 'Mature'), fact(4, 'Unclassified', 'Mature')];
    expect(maturePct(rows)).toBe(50);
    expect(maturePct([])).toBeNull();
  });
});
