/**
 * Pipeline Health page metric definitions.
 *
 * Source tables (confirmed against the live warehouse this session -- these are the tables the
 * Python ETL's CRM builders actually write, distinct from the aspirational snake_case
 * `data/warehouse/migrations/` design; see measures/customerGrowth.ts's header for the same lesson
 * applied to Dim_Customer):
 *
 *   Fact_Lead        -- one row per CRM lead. Already pre-scoped to genuine CRM leads by the ETL's
 *                        own build-time filter (LeadType IN ('lead','systematic') OR
 *                        IsETLCreatedLead) -- "Leads = CRM Leads only" needs no extra WHERE clause.
 *   Fact_Opportunity -- one row per CRM opportunity, similarly pre-scoped to real CRM opportunities
 *                        by the ETL. Carries Stage/Probability/ProbabilityBucket/ExpectedRevenue/
 *                        ExpectedCloseDate/IsWon/IsLost/IsOpen directly.
 *   Fact_Sales       -- one row per Odoo sale.order id (the live name for the quotation-to-order
 *                        funnel fact -- NOT a revenue fact). SalesDocumentType flips from
 *                        'Quotation' to 'Sales Order' on the SAME row once the order is confirmed
 *                        (a current-state snapshot, not a permanent history), so "Quotations linked
 *                        to an Opportunity" must count every row with IsLinkedToOpportunity=1
 *                        regardless of its current SalesDocumentType -- every Sales Order row
 *                        started life as a quotation.
 *   Fact_Delivery    -- one row per picking/delivery record. OpportunityID is already denormalized
 *                        directly onto this table from its linked Sales Order (no join needed).
 *
 * Full Pipeline funnel is scoped to B2B (Fact_*.SalesSegment = 'B2B', confirmed live as a clean,
 * consistently-cased value on all 4 tables) + YTD -- "consistent with the existing rule that this
 * funnel only reflects CRM-managed transactions" (CRM/Odoo opportunity tracking in this business is
 * a B2B-only discipline; B2C walk-in sales never go through the CRM pipeline at all). Each stage is
 * scoped by its own natural date field: Leads/Opportunities by their own CreatedDate; Quotations
 * AND Sales Orders both by QuotationDate (the same Fact_Sales row's one fixed origination
 * timestamp, since a Sales Order row IS a Quotation row that later got confirmed -- using the same
 * field for both keeps the two stages counting the same YTD cohort of documents, not two different
 * ones); Deliveries by their linked order's OrderDate (Fact_Delivery has no QuotationDate of its
 * own). Every other visual on this page (Expected Closure Opportunity, Opportunity by Stage,
 * Probabilities Distribution, Opportunity Details) is deliberately NOT B2B/YTD-scoped -- only the
 * funnel and the Stage Benchmark that's derived from it (see computeStageBenchmark). Expected
 * Closure Opportunity is anchor-scoped in a different sense, though: it's a forward-looking
 * forecast, not a YTD figure, so it starts at the anchor's own month and runs forward (see
 * fetchExpectedClosureByMonth) rather than being clipped to year-to-date.
 *
 * Won/Lost-exclusion policy: this is a pipeline page -- Won/Lost opportunities are already closed
 * deals, not active pipeline, so every general/summary widget on this page -- the Full Pipeline
 * funnel's Opportunities bar (+ its own drill-down and Stage Benchmark, which is derived from it),
 * Expected Closure Opportunity, and Probabilities Distribution (already excludes both incidentally,
 * since Won/Lost map to the 0%/100% buckets outside the 10-90% range this widget shows) -- excludes
 * BOTH closed-won and closed-lost opportunities via `fo.IsOpen = 1` (the same "not won, not lost"
 * flag already used this way in measures/activityMomentum.ts and measures/pipelineTrend.ts), so a
 * deal that's no longer active doesn't clutter charts about the live/forward pipeline. **Opportunity
 * by Stage is the one deliberate exception** -- it shows both Won and Lost stage segments so the
 * page still has one place to see where every current-stage dollar sits, closed deals included. The
 * shared Opportunity Details drill-down array is unfiltered at the query level (returns every
 * opportunity, Won/Lost/open) so it can back all four drill-down paths; `matchesFilter` on the
 * frontend applies the IsOpen requirement itself for the month/bucket drill-downs (Expected
 * Closure/Probabilities), leaves the stage drill-down unfiltered (Opportunity by Stage's exception),
 * and the funnelStage drill-down matches by an ID list that's already IsOpen-scoped at the query
 * level (see fetchOpportunityStageIds). The funnel's Quotations/Sales Orders/Deliveries bars stay
 * unfiltered by Won/Lost -- those are Fact_Sales/Fact_Delivery documents with no IsWon/IsLost
 * concept of their own (they already happened regardless of the linked opportunity's current
 * status).
 */

