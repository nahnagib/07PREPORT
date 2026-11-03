/**
 * Pipeline Health page metric definitions.
 *
 * Source tables (confirmed against the live warehouse this session -- these are the tables the
 * Python ETL's CRM builders actually write, distinct from the aspirational snake_case
 * `data/warehouse/migrations/` design; see measures/customerGrowth.ts's header for the same lesson
 * applied to dim_customer):
 *
 *   v_sales_leads        -- one row per CRM lead. Already pre-scoped to genuine CRM leads by the ETL's
 *                        own build-time filter (LeadType IN ('lead','systematic') OR
 *                        IsETLCreatedLead) -- "Leads = CRM Leads only" needs no extra WHERE clause.
 *   v_sales_opportunities -- one row per CRM opportunity, similarly pre-scoped to real CRM opportunities
 *                        by the ETL. Carries Stage/Probability/ProbabilityBucket/ExpectedRevenue/
 *                        ExpectedCloseDate/IsWon/IsLost/IsOpen directly.
 *   v_sales_documents       -- one row per Odoo sale.order id (the live name for the quotation-to-order
 *                        funnel fact -- NOT a revenue fact). SalesDocumentType flips from
 *                        'Quotation' to 'Sales Order' on the SAME row once the order is confirmed
 *                        (a current-state snapshot, not a permanent history), so "Quotations linked
 *                        to an Opportunity" must count every row with IsLinkedToOpportunity=1
 *                        regardless of its current SalesDocumentType -- every Sales Order row
 *                        started life as a quotation.
 *   v_sales_deliveries    -- one row per picking/delivery record. OpportunityID is already denormalized
 *                        directly onto this table from its linked Sales Order (no join needed).
 *
 * YEAR-TO-DATE ONLY (2026-09-21): the whole page is now limited to the current year. Every
 * opportunity-grain visual (Opportunity by Stage, Probabilities Distribution, Expected Closure,
 * Opportunity Details, the Full Pipeline chain, Data Quality) only includes opportunities CREATED
 * from Jan 1 of the current year through the anchor -- filtered on OpportunityCreatedDate, not
 * expected-close or last-modified date -- in the SQL WHERE clause, so earlier years are never
 * loaded. The anchor is clamped to the current year by filters.ts's parsePipelineAnchor. This
 * supersedes the "deliberately NOT B2B/YTD-scoped" remark below for those visuals (they are YTD
 * now; only the Full Pipeline funnel/chain is additionally B2B-only).
 *
 * Full Pipeline funnel is scoped to B2B (Fact_*.SalesSegment = 'B2B', confirmed live as a clean,
 * consistently-cased value on all 4 tables) + YTD -- "consistent with the existing rule that this
 * funnel only reflects CRM-managed transactions" (CRM/Odoo opportunity tracking in this business is
 * a B2B-only discipline; B2C walk-in sales never go through the CRM pipeline at all). Each stage is
 * scoped by its own natural date field: Leads/Opportunities by their own CreatedDate; Quotations
 * AND Sales Orders both by QuotationDate (the same v_sales_documents row's one fixed origination
 * timestamp, since a Sales Order row IS a Quotation row that later got confirmed -- using the same
 * field for both keeps the two stages counting the same YTD cohort of documents, not two different
 * ones); Deliveries by their linked order's OrderDate (v_sales_deliveries has no QuotationDate of its
 * own). Every other visual on this page (Expected Closure Opportunity, Opportunity by Stage,
 * Probabilities Distribution, Opportunity Details) is deliberately NOT B2B/YTD-scoped -- only the
 * funnel and the Stage Benchmark (computed on its own like-for-like cohort, see computeBenchmarkCohort). Expected
 * Closure Opportunity is anchor-scoped in a different sense, though: it's a forward-looking
 * forecast, not a YTD figure, so it starts at the anchor's own month and runs forward (see
 * fetchExpectedClosureByMonth) rather than being clipped to year-to-date.
 *
 * Status policy (2026-11-01, replaces the 2026-09 Won/Lost-exclusion policy): STAGE is where a deal sits in the
 * process, STATUS (OpportunityStatus: Pending / Won / Lost, filters.ts) is its outcome, set by Odoo's Won / Lost buttons.
 * A lost deal keeps its old stage in Odoo, so every stage-based visual -- the Full Pipeline Opportunities bar (+ its
 * drill-down, chain and Stage Benchmark), Opportunity by Stage, Probabilities Distribution and Expected Closure -- shows
 * OPEN opportunities only (`openOpportunityClause`, status Pending). Won and Lost are reported by status in Opportunities by
 * Status. The 2026-09 rule that matched the Opportunities bar to Odoo's "active" count (which includes Won cards) is
 * replaced: it now matches Odoo's pipeline filtered to won_status = pending. Archived-but-not-lost records are left out
 * everywhere. The shared Opportunity Details array carries every status (`status`) so it can back every drill-down
 * path; `matchesFilter` on the frontend applies the status per path. The funnel's Quotations/Sales Orders/Deliveries
 * bars stay unfiltered by status -- those documents already happened regardless of the opportunity's outcome.
 */

