import { describe, expect, it } from 'vitest';
import {
  PARTNER_BRANDS, agingBuckets, agingColor, computeBrandStats, dohRule, frequencyBucket, frequencyBuckets, frequencyColor, frequencyLabel,
  findPartnerBrandBySlug, isBrandOf, isrBands, slugifyBrand, isrPct, isrStatus, lookbackDays, moverGroupOf, moverRule, moverRuleText, toProductFacts, velocityVsCategoryMedian, type ProductFact,
} from '../shared';
import type { ProductDashboardOverview, ProductDashboardRow } from '../../api';

const fact = (over: Partial<ProductFact>): ProductFact => ({
  id: 'Majaal|1', odooUrl: null, ProductKey: '1', ProductName: 'P', OdooProductName: 'P', Company: 'Majaal', Category: 'C', Brand: null, SubBrand: null,
  Family: null, Size: null, SKU: null, IsActive: 1, value: 0, volume: 0, volumeByUom: [], uom: 'Unit', velocity: null, orderDays: 0,
  valuePrior: 0, volumePrior: 0, avgUnitPrice: null, grossProfitPct: null, bcg_class_YTD: null, bcg_class_LYTD: null, bcg_movement: null,
  bcgExcludedCategory: false, total_value_YTD: 0, total_value_LYTD: 0, total_quantity_YTD: 0, total_quantity_LYTD: 0,
  avg_unit_price_YTD: null, perc_gross_profit_YTD: null, quantity_growth_pct: null, stockQty: 0, stockValue: 0, inTransitQty: 0,
  inTransitValue: 0, avgDailySales: 0, daysOfInventory: null, stockBand: 'Normal', stockAgeDays: null, stockAgeBucket: null, lifecycle: 'Mature', firstSaleDate: null,
  lastSaleDate: null, daysSinceLastSale: null, Companies: ['Majaal'], parts: [], ...over,
});

describe('partner brands', () => {
  it('lists TAU, not RAK CERAMICS or Porcelanosa', () => {
    const names = PARTNER_BRANDS.map((b) => b.requested);
    expect(names).toContain('TAU');
    expect(names).not.toContain('RAK CERAMICS');
    expect(names).not.toContain('Porcelanosa');
  });

  it('includes Stonewrap, Saquer Gulf, Lotus Tile and Al-Saraya Al-Hamra by their Odoo vendor names (2026-11-07)', () => {
    const byName = Object.fromEntries(PARTNER_BRANDS.map((b) => [b.requested, b]));
    expect(PARTNER_BRANDS.map((b) => b.requested)).toEqual(['Ape Grupo', 'VitrA', 'Onyx', 'Mayor', 'QUA', 'FILA', 'TAU', 'Stonewrap', 'Saquer Gulf & Lotus Tile', 'Al-Saraya Al-Hamra']);
    expect(isBrandOf(byName['Stonewrap'], { Brand: 'Stonewrap' })).toBe(true);
    expect(isBrandOf(byName['Saquer Gulf & Lotus Tile'], { Brand: 'SAQUER GULF' })).toBe(true);
    expect(isBrandOf(byName['Saquer Gulf & Lotus Tile'], { Brand: 'Lotus Tile' })).toBe(true);
    expect(slugifyBrand('Saquer Gulf & Lotus Tile')).toBe('saquer-gulf-lotus-tile');
    expect(findPartnerBrandBySlug('saquer-gulf-lotus-tile')?.odooNames).toEqual(['Saquer Gulf', 'Lotus Tile']);
    expect(isBrandOf(byName['Al-Saraya Al-Hamra'], { Brand: 'Al-Saraya Al-Hamra' })).toBe(true);
    expect(isBrandOf(byName['Al-Saraya Al-Hamra'], { Brand: 'شركة السرايا البيضاء' })).toBe(false); // a different vendor
  });

  it('a new brand with no product yet still gets its "not assigned in Odoo" card', () => {
    const { found, notFound } = computeBrandStats([fact({ Brand: 'Stonewrap', value: 10, volume: 5 })]);
    expect(found.map((b) => b.requested)).toEqual(['Stonewrap']);
    expect(notFound.map((b) => b.requested)).toEqual(expect.arrayContaining(['Saquer Gulf & Lotus Tile', 'Al-Saraya Al-Hamra']));
  });

  it('Saquer Gulf & Lotus Tile: one card with both brands together; GP% weighted by revenue, not averaged', () => {
    const { found } = computeBrandStats([
      fact({ id: 'Majaal|1', Brand: 'Saquer Gulf', value: 900, valuePrior: 600, volume: 90, volumePrior: 60, grossProfitPct: 40 }),
      fact({ id: 'Majaal|2', Brand: 'Lotus Tile', value: 100, valuePrior: 400, volume: 10, volumePrior: 40, grossProfitPct: 10 }),
      fact({ id: 'Majaal|3', Brand: 'Lotus Tile', value: 0, volume: 0 }), // in the catalogue, not sold
    ]);
    const card = found.find((b) => b.requested === 'Saquer Gulf & Lotus Tile')!;
    expect([card.revenue, card.revenuePrior, card.volume, card.volumePrior, card.skuCount, card.skuSold]).toEqual([1000, 1000, 100, 100, 3, 2]);
    expect(card.gp).toBeCloseTo(37); // (40 x 900 + 10 x 100) / 1000 -- a plain average would be 25
    expect(card.volumeDeltaPct).toBe(0);
  });

  it('matches the Odoo brand (main vendor) case-insensitively', () => {
    const tau = PARTNER_BRANDS.find((b) => b.requested === 'TAU')!;
    expect(isBrandOf(tau, { Brand: 'tau CERAMICA' })).toBe(true);
    expect(isBrandOf(tau, { Brand: 'Tauro' })).toBe(false);
    expect(isBrandOf(tau, { Brand: null })).toBe(false);
  });

  it('a brand with no product in Odoo yet is "not currently assigned", never dropped', () => {
    const rows = [fact({ Brand: 'APE Group', value: 100 }), fact({ id: 'Tika|2', Company: 'Tika', Brand: 'ape group', value: 50 })];
    const { found, notFound } = computeBrandStats(rows);
    expect(found.map((b) => b.requested)).toEqual(['Ape Grupo']);
    expect(found[0]).toMatchObject({ revenue: 150, skuCount: 2 });
    expect(found[0].companySplit.map((c) => c.company)).toEqual(['Majaal', 'Tika']);
    expect(notFound.map((b) => b.requested)).toContain('TAU');
  });
});

