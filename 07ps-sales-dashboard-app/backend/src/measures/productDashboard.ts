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
 *   v_sales_product_dashboard    one row per Company + product: the pages' rows (OnProductPages = 1: every product
 *                           sold or in stock in that company, plus its active never-sold Odoo products) with today's
 *                           stock, days of inventory, stock band, lifecycle segment; and (2026-11-14, migration 0073)
 *                           every other Odoo product of the company (OnProductPages = 0), each row with its
 *                           ProductStatus -- read only by the Total SKUs / Product Status cards (statusSummary).
 *   etl_sales_product_dashboard_meta   as-of date and the thresholds the ETL used (config/product_dashboard.json).
 *
 * Company view (query.company = 'Majaal' | 'Tika'): that company's products and sales only.
 * All-companies view (no company, still called 'BMH'): every company's products side by side. A product is ALWAYS one
 * Odoo product in one company for detail rows. SKU cards count distinct variants in the selected scope.
 * Athena is not on the Product pages (EXCLUDED_COMPANIES; the ETL already leaves it out of these tables, the measure
 * filters it again so totals never include it).
 * Units: the ETL shows every unit-type UoM (UNIT, Unit, وحدة) as one "Unit"; other UoMs (bag, m, m², kg) keep their name.
 *
 * Period (2026-11-14, round 2): the Date filter (fromDate / toDate); none = the rolling LAST 12 MONTHS
 * (lib/last12Months.ts resolveProductPeriod). Every number follows it -- status, BCG, movement, tables -- compared with
 * the same number of days immediately before. The only other filter is Company: the Customer Group / Channel / Branch /
 * Salesperson query params are dropped by the route; the role data scope and the salesperson lock still apply.
 *
 * Metric definitions (docs/product_data_runbook.md):
 *   Value    = SUM(untaxed line amount) in LYD, confirmed orders, order date in Africa/Tripoli.
 *   Volume   = SUM(invoiced quantity) -- same quantity as the Sales pages, always added up as "Unit" whatever the
 *              Odoo UoM (2026-11-07 decision). volumeByUom keeps the split by UoM for reference.
 *   Velocity = Volume / days in the period (period end capped at today).
 *   Order days = distinct days in the period with at least one sales line of the product (Sales Frequency).
 * Product Status of the period: one rule, measures/productPortfolio.ts -- Unclassified (ProductExclusions.xlsx / Raw
 * Materials) > Dormant (archived in Odoo) > Active (sold, quantity > 0, in the period) > Non Active. The product list is the
 * PORTFOLIO only (Active + Non Active); Dormant and Unclassified are counted by statusSummary / skuList alone.
 * BCG class: Active products only, always one of Stars / Cash Cows / Strategic / Dogs (measures/bcgLatestProfit.ts; no
 * cost data = low GP%, flagged missingCost). The thresholds never leave the server (publicThresholds).
 * Profit data -- profit, GP%, cost, missingCost -- is served only with View on `profit_data` (withoutProfit, the route).
 * Stock, days of inventory and lifecycle are as of the last ETL run.
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
import { odooConfiguredBaseUrl, odooFormUrl } from '../lib/odooLinks';
import { FRESHNESS_TARGET_PCT } from '../config/productTargets';
import { BCG_CLASS_KEYS, bcgRule, classify, classifyPeriod, fetchBcgPeriod, withBcgThresholds, type BcgClassKey, type BcgResult } from './bcgLatestProfit';
import { resolveProductPeriod, type ProductPeriod } from '../lib/last12Months';
import { isArchivedRow, isPortfolioStatus, productStatusOf, statusFromSalesAndStock, PRODUCT_STATUSES, type ProductStatus } from './productPortfolio';

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
  /** PROFIT DATA: GP% of the period (every line costed), else null. Absent without profit access. */
  grossProfitPct?: number | null;
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
  /** On Hand units / value per aging bucket holding stock (config stock.aging_buckets order; a bucket not listed = 0). */
  agingBuckets: AgingBucketAmount[];
  lifecycleSegment: 'New' | 'Growing' | 'Mature' | 'Declining' | 'Discontinued' | 'Never sold';
  firstSaleDate: string | null;
  lastSaleDate: string | null;
  /** Status in the period: Unclassified / Dormant (ETL) or Active (sold in the period) / NonActive. */
  productStatus: ProductStatus;
  /** BCG class of the period; Active products only (null otherwise). */
  bcgClass: BcgClassKey | null;
  /** Units / sales value of the period, company-wide (the class's volume). */
  bcgVolume: number | null;
  bcgValue: number | null;
  /** PROFIT DATA (absent without profit access): profit and GP% of the fully costed sales days; missingCost = some sales
   * of the period have no standard cost in Odoo (or zero revenue), so GP% counted as low. */
  bcgProfit?: number | null;
  bcgGrossProfitPct?: number | null;
  missingCost?: boolean | null;
  /** Last sale date in the period. */
  bcgDataAsOf: string | null;
  bcgMovement: 'New' | 'Stable' | 'Improved' | 'Drop' | 'Discontinued' | null;
  bcgExcludedCategory: boolean;
  negativeStockRows: number;
}

