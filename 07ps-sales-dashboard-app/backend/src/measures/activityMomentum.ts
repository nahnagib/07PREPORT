/**
 * Activity Momentum page metric definitions.
 *
 * "Opportunities Without Activity" / "Opportunities Without Next Step" / the Rates panel's
 * "Inactive Opportunities" need real CRM activity-tracking data. That data is computed by the
 * Python ETL (PipelineFactBuilder, data/etl/src/sales_pipeline/facts/fact_pipeline.py) but was
 * never exported onto the live Fact_Opportunity table -- confirmed by reading the ETL source and
 * querying information_schema against the live warehouse this session. The 6 missing columns
 * (ActivityState, NextActivityDate, HasNextStep, HasRecentActivity, IsInactive, DaysSinceUpdate)
 * were added to OpportunityFactBuilder.COLUMNS this session (see that file), but the ETL was
 * deliberately NOT re-run -- doing so hits live production Odoo and rewrites the whole shared
 * warehouse, the user's own call to make, not this session's.
 *
 * Every query below therefore checks checkActivityColumnsAvailable() first and degrades
 * gracefully: the 3 activity-dependent figures resolve to `null` (rendered as "--" on the
 * frontend) rather than throwing a SQL "unknown column" error, until the user runs their own ETL
 * refresh -- at which point these start returning real numbers with no further code changes.
 */

import type { Pool } from 'mysql2/promise';
import { buildCrmWhereClause, ytdWindow, type Filters } from './filters';

function toDateOnlyString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function safeDiv(numerator: number, denominator: number): number | null {
  if (!denominator) return null;
  return numerator / denominator;
}

// ---------------------------------------------------------------------------
// Activity-column availability check -- cached for 5 minutes so a mid-session ETL refresh is
// picked up without requiring a backend restart, without re-querying information_schema on every
// request either.
// ---------------------------------------------------------------------------