describe('Sales Frequency buckets (config: Daily ≤ 2 · Weekly ≤ 7 · Monthly ≤ 30 · Quarterly ≤ 90 · Rarely)', () => {
  const buckets = frequencyBuckets({
    sales_frequency: { buckets: [{ key: 'Daily', max_gap_days: 2 }, { key: 'Weekly', max_gap_days: 7 }, { key: 'Monthly', max_gap_days: 30 }, { key: 'Quarterly', max_gap_days: 90 }, { key: 'Rarely', max_gap_days: null }] },
  });
  it('buckets by the average gap between selling days, at every boundary', () => {
    expect(frequencyBucket(0, 30, buckets)).toBeNull();
    expect(frequencyBucket(15, 30, buckets)).toBe('Daily'); // every 2 days
    expect(frequencyBucket(14, 30, buckets)).toBe('Weekly'); // every 2.1 days
    expect(frequencyBucket(30, 210, buckets)).toBe('Weekly'); // every 7 days
    expect(frequencyBucket(4, 30, buckets)).toBe('Monthly'); // every 7.5 days
    expect(frequencyBucket(1, 30, buckets)).toBe('Monthly'); // every 30 days
    expect(frequencyBucket(1, 31, buckets)).toBe('Quarterly'); // every 31 days
    expect(frequencyBucket(1, 90, buckets)).toBe('Quarterly'); // every 90 days
    expect(frequencyBucket(1, 91, buckets)).toBe('Rarely');
  });
  it('labels and colours: Rarely (not "Rarer") is red', () => {
    expect(buckets.map((b) => frequencyLabel(buckets, b.key))).toEqual([
      'Daily (≤ 2 days)', 'Weekly (3–7 days)', 'Monthly (8–30 days)', 'Quarterly (31–90 days)', 'Rarely (> 90 days)']);
    expect(frequencyColor(buckets, 'Rarely')).toBe('var(--ps-color-alert)');
    expect(frequencyColor(buckets, 'Daily')).toBe('var(--ps-color-success)');
  });
  it('falls back to the default buckets when the config has none', () => {
    expect(frequencyBuckets({}).map((b) => b.key)).toEqual(['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Rarely']);
  });
});

