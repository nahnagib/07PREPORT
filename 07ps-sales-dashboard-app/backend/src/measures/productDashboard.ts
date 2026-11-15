/**
 * Product pages (BCG Matrix, Stock Velocity, PIM Contribution, Product Lifecycle) -- one measure,
 * served per page by routes/productDashboard.ts.
 *
 * Source tables, all rebuilt by every ETL run (data/etl/src/sales_pipeline/product_dashboard.py):
 * Products are Odoo's (2026-11-03): one product = one Odoo product.product id in one company
 * (ProductCompanyKey 'Majaal|2163'); name, SKU, category, brand, sub brand, family, size and active are Odoo's values as
 * stored, 'Unassigned' where Odoo has none. Nothing is matched or grouped on a product name.
 *
 *   v_sales_product_daily  Company + product (ProductCompanyKey) + day + filter keys + UoM. Built from the
 *                           same v_sales_lines rows the Sales pages read, minus the lines that are not real
 *                           sales (Customer Group Backoffice / Inter Company and IsIntercompany lines, config
 *                           product_pages_excluded_segment_keys / product_pages_exclude_intercompany), so the
 *                           grand total = the Sales pages' SUM(Value) for the same period minus those lines.
 *   v_sales_product_dashboard    one row per Company + product (every product sold or in stock in that company,
 *                           plus its active never-sold Odoo products) with today's stock, days of inventory,
 *                           stock band, lifecycle segment and BCG class.
 *   etl_sales_product_dashboard_meta   as-of date and the thresholds the ETL used (config/product_dashboard.json).
 *
 * Company view (query.company = 'Majaal' | 'Tika'): that company's products and sales only.
 * All-companies view (no company, still called 'BMH'): every company's products side by side. A product is ALWAYS one
 * Odoo product in one company -- nothing is combined across companies (2026-11-04).
 * Athena is not on the Product pages (EXCLUDED_COMPANIES; the ETL already leaves it out of these tables, the measure
 * filters it again so totals never include it).
 * Units: the ETL shows every unit-type UoM (UNIT, Unit, وحدة) as one "Unit"; other UoMs (bag, m, m², kg) keep their name.
 *
 * Metric definitions (docs/product_data_runbook.md):
 *   Value    = SUM(untaxed line amount) in LYD, confirmed orders, order date in Africa/Tripoli.
 *   Volume   = SUM(invoiced quantity) -- same quantity as the Sales pages, always added up as "Unit" whatever the
 *              Odoo UoM (2026-11-07 decision). volumeByUom keeps the split by UoM for reference.
 *   Velocity = Volume / days in the period (period end capped at today).
 *   Order days = distinct days in the period with at least one sales line of the product (Sales Frequency).
 * Stock, days of inventory, lifecycle, BCG class and Product Movement are "as of the last ETL run", company-wide,
 * and do not move with the period or the filters. Volume / Revenue YTD and LYTD (calendar, as of today) DO follow
 * the Customer Group / Channel / Branch / Salesperson filters (2026-11-07, option a); the class is never recomputed
 * for the filtered subset.
 * BCG class (2026-11-11): the config thresholds applied to each product's LATEST profit data (measures/bcgLatestProfit.ts):
 * calendar YTD when it sold this year fully costed, else its most recent fully costed calendar year. Served as
 * bcgClassYTD (every Product page shows it) with the volume, profit, GP% and the period / date of the data used.
 * On Hand (2026-11-10): Odoo's On Hand of the product in its company (OnHandQty / OnHandValue, every internal location);
 * stockQty stays the finished-goods stock behind DOH, the stock band and ISR.
 *
 * Scope: Customer Group / Channel / Branch / Salesperson filters and the RBAC lock (resolveScopedFilters) narrow the
 * sales metrics. When any of them is active, a product is listed when it sold in scope in the period OR in the same
 * period last year. Products with no sale at all in either period (stock only, never sold) have no customer, so they
 * stay listed -- except for a SALESPERSON-tier user, who sees only products they sold.
 */

