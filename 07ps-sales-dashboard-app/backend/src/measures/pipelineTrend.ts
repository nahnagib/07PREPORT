/**
 * Pipeline Trend page metric definitions.
 *
 * Read-only diagnostic page (per the page spec) -- no drill-down/click-filter scope needed, just
 * anchorDate + the standard 5 sidebar filters (Fact_Sales-grain queries use buildWhereClause,
 * Fact_Opportunity-grain queries use buildCrmWhereClause -- see filters.ts's header comment on why
 * Opportunity has no ChannelKey column).
 *
 * Quotation Rate KPIs -- "Won ÷ Total Real Quotations" was resolved empirically against the live
 * warehouse this session, not guessed: Fact_Sales.IsWonQuotation is always 0 for every live row
 * (confirmed broken/unusable). Verified instead that IsRealQuotation=1 (still-quotation state) and
 * IsRealSalesOrder=1 (already-converted state) are disjoint by construction and their counts sum
 * exactly to the "real quotation universe" -- that's the Win Rate denominator. OrderState (the raw
 * Odoo sale.order state: sale/cancel/draft/sent) is reused directly as the Open/Lost signal rather
 * than inventing a new status scheme.
 *
 * Lost-exclusion policy: fetchOpportunitiesByMonth (Fact_Opportunity-scoped) excludes closed-lost
 * opportunities via filters.ts's excludeLostClause -- it's a general creation-volume trend, not a
 * lost-specific one. Every other query on this page is Fact_Sales-scoped (Quotation Rates,
 * Quotations/Sales Orders by month, aging), which has no Stage/IsLost concept of its own (its
 * "lost" signal is OrderState='cancel', already tracked separately as lostQuotations/its own
 * aging bucket) -- untouched.
 */

import type { Pool } from 'mysql2/promise';
import { buildCrmWhereClause, buildWhereClause, excludeLostClause, ytdWindow, type DateWindow, type Filters } from './filters';

function toDateOnlyString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function safeDiv(numerator: number, denominator: number): number | null {
  if (!denominator) return null;
  return numerator / denominator;
}

// ---------------------------------------------------------------------------
// Quotation Rates YTD
// ---------------------------------------------------------------------------

export interface QuotationRates {
  totalQuotations: number;
  wonQuotations: number;
  winRatePct: number | null;
  openQuotations: number;
  lostQuotations: number;
  wonLostRatio: number | null;
}

/** DATE(fs.QuotationDate) rather than a raw datetime BETWEEN comparison -- QuotationDate is a
 * datetime column, and comparing it directly against a 'YYYY-MM-DD' upper bound would silently
 * exclude same-day rows with a non-midnight time component. */
async function countQuotationsWhere(pool: Pool, window: DateWindow, filters: Filters, extraClause: string): Promise<number> {
  const { clause, params } = buildWhereClause(filters, 'fs');
  const sql = `
    SELECT COUNT(*) AS cnt
    FROM Fact_Sales fs
    WHERE DATE(fs.QuotationDate) BETWEEN ? AND ? AND ${extraClause} AND ${clause}
  `;
  const [rows] = await pool.query(sql, [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]);
  return Number((rows as any[])[0].cnt);
}

export async function computeQuotationRates(pool: Pool, anchor: Date, filters: Filters): Promise<QuotationRates> {
  const window = ytdWindow(anchor);
  const [total, won, open, lost] = await Promise.all([
    countQuotationsWhere(pool, window, filters, '(fs.IsRealQuotation = 1 OR fs.IsRealSalesOrder = 1)'),
    countQuotationsWhere(pool, window, filters, 'fs.IsRealSalesOrder = 1'),
    countQuotationsWhere(pool, window, filters, "(fs.IsRealQuotation = 1 AND fs.OrderState IN ('draft', 'sent'))"),
    countQuotationsWhere(pool, window, filters, "(fs.IsRealQuotation = 1 AND fs.OrderState = 'cancel')"),
  ]);
  return {
    totalQuotations: total,
    wonQuotations: won,
    winRatePct: safeDiv(won, total),
    openQuotations: open,
    lostQuotations: lost,
    wonLostRatio: safeDiv(won, lost),
  };
}