export { PRODUCT_STATUSES, type ProductStatus };
export { BCG_CLASS_KEYS, type BcgClassKey };

/** Total SKUs / Product Status / BCG cards of the BCG Matrix page (company view, the selected period). */
/** Quantity on hand and its value (Odoo On Hand of the SKUs of a status, 2026-11-16: every status card shows them). */
export interface OnHandTotals {
  onHandQty: number;
  onHandValue: number;
}

export interface ProductStatusSummary {
  total: number;
  active: { count: number; units: number; value: number } & OnHandTotals;
  /** withStock = stock but no sales; withSales (= zeroStock) = sales but no stock (2026-11-15 rules). */
  nonActive: { count: number; withStock: number; withSales: number; zeroStock: number; stockUnits: number; stockValue: number } & OnHandTotals;
  /** archived = archived in Odoo; idle = no stock and no sales in the period. */
  dormant: { count: number; archived: number; idle: number } & OnHandTotals;
  unclassified: { count: number } & OnHandTotals;
  /** Stars + Cash Cows + Strategic + Dogs = active.count + nonActive.count (the portfolio, 2026-11-15). Non Active SKUs
   * with no sales in the period have zero volume and no margin: Dogs. profit / missingCost: PROFIT DATA. */
  bcg: { classes: { key: BcgClassKey; count: number; units: number; value: number; profit?: number }[]; missingCost?: number };
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
  period: ProductPeriod;
  /** The caller may see profit data (View on profit_data); without it every profit field is absent. */
  profitAccess: boolean;
  lookbackDays: number;
  thresholds: Record<string, unknown>;
  products: ProductDashboardRow[];
  totals: { value: number; lines: number; volumeByUom: UomQty[] };
  intercompanyValue: number;
  /** null when a reconciliation check fails (statusSummaryError says which). */
  statusSummary: ProductStatusSummary | null;
  statusSummaryError: string | null;
  /** Only with query.includeSkuList: the SKUs behind the Total SKUs / Product Status cards (same grouping, same count). */
  skuList?: ProductStatusSkuRow[];
}

/** One SKU of the Product Status cards (2026-11-15): an Odoo variant, its company rows combined exactly as the cards
 * combine them (combineSkuStatus), so the rows per status = the card counts. */
export interface ProductStatusSkuRow {
  odooProductId: string;
  productName: string;
  sku: string | null;
  /** Every company row of the variant in the view (usually one). */
  companies: string[];
  category: string | null;
  brand: string | null;
  status: ProductStatus;
  /** The period's BCG class (Active only). */
  bcgClass: BcgClassKey | null;
  units: number;
  unitsPrior: number;
  value: number;
  /** PROFIT DATA: the period's value - cost when every sold line is costed, else null. Absent without profit access. */
  profit?: number | null;
  grossProfitPct?: number | null;
  onHandQty: number;
  /** Last sale date (any period, Odoo order date). */
  lastSaleDate: string | null;
  odooUrl: string | null;
  /** Non Active: On Hand > 0 (the card's "with stock"). */
  withStock: boolean;
  /** Non Active with sales in the period but no stock (2026-11-15). */
  withSales?: boolean;
  /** Dormant because of no stock and no sales (not archived). */
  idle?: boolean;
  /** Archived in Odoo (Dormant). The archive date is not loaded (null). */
  archived: boolean;
  archivedDate: string | null;
  /** Unclassified: the ProductExclusions.xlsx rule that matched. */
  exclusionRule: string | null;
}

