/**
 * Pipeline Trend page metric definitions.
 *
 * Read-only diagnostic page (per the page spec) -- no drill-down/click-filter scope needed, just
 * anchorDate + the standard 5 sidebar filters (v_sales_documents-grain queries use buildWhereClause,
 * v_sales_opportunities-grain queries use buildCrmWhereClause -- see filters.ts's header comment on why
 * Opportunity has no ChannelKey column).
 *
 * Quotation Rate KPIs -- "Won ÷ Total Real Quotations" was resolved empirically against the live
 * warehouse this session, not guessed: v_sales_documents.IsWonQuotation is always 0 for every live row
 * (confirmed broken/unusable). Verified instead that IsRealQuotation=1 (still-quotation state) and
 * IsRealSalesOrder=1 (already-converted state) are disjoint by construction and their counts sum
 * exactly to the "real quotation universe" -- that's the Win Rate denominator. OrderState (the raw
 * Odoo sale.order state: sale/cancel/draft/sent) is reused directly as the Open/Lost signal rather
 * than inventing a new status scheme.
 *
 * YEAR-TO-DATE ONLY (2026-09-21): every query here is limited to records created/quoted from Jan 1
 * of the current year through the anchor (clamped by filters.ts's parsePipelineAnchor), and the aging buckets only
 * cover this year's open records. Exception (2026-11-09): the Opportunities / Quotations / Sales Orders charts follow the
 * page's Daily / Weekly / Monthly / Yearly period selector (lib/periods.ts window), with no prior-year series.
 *
 * Lost-exclusion policy: fetchOpportunitiesByPeriod (v_sales_opportunities-scoped) excludes closed-lost
 * opportunities via filters.ts's excludeLostClause -- it's a general creation-volume trend, not a
 * lost-specific one. Every other query on this page is v_sales_documents-scoped (Quotation Rates,
 * Quotations/Sales Orders by period, aging), which has no Stage/IsLost concept of its own (its
 * "lost" signal is OrderState='cancel', already tracked separately as lostQuotations/its own
 * aging bucket) -- untouched.
 */

import type { Pool } from 'mysql2/promise';
import { fetchPipelineStageOrder } from './pipelineStages';
import { anchorToday, byPeriod, changePct, fillPeriods, periodBucketSql, periodRangeSql, periodWindow, type PeriodGranularity } from '../lib/periods';
import {
  buildCrmWhereClause,
  buildWhereClause,
  excludeCancelledDocumentsClause,
  excludeLostClause,
  openOpportunityClause,
  ytdWindow,
  type DateWindow,
  type Filters,
} from './filters';

function toDateOnlyString(d: Date): string {
  return d.toISOString().slice(0, 10);
}


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
    FROM v_sales_documents fs
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
// 3 combo charts -- Opportunities / Quotations / Sales Orders (count + value) per Daily / Weekly / Monthly / Yearly period
// of the page's period selector (lib/periods.ts window ending with the anchor's period).
// ---------------------------------------------------------------------------

export interface PeriodComparisonPoint {
  start: string;
  end: string;
  inProgress: boolean;
  count: number;
  value: number;
  /** against the previous period of the same granularity */
  countChangePct: number | null;
  valueChangePct: number | null;
}

export interface PeriodComparisonSeries {
  points: PeriodComparisonPoint[];
  /** the whole window (the points add up to it) */
  totals: { count: number; value: number };
}

