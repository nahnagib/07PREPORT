import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { DateTime } from 'luxon';
import { computeProductDashboard, publicThresholds, resolvePeriod, summarizeProductStatus, withoutProfit, type StatusInput } from '../productDashboard';
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
    if (sql.includes('SELECT DISTINCT Company FROM v_sales_product_dashboard')) {
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
  // one unit on hand by default (2026-11-15 rules: sold + stock = Active, stock only = Non Active, neither = Dormant)
  LifecycleSegment: 'Mature', ValueYTD: 0, QtyYTD: 0, ValueLYTD: 0, QtyLYTD: 0, OnHandQty: 1, OnHandValue: 10, ...extra,
});
const sale = (k: string, uom: string, value: number, qty: number, lines = 1, extra: Record<string, unknown> = {}) => ({
  k, uom, value, qty, lineCount: lines, costValue: 0, uncostedQty: qty, valuePrior: 0, qtyPrior: 0, icValue: 0,
  linesPrior: 0, ...extra,
});

/** One row of the period BCG query: product, value, qty, cost of the costed days, last sale date. `uncostedDays` > 0 =
 * some sales days without a standard cost; costed: false = no costed day at all. */
const win = (k: string, value: number, qty: number, cost: number, opts: { lastDate?: string; uncostedDays?: number; costed?: boolean; costedValue?: number; sold?: boolean } = {}) => ({
  k, company: k.split('|')[0], qty, value,
  costedValue: opts.costed === false ? null : (opts.costedValue ?? value), costedCost: opts.costed === false ? null : cost,
  incompleteDays: opts.uncostedDays ?? 0, costedRows: opts.costed === false ? 0 : 1, soldRows: opts.sold === false ? 0 : 1,
  lastDate: opts.lastDate ?? '2026-06-30',
});