import type { Pool } from 'mysql2/promise';
import { classifyVsTarget, variancePct, TargetStatus } from './classify';
import { buildCrmWhereClause, buildWhereClause, excludeLostClause, ytdWindow, type Filters } from './filters';

function toDateOnlyString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function b2bClause(alias: string): string {
  return `${alias}.SalesSegment = 'B2B'`;
}

// ---------------------------------------------------------------------------
// Full Pipeline funnel -- Leads -> Opportunities -> Quotations -> Sales Orders -> Deliveries.
// B2B + YTD scoped (see module docstring).
// ---------------------------------------------------------------------------

export interface FunnelCounts {
  leads: number;
  opportunities: number;
  quotations: number;
  salesOrders: number;
  deliveries: number;
}

async function countRows(pool: Pool, sql: string, params: Array<string | number>): Promise<number> {
  const [rows] = await pool.query(sql, params);
  return Number((rows as any[])[0].cnt);
}

async function countLeads(pool: Pool, anchor: Date, filters: Filters): Promise<number> {
  const window = ytdWindow(anchor);
  const { clause, params } = buildCrmWhereClause(filters, 'fl');
  const sql = `
    SELECT COUNT(*) AS cnt FROM Fact_Lead fl
    WHERE DATE(fl.LeadCreatedDate) BETWEEN ? AND ? AND ${b2bClause('fl')} AND ${clause}
  `;
  return countRows(pool, sql, [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]);
}

/** Excludes both Won and Lost via `fo.IsOpen = 1` (see module docstring's Won/Lost-exclusion
 * policy) -- unlike the Quotations/Sales Orders/Deliveries stages below, which stay unfiltered on
 * purpose: those are documents that already happened regardless of the opportunity's current
 * status. Returns count + value (SUM(ExpectedRevenue)) in one query since Stage Benchmark needs the
 * count and the Full Pipeline funnel's hover/legend now needs the value too, and both must stay
 * scoped identically. */
async function fetchOpportunitiesCountAndValue(pool: Pool, anchor: Date, filters: Filters): Promise<{ count: number; value: number }> {
  const window = ytdWindow(anchor);
  const { clause, params } = buildCrmWhereClause(filters, 'fo');
  const sql = `
    SELECT COUNT(*) AS cnt, COALESCE(SUM(fo.ExpectedRevenue), 0) AS val FROM Fact_Opportunity fo
    WHERE DATE(fo.OpportunityCreatedDate) BETWEEN ? AND ? AND ${b2bClause('fo')} AND ${clause} AND fo.IsOpen = 1
  `;
  const [rows] = await pool.query(sql, [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]);
  const row = (rows as any[])[0];
  return { count: Number(row.cnt), value: Number(row.val) };
}