// ---------------------------------------------------------------------------
// 3 by-month YTD-vs-LYTD combo charts -- Opportunities / Quotations / Sales Orders. Same "up to
// anchor's month only" convention as tachometer.ts's fetchMonthlySeries -- both the YTD and LYTD
// series are clipped to the same month range for an apples-to-apples comparison.
// ---------------------------------------------------------------------------

export interface MonthComparisonPoint {
  month: number;
  label: string;
  countYtd: number;
  countLytd: number;
  valueYtd: number;
  valueLytd: number;
}

async function fetchMonthComparison(
  pool: Pool,
  anchor: Date,
  filters: Filters,
  table: 'Fact_Opportunity' | 'Fact_Sales',
  dateColumn: string,
  valueColumn: string,
  extraWhere: string,
  crmScoped: boolean,
): Promise<MonthComparisonPoint[]> {
  const year = anchor.getUTCFullYear();
  const throughMonth = anchor.getUTCMonth() + 1;
  const { clause, params } = crmScoped ? buildCrmWhereClause(filters, 't') : buildWhereClause(filters, 't');
  const sql = `
    SELECT YEAR(t.${dateColumn}) AS yr, MONTH(t.${dateColumn}) AS mo, COUNT(*) AS cnt, COALESCE(SUM(t.${valueColumn}), 0) AS val
    FROM ${table} t
    WHERE YEAR(t.${dateColumn}) IN (?, ?) AND ${extraWhere} AND ${clause}
    GROUP BY YEAR(t.${dateColumn}), MONTH(t.${dateColumn})
  `;
  const [rows] = await pool.query(sql, [year, year - 1, ...params]);
  const byYearMonth = new Map<string, { cnt: number; val: number }>();
  for (const r of rows as any[]) {
    byYearMonth.set(`${r.yr}-${r.mo}`, { cnt: Number(r.cnt), val: Number(r.val) });
  }
  return Array.from({ length: throughMonth }, (_, i) => i + 1).map((m) => ({
    month: m,
    label: MONTH_LABELS[m - 1],
    countYtd: byYearMonth.get(`${year}-${m}`)?.cnt ?? 0,
    countLytd: byYearMonth.get(`${year - 1}-${m}`)?.cnt ?? 0,
    valueYtd: byYearMonth.get(`${year}-${m}`)?.val ?? 0,
    valueLytd: byYearMonth.get(`${year - 1}-${m}`)?.val ?? 0,
  }));
}

/** Excludes Lost (see filters.ts's excludeLostClause) -- a general opportunity-creation trend, not
 * a lost-specific one. Fact_Sales-scoped siblings below (Quotations/Sales Orders by month) are
 * untouched: Fact_Sales has no Stage/IsLost concept of its own, and those documents already
 * happened regardless of the linked opportunity's current status. */
export function fetchOpportunitiesByMonth(pool: Pool, anchor: Date, filters: Filters): Promise<MonthComparisonPoint[]> {
  return fetchMonthComparison(pool, anchor, filters, 'Fact_Opportunity', 'OpportunityCreatedDate', 'ExpectedRevenue', excludeLostClause('t'), true);
}

/** Same "real quotation universe" (IsRealQuotation=1 OR IsRealSalesOrder=1) as computeQuotationRates,
 * cohorted by QuotationDate's month regardless of whether the row has since converted. */
export function fetchQuotationsByMonth(pool: Pool, anchor: Date, filters: Filters): Promise<MonthComparisonPoint[]> {
  return fetchMonthComparison(pool, anchor, filters, 'Fact_Sales', 'QuotationDate', 'OrderValue', '(t.IsRealQuotation = 1 OR t.IsRealSalesOrder = 1)', false);
}

export function fetchSalesOrdersByMonth(pool: Pool, anchor: Date, filters: Filters): Promise<MonthComparisonPoint[]> {
  return fetchMonthComparison(pool, anchor, filters, 'Fact_Sales', 'OrderDate', 'OrderValue', "(t.SalesDocumentType = 'Sales Order' AND t.IsRealSalesOrder = 1)", false);
}