import type { Pool } from 'mysql2/promise';
import { DateTime } from 'luxon';
import { buildWhereClause, type Filters } from './filters';
import { getAppTimezone } from '../lib/timezone';
import { odooConfiguredBaseUrl, odooFormUrl } from '../lib/odooLinks';
import { bcgRule, fetchBcgWindows, latestBcg, withBcgThresholds } from './bcgLatestProfit';

export interface UomQty {
  uom: string;
  qty: number;
}

export interface ProductDashboardRow {
  /** Company|Odoo product id: the row's identity (one Odoo product in one company). */
  productCompanyKey: string;
  /** Odoo product.product id; null for sales lines without a product. */
  productKey: string | null;
  /** The product's form in Odoo (product.product, opened in its own company); null without ODOO_URL or a real id. */
  odooUrl: string | null;
  productTemplateId: number | null;
  company: string;
  productName: string;
  odooProductName: string | null;
  category: string | null;
  brand: string | null;
  subBrand: string | null;
  family: string | null;
  size: string | null;
  sku: string | null;
  isActive: number | null;
  /** Always exactly one company: [company]. */
  companies: string[];
  /** The row's own period sales as one part (kept for the pages' company split). */
  parts: ProductCompanyPart[];
  // Period (filter-dependent)
  value: number;
  /** Invoiced quantity of the period, added up across UoMs ("Unit"). */
  volume: number;
  volumeByUom: UomQty[];
  uom: string | null;
  lines: number;
  /** Distinct order dates of the product in the period (how often it sells). */
  orderDays: number;
  velocity: number | null;
  valuePrior: number;
  volumePrior: number;
  avgUnitPrice: number | null;
  grossProfitPct: number | null;
  // Snapshot (as of the last ETL run)
  stockQty: number;
  stockValue: number;
  inTransitQty: number;
  inTransitValue: number;
  avgDailySales: number;
  daysOfInventory: number | null;
  stockBand: 'Overstock' | 'Normal' | 'StockOutRisk' | 'NoMovement' | 'NoStockNoSales';
  /** Units-weighted average days since the finished-goods stock on hand arrived (Odoo in_date); null = no stock. */
  stockAgeDays: number | null;
  /** Stock Aging bucket (config stock.aging_buckets), null = no stock on hand. */
  stockAgeBucket: string | null;
  /** Odoo's On Hand in the product's company: every quant in an internal location (dim OnHandQty, 2026-11-10). */
  onHandQty: number;
  onHandValue: number;
  /** Age (days) of the oldest receipt layer still in stock; null = no stock on hand. */
  stockAgeOldestDays: number | null;
  /** 'layers' (Odoo stock.valuation.layer) or 'quant_in_date' (no open layer). */
  stockAgeSource: string | null;
  /** On Hand units / value per aging bucket, split by receipt layer (config stock.aging_buckets order). */
  agingBuckets: AgingBucketAmount[];
  lifecycleSegment: 'New' | 'Growing' | 'Mature' | 'Declining' | 'Discontinued' | 'Never sold';
  firstSaleDate: string | null;
  lastSaleDate: string | null;
  /** BCG class on the product's latest profit data (bcgLatestProfit.ts); null = never sold. */
  bcgClassYTD: string | null;
  bcgClassLYTD: string | null;
  /** The data behind bcgClassYTD: volume, sales value, profit (Value - Qty x standard cost), GP% of that window. */
  bcgVolume: number | null;
  bcgValue: number | null;
  bcgProfit: number | null;
  bcgGrossProfitPct: number | null;
  /** 'YTD 2026' or the calendar year used ('2025'); null = no profit data in the database. */
  bcgDataPeriod: string | null;
  /** Last sale date of the data used. */
  bcgDataAsOf: string | null;
  bcgMovement: 'New' | 'Stable' | 'Improved' | 'Drop' | 'Discontinued' | null;
  bcgExcludedCategory: boolean;
  valueYTD: number;
  volumeYTD: number;
  valueLYTD: number;
  volumeLYTD: number;
  grossProfitPctYTD: number | null;
  grossProfitPctLYTD: number | null;
  negativeStockRows: number;
}