/**
 * Row-level records for the 3 downstream funnel stages (Quotations, Sales Orders, Deliveries) --
 * every B2B/YTD row is fetched regardless of Opportunity linkage (`opportunityId` is null for an
 * unlinked row), so one query per stage backs three things at once: the funnel's stage count
 * (linked rows only -- see computeFunnelCounts), the "click a stage" drill-down table (linked rows
 * only), and the new "[Stage] with no Opportunities" PDF export (unlinked rows only). Fetching once
 * and deriving all three from it means the count and the drill-down table can never disagree with
 * each other, unlike the old count-only + separate-ID-list approach this replaces.
 *
 * Verified against live Odoo (2026-07-23): read back every SalesDocumentID this query currently
 * flags as linked and confirmed opportunity_id is genuinely set on all of them right now -- so
 * IsLinkedToOpportunity/OpportunityID is NOT stale in this warehouse, it already matches Odoo
 * exactly for the rows it counts. If the funnel's Quotations count still doesn't match a count
 * pulled from Odoo's own UI, the gap is almost certainly in how that Odoo view scopes "Quotations"
 * (e.g. a state or date-field difference) or how "B2B" is being filtered there, not a linkage bug --
 * worth comparing the exact Odoo filter used against this query's WHERE clause before assuming
 * either side is wrong.
 */
export interface FunnelSalesRecord {
  orderNumber: string;
  customer: string | null;
  company: string | null;
  salesperson: string | null;
  documentDate: string | null;
  value: number;
  /** null = no linked Opportunity ("Tracking > Opportunity" empty on the Odoo form). */
  opportunityId: string | null;
}

export interface FunnelDeliveryRecord {
  orderNumber: string | null;
  customer: string | null;
  company: string | null;
  salesperson: string | null;
  orderDate: string | null;
  deliveryStatus: string | null;
  opportunityId: string | null;
}

export interface FunnelStageRecords {
  quotations: FunnelSalesRecord[];
  salesOrders: FunnelSalesRecord[];
  deliveries: FunnelDeliveryRecord[];
}

function toFunnelSalesRecord(r: any): FunnelSalesRecord {
  return {
    orderNumber: String(r.orderNumber ?? ''),
    customer: r.customer ?? null,
    company: r.company ?? null,
    salesperson: r.salesperson ?? null,
    documentDate: r.documentDate ? toDateOnlyString(r.documentDate) : null,
    value: Number(r.value ?? 0),
    opportunityId: r.opportunityId != null ? String(r.opportunityId) : null,
  };
}

/** Quotations -- both still-pending ('Quotation') and already-converted ('Sales Order') rows,
 * since every Sales Order row started as a quotation (see module docstring). Opportunity linkage is
 * NOT filtered here -- every B2B/YTD row is returned so the caller can derive both the linked count
 * and the unlinked "with no Opportunities" list from one fetch. */
async function fetchQuotationRecords(pool: Pool, anchor: Date, filters: Filters): Promise<FunnelSalesRecord[]> {
  const window = ytdWindow(anchor);
  const { clause, params } = buildWhereClause(filters, 'fs');
  const sql = `
    SELECT fs.OrderNumber AS orderNumber, fs.Customer AS customer, fs.Company AS company,
           fs.Salesperson AS salesperson, fs.QuotationDate AS documentDate, fs.OrderValue AS value,
           fs.OpportunityID AS opportunityId
    FROM Fact_Sales fs
    WHERE DATE(fs.QuotationDate) BETWEEN ? AND ? AND ${b2bClause('fs')} AND ${clause}
  `;
  const [rows] = await pool.query(sql, [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]);
  return (rows as any[]).map(toFunnelSalesRecord);
}

async function fetchSalesOrderRecords(pool: Pool, anchor: Date, filters: Filters): Promise<FunnelSalesRecord[]> {
  const window = ytdWindow(anchor);
  const { clause, params } = buildWhereClause(filters, 'fs');
  const sql = `
    SELECT fs.OrderNumber AS orderNumber, fs.Customer AS customer, fs.Company AS company,
           fs.Salesperson AS salesperson, fs.QuotationDate AS documentDate, fs.OrderValue AS value,
           fs.OpportunityID AS opportunityId
    FROM Fact_Sales fs
    WHERE fs.SalesDocumentType = 'Sales Order' AND DATE(fs.QuotationDate) BETWEEN ? AND ? AND ${b2bClause('fs')} AND ${clause}
  `;
  const [rows] = await pool.query(sql, [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]);
  return (rows as any[]).map(toFunnelSalesRecord);
}

