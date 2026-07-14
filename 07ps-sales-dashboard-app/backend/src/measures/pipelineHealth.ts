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
 * funnel and the Stage Benchmark that's derived from it (see computeStageBenchmark).
 */

import type { Pool } from 'mysql2/promise';
import { classifyVsTarget, variancePct, TargetStatus } from './classify';
import { buildCrmWhereClause, buildWhereClause, ytdWindow, type Filters } from './filters';

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

async function countOpportunities(pool: Pool, anchor: Date, filters: Filters): Promise<number> {
  const window = ytdWindow(anchor);
  const { clause, params } = buildCrmWhereClause(filters, 'fo');
  const sql = `
    SELECT COUNT(*) AS cnt FROM Fact_Opportunity fo
    WHERE DATE(fo.OpportunityCreatedDate) BETWEEN ? AND ? AND ${b2bClause('fo')} AND ${clause}
  `;
  return countRows(pool, sql, [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]);
}

/** Quotations linked to an Opportunity -- both still-pending ('Quotation') and already-converted
 * ('Sales Order') rows, since every Sales Order row started as a quotation (see module docstring). */
async function countLinkedQuotations(pool: Pool, anchor: Date, filters: Filters): Promise<number> {
  const window = ytdWindow(anchor);
  const { clause, params } = buildWhereClause(filters, 'fs');
  const sql = `
    SELECT COUNT(*) AS cnt FROM Fact_Sales fs
    WHERE fs.IsLinkedToOpportunity = 1 AND DATE(fs.QuotationDate) BETWEEN ? AND ? AND ${b2bClause('fs')} AND ${clause}
  `;
  return countRows(pool, sql, [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]);
}

async function countLinkedSalesOrders(pool: Pool, anchor: Date, filters: Filters): Promise<number> {
  const window = ytdWindow(anchor);
  const { clause, params } = buildWhereClause(filters, 'fs');
  const sql = `
    SELECT COUNT(*) AS cnt FROM Fact_Sales fs
    WHERE fs.SalesDocumentType = 'Sales Order' AND fs.IsLinkedToOpportunity = 1
      AND DATE(fs.QuotationDate) BETWEEN ? AND ? AND ${b2bClause('fs')} AND ${clause}
  `;
  return countRows(pool, sql, [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]);
}

/** Deliveries generated from Sales Orders that originated from an Opportunity. Can exceed the
 * Sales Orders count -- one order can have multiple partial delivery/picking records, a real
 * characteristic of the data, not a bug; shown as-is rather than clamped. */
async function countLinkedDeliveries(pool: Pool, anchor: Date, filters: Filters): Promise<number> {
  const window = ytdWindow(anchor);
  const { clause, params } = buildCrmWhereClause(filters, 'fd');
  const sql = `
    SELECT COUNT(*) AS cnt FROM Fact_Delivery fd
    WHERE fd.OpportunityID IS NOT NULL AND fd.OrderDate BETWEEN ? AND ? AND ${b2bClause('fd')} AND ${clause}
  `;
  return countRows(pool, sql, [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]);
}

export async function computeFunnelCounts(pool: Pool, anchor: Date, filters: Filters): Promise<FunnelCounts> {
  const [leads, opportunities, quotations, salesOrders, deliveries] = await Promise.all([
    countLeads(pool, anchor, filters),
    countOpportunities(pool, anchor, filters),
    countLinkedQuotations(pool, anchor, filters),
    countLinkedSalesOrders(pool, anchor, filters),
    countLinkedDeliveries(pool, anchor, filters),
  ]);
  return { leads, opportunities, quotations, salesOrders, deliveries };
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
  { transition: 'Lead → Opportunity', target: 0.5, from: 'leads', to: 'opportunities' },
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
// Spans future months (these are forward-looking dates), so no anchor clipping.
// ---------------------------------------------------------------------------

export interface ExpectedClosureMonthPoint {
  year: number;
  month: number;
  label: string;
  expectedCount: number;
  expectedValue: number;
}

export async function fetchExpectedClosureByMonth(pool: Pool, filters: Filters): Promise<ExpectedClosureMonthPoint[]> {
  const { clause, params } = buildCrmWhereClause(filters, 'fo');
  const sql = `
    SELECT
      YEAR(fo.ExpectedCloseDate) AS year,
      MONTH(fo.ExpectedCloseDate) AS month,
      COUNT(*) AS expectedCount,
      COALESCE(SUM(fo.ExpectedRevenue), 0) AS expectedValue
    FROM Fact_Opportunity fo
    WHERE fo.ExpectedCloseDate IS NOT NULL AND ${clause}
    GROUP BY YEAR(fo.ExpectedCloseDate), MONTH(fo.ExpectedCloseDate)
    ORDER BY year, month
  `;
  const [rows] = await pool.query(sql, params);
  return (rows as any[]).map((r) => ({
    year: Number(r.year),
    month: Number(r.month),
    label: `${MONTH_LABELS[Number(r.month) - 1]} ${r.year}`,
    expectedCount: Number(r.expectedCount),
    expectedValue: Number(r.expectedValue),
  }));
}

// ---------------------------------------------------------------------------
// Opportunity by Stage -- value distribution across current CRM stages.
// ---------------------------------------------------------------------------

export interface StageValueSlice {
  stage: string;
  value: number;
}

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
    WHERE fo.ProbabilityBucket IN (${placeholders}) AND ${clause}
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
  expectedCloseMonth: string | null;
  probabilityBucket: string | null;
}

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
      YEAR(fo.ExpectedCloseDate) AS closeYear,
      MONTH(fo.ExpectedCloseDate) AS closeMonth,
      fo.ProbabilityBucket AS probabilityBucket
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
    expectedCloseMonth: r.closeMonth != null ? `${MONTH_LABELS[Number(r.closeMonth) - 1]} ${r.closeYear}` : null,
    probabilityBucket: r.probabilityBucket ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface PipelineHealthOverview {
  funnel: FunnelCounts;
  stageBenchmark: StageBenchmarkRow[];
  expectedClosureByMonth: ExpectedClosureMonthPoint[];
  opportunityByStage: StageValueSlice[];
  probabilityDistribution: ProbabilityBucketSlice[];
  opportunities: OpportunityDetailRow[];
}

export async function computePipelineHealthOverview(pool: Pool, filters: Filters): Promise<PipelineHealthOverview> {
  const [funnel, expectedClosureByMonth, opportunityByStage, probabilityDistribution, opportunities] = await Promise.all([
    computeFunnelCounts(pool, filters),
    fetchExpectedClosureByMonth(pool, filters),
    fetchOpportunityByStage(pool, filters),
    fetchProbabilityDistribution(pool, filters),
    fetchOpportunityDetails(pool, filters),
  ]);
  const stageBenchmark = computeStageBenchmark(funnel);
  return { funnel, stageBenchmark, expectedClosureByMonth, opportunityByStage, probabilityDistribution, opportunities };
}