let cachedAt = 0;
let cachedAvailable = false;
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function checkActivityColumnsAvailable(pool: Pool): Promise<boolean> {
  const now = Date.now();
  if (now - cachedAt < CACHE_TTL_MS) return cachedAvailable;
  try {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'Fact_Opportunity' AND column_name = 'HasNextStep'`,
    );
    cachedAvailable = Number((rows as any[])[0].cnt) > 0;
  } catch {
    cachedAvailable = false;
  }
  cachedAt = now;
  return cachedAvailable;
}

// ---------------------------------------------------------------------------
// Zone A -- Opportunity Activities, 2x3, all scoped YTD by OpportunityCreatedDate.
// ---------------------------------------------------------------------------

export interface OpportunityActivityCounts {
  totalYtd: number;
  won: number;
  withoutActivity: number | null;
  active: number;
  lost: number;
  withoutNextStep: number | null;
}

async function computeOpportunityActivityCounts(
  pool: Pool,
  anchor: Date,
  filters: Filters,
  activityAvailable: boolean,
): Promise<OpportunityActivityCounts> {
  const window = ytdWindow(anchor);
  const { clause, params } = buildCrmWhereClause(filters, 'fo');

  const selectParts = [
    'COUNT(*) AS totalYtd',
    'SUM(CASE WHEN fo.IsWon = 1 THEN 1 ELSE 0 END) AS won',
    'SUM(CASE WHEN fo.IsLost = 1 THEN 1 ELSE 0 END) AS lost',
  ];
  if (activityAvailable) {
    selectParts.push(
      'SUM(CASE WHEN fo.IsOpen = 1 AND (fo.IsInactive IS NULL OR fo.IsInactive = 0) THEN 1 ELSE 0 END) AS active',
      'SUM(CASE WHEN fo.IsOpen = 1 AND fo.HasRecentActivity = 0 THEN 1 ELSE 0 END) AS withoutActivity',
      'SUM(CASE WHEN fo.IsOpen = 1 AND fo.HasNextStep = 0 THEN 1 ELSE 0 END) AS withoutNextStep',
    );
  } else {
    selectParts.push('SUM(CASE WHEN fo.IsOpen = 1 THEN 1 ELSE 0 END) AS active');
  }

  const sql = `
    SELECT ${selectParts.join(', ')}
    FROM Fact_Opportunity fo
    WHERE DATE(fo.OpportunityCreatedDate) BETWEEN ? AND ? AND ${clause}
  `;
  const [rows] = await pool.query(sql, [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]);
  const row = (rows as any[])[0];
  return {
    totalYtd: Number(row.totalYtd ?? 0),
    won: Number(row.won ?? 0),
    lost: Number(row.lost ?? 0),
    active: Number(row.active ?? 0),
    withoutActivity: activityAvailable ? Number(row.withoutActivity ?? 0) : null,
    withoutNextStep: activityAvailable ? Number(row.withoutNextStep ?? 0) : null,
  };
}

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

export interface ActivityRates {
  inactiveDealsRatio: number | null;
  lostDealsRatio: number | null;
}

async function computeActivityRates(
  pool: Pool,
  anchor: Date,
  filters: Filters,
  activityAvailable: boolean,
  counts: OpportunityActivityCounts,
): Promise<ActivityRates> {
  const lostDealsRatio = safeDiv(counts.lost, counts.totalYtd);
  if (!activityAvailable) return { inactiveDealsRatio: null, lostDealsRatio };

  const window = ytdWindow(anchor);
  const { clause, params } = buildCrmWhereClause(filters, 'fo');
  const sql = `
    SELECT
      SUM(CASE WHEN fo.IsOpen = 1 THEN 1 ELSE 0 END) AS openCount,
      SUM(CASE WHEN fo.IsOpen = 1 AND fo.IsInactive = 1 THEN 1 ELSE 0 END) AS inactiveCount,
      SUM(CASE WHEN fo.IsOpen = 1 AND fo.HasNextStep = 0 THEN 1 ELSE 0 END) AS withoutNextStepCount
    FROM Fact_Opportunity fo
    WHERE DATE(fo.OpportunityCreatedDate) BETWEEN ? AND ? AND ${clause}
  `;
  const [rows] = await pool.query(sql, [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]);
  const row = (rows as any[])[0];
  const openCount = Number(row.openCount ?? 0);
  const inactiveCount = Number(row.inactiveCount ?? 0);
  const withoutNextStepCount = Number(row.withoutNextStepCount ?? 0);
  return {
    inactiveDealsRatio: safeDiv(inactiveCount + withoutNextStepCount, openCount),
    lostDealsRatio,
  };
}

// ---------------------------------------------------------------------------
// Total Lost Opportunity by Reason -- always available (LostReasonID/Dim_LostReason are live,
// unrelated to the activity-column gap).
// ---------------------------------------------------------------------------

export interface LostReasonSlice {
  reason: string;
  count: number;
}

async function fetchLostByReason(pool: Pool, anchor: Date, filters: Filters): Promise<LostReasonSlice[]> {
  const window = ytdWindow(anchor);
  const { clause, params } = buildCrmWhereClause(filters, 'fo');
  const sql = `
    SELECT COALESCE(dlr.LostReasonEnglish, 'Unspecified') AS reason, COUNT(*) AS cnt
    FROM Fact_Opportunity fo
    LEFT JOIN Dim_LostReason dlr ON fo.LostReasonID = dlr.LostReasonID
    WHERE fo.IsLost = 1 AND DATE(fo.OpportunityCreatedDate) BETWEEN ? AND ? AND ${clause}
    GROUP BY reason
    ORDER BY cnt DESC
  `;
  const [rows] = await pool.query(sql, [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]);
  return (rows as any[]).map((r) => ({ reason: String(r.reason), count: Number(r.cnt) }));
}

// ---------------------------------------------------------------------------
// New Opportunities YTD vs LYTD, by month. Same "up to anchor's month only" convention as every
// other by-month series in this codebase.
// ---------------------------------------------------------------------------

export interface NewOpportunitiesMonthPoint {
  month: number;
  label: string;
  countYtd: number;
  countLytd: number;
}

async function fetchNewOpportunitiesByMonth(pool: Pool, anchor: Date, filters: Filters): Promise<NewOpportunitiesMonthPoint[]> {
  const year = anchor.getUTCFullYear();
  const throughMonth = anchor.getUTCMonth() + 1;
  const { clause, params } = buildCrmWhereClause(filters, 'fo');
  const sql = `
    SELECT YEAR(fo.OpportunityCreatedDate) AS yr, MONTH(fo.OpportunityCreatedDate) AS mo, COUNT(*) AS cnt
    FROM Fact_Opportunity fo
    WHERE YEAR(fo.OpportunityCreatedDate) IN (?, ?) AND ${clause}
    GROUP BY YEAR(fo.OpportunityCreatedDate), MONTH(fo.OpportunityCreatedDate)
  `;
  const [rows] = await pool.query(sql, [year, year - 1, ...params]);
  const byYearMonth = new Map<string, number>();
  for (const r of rows as any[]) byYearMonth.set(`${r.yr}-${r.mo}`, Number(r.cnt));
  return Array.from({ length: throughMonth }, (_, i) => i + 1).map((m) => ({
    month: m,
    label: MONTH_LABELS[m - 1],
    countYtd: byYearMonth.get(`${year}-${m}`) ?? 0,
    countLytd: byYearMonth.get(`${year - 1}-${m}`) ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Opportunity table -- all-time (not YTD-scoped), same shape as Pipeline Health's Opportunity
// Details for consistency, plus per-row flags for the Details view's Activity filter panel
// (#Active/#Lost/#Won/#Inactive/#W/O Next Step/#YTD, single-select).
// ---------------------------------------------------------------------------

export interface ActivityOpportunityRow {
  opportunityId: string;
  name: string;
  customer: string | null;
  company: string | null;
  expectedRevenue: number;
  salesperson: string | null;
  stage: string | null;
  createdDate: string | null;
  isOpen: boolean;
  isWon: boolean;
  isLost: boolean;
  isActive: boolean;
  isInactive: boolean | null;
  isWithoutNextStep: boolean | null;
  isYtd: boolean;
}

async function fetchActivityOpportunities(pool: Pool, anchor: Date, filters: Filters, activityAvailable: boolean): Promise<ActivityOpportunityRow[]> {
  const window = ytdWindow(anchor);
  const { clause, params } = buildCrmWhereClause(filters, 'fo');
  const selectParts = [
    'fo.OpportunityID AS opportunityId',
    'fo.OpportunityName AS name',
    'fo.Customer AS customer',
    'fo.Company AS company',
    'fo.ExpectedRevenue AS expectedRevenue',
    'fo.Salesperson AS salesperson',
    'fo.Stage AS stage',
    'fo.OpportunityCreatedDate AS createdDate',
    'fo.IsOpen AS isOpen',
    'fo.IsWon AS isWon',
    'fo.IsLost AS isLost',
  ];
  if (activityAvailable) {
    selectParts.push('fo.IsInactive AS isInactive', 'fo.HasNextStep AS hasNextStep');
  }
  const sql = `SELECT ${selectParts.join(', ')} FROM Fact_Opportunity fo WHERE ${clause}`;
  const [rows] = await pool.query(sql, params);

  const ytdStartStr = toDateOnlyString(window.start);
  const ytdEndStr = toDateOnlyString(window.end);

  return (rows as any[]).map((r) => {
    const createdDate = r.createdDate ? toDateOnlyString(r.createdDate) : null;
    const isOpen = Number(r.isOpen) === 1;
    const isInactive = activityAvailable ? (r.isInactive == null ? false : Number(r.isInactive) === 1) : null;
    const hasNextStep = activityAvailable ? (r.hasNextStep == null ? null : Number(r.hasNextStep) === 1) : null;
    return {
      opportunityId: String(r.opportunityId),
      name: String(r.name ?? ''),
      customer: r.customer ?? null,
      company: r.company ?? null,
      expectedRevenue: Number(r.expectedRevenue ?? 0),
      salesperson: r.salesperson ?? null,
      stage: r.stage ?? null,
      createdDate,
      isOpen,
      isWon: Number(r.isWon) === 1,
      isLost: Number(r.isLost) === 1,
      isActive: isOpen && !(isInactive ?? false),
      isInactive,
      isWithoutNextStep: hasNextStep == null ? null : !hasNextStep,
      isYtd: createdDate != null && createdDate >= ytdStartStr && createdDate <= ytdEndStr,
    };
  });
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface ActivityMomentumOverview {
  activityColumnsAvailable: boolean;
  counts: OpportunityActivityCounts;
  rates: ActivityRates;
  lostByReason: LostReasonSlice[];
  newOpportunitiesByMonth: NewOpportunitiesMonthPoint[];
  opportunities: ActivityOpportunityRow[];
}

export async function computeActivityMomentumOverview(pool: Pool, anchor: Date, filters: Filters): Promise<ActivityMomentumOverview> {
  const activityColumnsAvailable = await checkActivityColumnsAvailable(pool);
  const counts = await computeOpportunityActivityCounts(pool, anchor, filters, activityColumnsAvailable);
  const [rates, lostByReason, newOpportunitiesByMonth, opportunities] = await Promise.all([
    computeActivityRates(pool, anchor, filters, activityColumnsAvailable, counts),
    fetchLostByReason(pool, anchor, filters),
    fetchNewOpportunitiesByMonth(pool, anchor, filters),
    fetchActivityOpportunities(pool, anchor, filters, activityColumnsAvailable),
  ]);
  return { activityColumnsAvailable, counts, rates, lostByReason, newOpportunitiesByMonth, opportunities };
}
