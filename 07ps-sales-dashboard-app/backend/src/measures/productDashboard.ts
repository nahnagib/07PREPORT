/**
 * Product pages (BCG Matrix, Stock Velocity, PIM Contribution, Product Lifecycle) -- one measure,
 * served per page by routes/productDashboard.ts.
 *
 * Source tables, all rebuilt by every ETL run (data/etl/src/sales_pipeline/product_dashboard.py):
 *   fact_productsalesdaily  Company + product (ProductMatchKey) + day + filter keys + UoM. Built from the
 *                           same Fact_SalesLines rows the Sales pages read, so the grand total of all
 *                           products + Unmapped equals the Sales pages' SUM(Value) for the same period.
 *   dim_productdashboard    one row per Company + product (every PRODUCTS.xlsx row, zero sales included,
 *                           plus Unmapped products seen in sales or stock) with today's stock, days of
 *                           inventory, stock band, lifecycle segment and BCG class.
 *   dim_productdashboardgroup  the BMH view: one row per ProductGroupKey (sheet ProductName, normalized)
 *                           across companies, with stock / days of inventory / stock band / lifecycle /
 *                           BCG recomputed by the ETL from the COMBINED lines and stock.
 *   productdashboard_meta   as-of date and the thresholds the ETL used (config/product_dashboard.json).
 *
 * Company view (query.company = 'Majaal' | 'Tika'): that company's products and sales only.
 * BMH view (no company): products grouped by ProductGroupKey, so a product both companies sell
 * (Majaal "Cemair" + Tika "Cem Air") is one row whose value/volume are the exact sum of the two company
 * rows. Period metrics are recomputed from the combined sums (velocity = combined volume / days,
 * margin = combined (value - cost) / combined value) -- never averaged. Unmapped products are not grouped.
 *
 * Metric definitions (docs/product_data_runbook.md):
 *   Value    = SUM(untaxed line amount) in LYD, confirmed orders, order date in Africa/Tripoli.
 *   Volume   = SUM(invoiced quantity) -- same quantity as the Sales pages. Never summed across units of
 *              measure: a product sold in several UoMs in the period gets volume = null and volumeByUom.
 *   Velocity = Volume / days in the period (period end capped at today).
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
  productMatchKey: string;
  productKey: string | null;
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
  isMapped: boolean;
  /** Companies in this row: one in the company view; one or more in the BMH view. */
  companies: string[];
  /** Per-company split of the period sales (BMH view: one entry per company that has the product). */
  parts: ProductCompanyPart[];
  // Period (filter-dependent)
  value: number;
  volume: number | null;
  volumeByUom: UomQty[];
  uom: string | null;
  lines: number;
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
  productMatchKey: string;
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
  unmapped: { value: number; lines: number; volumeByUom: UomQty[]; products: number };
  totals: { value: number; lines: number; volumeByUom: UomQty[] };
  intercompanyValue: number;
}

export interface ProductDashboardQuery {
  fromDate?: string;
  toDate?: string;
  /** 'Majaal' / 'Tika' = company view; anything else (or absent) = BMH view. */
  company?: string;
  /** companyKeys only ever comes from the user's role data scope (the page sends a company name). */
  filters?: Pick<Filters, 'companyKeys' | 'segmentKeys' | 'channelKeys' | 'salesTeamKeys' | 'salespersonKeys'>;
}

/** A company the caller's role may not see was requested (the route answers 403). */
export class ProductScopeError extends Error {}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

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

function addInto(target: Agg, a: Agg): void {
  target.value += a.value;
  target.lines += a.lines;
  target.cost += a.cost;
  target.uncosted += a.uncosted;
  target.valuePrior += a.valuePrior;
  for (const [uom, q] of a.qty) target.qty.set(uom, (target.qty.get(uom) ?? 0) + q);
  for (const [uom, q] of a.qtyPrior) target.qtyPrior.set(uom, (target.qtyPrior.get(uom) ?? 0) + q);
}

