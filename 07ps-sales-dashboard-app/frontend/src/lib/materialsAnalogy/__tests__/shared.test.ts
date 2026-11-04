import { describe, expect, it } from 'vitest';
import { PARTNER_BRANDS, computeBrandStats, frequencyBucket, isBrandOf, toProductFacts, type ProductFact } from '../shared';
import type { ProductDashboardOverview, ProductDashboardRow } from '../../api';

const fact = (over: Partial<ProductFact>): ProductFact => ({
  id: 'Majaal|1', ProductKey: '1', ProductName: 'P', OdooProductName: 'P', Company: 'Majaal', Category: 'C', Brand: null, SubBrand: null,
  Family: null, Size: null, SKU: null, IsActive: 1, value: 0, volume: 0, volumeByUom: [], uom: 'Unit', velocity: null, orderDays: 0,
  valuePrior: 0, avgUnitPrice: null, grossProfitPct: null, bcg_class_YTD: null, bcg_class_LYTD: null, bcg_movement: null,
  bcgExcludedCategory: false, total_value_YTD: 0, total_value_LYTD: 0, total_quantity_YTD: 0, total_quantity_LYTD: 0,
  avg_unit_price_YTD: null, perc_gross_profit_YTD: null, quantity_growth_pct: null, stockQty: 0, stockValue: 0, inTransitQty: 0,
  inTransitValue: 0, avgDailySales: 0, daysOfInventory: null, stockBand: 'Normal', lifecycle: 'Mature', firstSaleDate: null,
  lastSaleDate: null, daysSinceLastSale: null, Companies: ['Majaal'], parts: [], ...over,
});

describe('partner brands', () => {
  it('lists TAU, not RAK CERAMICS or Porcelanosa', () => {
    const names = PARTNER_BRANDS.map((b) => b.requested);
    expect(names).toContain('TAU');
    expect(names).not.toContain('RAK CERAMICS');
    expect(names).not.toContain('Porcelanosa');
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

describe('Sales Frequency buckets', () => {
  it('buckets by the average gap between selling days', () => {
    expect(frequencyBucket(0, 30)).toBeNull();
    expect(frequencyBucket(15, 30)).toBe('Daily'); // every 2 days
    expect(frequencyBucket(14, 30)).toBe('Weekly'); // every 2.1 days
    expect(frequencyBucket(5, 30)).toBe('Weekly'); // every 6 days
    expect(frequencyBucket(4, 30)).toBe('Monthly'); // every 7.5 days
    expect(frequencyBucket(1, 31)).toBe('Monthly');
    expect(frequencyBucket(1, 90)).toBe('Rarer');
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