import type { Pool } from 'mysql2/promise';
import { classifyVsTarget, variancePct, TargetStatus } from './classify';
import {
  buildCrmWhereClause,
  buildWhereClause,
  excludeCancelledDocumentsClause,
  notArchivedClause,
  openOpportunityClause,
  OPPORTUNITY_STATUSES,
  type OpportunityStatus,
  ytdWindow,
  type Filters,
} from './filters';
import { computeOpportunityDataQuality, type DataQualityOverview } from './dataQuality';
import { odooConfiguredBaseUrl, odooFormUrl } from '../lib/odooLinks';
import type { PipelineStage, PipelineStageOrder } from '../config/pipelineStages';
import { fetchPipelineStageOrder } from './pipelineStages';

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
    SELECT COUNT(*) AS cnt FROM v_sales_leads fl
    WHERE DATE(fl.LeadCreatedDate) BETWEEN ? AND ? AND ${b2bClause('fl')} AND ${clause}
  `;
  return countRows(pool, sql, [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]);
}

/** The Full Pipeline Opportunities bar: open opportunities only (status Pending) -- Won deals have their own slice in
 * Opportunity by Status. Matches Odoo's pipeline filtered to won_status = pending. Returns count + value
 * (SUM(ExpectedRevenue)) in one query since Stage Benchmark needs the count and the funnel's hover/legend the value. */
async function fetchOpportunitiesCountAndValue(pool: Pool, anchor: Date, filters: Filters): Promise<{ count: number; value: number }> {
  const window = ytdWindow(anchor);
  const { clause, params } = buildCrmWhereClause(filters, 'fo');
  const sql = `
    SELECT COUNT(*) AS cnt, COALESCE(SUM(fo.ExpectedRevenue), 0) AS val FROM v_sales_opportunities fo
    WHERE DATE(fo.OpportunityCreatedDate) BETWEEN ? AND ? AND ${b2bClause('fo')} AND ${clause} AND ${openOpportunityClause('fo')}
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
/** A warehouse id column as an Odoo record id (odooFormUrl drops anything that is not an integer > 0, e.g. -1 Unknown). */
function odooId(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

export interface FunnelSalesRecord {
  orderNumber: string;
  customer: string | null;
  company: string | null;
  salesperson: string | null;
  documentDate: string | null;
  value: number;
  /** v_sales_documents.OrderDate (confirmation date for a Sales Order). */
  orderDate: string | null;
  /** Raw Odoo sale.order state (draft/sent/sale/done/cancel). */
  orderState: string | null;
  /** 'Quotation' | 'Sales Order' -- the row's CURRENT type (see module docstring). */
  documentType: string | null;
  /** null = no linked Opportunity ("Tracking > Opportunity" empty on the Odoo form). */
  opportunityId: string | null;
  /** The sale.order form in Odoo (SalesOrderKey, in its own company); null without ODOO_WEB_BASE_URL / ODOO_URL or id. */
  odooUrl: string | null;
  /** The customer's res.partner form (CustomerKey = commercial partner). */
  customerOdooUrl: string | null;
}

export interface FunnelDeliveryRecord {
  orderNumber: string | null;
  customer: string | null;
  company: string | null;
  salesperson: string | null;
  orderDate: string | null;
  deliveryStatus: string | null;
  /** Picking/delivery reference; null for a sales order with no picking yet. */
  deliveryReference: string | null;
  deliveryDate: string | null;
  opportunityId: string | null;
  /** The stock.picking form (PickingID); null for an order with no picking yet. */
  odooUrl: string | null;
  /** The sale.order the picking belongs to (SalesOrderID). */
  orderOdooUrl: string | null;
  customerOdooUrl: string | null;
}

export interface FunnelStageRecords {
  quotations: FunnelSalesRecord[];
  salesOrders: FunnelSalesRecord[];
  deliveries: FunnelDeliveryRecord[];
}

function toFunnelSalesRecord(r: any, base: string | null): FunnelSalesRecord {
  const companyKey = odooId(r.companyKey);
  return {
    orderNumber: String(r.orderNumber ?? ''),
    customer: r.customer ?? null,
    company: r.company ?? null,
    salesperson: r.salesperson ?? null,
    documentDate: r.documentDate ? toDateOnlyString(r.documentDate) : null,
    value: Number(r.value ?? 0),
    orderDate: r.orderDate ? toDateOnlyString(r.orderDate) : null,
    orderState: r.orderState ?? null,
    documentType: r.documentType ?? null,
    opportunityId: r.opportunityId != null ? String(r.opportunityId) : null,
    odooUrl: odooFormUrl(base, 'sale.order', odooId(r.odooOrderId), companyKey),
    customerOdooUrl: odooFormUrl(base, 'res.partner', odooId(r.partnerId), companyKey),
  };
}

/** Quotations -- both still-pending ('Quotation') and already-converted ('Sales Order') rows,
 * since every Sales Order row started as a quotation (see module docstring); cancelled documents are not pipeline
 * and are left out (excludeCancelledDocumentsClause). Opportunity linkage is
 * NOT filtered here -- every B2B/YTD row is returned so the caller can derive both the linked count
 * and the unlinked "with no Opportunities" list from one fetch. */
async function fetchQuotationRecords(pool: Pool, anchor: Date, filters: Filters): Promise<FunnelSalesRecord[]> {
  const window = ytdWindow(anchor);
  const { clause, params } = buildWhereClause(filters, 'fs');
  const sql = `
    SELECT fs.OrderNumber AS orderNumber, fs.Customer AS customer, fs.Company AS company,
           COALESCE(sap.admin_name_override, fs.Salesperson) AS salesperson,
           fs.QuotationDate AS documentDate, fs.OrderValue AS value,
           fs.OrderDate AS orderDate, fs.OrderState AS orderState, fs.SalesDocumentType AS documentType,
           fs.OpportunityID AS opportunityId,
           fs.SalesOrderKey AS odooOrderId, fs.CustomerKey AS partnerId, fs.CompanyKey AS companyKey
    FROM v_sales_documents fs
    LEFT JOIN salesperson_admin_profile sap ON sap.salesperson_key = fs.SalespersonKey
    WHERE DATE(fs.QuotationDate) BETWEEN ? AND ? AND ${b2bClause('fs')} AND ${excludeCancelledDocumentsClause('fs')} AND ${clause}
  `;
  const [rows] = await pool.query(sql, [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]);
  const base = odooConfiguredBaseUrl();
  return (rows as any[]).map((r) => toFunnelSalesRecord(r, base));
}

async function fetchSalesOrderRecords(pool: Pool, anchor: Date, filters: Filters): Promise<FunnelSalesRecord[]> {
  const window = ytdWindow(anchor);
  const { clause, params } = buildWhereClause(filters, 'fs');
  const sql = `
    SELECT fs.OrderNumber AS orderNumber, fs.Customer AS customer, fs.Company AS company,
           COALESCE(sap.admin_name_override, fs.Salesperson) AS salesperson,
           fs.QuotationDate AS documentDate, fs.OrderValue AS value,
           fs.OrderDate AS orderDate, fs.OrderState AS orderState, fs.SalesDocumentType AS documentType,
           fs.OpportunityID AS opportunityId,
           fs.SalesOrderKey AS odooOrderId, fs.CustomerKey AS partnerId, fs.CompanyKey AS companyKey
    FROM v_sales_documents fs
    LEFT JOIN salesperson_admin_profile sap ON sap.salesperson_key = fs.SalespersonKey
    WHERE fs.SalesDocumentType = 'Sales Order' AND DATE(fs.QuotationDate) BETWEEN ? AND ? AND ${b2bClause('fs')}
      AND ${excludeCancelledDocumentsClause('fs')} AND ${clause}
  `;
  const [rows] = await pool.query(sql, [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]);
  const base = odooConfiguredBaseUrl();
  return (rows as any[]).map((r) => toFunnelSalesRecord(r, base));
}

/** Row count can exceed the Sales Orders row count -- one order can have multiple partial
 * delivery/picking records, a real characteristic of the data, not a bug; shown as-is rather than
 * clamped in the drill-down table. The funnel bar itself counts distinct Opportunities, not rows
 * (see countLinkedOpportunities), so it isn't affected by this. */
async function fetchDeliveryRecords(pool: Pool, anchor: Date, filters: Filters): Promise<FunnelDeliveryRecord[]> {
  const window = ytdWindow(anchor);
  const { clause, params } = buildCrmWhereClause(filters, 'fd');
  const sql = `
    SELECT fd.OrderNumber AS orderNumber, fd.Customer AS customer, fd.Company AS company,
           COALESCE(sap.admin_name_override, fd.Salesperson) AS salesperson,
           fd.OrderDate AS orderDate, fd.DeliveryStatus AS deliveryStatus,
           fd.DeliveryReference AS deliveryReference, fd.DeliveryDate AS deliveryDate,
           fd.OpportunityID AS opportunityId,
           fd.PickingID AS pickingId, fd.SalesOrderID AS odooOrderId, fd.CustomerKey AS partnerId, fd.CompanyKey AS companyKey
    FROM v_sales_deliveries fd
    LEFT JOIN salesperson_admin_profile sap ON sap.salesperson_key = fd.SalespersonKey
    WHERE fd.OrderDate BETWEEN ? AND ? AND ${b2bClause('fd')} AND ${clause}
  `;
  const [rows] = await pool.query(sql, [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]);
  const base = odooConfiguredBaseUrl();
  return (rows as any[]).map((r) => ({
    orderNumber: r.orderNumber != null ? String(r.orderNumber) : null,
    customer: r.customer ?? null,
    company: r.company ?? null,
    salesperson: r.salesperson ?? null,
    orderDate: r.orderDate ? toDateOnlyString(r.orderDate) : null,
    deliveryStatus: r.deliveryStatus ?? null,
    deliveryReference: r.deliveryReference != null ? String(r.deliveryReference) : null,
    deliveryDate: r.deliveryDate ? toDateOnlyString(r.deliveryDate) : null,
    opportunityId: r.opportunityId != null ? String(r.opportunityId) : null,
    odooUrl: odooFormUrl(base, 'stock.picking', odooId(r.pickingId), odooId(r.companyKey)),
    orderOdooUrl: odooFormUrl(base, 'sale.order', odooId(r.odooOrderId), odooId(r.companyKey)),
    customerOdooUrl: odooFormUrl(base, 'res.partner', odooId(r.partnerId), odooId(r.companyKey)),
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

/** Distinct Opportunities represented among the linked rows, not a row count. A single Opportunity
 * can have several Quotation revisions, several confirmed Sales Orders, or several partial
 * Deliveries -- counting rows directly (countLinked) counts each of those separately, which let a
 * downstream stage's raw row count exceed the Opportunities count it's supposed to be a subset of
 * (e.g. one Opportunity's 3 delivery rows would out-count 1 Opportunity). The funnel is a "how many
 * of my Opportunities got at least this far" drop-off chart, not a document-volume count, so each
 * stage's bar must count distinct Opportunities to stay a subset of the stage above it. */
function countLinkedOpportunities(rows: { opportunityId: string | null }[]): number {
  return new Set(rows.filter((r) => r.opportunityId != null).map((r) => r.opportunityId)).size;
}

/** Sum of `value` across linked (opportunityId != null) rows -- same population as countLinked
 * above, just summed instead of counted. Used for the Quotations/Sales Orders funnel stages'
 * hover/legend value. */
function sumLinkedValue(rows: { opportunityId: string | null; value: number }[]): number {
  return rows.filter((r) => r.opportunityId != null).reduce((sum, r) => sum + r.value, 0);
}

/** v_sales_deliveries carries no monetary value of its own (quantities only -- confirmed against the
 * live schema), and a single order can have multiple partial delivery rows, so summing a per-row
 * value would double-count. Instead: build an orderNumber -> value map from the Quotations stage
 * records (a superset of every v_sales_documents row, pending or converted, each order's value is stable
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
    quotations: countLinkedOpportunities(stageRecords.quotations),
    salesOrders: countLinkedOpportunities(stageRecords.salesOrders),
    deliveries: countLinkedOpportunities(stageRecords.deliveries),
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
    SELECT DISTINCT fl.OpportunityID AS opportunityId FROM v_sales_leads fl
    WHERE DATE(fl.LeadCreatedDate) BETWEEN ? AND ? AND ${b2bClause('fl')} AND ${clause} AND fl.OpportunityID IS NOT NULL
  `;
  return fetchIdRows(pool, sql, [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]);
}

/** Open only, matching fetchOpportunitiesCountAndValue above, so clicking the Opportunities bar drills down into
 * exactly what that bar counted. */
async function fetchOpportunityStageIds(pool: Pool, anchor: Date, filters: Filters): Promise<string[]> {
  const window = ytdWindow(anchor);
  const { clause, params } = buildCrmWhereClause(filters, 'fo');
  const sql = `
    SELECT fo.OpportunityID AS opportunityId FROM v_sales_opportunities fo
    WHERE DATE(fo.OpportunityCreatedDate) BETWEEN ? AND ? AND ${b2bClause('fo')} AND ${clause} AND ${openOpportunityClause('fo')}
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
// BY VALUE (LYD), 2026-11-03: each step = value of the next stage ÷ value of the previous one, on the option-A cohort.
// ---------------------------------------------------------------------------

export interface StageBenchmarkRow {
  transition: string;
  /** Cohort values (LYD) behind actualPct (see computeStageBenchmark): the "from" / "to" step's value. */
  fromValue: number;
  toValue: number;
  /** Cohort counts: opportunities that reached the "from" / "to" step (the count-based view, kept for reference). */
  fromCount: number;
  toCount: number;
  /** toValue ÷ fromValue. */
  actualPct: number | null;
  /** toCount ÷ fromCount -- the pre-2026-11-03 definition, which the targets were set for. Not shown on the page. */
  countPct: number | null;
  targetPct: number;
  status: TargetStatus;
  variancePct: number | null;
}

type BenchmarkStep = keyof BenchmarkCohort['values'];

/** The targets were set for the count-based definition (2026-11-03: kept for now, pending new value-based targets). */
const STAGE_TARGETS: { transition: string; target: number; from: BenchmarkStep; to: BenchmarkStep }[] = [
  { transition: 'Opportunity → Quotation', target: 0.8, from: 'opportunities', to: 'quotations' },
  { transition: 'Quotation → Sales Order', target: 0.15, from: 'quotations', to: 'salesOrders' },
  { transition: 'Sales Order → Delivery', target: 0.98, from: 'salesOrders', to: 'deliveries' },
];

/** The like-for-like population the Stage Benchmark is computed on (option A, 2026-11-01): every B2B opportunity created
 * in the period whatever its status (Pending + Won + Lost; Archived left out), and how many of THOSE SAME opportunities
 * reached each later step. The Full Pipeline Opportunities bar shows open (Pending) only, but won deals are the ones that
 * reached orders, so dividing documents of every deal by open deals would read above 100%. Each step is a subset of the
 * one before, so no count ratio can exceed 100%.
 *
 * `values` (LYD, 2026-11-03) are the same steps by value:
 *   opportunities = Σ expected revenue of the cohort opportunities;
 *   quotations    = Σ value of their non-cancelled quotations (every revision, like the funnel's Quotations value);
 *   salesOrders   = Σ value of those quotations that became sales orders;
 *   deliveries    = Σ value of those sales orders whose delivery has started (each order once, however many pickings).
 * Sales orders are a subset of the quotations and delivered orders a subset of the sales orders, so those two steps stay
 * at or under 100%; quotations can be worth more than the opportunity's expected revenue, so the first step can pass 100%.
 * Amounts are the warehouse's: OrderValue is converted to the company currency (LYD) by the ETL like Odoo's sale.report,
 * and expected revenue is in the company currency; every in-scope company keeps its books in LYD. */
export interface BenchmarkCohort {
  opportunities: number;
  quotations: number;
  salesOrders: number;
  deliveries: number;
  values: { opportunities: number; quotations: number; salesOrders: number; deliveries: number };
}

export interface BenchmarkCohortOpportunity {
  opportunityId: string;
  expectedRevenue: number;
}

async function fetchBenchmarkOpportunities(pool: Pool, anchor: Date, filters: Filters): Promise<BenchmarkCohortOpportunity[]> {
  const window = ytdWindow(anchor);
  const { clause, params } = buildCrmWhereClause(filters, 'fo');
  const sql = `
    SELECT fo.OpportunityID AS opportunityId, fo.ExpectedRevenue AS expectedRevenue FROM v_sales_opportunities fo
    WHERE DATE(fo.OpportunityCreatedDate) BETWEEN ? AND ? AND ${b2bClause('fo')} AND ${clause} AND ${notArchivedClause('fo')}
  `;
  const [rows] = await pool.query(sql, [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]);
  return (rows as any[]).map((r) => ({ opportunityId: String(r.opportunityId), expectedRevenue: Number(r.expectedRevenue ?? 0) }));
}

export function computeBenchmarkCohort(cohortRows: BenchmarkCohortOpportunity[], stageRecords: FunnelStageRecords): BenchmarkCohort {
  const cohort = new Set(cohortRows.map((r) => r.opportunityId));
  const within = <T extends { opportunityId: string | null }>(rows: T[], ids: Set<string>) =>
    rows.filter((r) => r.opportunityId != null && ids.has(r.opportunityId));
  const idsOf = (rows: { opportunityId: string | null }[]) => new Set(rows.map((r) => r.opportunityId as string));

  const quotationRows = within(stageRecords.quotations, cohort);
  const quoted = idsOf(quotationRows);
  const orderRows = within(stageRecords.salesOrders, quoted);
  const ordered = idsOf(orderRows);
  const deliveredRows = within(stageRecords.deliveries.filter((d) => isDelivered(d.deliveryStatus)), ordered);
  const delivered = idsOf(deliveredRows);

  // Delivered value: each cohort sales order with a started delivery, once, at its order value.
  const deliveredOrderNumbers = new Set(deliveredRows.map((d) => d.orderNumber).filter((n): n is string => !!n));
  const orderValue = new Map<string, number>();
  for (const o of orderRows) if (o.orderNumber) orderValue.set(o.orderNumber, o.value);
  let deliveredValue = 0;
  for (const n of deliveredOrderNumbers) deliveredValue += orderValue.get(n) ?? 0;

  const sum = (rows: { value: number }[]) => rows.reduce((s, r) => s + r.value, 0);
  return {
    opportunities: cohort.size,
    quotations: quoted.size,
    salesOrders: ordered.size,
    deliveries: delivered.size,
    values: {
      opportunities: cohortRows.reduce((s, r) => s + r.expectedRevenue, 0),
      quotations: sum(quotationRows),
      salesOrders: sum(orderRows),
      deliveries: deliveredValue,
    },
  };
}

/** A delivery counts as reached once it has started (Started / Partially / Fully Delivered), not "Not Delivered". */
function isDelivered(status: string | null): boolean {
  return status != null && !/^not delivered$/i.test(status.trim());
}

export function computeStageBenchmark(cohort: BenchmarkCohort): StageBenchmarkRow[] {
  return STAGE_TARGETS.map(({ transition, target, from, to }) => {
    const fromCount = cohort[from];
    const toCount = cohort[to];
    const fromValue = cohort.values[from];
    const toValue = cohort.values[to];
    const actualPct = fromValue > 0 ? toValue / fromValue : null;
    return {
      transition,
      fromValue,
      toValue,
      fromCount,
      toCount,
      actualPct,
      countPct: fromCount > 0 ? toCount / fromCount : null,
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
// and runs forward through however many months of real data actually exist -- NOT a fixed
// months-ahead count. A hardcoded `monthsAhead` (previously 12) silently cut off any real
// expected-closure data sitting further out than that -- confirmed live (2026-09): open B2B
// opportunities have ExpectedCloseDate values into January 2028, more than a year past a 12-month
// window from "today." The window here is instead bounded by the furthest month the unbounded query
// below actually returns (or just the anchor's own month if there's no future data at all, so the
// chart still renders one zero-filled bar instead of an empty array). Zero-filled in between so a
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

export async function fetchExpectedClosureByMonth(pool: Pool, anchor: Date, filters: Filters): Promise<ExpectedClosureMonthPoint[]> {
  const { clause, params } = buildCrmWhereClause(filters, 'fo');
  const startYear = anchor.getUTCFullYear();
  const startMonth = anchor.getUTCMonth() + 1;
  const rangeStart = new Date(Date.UTC(startYear, startMonth - 1, 1));
  const window = ytdWindow(anchor);

  const sql = `
    SELECT
      YEAR(fo.ExpectedCloseDate) AS year,
      MONTH(fo.ExpectedCloseDate) AS month,
      COUNT(*) AS expectedCount,
      COALESCE(SUM(fo.ExpectedRevenue), 0) AS expectedValue
    FROM v_sales_opportunities fo
    WHERE fo.ExpectedCloseDate >= ? AND DATE(fo.OpportunityCreatedDate) BETWEEN ? AND ? AND ${clause} AND ${openOpportunityClause('fo')}
    GROUP BY YEAR(fo.ExpectedCloseDate), MONTH(fo.ExpectedCloseDate)
    ORDER BY year, month
  `;
  const [rows] = await pool.query(sql, [toDateOnlyString(rangeStart), toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]);
  const byYearMonth = new Map<string, { count: number; value: number }>();
  let monthsAhead = 1;
  for (const r of rows as any[]) {
    const year = Number(r.year);
    const month = Number(r.month);
    byYearMonth.set(`${year}-${month}`, { count: Number(r.expectedCount), value: Number(r.expectedValue) });
    const monthIndex = (year - startYear) * 12 + (month - startMonth) + 1;
    monthsAhead = Math.max(monthsAhead, monthIndex);
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
// Opportunity by Stage -- value distribution across current CRM stages, in pipeline order (config/pipelineStages.ts),
// not by value, so every page lists the stages the same way.
// ---------------------------------------------------------------------------

export interface StageValueSlice {
  stageId: number | null;
  stage: string;
  /** Place in the pipeline order (config/pipelineStages.ts). */
  position: number;
  /** Theme colour token (frontend --ps-stage-<colorKey>); the same stage has the same colour on every chart. */
  colorKey: string;
  value: number;
  count: number;
}

/** Only opportunities CREATED in the current year (DATE(OpportunityCreatedDate) from Jan 1 through
 * the anchor), OPEN only (status Pending): a deal marked Lost keeps its old stage in Odoo, so without the status it would
 * still count there. Won and Lost are shown by status in Opportunity by Status. */
export async function fetchOpportunityByStage(pool: Pool, anchor: Date, filters: Filters, stageOrder?: PipelineStageOrder): Promise<StageValueSlice[]> {
  const window = ytdWindow(anchor);
  const { clause, params } = buildCrmWhereClause(filters, 'fo');
  const sql = `
    SELECT fo.StageID AS stageId, MAX(fo.Stage) AS stage, COALESCE(SUM(fo.ExpectedRevenue), 0) AS value, COUNT(*) AS cnt
    FROM v_sales_opportunities fo
    WHERE DATE(fo.OpportunityCreatedDate) BETWEEN ? AND ? AND ${clause} AND ${openOpportunityClause('fo')}
    GROUP BY fo.StageID
  `;
  const [[rows], order] = await Promise.all([
    pool.query(sql, [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]),
    stageOrder ? Promise.resolve(stageOrder) : fetchPipelineStageOrder(pool),
  ]);
  return (rows as any[])
    .map((r) => {
      const s = order.of(r.stageId != null ? Number(r.stageId) : null, r.stage ?? null);
      return { stageId: s.stageId, stage: String(r.stage ?? s.stage), position: s.position, colorKey: s.colorKey, value: Number(r.value), count: Number(r.cnt) };
    })
    .sort((a, b) => a.position - b.position || a.stage.localeCompare(b.stage));
}

// ---------------------------------------------------------------------------
// Opportunity by Status -- the outcome (Odoo won_status: Won / Lost / Pending), never the stage. Same population as Opportunity by Stage
// (created YTD, page filters + role scope via buildCrmWhereClause) but every status, so the slices add up to every
// opportunity in scope except the archived-but-not-lost ones, which are counted separately.
// ---------------------------------------------------------------------------

export interface StatusSlice {
  status: OpportunityStatus;
  count: number;
  expectedRevenue: number;
}

export interface OpportunitiesByStatus {
  slices: StatusSlice[];
  /** Archived without being marked Lost (archived, probability > 0): no outcome, in no slice. */
  archivedCount: number;
}

export async function fetchOpportunitiesByStatus(pool: Pool, anchor: Date, filters: Filters): Promise<OpportunitiesByStatus> {
  const window = ytdWindow(anchor);
  const { clause, params } = buildCrmWhereClause(filters, 'fo');
  const sql = `
    SELECT fo.OpportunityStatus AS status, COUNT(*) AS cnt, COALESCE(SUM(fo.ExpectedRevenue), 0) AS val
    FROM v_sales_opportunities fo
    WHERE DATE(fo.OpportunityCreatedDate) BETWEEN ? AND ? AND ${clause}
    GROUP BY fo.OpportunityStatus
  `;
  const [rows] = await pool.query(sql, [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]);
  const byStatus = new Map((rows as any[]).map((r) => [String(r.status), { count: Number(r.cnt), value: Number(r.val) }]));
  return {
    slices: OPPORTUNITY_STATUSES.map((status) => ({
      status,
      count: byStatus.get(status)?.count ?? 0,
      expectedRevenue: byStatus.get(status)?.value ?? 0,
    })),
    archivedCount: byStatus.get('Archived')?.count ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Probabilities Distribution -- expected revenue (LYD) and opportunity count per 10-90% ProbabilityBucket (2026-11-03:
// the bars show the value, the count is in the tooltip). Live buckets also include '0%'/'100%', which the spec's explicit
// "10-90%" range excludes; open deals there are the gap between the buckets' total and the Total Pipeline Value.
// ---------------------------------------------------------------------------

const PROBABILITY_BUCKETS = ['10%', '20%', '30%', '40%', '50%', '60%', '70%', '80%', '90%'];

export interface ProbabilityBucketSlice {
  bucket: string;
  count: number;
  /** Σ ExpectedRevenue (LYD). */
  value: number;
}

export async function fetchProbabilityDistribution(pool: Pool, anchor: Date, filters: Filters): Promise<ProbabilityBucketSlice[]> {
  const window = ytdWindow(anchor);
  const { clause, params } = buildCrmWhereClause(filters, 'fo');
  const placeholders = PROBABILITY_BUCKETS.map(() => '?').join(', ');
  const sql = `
    SELECT fo.ProbabilityBucket AS bucket, COUNT(*) AS cnt, COALESCE(SUM(fo.ExpectedRevenue), 0) AS val
    FROM v_sales_opportunities fo
    WHERE fo.ProbabilityBucket IN (${placeholders}) AND DATE(fo.OpportunityCreatedDate) BETWEEN ? AND ? AND ${clause} AND ${openOpportunityClause('fo')}
    GROUP BY fo.ProbabilityBucket
  `;
  const [rows] = await pool.query(sql, [...PROBABILITY_BUCKETS, toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]);
  const byBucket = new Map<string, { count: number; value: number }>();
  for (const r of rows as any[]) byBucket.set(String(r.bucket), { count: Number(r.cnt), value: Number(r.val ?? 0) });
  return PROBABILITY_BUCKETS.map((bucket) => ({ bucket, count: byBucket.get(bucket)?.count ?? 0, value: byBucket.get(bucket)?.value ?? 0 }));
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
  stageId: number | null;
  /** Place of the stage in the pipeline order (config/pipelineStages.ts), for sorting the Stage column. */
  stagePosition: number;
  createdDate: string | null;
  expectedCloseDate: string | null;
  expectedCloseMonth: string | null;
  probabilityBucket: string | null;
  /** The outcome (Pending / Won / Lost). Every status is returned (see below); the frontend applies the status each
   * drill-down path needs (stage/month/bucket: New; a status slice: that status). */
  status: OpportunityStatus;
  /** status === 'Pending'. */
  isOpen: boolean;
  /** The crm.lead form in Odoo (OpportunityID, in its own company); null without ODOO_WEB_BASE_URL / ODOO_URL or id. */
  odooUrl: string | null;
  customerOdooUrl: string | null;
}

/** Every status (Pending / Won / Lost; Archived left out) -- this is the shared drill-through target for Expected Closure,
 * Opportunity by Stage, Probabilities Distribution, Opportunity by Status and the Full Pipeline Opportunities bar.
 * Returning every status here and filtering by `status` per drill-down path on the frontend (see pipeline-health/
 * page.tsx's matchesFilter) keeps every drill-down table's rows consistent with whichever bar/segment was clicked. */
export async function fetchOpportunityDetails(pool: Pool, anchor: Date, filters: Filters, stageOrder?: PipelineStageOrder): Promise<OpportunityDetailRow[]> {
  const window = ytdWindow(anchor);
  const { clause, params } = buildCrmWhereClause(filters, 'fo');
  const sql = `
    SELECT
      fo.OpportunityID AS opportunityId,
      fo.OpportunityName AS name,
      fo.Customer AS customer,
      fo.Company AS company,
      fo.ExpectedRevenue AS expectedRevenue,
      COALESCE(sap.admin_name_override, fo.Salesperson) AS salesperson,
      fo.Stage AS stage,
      fo.StageID AS stageId,
      fo.OpportunityCreatedDate AS createdDate,
      fo.ExpectedCloseDate AS expectedCloseDate,
      YEAR(fo.ExpectedCloseDate) AS closeYear,
      MONTH(fo.ExpectedCloseDate) AS closeMonth,
      fo.ProbabilityBucket AS probabilityBucket,
      fo.OpportunityStatus AS status,
      fo.CustomerKey AS partnerId,
      fo.CompanyKey AS companyKey
    FROM v_sales_opportunities fo
    LEFT JOIN salesperson_admin_profile sap ON sap.salesperson_key = fo.SalespersonKey
    WHERE DATE(fo.OpportunityCreatedDate) BETWEEN ? AND ? AND ${clause} AND ${notArchivedClause('fo')}
  `;
  const [[rows], order] = await Promise.all([
    pool.query(sql, [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]),
    stageOrder ? Promise.resolve(stageOrder) : fetchPipelineStageOrder(pool),
  ]);
  const base = odooConfiguredBaseUrl();
  return (rows as any[]).map((r) => ({
    opportunityId: String(r.opportunityId),
    name: String(r.name ?? ''),
    customer: r.customer ?? null,
    company: r.company ?? null,
    expectedRevenue: Number(r.expectedRevenue ?? 0),
    salesperson: r.salesperson ?? null,
    stage: r.stage ?? null,
    stageId: r.stageId != null ? Number(r.stageId) : null,
    stagePosition: order.of(r.stageId != null ? Number(r.stageId) : null, r.stage ?? null).position,
    createdDate: r.createdDate ? toDateOnlyString(r.createdDate) : null,
    expectedCloseDate: r.expectedCloseDate ? toDateOnlyString(r.expectedCloseDate) : null,
    expectedCloseMonth: r.closeMonth != null ? `${MONTH_LABELS[Number(r.closeMonth) - 1]} ${r.closeYear}` : null,
    probabilityBucket: r.probabilityBucket ?? null,
    status: r.status as OpportunityStatus,
    isOpen: r.status === 'Pending',
    odooUrl: odooFormUrl(base, 'crm.lead', odooId(r.opportunityId), odooId(r.companyKey)),
    customerOdooUrl: odooFormUrl(base, 'res.partner', odooId(r.partnerId), odooId(r.companyKey)),
  }));
}

// ---------------------------------------------------------------------------
// Full Pipeline chain -- one row per B2B, current-year opportunity (same population as the funnel's
// Opportunities bar: created YTD, open only), with every linked Quotation / Sales Order /
// Delivery. Links used (all already in the warehouse, nothing inferred):
//   Opportunity -> Quotation / Sales Order : v_sales_documents.OpportunityID (one v_sales_documents row is the
//                                            quotation and, once confirmed, the same row is the SO)
//   Sales Order -> Delivery                : v_sales_deliveries.OpportunityID (denormalised from the SO)
//                                            + v_sales_deliveries.OrderNumber
// Built from the funnel's stage records (already B2B + YTD scoped), so the chain can never disagree
// with the funnel's drill-downs.
// ---------------------------------------------------------------------------

export type ChainStage = 'opportunity' | 'quotation' | 'salesOrder' | 'delivery';

export interface ChainDocument {
  number: string;
  date: string | null;
  value: number;
  status: string | null;
}

export interface OpportunityChainRow {
  opportunityId: string;
  name: string;
  customer: string | null;
  salesperson: string | null;
  stage: string | null;
  createdDate: string | null;
  isWon: boolean;
  opportunity: ChainDocument;
  quotations: ChainDocument[];
  salesOrders: ChainDocument[];
  deliveries: ChainDocument[];
  /** Furthest stage the opportunity has reached. */
  reachedStage: ChainStage;
}

export interface ChainStageTotal {
  /** Distinct opportunities that reached this stage. */
  opportunities: number;
  /** Documents at this stage (an opportunity can have several). */
  documents: number;
  value: number;
}

export interface OpportunityChains {
  rows: OpportunityChainRow[];
  totals: Record<'opportunities' | 'quotations' | 'salesOrders' | 'deliveries', ChainStageTotal>;
}

const QUOTATION_STATE_LABEL: Record<string, string> = { draft: 'Draft', sent: 'Sent', cancel: 'Cancelled' };
const ORDER_STATE_LABEL: Record<string, string> = { sale: 'Confirmed', done: 'Locked', cancel: 'Cancelled', draft: 'Draft', sent: 'Sent' };

function quotationStatus(r: FunnelSalesRecord): string | null {
  if (r.documentType === 'Sales Order') return 'Converted to Sales Order';
  return r.orderState ? QUOTATION_STATE_LABEL[r.orderState] ?? r.orderState : null;
}

function salesOrderStatus(r: FunnelSalesRecord): string | null {
  return r.orderState ? ORDER_STATE_LABEL[r.orderState] ?? r.orderState : null;
}

async function fetchChainOpportunities(pool: Pool, anchor: Date, filters: Filters) {
  const window = ytdWindow(anchor);
  const { clause, params } = buildCrmWhereClause(filters, 'fo');
  const sql = `
    SELECT fo.OpportunityID AS opportunityId, fo.OpportunityName AS name, fo.Customer AS customer,
           COALESCE(sap.admin_name_override, fo.Salesperson) AS salesperson, fo.Stage AS stage,
           fo.OpportunityCreatedDate AS createdDate, fo.ExpectedRevenue AS expectedRevenue, fo.IsWon AS isWon
    FROM v_sales_opportunities fo
    LEFT JOIN salesperson_admin_profile sap ON sap.salesperson_key = fo.SalespersonKey
    WHERE DATE(fo.OpportunityCreatedDate) BETWEEN ? AND ? AND ${b2bClause('fo')} AND ${clause} AND ${openOpportunityClause('fo')}
    ORDER BY fo.OpportunityCreatedDate DESC
  `;
  const [rows] = await pool.query(sql, [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]);
  return rows as any[];
}

function groupByOpportunity<T extends { opportunityId: string | null }>(rows: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const r of rows) {
    if (r.opportunityId == null) continue;
    const list = map.get(r.opportunityId);
    if (list) list.push(r);
    else map.set(r.opportunityId, [r]);
  }
  return map;
}

export async function computeOpportunityChains(pool: Pool, anchor: Date, filters: Filters, stageRecords: FunnelStageRecords): Promise<OpportunityChains> {
  const opps = await fetchChainOpportunities(pool, anchor, filters);
  const quotesByOpp = groupByOpportunity(stageRecords.quotations);
  const ordersByOpp = groupByOpportunity(stageRecords.salesOrders);
  const deliveriesByOpp = groupByOpportunity(stageRecords.deliveries);
  const valueByOrderNumber = new Map<string, number>();
  for (const q of stageRecords.quotations) if (q.orderNumber) valueByOrderNumber.set(q.orderNumber, q.value);

  const totals: OpportunityChains['totals'] = {
    opportunities: { opportunities: 0, documents: 0, value: 0 },
    quotations: { opportunities: 0, documents: 0, value: 0 },
    salesOrders: { opportunities: 0, documents: 0, value: 0 },
    deliveries: { opportunities: 0, documents: 0, value: 0 },
  };

  const rows: OpportunityChainRow[] = opps.map((o) => {
    const opportunityId = String(o.opportunityId);
    const opportunity: ChainDocument = {
      number: opportunityId,
      date: o.createdDate ? toDateOnlyString(o.createdDate) : null,
      value: Number(o.expectedRevenue ?? 0),
      status: o.stage ?? null,
    };
    const quotations = (quotesByOpp.get(opportunityId) ?? []).map<ChainDocument>((r) => ({
      number: r.orderNumber,
      date: r.documentDate,
      value: r.value,
      status: quotationStatus(r),
    }));
    const salesOrders = (ordersByOpp.get(opportunityId) ?? []).map<ChainDocument>((r) => ({
      number: r.orderNumber,
      date: r.orderDate ?? r.documentDate,
      value: r.value,
      status: salesOrderStatus(r),
    }));
    // One order can have several partial pickings; its value is attributed to the first picking only
    // so the per-opportunity and grand totals never double-count an order.
    const seenOrders = new Set<string>();
    const deliveries = (deliveriesByOpp.get(opportunityId) ?? []).map<ChainDocument>((r) => {
      const first = r.orderNumber != null && !seenOrders.has(r.orderNumber);
      if (r.orderNumber != null) seenOrders.add(r.orderNumber);
      return {
        number: r.deliveryReference ?? r.orderNumber ?? '',
        date: r.deliveryDate ?? r.orderDate,
        value: first && r.orderNumber != null ? valueByOrderNumber.get(r.orderNumber) ?? 0 : 0,
        status: r.deliveryStatus,
      };
    });

    const reachedStage: ChainStage = deliveries.length
      ? 'delivery'
      : salesOrders.length
        ? 'salesOrder'
        : quotations.length
          ? 'quotation'
          : 'opportunity';

    totals.opportunities.opportunities += 1;
    totals.opportunities.documents += 1;
    totals.opportunities.value += opportunity.value;
    const bump = (key: 'quotations' | 'salesOrders' | 'deliveries', docs: ChainDocument[]) => {
      if (!docs.length) return;
      totals[key].opportunities += 1;
      totals[key].documents += docs.length;
      totals[key].value += docs.reduce((sum, d) => sum + d.value, 0);
    };
    bump('quotations', quotations);
    bump('salesOrders', salesOrders);
    bump('deliveries', deliveries);

    return {
      opportunityId,
      name: String(o.name ?? ''),
      customer: o.customer ?? null,
      salesperson: o.salesperson ?? null,
      stage: o.stage ?? null,
      createdDate: opportunity.date,
      isWon: Number(o.isWon ?? 0) === 1,
      opportunity,
      quotations,
      salesOrders,
      deliveries,
      reachedStage,
    };
  });

  return { rows, totals };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface PipelineHealthOverview {
  funnel: FunnelCounts;
  funnelValues: FunnelValues;
  funnelOpportunityIds: FunnelOpportunityIds;
  funnelStageRecords: FunnelStageRecords;
  opportunityChains: OpportunityChains;
  stageBenchmark: StageBenchmarkRow[];
  /** The like-for-like population behind stageBenchmark (all statuses; see BenchmarkCohort). */
  benchmarkCohort: BenchmarkCohort;
  /** Total Pipeline Value card: open (Pending) opportunities created in the period -- the same population as Opportunity by
   * Stage and the Pending slice of Opportunity by Status (taken from that slice, so the three always agree). */
  openPipeline: { count: number; value: number };
  expectedClosureByMonth: ExpectedClosureMonthPoint[];
  opportunityByStage: StageValueSlice[];
  /** Every CRM stage in pipeline order (config/pipelineStages.ts), for ordering stage filters and tables. */
  stages: PipelineStage[];
  opportunitiesByStatus: OpportunitiesByStatus;
  probabilityDistribution: ProbabilityBucketSlice[];
  opportunities: OpportunityDetailRow[];
  /** Present only for Admin callers -- see routes/pipelineHealth.ts. */
  dataQuality?: DataQualityOverview;
}

export async function computePipelineHealthOverview(pool: Pool, anchor: Date, filters: Filters, includeDataQuality = true): Promise<PipelineHealthOverview> {
  const [funnelStageRecords, stageOrder] = await Promise.all([fetchFunnelStageRecords(pool, anchor, filters), fetchPipelineStageOrder(pool)]);
  const [funnelCounted, benchmarkOpportunities, funnelOpportunityIds, expectedClosureByMonth, opportunityByStage, opportunitiesByStatus, probabilityDistribution, opportunities, opportunityChains, dataQuality] = await Promise.all([
    computeFunnelCounts(pool, anchor, filters, funnelStageRecords),
    fetchBenchmarkOpportunities(pool, anchor, filters),
    fetchFunnelOpportunityIds(pool, anchor, filters),
    fetchExpectedClosureByMonth(pool, anchor, filters),
    fetchOpportunityByStage(pool, anchor, filters, stageOrder),
    fetchOpportunitiesByStatus(pool, anchor, filters),
    fetchProbabilityDistribution(pool, anchor, filters),
    fetchOpportunityDetails(pool, anchor, filters, stageOrder),
    computeOpportunityChains(pool, anchor, filters, funnelStageRecords),
    includeDataQuality ? computeOpportunityDataQuality(pool, filters, anchor) : Promise.resolve(undefined),
  ]);
  const { counts: funnel, values: funnelValues } = funnelCounted;
  const benchmarkCohort = computeBenchmarkCohort(benchmarkOpportunities, funnelStageRecords);
  const stageBenchmark = computeStageBenchmark(benchmarkCohort);
  const pending = opportunitiesByStatus.slices.find((sl) => sl.status === 'Pending');
  const openPipeline = { count: pending?.count ?? 0, value: pending?.expectedRevenue ?? 0 };
  return { funnel, funnelValues, funnelOpportunityIds, funnelStageRecords, opportunityChains, stageBenchmark, benchmarkCohort, openPipeline, expectedClosureByMonth, opportunityByStage, stages: stageOrder.stages, opportunitiesByStatus, probabilityDistribution, opportunities, dataQuality };
}