describe('resolvePeriod (the Date filter; default Last 12 Months)', () => {
  const now = DateTime.fromISO('2026-11-14T10:00:00', { zone: 'Africa/Tripoli' });
  it('no dates: today - 12 months (same day) to today, both included; the prior period has the same length', () => {
    expect(resolvePeriod(undefined, undefined, now)).toEqual({
      from: '2025-11-14', to: '2026-11-14', days: 366, priorFrom: '2024-11-13', priorTo: '2025-11-13', isDefault: true, label: 'Last 12 Months',
    });
  });

  it('a custom range: its own dates (To capped at today), the same number of days just before, labelled as custom', () => {
    expect(resolvePeriod('2026-01-01', '2026-03-31', now)).toEqual({
      from: '2026-01-01', to: '2026-03-31', days: 90, priorFrom: '2025-10-03', priorTo: '2025-12-31', isDefault: false, label: 'Custom range',
    });
    expect(resolvePeriod('2026-10-01', '2027-01-01', now)).toMatchObject({ to: '2026-11-14', days: 45 });
    expect(resolvePeriod('2025-11-14', '2026-11-14', now)).toMatchObject({ isDefault: true, label: 'Last 12 Months' });
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

  it('the period and the prior period of the same length drive volume, revenue, class and movement', async () => {
    const { pool, calls } = makePool(
      [sale('Majaal|1', 'Unit', 900, 90, 1, { valuePrior: 400, qtyPrior: 40 }),
       sale('Majaal|1', 'm2', 100, 10, 1)],
      [product('Majaal|1', 'Majaal', { ValueYTD: 99999, QtyYTD: 9999, BcgClassYTD: 'Dogs', BcgMovement: 'Drop', ProductStatus: 'NonActive', IsActive: 1 })],
      META, [], [],
      [win('Majaal|1', 50000, 4000, 20000)], // company-wide: 4,000 units >= 3,500, GP 60% -> Stars
    );
    const out = await computeProductDashboard(pool, { filters: { segmentKeys: [1] } });
    // the period's own status / class / movement (the ETL's stored values are not used): +150% -> Improved
    expect(out.products[0]).toMatchObject({ value: 1000, volume: 100, valuePrior: 400, volumePrior: 40, productStatus: 'Active', bcgClass: 'Stars', bcgMovement: 'Improved' });
    const salesCall = calls.find((c) => c.sql.includes('SUM(CASE'))!;
    expect(salesCall.params).toContain('2025-11-14'); // last 12 months
    expect(salesCall.params).toContain('2024-11-13'); // the 366 days before
    expect(salesCall.params).toContain('2025-11-13');
    const bcgCall = calls.find((c) => c.sql.includes('AS fullyCosted'))!;
    expect(bcgCall.params.slice(0, 2)).toEqual(['2025-11-14', '2026-11-14']);
  });

  it('a custom range: the BCG volume threshold scales with its length (x days / 365)', async () => {
    const rows = [product('Majaal|1', 'Majaal', { IsActive: 1 }), product('Majaal|2', 'Majaal', { IsActive: 1 })];
    const windows = [win('Majaal|1', 10000, 900, 1000), win('Majaal|2', 10000, 800, 1000)]; // 90 days: threshold 3,500 x 90/365 = 863
    const { pool, calls } = makePool([], rows, META, [], [], windows);
    const out = await computeProductDashboard(pool, { fromDate: '2026-01-01', toDate: '2026-03-31' });
    expect(out.period).toMatchObject({ from: '2026-01-01', to: '2026-03-31', isDefault: false, label: 'Custom range' });
    expect(out.products.map((r) => r.bcgClass)).toEqual(['Stars', 'Strategic']);
    expect(calls.find((c) => c.sql.includes('AS fullyCosted'))!.params.slice(0, 2)).toEqual(['2026-01-01', '2026-03-31']);
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

  it('BCG: every Active + Non Active product in one of the 4 classes; no cost data = low GP% (Cash Cows / Dogs), flagged; no sales = Dogs, not flagged', async () => {
    const { pool } = makePool(
      [],
      [
        ...['1', '2', '4', '5', '8', '9'].map((i) => product(`Majaal|${i}`, 'Majaal', { IsActive: 1 })),
        product('Majaal|6', 'Majaal', { IsActive: 1 }), // stock, not sold in the period: Non Active -> Dogs (zero volume, no margin)
        product('Tika|7', 'Tika', { IsActive: 1 }),
        product('Majaal|10', 'Majaal', { ProductStatus: 'Dormant', IsActive: 0 }), // archived: never classified
      ],
      META, [], [],
      [
        win('Majaal|1', 7000, 3500, 4550, { lastDate: '2026-11-10' }), // volume = threshold -> High; GP 35% -> High -> Stars
        win('Majaal|2', 2000, 200, 1800, { uncostedDays: 5 }),          // some uncosted days: GP of the costed days 10% -> Dogs, flagged
        win('Majaal|4', 500, 50, 0, { costed: false }),                  // never costed: low GP -> Dogs, flagged
        win('Majaal|9', 90000, 9000, 0, { costed: false }),              // never costed, high volume -> Cash Cows, flagged
        win('Majaal|5', 900, 30, 300),                                   // low volume, GP 66.7% -> Strategic
        win('Tika|7', 30000, 24999, 1000),                               // under the Tika 25,000 -> Strategic
        win('Majaal|8', 0, 10, 80, { costedValue: 0 }),                  // zero revenue: GP undefined -> low -> Dogs, flagged
        win('Majaal|10', 9000, 9000, 1000),
      ],
    );
    const out = await computeProductDashboard(pool, { company: 'All' });
    const by = Object.fromEntries(out.products.map((r) => [r.productCompanyKey, r]));
    expect(by['Majaal|1']).toMatchObject({ productStatus: 'Active', bcgClass: 'Stars', bcgProfit: 2450, bcgVolume: 3500, missingCost: false, bcgDataAsOf: '2026-11-10' });
    expect(by['Majaal|2']).toMatchObject({ bcgClass: 'Dogs', bcgProfit: 200, missingCost: true });
    expect(by['Majaal|4']).toMatchObject({ bcgClass: 'Dogs', bcgProfit: null, bcgGrossProfitPct: null, missingCost: true });
    expect(by['Majaal|9']).toMatchObject({ bcgClass: 'Cash Cows', missingCost: true });
    expect(by['Majaal|5'].bcgClass).toBe('Strategic');
    expect(by['Majaal|6']).toMatchObject({ productStatus: 'NonActive', bcgClass: 'Dogs', bcgProfit: null, missingCost: false });
    expect(by['Tika|7'].bcgClass).toBe('Strategic');
    expect(by['Majaal|8']).toMatchObject({ bcgClass: 'Dogs', bcgGrossProfitPct: null, missingCost: true });
    expect(by['Majaal|10']).toBeUndefined(); // archived = Dormant: never listed, never classified (portfolio only, 2026-11-15)
    // the cards: 7 Active + 1 Non Active = Stars 1 + Cash Cows 1 + Strategic 2 + Dogs 4; 4 with missing cost
    expect(out.statusSummary?.active.count).toBe(7);
    expect(out.statusSummary?.nonActive.count).toBe(1);
    expect(out.statusSummary?.bcg.classes.map((c) => [c.key, c.count])).toEqual([['Stars', 1], ['Cash Cows', 1], ['Strategic', 2], ['Dogs', 4]]);
    expect(out.statusSummary?.bcg.missingCost).toBe(4);
    expect(out.statusSummary?.dormant.count).toBe(1);
  });

  it('the BCG thresholds never leave the server', async () => {
    const meta = [{ AsOfDate: '2026-11-11', LookbackDays: 90, ConfigJson: '{"bcg":{"movement_stable_band_pct":10,"volume_threshold":{"Majaal":3500},"profit_threshold_pct":35}}' }];
    const { pool } = makePool([], [product('Majaal|1', 'Majaal', { IsActive: 1 })], meta, [], [], [win('Majaal|1', 8000, 4000, 4000)]);
    const out = await computeProductDashboard(pool, { company: 'Majaal' });
    expect(out.thresholds.bcg).toEqual({ movement_stable_band_pct: 10 });
    expect(JSON.stringify(out)).not.toMatch(/3500|volume_threshold|profit_threshold/);
    expect(out.products[0].bcgClass).toBe('Stars'); // 4,000 >= 3,500 and GP 50%, applied server-side
    expect(publicThresholds({ bcg: { volume_threshold: { A: 1 }, profit_threshold_pct: 1 } })).toEqual({ bcg: {} });
  });

  it('without profit access every profit field is absent from the rows and the cards (withoutProfit)', async () => {
    const { pool } = makePool([sale('Majaal|1', 'Unit', 100, 10, 1, { costValue: 60, uncostedQty: 0 })], [product('Majaal|1', 'Majaal', { IsActive: 1 })], META, [], [],
      [win('Majaal|1', 100, 10, 60, { uncostedDays: 1 })]);
    const full = await computeProductDashboard(pool, {});
    expect(full.profitAccess).toBe(true);
    expect(full.products[0]).toMatchObject({ grossProfitPct: 40, bcgProfit: 40, bcgGrossProfitPct: 40, missingCost: true, bcgClass: 'Strategic' });
    const stripped = withoutProfit(full);
    expect(stripped.profitAccess).toBe(false);
    for (const key of ['grossProfitPct', 'bcgProfit', 'bcgGrossProfitPct', 'missingCost']) expect(stripped.products[0]).not.toHaveProperty(key);
    expect(stripped.products[0]).toMatchObject({ bcgClass: 'Strategic', value: 100, volume: 10 }); // the class and sales stay
    expect(stripped.statusSummary?.bcg).not.toHaveProperty('missingCost');
    expect(stripped.statusSummary?.bcg.classes.every((c) => !('profit' in c))).toBe(true);
    expect(JSON.stringify(stripped)).not.toMatch(/[Pp]rofit"|grossProfit|missingCost/);
  });

  describe('Total SKUs / Product Status cards (statusSummary)', () => {
    it('counts 60 category members once, including overlap and shared company rows, outside analytical rows', async () => {
      const packaging = Array.from({ length: 60 }, (_, i) => product(`Majaal|${i + 1}`, 'Majaal', {
        OdooProductID: i + 1, ExcludedByCategory: 1, ExcludedByProduct: i === 0 ? 1 : 0,
        OnProductPages: 0, ProductStatus: 'Unclassified',
      }));
      const shared = product('Tika|1', 'Tika', { OdooProductID: 1, ExcludedByCategory: 1, OnProductPages: 0 });
      const pending = product('Majaal|61', 'Majaal', { OdooProductID: 61, OnProductPages: 1 });
      const out = await computeProductDashboard(makePool([], [...packaging, shared, pending]).pool, {});
      expect(out.statusSummary).toMatchObject({ total: 61, unclassified: { count: 60 }, nonActive: { count: 1 } });
      expect(out.products.map((p) => p.productKey)).toHaveLength(1);
      expect(out.statusSummaryError).toBeNull();
    });

    const rows = [
      product('Majaal|1', 'Majaal', { ProductStatus: 'Active', IsActive: 1 }),
      product('Majaal|2', 'Majaal', { ProductStatus: 'Active', IsActive: 1, OnHandQty: 5, OnHandValue: 50 }), // not sold in the period
      product('Majaal|3', 'Majaal', { ProductStatus: 'NonActive', IsActive: 1, OnHandQty: 0 }), // no stock, no sales: Dormant
      product('Majaal|4', 'Majaal', { ProductStatus: 'Dormant', IsActive: 0, OnProductPages: 0 }),
      product('Majaal|5', 'Majaal', { ProductStatus: 'Unclassified', IsActive: 1, OnProductPages: 0 }),
      product('Majaal|6', 'Majaal', { ProductStatus: 'Active', IsActive: 1, OnProductPages: 0 }), // Products-sheet excluded: no product sales
      product('Tika|7', 'Tika', { ProductStatus: 'NonActive', IsActive: 1 }),
    ];
    const windows = [win('Majaal|1', 1000, 4000, 100), win('Tika|7', 70, 7, 0, { costed: false })];

    it('the period decides Active / Non Active; every product counted once; the pages list the portfolio only', async () => {
      const { pool } = makePool([], rows, META, [], [], windows);
      const out = await computeProductDashboard(pool, {});
      // 2026-11-15: Active + Non Active, whatever OnProductPages says (Majaal|6: off the ETL pages, not excluded, not archived,
      // stock but no sales = Non Active, so listed); the Dormant (3 no stock + no sales, 4 archived) and Unclassified (5) rows
      // only in the cards
      expect(out.products.map((p) => p.productCompanyKey)).toEqual(['Majaal|1', 'Majaal|2', 'Majaal|6', 'Tika|7']);
      expect(out.products.map((p) => p.productStatus).every((s) => s === 'Active' || s === 'NonActive')).toBe(true);
      // an off-page row has no ETL lifecycle / stock band: never sold, no stock
      const offPage = product('Majaal|12', 'Majaal', { IsActive: 1, OnProductPages: 0, LifecycleSegment: null, StockBand: null });
      const listed = await computeProductDashboard(makePool([], [offPage], META).pool, {});
      expect([listed.products[0].lifecycleSegment, listed.products[0].stockBand]).toEqual(['Never sold', 'NoStockNoSales']);
      expect(out.statusSummaryError).toBeNull();
      expect(out.statusSummary).toMatchObject({
        total: 7,
        active: { count: 2, units: 4007, value: 1070 },
        nonActive: { count: 2, withStock: 2, withSales: 0, zeroStock: 0, stockUnits: 6, stockValue: 60 },
        dormant: { count: 2, archived: 1, idle: 1 },
        unclassified: { count: 1 },
      });
      expect(out.statusSummary?.bcg.classes.find((c) => c.key === 'Stars')).toMatchObject({ count: 1, units: 4000, value: 1000, profit: 900 });
      expect(out.statusSummary?.bcg.classes.find((c) => c.key === 'Dogs')).toMatchObject({ count: 3, units: 7 }); // Tika|7 (no cost) + 2 unsold Non Active
    });

    it('status table (skuList, 2026-11-15): one row per SKU, the rows per status = the cards, with stock / rule / archived', async () => {
      const { pool } = makePool([], [...rows, product('Tika|5', 'Tika', { OdooProductID: 5, ProductStatus: 'Unclassified', ExcludedByCategory: 1, Category: 'All / Packaging', OnProductPages: 0 })],
        META, [], [], windows);
      const out = await computeProductDashboard(pool, { includeSkuList: true });
      const skus = out.skuList ?? [];
      const count = (status: string) => skus.filter((r) => r.status === status).length;
      const s = out.statusSummary!;
      expect(skus).toHaveLength(s.total);
      expect([count('Active'), count('NonActive'), count('Dormant'), count('Unclassified')])
        .toEqual([s.active.count, s.nonActive.count, s.dormant.count, s.unclassified.count]);
      const nonActive = skus.filter((r) => r.status === 'NonActive');
      expect(nonActive.filter((r) => r.withStock)).toHaveLength(s.nonActive.withStock);
      expect(nonActive.filter((r) => !r.withStock)).toHaveLength(s.nonActive.zeroStock);
      expect(skus.find((r) => r.odooProductId === '4')).toMatchObject({ status: 'Dormant', archived: true, archivedDate: null });
      // Majaal|5 and Tika|5 are one SKU (Odoo variant 5): one row, both companies, the Majaal ETL status wins
      expect(skus.filter((r) => r.odooProductId === '5')).toHaveLength(1);
      expect(skus.find((r) => r.odooProductId === '5')).toMatchObject({ status: 'Unclassified', companies: ['Majaal', 'Tika'] });
      expect(skus.find((r) => r.odooProductId === '1')).toMatchObject({ status: 'Active', bcgClass: 'Stars', companies: ['Majaal'] });
      // without the option the response carries no table
      expect((await computeProductDashboard(makePool([], rows, META, [], [], windows).pool, {})).skuList).toBeUndefined();
    });

    it('status table: the Unclassified row names the ProductExclusions rule; profit stripped without profit access', async () => {
      const { pool } = makePool([sale('Majaal|9', 'Unit', 100, 4, 1, { costValue: 60, uncostedQty: 0 })], [
        product('Majaal|8', 'Majaal', { OdooProductID: 8, ProductStatus: 'Unclassified', ExcludedByProduct: 1, OnProductPages: 0 }),
        product('Majaal|10', 'Majaal', { OdooProductID: 10, ProductStatus: 'Unclassified', ExcludedByCategory: 1, Category: 'All / Samples', OnProductPages: 0 }),
        product('Majaal|9', 'Majaal', { OdooProductID: 9, IsActive: 1 }),
      ], META, [], [], [win('Majaal|9', 100, 4, 60)]);
      const out = await computeProductDashboard(pool, { includeSkuList: true });
      const by = new Map((out.skuList ?? []).map((r) => [r.odooProductId, r]));
      expect(by.get('8')?.exclusionRule).toMatch(/Products sheet/);
      expect(by.get('10')?.exclusionRule).toBe('ProductExclusions.xlsx · Categories sheet · All / Samples');
      expect(by.get('9')).toMatchObject({ status: 'Active', units: 4, value: 100, profit: 40, grossProfitPct: 40, exclusionRule: null });
      const stripped = withoutProfit(out);
      expect(JSON.stringify(stripped.skuList)).not.toMatch(/"profit"|grossProfitPct/);
    });

    it('company view: that company only', async () => {
      const { pool } = makePool([], rows, META, [], [], windows);
      const out = await computeProductDashboard(pool, { company: 'Tika' });
      expect(out.statusSummary).toMatchObject({ total: 1, active: { count: 1 } });
    });

    it('before migration 0073 (no ProductStatus): archived = Dormant, the rest by the period', async () => {
      const { pool } = makePool([], [product('Majaal|1', 'Majaal', { IsActive: 1 }), product('Majaal|2', 'Majaal', { IsActive: 0 })], META, [], [], [win('Majaal|1', 10, 1, 5)]);
      const out = await computeProductDashboard(pool, {});
      expect(out.statusSummary).toMatchObject({ total: 2, active: { count: 1 }, dormant: { count: 1 } });
    });

    it('a row without a known status fails the check (reported, never silently miscounted)', async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const out = await computeProductDashboard(makePool([], [product('Majaal|1', 'Majaal', { ProductStatus: 'Weird', IsActive: 1 })]).pool, {});
      errors.mockRestore();
      // an unknown ETL status is treated by the period (NonActive): the check passes
      expect(out.statusSummary).toMatchObject({ total: 1, nonActive: { count: 1 } });
    });
  });

  describe('summarizeProductStatus reconciliation', () => {
    const input = (status: string | null, bcg: StatusInput['bcg'] = null, over: Partial<StatusInput> = {}): StatusInput => ({ status, onHandQty: 0, onHandValue: 0, bcg, ...over });
    const cls = (bcgClass: 'Stars' | 'Cash Cows' | 'Strategic' | 'Dogs', missingCost = false) => ({ bcgClass, volume: 10, value: 100, profit: missingCost ? null : 5, missingCost });

    it('Total = Unclassified + Dormant + Active + Non Active, and Stars + Cash Cows + Strategic + Dogs = Active + Non Active', () => {
      const out = summarizeProductStatus([
        input('Active', cls('Stars')), input('Active', cls('Dogs', true)), input('Active', cls('Cash Cows', true)), input('Active', cls('Strategic')),
        input('NonActive', cls('Dogs'), { onHandQty: 3, onHandValue: 30 }), input('NonActive', cls('Strategic'), { sold: true }),
        input('Dormant', null, { archived: true, onHandQty: 2, onHandValue: 8 }), input('Dormant', null, { archived: false }),
        input('Unclassified', null, { onHandQty: 5, onHandValue: 50 }),
      ]);
      expect(out.total).toBe(out.active.count + out.nonActive.count + out.dormant.count + out.unclassified.count);
      expect(out.bcg.classes.reduce((t, c) => t + c.count, 0)).toBe(out.active.count + out.nonActive.count);
      expect([out.total, out.active.count, out.bcg.missingCost]).toEqual([9, 4, 2]);
      expect(out.nonActive).toMatchObject({ count: 2, withStock: 1, withSales: 1 });
      expect(out.dormant).toEqual({ count: 2, archived: 1, idle: 1, onHandQty: 2, onHandValue: 8 });
      // every status card: the On Hand quantity and value of its SKUs (2026-11-16)
      expect([out.nonActive.onHandQty, out.nonActive.onHandValue, out.unclassified.onHandQty, out.unclassified.onHandValue]).toEqual([3, 30, 5, 50]);
      expect([out.active.onHandQty, out.active.onHandValue]).toEqual([0, 0]);
      expect(out.bcg).not.toHaveProperty('notClassified');
    });

    it('throws on a row with no status, or an Active product without a class', () => {
      expect(() => summarizeProductStatus([input(null)])).toThrow(/Product status check failed/);
      expect(() => summarizeProductStatus([input('Active')])).toThrow(/has no BCG class/);
      expect(() => summarizeProductStatus([input('NonActive')])).toThrow(/has no BCG class/);
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