export interface AgingBucketAmount {
  key: string;
  label: string;
  qty: number;
  value: number;
}

export interface ProductCompanyPart {
  company: string;
  productCompanyKey: string;
  value: number;
  lines: number;
  volumeByUom: UomQty[];
}

export type ProductDashboardView = 'BMH' | 'Majaal' | 'Tika';

export interface ProductDashboardOverview {
  view: ProductDashboardView;
  asOfDate: string | null;
  builtAtUtc: string | null;
  period: { from: string; to: string; days: number; priorFrom: string; priorTo: string };
  lookbackDays: number;
  thresholds: Record<string, unknown>;
  products: ProductDashboardRow[];
  totals: { value: number; lines: number; volumeByUom: UomQty[] };
  intercompanyValue: number;
}

export interface ProductDashboardQuery {
  fromDate?: string;
  toDate?: string;
  /** 'Majaal' / 'Tika' = company view; anything else (or absent) = all companies side by side ('BMH'). */
  company?: string;
  /** companyKeys only ever comes from the user's role data scope (the page sends a company name). */
  filters?: Pick<Filters, 'companyKeys' | 'segmentKeys' | 'channelKeys' | 'salesTeamKeys' | 'salespersonKeys'>;
  /** SALESPERSON-tier caller: products without any sale in the period / prior period are not listed. */
  salespersonTier?: boolean;
}

/** A company the caller's role may not see was requested (the route answers 403). */
export class ProductScopeError extends Error {}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Companies never shown on the Product pages (Promotion / Price / Process are not affected). */
export const EXCLUDED_COMPANIES = ['Athena'];
/** Label of a quantity added up across units of measure. */
export const UNIT_LABEL = 'Unit';

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s === '' ? null : s;
}
function isoDate(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return DateTime.fromJSDate(v, { zone: 'utc' }).toISODate();
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : null;
}

/** Resolves the requested period; default = calendar YTD. The end is capped at today (app timezone). */
export function resolvePeriod(fromDate?: string, toDate?: string, now: DateTime = DateTime.now()) {
  const today = now.setZone(getAppTimezone()).startOf('day');
  let to = toDate && ISO.test(toDate) ? DateTime.fromISO(toDate, { zone: getAppTimezone() }) : today;
  if (to > today) to = today;
  let from = fromDate && ISO.test(fromDate) ? DateTime.fromISO(fromDate, { zone: getAppTimezone() }) : today.startOf('year');
  if (from > to) from = to;
  const days = Math.round(to.diff(from, 'days').days) + 1;
  const priorFrom = from.minus({ years: 1 });
  const priorTo = to.minus({ years: 1 });
  return {
    from: from.toISODate() as string,
    to: to.toISODate() as string,
    days,
    priorFrom: priorFrom.toISODate() as string,
    priorTo: priorTo.toISODate() as string,
    // BCG windows: calendar YTD and the same dates last year, whatever the period (the ETL's own windows).
    ytdFrom: today.startOf('year').toISODate() as string,
    ytdTo: today.toISODate() as string,
    lytdFrom: today.minus({ years: 1 }).startOf('year').toISODate() as string,
    lytdTo: today.minus({ years: 1 }).toISODate() as string,
  };
}

function uomList(map: Map<string, number>): UomQty[] {
  return [...map.entries()].map(([uom, qty]) => ({ uom, qty })).sort((a, b) => b.qty - a.qty);
}

export function resolveView(company?: string): ProductDashboardView {
  const c = (company ?? '').trim().toUpperCase();
  if (c === 'MAJAAL') return 'Majaal';
  if (c === 'TIKA') return 'Tika';
  return 'BMH';
}

type Agg = {
  value: number;
  lines: number;
  linesPrior: number;
  cost: number;
  uncosted: number;
  valuePrior: number;
  qty: Map<string, number>;
  qtyPrior: Map<string, number>;
  valueYTD: number;
  qtyYTD: number;
  valueLYTD: number;
  qtyLYTD: number;
};

