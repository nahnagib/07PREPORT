/**
 * Activity Momentum page metric definitions.
 *
 * "Opportunities Without Activity" / "Opportunities Without Next Step" / the Rates panel's
 * "Inactive Opportunities" need real CRM activity-tracking data. That data is computed by the
 * Python ETL (PipelineFactBuilder, data/etl/src/sales_pipeline/facts/fact_pipeline.py). The 6
 * columns (ActivityState, NextActivityDate, HasNextStep, HasRecentActivity, IsInactive,
 * DaysSinceUpdate) were added to OpportunityFactBuilder.COLUMNS in an earlier session, and a
 * schema migration has since landed the columns on the live Fact_Opportunity table -- but as of
 * this session, re-querying the live warehouse directly shows every row's value for all 6 columns
 * is NULL (256/256 opportunities, 219/219 open YTD). The migration ran; the ETL pass that actually
 * *computes* these fields for existing rows has not (or hasn't reached this table yet).
 *
 * That distinction matters because `SUM(CASE WHEN col = 1 THEN 1 ELSE 0 END)` treats a NULL column
 * exactly like a real 0 -- silently. A naive "does the column exist" check (the original form of
 * checkActivityColumnsAvailable()) would report the data as available and let #W/O Activity,
 * #W/O Next Step, and Inactive Deals Ratio all render a false "0" / "+0.00%" instead of the honest
 * "--" placeholder the null-gating below was built for. checkActivityColumnsAvailable() therefore
 * also requires at least one populated row, not just a present column, before flipping on.
 *
 * Every query below checks checkActivityColumnsAvailable() first and degrades gracefully: the 3
 * activity-dependent figures resolve to `null` (rendered as "--" on the frontend) rather than a
 * false zero or a SQL "unknown column" error, until the ETL actually populates these columns --
 * at which point these start returning real numbers with no further code changes.
 *
 * Lost-exclusion policy (see filters.ts's excludeLostClause): `totalYtd` (the #YTD tile) and
 * fetchNewOpportunitiesByMonth (New Opportunities chart) exclude closed-lost opportunities -- both
 * are general "how much pipeline volume" figures, not lost-specific ones. `won`/`active`/
 * `withoutActivity`/`withoutNextStep` need no change: `IsOpen = 1` already implies not-lost by
 * construction (crm_status_classifier.py: is_open = not is_won and not is_lost). `lost`/
 * lostDealsRatio/lostByReason ARE the lost-specific widgets and stay fully unfiltered, including
 * lostDealsRatio's own denominator (see OpportunityActivityCountsInternal's comment -- it does NOT
 * reuse the now-Lost-excluding `totalYtd`). fetchActivityOpportunities also stays unfiltered: its
 * one shared array backs the Details view's Activity Filter panel, whose "Lost" option needs those
 * rows to exist -- the frontend's default (no filter selected) view is what excludes Lost, via
 * matchesActivityFilter in activity-momentum/page.tsx.
 */

import type { Pool } from 'mysql2/promise';
import { buildCrmWhereClause, excludeLostClause, ytdWindow, type Filters } from './filters';

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
    const [colRows] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'Fact_Opportunity' AND column_name = 'HasNextStep'`,
    );
    const columnExists = Number((colRows as any[])[0].cnt) > 0;
    if (!columnExists) {
      cachedAvailable = false;
    } else {
      // Column existing isn't enough -- see module header. Require at least one row where the
      // ETL has actually computed a value, not just a migrated-but-unpopulated column, or every
      // activity-dependent figure silently renders as a false 0 instead of "--".
      const [dataRows] = await pool.query(
        `SELECT COUNT(*) AS cnt FROM Fact_Opportunity WHERE HasNextStep IS NOT NULL LIMIT 1`,
      );
      cachedAvailable = Number((dataRows as any[])[0].cnt) > 0;
    }
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

/** Internal-only extension of OpportunityActivityCounts: totalYtdAll (every YTD opportunity
 * regardless of status) is never rendered on the frontend -- it exists purely so
 * computeActivityRates below can keep Lost Deals Ratio's denominator as the true, unfiltered YTD
 * total (its original, correct meaning: Lost ÷ ALL YTD opportunities) even though the *displayed*
 * `totalYtd` field now excludes Lost (see selectParts below). Without this split, excluding Lost
 * from `totalYtd` would silently shrink the ratio's own denominator and inflate it. */
interface OpportunityActivityCountsInternal extends OpportunityActivityCounts {
  totalYtdAll: number;
}

/** `totalYtd` excludes Lost (see filters.ts's excludeLostClause) -- it's a general "how many
 * opportunities are in this YTD cohort" figure, not a lost-specific one, same policy as every
 * other general widget on the Pipeline pages. `won`/`lost`/`active`/`withoutActivity`/
 * `withoutNextStep` are untouched: `lost` is the lost-specific counter itself, and the other three
 * already exclude Lost by construction (IsOpen=1 implies not-lost, see
 * crm_status_classifier.py's is_open = not is_won and not is_lost). */
async function computeOpportunityActivityCounts(
  pool: Pool,
  anchor: Date,
  filters: Filters,
  activityAvailable: boolean,
): Promise<OpportunityActivityCountsInternal> {
  const window = ytdWindow(anchor);
  const { clause, params } = buildCrmWhereClause(filters, 'fo');

  const selectParts = [
    'COUNT(*) AS totalYtdAll',
    `SUM(CASE WHEN ${excludeLostClause('fo')} THEN 1 ELSE 0 END) AS totalYtd`,
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
    totalYtdAll: Number(row.totalYtdAll ?? 0),
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
  counts: OpportunityActivityCountsInternal,
): Promise<ActivityRates> {
  // Lost ÷ ALL YTD opportunities (totalYtdAll, not the now-Lost-excluding totalYtd) -- this ratio
  // IS the lost-specific widget, so its own denominator must keep counting Lost rows, unaffected
  // by the Lost-exclusion policy applied to totalYtd for display elsewhere. See
  // OpportunityActivityCountsInternal's comment.
  const lostDealsRatio = safeDiv(counts.lost, counts.totalYtdAll);
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

/** Excludes Lost (see filters.ts's excludeLostClause) -- a general creation-volume trend, not a
 * lost-specific one. */
async function fetchNewOpportunitiesByMonth(pool: Pool, anchor: Date, filters: Filters): Promise<NewOpportunitiesMonthPoint[]> {
  const year = anchor.getUTCFullYear();
  const throughMonth = anchor.getUTCMonth() + 1;
  const { clause, params } = buildCrmWhereClause(filters, 'fo');
  const sql = `
    SELECT YEAR(fo.OpportunityCreatedDate) AS yr, MONTH(fo.OpportunityCreatedDate) AS mo, COUNT(*) AS cnt
    FROM Fact_Opportunity fo
    WHERE YEAR(fo.OpportunityCreatedDate) IN (?, ?) AND ${clause} AND ${excludeLostClause('fo')}
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