async function fetchPeriodComparison(
  pool: Pool,
  anchor: Date,
  g: PeriodGranularity,
  filters: Filters,
  table: 'v_sales_opportunities' | 'v_sales_documents',
  dateColumn: string,
  valueColumn: string,
  extraWhere: string,
  crmScoped: boolean,
): Promise<PeriodComparisonSeries> {
  const w = periodWindow(g, anchorToday(anchor));
  const { clause, params } = crmScoped ? buildCrmWhereClause(filters, 't') : buildWhereClause(filters, 't');
  const range = periodRangeSql(`t.${dateColumn}`, w.previous.start, w.to);
  const windowRange = periodRangeSql(`t.${dateColumn}`, w.from, w.to);
  const [[rows], [totalRows]] = await Promise.all([
    pool.query(
      `SELECT ${periodBucketSql(g, `t.${dateColumn}`)} AS p, COUNT(*) AS cnt, COALESCE(SUM(t.${valueColumn}), 0) AS val
       FROM ${table} t
       WHERE ${range.sql} AND ${extraWhere} AND ${clause}
       GROUP BY p`,
      [...range.params, ...params],
    ),
    pool.query(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(t.${valueColumn}), 0) AS val FROM ${table} t WHERE ${windowRange.sql} AND ${extraWhere} AND ${clause}`,
      [...windowRange.params, ...params],
    ),
  ]);
  const map = byPeriod(rows as Record<string, unknown>[]);
  let prev = map.get(w.previous.start);
  const points = fillPeriods(w, map, (p, r): PeriodComparisonPoint => {
    const count = Number(r?.cnt ?? 0);
    const value = Number(r?.val ?? 0);
    const point = {
      start: p.start,
      end: p.end,
      inProgress: p.inProgress,
      count,
      value,
      countChangePct: changePct(count, Number(prev?.cnt ?? 0)),
      valueChangePct: changePct(value, Number(prev?.val ?? 0)),
    };
    prev = r;
    return point;
  });
  const t = (totalRows as Record<string, unknown>[])[0] ?? {};
  return { points, totals: { count: Number(t.cnt ?? 0), value: Number(t.val ?? 0) } };
}

/** Excludes Lost (see filters.ts's excludeLostClause) -- a general opportunity-creation trend, not
 * a lost-specific one. v_sales_documents-scoped siblings below (Quotations/Sales Orders) are
 * untouched: v_sales_documents has no Stage/IsLost concept of its own, and those documents already
 * happened regardless of the linked opportunity's current status. */
export function fetchOpportunitiesByPeriod(pool: Pool, anchor: Date, g: PeriodGranularity, filters: Filters): Promise<PeriodComparisonSeries> {
  return fetchPeriodComparison(pool, anchor, g, filters, 'v_sales_opportunities', 'OpportunityCreatedDate', 'ExpectedRevenue', excludeLostClause('t'), true);
}

/** Same "real quotation universe" (IsRealQuotation=1 OR IsRealSalesOrder=1) as computeQuotationRates, minus cancelled
 * documents (not pipeline: excludeCancelledDocumentsClause), cohorted by QuotationDate's period regardless of whether
 * the row has since converted. */
export function fetchQuotationsByPeriod(pool: Pool, anchor: Date, g: PeriodGranularity, filters: Filters): Promise<PeriodComparisonSeries> {
  return fetchPeriodComparison(pool, anchor, g, filters, 'v_sales_documents', 'QuotationDate', 'OrderValue',
    `(t.IsRealQuotation = 1 OR t.IsRealSalesOrder = 1) AND ${excludeCancelledDocumentsClause('t')}`, false);
}

export function fetchSalesOrdersByPeriod(pool: Pool, anchor: Date, g: PeriodGranularity, filters: Filters): Promise<PeriodComparisonSeries> {
  return fetchPeriodComparison(pool, anchor, g, filters, 'v_sales_documents', 'OrderDate', 'OrderValue',
    `(t.SalesDocumentType = 'Sales Order' AND t.IsRealSalesOrder = 1) AND ${excludeCancelledDocumentsClause('t')}`, false);
}

export interface PipelineTrendPeriods {
  granularity: PeriodGranularity;
  from: string;
  to: string;
  opportunities: PeriodComparisonSeries;
  quotations: PeriodComparisonSeries;
  salesOrders: PeriodComparisonSeries;
}

export async function fetchPipelineTrendPeriods(pool: Pool, anchor: Date, g: PeriodGranularity, filters: Filters): Promise<PipelineTrendPeriods> {
  const w = periodWindow(g, anchorToday(anchor));
  const [opportunities, quotations, salesOrders] = await Promise.all([
    fetchOpportunitiesByPeriod(pool, anchor, g, filters),
    fetchQuotationsByPeriod(pool, anchor, g, filters),
    fetchSalesOrdersByPeriod(pool, anchor, g, filters),
  ]);
  return { granularity: g, from: w.from, to: w.to, opportunities, quotations, salesOrders };
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

/** The open-record universe behind each aging bar -- shared by the bucket counts and the
 * drill-down list (fetchAgingDetails), so a clicked bucket always lists exactly the records it
 * counted. */
function openOpportunityScope(anchor: Date, filters: Filters) {
  const { clause, params } = buildCrmWhereClause(filters, 'fo');
  const window = ytdWindow(anchor);
  return {
    where: `${openOpportunityClause('fo')} AND DATE(fo.OpportunityCreatedDate) BETWEEN ? AND ? AND ${clause}`,
    params: [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params],
  };
}

function openQuotationScope(anchor: Date, filters: Filters) {
  const { clause, params } = buildWhereClause(filters, 'fs');
  const window = ytdWindow(anchor);
  return {
    where: `fs.IsRealQuotation = 1 AND fs.OrderState IN ('draft', 'sent') AND DATE(fs.QuotationDate) BETWEEN ? AND ? AND ${clause}`,
    params: [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params],
  };
}

async function fetchOpenOpportunityAging(pool: Pool, anchor: Date, filters: Filters): Promise<AgingBuckets> {
  const anchorStr = toDateOnlyString(anchor);
  const scope = openOpportunityScope(anchor, filters);
  const sql = `
    SELECT ${agingCaseSql('fo.OpportunityCreatedDate')}
    FROM v_sales_opportunities fo
    WHERE ${scope.where}
  `;
  const [rows] = await pool.query(sql, [anchorStr, anchorStr, anchorStr, anchorStr, ...scope.params]);
  return toAgingBuckets((rows as any[])[0]);
}

async function fetchOpenQuotationAging(pool: Pool, anchor: Date, filters: Filters): Promise<AgingBuckets> {
  const anchorStr = toDateOnlyString(anchor);
  const scope = openQuotationScope(anchor, filters);
  const sql = `
    SELECT ${agingCaseSql('fs.QuotationDate')}
    FROM v_sales_documents fs
    WHERE ${scope.where}
  `;
  const [rows] = await pool.query(sql, [anchorStr, anchorStr, anchorStr, anchorStr, ...scope.params]);
  return toAgingBuckets((rows as any[])[0]);
}

export interface AgingDistribution {
  opportunities: AgingBuckets;
  quotations: AgingBuckets;
}

// ---------------------------------------------------------------------------
// Aging drill-down -- the open opportunities / quotations behind one bucket of one bar, with their
// customer and salesperson names.
// ---------------------------------------------------------------------------

export const AGING_CATEGORIES = ['opportunities', 'quotations'] as const;
export type AgingCategory = (typeof AGING_CATEGORIES)[number];
export const AGING_BUCKET_KEYS = ['b0to30', 'b30to60', 'b60to90', 'b90plus'] as const;
export type AgingBucketKey = (typeof AGING_BUCKET_KEYS)[number];

/** Same day ranges as agingCaseSql (one `?` = the anchor date). */
function agingBucketCondition(bucket: AgingBucketKey, dateColumn: string): string {
  switch (bucket) {
    case 'b0to30':
      return `DATEDIFF(?, ${dateColumn}) BETWEEN 0 AND 30`;
    case 'b30to60':
      return `DATEDIFF(?, ${dateColumn}) BETWEEN 31 AND 60`;
    case 'b60to90':
      return `DATEDIFF(?, ${dateColumn}) BETWEEN 61 AND 90`;
    case 'b90plus':
      return `DATEDIFF(?, ${dateColumn}) > 90`;
  }
}

export interface AgingDetailRow {
  /** Opportunity ID, or the quotation's order number. */
  id: string;
  /** Opportunity name, or the quotation's order number. */
  name: string;
  customer: string | null;
  salesperson: string | null;
  /** Opportunity created date / quotation date (YYYY-MM-DD). */
  date: string | null;
  ageDays: number;
  /** Expected revenue (opportunity) or order value (quotation). */
  value: number;
  /** CRM stage (opportunity) or Odoo order state (quotation). */
  status: string | null;
  /** Opportunities: place of the stage in the pipeline order (config/pipelineStages.ts), for sorting; null for quotations. */
  stagePosition: number | null;
}

export async function fetchAgingDetails(
  pool: Pool,
  anchor: Date,
  filters: Filters,
  category: AgingCategory,
  bucket: AgingBucketKey,
): Promise<AgingDetailRow[]> {
  const anchorStr = toDateOnlyString(anchor);
  const isOpp = category === 'opportunities';
  const scope = isOpp ? openOpportunityScope(anchor, filters) : openQuotationScope(anchor, filters);
  const sql = isOpp
    ? `
    SELECT fo.OpportunityID AS id, fo.OpportunityName AS name, fo.Customer AS customer,
           COALESCE(sap.admin_name_override, fo.Salesperson) AS salesperson,
           DATE_FORMAT(fo.OpportunityCreatedDate, '%Y-%m-%d') AS docDate, DATEDIFF(?, fo.OpportunityCreatedDate) AS ageDays,
           fo.ExpectedRevenue AS value, fo.Stage AS status, fo.StageID AS stageId
    FROM v_sales_opportunities fo
    LEFT JOIN salesperson_admin_profile sap ON sap.salesperson_key = fo.SalespersonKey
    WHERE ${scope.where} AND ${agingBucketCondition(bucket, 'fo.OpportunityCreatedDate')}
    ORDER BY ageDays DESC, fo.OpportunityID
  `
    : `
    SELECT fs.OrderNumber AS id, fs.OrderNumber AS name, fs.Customer AS customer,
           COALESCE(sap.admin_name_override, fs.Salesperson) AS salesperson,
           DATE_FORMAT(fs.QuotationDate, '%Y-%m-%d') AS docDate, DATEDIFF(?, fs.QuotationDate) AS ageDays,
           fs.OrderValue AS value, fs.OrderState AS status
    FROM v_sales_documents fs
    LEFT JOIN salesperson_admin_profile sap ON sap.salesperson_key = fs.SalespersonKey
    WHERE ${scope.where} AND ${agingBucketCondition(bucket, 'fs.QuotationDate')}
    ORDER BY ageDays DESC, fs.OrderNumber
  `;
  const [[rows], stageOrder] = await Promise.all([
    pool.query(sql, [anchorStr, ...scope.params, anchorStr]),
    isOpp ? fetchPipelineStageOrder(pool) : Promise.resolve(null),
  ]);
  return (rows as any[]).map((r) => ({
    id: String(r.id ?? ''),
    name: String(r.name ?? ''),
    customer: r.customer ?? null,
    salesperson: r.salesperson ?? null,
    date: r.docDate ?? null,
    ageDays: Number(r.ageDays ?? 0),
    value: Number(r.value ?? 0),
    status: r.status ?? null,
    stagePosition: stageOrder ? stageOrder.of(r.stageId != null ? Number(r.stageId) : null, r.status ?? null).position : null,
  }));
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
  aging: AgingDistribution;
}

export async function computePipelineTrendOverview(pool: Pool, anchor: Date, filters: Filters): Promise<PipelineTrendOverview> {
  const [quotationRates, aging] = await Promise.all([computeQuotationRates(pool, anchor, filters), computeAgingDistribution(pool, anchor, filters)]);
  return { quotationRates, aging };
}
