import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { DateTime } from 'luxon';
import { computeProductDashboard, resolvePeriod } from '../productDashboard';

/** Mocks pool.query by SQL text (same convention as the other measure tests). */
const META = [{ AsOfDate: '2026-09-29', LookbackDays: 90,
  ConfigJson: '{"intercompany_customers":{"names":["x"]},"bcg":{"volume_threshold":{"Majaal":3500,"Tika":25000,"Athena":3500},"profit_threshold_pct":35}}' }];

function makePool(salesRows: unknown[], productRows: unknown[], meta: unknown[] = META, orderDayRows: unknown[] = [], soldRows: unknown[] = [],
  bcgWindows: unknown[] = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('SELECT DISTINCT Company FROM v_sales_product_daily')) {
      const keys = (params[0] as number[]) ?? [];
      return [[...(keys.includes(1) ? [{ Company: 'Majaal' }] : []), ...(keys.includes(2) ? [{ Company: 'Tika' }] : [])]];
    }
    if (sql.includes('COUNT(DISTINCT d.OrderDate)')) return [orderDayRows];
    if (sql.includes('SELECT DISTINCT d.ProductCompanyKey')) return [soldRows];
    if (sql.includes('AS win')) return [bcgWindows];
    if (sql.includes('FROM v_sales_product_daily')) return [salesRows];
    if (sql.includes('FROM v_sales_product_dashboard')) return [productRows];
    if (sql.includes('FROM etl_sales_product_dashboard_meta')) return [meta];
    throw new Error(`unexpected SQL: ${sql}`);
  });
  return { pool: { query } as unknown as Pool, calls };
}

const product = (key: string, company: string, extra: Record<string, unknown> = {}) => ({
  ProductCompanyKey: key, ProductKey: key.split('|')[1] ?? key, Company: company, ProductName: key, Brand: 'Unassigned', StockQty: 0, StockValue: 0,
  InTransitQty: 0, InTransitValue: 0, AvgDailySales: 0, DaysOfInventory: null, StockBand: 'NoStockNoSales',
  LifecycleSegment: 'Mature', ValueYTD: 0, QtyYTD: 0, ValueLYTD: 0, QtyLYTD: 0, ...extra,
});
const sale = (k: string, uom: string, value: number, qty: number, lines = 1, extra: Record<string, unknown> = {}) => ({
  k, uom, value, qty, lineCount: lines, costValue: 0, uncostedQty: qty, valuePrior: 0, qtyPrior: 0, icValue: 0,
  linesPrior: 0, valueYTD: 0, qtyYTD: 0, valueLYTD: 0, qtyLYTD: 0, ...extra,
});

/** One row of the BCG window query: product, window ('YTD' or a year), value, qty, cost, last sale date, uncosted qty. */
const win = (k: string, w: string, value: number, qty: number, cost: number, lastDate = '2025-06-30', uncosted = 0) => ({
  k, company: k.split('|')[0], win: w, value, qty, cost, incompleteDays: uncosted, costedRows: 1, lastDate,
});

describe('resolvePeriod', () => {
  const now = DateTime.fromISO('2026-09-29T10:00:00', { zone: 'Africa/Tripoli' });

  it('defaults to calendar YTD and counts days inclusively', () => {
    const p = resolvePeriod(undefined, undefined, now);
    expect(p).toMatchObject({ from: '2026-01-01', to: '2026-09-29', days: 272, priorFrom: '2025-01-01', priorTo: '2025-09-29' });
  });

  it('caps the end at today and never lets from pass to', () => {
    expect(resolvePeriod('2026-09-01', '2027-01-01', now)).toMatchObject({ from: '2026-09-01', to: '2026-09-29', days: 29 });
    expect(resolvePeriod('2026-10-05', '2026-09-10', now)).toMatchObject({ from: '2026-09-10', to: '2026-09-10', days: 1 });
  });
});