// ---------------------------------------------------------------------------
// Open Opportunities & Quotations by Aging -- raw counts per bucket; the frontend normalizes each
// category to 100% before handing points to StackedPercentBarChart (a presentation concern, same
// split as every other page returning raw figures for the frontend to format).
// ---------------------------------------------------------------------------

export interface AgingBuckets {
  b0to30: number;
  b30to60: number;
  b60to90: number;
  b90plus: number;
}

function agingCaseSql(dateColumn: string): string {
  return `
    SUM(CASE WHEN DATEDIFF(?, ${dateColumn}) BETWEEN 0 AND 30 THEN 1 ELSE 0 END) AS b0to30,
    SUM(CASE WHEN DATEDIFF(?, ${dateColumn}) BETWEEN 31 AND 60 THEN 1 ELSE 0 END) AS b30to60,
    SUM(CASE WHEN DATEDIFF(?, ${dateColumn}) BETWEEN 61 AND 90 THEN 1 ELSE 0 END) AS b60to90,
    SUM(CASE WHEN DATEDIFF(?, ${dateColumn}) > 90 THEN 1 ELSE 0 END) AS b90plus
  `;
}

function toAgingBuckets(row: any): AgingBuckets {
  return {
    b0to30: Number(row.b0to30 ?? 0),
    b30to60: Number(row.b30to60 ?? 0),
    b60to90: Number(row.b60to90 ?? 0),
    b90plus: Number(row.b90plus ?? 0),
  };
}

async function fetchOpenOpportunityAging(pool: Pool, anchor: Date, filters: Filters): Promise<AgingBuckets> {
  const { clause, params } = buildCrmWhereClause(filters, 'fo');
  const anchorStr = toDateOnlyString(anchor);
  const sql = `
    SELECT ${agingCaseSql('fo.OpportunityCreatedDate')}
    FROM Fact_Opportunity fo
    WHERE fo.IsOpen = 1 AND ${clause}
  `;
  const [rows] = await pool.query(sql, [anchorStr, anchorStr, anchorStr, anchorStr, ...params]);
  return toAgingBuckets((rows as any[])[0]);
}

async function fetchOpenQuotationAging(pool: Pool, anchor: Date, filters: Filters): Promise<AgingBuckets> {
  const { clause, params } = buildWhereClause(filters, 'fs');
  const anchorStr = toDateOnlyString(anchor);
  const sql = `
    SELECT ${agingCaseSql('fs.QuotationDate')}
    FROM Fact_Sales fs
    WHERE fs.IsRealQuotation = 1 AND fs.OrderState IN ('draft', 'sent') AND ${clause}
  `;
  const [rows] = await pool.query(sql, [anchorStr, anchorStr, anchorStr, anchorStr, ...params]);
  return toAgingBuckets((rows as any[])[0]);
}

export interface AgingDistribution {
  opportunities: AgingBuckets;
  quotations: AgingBuckets;
}

export async function computeAgingDistribution(pool: Pool, anchor: Date, filters: Filters): Promise<AgingDistribution> {
  const [opportunities, quotations] = await Promise.all([
    fetchOpenOpportunityAging(pool, anchor, filters),
    fetchOpenQuotationAging(pool, anchor, filters),
  ]);
  return { opportunities, quotations };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface PipelineTrendOverview {
  quotationRates: QuotationRates;
  opportunitiesByMonth: MonthComparisonPoint[];
  quotationsByMonth: MonthComparisonPoint[];
  salesOrdersByMonth: MonthComparisonPoint[];
  aging: AgingDistribution;
}

export async function computePipelineTrendOverview(pool: Pool, anchor: Date, filters: Filters): Promise<PipelineTrendOverview> {
  const [quotationRates, opportunitiesByMonth, quotationsByMonth, salesOrdersByMonth, aging] = await Promise.all([
    computeQuotationRates(pool, anchor, filters),
    fetchOpportunitiesByMonth(pool, anchor, filters),
    fetchQuotationsByMonth(pool, anchor, filters),
    fetchSalesOrdersByMonth(pool, anchor, filters),
    computeAgingDistribution(pool, anchor, filters),
  ]);
  return { quotationRates, opportunitiesByMonth, quotationsByMonth, salesOrdersByMonth, aging };
}