/** One page row from a snapshot row (dim_productdashboard or dim_productdashboardgroup) and its period sums. */
function toRow(key: string, p: any, a: Agg | undefined, days: number, companies: string[], parts: ProductCompanyPart[]): ProductDashboardRow {
  const value = a?.value ?? 0;
  const lines = a?.lines ?? 0;
  const volumeByUom = a ? uomList(a.qty) : [];
  const single = volumeByUom.length <= 1;
  const volume = single ? (volumeByUom[0]?.qty ?? 0) : null;
  const priorByUom = a ? uomList(a.qtyPrior) : [];
  const volumePrior = priorByUom.length <= 1 ? (priorByUom[0]?.qty ?? 0) : null;
  const costed = a && a.uncosted === 0 && lines > 0;
  return {
    productMatchKey: key,
    productKey: str(p.ProductKey),
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
    isMapped: Boolean(num(p.IsMapped)),
    companies,
    parts,
    value,
    volume,
    volumeByUom,
    uom: single ? (volumeByUom[0]?.uom || str(p.UoM)) : null,
    lines,
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

async function loadGroupRows(pool: Pool): Promise<any[] | null> {
  try {
    const [rows] = await pool.query('SELECT * FROM dim_productdashboardgroup');
    return rows as any[];
  } catch (err: any) {
    // Before the first ETL run of this version the table does not exist yet: serve per-company rows.
    if (err && err.code === 'ER_NO_SUCH_TABLE') return null;
    throw err;
  }
}

export async function computeProductDashboard(pool: Pool, query: ProductDashboardQuery = {}): Promise<ProductDashboardOverview> {
  const period = resolvePeriod(query.fromDate, query.toDate);
  let requestedView = resolveView(query.company);
  const companyKeys = query.filters?.companyKeys ?? [];
  if (companyKeys.length > 0) {
    // Role limited to some companies: never show another company, and never show a BMH row whose stock /
    // BCG combine a company the user cannot see -- a single allowed company always gets its company view.
    const [allowedRows] = await pool.query('SELECT DISTINCT Company FROM fact_productsalesdaily WHERE CompanyKey IN (?)', [companyKeys]);
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
    SELECT d.ProductMatchKey AS k, COALESCE(d.UoM, '') AS uom,
      SUM(CASE WHEN d.OrderDate BETWEEN ? AND ? THEN d.Value ELSE 0 END)      AS value,
      SUM(CASE WHEN d.OrderDate BETWEEN ? AND ? THEN d.Qty ELSE 0 END)        AS qty,
      SUM(CASE WHEN d.OrderDate BETWEEN ? AND ? THEN d.Lines ELSE 0 END)      AS lineCount,
      SUM(CASE WHEN d.OrderDate BETWEEN ? AND ? THEN d.CostValue ELSE 0 END)  AS costValue,
      SUM(CASE WHEN d.OrderDate BETWEEN ? AND ? THEN d.UncostedQty ELSE 0 END) AS uncostedQty,
      SUM(CASE WHEN d.OrderDate BETWEEN ? AND ? THEN d.Value ELSE 0 END)      AS valuePrior,
      SUM(CASE WHEN d.OrderDate BETWEEN ? AND ? THEN d.Qty ELSE 0 END)        AS qtyPrior,
      SUM(CASE WHEN d.OrderDate BETWEEN ? AND ? AND d.IsIntercompany = 1 THEN d.Value ELSE 0 END) AS icValue
    FROM fact_productsalesdaily d
    WHERE ((d.OrderDate BETWEEN ? AND ?) OR (d.OrderDate BETWEEN ? AND ?)) AND ${scope.clause}${companyClause}
    GROUP BY d.ProductMatchKey, COALESCE(d.UoM, '')`;
  const cur = [period.from, period.to];
  const prior = [period.priorFrom, period.priorTo];
  const salesParams: Array<string | number> = [...cur, ...cur, ...cur, ...cur, ...cur, ...prior, ...prior, ...cur, ...cur, ...prior, ...scope.params];
  if (requestedView !== 'BMH') salesParams.push(requestedView);

  const [[salesRows], [productRows], [metaRows], groupRows] = await Promise.all([
    pool.query(salesSql, salesParams),
    pool.query('SELECT * FROM dim_productdashboard'),
    pool.query('SELECT AsOfDate, BuiltAtUtc, LookbackDays, ConfigJson FROM productdashboard_meta LIMIT 1'),
    requestedView === 'BMH' ? loadGroupRows(pool) : Promise.resolve(null),
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
    productMatchKey: String(p.ProductMatchKey),
    value: a?.value ?? 0,
    lines: a?.lines ?? 0,
    volumeByUom: a ? uomList(a.qty) : [],
  });

  const products: ProductDashboardRow[] = [];
  const companyRows = (productRows as any[]).filter((p) => view === 'BMH' || String(p.Company ?? '') === view);
  if (groupRows === null) {
    for (const p of companyRows) {
      const key = String(p.ProductMatchKey);
      const a = byProduct.get(key);
      if (scoped && !(a && a.lines > 0)) continue;
      products.push(toRow(key, p, a, period.days, [String(p.Company ?? '')], [partOf(p, a)]));
    }
  } else {
    // BMH view: sum each group's member products (exact, per UoM), then recompute the ratios.
    const members = new Map<string, any[]>();
    for (const p of companyRows) {
      const g = String(p.ProductGroupKey ?? p.ProductMatchKey);
      const list = members.get(g) ?? [];
      list.push(p);
      members.set(g, list);
    }
    for (const gp of groupRows) {
      const g = String(gp.ProductGroupKey);
      const list = members.get(g) ?? [];
      const agg = emptyAgg();
      const parts: ProductCompanyPart[] = [];
      let found = false;
      for (const m of list) {
        const a = byProduct.get(String(m.ProductMatchKey));
        if (a) {
          addInto(agg, a);
          found = true;
        }
        parts.push(partOf(m, a));
      }
      const a = found ? agg : undefined;
      if (scoped && !(a && a.lines > 0)) continue;
      const companies = [...new Set(list.map((m) => String(m.Company ?? '')))].sort();
      products.push(toRow(g, gp, a, period.days, companies, parts.sort((x, y) => x.company.localeCompare(y.company))));
    }
  }

  // Totals straight from the sales rows (not from the product list), so a key missing from
  // dim_productdashboard can never drop out of the reconciliation; such a key counts as Unmapped.
  const unmappedQty = new Map<string, number>();
  const totalQty = new Map<string, number>();
  let unmappedValue = 0;
  let unmappedLines = 0;
  let unmappedProducts = 0;
  let totalValue = 0;
  let totalLines = 0;
  const mappedKeys = new Set((productRows as any[]).filter((p) => Boolean(num(p.IsMapped))).map((p) => String(p.ProductMatchKey)));
  for (const [key, a] of byProduct) {
    if (a.lines <= 0) continue;
    totalValue += a.value;
    totalLines += a.lines;
    for (const [uom, qty] of a.qty) totalQty.set(uom, (totalQty.get(uom) ?? 0) + qty);
    if (!mappedKeys.has(key)) {
      unmappedValue += a.value;
      unmappedLines += a.lines;
      unmappedProducts += 1;
      for (const [uom, qty] of a.qty) unmappedQty.set(uom, (unmappedQty.get(uom) ?? 0) + qty);
    }
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
    unmapped: { value: unmappedValue, lines: unmappedLines, volumeByUom: uomList(unmappedQty), products: unmappedProducts },
    totals: { value: totalValue, lines: totalLines, volumeByUom: uomList(totalQty) },
    intercompanyValue,
  };
}