function emptyAgg(): Agg {
  return { value: 0, lines: 0, linesPrior: 0, cost: 0, uncosted: 0, valuePrior: 0, qty: new Map(), qtyPrior: new Map(), valueYTD: 0, qtyYTD: 0, valueLYTD: 0, qtyLYTD: 0 };
}

const sumQty = (m: Map<string, number>) => [...m.values()].reduce((t, q) => t + q, 0);

/** One page row from a v_sales_product_dashboard row and its period sums. */
/** Aging buckets of the config (stock.aging_buckets: key + label), in order. */
function agingBucketDefs(thresholds: Record<string, unknown>): { key: string; label: string }[] {
  const raw = ((thresholds.stock ?? {}) as { aging_buckets?: { key?: string; label?: string }[] }).aging_buckets ?? [];
  return raw.filter((b) => b.key).map((b) => ({ key: String(b.key), label: String(b.label ?? b.key) }));
}

function toRow(key: string, p: any, a: Agg | undefined, days: number, companies: string[], parts: ProductCompanyPart[], orderDays = 0, odooBase: string | null = null,
  buckets: { key: string; label: string }[] = []): ProductDashboardRow {
  const value = a?.value ?? 0;
  const lines = a?.lines ?? 0;
  const volumeByUom = a ? uomList(a.qty) : [];
  const single = volumeByUom.length <= 1;
  // Always added up as "Unit", whatever the Odoo UoM (2026-11-07); a product sold in one UoM keeps that UoM's name.
  const volume = a ? sumQty(a.qty) : 0;
  const volumePrior = a ? sumQty(a.qtyPrior) : 0;
  const costed = a && a.uncosted === 0 && lines > 0;
  return {
    productCompanyKey: key,
    productKey: p.ProductKey === null || p.ProductKey === undefined || String(p.ProductKey) === '-1' ? null : String(p.ProductKey),
    odooUrl: odooFormUrl(odooBase, 'product.product', Number(p.ProductKey), numOrNull(p.CompanyKey)),
    productTemplateId: numOrNull(p.ProductTemplateID),
    company: String(p.Company ?? ''),
    productName: String(p.ProductName ?? p.OdooProductName ?? key),
    odooProductName: str(p.OdooProductName),
    category: str(p.Category),
    brand: str(p.Brand),
    subBrand: str(p.SubBrand),
    family: str(p.Family),
    size: str(p.Size),
    sku: str(p.SKU),
    isActive: numOrNull(p.IsActive),
    companies,
    parts,
    value,
    volume,
    volumeByUom,
    uom: single ? (volumeByUom[0]?.uom || str(p.UoM)) : UNIT_LABEL,
    lines,
    orderDays,
    velocity: volume / days,
    valuePrior: a?.valuePrior ?? 0,
    volumePrior,
    avgUnitPrice: volume ? value / volume : null,
    grossProfitPct: costed && value !== 0 ? ((value - (a?.cost ?? 0)) / value) * 100 : null,
    stockQty: num(p.StockQty),
    stockValue: num(p.StockValue),
    inTransitQty: num(p.InTransitQty),
    inTransitValue: num(p.InTransitValue),
    avgDailySales: num(p.AvgDailySales),
    daysOfInventory: numOrNull(p.DaysOfInventory),
    stockBand: String(p.StockBand) as ProductDashboardRow['stockBand'],
    stockAgeDays: numOrNull(p.StockAgeDays),
    stockAgeBucket: str(p.StockAgeBucket),
    onHandQty: num(p.OnHandQty),
    onHandValue: num(p.OnHandValue),
    stockAgeOldestDays: numOrNull(p.StockAgeOldestDays),
    stockAgeSource: str(p.StockAgeSource),
    agingBuckets: buckets.map((b) => ({ ...b, qty: num(p[`AgeQty_${b.key}`]), value: num(p[`AgeValue_${b.key}`]) })),
    lifecycleSegment: String(p.LifecycleSegment) as ProductDashboardRow['lifecycleSegment'],
    firstSaleDate: isoDate(p.FirstSaleDate),
    lastSaleDate: isoDate(p.LastSaleDate),
    bcgClassYTD: str(p.BcgClassYTD),
    bcgClassLYTD: str(p.BcgClassLYTD),
    bcgVolume: null,
    bcgValue: null,
    bcgProfit: null,
    bcgGrossProfitPct: null,
    bcgDataPeriod: null,
    bcgDataAsOf: null,
    bcgMovement: (str(p.BcgMovement) as ProductDashboardRow['bcgMovement']) ?? null,
    bcgExcludedCategory: Boolean(num(p.BcgExcludedCategory)),
    // Follow the filters (calendar YTD / LYTD of the period's sales rows); class and movement stay the ETL's.
    valueYTD: a?.valueYTD ?? 0,
    volumeYTD: a?.qtyYTD ?? 0,
    valueLYTD: a?.valueLYTD ?? 0,
    volumeLYTD: a?.qtyLYTD ?? 0,
    grossProfitPctYTD: numOrNull(p.GrossProfitPctYTD),
    grossProfitPctLYTD: numOrNull(p.GrossProfitPctLYTD),
    negativeStockRows: num(p.NegativeStockRows),
  };
}