/** Deliveries linked to an Opportunity can exceed the Sales Orders count -- one order can have
 * multiple partial delivery/picking records, a real characteristic of the data, not a bug; shown
 * as-is rather than clamped. */
async function fetchDeliveryRecords(pool: Pool, anchor: Date, filters: Filters): Promise<FunnelDeliveryRecord[]> {
  const window = ytdWindow(anchor);
  const { clause, params } = buildCrmWhereClause(filters, 'fd');
  const sql = `
    SELECT fd.OrderNumber AS orderNumber, fd.Customer AS customer, fd.Company AS company,
           fd.Salesperson AS salesperson, fd.OrderDate AS orderDate, fd.DeliveryStatus AS deliveryStatus,
           fd.OpportunityID AS opportunityId
    FROM Fact_Delivery fd
    WHERE fd.OrderDate BETWEEN ? AND ? AND ${b2bClause('fd')} AND ${clause}
  `;
  const [rows] = await pool.query(sql, [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]);
  return (rows as any[]).map((r) => ({
    orderNumber: r.orderNumber != null ? String(r.orderNumber) : null,
    customer: r.customer ?? null,
    company: r.company ?? null,
    salesperson: r.salesperson ?? null,
    orderDate: r.orderDate ? toDateOnlyString(r.orderDate) : null,
    deliveryStatus: r.deliveryStatus ?? null,
    opportunityId: r.opportunityId != null ? String(r.opportunityId) : null,
  }));
}

export async function fetchFunnelStageRecords(pool: Pool, anchor: Date, filters: Filters): Promise<FunnelStageRecords> {
  const [quotations, salesOrders, deliveries] = await Promise.all([
    fetchQuotationRecords(pool, anchor, filters),
    fetchSalesOrderRecords(pool, anchor, filters),
    fetchDeliveryRecords(pool, anchor, filters),
  ]);
  return { quotations, salesOrders, deliveries };
}

function countLinked(rows: { opportunityId: string | null }[]): number {
  return rows.filter((r) => r.opportunityId != null).length;
}

/** Sum of `value` across linked (opportunityId != null) rows -- same population as countLinked
 * above, just summed instead of counted. Used for the Quotations/Sales Orders funnel stages'
 * hover/legend value. */
function sumLinkedValue(rows: { opportunityId: string | null; value: number }[]): number {
  return rows.filter((r) => r.opportunityId != null).reduce((sum, r) => sum + r.value, 0);
}

/** Fact_Delivery carries no monetary value of its own (quantities only -- confirmed against the
 * live schema), and a single order can have multiple partial delivery rows, so summing a per-row
 * value would double-count. Instead: build an orderNumber -> value map from the Quotations stage
 * records (a superset of every Fact_Sales row, pending or converted, each order's value is stable
 * across its life), then sum each *unique* linked delivery's order value once. */
function sumDeliveryValue(deliveries: FunnelDeliveryRecord[], quotations: FunnelSalesRecord[]): number {
  const valueByOrderNumber = new Map<string, number>();
  for (const q of quotations) {
    if (q.orderNumber) valueByOrderNumber.set(q.orderNumber, q.value);
  }
  const seen = new Set<string>();
  let total = 0;
  for (const d of deliveries) {
    if (d.opportunityId == null || !d.orderNumber || seen.has(d.orderNumber)) continue;
    seen.add(d.orderNumber);
    total += valueByOrderNumber.get(d.orderNumber) ?? 0;
  }
  return total;
}

/** Total monetary value per funnel stage, alongside the existing counts -- powers the Full Pipeline
 * funnel's "count + value" hover/legend. Leads has no value figure (it isn't plotted on the funnel
 * at all, see page.tsx's funnelStages). */
