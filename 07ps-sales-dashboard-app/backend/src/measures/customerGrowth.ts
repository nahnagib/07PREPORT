/**
 * Customer Growth page metric definitions.
 *
 * Source tables (confirmed against the live throwaway/validation warehouse, same DB every other
 * page reads from -- not a second data source):
 *
 *   Dim_Customer  -- one row per customer. Static/slow-changing attributes only: CustomerKey,
 *                     customer (name), First_Purchase_Date, Last_Purchase_Date, CustomerSegment
 *                     ('B2B'/'B2C'/'Unknown'), CustomerClass_LY (A/B/C/D, already computed
 *                     upstream from last-year value thresholds -- kept as-is, same "already
 *                     computed in source" convention as Invoices Engine's `Invoice Class`), and
 *                     IsBlocked (a true operational flag, independent of purchase behavior).
 *                     Dim_Customer also carries LY_Value/YTD_Value/CustomerStatus fields, but
 *                     those are frozen at the last ETL run relative to the pipeline's own "today"
 *                     -- not reactive to this page's anchorDate/Year selector -- so they are
 *                     deliberately NOT used here. Every YTD/LYTD-derived figure below is instead
 *                     computed live from Fact_SalesLines, exactly like every other page.
 *   Fact_SalesLines -- CustomerKey (joins to Dim_Customer), DateKey, Value, plus the same
 *                     CompanyKey/SegmentKey/ChannelKey/SalesTeamKey/SalespersonKey columns
 *                     buildWhereClause already filters on everywhere else.
 *
 * Customer status (Active Retained / Non Active / Reactivated / New / Other / Blocked) is
 * computed live by classifyCustomerStatus() below, reproducing the page spec's exact business
 * definitions against a single per-customer activity snapshot (fetchCustomerActivitySnapshot) --
 * this is what lets the Customers Trend "click a year" page-filter meaningfully re-scope the
 * Customer Status panel, which a frozen per-refresh snapshot field could never do. Blocked always
 * wins over the YTD/LYTD-derived label (an operational lock, not a purchase-behavior signal),
 * matching the spec's "regardless of purchasing behavior" framing.
 */

import type { Pool } from 'mysql2/promise';
import {
  buildWhereClause,
  dateOnlyUTC,
  lmtdWindow,
  lytdWindow,
  mtdWindow,
  ytdWindow,
  type DateWindow,
  type Filters,
} from './filters';

function toDateOnlyString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface CustomerGrowthScope {
  /** Restricts to a single calendar year -- sourced from a Customers Trend bar/point click in
   * page-filter mode. Same anchorForYear remap convention as invoicesEngine.ts's Sales Trend Year
   * filter: every windowed (YTD/LYTD/MTD/LMTD-style) query remaps its anchor into this year rather
   * than intersecting the window with a `Year = ?` clause. */
  year?: number;
}

function anchorForYear(anchor: Date, year: number | undefined): Date {
  if (year === undefined) return anchor;
  return dateOnlyUTC(year, anchor.getUTCMonth() + 1, anchor.getUTCDate());
}

function fullYearWindow(year: number): DateWindow {
  return { start: dateOnlyUTC(year, 1, 1), end: dateOnlyUTC(year, 12, 31) };
}

// ---------------------------------------------------------------------------
// Per-customer activity snapshot -- one pass over Fact_SalesLines, grouped by CustomerKey. Backs
// every status classification below and the Customers Table's YTD Value column. Computed once per
// request and reused (see computeCustomerGrowthOverview) rather than re-queried per consumer.
// ---------------------------------------------------------------------------

export interface CustomerActivity {
  customerKey: number;
  ytdValue: number;
  hasYtd: boolean;
  hasLytd: boolean;
  /** Has at least one sale strictly before the LYTD window's start -- "purchase history prior to
   * that LYTD period" per the Reactivated definition. */
  hasBeforeLytd: boolean;
}