export interface ProductDashboardQuery {
  /** The Date filter; none = the Last 12 Months. */
  fromDate?: string;
  toDate?: string;
  /** 'Majaal' / 'Tika' = company view; anything else (or absent) = all companies side by side ('BMH'). */
  company?: string;
  /** companyKeys only ever comes from the user's role data scope (the page sends a company name). */
  filters?: Pick<Filters, 'companyKeys' | 'segmentKeys' | 'channelKeys' | 'salesTeamKeys' | 'salespersonKeys'>;
  /** SALESPERSON-tier caller: products without any sale in the period / prior period are not listed. */
  salespersonTier?: boolean;
  /** Also return skuList (the BCG page's status table, GET <page>/products): one row per SKU of the status cards. */
  includeSkuList?: boolean;
}

/** A company the caller's role may not see was requested (the route answers 403). */
export class ProductScopeError extends Error {}

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

/** The Product pages' period: the Date filter, default the Last 12 Months (lib/last12Months.ts). */
export function resolvePeriod(fromDate?: string, toDate?: string, now: DateTime = DateTime.now()): ProductPeriod {
  return resolveProductPeriod(fromDate, toDate, now);
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

/** The Company view of a request (`company` = Majaal / Tika, else every company) within the role's companies: a role
 * limited to some companies never sees another one, and a single allowed company always gets its company view. Shared by
 * every Product pages measure (the overview, SKU Trend). */
export async function resolveCompanyView(pool: Pool, company: string | undefined, companyKeys: number[]): Promise<{ view: ProductDashboardView; allowedCompanies?: Set<string> }> {
  let view = resolveView(company);
  if (companyKeys.length === 0) return { view };
  const [allowedRows] = await pool.query('SELECT DISTINCT Company FROM v_sales_product_dashboard WHERE CompanyKey IN (?) AND Company NOT IN (?)', [companyKeys, EXCLUDED_COMPANIES]);
  const allowed = (allowedRows as any[]).map((r) => String(r.Company));
  if (view !== 'BMH' && !allowed.includes(view)) {
    throw new ProductScopeError(`Company ${view} is outside this role's permitted data scope.`);
  }
  if (view === 'BMH' && allowed.length === 1) view = resolveView(allowed[0]);
  return { view, allowedCompanies: new Set(allowed) };
}

export type Agg = {
  value: number;
  lines: number;
  linesPrior: number;
  cost: number;
  uncosted: number;
  valuePrior: number;
  qty: Map<string, number>;
  qtyPrior: Map<string, number>;
};

function emptyAgg(): Agg {
  return { value: 0, lines: 0, linesPrior: 0, cost: 0, uncosted: 0, valuePrior: 0, qty: new Map(), qtyPrior: new Map() };
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
    stockBand: (str(p.StockBand) ?? 'NoStockNoSales') as ProductDashboardRow['stockBand'],
    stockAgeDays: numOrNull(p.StockAgeDays),
    stockAgeBucket: str(p.StockAgeBucket),
    onHandQty: num(p.OnHandQty),
    onHandValue: num(p.OnHandValue),
    stockAgeOldestDays: numOrNull(p.StockAgeOldestDays),
    stockAgeSource: str(p.StockAgeSource),
    // only the buckets holding stock (consumers look a bucket up by key, missing = 0): a quarter of the response before
    agingBuckets: buckets.map((b) => ({ ...b, qty: num(p[`AgeQty_${b.key}`]), value: num(p[`AgeValue_${b.key}`]) })).filter((b) => b.qty !== 0 || b.value !== 0),
    lifecycleSegment: (str(p.LifecycleSegment) ?? (p.FirstSaleDate ? 'Mature' : 'Never sold')) as ProductDashboardRow['lifecycleSegment'],
    firstSaleDate: isoDate(p.FirstSaleDate),
    lastSaleDate: isoDate(p.LastSaleDate),
    productStatus: 'NonActive',
    bcgClass: null,
    bcgVolume: null,
    bcgValue: null,
    bcgProfit: null,
    bcgGrossProfitPct: null,
    missingCost: null,
    bcgDataAsOf: null,
    bcgMovement: null,
    bcgExcludedCategory: Boolean(num(p.BcgExcludedCategory)),
    negativeStockRows: num(p.NegativeStockRows),
  };
}

