import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { clearSkuTrendCache, computeSkuTrend, computeSkuTrendSkus, SkuTrendQueryError } from '../skuTrend';

/**
 * SKU Trend (round 3): Active / Non Active / Dormant per period with the Product Status cards' rules. pool.query is mocked
 * by SQL text (the other measure tests' convention).
 *
 * Catalog (Majaal = 1, Tika = 3):
 *   A  Majaal|101  on hand today 5, first sale 2024
 *   B  Majaal|102  ARCHIVED; had 2 on hand at the end of Oct 2026, never sold
 *   C  Majaal|103  Unclassified (ProductExclusions.xlsx category)
 *   D  Tika|201    first sale 5 Oct 2026, no stock
 *   E  Majaal|104  never sold, never stocked
 *   F  variant 105 in both companies (one SKU): stock in Majaal, sales in Tika
 */
const row = (company: string, ck: number, pk: number, extra: Record<string, unknown> = {}) => ({
  ProductCompanyKey: `${company}|${pk}`, Company: company, CompanyKey: ck, ProductKey: pk, OdooProductID: pk, ProductName: `P${pk}`, SKU: `S${pk}`,
  IsActive: 1, OnHandQty: 0, OnHandValue: 0, ExcludedByProduct: 0, ExcludedByCategory: 0, ProductStatus: 'Active', FirstSaleDate: null, ValueYTD: 0, ...extra,
});
const CATALOG = [
  row('Majaal', 1, 101, { OnHandQty: 5, FirstSaleDate: '2024-01-01' }),
  row('Majaal', 1, 102, { IsActive: 0, ProductStatus: 'Dormant' }),
  row('Majaal', 1, 103, { ExcludedByCategory: 1, ProductStatus: 'Unclassified', OnHandQty: 9, FirstSaleDate: '2023-01-01' }),
  row('Tika', 3, 201, { FirstSaleDate: '2026-10-05' }),
  row('Majaal', 1, 104),
  row('Majaal', 1, 105, { OnHandQty: 6 }),
  row('Tika', 3, 105, { FirstSaleDate: '2026-10-10' }),
  row('Athena', 9, 900, { OnHandQty: 1 }),
];
const CLOSED_MONTH_ENDS = ['2025-11-30', '2025-12-31', '2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30',
  '2026-07-31', '2026-08-31', '2026-09-30', '2026-10-31'];
const SALES = [
  { p: '2026-09-01', k: 'Majaal|101', units: 2, value: 20, soldRows: 1 },
  { p: '2026-10-01', k: 'Majaal|101', units: 1, value: 10, soldRows: 1 },
  { p: '2026-10-01', k: 'Tika|201', units: 4, value: 400, soldRows: 1 },
  { p: '2026-10-01', k: 'Tika|105', units: 3, value: 30, soldRows: 1 },
  { p: '2026-10-01', k: 'Majaal|103', units: 9, value: 90, soldRows: 1 },
  { p: '2026-11-01', k: 'Majaal|101', units: 1, value: 10, soldRows: 1 },
  { p: '2026-08-01', k: 'Majaal|104', units: -1, value: -10, soldRows: 0 }, // a return only: not a sale
];
const stock = (d: string, company: number, product: number, qty: number) => ({ d, company_id: company, product_id: product, qty_on_hand: qty });
const STOCK = [
  ...CLOSED_MONTH_ENDS.map((d) => stock(d, 1, 999, 1)), // another product: marks every month end as loaded
  stock('2026-09-30', 1, 101, 0),
  stock('2026-10-31', 1, 101, 3), stock('2026-10-31', 1, 102, 2), stock('2026-10-31', 1, 105, 4), stock('2026-10-31', 1, 103, 9),
];

function makePool(opts: { stock?: typeof STOCK; noTable?: boolean; allowed?: string[]; version?: string } = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const missing = () => Object.assign(new Error("Table 'product_stock_period_end' doesn't exist"), { code: 'ER_NO_SUCH_TABLE' });
  const stockRows = opts.stock ?? STOCK;
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('FROM etl_sales_product_dashboard_meta')) return [[{ v: opts.version ?? '2026-11-16 08:00:00' }]];
    if (sql.includes('SELECT DISTINCT Company FROM v_sales_product_dashboard')) return [(opts.allowed ?? []).map((Company) => ({ Company }))];
    if (sql.includes('SELECT * FROM v_sales_product_dashboard')) return [CATALOG.filter((r) => !(params[0] as string[]).includes(r.Company))];
    if (sql.includes('FROM v_sales_product_daily')) return [SALES];
    if (sql.includes('product_stock_period_end')) {
      if (opts.noTable) throw missing();
      if (sql.includes('MAX(loaded_at)')) return [[{ v: '2026-11-16 07:00:00', n: stockRows.length }]];
      if (sql.includes('MIN(period_end_date)')) {
        const first = new Map<string, (typeof STOCK)[number]>();
        for (const r of stockRows) {
          const k = `${r.company_id}|${r.product_id}`;
          if (r.d <= String(params[0]) && (!first.has(k) || r.d < first.get(k)!.d)) first.set(k, r);
        }
        return [[...first.values()].map((r) => ({ product_id: r.product_id, company_id: r.company_id, first: r.d }))];
      }
      const dates = params[0] as string[];
      return [stockRows.filter((r) => dates.includes(r.d))];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  return { pool: { query } as unknown as Pool, calls };
}
const month = (q: { company?: string } = {}) => ({ granularity: 'month' as const, to: '2026-11-16', ...q });

