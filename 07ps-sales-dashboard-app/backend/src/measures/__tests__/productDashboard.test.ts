import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { DateTime } from 'luxon';
import { computeProductDashboard, resolvePeriod } from '../productDashboard';

/** Mocks pool.query by SQL text (same convention as the other measure tests). */
function makePool(salesRows: unknown[], productRows: unknown[], meta: unknown[] = [{ AsOfDate: '2026-09-29', LookbackDays: 90, ConfigJson: '{"intercompany_customers":{"names":["x"]},"bcg":{"profit_threshold_pct":35}}' }]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('FROM fact_productsalesdaily')) return [salesRows];
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
    expect(salesCall.sql).not.toMatch(/AS lines/i);
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
});
