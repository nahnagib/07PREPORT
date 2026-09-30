import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { DateTime } from 'luxon';
import { computeProductDashboard, resolvePeriod } from '../productDashboard';

/** Mocks pool.query by SQL text (same convention as the other measure tests). */
const META = [{ AsOfDate: '2026-09-29', LookbackDays: 90, ConfigJson: '{"intercompany_customers":{"names":["x"]},"bcg":{"profit_threshold_pct":35}}' }];

/** groupRows = null -> dim_productdashboardgroup does not exist yet (per-company rows are served). */
function makePool(salesRows: unknown[], productRows: unknown[], meta: unknown[] = META, groupRows: unknown[] | null = null) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('SELECT DISTINCT Company FROM fact_productsalesdaily')) {
      const keys = (params[0] as number[]) ?? [];
      return [[...(keys.includes(1) ? [{ Company: 'Majaal' }] : []), ...(keys.includes(2) ? [{ Company: 'Tika' }] : [])]];
    }
    if (sql.includes('FROM fact_productsalesdaily')) return [salesRows];
    if (sql.includes('FROM dim_productdashboardgroup')) {
      if (groupRows === null) throw Object.assign(new Error('no table'), { code: 'ER_NO_SUCH_TABLE' });
      return [groupRows];
    }
    if (sql.includes('FROM dim_productdashboard')) return [productRows];
    if (sql.includes('FROM productdashboard_meta')) return [meta];
    throw new Error(`unexpected SQL: ${sql}`);
  });
  return { pool: { query } as unknown as Pool, calls };
}