export async function fetchCustomerActivitySnapshot(
  pool: Pool,
  effectiveAnchor: Date,
  filters: Filters,
): Promise<Map<number, CustomerActivity>> {
  const { clause, params } = buildWhereClause(filters, 'fsl');
  const ytd = ytdWindow(effectiveAnchor);
  const lytd = lytdWindow(effectiveAnchor);
  const sql = `
    SELECT
      fsl.CustomerKey AS customerKey,
      COALESCE(SUM(CASE WHEN dd.Date BETWEEN ? AND ? THEN fsl.Value ELSE 0 END), 0) AS ytdValue,
      MAX(CASE WHEN dd.Date BETWEEN ? AND ? THEN 1 ELSE 0 END) AS hasYtd,
      MAX(CASE WHEN dd.Date BETWEEN ? AND ? THEN 1 ELSE 0 END) AS hasLytd,
      MAX(CASE WHEN dd.Date < ? THEN 1 ELSE 0 END) AS hasBeforeLytd
    FROM Fact_SalesLines fsl
    JOIN Dim_Date dd ON fsl.DateKey = dd.DateKey
    WHERE ${clause}
    GROUP BY fsl.CustomerKey
  `;
  const [rows] = await pool.query(sql, [
    toDateOnlyString(ytd.start), toDateOnlyString(ytd.end),
    toDateOnlyString(ytd.start), toDateOnlyString(ytd.end),
    toDateOnlyString(lytd.start), toDateOnlyString(lytd.end),
    toDateOnlyString(lytd.start),
    ...params,
  ]);
  const map = new Map<number, CustomerActivity>();
  for (const r of rows as any[]) {
    map.set(Number(r.customerKey), {
      customerKey: Number(r.customerKey),
      ytdValue: Number(r.ytdValue),
      hasYtd: Number(r.hasYtd) === 1,
      hasLytd: Number(r.hasLytd) === 1,
      hasBeforeLytd: Number(r.hasBeforeLytd) === 1,
    });
  }
  return map;
}

interface CustomerDimRow {
  customerKey: number;
  name: string;
  firstPurchaseDate: string | null;
  lastPurchaseDate: string | null;
  customerSegment: string | null;
  customerClass: string | null;
  isBlocked: boolean;
}

async function fetchCustomerDim(pool: Pool): Promise<Map<number, CustomerDimRow>> {
  const sql = `
    SELECT
      CustomerKey AS customerKey,
      customer AS name,
      First_Purchase_Date AS firstPurchaseDate,
      Last_Purchase_Date AS lastPurchaseDate,
      CustomerSegment AS customerSegment,
      CustomerClass_LY AS customerClass,
      IsBlocked AS isBlocked
    FROM Dim_Customer
  `;
  const [rows] = await pool.query(sql);
  const map = new Map<number, CustomerDimRow>();
  for (const r of rows as any[]) {
    map.set(Number(r.customerKey), {
      customerKey: Number(r.customerKey),
      name: String(r.name ?? `Customer ${r.customerKey}`),
      firstPurchaseDate: r.firstPurchaseDate ? toDateOnlyString(r.firstPurchaseDate) : null,
      lastPurchaseDate: r.lastPurchaseDate ? toDateOnlyString(r.lastPurchaseDate) : null,
      customerSegment: r.customerSegment ?? null,
      customerClass: r.customerClass ?? null,
      isBlocked: Number(r.isBlocked) === 1,
    });
  }
  return map;
}

export type CustomerStatusLabel = 'Active Retained' | 'Non Active' | 'Reactivated' | 'New' | 'Other' | 'Blocked';

/**
 * Pure classifier, mirrors classify.ts's classifyVsTarget style. Reproduces the page spec's Zone A
 * definitions exactly; its 5 non-Blocked outputs map 1:1 onto the Status Slicer's 5 options
 * (Active Retained / New / Non Active / Reactivated / Other).
 */
export function classifyCustomerStatus(activity: CustomerActivity | undefined, isBlocked: boolean): CustomerStatusLabel {
  if (isBlocked) return 'Blocked';
  const hasYtd = activity?.hasYtd ?? false;
  const hasLytd = activity?.hasLytd ?? false;
  const hasBeforeLytd = activity?.hasBeforeLytd ?? false;
  if (hasYtd && hasLytd) return 'Active Retained';
  if (hasLytd && !hasYtd) return 'Non Active';
  if (hasYtd && !hasLytd && hasBeforeLytd) return 'Reactivated';
  if (hasYtd && !hasLytd && !hasBeforeLytd) return 'New';
  return 'Other';
}