beforeEach(() => clearSkuTrendCache());

describe('SKU Trend periods (lib/periods.ts)', () => {
  it('12 weeks (Saturday starts) / 12 months / 5 years, the last one in progress with today’s stock', async () => {
    const { pool } = makePool();
    const w = await computeSkuTrend(pool, { granularity: 'week', to: '2026-11-16' });
    expect(w.points).toHaveLength(12);
    expect(w.points.every((p) => new Date(`${p.start}T12:00:00Z`).getUTCDay() === 6)).toBe(true);
    expect(w.points[11]).toMatchObject({ start: '2026-11-14', inProgress: true, stockDate: '2026-11-16' });
    expect(w.points[10]).toMatchObject({ start: '2026-11-07', end: '2026-11-13', inProgress: false, stockDate: '2026-11-13' });
    const m = await computeSkuTrend(pool, month());
    expect(m.points[0].start).toBe('2025-12-01');
    expect(m.points.map((p) => p.stockDate).slice(-2)).toEqual(['2026-10-31', '2026-11-16']);
    const y = await computeSkuTrend(pool, { granularity: 'year', to: '2026-11-16' });
    expect(y.points.map((p) => [p.start, p.inProgress])).toEqual([['2022-01-01', false], ['2023-01-01', false], ['2024-01-01', false], ['2025-01-01', false], ['2026-01-01', true]]);
  });

  it('reads the stock of every closed period end in ONE query, never per period', async () => {
    const { pool, calls } = makePool();
    await computeSkuTrend(pool, month());
    const stockCalls = calls.filter((c) => c.sql.includes('WHERE period_end_date IN'));
    expect(stockCalls).toHaveLength(1);
    expect(stockCalls[0].params[0]).toEqual(CLOSED_MONTH_ENDS); // the period before the window too (Nov 2025)
    expect(calls.filter((c) => c.sql.includes('FROM v_sales_product_daily'))).toHaveLength(1);
  });
});

describe('SKU Trend statuses (the cards’ rules)', () => {
  it('a closed period: stock at its end + its sales; archived classified by sales / stock; Unclassified and not-yet-existing SKUs left out', async () => {
    const { pool } = makePool();
    const t = await computeSkuTrend(pool, month());
    const at = (start: string) => t.points.find((p) => p.start === start)!;
    // Oct: A sold + stock 3 = Active; F (one SKU) sold in Tika + stock 4 in Majaal = Active; B archived but 2 on hand =
    // Non Active; D sold, no stock = Non Active; C Unclassified out; E never sold / stocked: not counted yet
    expect(at('2026-10-01').counts).toEqual({ active: 2, nonActive: 2, dormant: 0, total: 4 });
    // Sep: only A existed (first sale 2024): sold, 0 on hand = Non Active
    expect(at('2026-09-01').counts).toEqual({ active: 0, nonActive: 1, dormant: 0, total: 1 });
    // Aug: A existed, no sale, no stock = Dormant (E's return is not a sale, and E did not exist yet)
    expect(at('2026-08-01').counts).toEqual({ active: 0, nonActive: 0, dormant: 1, total: 1 });
    for (const p of t.points) if (p.counts) expect(p.counts.active + p.counts.nonActive + p.counts.dormant).toBe(p.counts.total);
  });

  it('the period in progress = the cards: today’s On Hand, archived = Dormant, every SKU (Unclassified out)', async () => {
    const { pool } = makePool();
    const nov = (await computeSkuTrend(pool, month())).points[11];
    // A sold + 5 on hand = Active; F 6 on hand, no sale = Non Active; B archived, D / E nothing = Dormant
    expect(nov.counts).toEqual({ active: 1, nonActive: 1, dormant: 3, total: 5 });
    expect(nov.previous).toEqual({ active: 2, nonActive: 2, dormant: 0, total: 4 }); // Oct: the MoM change
  });

  it('Company filter: Tika only reads Tika’s rows; Athena is never on the Product pages', async () => {
    const { pool } = makePool();
    const tika = await computeSkuTrend(pool, month({ company: 'Tika' }));
    expect(tika.view).toBe('Tika');
    // Oct: D (sold, no stock) and Tika's F row (sold, no Tika stock) = Non Active
    expect(tika.points.find((p) => p.start === '2026-10-01')!.counts).toEqual({ active: 0, nonActive: 2, dormant: 0, total: 2 });
    const all = await computeSkuTrend(pool, month());
    expect(all.points[11].counts!.total).toBe(5); // never Athena's product 900
  });
});