describe('Fast vs Slow Movers benchmark (config: Fast ≥ 150% of the category median, Slow ≤ 50%)', () => {
  const rule = moverRule({ stock: { fast_mover_vs_category_median_pct: 150, slow_mover_vs_category_median_pct: 50 } });
  it('boundaries are inclusive', () => {
    expect(moverGroupOf(150, rule)).toBe('Fast');
    expect(moverGroupOf(149.99, rule)).toBe('Normal');
    expect(moverGroupOf(100, rule)).toBe('Normal');
    expect(moverGroupOf(50.01, rule)).toBe('Normal');
    expect(moverGroupOf(50, rule)).toBe('Slow');
    expect(moverGroupOf(0, rule)).toBe('Slow');
  });
  it("compares with the median of each SKU's own category in the same company", () => {
    const v = (id: string, Company: string, Category: string, velocity: number) => ({ id, Company, Category, velocity });
    const ratios = velocityVsCategoryMedian([
      v('a', 'Majaal', 'Tiles', 1), v('b', 'Majaal', 'Tiles', 2), v('c', 'Majaal', 'Tiles', 4),   // median 2
      v('d', 'Tika', 'Tiles', 10),                                                                 // other company: alone
      v('e', 'Majaal', 'Adhesive', 30), v('f', 'Majaal', 'Adhesive', 10),                          // median 20
    ]);
    expect([...ratios.entries()]).toEqual([['a', 50], ['b', 100], ['c', 200], ['d', 100], ['e', 150], ['f', 50]]);
    expect(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => moverGroupOf(ratios.get(id)!, rule))).toEqual(['Slow', 'Normal', 'Fast', 'Normal', 'Fast', 'Slow']);
  });
  it('defaults and the "?" line come from the config values', () => {
    expect(moverRule({})).toEqual({ fastPct: 150, slowPct: 50 });
    expect(moverRuleText(moverRule({ stock: { fast_mover_vs_category_median_pct: 200, slow_mover_vs_category_median_pct: 40 } })))
      .toBe('Velocity = units sold ÷ days in period. Fast ≥ 200% of the category median · Slow ≤ 40%');
  });
});

describe('ISR colour bands (config stock.isr_target_pct 15, isr_red_pct 25)', () => {
  const bands = isrBands({ stock: { isr_target_pct: 15, isr_red_pct: 25 } });
  it('≤ 15% green, 15–25% yellow, ≥ 25% red; no sales = neutral', () => {
    expect(isrPct(15, 100)).toBe(15);
    expect(isrStatus(15, bands)).toBe('success');
    expect(isrStatus(15.01, bands)).toBe('watch');
    expect(isrStatus(24.99, bands)).toBe('watch');
    expect(isrStatus(25, bands)).toBe('alert');
    expect(isrStatus(isrPct(10, 0), bands)).toBe('neutral');
  });
});

describe('Stock Aging buckets (config stock.aging_buckets)', () => {
  const buckets = agingBuckets({ stock: { aging_buckets: [{ label: '0–90 days', max_days: 90 }, { label: '91–180 days', max_days: 180 }, { label: '181–365 days', max_days: 365 }, { label: '1–2 years', max_days: 730 }, { label: '> 2 years', max_days: null }] } });
  it('green to red, youngest to oldest', () => {
    expect(buckets.map((b) => b.label)).toEqual(['0–90 days', '91–180 days', '181–365 days', '1–2 years', '> 2 years']);
    expect(agingColor(buckets, '0–90 days')).toBe('var(--ps-color-success)');
    expect(agingColor(buckets, '1–2 years')).toBe('var(--ps-color-alert)');
    expect(agingColor(buckets, '> 2 years')).toContain('--ps-color-alert');
  });
  it('days-on-hand rules for the "?" come from the config (Athena left out)', () => {
    const t = { days_of_inventory: { overstock_days: { Majaal: 180, Tika: 60, Athena: 180 }, stockout_risk_days: { Majaal: 60, Tika: 30 }, lookback_days: 90 } };
    expect(dohRule(t, 'overstock_days', '>')).toBe('Majaal > 180 days · Tika > 60 days');
    expect(dohRule(t, 'stockout_risk_days', '<')).toBe('Majaal < 60 days · Tika < 30 days');
    expect(lookbackDays(t)).toBe(90);
  });
});

describe('toProductFacts', () => {
  it('never returns an Athena row and carries the order days', () => {
    const row = (company: string, orderDays: number) => ({ productCompanyKey: `${company}|1`, company, orderDays, companies: [company], parts: [] }) as unknown as ProductDashboardRow;
    const data = { products: [row('Majaal', 3), row('Athena', 9)], asOfDate: '2026-11-04' } as unknown as ProductDashboardOverview;
    const facts = toProductFacts(data);
    expect(facts.map((f) => f.Company)).toEqual(['Majaal']);
    expect(facts[0].orderDays).toBe(3);
  });
});