export async function computeProductDashboard(pool: Pool, query: ProductDashboardQuery = {}): Promise<ProductDashboardOverview> {
  const period = resolvePeriod(query.fromDate, query.toDate);
  let requestedView = resolveView(query.company);
  const companyKeys = query.filters?.companyKeys ?? [];
  if (companyKeys.length > 0) {
    // Role limited to some companies: never show another company -- a single allowed company always gets its company view.
    const [allowedRows] = await pool.query('SELECT DISTINCT Company FROM v_sales_product_daily WHERE CompanyKey IN (?)', [companyKeys]);
    const allowed = (allowedRows as any[]).map((r) => String(r.Company));
    if (requestedView !== 'BMH' && !allowed.includes(requestedView)) {
      throw new ProductScopeError(`Company ${requestedView} is outside this role's permitted data scope.`);
    }
    if (requestedView === 'BMH' && allowed.length === 1) requestedView = resolveView(allowed[0]);
  }
  const scope = buildWhereClause(query.filters ?? {}, 'd');
  const scoped = scope.clause !== '1=1';
  const companyClause = requestedView === 'BMH' ? '' : ' AND d.Company = ?';

  const salesSql = `
    SELECT d.ProductCompanyKey AS k, COALESCE(d.UoM, '') AS uom,
      SUM(CASE WHEN d.OrderDate BETWEEN ? AND ? THEN d.Value ELSE 0 END)      AS value,
      SUM(CASE WHEN d.OrderDate BETWEEN ? AND ? THEN d.Qty ELSE 0 END)        AS qty,
      SUM(CASE WHEN d.OrderDate BETWEEN ? AND ? THEN d.Lines ELSE 0 END)      AS lineCount,
      SUM(CASE WHEN d.OrderDate BETWEEN ? AND ? THEN d.CostValue ELSE 0 END)  AS costValue,
      SUM(CASE WHEN d.OrderDate BETWEEN ? AND ? THEN d.UncostedQty ELSE 0 END) AS uncostedQty,
      SUM(CASE WHEN d.OrderDate BETWEEN ? AND ? THEN d.Value ELSE 0 END)      AS valuePrior,
      SUM(CASE WHEN d.OrderDate BETWEEN ? AND ? THEN d.Qty ELSE 0 END)        AS qtyPrior,
      SUM(CASE WHEN d.OrderDate BETWEEN ? AND ? AND d.IsIntercompany = 1 THEN d.Value ELSE 0 END) AS icValue,
      SUM(CASE WHEN d.OrderDate BETWEEN ? AND ? THEN d.Lines ELSE 0 END)      AS linesPrior,
      SUM(CASE WHEN d.OrderDate BETWEEN ? AND ? THEN d.Value ELSE 0 END)      AS valueYTD,
      SUM(CASE WHEN d.OrderDate BETWEEN ? AND ? THEN d.Qty ELSE 0 END)        AS qtyYTD,
      SUM(CASE WHEN d.OrderDate BETWEEN ? AND ? THEN d.Value ELSE 0 END)      AS valueLYTD,
      SUM(CASE WHEN d.OrderDate BETWEEN ? AND ? THEN d.Qty ELSE 0 END)        AS qtyLYTD
    FROM v_sales_product_daily d
    WHERE ((d.OrderDate BETWEEN ? AND ?) OR (d.OrderDate BETWEEN ? AND ?) OR (d.OrderDate BETWEEN ? AND ?) OR (d.OrderDate BETWEEN ? AND ?))
      AND ${scope.clause}${companyClause}
      AND d.Company NOT IN (?)
    GROUP BY d.ProductCompanyKey, COALESCE(d.UoM, '')`;
  const cur = [period.from, period.to];
  const prior = [period.priorFrom, period.priorTo];
  const ytd = [period.ytdFrom, period.ytdTo];
  const lytd = [period.lytdFrom, period.lytdTo];
  const salesParams: Array<string | number> = [
    ...cur, ...cur, ...cur, ...cur, ...cur, ...prior, ...prior, ...cur, ...prior, ...ytd, ...ytd, ...lytd, ...lytd,
    ...cur, ...prior, ...ytd, ...lytd, ...scope.params,
  ];
  if (requestedView !== 'BMH') salesParams.push(requestedView);
  salesParams.push(EXCLUDED_COMPANIES as unknown as string);

  const orderDaysSql = `
    SELECT d.ProductCompanyKey AS k, COUNT(DISTINCT d.OrderDate) AS orderDays
    FROM v_sales_product_daily d
    WHERE d.OrderDate BETWEEN ? AND ? AND d.Lines > 0 AND ${scope.clause}${companyClause} AND d.Company NOT IN (?)
    GROUP BY d.ProductCompanyKey`;
  const orderDaysParams: Array<string | number | string[]> = [...cur, ...scope.params];
  if (requestedView !== 'BMH') orderDaysParams.push(requestedView);
  orderDaysParams.push(EXCLUDED_COMPANIES);

  // Products with any sale (in any scope) in the period or the prior period: under a filter, those without a sale in
  // scope are hidden; the ones that never sold in either period (stock only, never sold) stay listed (not a salesperson).
  const soldSql = `
    SELECT DISTINCT d.ProductCompanyKey AS k FROM v_sales_product_daily d
    WHERE ((d.OrderDate BETWEEN ? AND ?) OR (d.OrderDate BETWEEN ? AND ?)) AND d.Lines > 0${companyClause} AND d.Company NOT IN (?)`;
  const soldParams: Array<string | string[]> = [...cur, ...prior];
  if (requestedView !== 'BMH') soldParams.push(requestedView);
  soldParams.push(EXCLUDED_COMPANIES);

  const [[salesRows], [orderDayRows], [soldRows], [productRows], [metaRows], bcgWindows] = await Promise.all([
    pool.query(salesSql, salesParams),
    pool.query(orderDaysSql, orderDaysParams),
    scoped ? pool.query(soldSql, soldParams) : Promise.resolve([[]] as unknown[]),
    pool.query('SELECT * FROM v_sales_product_dashboard WHERE Company NOT IN (?)', [EXCLUDED_COMPANIES]),
    pool.query('SELECT AsOfDate, BuiltAtUtc, LookbackDays, ConfigJson FROM etl_sales_product_dashboard_meta LIMIT 1'),
    fetchBcgWindows(pool, period.ytdFrom, period.ytdTo, EXCLUDED_COMPANIES),
  ]);
  const view = requestedView;

  const byProduct = new Map<string, Agg>();
  let intercompanyValue = 0;
  for (const r of salesRows as any[]) {
    const key = String(r.k);
    const a = byProduct.get(key) ?? emptyAgg();
    a.value += num(r.value);
    a.lines += num(r.lineCount);
    a.cost += num(r.costValue);
    a.uncosted += num(r.uncostedQty);
    a.valuePrior += num(r.valuePrior);
    a.linesPrior += num(r.linesPrior);
    a.valueYTD += num(r.valueYTD);
    a.qtyYTD += num(r.qtyYTD);
    a.valueLYTD += num(r.valueLYTD);
    a.qtyLYTD += num(r.qtyLYTD);
    const uom = String(r.uom ?? '');
    if (num(r.lineCount) > 0) a.qty.set(uom, (a.qty.get(uom) ?? 0) + num(r.qty));
    if (num(r.qtyPrior) !== 0) a.qtyPrior.set(uom, (a.qtyPrior.get(uom) ?? 0) + num(r.qtyPrior));
    intercompanyValue += num(r.icValue);
    byProduct.set(key, a);
  }

  const partOf = (p: any, a: Agg | undefined): ProductCompanyPart => ({
    company: String(p.Company ?? ''),
    productCompanyKey: String(p.ProductCompanyKey),
    value: a?.value ?? 0,
    lines: a?.lines ?? 0,
    volumeByUom: a ? uomList(a.qty) : [],
  });

  const meta = (metaRows as any[])[0] ?? {};
  let thresholds: Record<string, unknown> = {};
  try {
    thresholds = meta.ConfigJson ? JSON.parse(String(meta.ConfigJson)) : {};
    delete (thresholds as any).intercompany_customers;
  } catch {
    thresholds = {};
  }
  thresholds = withBcgThresholds(thresholds);
  const buckets = agingBucketDefs(thresholds);

  const orderDaysOf = new Map((orderDayRows as any[]).map((r) => [String(r.k), num(r.orderDays)]));
  const soldAnywhere = new Set((soldRows as any[]).map((r) => String(r.k)));
  const odooBase = odooConfiguredBaseUrl();
  const products: ProductDashboardRow[] = [];
  for (const p of (productRows as any[]).filter((r) => view === 'BMH' || String(r.Company ?? '') === view)) {
    const key = String(p.ProductCompanyKey);
    const a = byProduct.get(key);
    const soldInScope = Boolean(a && (a.lines > 0 || a.linesPrior > 0));
    if (scoped && !soldInScope && (query.salespersonTier || soldAnywhere.has(key))) continue;
    products.push(toRow(key, p, a, period.days, [String(p.Company ?? '')], [partOf(p, a)], orderDaysOf.get(key) ?? 0, odooBase, buckets));
  }

  // BCG on each product's latest fully costed data (company-wide), the config thresholds.
  const latest = latestBcg(bcgWindows, bcgRule(thresholds), Number(period.ytdFrom.slice(0, 4)));
  for (const r of products) {
    const b = latest.get(r.productCompanyKey);
    r.bcgClassYTD = b?.bcgClass ?? null;
    r.bcgVolume = b?.volume ?? null;
    r.bcgValue = b?.value ?? null;
    r.bcgProfit = b?.profit ?? null;
    r.bcgGrossProfitPct = b?.grossProfitPct ?? null;
    r.bcgDataPeriod = b?.dataPeriod ?? null;
    r.bcgDataAsOf = b?.dataAsOf ?? null;
  }

  // Totals straight from the sales rows (not from the product list), so a key missing from
  // v_sales_product_dashboard can never drop out of the reconciliation.
  const totalQty = new Map<string, number>();
  let totalValue = 0;
  let totalLines = 0;
  for (const a of byProduct.values()) {
    if (a.lines <= 0) continue;
    totalValue += a.value;
    totalLines += a.lines;
    for (const [uom, qty] of a.qty) totalQty.set(uom, (totalQty.get(uom) ?? 0) + qty);
  }

  return {
    view,
    asOfDate: isoDate(meta.AsOfDate),
    builtAtUtc: meta.BuiltAtUtc ? new Date(meta.BuiltAtUtc).toISOString() : null,
    period,
    lookbackDays: num(meta.LookbackDays) || 90,
    thresholds,
    products,
    totals: { value: totalValue, lines: totalLines, volumeByUom: uomList(totalQty) },
    intercompanyValue,
  };
}
