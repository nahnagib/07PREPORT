/**
 * SKU Trend (Product Portfolio page, 2026-11-16, round 3): Active / Non Active / Dormant SKUs per Weekly / Monthly / Yearly
 * period, with the Product Status cards' own rules (measures/productPortfolio.ts + combineSkuStatus in productDashboard.ts):
 *   Active     = sales in the period AND stock on hand > 0
 *   Non Active = sales but no stock, OR stock but no sales
 *   Dormant    = archived, OR no stock and no sales
 *   Unclassified (ProductExclusions.xlsx rules) is left out of the chart.
 *
 * Periods: lib/periods.ts (12 weeks Sat–Fri / 12 months / 5 years ending with the period of the To Date), plus the period
 * before the window (the first column's change).
 *   Sales of a period  v_sales_product_daily, a day with quantity > 0 (the cards' "sold", fetchBcgPeriod).
 *   Stock of a period  closed periods: on hand at the period end, product_stock_period_end (migration 0079; backfilled once
 *                      from Odoo valuation layers, then kept by the ETL at each period end). The CURRENT period: today's
 *                      On Hand (v_sales_product_dashboard.OnHandQty), exactly the cards' input -- so with the Date filter on
 *                      the same dates, the last column equals the cards (the API test checks it).
 * History rules (Odoo's data here has no archive date and no creation date):
 *   - a SKU archived today is Dormant only in periods with no sales and no stock; with sales or stock it is classified by
 *     them (the current period follows the cards: archived = Dormant);
 *   - a past period counts only SKUs that existed by its end: a first sale or a stock row on or before it (else a product
 *     created in 2026 would be "Dormant" in 2022).
 * A closed period without any stock row (the backfill not run yet, or a missed period end) has no counts (null).
 * Queries: a fixed 5 (catalog, sales of every period, stock at every period end, first stock dates, data version) whatever
 * the number of periods; the status rule runs in memory with the cards' functions. Cached per data version.
 */
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { EXCLUDED_COMPANIES, combineSkuStatus, groupBySku, resolveCompanyView, type ProductDashboardView, type StatusInput } from './productDashboard';
import { isArchivedRow, productStatusOf } from './productPortfolio';
import { addDaysIso } from '../lib/businessWeek';
import { periodBucketSql, periodWindow, shiftPeriod, type PeriodGranularity } from '../lib/periods';
import { odooConfiguredBaseUrl, odooFormUrl } from '../lib/odooLinks';

export const SKU_TREND_STATUSES = ['active', 'nonActive', 'dormant'] as const;
export type SkuTrendStatus = (typeof SKU_TREND_STATUSES)[number];
const STATUS_KEY: Record<string, SkuTrendStatus> = { Active: 'active', NonActive: 'nonActive', Dormant: 'dormant' };

export class SkuTrendQueryError extends Error {
  readonly status = 400;
}

export interface SkuTrendCounts {
  active: number;
  nonActive: number;
  dormant: number;
  total: number;
}

export interface SkuTrendPoint {
  start: string;
  end: string;
  inProgress: boolean;
  /** the day the stock is read: the period end, or the To Date for the period in progress (live On Hand) */
  stockDate: string;
  /** null = no stock rows for this period end (not loaded) */
  counts: SkuTrendCounts | null;
  /** the period before (WoW / MoM / YoY change); null when it has no counts */
  previous: SkuTrendCounts | null;
}

export interface SkuTrend {
  granularity: PeriodGranularity;
  view: ProductDashboardView;
  from: string;
  to: string;
  points: SkuTrendPoint[];
  /** at least one closed period of the window has stock rows; false = show "Stock history not loaded yet" */
  stockLoaded: boolean;
  /** closed period ends of the window with no stock row */
  missingStockDates: string[];
}