const product = (key: string, company: string, extra: Record<string, unknown> = {}) => ({
  ProductMatchKey: key, ProductKey: key, Company: company, ProductName: key, IsMapped: 1, StockQty: 0, StockValue: 0,
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
        sale('MAJAAL|A', 'UNIT', 1000, 100),
        sale('MAJAAL|B', 'm2', 300, 10),
        sale('MAJAAL|B', 'UNIT', 200, 5),
        sale('TIKA|X', 'UNIT', 50, 2), // unmapped (IsMapped 0)
        sale('TIKA|ORPHAN', 'UNIT', 7, 1), // sold, but missing from the product table -> still Unmapped
      ],
      [product('MAJAAL|A', 'Majaal'), product('MAJAAL|B', 'Majaal'), product('MAJAAL|ZERO', 'Majaal'), product('TIKA|X', 'Tika', { IsMapped: 0 })],
    );

    const out = await computeProductDashboard(pool, { fromDate: '2026-09-01', toDate: '2026-09-10' });
    const byKey = Object.fromEntries(out.products.map((p) => [p.productMatchKey, p]));

    expect(out.period.days).toBe(10);
    expect(byKey['MAJAAL|A']).toMatchObject({ value: 1000, volume: 100, uom: 'UNIT', velocity: 10 });
    expect(byKey['MAJAAL|B'].volume).toBeNull(); // two units of measure: no single volume
    expect(byKey['MAJAAL|B'].velocity).toBeNull();
    expect(byKey['MAJAAL|B'].volumeByUom).toEqual([{ uom: 'm2', qty: 10 }, { uom: 'UNIT', qty: 5 }]);
    expect(byKey['MAJAAL|ZERO']).toMatchObject({ value: 0, volume: 0, lines: 0 });
    expect(out.unmapped).toMatchObject({ value: 57, lines: 2, products: 2 });
    expect(out.totals.value).toBe(1557);
    expect(out.totals.volumeByUom).toEqual([{ uom: 'UNIT', qty: 108 }, { uom: 'm2', qty: 10 }]);
    expect(out.thresholds).not.toHaveProperty('intercompany_customers');
  });

  it('applies the scope clause to the daily table and then hides products with no sales in scope', async () => {
    const { pool, calls } = makePool([sale('MAJAAL|A', 'UNIT', 10, 1)], [product('MAJAAL|A', 'Majaal'), product('MAJAAL|B', 'Majaal')]);

    const out = await computeProductDashboard(pool, { fromDate: '2026-01-01', toDate: '2026-01-31', filters: { salespersonKeys: [42] } });

    const salesCall = calls.find((c) => c.sql.includes('fact_productsalesdaily'))!;
    expect(salesCall.sql).toContain('d.SalespersonKey IN (?)');
    // MySQL reserved words (LINES, VALUE is fine) must never be used as bare aliases.
    expect(salesCall.sql).not.toMatch(/\bAS lines\b/i);
    expect(salesCall.params[salesCall.params.length - 1]).toBe(42);
    expect(out.products.map((p) => p.productMatchKey)).toEqual(['MAJAAL|A']);
  });

  it('reports GP% only when every line in the period has a cost', async () => {
    const { pool } = makePool(
      [sale('MAJAAL|A', 'UNIT', 100, 10, 1, { costValue: 60, uncostedQty: 0 }), sale('MAJAAL|B', 'UNIT', 100, 10, 1, { costValue: 60, uncostedQty: 4 })],
      [product('MAJAAL|A', 'Majaal'), product('MAJAAL|B', 'Majaal')],
    );
    const out = await computeProductDashboard(pool, {});
    const byKey = Object.fromEntries(out.products.map((p) => [p.productMatchKey, p]));
    expect(byKey['MAJAAL|A'].grossProfitPct).toBeCloseTo(40);
    expect(byKey['MAJAAL|B'].grossProfitPct).toBeNull();
  });

  describe('same product in both companies', () => {
    // Majaal "Cemair" (MAJAAL|CEMAIR) and Tika "Cem Air" (TIKA|CEM AIR) share the group G|CEMAIR.
    const products = [
      product('MAJAAL|CEMAIR', 'Majaal', { ProductGroupKey: 'G|CEMAIR', ProductName: 'Cemair', StockQty: 60 }),
      product('TIKA|CEM AIR', 'Tika', { ProductGroupKey: 'G|CEMAIR', ProductName: 'Cemair', StockQty: 120 }),
      product('MAJAAL|OTHER', 'Majaal', { ProductGroupKey: 'G|OTHER' }),
      product('TIKA|X', 'Tika', { IsMapped: 0, ProductGroupKey: 'TIKA|X' }),
    ];
    const groups = [
      product('G|CEMAIR', 'Majaal + Tika', { ProductGroupKey: 'G|CEMAIR', ProductName: 'Cemair', StockQty: 180, DaysOfInventory: 180, BcgClassYTD: 'Strategic' }),
      product('G|OTHER', 'Majaal', { ProductGroupKey: 'G|OTHER' }),
      product('TIKA|X', 'Tika', { IsMapped: 0, ProductGroupKey: 'TIKA|X' }),
    ];
    const sales = [
      sale('MAJAAL|CEMAIR', 'BAG', 300, 100, 3, { costValue: 100, uncostedQty: 0, valuePrior: 40 }),
      sale('TIKA|CEM AIR', 'BAG', 700, 90, 5, { costValue: 180, uncostedQty: 0, valuePrior: 60 }),
      sale('MAJAAL|OTHER', 'UNIT', 5, 1, 1, { costValue: 1, uncostedQty: 0 }),
      sale('TIKA|X', 'UNIT', 5, 1, 1),
    ];

    it('BMH view: one row whose value and volume are exactly Majaal + Tika; ratios recomputed from the sums', async () => {
      const { pool } = makePool(sales, products, META, groups);
      const out = await computeProductDashboard(pool, { fromDate: '2026-01-01', toDate: '2026-01-10' });
      expect(out.view).toBe('BMH');
      const cemair = out.products.filter((p) => p.productName === 'Cemair');
      expect(cemair).toHaveLength(1);
      const row = cemair[0];
      expect(row).toMatchObject({ productMatchKey: 'G|CEMAIR', company: 'Majaal + Tika', companies: ['Majaal', 'Tika'] });
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
      expect(out.unmapped).toMatchObject({ value: 5, products: 1 });
    });

    it('company view: only that company, from the daily table filtered by Company', async () => {
      const { pool, calls } = makePool(sales.filter((r) => r.k.startsWith('TIKA')), products, META, groups);
      const out = await computeProductDashboard(pool, { fromDate: '2026-01-01', toDate: '2026-01-10', company: 'TIKA' });
      expect(out.view).toBe('Tika');
      const salesCall = calls.find((c) => c.sql.includes('fact_productsalesdaily'))!;
      expect(salesCall.sql).toContain('d.Company = ?');
      expect(salesCall.params[salesCall.params.length - 1]).toBe('Tika');
      expect(calls.some((c) => c.sql.includes('dim_productdashboardgroup'))).toBe(false);
      expect(out.products.map((p) => p.productMatchKey).sort()).toEqual(['TIKA|CEM AIR', 'TIKA|X']);
      expect(out.products.find((p) => p.productMatchKey === 'TIKA|CEM AIR')).toMatchObject({ value: 700, volume: 90, companies: ['Tika'] });
      expect(out.totals.value).toBe(705);
    });

    it('a role limited to one company gets that company view, never the combined BMH row', async () => {
      const { pool, calls } = makePool(sales.filter((r) => r.k.startsWith('MAJAAL')), products, META, groups);
      const out = await computeProductDashboard(pool, { filters: { companyKeys: [1] } });
      expect(out.view).toBe('Majaal');
      expect(calls.some((c) => c.sql.includes('dim_productdashboardgroup'))).toBe(false);
      const salesCall = calls.find((c) => c.sql.includes('SUM(CASE'))!;
      expect(salesCall.sql).toContain('d.CompanyKey IN (?)');
      expect(out.products.every((p) => p.company === 'Majaal')).toBe(true);
      expect(out.products.find((p) => p.productName === 'Cemair')).toMatchObject({ value: 300, stockQty: 60 });
      await expect(computeProductDashboard(pool, { company: 'Tika', filters: { companyKeys: [1] } })).rejects.toThrow(/outside/);
    });
  });
});