export interface FunnelValues {
  opportunities: number;
  quotations: number;
  salesOrders: number;
  deliveries: number;
}

export async function computeFunnelCounts(
  pool: Pool,
  anchor: Date,
  filters: Filters,
  stageRecords: FunnelStageRecords,
): Promise<{ counts: FunnelCounts; values: FunnelValues }> {
  const [leads, opportunities] = await Promise.all([countLeads(pool, anchor, filters), fetchOpportunitiesCountAndValue(pool, anchor, filters)]);
  const counts: FunnelCounts = {
    leads,
    opportunities: opportunities.count,
    quotations: countLinked(stageRecords.quotations),
    salesOrders: countLinked(stageRecords.salesOrders),
    deliveries: countLinked(stageRecords.deliveries),
  };
  const values: FunnelValues = {
    opportunities: opportunities.value,
    quotations: sumLinkedValue(stageRecords.quotations),
    salesOrders: sumLinkedValue(stageRecords.salesOrders),
    deliveries: sumDeliveryValue(stageRecords.deliveries, stageRecords.quotations),
  };
  return { counts, values };
}

// ---------------------------------------------------------------------------
// Full Pipeline funnel drill-down for the Leads/Opportunities stages -- same exact B2B/YTD-scoped
// WHERE clause as that stage's count* function above (so clicking the Opportunities bar drills down
// into exactly what it counted), resolved back to Fact_*.OpportunityID and matched against the
// shared Opportunity Details array (fetchOpportunityDetails). Leads that haven't converted yet (no
// OpportunityID) simply contribute no rows -- an honest gap, not a bug: a lead isn't an opportunity
// until Odoo converts it.
//
// Quotations/Sales Orders/Deliveries no longer go through this ID-list + shared-Opportunity-array
// indirection -- see FunnelStageRecords above, which returns each of those 3 stages' own real
// records directly (so the drill-down table shows the actual Quotation/Sales Order/Delivery rows,
// not a resolved-back list of the Opportunities that happen to have one).
// ---------------------------------------------------------------------------

export interface FunnelOpportunityIds {
  leads: string[];
  opportunities: string[];
}

async function fetchIdRows(pool: Pool, sql: string, params: Array<string | number>): Promise<string[]> {
  const [rows] = await pool.query(sql, params);
  return (rows as any[]).map((r) => String(r.opportunityId));
}

async function fetchLeadOpportunityIds(pool: Pool, anchor: Date, filters: Filters): Promise<string[]> {
  const window = ytdWindow(anchor);
  const { clause, params } = buildCrmWhereClause(filters, 'fl');
  const sql = `
    SELECT DISTINCT fl.OpportunityID AS opportunityId FROM Fact_Lead fl
    WHERE DATE(fl.LeadCreatedDate) BETWEEN ? AND ? AND ${b2bClause('fl')} AND ${clause} AND fl.OpportunityID IS NOT NULL
  `;
  return fetchIdRows(pool, sql, [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]);
}

/** Excludes both Won and Lost (`fo.IsOpen = 1`), matching fetchOpportunitiesCountAndValue above, so
 * clicking the Opportunities bar drills down into exactly what that bar counted. */
async function fetchOpportunityStageIds(pool: Pool, anchor: Date, filters: Filters): Promise<string[]> {
  const window = ytdWindow(anchor);
  const { clause, params } = buildCrmWhereClause(filters, 'fo');
  const sql = `
    SELECT fo.OpportunityID AS opportunityId FROM Fact_Opportunity fo
    WHERE DATE(fo.OpportunityCreatedDate) BETWEEN ? AND ? AND ${b2bClause('fo')} AND ${clause} AND fo.IsOpen = 1
  `;
  return fetchIdRows(pool, sql, [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]);
}

export async function fetchFunnelOpportunityIds(pool: Pool, anchor: Date, filters: Filters): Promise<FunnelOpportunityIds> {
  const [leads, opportunities] = await Promise.all([
    fetchLeadOpportunityIds(pool, anchor, filters),
    fetchOpportunityStageIds(pool, anchor, filters),
  ]);
  return { leads, opportunities };
}