export interface SkuTrendSku {
  odooProductId: string;
  sku: string | null;
  productName: string;
  companies: string[];
  /** units and LYD sold in the period */
  units: number;
  value: number;
  /** on hand at the period end (the To Date for the period in progress) */
  onHandQty: number;
  archived: boolean;
  /** the SKU's status in that period */
  status: SkuTrendStatus;
  odooUrl: string | null;
}

/** The drill-down's selection: one status (a line point) or every SKU of the period (the total bar). */
export type SkuTrendSelection = SkuTrendStatus | 'all';

export interface SkuTrendSkuList {
  granularity: PeriodGranularity;
  view: ProductDashboardView;
  status: SkuTrendSelection;
  period: { start: string; end: string; stockDate: string };
  skus: SkuTrendSku[];
}

export interface SkuTrendQuery {
  granularity: PeriodGranularity;
  /** the anchor, yyyy-mm-dd (the page's To Date) */
  to: string;
  company?: string;
  /** role data scope (resolveScopedFilters): only its companies are used, like the cards */
  filters?: { companyKeys?: number[] };
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const iso = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};
const stockKey = (companyKey: unknown, productKey: unknown) => `${num(companyKey)}|${num(productKey)}`;

interface PeriodDef {
  start: string;
  end: string;
  inProgress: boolean;
  stockDate: string;
  /** false = the period before the window (only its counts are needed) */
  shown: boolean;
}

interface SkuState {
  id: string;
  parts: any[];
  status: SkuTrendStatus;
  onHandQty: number;
  units: number;
  value: number;
}

interface Computed {
  trend: SkuTrend;
  skus: Map<string, SkuState[]>;
}

/** A query on product_stock_period_end before migration 0079 is applied: no rows (the trend says "not loaded yet"). */
async function orEmpty<T>(run: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if ((err as { code?: string }).code === 'ER_NO_SUCH_TABLE') return empty;
    throw err;
  }
}