export interface CustomerRow {
  customerKey: number;
  name: string;
  ytdValue: number;
  firstPurchaseDate: string | null;
  lastPurchaseDate: string | null;
  customerSegment: string | null;
  customerClass: string | null;
  status: CustomerStatusLabel;
}

/** Every customer with at least one sale matching `filters` (all-time, no date bound), joined to
 * Dim_Customer's static attributes and classified. Backs both the Zone A Customer Status counts
 * (tallyCustomerStatusCounts) and the Details view's Customers Table + Status Slicer -- computed
 * once so the two can never disagree. */
export async function fetchCustomerRows(pool: Pool, effectiveAnchor: Date, filters: Filters): Promise<CustomerRow[]> {
  const [activityMap, dimMap] = await Promise.all([
    fetchCustomerActivitySnapshot(pool, effectiveAnchor, filters),
    fetchCustomerDim(pool),
  ]);
  const rows: CustomerRow[] = [];
  for (const [customerKey, activity] of activityMap) {
    const dim = dimMap.get(customerKey);
    rows.push({
      customerKey,
      name: dim?.name ?? `Customer ${customerKey}`,
      ytdValue: activity.ytdValue,
      firstPurchaseDate: dim?.firstPurchaseDate ?? null,
      lastPurchaseDate: dim?.lastPurchaseDate ?? null,
      customerSegment: dim?.customerSegment ?? null,
      customerClass: dim?.customerClass ?? null,
      status: classifyCustomerStatus(activity, dim?.isBlocked ?? false),
    });
  }
  return rows;
}

export interface CustomerStatusCounts {
  activeRetained: number;
  nonActive: number;
  blocked: number;
  reactivated: number;
}