describe('computeProductDashboard', () => {
  it('keeps zero-sales products, adds quantities up across UoMs as "Unit", and totals straight from the sales rows', async () => {
    const { pool } = makePool(
      [
        sale('Majaal|101', 'UNIT', 1000, 100),
        sale('Majaal|102', 'm2', 300, 10),
        sale('Majaal|102', 'UNIT', 200, 5),
        sale('Tika|201', 'UNIT', 50, 2),
        sale('Tika|909', 'UNIT', 7, 1), // sold, but missing from the product table -> still in the totals
      ],
      [product('Majaal|101', 'Majaal'), product('Majaal|102', 'Majaal'), product('Majaal|103', 'Majaal'), product('Tika|201', 'Tika')],
    );

    const out = await computeProductDashboard(pool, { fromDate: '2026-09-01', toDate: '2026-09-10' });
    const byKey = Object.fromEntries(out.products.map((p) => [p.productCompanyKey, p]));

    expect(out.period.days).toBe(10);
    expect(byKey['Majaal|101']).toMatchObject({ value: 1000, volume: 100, uom: 'UNIT', velocity: 10 });
    // two units of measure: added up as "Unit" (2026-11-07), the split kept for reference
    expect(byKey['Majaal|102']).toMatchObject({ volume: 15, uom: 'Unit', velocity: 1.5 });
    expect(byKey['Majaal|102'].volumeByUom).toEqual([{ uom: 'm2', qty: 10 }, { uom: 'UNIT', qty: 5 }]);
    expect(byKey['Majaal|103']).toMatchObject({ value: 0, volume: 0, lines: 0 });
    expect(byKey['Majaal|101']).toMatchObject({ productKey: '101', brand: 'Unassigned' }); // Odoo product id; empty Odoo brand
    expect(out.totals.value).toBe(1557);
    expect(out.totals.volumeByUom).toEqual([{ uom: 'UNIT', qty: 108 }, { uom: 'm2', qty: 10 }]);
    expect(out.thresholds).not.toHaveProperty('intercompany_customers');
  });

  it('applies the scope clause to the daily table and then hides products sold only outside the scope', async () => {
    const { pool, calls } = makePool(
      [sale('Majaal|101', 'UNIT', 10, 1)],
      [product('Majaal|101', 'Majaal'), product('Majaal|102', 'Majaal')],
      META, [], [{ k: 'Majaal|101' }, { k: 'Majaal|102' }], // 102 sold in the period, to someone else
    );

    const out = await computeProductDashboard(pool, { fromDate: '2026-01-01', toDate: '2026-01-31', filters: { salespersonKeys: [42] } });

    const salesCall = calls.find((c) => c.sql.includes('v_sales_product_daily'))!;
    expect(salesCall.sql).toContain('d.SalespersonKey IN (?)');
    // MySQL reserved words (LINES, VALUE is fine) must never be used as bare aliases.
    expect(salesCall.sql).not.toMatch(/\bAS lines\b/i);
    expect(salesCall.params[salesCall.params.length - 2]).toBe(42); // then the excluded companies (Athena)
    expect(out.products.map((p) => p.productCompanyKey)).toEqual(['Majaal|101']);
  });

  describe('membership under a filter (2026-11-07)', () => {
    const rows = [product('Majaal|1', 'Majaal'), product('Majaal|2', 'Majaal'), product('Majaal|3', 'Majaal', { StockQty: 50 }), product('Majaal|4', 'Majaal')];
    const sales = [
      sale('Majaal|1', 'Unit', 10, 1),                                                     // sold in scope this period
      sale('Majaal|2', 'Unit', 0, 0, 0, { linesPrior: 2, valuePrior: 30, qtyPrior: 3 }),   // in scope last year only
    ];
    const soldAnywhere = [{ k: 'Majaal|1' }, { k: 'Majaal|2' }, { k: 'Majaal|4' }];        // 4 sold, but only to other groups
    const filters = { segmentKeys: [1, 2] };

    it('keeps products sold in scope this period OR the same period last year, and stock-only / never-sold ones', async () => {
      const { pool } = makePool(sales, rows, META, [], soldAnywhere);
      const out = await computeProductDashboard(pool, { filters });
      expect(out.products.map((p) => p.productCompanyKey).sort()).toEqual(['Majaal|1', 'Majaal|2', 'Majaal|3']);
    });

    it('a salesperson-tier caller only sees products with sales in scope', async () => {
      const { pool } = makePool(sales, rows, META, [], soldAnywhere);
      const out = await computeProductDashboard(pool, { filters: { salespersonKeys: [7] }, salespersonTier: true });
      expect(out.products.map((p) => p.productCompanyKey).sort()).toEqual(['Majaal|1', 'Majaal|2']);
    });

    it('no filter: every product, and the "sold anywhere" query is not run', async () => {
      const { pool, calls } = makePool(sales, rows);
      const out = await computeProductDashboard(pool, {});
      expect(out.products).toHaveLength(4);
      expect(calls.some((c) => c.sql.includes('SELECT DISTINCT d.ProductCompanyKey'))).toBe(false);
    });
  });

  it('Volume / Revenue YTD and LYTD follow the filters (calendar windows); class (company-wide) and movement do not', async () => {
    const { pool, calls } = makePool(
      [sale('Majaal|1', 'Unit', 10, 1, 1, { valueYTD: 900, qtyYTD: 90, valueLYTD: 400, qtyLYTD: 40 }),
       sale('Majaal|1', 'm2', 0, 0, 0, { valueYTD: 100, qtyYTD: 10 })],
      [product('Majaal|1', 'Majaal', { ValueYTD: 99999, QtyYTD: 9999, BcgClassYTD: 'Dogs', BcgMovement: 'Improved' })],
      META, [], [],
      [win('Majaal|1', 'YTD', 50000, 4000, 20000)], // company-wide: 4,000 units >= 3,500, GP 60% -> Stars
    );
    const out = await computeProductDashboard(pool, { fromDate: '2026-03-01', toDate: '2026-03-31', filters: { segmentKeys: [1] } });
    expect(out.products[0]).toMatchObject({ valueYTD: 1000, volumeYTD: 100, valueLYTD: 400, volumeLYTD: 40, bcgClassYTD: 'Stars', bcgMovement: 'Improved' });
    const salesCall = calls.find((c) => c.sql.includes('SUM(CASE'))!;
    const today = DateTime.now().setZone('Africa/Tripoli');
    expect(salesCall.params).toContain(`${today.year}-01-01`);
    expect(salesCall.params).toContain(`${today.year - 1}-01-01`);
  });

  it('every product links to its Odoo product.product form in its own company (ODOO_URL), never a guessed host', async () => {
    const { pool } = makePool([], [product('Majaal|2163', 'Majaal', { CompanyKey: 1 }), product('Tika|-1', 'Tika', { ProductKey: -1, CompanyKey: 3 })]);
    const prev = { url: process.env.ODOO_URL, web: process.env.ODOO_WEB_BASE_URL };
    process.env.ODOO_URL = 'https://odoo.example.com/';
    delete process.env.ODOO_WEB_BASE_URL;
    try {
      const out = await computeProductDashboard(pool, {});
      const byKey = Object.fromEntries(out.products.map((p) => [p.productCompanyKey, p]));
      expect(byKey['Majaal|2163'].odooUrl).toBe('https://odoo.example.com/web#id=2163&model=product.product&view_type=form&cids=1');
      expect(byKey['Tika|-1'].odooUrl).toBeNull();
      delete process.env.ODOO_URL;
      expect((await computeProductDashboard(pool, {})).products[0].odooUrl).toBeNull();
    } finally {
      if (prev.url === undefined) delete process.env.ODOO_URL; else process.env.ODOO_URL = prev.url;
      if (prev.web !== undefined) process.env.ODOO_WEB_BASE_URL = prev.web;
    }
  });

  it('reports GP% only when every line in the period has a cost', async () => {
    const { pool } = makePool(
      [sale('Majaal|101', 'UNIT', 100, 10, 1, { costValue: 60, uncostedQty: 0 }), sale('Majaal|102', 'UNIT', 100, 10, 1, { costValue: 60, uncostedQty: 4 })],
      [product('Majaal|101', 'Majaal'), product('Majaal|102', 'Majaal')],
    );
    const out = await computeProductDashboard(pool, {});
    const byKey = Object.fromEntries(out.products.map((p) => [p.productCompanyKey, p]));
    expect(byKey['Majaal|101'].grossProfitPct).toBeCloseTo(40);
    expect(byKey['Majaal|102'].grossProfitPct).toBeNull();
  });

  describe('same Odoo template sold by both companies', () => {
    // Odoo products 301 (Majaal) and 302 (Tika) are variants of one template: still two rows, one company each.
    const products = [
      product('Majaal|301', 'Majaal', { ProductName: 'Cemair', StockQty: 60 }),
      product('Tika|302', 'Tika', { ProductName: 'Cemair', StockQty: 120 }),
      product('Majaal|303', 'Majaal'),
      product('Tika|201', 'Tika'),
    ];
    const sales = [
      sale('Majaal|301', 'Unit', 300, 100, 3, { costValue: 100, uncostedQty: 0, valuePrior: 40 }),
      sale('Tika|302', 'Unit', 700, 90, 5, { costValue: 180, uncostedQty: 0, valuePrior: 60 }),
      sale('Majaal|303', 'Unit', 5, 1, 1, { costValue: 1, uncostedQty: 0 }),
      sale('Tika|201', 'Unit', 5, 1, 1),
    ];

    it('all companies: one row per company product, never combined ("Majaal + Tika" never appears)', async () => {
      const { pool, calls } = makePool(sales, products);
      const out = await computeProductDashboard(pool, { fromDate: '2026-01-01', toDate: '2026-01-10' });
      expect(out.view).toBe('BMH');
      const cemair = out.products.filter((p) => p.productName === 'Cemair');
      expect(cemair.map((p) => [p.productCompanyKey, p.company, p.value, p.stockQty])).toEqual([
        ['Majaal|301', 'Majaal', 300, 60],
        ['Tika|302', 'Tika', 700, 120],
      ]);
      expect(out.products.every((p) => p.companies.length === 1 && !p.company.includes('+'))).toBe(true);
      expect(calls.some((c) => c.sql.includes('dim_sales_product_group'))).toBe(false);
      // company totals add up to the page total
      expect(out.products.reduce((t, p) => t + p.value, 0)).toBe(out.totals.value);
      expect(out.totals.value).toBe(1010);
    });

    it('order days per product come from the distinct order dates in the period (Sales Frequency)', async () => {
      const { pool, calls } = makePool(sales, products, META, [{ k: 'Majaal|301', orderDays: 7 }]);
      const out = await computeProductDashboard(pool, { fromDate: '2026-01-01', toDate: '2026-01-10', company: 'Majaal' });
      expect(out.products.find((p) => p.productCompanyKey === 'Majaal|301')?.orderDays).toBe(7);
      expect(out.products.find((p) => p.productCompanyKey === 'Majaal|303')?.orderDays).toBe(0);
      const call = calls.find((c) => c.sql.includes('COUNT(DISTINCT d.OrderDate)'))!;
      expect(call.params).toEqual(['2026-01-01', '2026-01-10', 'Majaal', ['Athena']]);
    });

    it('Athena is excluded in SQL from both the sales and the product rows', async () => {
      const { pool, calls } = makePool(sales, products);
      await computeProductDashboard(pool, {});
      const salesCall = calls.find((c) => c.sql.includes('SUM(CASE'))!;
      expect(salesCall.sql).toContain('d.Company NOT IN (?)');
      expect(salesCall.params[salesCall.params.length - 1]).toEqual(['Athena']);
      const productCall = calls.find((c) => c.sql.includes('FROM v_sales_product_dashboard'))!;
      expect(productCall.sql).toContain('Company NOT IN (?)');
      expect(productCall.params).toEqual([['Athena']]);
    });

    it('company view: only that company, from the daily table filtered by Company', async () => {
      const { pool, calls } = makePool(sales.filter((r) => r.k.startsWith('Tika|')), products);
      const out = await computeProductDashboard(pool, { fromDate: '2026-01-01', toDate: '2026-01-10', company: 'TIKA' });
      expect(out.view).toBe('Tika');
      const salesCall = calls.find((c) => c.sql.includes('v_sales_product_daily'))!;
      expect(salesCall.sql).toContain('d.Company = ?');
      expect(salesCall.params[salesCall.params.length - 2]).toBe('Tika');
      expect(out.products.map((p) => p.productCompanyKey).sort()).toEqual(['Tika|201', 'Tika|302']);
      expect(out.products.find((p) => p.productCompanyKey === 'Tika|302')).toMatchObject({ value: 700, volume: 90, companies: ['Tika'] });
      expect(out.totals.value).toBe(705);
    });

    it('a role limited to one company gets that company view', async () => {
      const { pool, calls } = makePool(sales.filter((r) => r.k.startsWith('Majaal|')), products);
      const out = await computeProductDashboard(pool, { filters: { companyKeys: [1] } });
      expect(out.view).toBe('Majaal');
      const salesCall = calls.find((c) => c.sql.includes('SUM(CASE'))!;
      expect(salesCall.sql).toContain('d.CompanyKey IN (?)');
      expect(out.products.every((p) => p.company === 'Majaal')).toBe(true);
      expect(out.products.find((p) => p.productName === 'Cemair')).toMatchObject({ value: 300, stockQty: 60 });
      await expect(computeProductDashboard(pool, { company: 'Tika', filters: { companyKeys: [1] } })).rejects.toThrow(/outside/);
    });
  });

  it('BCG: config thresholds on each product\'s latest fully costed data, with its profit and the date of that data', async () => {
    const { pool } = makePool(
      [],
      ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((i) => product(`${i === '7' ? 'Tika' : 'Majaal'}|${i}`, i === '7' ? 'Tika' : 'Majaal')),
      META, [], [],
      [
        win('Majaal|1', 'YTD', 7000, 3500, 4550, '2026-11-10'),         // volume = threshold -> High; GP 35% -> High -> Stars
        win('Majaal|1', '2025', 100, 10, 90),                            // older year never used when YTD is costed
        win('Majaal|2', 'YTD', 1000, 100, 500, '2026-10-01', 5),          // YTD has an uncosted line ...
        win('Majaal|2', '2025', 2000, 200, 1800, '2025-12-20'),          // ... so the latest costed year: GP 10% -> Dogs
        win('Majaal|2', '2024', 9000, 9000, 1000),
        win('Majaal|3', '2023', 10000, 5000, 9000, '2023-06-30'),        // only sold in 2023: Cash Cows on 2023 data
        { ...win('Majaal|4', 'YTD', 500, 50, 0, '2026-11-01', 50), costedRows: 0 }, // never costed
        win('Majaal|5', 'YTD', 900, 30, 300, '2026-11-02'),              // low volume, GP 66.7% -> Strategic
        win('Tika|7', 'YTD', 30000, 24999, 1000, '2026-11-03'),          // under the Tika 25,000 -> Strategic
        win('Majaal|8', 'YTD', 0, 10, 80, '2026-11-01'),                // recorded cost, undefined margin
        win('Majaal|9', '2025', 1000, 100, 1000, '2025-11-03', 5),      // only costed subtotal, genuine zero profit
      ],
    );
    const out = await computeProductDashboard(pool, { company: 'All', fromDate: '2026-03-01', toDate: '2026-03-31' });
    const by = Object.fromEntries(out.products.map((r) => [r.productCompanyKey, r]));
    expect(by['Majaal|1']).toMatchObject({ bcgClassYTD: 'Stars', bcgProfit: 2450, bcgVolume: 3500, bcgDataAsOf: '2026-11-10' });
    expect(by['Majaal|1'].bcgDataPeriod).toMatch(/^YTD \d{4}$/);
    expect(by['Majaal|2']).toMatchObject({ bcgClassYTD: 'Dogs', bcgProfit: 200, bcgDataPeriod: '2025', bcgDataAsOf: '2025-12-20' });
    expect(by['Majaal|3']).toMatchObject({ bcgClassYTD: 'Cash Cows', bcgProfit: 1000, bcgDataPeriod: '2023', bcgDataAsOf: '2023-06-30' });
    expect(by['Majaal|4']).toMatchObject({ bcgClassYTD: 'Unclassified (no cost)', bcgProfit: null, bcgDataPeriod: null });
    expect(by['Majaal|5'].bcgClassYTD).toBe('Strategic');
    expect(by['Majaal|6']).toMatchObject({ bcgClassYTD: null, bcgProfit: null });   // never sold: no class
    expect(by['Tika|7'].bcgClassYTD).toBe('Strategic');
    expect(by['Majaal|8']).toMatchObject({ bcgClassYTD: 'Unclassified (zero revenue)', bcgProfit: -80, bcgGrossProfitPct: null });
    expect(by['Majaal|9']).toMatchObject({ bcgClassYTD: 'Dogs', bcgProfit: 0, bcgDataPeriod: '2025 (costed sales)', bcgDataAsOf: '2025-11-03' });
  });

  it('BCG thresholds fall back to the config values when the ETL snapshot of the config has none', async () => {
    const meta = [{ AsOfDate: '2026-11-11', LookbackDays: 90, ConfigJson: '{"bcg":{"movement_stable_band_pct":10}}' }];
    const { pool } = makePool([], [product('Majaal|1', 'Majaal')], meta, [], [], [win('Majaal|1', 'YTD', 8000, 4000, 4000)]);
    const out = await computeProductDashboard(pool, { company: 'Majaal' });
    expect(out.thresholds.bcg).toEqual({ movement_stable_band_pct: 10, volume_threshold: { Majaal: 3500, Tika: 25000, Athena: 3500 }, profit_threshold_pct: 35 });
    expect(out.products[0].bcgClassYTD).toBe('Stars'); // 4,000 >= 3,500 and GP 50%
  });

  it('serves Odoo On Hand and the aging buckets of the config', async () => {
    const meta = [{ AsOfDate: '2026-11-10', LookbackDays: 90,
      ConfigJson: JSON.stringify({ stock: { aging_buckets: [{ key: '0_30', label: '0–30 days', max_days: 30 }, { key: '365_plus', label: '365+ days', max_days: null }] } }) }];
    const { pool } = makePool([], [product('Majaal|1', 'Majaal', { OnHandQty: 12, OnHandValue: 120, StockAgeDays: 20, StockAgeOldestDays: 400,
      StockAgeSource: 'layers', AgeQty_0_30: 10, AgeValue_0_30: 100, AgeQty_365_plus: 2, AgeValue_365_plus: 20 })], meta);
    const r = (await computeProductDashboard(pool, {})).products[0];
    expect(r).toMatchObject({ onHandQty: 12, onHandValue: 120, stockAgeOldestDays: 400, stockAgeSource: 'layers' });
    expect(r.agingBuckets).toEqual([{ key: '0_30', label: '0–30 days', qty: 10, value: 100 }, { key: '365_plus', label: '365+ days', qty: 2, value: 20 }]);
  });
});