/** Every number of the trend for one query: the catalog, the sales and the stock read once, then the cards' rule per period. */
async function compute(pool: Pool, q: SkuTrendQuery): Promise<Computed> {
  const w = periodWindow(q.granularity, q.to);
  const periods: PeriodDef[] = [
    { start: w.previous.start, end: w.previous.end, inProgress: false, stockDate: w.previous.end, shown: false },
    ...w.periods.map((p) => ({ start: p.start, end: p.end, inProgress: p.inProgress, stockDate: p.inProgress ? w.to : p.end, shown: true })),
  ];
  const closedEnds = periods.filter((p) => !p.inProgress).map((p) => p.end);
  const { view, allowedCompanies } = await resolveCompanyView(pool, q.company, q.filters?.companyKeys ?? []);

  const [[catalog], [sales], stockRows, firstRows] = await Promise.all([
    pool.query<RowDataPacket[]>('SELECT * FROM v_sales_product_dashboard WHERE Company NOT IN (?)', [EXCLUDED_COMPANIES]),
    pool.query<RowDataPacket[]>(
      `SELECT d.ProductCompanyKey AS k, ${periodBucketSql(q.granularity, 'd.OrderDate')} AS p, SUM(d.Qty) AS units, SUM(d.Value) AS value,
              SUM(CASE WHEN d.Qty > 0 THEN 1 ELSE 0 END) AS soldRows
       FROM v_sales_product_daily d
       WHERE d.OrderDate >= ? AND d.OrderDate < ? AND d.Lines > 0 AND d.Company NOT IN (?)
       GROUP BY d.ProductCompanyKey, p`,
      [w.previous.start, addDaysIso(w.to, 1), EXCLUDED_COMPANIES],
    ),
    orEmpty(async () => (await pool.query<RowDataPacket[]>(
      `SELECT product_id, company_id, DATE_FORMAT(period_end_date, '%Y-%m-%d') AS d, qty_on_hand
       FROM product_stock_period_end WHERE period_end_date IN (?)`, [closedEnds]))[0], [] as RowDataPacket[]),
    orEmpty(async () => (await pool.query<RowDataPacket[]>(
      `SELECT product_id, company_id, DATE_FORMAT(MIN(period_end_date), '%Y-%m-%d') AS first
       FROM product_stock_period_end WHERE period_end_date <= ? GROUP BY product_id, company_id`, [w.to]))[0], [] as RowDataPacket[]),
  ]);

  // the cards' rows: the view's companies within the role's companies
  const rows = (catalog as any[]).filter((r) => {
    const company = String(r.Company ?? '');
    return (!allowedCompanies || allowedCompanies.has(company)) && (view === 'BMH' || company === view);
  });
  const salesBy = new Map<string, { units: number; value: number; sold: boolean }>();
  for (const r of sales) salesBy.set(`${r.p}|${r.k}`, { units: num(r.units), value: num(r.value), sold: num(r.soldRows) > 0 });
  const stockAt = new Map<string, number>();
  const loadedDates = new Set<string>();
  for (const r of stockRows) {
    stockAt.set(`${r.d}|${stockKey(r.company_id, r.product_id)}`, num(r.qty_on_hand));
    loadedDates.add(String(r.d));
  }
  const firstStock = new Map<string, string>(firstRows.map((r) => [stockKey(r.company_id, r.product_id), String(r.first)]));
  const groups = [...groupBySku(rows).entries()];

  const skus = new Map<string, SkuState[]>();
  const countsOf = new Map<string, SkuTrendCounts | null>();
  for (const period of periods) {
    if (!period.inProgress && !loadedDates.has(period.end)) {
      countsOf.set(period.start, null);
      continue;
    }
    const list: SkuState[] = [];
    const counts: SkuTrendCounts = { active: 0, nonActive: 0, dormant: 0, total: 0 };
    for (const [id, parts] of groups) {
      const inputs: StatusInput[] = [];
      let existed = period.inProgress; // the period in progress: every SKU, like the cards
      let units = 0;
      let value = 0;
      for (const p of parts) {
        const s = salesBy.get(`${period.start}|${p.ProductCompanyKey}`);
        const sold = Boolean(s?.sold);
        units += s?.units ?? 0;
        value += s?.value ?? 0;
        if (period.inProgress) {
          // the cards' StatusInput (productDashboard statusInputOf): today's On Hand, archived = Dormant
          inputs.push({ status: productStatusOf(p, sold), sold, archived: isArchivedRow(p), onHandQty: num(p.OnHandQty), onHandValue: num(p.OnHandValue), bcg: null });
          continue;
        }
        const key = stockKey(p.CompanyKey, p.ProductKey);
        const stock = stockAt.get(`${period.end}|${key}`) ?? 0;
        const first = iso(p.FirstSaleDate);
        if (sold || (first !== null && first <= period.end) || (firstStock.get(key) ?? '9999-12-31') <= period.end) existed = true;
        // archived today: Dormant only where it had no sales and no stock; otherwise classified by them
        const archived = isArchivedRow(p) && !sold && !(stock > 0);
        const asOfPeriod = { ...p, OnHandQty: stock, IsActive: archived ? 0 : 1 };
        inputs.push({ status: productStatusOf(asOfPeriod, sold), sold, archived, onHandQty: stock, onHandValue: 0, bcg: null });
      }
      if (!existed) continue;
      const combined = combineSkuStatus(inputs);
      const status = STATUS_KEY[String(combined.status)];
      if (!status) continue; // Unclassified: not on the chart
      counts[status] += 1;
      counts.total += 1;
      list.push({ id, parts, status, onHandQty: combined.onHandQty, units, value });
    }
    countsOf.set(period.start, counts);
    skus.set(period.start, list);
  }

  const points: SkuTrendPoint[] = periods.filter((p) => p.shown).map((p) => ({
    start: p.start,
    end: p.end,
    inProgress: p.inProgress,
    stockDate: p.stockDate,
    counts: countsOf.get(p.start) ?? null,
    previous: countsOf.get(shiftPeriod(p.start, q.granularity, -1)) ?? null,
  }));
  const closedShown = periods.filter((p) => p.shown && !p.inProgress);
  const missingStockDates = closedShown.filter((p) => !loadedDates.has(p.end)).map((p) => p.end);
  return {
    trend: { granularity: q.granularity, view, from: w.from, to: w.to, points, stockLoaded: missingStockDates.length < closedShown.length, missingStockDates },
    skus,
  };
}