export function tallyCustomerStatusCounts(rows: CustomerRow[]): CustomerStatusCounts {
  const counts: CustomerStatusCounts = { activeRetained: 0, nonActive: 0, blocked: 0, reactivated: 0 };
  for (const r of rows) {
    if (r.status === 'Active Retained') counts.activeRetained += 1;
    else if (r.status === 'Non Active') counts.nonActive += 1;
    else if (r.status === 'Blocked') counts.blocked += 1;
    else if (r.status === 'Reactivated') counts.reactivated += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Zone A -- New Customers / Total Customers, all four periods (LYTD/YTD/LMTD/MTD).
// ---------------------------------------------------------------------------

export interface PeriodCustomerCounts {
  ytd: number;
  lytd: number;
  mtd: number;
  lmtd: number;
}

async function fetchDistinctCustomerCount(pool: Pool, window: DateWindow, filters: Filters): Promise<number> {
  const { clause, params } = buildWhereClause(filters, 'fsl');
  const sql = `
    SELECT COUNT(DISTINCT fsl.CustomerKey) AS cnt
    FROM Fact_SalesLines fsl
    JOIN Dim_Date dd ON fsl.DateKey = dd.DateKey
    WHERE dd.Date BETWEEN ? AND ? AND ${clause}
  `;
  const [rows] = await pool.query(sql, [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]);
  return Number((rows as any[])[0].cnt);
}

/** A customer counts as "new" in `window` if they have a sale in the window AND their all-time
 * first purchase (Dim_Customer.First_Purchase_Date) also falls within that same window. */
async function fetchNewCustomerCount(pool: Pool, window: DateWindow, filters: Filters): Promise<number> {
  const { clause, params } = buildWhereClause(filters, 'fsl');
  const sql = `
    SELECT COUNT(DISTINCT fsl.CustomerKey) AS cnt
    FROM Fact_SalesLines fsl
    JOIN Dim_Date dd ON fsl.DateKey = dd.DateKey
    JOIN Dim_Customer dc ON dc.CustomerKey = fsl.CustomerKey
    WHERE dd.Date BETWEEN ? AND ?
      AND dc.First_Purchase_Date BETWEEN ? AND ?
      AND ${clause}
  `;
  const [rows] = await pool.query(sql, [
    toDateOnlyString(window.start), toDateOnlyString(window.end),
    toDateOnlyString(window.start), toDateOnlyString(window.end),
    ...params,
  ]);
  return Number((rows as any[])[0].cnt);
}

export async function computeTotalCustomers(
  pool: Pool,
  anchor: Date,
  filters: Filters,
  scope: CustomerGrowthScope = {},
): Promise<PeriodCustomerCounts> {
  const effectiveAnchor = anchorForYear(anchor, scope.year);
  const [ytd, lytd, mtd, lmtd] = await Promise.all([
    fetchDistinctCustomerCount(pool, ytdWindow(effectiveAnchor), filters),
    fetchDistinctCustomerCount(pool, lytdWindow(effectiveAnchor), filters),
    fetchDistinctCustomerCount(pool, mtdWindow(effectiveAnchor), filters),
    fetchDistinctCustomerCount(pool, lmtdWindow(effectiveAnchor), filters),
  ]);
  return { ytd, lytd, mtd, lmtd };
}

export async function computeNewCustomers(
  pool: Pool,
  anchor: Date,
  filters: Filters,
  scope: CustomerGrowthScope = {},
): Promise<PeriodCustomerCounts> {
  const effectiveAnchor = anchorForYear(anchor, scope.year);
  const [ytd, lytd, mtd, lmtd] = await Promise.all([
    fetchNewCustomerCount(pool, ytdWindow(effectiveAnchor), filters),
    fetchNewCustomerCount(pool, lytdWindow(effectiveAnchor), filters),
    fetchNewCustomerCount(pool, mtdWindow(effectiveAnchor), filters),
    fetchNewCustomerCount(pool, lmtdWindow(effectiveAnchor), filters),
  ]);
  return { ytd, lytd, mtd, lmtd };
}

// ---------------------------------------------------------------------------
// Zone B (right) -- Rates. Pure derivation from the figures above, no DB access of its own.
// ---------------------------------------------------------------------------

export interface CustomerGrowthRates {
  customerAcquisitionPct: number | null;
  customerGrowthPct: number | null;
  retentionRatePct: number | null;
  churnRatePct: number | null;
}

function safeDiv(numerator: number, denominator: number): number | null {
  if (!denominator) return null;
  return numerator / denominator;
}

/** Churn + Retention may not sum to 100% -- Reactivated customers weren't part of the LYTD base
 * but are counted in Retention. Expected, per the page spec, not a bug. */
export function computeRates(
  newCustomers: PeriodCustomerCounts,
  totalCustomers: PeriodCustomerCounts,
  statusCounts: CustomerStatusCounts,
): CustomerGrowthRates {
  return {
    customerAcquisitionPct: safeDiv(newCustomers.ytd - newCustomers.lytd, newCustomers.lytd),
    customerGrowthPct: safeDiv(totalCustomers.ytd - totalCustomers.lytd, totalCustomers.lytd),
    retentionRatePct: safeDiv(statusCounts.activeRetained + statusCounts.reactivated, totalCustomers.lytd),
    churnRatePct: safeDiv(statusCounts.nonActive, totalCustomers.lytd),
  };
}

// ---------------------------------------------------------------------------
// Zone B (left) -- Customers Trend: Total Sales Value + Customer Count, by Year. Drillable only in
// the sense that it PRODUCES the Year page-filter -- deliberately ignores scope.year itself (same
// self-exclusion convention as invoicesEngine.ts's Sales Trend), always shows the full series.
// ---------------------------------------------------------------------------

export interface CustomerYearPoint {
  year: number;
  label: string;
  totalSalesValue: number;
  customerCount: number;
}

export async function fetchCustomersTrendByYear(pool: Pool, anchor: Date, filters: Filters): Promise<CustomerYearPoint[]> {
  const { clause, params } = buildWhereClause(filters, 'fsl');
  const sql = `
    SELECT
      dd.Year AS year,
      COALESCE(SUM(fsl.Value), 0) AS totalSalesValue,
      COUNT(DISTINCT fsl.CustomerKey) AS customerCount
    FROM Fact_SalesLines fsl
    JOIN Dim_Date dd ON fsl.DateKey = dd.DateKey
    WHERE dd.Date <= ? AND ${clause}
    GROUP BY dd.Year
    ORDER BY dd.Year
  `;
  const [rows] = await pool.query(sql, [toDateOnlyString(anchor), ...params]);
  return (rows as any[]).map((r) => ({
    year: Number(r.year),
    label: String(r.year),
    totalSalesValue: Number(r.totalSalesValue),
    customerCount: Number(r.customerCount),
  }));
}

// ---------------------------------------------------------------------------
// Zone C (left) -- Customers Contribution: Top 10 vs Other, by sales value. Honors scope.year
// (window swaps from YTD-as-of-today to the full selected calendar year, same convention as
// invoicesEngine.ts's Invoices Classification). Returns the top 30 individual customers plus an
// aggregated remainder so the frontend can compute exact Top-10/Other totals and drill into
// individual customers without a second round trip, while keeping the response/slice count bounded.
// ---------------------------------------------------------------------------

export interface CustomerContributionRow {
  customerKey: number;
  name: string;
  value: number;
}

export interface CustomersContribution {
  customers: CustomerContributionRow[];
  remainderValue: number;
  remainderCount: number;
}

const CONTRIBUTION_TOP_N = 30;

export async function fetchCustomersContribution(
  pool: Pool,
  anchor: Date,
  filters: Filters,
  scope: CustomerGrowthScope = {},
): Promise<CustomersContribution> {
  const { clause, params } = buildWhereClause(filters, 'fsl');
  const window = scope.year !== undefined ? fullYearWindow(scope.year) : ytdWindow(anchor);
  const sql = `
    SELECT
      fsl.CustomerKey AS customerKey,
      COALESCE(dc.customer, CONCAT('Customer ', fsl.CustomerKey)) AS name,
      COALESCE(SUM(fsl.Value), 0) AS value
    FROM Fact_SalesLines fsl
    JOIN Dim_Date dd ON fsl.DateKey = dd.DateKey
    LEFT JOIN Dim_Customer dc ON dc.CustomerKey = fsl.CustomerKey
    WHERE dd.Date BETWEEN ? AND ? AND ${clause}
    GROUP BY fsl.CustomerKey, dc.customer
    HAVING value > 0
    ORDER BY value DESC
  `;
  const [rows] = await pool.query(sql, [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]);
  const all = (rows as any[]).map((r) => ({
    customerKey: Number(r.customerKey),
    name: String(r.name),
    value: Number(r.value),
  }));
  const customers = all.slice(0, CONTRIBUTION_TOP_N);
  const remainder = all.slice(CONTRIBUTION_TOP_N);
  return {
    customers,
    remainderValue: remainder.reduce((sum, c) => sum + c.value, 0),
    remainderCount: remainder.length,
  };
}

// ---------------------------------------------------------------------------
// Zone C (right) -- Customers Category Performance: Sales LYTM vs YTM by Customer Category
// (Dim_Customer.CustomerClass_LY, A-D). "LYTM"/"YTM" map onto the existing LYTD/YTD windows --
// no new date-period term exists elsewhere in this codebase, so no new one is invented here.
// Honors scope.year via the same anchorForYear remap as everywhere else on this page. Each
// category also carries its top 20 customers by YTD value, for the drill-down (same "return drill
// data eagerly" convention as invoicesEngine.ts's byYearClass).
// ---------------------------------------------------------------------------

export interface CategoryCustomer {
  customerKey: number;
  name: string;
  salesLytm: number;
  salesYtm: number;
}

export interface CategoryPerformanceRow {
  category: string;
  salesLytm: number;
  salesYtm: number;
  customers: CategoryCustomer[];
}

const CATEGORY_ORDER = ['A', 'B', 'C', 'D'];
const CATEGORY_CUSTOMER_TOP_N = 20;

interface ClassSalesRow {
  customerKey: number;
  name: string;
  value: number;
}

async function fetchSalesByCustomerAndClass(pool: Pool, window: DateWindow, filters: Filters): Promise<Map<string, ClassSalesRow[]>> {
  const { clause, params } = buildWhereClause(filters, 'fsl');
  const sql = `
    SELECT
      fsl.CustomerKey AS customerKey,
      dc.customer AS name,
      dc.CustomerClass_LY AS customerClass,
      COALESCE(SUM(fsl.Value), 0) AS value
    FROM Fact_SalesLines fsl
    JOIN Dim_Date dd ON fsl.DateKey = dd.DateKey
    JOIN Dim_Customer dc ON dc.CustomerKey = fsl.CustomerKey
    WHERE dd.Date BETWEEN ? AND ? AND ${clause} AND dc.CustomerClass_LY IS NOT NULL
    GROUP BY fsl.CustomerKey, dc.customer, dc.CustomerClass_LY
  `;
  const [rows] = await pool.query(sql, [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]);
  const byClass = new Map<string, ClassSalesRow[]>();
  for (const r of rows as any[]) {
    const cls = String(r.customerClass);
    const arr = byClass.get(cls) ?? [];
    arr.push({ customerKey: Number(r.customerKey), name: String(r.name), value: Number(r.value) });
    byClass.set(cls, arr);
  }
  return byClass;
}

export async function fetchCategoryPerformance(
  pool: Pool,
  anchor: Date,
  filters: Filters,
  scope: CustomerGrowthScope = {},
): Promise<CategoryPerformanceRow[]> {
  const effectiveAnchor = anchorForYear(anchor, scope.year);
  const [ytmByClass, lytmByClass] = await Promise.all([
    fetchSalesByCustomerAndClass(pool, ytdWindow(effectiveAnchor), filters),
    fetchSalesByCustomerAndClass(pool, lytdWindow(effectiveAnchor), filters),
  ]);

  return CATEGORY_ORDER.map((category) => {
    const ytmRows = ytmByClass.get(category) ?? [];
    const lytmRows = lytmByClass.get(category) ?? [];
    const lytmByCustomer = new Map(lytmRows.map((r) => [r.customerKey, r.value]));
    const salesYtm = ytmRows.reduce((sum, r) => sum + r.value, 0);
    const salesLytm = lytmRows.reduce((sum, r) => sum + r.value, 0);
    const customers = ytmRows
      .map((r) => ({
        customerKey: r.customerKey,
        name: r.name,
        salesYtm: r.value,
        salesLytm: lytmByCustomer.get(r.customerKey) ?? 0,
      }))
      .sort((a, b) => b.salesYtm - a.salesYtm)
      .slice(0, CATEGORY_CUSTOMER_TOP_N);
    return { category, salesLytm, salesYtm, customers };
  });
}

// ---------------------------------------------------------------------------
// Orchestrator -- one /overview endpoint's worth of data in one round trip, same style as
// criticalNumber.ts / computeInvoicesEngineKpis.
// ---------------------------------------------------------------------------

export interface CustomerGrowthKpis {
  newCustomers: PeriodCustomerCounts;
  totalCustomers: PeriodCustomerCounts;
  customerStatus: CustomerStatusCounts;
}

export interface CustomerGrowthOverview {
  kpis: CustomerGrowthKpis;
  rates: CustomerGrowthRates;
  customersTrend: CustomerYearPoint[];
  customersContribution: CustomersContribution;
  categoryPerformance: CategoryPerformanceRow[];
  customersTable: CustomerRow[];
}

export async function computeCustomerGrowthOverview(
  pool: Pool,
  anchor: Date,
  filters: Filters,
  scope: CustomerGrowthScope = {},
): Promise<CustomerGrowthOverview> {
  const effectiveAnchor = anchorForYear(anchor, scope.year);

  const [newCustomers, totalCustomers, customersTable, customersTrend, customersContribution, categoryPerformance] = await Promise.all([
    computeNewCustomers(pool, anchor, filters, scope),
    computeTotalCustomers(pool, anchor, filters, scope),
    fetchCustomerRows(pool, effectiveAnchor, filters),
    fetchCustomersTrendByYear(pool, anchor, filters),
    fetchCustomersContribution(pool, anchor, filters, scope),
    fetchCategoryPerformance(pool, anchor, filters, scope),
  ]);

  const customerStatus = tallyCustomerStatusCounts(customersTable);
  const rates = computeRates(newCustomers, totalCustomers, customerStatus);

  return {
    kpis: { newCustomers, totalCustomers, customerStatus },
    rates,
    customersTrend,
    customersContribution,
    categoryPerformance,
    customersTable,
  };
}
