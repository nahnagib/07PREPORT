import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { DateTime } from 'luxon';
import { computeProductDashboard, resolvePeriod, summarizeProductStatus, type StatusInput } from '../productDashboard';
import { last12MonthsRange } from '../../lib/last12Months';

// Every Product page number is the last 12 months as of "today" (2026-11-14 here).
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-14T10:00:00Z'));
});
afterAll(() => {
  vi.useRealTimers();
});

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
    if (sql.includes('AS fullyCosted')) return [bcgWindows];
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
  linesPrior: 0, ...extra,
});

/** One row of the last-12-months BCG query: product, value, qty, cost, last sale date, uncosted days. */
const win = (k: string, value: number, qty: number, cost: number, lastDate = '2026-06-30', uncosted = 0) => ({
  k, company: k.split('|')[0], value, qty, cost, incompleteDays: uncosted, costedRows: 1, lastDate,
});

describe('resolvePeriod / last12MonthsRange (one window for every Product page)', () => {
  it('is today - 12 months (same day) to today, both included, and the 12 months before', () => {
    const now = DateTime.fromISO('2026-11-14T10:00:00', { zone: 'Africa/Tripoli' });
    expect(resolvePeriod(now)).toEqual({
      from: '2025-11-14', to: '2026-11-14', days: 366, priorFrom: '2024-11-14', priorTo: '2025-11-13', label: 'Last 12 Months',
    });
  });

  it('uses the app timezone date and handles Feb 29', () => {
    // 23:30 UTC on 28 Feb is already 1 Mar in Tripoli (UTC+2)
    expect(last12MonthsRange(DateTime.fromISO('2025-02-28T23:30:00Z'))).toMatchObject({ from: '2024-03-01', to: '2025-03-01' });
    expect(last12MonthsRange(DateTime.fromISO('2028-02-29T10:00:00', { zone: 'Africa/Tripoli' }))).toMatchObject({ from: '2027-02-28', to: '2028-02-29' });
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

    const out = await computeProductDashboard(pool, {});
    const byKey = Object.fromEntries(out.products.map((p) => [p.productCompanyKey, p]));

    expect(out.period).toMatchObject({ from: '2025-11-14', to: '2026-11-14', days: 366, label: 'Last 12 Months' });
    expect(byKey['Majaal|101']).toMatchObject({ value: 1000, volume: 100, uom: 'UNIT', velocity: 100 / 366 });
    // two units of measure: added up as "Unit" (2026-11-07), the split kept for reference
    expect(byKey['Majaal|102']).toMatchObject({ volume: 15, uom: 'Unit', velocity: 15 / 366 });
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

    const out = await computeProductDashboard(pool, { filters: { salespersonKeys: [42] } });

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

  it('volume / revenue of the last 12 months and the 12 months before follow the filters; class (company-wide) and movement do not', async () => {
    const { pool, calls } = makePool(
      [sale('Majaal|1', 'Unit', 900, 90, 1, { valuePrior: 400, qtyPrior: 40 }),
       sale('Majaal|1', 'm2', 100, 10, 1)],
      [product('Majaal|1', 'Majaal', { ValueYTD: 99999, QtyYTD: 9999, BcgClassYTD: 'Dogs', BcgMovement: 'Improved', ProductStatus: 'Active' })],
      META, [], [],
      [win('Majaal|1', 50000, 4000, 20000)], // company-wide: 4,000 units >= 3,500, GP 60% -> Stars
    );
    const out = await computeProductDashboard(pool, { filters: { segmentKeys: [1] } });
    expect(out.products[0]).toMatchObject({ value: 1000, volume: 100, valuePrior: 400, volumePrior: 40, bcgClass: 'Stars', bcgMovement: 'Improved' });
    const salesCall = calls.find((c) => c.sql.includes('SUM(CASE'))!;
    expect(salesCall.params).toContain('2025-11-14'); // last 12 months
    expect(salesCall.params).toContain('2024-11-14'); // the 12 months before
    expect(salesCall.params).toContain('2025-11-13');
    expect(salesCall.params).not.toContain('2026-01-01'); // no calendar YTD
    const bcgCall = calls.find((c) => c.sql.includes('AS fullyCosted'))!;
    expect(bcgCall.params.slice(0, 2)).toEqual(['2025-11-14', '2026-11-14']);
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
      const out = await computeProductDashboard(pool, {});
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
      const out = await computeProductDashboard(pool, { company: 'Majaal' });
      expect(out.products.find((p) => p.productCompanyKey === 'Majaal|301')?.orderDays).toBe(7);
      expect(out.products.find((p) => p.productCompanyKey === 'Majaal|303')?.orderDays).toBe(0);
      const call = calls.find((c) => c.sql.includes('COUNT(DISTINCT d.OrderDate)'))!;
      expect(call.params).toEqual(['2025-11-14', '2026-11-14', 'Majaal', ['Athena']]);
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
      const out = await computeProductDashboard(pool, { company: 'TIKA' });
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

  it('BCG: config thresholds on each Active product\'s last 12 months, with its profit and the date of that data', async () => {
    const active = { ProductStatus: 'Active' };
    const { pool } = makePool(
      [],
      [
        ...['1', '2', '4', '5', '8'].map((i) => product(`Majaal|${i}`, 'Majaal', active)),
        product('Majaal|6', 'Majaal', { ProductStatus: 'NonActive' }), // not sold in the window: no class
        product('Tika|7', 'Tika', active),
        product('Majaal|10', 'Majaal', { ProductStatus: 'NonActive' }), // a window row but not Active: never classified
      ],
      META, [], [],
      [
        win('Majaal|1', 7000, 3500, 4550, '2026-11-10'),               // volume = threshold -> High; GP 35% -> High -> Stars
        win('Majaal|2', 2000, 200, 1800, '2026-10-01', 5),             // some uncosted days: the costed days only, GP 10% -> Dogs
        { ...win('Majaal|4', 500, 50, 0, '2026-11-01', 50), costedRows: 0 }, // never costed
        win('Majaal|5', 900, 30, 300, '2026-11-02'),                   // low volume, GP 66.7% -> Strategic
        win('Tika|7', 30000, 24999, 1000, '2026-11-03'),               // under the Tika 25,000 -> Strategic
        win('Majaal|8', 0, 10, 80, '2026-11-01'),                      // recorded cost, undefined margin
        win('Majaal|10', 9000, 9000, 1000, '2026-11-01'),
      ],
    );
    const out = await computeProductDashboard(pool, { company: 'All' });
    const by = Object.fromEntries(out.products.map((r) => [r.productCompanyKey, r]));
    expect(by['Majaal|1']).toMatchObject({ bcgClass: 'Stars', bcgProfit: 2450, bcgVolume: 3500, bcgDataPeriod: 'Last 12 Months', bcgDataAsOf: '2026-11-10' });
    expect(by['Majaal|2']).toMatchObject({ bcgClass: 'Dogs', bcgProfit: 200, bcgDataPeriod: 'Last 12 Months (costed sales)' });
    expect(by['Majaal|4']).toMatchObject({ bcgClass: 'Unclassified (no cost)', bcgProfit: null, bcgDataPeriod: null });
    expect(by['Majaal|5'].bcgClass).toBe('Strategic');
    expect(by['Majaal|6']).toMatchObject({ bcgClass: null, bcgProfit: null });
    expect(by['Tika|7'].bcgClass).toBe('Strategic');
    expect(by['Majaal|8']).toMatchObject({ bcgClass: 'Unclassified (zero revenue)', bcgProfit: -80, bcgGrossProfitPct: null });
    expect(by['Majaal|10']).toMatchObject({ bcgClass: null, bcgProfit: null });
    // the cards: 6 Active = Stars 1 + Strategic 2 + Dogs 1 + Not classified 2 (no cost, zero revenue)
    expect(out.statusSummary?.active.count).toBe(6);
    expect(out.statusSummary?.bcg.classes.map((c) => [c.key, c.count])).toEqual([['Stars', 1], ['Cash Cows', 0], ['Strategic', 2], ['Dogs', 1]]);
    expect(out.statusSummary?.bcg.notClassified).toBe(2);
  });

  it('BCG thresholds fall back to the config values when the ETL snapshot of the config has none', async () => {
    const meta = [{ AsOfDate: '2026-11-11', LookbackDays: 90, ConfigJson: '{"bcg":{"movement_stable_band_pct":10}}' }];
    const { pool } = makePool([], [product('Majaal|1', 'Majaal')], meta, [], [], [win('Majaal|1', 8000, 4000, 4000)]);
    const out = await computeProductDashboard(pool, { company: 'Majaal' });
    expect(out.thresholds.bcg).toEqual({ movement_stable_band_pct: 10, volume_threshold: { Majaal: 3500, Tika: 25000, Athena: 3500 }, profit_threshold_pct: 35 });
    expect(out.products[0].bcgClass).toBe('Stars'); // 4,000 >= 3,500 and GP 50%; no ProductStatus yet -> sold in the window = Active
  });

  describe('Total SKUs / Product Status cards (statusSummary)', () => {
    const rows = [
      product('Majaal|1', 'Majaal', { ProductStatus: 'Active', QtyYTD: 100, ValueYTD: 1000 }),
      product('Majaal|2', 'Majaal', { ProductStatus: 'NonActive', OnHandQty: 5, OnHandValue: 50 }),
      product('Majaal|3', 'Majaal', { ProductStatus: 'NonActive', OnHandQty: 0 }),
      product('Majaal|4', 'Majaal', { ProductStatus: 'Dormant', OnProductPages: 0 }),
      product('Majaal|5', 'Majaal', { ProductStatus: 'Unclassified', OnProductPages: 0 }),
      product('Majaal|6', 'Majaal', { ProductStatus: 'Active', OnProductPages: 0, QtyYTD: 0, ValueYTD: 0 }), // excluded product that sold
      product('Tika|7', 'Tika', { ProductStatus: 'Active', QtyYTD: 7, ValueYTD: 70 }),
    ];

    it('counts every product (OnProductPages 0 too) once; the pages list only OnProductPages = 1', async () => {
      const { pool } = makePool([], rows, META, [], [], [win('Majaal|1', 1000, 4000, 100)]);
      const out = await computeProductDashboard(pool, {});
      expect(out.products.map((p) => p.productCompanyKey)).toEqual(['Majaal|1', 'Majaal|2', 'Majaal|3', 'Tika|7']);
      expect(out.statusSummaryError).toBeNull();
      expect(out.statusSummary).toMatchObject({
        total: 7,
        active: { count: 3, units: 107, value: 1070 },
        nonActive: { count: 2, withStock: 1, zeroStock: 1, stockUnits: 5, stockValue: 50 },
        dormant: { count: 1 },
        unclassified: { count: 1 },
      });
      expect(out.statusSummary?.bcg.classes.find((c) => c.key === 'Stars')).toMatchObject({ count: 1, units: 4000, profit: 900 });
      expect(out.statusSummary?.bcg.notClassified).toBe(2); // Majaal|6 (no sales on the pages) and Tika|7 (no profit data)
    });

    it('company view: that company only', async () => {
      const { pool } = makePool([], rows);
      const out = await computeProductDashboard(pool, { company: 'Tika' });
      expect(out.statusSummary).toMatchObject({ total: 1, active: { count: 1 } });
    });

    it('before migration 0073 (no ProductStatus): no cards, a clear message, the pages still work', async () => {
      const { pool } = makePool([], [product('Majaal|1', 'Majaal')]);
      const out = await computeProductDashboard(pool, {});
      expect(out.products).toHaveLength(1);
      expect(out.statusSummary).toBeNull();
      expect(out.statusSummaryError).toMatch(/migration 0073/);
    });

    it('a row without a known status fails the check (reported, never silently miscounted)', async () => {
      const { pool } = makePool([], [product('Majaal|1', 'Majaal', { ProductStatus: 'Active' }), product('Majaal|2', 'Majaal', { ProductStatus: 'Weird' })]);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const out = await computeProductDashboard(pool, {});
      errors.mockRestore();
      expect(out.statusSummary).toBeNull();
      expect(out.statusSummaryError).toMatch(/unknown ProductStatus "Weird"/);
    });
  });

  describe('summarizeProductStatus reconciliation', () => {
    const input = (status: string, over: Partial<StatusInput> = {}): StatusInput => ({ status, onHandQty: 0, onHandValue: 0, unitsL12M: 0, valueL12M: 0, bcg: null, ...over });

    it('Total = Unclassified + Dormant + Active + Non Active, and the 5 BCG cards = Active', () => {
      const out = summarizeProductStatus([
        input('Active', { bcg: { bcgClass: 'Stars', volume: 10, profit: 5 } }),
        input('Active', { bcg: { bcgClass: 'Dogs', volume: 1, profit: -1 } }),
        input('Active', { bcg: { bcgClass: 'Unclassified (no cost)', volume: null, profit: null } }),
        input('Active'),
        input('NonActive', { onHandQty: 3, onHandValue: 30 }),
        input('Dormant'),
        input('Unclassified'),
      ]);
      expect(out.total).toBe(out.active.count + out.nonActive.count + out.dormant.count + out.unclassified.count);
      expect(out.bcg.classes.reduce((t, c) => t + c.count, 0) + out.bcg.notClassified).toBe(out.active.count);
      expect([out.total, out.active.count, out.bcg.notClassified]).toEqual([7, 4, 2]);
    });

    it('throws on a row with no status', () => {
      expect(() => summarizeProductStatus([input('Active'), { ...input('Active'), status: null }])).toThrow(/Product status check failed/);
    });
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