/** Cached per query and data version: the ETL build (BuiltAtUtc) and the period-end stock (its latest load and row count). */
const CACHE_MAX = 100;
const cache = new Map<string, Computed>();

async function dataVersion(pool: Pool): Promise<string> {
  const [[meta]] = await pool.query<RowDataPacket[]>('SELECT MAX(BuiltAtUtc) AS v FROM etl_sales_product_dashboard_meta');
  const stock = await orEmpty(async () => (await pool.query<RowDataPacket[]>(
    'SELECT MAX(loaded_at) AS v, COUNT(*) AS n FROM product_stock_period_end'))[0][0], undefined);
  const s = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v ?? ''));
  return `${s(meta?.v)}|${s(stock?.v)}|${s(stock?.n)}`;
}

export function clearSkuTrendCache(): void {
  cache.clear();
}

async function cached(pool: Pool, q: SkuTrendQuery): Promise<Computed> {
  const key = JSON.stringify([await dataVersion(pool), q.granularity, q.to, q.company ?? null, q.filters?.companyKeys ?? []]);
  const hit = cache.get(key);
  if (hit) return hit;
  const result = await compute(pool, q);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, result);
  return result;
}

/** Every period of the window in one response. */
export async function computeSkuTrend(pool: Pool, q: SkuTrendQuery): Promise<SkuTrend> {
  return (await cached(pool, q)).trend;
}

/** The SKUs behind one point: one status ('active' / 'nonActive' / 'dormant', a line point) or every SKU ('all', the total
 * bar) of one period of the window. */
export async function computeSkuTrendSkus(pool: Pool, q: SkuTrendQuery & { period: string; status: string }): Promise<SkuTrendSkuList> {
  if (q.status !== 'all' && !(SKU_TREND_STATUSES as readonly string[]).includes(q.status)) {
    throw new SkuTrendQueryError('status must be all, active, nonActive or dormant');
  }
  const { trend, skus } = await cached(pool, q);
  const point = trend.points.find((p) => p.start === q.period);
  if (!point) throw new SkuTrendQueryError('period must be the start of a period of the window');
  const status = q.status as SkuTrendSelection;
  const base = odooConfiguredBaseUrl();
  const list = (skus.get(point.start) ?? []).filter((s) => status === 'all' || s.status === status).map((s): SkuTrendSku => {
    const primary = [...s.parts].sort((a, b) => num(b.ValueYTD) - num(a.ValueYTD))[0];
    return {
      odooProductId: s.id,
      sku: primary.SKU ? String(primary.SKU) : null,
      productName: String(primary.ProductName ?? primary.OdooProductName ?? s.id).trim(),
      companies: [...new Set(s.parts.map((p) => String(p.Company ?? '')))],
      units: s.units,
      value: s.value,
      onHandQty: s.onHandQty,
      archived: s.parts.every((p) => isArchivedRow(p)),
      status: s.status,
      odooUrl: odooFormUrl(base, 'product.product', num(primary.ProductKey), num(primary.CompanyKey)),
    };
  }).sort((a, b) => b.value - a.value || b.onHandQty - a.onHandQty || a.productName.localeCompare(b.productName));
  return { granularity: q.granularity, view: trend.view, status, period: { start: point.start, end: point.end, stockDate: point.stockDate }, skus: list };
}
