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
 *                           same v_sales_lines rows the Sales pages read, so the grand total of all
 *                           products equals the Sales pages' SUM(Value) for the same period.
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
 *   Volume   = SUM(invoiced quantity) -- same quantity as the Sales pages. Never summed across units of
 *              measure: a product sold in several UoMs in the period gets volume = null and volumeByUom.
 *   Velocity = Volume / days in the period (period end capped at today).
 *   Order days = distinct days in the period with at least one sales line of the product (Sales Frequency).
 * Stock, days of inventory, lifecycle and BCG class are "as of the last ETL run" and do not move with the
 * period; BCG is calendar YTD vs LYTD, as before.
 *
 * Scope: Customer Group / Channel / Branch / Salesperson filters and the RBAC lock (resolveScopedFilters)
 * narrow the sales metrics. When any of them is active, only products with sales in scope during the
 * period are returned (a salesperson does not see the whole company's stock list).
 */

import type { Pool } from 'mysql2/promise';
import { DateTime } from 'luxon';
import { buildWhereClause, type Filters } from './filters';
import { getAppTimezone } from '../lib/timezone';

export interface UomQty {
  uom: string;
  qty: number;
}

export interface ProductDashboardRow {
  /** Company|Odoo product id: the row's identity (one Odoo product in one company). */
  productCompanyKey: string;
  /** Odoo product.product id; null for sales lines without a product. */
  productKey: string | null;
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
  volume: number | null;
  volumeByUom: UomQty[];
  uom: string | null;
  lines: number;
  /** Distinct order dates of the product in the period (how often it sells). */
  orderDays: number;
  velocity: number | null;
  valuePrior: number;
  volumePrior: number | null;
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
  lifecycleSegment: 'New' | 'Growing' | 'Mature' | 'Declining' | 'Discontinued' | 'Never sold';
  firstSaleDate: string | null;
  lastSaleDate: string | null;
  bcgClassYTD: string | null;
  bcgClassLYTD: string | null;
  bcgMovement: 'New' | 'Stable' | 'Improved' | 'Declined' | 'Lost' | null;
  bcgExcludedCategory: boolean;
  valueYTD: number;
  volumeYTD: number;
  valueLYTD: number;
  volumeLYTD: number;
  grossProfitPctYTD: number | null;
  grossProfitPctLYTD: number | null;
  negativeStockRows: number;
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
}

/** A company the caller's role may not see was requested (the route answers 403). */
export class ProductScopeError extends Error {}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Companies never shown on the Product pages (Promotion / Price / Process are not affected). */
export const EXCLUDED_COMPANIES = ['Athena'];

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
  cost: number;
  uncosted: number;
  valuePrior: number;
  qty: Map<string, number>;
  qtyPrior: Map<string, number>;
};

function emptyAgg(): Agg {
  return { value: 0, lines: 0, cost: 0, uncosted: 0, valuePrior: 0, qty: new Map(), qtyPrior: new Map() };
}

/** One page row from a v_sales_product_dashboard row and its period sums. */
function toRow(key: string, p: any, a: Agg | undefined, days: number, companies: string[], parts: ProductCompanyPart[], orderDays = 0): ProductDashboardRow {
  const value = a?.value ?? 0;
  const lines = a?.lines ?? 0;
  const volumeByUom = a ? uomList(a.qty) : [];
  const single = volumeByUom.length <= 1;
  const volume = single ? (volumeByUom[0]?.qty ?? 0) : null;
  const priorByUom = a ? uomList(a.qtyPrior) : [];
  const volumePrior = priorByUom.length <= 1 ? (priorByUom[0]?.qty ?? 0) : null;
  const costed = a && a.uncosted === 0 && lines > 0;
  return {
    productCompanyKey: key,
    productKey: p.ProductKey === null || p.ProductKey === undefined || String(p.ProductKey) === '-1' ? null : String(p.ProductKey),
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
    uom: single ? (volumeByUom[0]?.uom || str(p.UoM)) : null,
    lines,
    orderDays,
    velocity: volume === null ? null : volume / days,
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
    lifecycleSegment: String(p.LifecycleSegment) as ProductDashboardRow['lifecycleSegment'],
    firstSaleDate: isoDate(p.FirstSaleDate),
    lastSaleDate: isoDate(p.LastSaleDate),
    bcgClassYTD: str(p.BcgClassYTD),
    bcgClassLYTD: str(p.BcgClassLYTD),
    bcgMovement: (str(p.BcgMovement) as ProductDashboardRow['bcgMovement']) ?? null,
    bcgExcludedCategory: Boolean(num(p.BcgExcludedCategory)),
    valueYTD: num(p.ValueYTD),
    volumeYTD: num(p.QtyYTD),
    valueLYTD: num(p.ValueLYTD),
    volumeLYTD: num(p.QtyLYTD),
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
      SUM(CASE WHEN d.OrderDate BETWEEN ? AND ? AND d.IsIntercompany = 1 THEN d.Value ELSE 0 END) AS icValue
    FROM v_sales_product_daily d
    WHERE ((d.OrderDate BETWEEN ? AND ?) OR (d.OrderDate BETWEEN ? AND ?)) AND ${scope.clause}${companyClause}
      AND d.Company NOT IN (?)
    GROUP BY d.ProductCompanyKey, COALESCE(d.UoM, '')`;
  const cur = [period.from, period.to];
  const prior = [period.priorFrom, period.priorTo];
  const salesParams: Array<string | number> = [...cur, ...cur, ...cur, ...cur, ...cur, ...prior, ...prior, ...cur, ...cur, ...prior, ...scope.params];
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

  const [[salesRows], [orderDayRows], [productRows], [metaRows]] = await Promise.all([
    pool.query(salesSql, salesParams),
    pool.query(orderDaysSql, orderDaysParams),
    pool.query('SELECT * FROM v_sales_product_dashboard WHERE Company NOT IN (?)', [EXCLUDED_COMPANIES]),
    pool.query('SELECT AsOfDate, BuiltAtUtc, LookbackDays, ConfigJson FROM etl_sales_product_dashboard_meta LIMIT 1'),
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

  const orderDaysOf = new Map((orderDayRows as any[]).map((r) => [String(r.k), num(r.orderDays)]));
  const products: ProductDashboardRow[] = [];
  for (const p of (productRows as any[]).filter((r) => view === 'BMH' || String(r.Company ?? '') === view)) {
    const key = String(p.ProductCompanyKey);
    const a = byProduct.get(key);
    if (scoped && !(a && a.lines > 0)) continue;
    products.push(toRow(key, p, a, period.days, [String(p.Company ?? '')], [partOf(p, a)], orderDaysOf.get(key) ?? 0));
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

  const meta = (metaRows as any[])[0] ?? {};
  let thresholds: Record<string, unknown> = {};
  try {
    thresholds = meta.ConfigJson ? JSON.parse(String(meta.ConfigJson)) : {};
    delete (thresholds as any).intercompany_customers;
  } catch {
    thresholds = {};
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