describe('SKU Trend without stock history', () => {
  it('before migration 0079: nothing loaded -> stockLoaded false; the period in progress still has the cards’ counts', async () => {
    const { pool } = makePool({ noTable: true });
    const t = await computeSkuTrend(pool, month());
    expect(t.stockLoaded).toBe(false);
    expect(t.missingStockDates).toHaveLength(11);
    expect(t.points.slice(0, 11).every((p) => p.counts === null)).toBe(true);
    expect(t.points[11].counts).toEqual({ active: 1, nonActive: 1, dormant: 3, total: 5 });
  });

  it('a missed period end has no counts (never zeros); the others still show', async () => {
    const { pool } = makePool({ stock: STOCK.filter((r) => r.d !== '2026-06-30') });
    const t = await computeSkuTrend(pool, month());
    expect(t.stockLoaded).toBe(true);
    expect(t.missingStockDates).toEqual(['2026-06-30']);
    expect(t.points.find((p) => p.start === '2026-06-01')!.counts).toBeNull();
    expect(t.points.find((p) => p.start === '2026-07-01')!.previous).toBeNull();
  });
});

describe('SKU Trend drill-down and cache', () => {
  it('the SKUs of one segment: code, name, companies, units / LYD of the period, on hand at its end', async () => {
    const { pool } = makePool();
    const l = await computeSkuTrendSkus(pool, { ...month(), period: '2026-10-01', status: 'active' });
    expect(l.period).toEqual({ start: '2026-10-01', end: '2026-10-31', stockDate: '2026-10-31' });
    expect(l.skus.map((s) => [s.sku, s.companies, s.units, s.value, s.onHandQty])).toEqual([
      ['S105', ['Majaal', 'Tika'], 3, 30, 4], ['S101', ['Majaal'], 1, 10, 3],
    ]);
    const na = await computeSkuTrendSkus(pool, { ...month(), period: '2026-10-01', status: 'nonActive' });
    expect(na.skus.map((s) => [s.productName, s.archived])).toEqual([['P201', false], ['P102', true]]);
  });

  it('the total bar: every SKU of the period, each with its status (= the bar)', async () => {
    const { pool } = makePool();
    const all = await computeSkuTrendSkus(pool, { ...month(), period: '2026-10-01', status: 'all' });
    expect(all.status).toBe('all');
    expect(all.skus.map((s) => [s.productName, s.status])).toEqual([['P201', 'nonActive'], ['P105', 'active'], ['P101', 'active'], ['P102', 'nonActive']]);
    const t = await computeSkuTrend(pool, month());
    expect(all.skus).toHaveLength(t.points.find((p) => p.start === '2026-10-01')!.counts!.total);
  });

  it('refuses an unknown status or a period outside the window', async () => {
    const { pool } = makePool();
    await expect(computeSkuTrendSkus(pool, { ...month(), period: '2026-10-01', status: 'lost' })).rejects.toBeInstanceOf(SkuTrendQueryError);
    await expect(computeSkuTrendSkus(pool, { ...month(), period: '2026-10-01', status: 'unclassified' })).rejects.toBeInstanceOf(SkuTrendQueryError);
    await expect(computeSkuTrendSkus(pool, { ...month(), period: '2024-10-01', status: 'active' })).rejects.toBeInstanceOf(SkuTrendQueryError);
  });

  it('serves a repeat (and its drill-down) from memory; a new ETL build recomputes', async () => {
    const first = makePool();
    await computeSkuTrend(first.pool, month());
    await computeSkuTrendSkus(first.pool, { ...month(), period: '2026-10-01', status: 'dormant' });
    expect(first.calls.filter((c) => c.sql.includes('FROM v_sales_product_daily'))).toHaveLength(1);
    const rebuilt = makePool({ version: '2026-11-16 08:30:00' });
    await computeSkuTrend(rebuilt.pool, month());
    expect(rebuilt.calls.filter((c) => c.sql.includes('FROM v_sales_product_daily'))).toHaveLength(1);
  });
});