export async function computeProductDashboard(pool: Pool, query: ProductDashboardQuery = {}): Promise<ProductDashboardOverview> {
  const period = resolvePeriod(query.fromDate, query.toDate);
  const { view: requestedView, allowedCompanies } = await resolveCompanyView(pool, query.company, query.filters?.companyKeys ?? []);
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
      SUM(CASE WHEN d.OrderDate BETWEEN ? AND ? THEN d.Lines ELSE 0 END)      AS linesPrior
    FROM v_sales_product_daily d
    WHERE ((d.OrderDate BETWEEN ? AND ?) OR (d.OrderDate BETWEEN ? AND ?))
      AND ${scope.clause}${companyClause}
      AND d.Company NOT IN (?)
    GROUP BY d.ProductCompanyKey, COALESCE(d.UoM, '')`;
  const cur = [period.from, period.to];
  const prior = [period.priorFrom, period.priorTo];
  const salesParams: Array<string | number> = [
    ...cur, ...cur, ...cur, ...cur, ...cur, ...prior, ...prior, ...cur, ...prior,
    ...cur, ...prior, ...scope.params,
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
    fetchBcgPeriod(pool, period.from, period.to, EXCLUDED_COMPANIES),
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
  thresholds = withBcgThresholds(thresholds); // server-side; publicThresholds() is what the response carries
  const buckets = agingBucketDefs(thresholds);

  const orderDaysOf = new Map((orderDayRows as any[]).map((r) => [String(r.k), num(r.orderDays)]));
  const soldAnywhere = new Set((soldRows as any[]).map((r) => String(r.k)));
  const odooBase = odooConfiguredBaseUrl();
  // Status of the period (productPortfolio.ts): Unclassified / Dormant from the ETL, else Active = sold in the period.
  const bcgByKey = new Map(bcgWindows.map((w) => [w.k, w]));
  const statusOf = (p: any): ProductStatus => productStatusOf(p, Boolean(bcgByKey.get(String(p?.ProductCompanyKey))?.sold));
  const products: ProductDashboardRow[] = [];
  const viewRows = (productRows as any[]).filter((r) => {
    const company = String(r.Company ?? '');
    return (!allowedCompanies || allowedCompanies.has(company)) && (view === 'BMH' || company === view);
  });
  const rawByKey = new Map(viewRows.map((r) => [String(r.ProductCompanyKey), r]));
  // The pages list the PORTFOLIO only (2026-11-15): Active + Non Active, whatever OnProductPages says -- Dormant and
  // Unclassified are counted by the status cards alone. (A catalog-only product the ETL kept off the pages, e.g. a PoS gift
  // card, is Non Active: it is listed, like any never-sold product, until ProductExclusions.xlsx excludes it.)
  for (const p of viewRows.filter((r) => isPortfolioStatus(statusOf(r)))) {
    const key = String(p.ProductCompanyKey);
    const a = byProduct.get(key);
    const soldInScope = Boolean(a && (a.lines > 0 || a.linesPrior > 0));
    if (scoped && !soldInScope && (query.salespersonTier || soldAnywhere.has(key))) continue;
    products.push(toRow(key, p, a, period.days, [String(p.Company ?? '')], [partOf(p, a)], orderDaysOf.get(key) ?? 0, odooBase, buckets));
  }

  // Status of the period, BCG of the PORTFOLIO (Active + Non Active, 2026-11-15), movement vs the prior period. A Non Active
  // product with no sale in the period has zero volume and no margin: Dogs (never "missing cost": there is no sale to cost).
  const rule = bcgRule(thresholds);
  const volumeScale = period.isDefault ? 1 : period.days / 365;
  const classOf = new Map<string, BcgResult>();
  for (const p of viewRows) {
    const key = String(p.ProductCompanyKey);
    if (!isPortfolioStatus(statusOf(p))) continue;
    const w = bcgByKey.get(key);
    classOf.set(key, w && w.sold ? classifyPeriod(w, rule, volumeScale) : {
      bcgClass: classify(String(p.Company ?? ''), w?.qty ?? 0, null, rule, volumeScale),
      volume: w?.qty ?? 0, value: w?.value ?? 0, profit: null, grossProfitPct: null, missingCost: false, dataAsOf: w?.lastDate ?? null,
    });
  }
  const soldKeys = new Set(bcgWindows.filter((w) => w.sold).map((w) => w.k));
  const movementRule = movementConfig(thresholds);
  for (const r of products) {
    r.productStatus = statusOf(rawByKey.get(r.productCompanyKey));
    const b = classOf.get(r.productCompanyKey);
    r.bcgClass = b?.bcgClass ?? null;
    r.bcgVolume = b?.volume ?? null;
    r.bcgValue = b?.value ?? null;
    r.bcgProfit = b?.profit ?? null;
    r.bcgGrossProfitPct = b?.grossProfitPct ?? null;
    r.missingCost = b ? b.missingCost : null;
    r.bcgDataAsOf = b?.dataAsOf ?? null;
    r.bcgMovement = movementOf(r, period, movementRule);
  }

  const statuses = new Map(viewRows.map((r) => [String(r.ProductCompanyKey), statusOf(r)]));

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
    thresholds: { ...publicThresholds(thresholds), freshness_targets: { ...FRESHNESS_TARGET_PCT } },
    products,
    totals: { value: totalValue, lines: totalLines, volumeByUom: uomList(totalQty) },
    intercompanyValue,
    profitAccess: true,
    ...statusSummaryOf(viewRows, statuses, classOf, soldKeys),
    ...(query.includeSkuList ? { skuList: skuListOf(viewRows, statuses, classOf, byProduct, odooBase, soldKeys) } : {}),
  };
}

/** The config minus the BCG class thresholds (volume / GP%): they never leave the server. */
export function publicThresholds(thresholds: Record<string, unknown>): Record<string, unknown> {
  const bcg = { ...((thresholds.bcg ?? {}) as Record<string, unknown>) };
  delete bcg.volume_threshold;
  delete bcg.profit_threshold_pct;
  delete bcg.excluded_category_ids;
  return { ...thresholds, bcg };
}

const PROFIT_ROW_FIELDS = ['grossProfitPct', 'bcgProfit', 'bcgGrossProfitPct', 'missingCost'] as const;

/** Every PROFIT DATA field removed (no View on profit_data): profit, GP%, cost, missingCost -- in the rows and the cards. */
export function withoutProfit(o: ProductDashboardOverview): ProductDashboardOverview {
  const products = o.products.map((r) => {
    const rest = { ...r };
    for (const key of PROFIT_ROW_FIELDS) delete rest[key];
    return rest;
  });
  const statusSummary = o.statusSummary && {
    ...o.statusSummary,
    bcg: {
      classes: o.statusSummary.bcg.classes.map((c) => {
        const rest = { ...c };
        delete rest.profit;
        return rest;
      }),
    },
  };
  const skuList = o.skuList?.map((r) => {
    const rest = { ...r };
    delete rest.profit;
    delete rest.grossProfitPct;
    return rest;
  });
  return { ...o, products, statusSummary, ...(skuList ? { skuList } : {}), profitAccess: false };
}

interface MovementRule {
  bandPct: number;
  newWithinDays: number;
  /** Discontinued = no sale in this many days (lifecycle.discontinued_no_sales_days, the Product Lifecycle rule). */
  noSalesDays: number;
}

function movementConfig(thresholds: Record<string, unknown>): MovementRule {
  const bcg = (thresholds.bcg ?? {}) as { movement_stable_band_pct?: number };
  const lifecycle = (thresholds.lifecycle ?? {}) as { new_first_sale_within_days?: number; discontinued_no_sales_days?: number };
  return {
    bandPct: Number(bcg.movement_stable_band_pct ?? 10),
    newWithinDays: Number(lifecycle.new_first_sale_within_days ?? 180),
    noSalesDays: Number(lifecycle.discontinued_no_sales_days ?? 365),
  };
}

/** Product Movement on volume, the period vs the prior period of the same length (2026-11-15):
 * Discontinued = no sale in the last `noSalesDays` days before the period end -- the Product Lifecycle rule, so the word
 * means one thing everywhere (archived products are Dormant and never listed); New = first sale within the config days
 * of the period end, or nothing sold in the prior period; Improved / Drop = growth above +band / below -band; Stable
 * within. Never sold, or not sold in either period while still sold within the no-sales window = no movement. */
export function movementOf(r: ProductDashboardRow, period: ProductPeriod, rule: MovementRule): ProductDashboardRow['bcgMovement'] {
  const end = DateTime.fromISO(period.to);
  const last = r.lastSaleDate ? DateTime.fromISO(r.lastSaleDate) : null;
  if (last && end.diff(last, 'days').days >= rule.noSalesDays) return 'Discontinued';
  if (r.lines <= 0 && r.volumePrior === 0 && r.valuePrior === 0) return null;
  const first = r.firstSaleDate ? DateTime.fromISO(r.firstSaleDate) : null;
  if ((first && end.diff(first, 'days').days < rule.newWithinDays) || (r.volumePrior <= 0 && r.volume > 0)) return 'New';
  if (r.volumePrior <= 0) return 'Stable';
  const growth = ((r.volume - r.volumePrior) / r.volumePrior) * 100;
  if (growth > rule.bandPct) return 'Improved';
  if (growth < -rule.bandPct) return 'Drop';
  return 'Stable';
}

/** The SKUs of the status cards: the view's company rows grouped by Odoo variant id (a nullable OdooProductID marks
 * catalog membership even when core conformance uses ProductKey = -1). Rows without a real id are not SKUs. Shared by
 * the cards (statusSummaryOf) and the status table (skuListOf), so both count the same SKUs. */
export function groupBySku(rows: any[]): Map<string, any[]> {
  const catalog = new Map<string, any[]>();
  for (const p of rows) {
    const id = String(p.OdooProductID === undefined ? p.ProductKey : p.OdooProductID);
    if (!/^[1-9]\d*$/.test(id)) continue;
    const parts = catalog.get(id) ?? [];
    parts.push(p);
    catalog.set(id, parts);
  }
  return catalog;
}

function statusInputOf(p: any, statuses: Map<string, ProductStatus>, classOf: Map<string, BcgResult>, soldKeys: Set<string>): StatusInput {
  const key = String(p.ProductCompanyKey);
  return {
    status: statuses.get(key) ?? null,
    sold: soldKeys.has(key),
    archived: isArchivedRow(p),
    onHandQty: num(p.OnHandQty),
    onHandValue: num(p.OnHandValue),
    bcg: classOf.get(key) ?? null,
  };
}

/** The status table (GET <page>/products): one row per SKU of groupBySku, its status from combineSkuStatus -- the cards'
 * own rule -- so the rows per status equal the cards. Period sums add up the variant's company rows. */
export function skuListOf(rows: any[], statuses: Map<string, ProductStatus>, classOf: Map<string, BcgResult>,
  byProduct: Map<string, Agg>, odooBase: string | null, soldKeys: Set<string> = new Set()): ProductStatusSkuRow[] {
  const out: ProductStatusSkuRow[] = [];
  for (const [id, parts] of groupBySku(rows)) {
    const combined = combineSkuStatus(parts.map((p) => statusInputOf(p, statuses, classOf, soldKeys)));
    const status = combined.status as ProductStatus;
    const aggOf = (p: any) => byProduct.get(String(p.ProductCompanyKey));
    // The row's face: the excluded company row for Unclassified, else the company row with the most sales.
    const primary = (status === 'Unclassified' ? parts.find((p) => statuses.get(String(p.ProductCompanyKey)) === 'Unclassified') : undefined)
      ?? [...parts].sort((a, b) => (aggOf(b)?.value ?? 0) - (aggOf(a)?.value ?? 0))[0];
    const aggs = parts.map(aggOf);
    const value = aggs.reduce((t, a) => t + (a?.value ?? 0), 0);
    const sold = aggs.filter((a): a is Agg => Boolean(a && a.lines > 0));
    const costed = sold.length > 0 && sold.every((a) => a.uncosted === 0);
    const profit = costed ? sold.reduce((t, a) => t + a.value - a.cost, 0) : null;
    const lastSale = parts.map((p) => isoDate(p.LastSaleDate)).filter((d): d is string => d !== null).sort().pop() ?? null;
    const byProductSheet = parts.some((p) => num(p.ExcludedByProduct) === 1);
    const byCategorySheet = parts.find((p) => num(p.ExcludedByCategory) === 1);
    out.push({
      odooProductId: id,
      productName: String(primary.ProductName ?? primary.OdooProductName ?? id),
      sku: str(primary.SKU),
      companies: [...new Set(parts.map((p) => String(p.Company ?? '')))],
      category: str(primary.Category),
      brand: str(primary.Brand),
      status,
      bcgClass: isPortfolioStatus(status) ? ((combined.bcg?.bcgClass as BcgClassKey | undefined) ?? null) : null,
      units: aggs.reduce((t, a) => t + (a ? sumQty(a.qty) : 0), 0),
      unitsPrior: aggs.reduce((t, a) => t + (a ? sumQty(a.qtyPrior) : 0), 0),
      value,
      profit,
      grossProfitPct: profit !== null && value !== 0 ? (profit / value) * 100 : null,
      onHandQty: parts.reduce((t, p) => t + num(p.OnHandQty), 0),
      lastSaleDate: lastSale,
      odooUrl: odooFormUrl(odooBase, 'product.product', Number(primary.ProductKey), numOrNull(primary.CompanyKey)),
      withStock: status === 'NonActive' && combined.onHandQty > 0,
      withSales: status === 'NonActive' && combined.sold,
      idle: status === 'Dormant' && !combined.archived,
      archived: parts.some((p) => p.IsActive !== null && p.IsActive !== undefined && num(p.IsActive) === 0),
      archivedDate: null,
      exclusionRule: status !== 'Unclassified' ? null
        : (parts.map((p) => str(p.ExclusionRule)).find((r) => r !== null) ?? null) ?? (byProductSheet ? 'ProductExclusions.xlsx · Products sheet (product excluded)'
          : byCategorySheet ? `ProductExclusions.xlsx · Categories sheet · ${str(byCategorySheet.Category) ?? 'category'}`
            : 'Unclassified by the ETL (rule not recorded)'),
    });
  }
  return out;
}

/** The status cards, or why they cannot be shown (never fails the whole response: the other Product pages share it). */
function statusSummaryOf(rows: any[], statuses: Map<string, ProductStatus>, classOf: Map<string, BcgResult>, soldKeys: Set<string>) {
  try {
    const skus = [...groupBySku(rows).values()].map((parts) => combineSkuStatus(parts.map((p) => statusInputOf(p, statuses, classOf, soldKeys))));
    return { statusSummary: summarizeProductStatus(skus), statusSummaryError: null };
  } catch (err) {
    console.error('[productDashboard] status summary check failed:', err);
    return { statusSummary: null, statusSummaryError: (err as Error).message };
  }
}

export interface StatusInput {
  status: string | null;
  /** Sold in the selected period (any company row of the SKU). */
  sold?: boolean;
  /** Archived in Odoo (every company row of the SKU, once combined). */
  archived?: boolean;
  onHandQty: number;
  onHandValue: number;
  /** The portfolio (Active / Non Active) product's BCG of the period (units, value, profit); null otherwise. */
  bcg: Pick<BcgResult, 'bcgClass' | 'volume' | 'value' | 'profit' | 'missingCost'> | null;
}

/** Shared variants count once (2026-11-15 rules on the SKU): any Unclassified row > every row archived (Dormant) > the
 * live rows' sales in the period and summed stock on hand (Active / Non Active / Dormant). The BCG comes from the live
 * portfolio row with the most sales value; units, value and profit add up over those rows. */
export function combineSkuStatus(parts: StatusInput[]): StatusInput {
  const excluded = parts.find((part) => part.status === 'Unclassified');
  if (excluded) return excluded;
  // eslint-disable-next-line no-unused-vars -- parameter names of a function type (the base rule misreads them)
  const sum = (rows: StatusInput[], f: (r: StatusInput) => number) => rows.reduce((t, r) => t + f(r), 0);
  const archived = (part: StatusInput) => part.archived ?? part.status === 'Dormant';
  const live = parts.filter((part) => !archived(part));
  if (live.length === 0) {
    return { status: 'Dormant', sold: parts.some((p) => p.sold), archived: true, onHandQty: sum(parts, (p) => p.onHandQty),
      onHandValue: sum(parts, (p) => p.onHandValue), bcg: null };
  }
  const sold = live.some((part) => part.sold ?? part.status === 'Active');
  const onHandQty = sum(live, (p) => p.onHandQty);
  const status = statusFromSalesAndStock(sold, onHandQty > 0);
  const base = { status, sold, archived: false, onHandQty, onHandValue: sum(live, (p) => p.onHandValue) };
  if (status === 'Dormant') return { ...base, bcg: null };
  const classed = live.filter((part) => part.bcg);
  if (classed.length === 0) return { ...base, bcg: null };
  const primary = [...classed].sort((x, y) => (y.bcg!.value) - (x.bcg!.value))[0];
  return {
    ...base,
    bcg: {
      bcgClass: primary.bcg!.bcgClass,
      volume: sum(classed, (p) => p.bcg!.volume),
      value: sum(classed, (p) => p.bcg!.value),
      profit: sum(classed, (p) => p.bcg!.profit ?? 0),
      missingCost: classed.some((p) => p.bcg!.missingCost),
    },
  };
}

/** Total SKUs = Unclassified + Dormant + Active + Non Active, and Stars + Cash Cows + Strategic + Dogs = Active + Non Active
 * (the portfolio, 2026-11-15). Throws when a row has no known status, a portfolio product has no class, or a sum is off. */
export function summarizeProductStatus(rows: StatusInput[]): ProductStatusSummary {
  const out: ProductStatusSummary = {
    total: rows.length,
    active: { count: 0, units: 0, value: 0, onHandQty: 0, onHandValue: 0 },
    nonActive: { count: 0, withStock: 0, withSales: 0, zeroStock: 0, stockUnits: 0, stockValue: 0, onHandQty: 0, onHandValue: 0 },
    dormant: { count: 0, archived: 0, idle: 0, onHandQty: 0, onHandValue: 0 },
    unclassified: { count: 0, onHandQty: 0, onHandValue: 0 },
    bcg: { classes: BCG_CLASS_KEYS.map((key) => ({ key, count: 0, units: 0, value: 0, profit: 0 })), missingCost: 0 },
  };
  const addBcg = (r: StatusInput) => {
    const cls = out.bcg.classes.find((c) => c.key === r.bcg?.bcgClass);
    if (!cls || !r.bcg) throw new Error(`Product status check failed: a ${r.status} product has no BCG class`);
    cls.count += 1;
    cls.units += r.bcg.volume;
    cls.value += r.bcg.value;
    cls.profit = (cls.profit ?? 0) + (r.bcg.profit ?? 0);
    if (r.bcg.missingCost) out.bcg.missingCost = (out.bcg.missingCost ?? 0) + 1;
  };
  // every status: the On Hand of its SKUs (quantity and value), the same per-SKU On Hand the status rule read
  const addOnHand = (bucket: OnHandTotals, r: StatusInput) => {
    bucket.onHandQty += r.onHandQty;
    bucket.onHandValue += r.onHandValue;
  };
  for (const r of rows) {
    const bucket: OnHandTotals | null = r.status === 'Unclassified' ? out.unclassified : r.status === 'Dormant' ? out.dormant
      : r.status === 'NonActive' ? out.nonActive : r.status === 'Active' ? out.active : null;
    if (bucket) addOnHand(bucket, r);
    switch (r.status) {
      case 'Unclassified':
        out.unclassified.count += 1;
        break;
      case 'Dormant':
        out.dormant.count += 1;
        if (r.archived ?? true) out.dormant.archived += 1;
        else out.dormant.idle += 1;
        break;
      case 'NonActive':
        out.nonActive.count += 1;
        if (r.onHandQty > 0) {
          out.nonActive.withStock += 1;
          out.nonActive.stockUnits += r.onHandQty;
          out.nonActive.stockValue += r.onHandValue;
        } else {
          out.nonActive.withSales += 1;
        }
        addBcg(r);
        break;
      case 'Active':
        out.active.count += 1;
        out.active.units += r.bcg?.volume ?? 0;
        out.active.value += r.bcg?.value ?? 0;
        addBcg(r);
        break;
      default:
        throw new Error(`Product status check failed: unknown ProductStatus ${JSON.stringify(r.status)}`);
    }
  }
  out.nonActive.zeroStock = out.nonActive.withSales;
  const statusSum = out.unclassified.count + out.dormant.count + out.active.count + out.nonActive.count;
  if (statusSum !== out.total) {
    throw new Error(`Product status check failed: Total SKUs ${out.total} != Unclassified + Dormant + Active + Non Active ${statusSum}`);
  }
  const bcgSum = out.bcg.classes.reduce((t, c) => t + c.count, 0);
  if (bcgSum !== out.active.count + out.nonActive.count) {
    throw new Error(`Product status check failed: Stars + Cash Cows + Strategic + Dogs ${bcgSum} != Active + Non Active ${out.active.count + out.nonActive.count}`);
  }
  if (out.nonActive.withStock + out.nonActive.withSales !== out.nonActive.count) {
    throw new Error('Product status check failed: Non Active with stock + with sales != Non Active');
  }
  return out;
}