// ---------------------------------------------------------------------------
// Stage Benchmark -- actual conversion % per transition vs the spec's fixed targets, classified
// with the same classifyVsTarget/variancePct every other page's pass/fail treatment already uses.
// ---------------------------------------------------------------------------

export interface StageBenchmarkRow {
  transition: string;
  actualPct: number | null;
  targetPct: number;
  status: TargetStatus;
  variancePct: number | null;
}

const STAGE_TARGETS: { transition: string; target: number; from: keyof FunnelCounts; to: keyof FunnelCounts }[] = [
  { transition: 'Opportunity → Quotation', target: 0.8, from: 'opportunities', to: 'quotations' },
  { transition: 'Quotation → Sales Order', target: 0.15, from: 'quotations', to: 'salesOrders' },
  { transition: 'Sales Order → Delivery', target: 0.98, from: 'salesOrders', to: 'deliveries' },
];

export function computeStageBenchmark(funnel: FunnelCounts): StageBenchmarkRow[] {
  return STAGE_TARGETS.map(({ transition, target, from, to }) => {
    const fromCount = funnel[from];
    const toCount = funnel[to];
    const actualPct = fromCount > 0 ? toCount / fromCount : null;
    return {
      transition,
      actualPct,
      targetPct: target,
      status: classifyVsTarget(actualPct, target),
      variancePct: variancePct(actualPct, target),
    };
  });
}

// ---------------------------------------------------------------------------
// Expected Closure Opportunity -- Expected Opportunity Count + Value, by ExpectedCloseDate month.
// Forward-looking forecast, not a historical log: always starts at the anchor's own month (today's
// month, in production -- this route has no page-level date control, see routes/pipelineHealth.ts)
// and runs `monthsAhead` months forward, dropping anything already in the past. Zero-filled so a
// month with zero expected closures still renders as a bar, not a gap -- same
// Array.from-over-a-year-month-map convention as activityMomentum's fetchNewOpportunitiesByMonth.
// ---------------------------------------------------------------------------

export interface ExpectedClosureMonthPoint {
  year: number;
  month: number;
  label: string;
  expectedCount: number;
  expectedValue: number;
}

