import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { DateTime } from 'luxon';
import { computeProductDashboard, resolvePeriod } from '../productDashboard';

/** Mocks pool.query by SQL text (same convention as the other measure tests). */
const META = [{ AsOfDate: '2026-09-29', LookbackDays: 90, ConfigJson: '{"intercompany_customers":{"names":["x"]},"bcg":{"profit_threshold_pct":35}}' }];

/** groupRows = null -> dim_sales_product_group does not exist yet (per-company rows are served). */
function makePool(salesRows: unknown[], productRows: unknown[], meta: unknown[] = META, groupRows: unknown[] | null = null) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('SELECT DISTINCT Company FROM v_sales_product_daily')) {
      const keys = (params[0] as number[]) ?? [];
      return [[...(keys.includes(1) ? [{ Company: 'Majaal' }] : []), ...(keys.includes(2) ? [{ Company: 'Tika' }] : [])]];
    }
    if (sql.includes('FROM v_sales_product_daily')) return [salesRows];
    if (sql.includes('FROM dim_sales_product_group')) {
      if (groupRows === null) throw Object.assign(new Error('no table'), { code: 'ER_NO_SUCH_TABLE' });
      return [groupRows];
    }
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
  k, uom, value, qty, lineCount: lines, costValue: 0, uncostedQty: qty, valuePrior: 0, qtyPrior: 0, icValue: 0, ...extra,
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
  it('keeps zero-sales products, never sums quantities across UoMs, and totals straight from the sales rows', async () => {
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
    expect(byKey['Majaal|102'].volume).toBeNull(); // two units of measure: no single volume
    expect(byKey['Majaal|102'].velocity).toBeNull();
    expect(byKey['Majaal|102'].volumeByUom).toEqual([{ uom: 'm2', qty: 10 }, { uom: 'UNIT', qty: 5 }]);
    expect(byKey['Majaal|103']).toMatchObject({ value: 0, volume: 0, lines: 0 });
    expect(byKey['Majaal|101']).toMatchObject({ productKey: '101', brand: 'Unassigned' }); // Odoo product id; empty Odoo brand
    expect(out.totals.value).toBe(1557);
    expect(out.totals.volumeByUom).toEqual([{ uom: 'UNIT', qty: 108 }, { uom: 'm2', qty: 10 }]);
    expect(out.thresholds).not.toHaveProperty('intercompany_customers');
  });

  it('applies the scope clause to the daily table and then hides products with no sales in scope', async () => {
    const { pool, calls } = makePool([sale('Majaal|101', 'UNIT', 10, 1)], [product('Majaal|101', 'Majaal'), product('Majaal|102', 'Majaal')]);

    const out = await computeProductDashboard(pool, { fromDate: '2026-01-01', toDate: '2026-01-31', filters: { salespersonKeys: [42] } });

    const salesCall = calls.find((c) => c.sql.includes('v_sales_product_daily'))!;
    expect(salesCall.sql).toContain('d.SalespersonKey IN (?)');
    // MySQL reserved words (LINES, VALUE is fine) must never be used as bare aliases.
    expect(salesCall.sql).not.toMatch(/\bAS lines\b/i);
    expect(salesCall.params[salesCall.params.length - 1]).toBe(42);
    expect(out.products.map((p) => p.productCompanyKey)).toEqual(['Majaal|101']);
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

  describe('same product in both companies', () => {
    // Odoo products 301 (Majaal) and 302 (Tika) are variants of template 3001: one BMH row T|3001. Never grouped by name.
    const products = [
      product('Majaal|301', 'Majaal', { ProductGroupKey: 'T|3001', ProductName: 'Cemair', StockQty: 60 }),
      product('Tika|302', 'Tika', { ProductGroupKey: 'T|3001', ProductName: 'Cemair', StockQty: 120 }),
      product('Majaal|303', 'Majaal', { ProductGroupKey: 'T|3003' }),
      product('Tika|201', 'Tika', { ProductGroupKey: 'T|2001' }),
    ];
    const groups = [
      product('T|3001', 'Majaal + Tika', { ProductGroupKey: 'T|3001', ProductName: 'Cemair', StockQty: 180, DaysOfInventory: 180, BcgClassYTD: 'Strategic' }),
      product('T|3003', 'Majaal', { ProductGroupKey: 'T|3003' }),
      product('T|2001', 'Tika', { ProductGroupKey: 'T|2001' }),
    ];
    const sales = [
      sale('Majaal|301', 'BAG', 300, 100, 3, { costValue: 100, uncostedQty: 0, valuePrior: 40 }),
      sale('Tika|302', 'BAG', 700, 90, 5, { costValue: 180, uncostedQty: 0, valuePrior: 60 }),
      sale('Majaal|303', 'UNIT', 5, 1, 1, { costValue: 1, uncostedQty: 0 }),
      sale('Tika|201', 'UNIT', 5, 1, 1),
    ];

    it('BMH view: one row whose value and volume are exactly Majaal + Tika; ratios recomputed from the sums', async () => {
      const { pool } = makePool(sales, products, META, groups);
      const out = await computeProductDashboard(pool, { fromDate: '2026-01-01', toDate: '2026-01-10' });
      expect(out.view).toBe('BMH');
      const cemair = out.products.filter((p) => p.productName === 'Cemair');
      expect(cemair).toHaveLength(1);
      const row = cemair[0];
      expect(row).toMatchObject({ productCompanyKey: 'T|3001', company: 'Majaal + Tika', companies: ['Majaal', 'Tika'] });
      expect(row.value).toBe(300 + 700);
      expect(row.volume).toBe(100 + 90);
      expect(row.lines).toBe(8);
      expect(row.valuePrior).toBe(100);
      expect(row.velocity).toBeCloseTo(190 / 10); // combined volume / days
      expect(row.grossProfitPct).toBeCloseTo(72); // (1000 - 280) / 1000, not the 70.48 average of 66.67 and 74.29
      expect(row.avgUnitPrice).toBeCloseTo(1000 / 190);
      // snapshot metrics come from the ETL's combined group row
      expect(row).toMatchObject({ stockQty: 180, daysOfInventory: 180, bcgClassYTD: 'Strategic' });
      expect(row.parts.map((x) => [x.company, x.value])).toEqual([['Majaal', 300], ['Tika', 700]]);
      // the grand total is unchanged by grouping
      expect(out.products.reduce((t, p) => t + p.value, 0)).toBe(out.totals.value);
      expect(out.totals.value).toBe(1010);
    });

    it('company view: only that company, from the daily table filtered by Company', async () => {
      const { pool, calls } = makePool(sales.filter((r) => r.k.startsWith('Tika|')), products, META, groups);
      const out = await computeProductDashboard(pool, { fromDate: '2026-01-01', toDate: '2026-01-10', company: 'TIKA' });
      expect(out.view).toBe('Tika');
      const salesCall = calls.find((c) => c.sql.includes('v_sales_product_daily'))!;
      expect(salesCall.sql).toContain('d.Company = ?');
      expect(salesCall.params[salesCall.params.length - 1]).toBe('Tika');
      expect(calls.some((c) => c.sql.includes('dim_sales_product_group'))).toBe(false);
      expect(out.products.map((p) => p.productCompanyKey).sort()).toEqual(['Tika|201', 'Tika|302']);
      expect(out.products.find((p) => p.productCompanyKey === 'Tika|302')).toMatchObject({ value: 700, volume: 90, companies: ['Tika'] });
      expect(out.totals.value).toBe(705);
    });

    it('a role limited to one company gets that company view, never the combined BMH row', async () => {
      const { pool, calls } = makePool(sales.filter((r) => r.k.startsWith('Majaal|')), products, META, groups);
      const out = await computeProductDashboard(pool, { filters: { companyKeys: [1] } });
      expect(out.view).toBe('Majaal');
      expect(calls.some((c) => c.sql.includes('dim_sales_product_group'))).toBe(false);
      const salesCall = calls.find((c) => c.sql.includes('SUM(CASE'))!;
      expect(salesCall.sql).toContain('d.CompanyKey IN (?)');
      expect(out.products.every((p) => p.company === 'Majaal')).toBe(true);
      expect(out.products.find((p) => p.productName === 'Cemair')).toMatchObject({ value: 300, stockQty: 60 });
      await expect(computeProductDashboard(pool, { company: 'Tika', filters: { companyKeys: [1] } })).rejects.toThrow(/outside/);
    });
  });
});