export async function fetchExpectedClosureByMonth(
  pool: Pool,
  anchor: Date,
  filters: Filters,
  monthsAhead = 12,
): Promise<ExpectedClosureMonthPoint[]> {
  const { clause, params } = buildCrmWhereClause(filters, 'fo');
  const startYear = anchor.getUTCFullYear();
  const startMonth = anchor.getUTCMonth() + 1;
  const rangeStart = new Date(Date.UTC(startYear, startMonth - 1, 1));
  const rangeEndExclusive = new Date(Date.UTC(startYear, startMonth - 1 + monthsAhead, 1));

  const sql = `
    SELECT
      YEAR(fo.ExpectedCloseDate) AS year,
      MONTH(fo.ExpectedCloseDate) AS month,
      COUNT(*) AS expectedCount,
      COALESCE(SUM(fo.ExpectedRevenue), 0) AS expectedValue
    FROM Fact_Opportunity fo
    WHERE fo.ExpectedCloseDate >= ? AND fo.ExpectedCloseDate < ? AND ${clause} AND fo.IsOpen = 1
    GROUP BY YEAR(fo.ExpectedCloseDate), MONTH(fo.ExpectedCloseDate)
    ORDER BY year, month
  `;
  const [rows] = await pool.query(sql, [toDateOnlyString(rangeStart), toDateOnlyString(rangeEndExclusive), ...params]);
  const byYearMonth = new Map<string, { count: number; value: number }>();
  for (const r of rows as any[]) {
    byYearMonth.set(`${r.year}-${r.month}`, { count: Number(r.expectedCount), value: Number(r.expectedValue) });
  }

  return Array.from({ length: monthsAhead }, (_, i) => i).map((i) => {
    const d = new Date(Date.UTC(startYear, startMonth - 1 + i, 1));
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const point = byYearMonth.get(`${year}-${month}`);
    return {
      year,
      month,
      label: `${MONTH_LABELS[month - 1]} ${year}`,
      expectedCount: point?.count ?? 0,
      expectedValue: point?.value ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Opportunity by Stage -- value distribution across current CRM stages.
// ---------------------------------------------------------------------------

export interface StageValueSlice {
  stage: string;
  value: number;
}

/** Deliberately unfiltered by Won/Lost -- this is the one exception to the page's Won/Lost-exclusion
 * policy (see module docstring), so it stays the one place to see where every current-stage dollar
 * sits, including deals that already closed won or lost. */
export async function fetchOpportunityByStage(pool: Pool, filters: Filters): Promise<StageValueSlice[]> {
  const { clause, params } = buildCrmWhereClause(filters, 'fo');
  const sql = `
    SELECT fo.Stage AS stage, COALESCE(SUM(fo.ExpectedRevenue), 0) AS value
    FROM Fact_Opportunity fo
    WHERE ${clause}
    GROUP BY fo.Stage
    ORDER BY value DESC
  `;
  const [rows] = await pool.query(sql, params);
  return (rows as any[]).map((r) => ({ stage: String(r.stage ?? 'Unspecified'), value: Number(r.value) }));
}

// ---------------------------------------------------------------------------
// Probabilities Distribution -- opportunity count per 10-90% ProbabilityBucket. Live buckets also
// include '0%'/'100%' (definitively lost/won), which the spec's explicit "10-90%" range excludes.
// ---------------------------------------------------------------------------

const PROBABILITY_BUCKETS = ['10%', '20%', '30%', '40%', '50%', '60%', '70%', '80%', '90%'];

export interface ProbabilityBucketSlice {
  bucket: string;
  count: number;
}

export async function fetchProbabilityDistribution(pool: Pool, filters: Filters): Promise<ProbabilityBucketSlice[]> {
  const { clause, params } = buildCrmWhereClause(filters, 'fo');
  const placeholders = PROBABILITY_BUCKETS.map(() => '?').join(', ');
  const sql = `
    SELECT fo.ProbabilityBucket AS bucket, COUNT(*) AS cnt
    FROM Fact_Opportunity fo
    WHERE fo.ProbabilityBucket IN (${placeholders}) AND ${clause} AND ${excludeLostClause('fo')}
    GROUP BY fo.ProbabilityBucket
  `;
  const [rows] = await pool.query(sql, [...PROBABILITY_BUCKETS, ...params]);
  const byBucket = new Map<string, number>();
  for (const r of rows as any[]) byBucket.set(String(r.bucket), Number(r.cnt));
  return PROBABILITY_BUCKETS.map((bucket) => ({ bucket, count: byBucket.get(bucket) ?? 0 }));
}

// ---------------------------------------------------------------------------
// Opportunity Details -- shared drill-through target for all 3 drillable Zone visuals. Returned as
// one full array (same "return full data once, filter client-side" convention as Customer Growth's
// Customers Table -- ~3.3K rows live, small enough to return eagerly).
// ---------------------------------------------------------------------------

export interface OpportunityDetailRow {
  opportunityId: string;
  name: string;
  customer: string | null;
  company: string | null;
  expectedRevenue: number;
  salesperson: string | null;
  stage: string | null;
  createdDate: string | null;
  expectedCloseDate: string | null;
  expectedCloseMonth: string | null;
  probabilityBucket: string | null;
  /** `fo.IsOpen` -- neither Won nor Lost. Unfiltered at the query level (see below), this row-level
   * flag is what lets the frontend apply the page's Won/Lost-exclusion policy per drill-down path
   * (month/bucket require it; stage -- Opportunity by Stage's exception -- doesn't). */
  isOpen: boolean;
}

/** Unfiltered by Won/Lost at the query level -- this is the shared drill-through target for
 * Expected Closure Opportunity, Opportunity by Stage, Probabilities Distribution, and the Full
 * Pipeline Opportunities bar, which don't all apply the same Won/Lost policy (Opportunity by Stage
 * is the page's one exception that keeps both). Returning the full universe here and filtering by
 * `isOpen` per drill-down path on the frontend (see pipeline-health/page.tsx's matchesFilter) keeps
 * every drill-down table's rows consistent with whichever bar/segment/bucket was clicked. */
export async function fetchOpportunityDetails(pool: Pool, filters: Filters): Promise<OpportunityDetailRow[]> {
  const { clause, params } = buildCrmWhereClause(filters, 'fo');
  const sql = `
    SELECT
      fo.OpportunityID AS opportunityId,
      fo.OpportunityName AS name,
      fo.Customer AS customer,
      fo.Company AS company,
      fo.ExpectedRevenue AS expectedRevenue,
      fo.Salesperson AS salesperson,
      fo.Stage AS stage,
      fo.OpportunityCreatedDate AS createdDate,
      fo.ExpectedCloseDate AS expectedCloseDate,
      YEAR(fo.ExpectedCloseDate) AS closeYear,
      MONTH(fo.ExpectedCloseDate) AS closeMonth,
      fo.ProbabilityBucket AS probabilityBucket,
      fo.IsOpen AS isOpen
    FROM Fact_Opportunity fo
    WHERE ${clause}
  `;
  const [rows] = await pool.query(sql, params);
  return (rows as any[]).map((r) => ({
    opportunityId: String(r.opportunityId),
    name: String(r.name ?? ''),
    customer: r.customer ?? null,
    company: r.company ?? null,
    expectedRevenue: Number(r.expectedRevenue ?? 0),
    salesperson: r.salesperson ?? null,
    stage: r.stage ?? null,
    createdDate: r.createdDate ? toDateOnlyString(r.createdDate) : null,
    expectedCloseDate: r.expectedCloseDate ? toDateOnlyString(r.expectedCloseDate) : null,
    expectedCloseMonth: r.closeMonth != null ? `${MONTH_LABELS[Number(r.closeMonth) - 1]} ${r.closeYear}` : null,
    probabilityBucket: r.probabilityBucket ?? null,
    isOpen: Boolean(Number(r.isOpen ?? 0)),
  }));
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface PipelineHealthOverview {
  funnel: FunnelCounts;
  funnelValues: FunnelValues;
  funnelOpportunityIds: FunnelOpportunityIds;
  funnelStageRecords: FunnelStageRecords;
  stageBenchmark: StageBenchmarkRow[];
  expectedClosureByMonth: ExpectedClosureMonthPoint[];
  opportunityByStage: StageValueSlice[];
  probabilityDistribution: ProbabilityBucketSlice[];
  opportunities: OpportunityDetailRow[];
}

export async function computePipelineHealthOverview(pool: Pool, anchor: Date, filters: Filters): Promise<PipelineHealthOverview> {
  const funnelStageRecords = await fetchFunnelStageRecords(pool, anchor, filters);
  const [funnelCounted, funnelOpportunityIds, expectedClosureByMonth, opportunityByStage, probabilityDistribution, opportunities] = await Promise.all([
    computeFunnelCounts(pool, anchor, filters, funnelStageRecords),
    fetchFunnelOpportunityIds(pool, anchor, filters),
    fetchExpectedClosureByMonth(pool, anchor, filters),
    fetchOpportunityByStage(pool, filters),
    fetchProbabilityDistribution(pool, filters),
    fetchOpportunityDetails(pool, filters),
  ]);
  const { counts: funnel, values: funnelValues } = funnelCounted;
  const stageBenchmark = computeStageBenchmark(funnel);
  return { funnel, funnelValues, funnelOpportunityIds, funnelStageRecords, stageBenchmark, expectedClosureByMonth, opportunityByStage, probabilityDistribution, opportunities };
}
