/**
 * Activity Momentum page metric definitions.
 *
 * CORRECTED 2026-09-17: an earlier session added ActivityState/NextActivityDate/HasNextStep/
 * HasRecentActivity/IsInactive/DaysSinceUpdate to OpportunityFactBuilder.COLUMNS
 * (data/etl/src/sales_pipeline/facts/fact_opportunity.py) and wrote #W/O Activity, #W/O Next Step
 * and Inactive Deals Ratio against those 6 columns, gated behind checkActivityColumnsAvailable()
 * so they'd degrade to "--" until a migration + ETL backfill landed them on the live table. That
 * migration never happened: querying the live `Fact_Opportunity` schema directly
 * (information_schema.columns) shows those 6 columns do not exist on it at all, and never did --
 * the OUTPUT_DEFINITION.md / DATA_MODEL.md docs for this table never mention them either. So the
 * gate was permanently closed, not "pending a backfill."
 *
 * What the live table actually has -- and always has, since OpportunityFactBuilder's original
 * columns, not a pending addition -- is quotation-based staleness data: `HasQuotation`,
 * `FirstQuotationDate`, `LastQuotationDate`, `DaysSinceLastQuotation` (latest REAL B2B quotation
 * only, see OpportunityFactBuilder._attach_latest_quotation and POWER_BI_COMPATIBILITY.md),
 * `OpportunityAge` (= DaysInPipeline), and `SalesSegment`. These three measures are now computed
 * from those columns instead:
 *
 *   #W/O Next Step  = open B2B opportunities that DID get a real quotation, but it's gone stale --
 *                      no forward motion in >=30 days since LastQuotationDate.
 *   #W/O Activity   = open B2B opportunities that have NEVER had a real quotation, and have sat
 *                      that way for >=30 days since creation (OpportunityAge). There's no separate
 *                      activity-log column to check in this schema, so lack of a quotation itself
 *                      *is* "without activity" here.
 *   Inactive Deals Ratio = (#W/O Activity ∪ #W/O Next Step), counted once per opportunity, over
 *                      open B2B opportunities -- same "OR, not sum" shape as the
 *                      previously-fixed double-counting bug below, just against the real columns.
 *
 * The 30-day threshold matches CRM_INACTIVE_DAYS_THRESHOLD's default in the Python ETL's
 * config/settings.py (crm_inactive_days_threshold = 30) -- the same staleness window this
 * dashboard already uses elsewhere. The B2B segment scope matches
 * OpportunityFactBuilder._attach_latest_quotation's own SalesSegment == "B2B" filter: LastQuotationDate/
 * DaysSinceLastQuotation are only ever populated for B2B-eligible quotations in the first place, so
 * scoping #W/O Next Step to SalesSegment = 'B2B' just makes that existing constraint explicit; #W/O
 * Activity and the ratio are scoped to B2B to match (a mixed-segment denominator would understate
 * the ratio, since non-B2B opportunities can never satisfy either at-risk condition).
 *
 * checkActivityColumnsAvailable() still gates these three figures (kept for the same reason the
 * lostDealsRatio/totalYtdAll split is kept: defense if the schema regresses again), but now checks
 * for `DaysSinceLastQuotation`/`OpportunityAge` -- columns that have been part of this table from
 * the start, not a still-pending addition -- so in practice it now returns true.
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
 *
 * Cohort vs. snapshot scoping (fixed 2026-09): `totalYtdAll`/`totalYtd`/`won`/`lost` describe *this
 * year's origination cohort* -- opportunities CREATED in the anchor's YTD window -- so they stay
 * scoped by `DATE(fo.OpportunityCreatedDate) BETWEEN ? AND ?`, matching pipelineHealth.ts's
 * documented policy for fetchOpportunitiesCountAndValue (also a creation-volume figure).
 * `active`/`withoutActivity`/`withoutNextStep`, and the Rates panel's `openCount`/`atRiskCount`,
 * describe CURRENT PIPELINE STATE (IsOpen, DaysSinceLastQuotation and OpportunityAge are
 * point-in-time/wall-clock-relative, not flow metrics) and must NOT be filtered by creation date --
 * an opportunity created in a prior year that is still open and stale today is still part of
 * "current state." Previously these state figures were incorrectly filtered by the same
 * OpportunityCreatedDate YTD window as the cohort figures, silently excluding every still-open
 * opportunity created before the anchor year. They are now computed as an all-time snapshot,
 * consistent with this file's own fetchActivityOpportunities (explicitly all-time, see its own
 * comment below) and with pipelineHealth.ts's equivalent snapshot queries (fetchOpportunityByStage,
 * fetchOpportunityDetails). One consequence: because DaysSinceLastQuotation/OpportunityAge are
 * computed once per ETL run against wall-clock "now" (see OpportunityFactBuilder._refresh_timestamp
 * and crm_cleaner.py's `now = pd.Timestamp.now(...)`), these snapshot figures always reflect state
 * as of the last ETL refresh -- picking a past anchorDate no longer changes them at all (it only
 * ever changed which rows were *included*, never what "stale" meant for a given row), which is the
 * honest framing instead of an implied-but-false "as of the selected historical period."
 *
 * Ratio double-counting (fixed 2026-09, still holds under the corrected columns): `inactiveDealsRatio`
 * must not sum `withoutActivityCount + withoutNextStepCount` as its numerator. "No quotation ever,
 * stale by creation date" (#W/O Activity) and "quotation exists but stale since" (#W/O Next Step)
 * are mutually exclusive by construction here (HasQuotation = 0 vs. HasQuotation = 1), so they can't
 * literally double-count the same row the way the old IsInactive/HasNextStep=0 pair could -- but the
 * OR-based atRiskCount below is kept anyway: it's the correct shape for "count each at-risk
 * opportunity once," and is what actually protects against a future >100% ratio if the two
 * conditions ever stop being mutually exclusive. The numerator is a single `atRiskCount`
 * (`IsOpen = 1 AND SalesSegment = 'B2B' AND (<#W/O Activity condition> OR <#W/O Next Step condition>)`).
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
// Shared SQL fragments for the two "at risk" conditions -- see module header for why these use
// HasQuotation/LastQuotationDate/DaysSinceLastQuotation/OpportunityAge/SalesSegment instead of the
// non-existent HasNextStep/HasRecentActivity/IsInactive. Every caller still ANDs `fo.IsOpen = 1`
// itself (kept out of these fragments so the same fragment works in both the aggregate SUM/CASE
// queries here and per-row in fetchActivityOpportunities below).
// ---------------------------------------------------------------------------

const STALENESS_DAYS = 30;
/** Open B2B opportunities that never got a real quotation, stale by time-since-creation. */
const WITHOUT_ACTIVITY_SQL = `fo.SalesSegment = 'B2B' AND fo.HasQuotation = 0 AND fo.OpportunityAge >= ${STALENESS_DAYS}`;
/** Open B2B opportunities with a real quotation that's gone stale since. */
const WITHOUT_NEXT_STEP_SQL = `fo.SalesSegment = 'B2B' AND fo.HasQuotation = 1 AND fo.LastQuotationDate IS NOT NULL AND fo.DaysSinceLastQuotation >= ${STALENESS_DAYS}`;

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
    // DaysSinceLastQuotation/OpportunityAge are original OpportunityFactBuilder columns (not a
    // pending addition -- see module header), so this passes in practice. Unlike the old
    // HasNextStep check, a NULL DaysSinceLastQuotation is a legitimate business state (no real B2B
    // quotation yet), not "ETL hasn't run," so there's no additional "at least one populated row"
    // check here -- column presence is the only thing this needs to guard against.
    const [colRows] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'Fact_Opportunity'
         AND column_name IN ('DaysSinceLastQuotation', 'OpportunityAge')`,
    );
    cachedAvailable = Number((colRows as any[])[0].cnt) >= 2;
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
export interface OpportunityActivityCountsInternal extends OpportunityActivityCounts {
  totalYtdAll: number;
}

/** `totalYtd` excludes Lost (see filters.ts's excludeLostClause) -- it's a general "how many
 * opportunities are in this YTD cohort" figure, not a lost-specific one, same policy as every
 * other general widget on the Pipeline pages. `won`/`lost`/`active`/`withoutActivity`/
 * `withoutNextStep` are untouched: `lost` is the lost-specific counter itself, and the other three
 * already exclude Lost by construction (IsOpen=1 implies not-lost, see
 * crm_status_classifier.py's is_open = not is_won and not is_lost).
 *
 * `totalYtdAll`/`totalYtd`/`won`/`lost` are a creation-date cohort, scoped by the anchor's YTD
 * window. `active`/`withoutActivity`/`withoutNextStep` are current-state snapshots and are
 * deliberately NOT date-scoped -- see the module header comment ("Cohort vs. snapshot scoping"). */
export async function computeOpportunityActivityCounts(
  pool: Pool,
  anchor: Date,
  filters: Filters,
  activityAvailable: boolean,
): Promise<OpportunityActivityCountsInternal> {
  const window = ytdWindow(anchor);
  const { clause, params } = buildCrmWhereClause(filters, 'fo');

  const cohortSql = `
    SELECT
      COUNT(*) AS totalYtdAll,
      SUM(CASE WHEN ${excludeLostClause('fo')} THEN 1 ELSE 0 END) AS totalYtd,
      SUM(CASE WHEN fo.IsWon = 1 THEN 1 ELSE 0 END) AS won,
      SUM(CASE WHEN fo.IsLost = 1 THEN 1 ELSE 0 END) AS lost
    FROM Fact_Opportunity fo
    WHERE DATE(fo.OpportunityCreatedDate) BETWEEN ? AND ? AND ${clause}
  `;

  // #Active is deliberately left as plain `IsOpen = 1` regardless of activityAvailable -- it's the
  // one measure on this page that was already correct before this fix, and nothing above changes
  // what "active" means for it (there is no live "healthy vs. at-risk" open-opportunity split in
  // this schema the way the old, never-deployed IsInactive column implied).
  const snapshotSelectParts = activityAvailable
    ? [
        'SUM(CASE WHEN fo.IsOpen = 1 THEN 1 ELSE 0 END) AS active',
        `SUM(CASE WHEN fo.IsOpen = 1 AND ${WITHOUT_ACTIVITY_SQL} THEN 1 ELSE 0 END) AS withoutActivity`,
        `SUM(CASE WHEN fo.IsOpen = 1 AND ${WITHOUT_NEXT_STEP_SQL} THEN 1 ELSE 0 END) AS withoutNextStep`,
      ]
    : ['SUM(CASE WHEN fo.IsOpen = 1 THEN 1 ELSE 0 END) AS active'];
  const snapshotSql = `
    SELECT ${snapshotSelectParts.join(', ')}
    FROM Fact_Opportunity fo
    WHERE ${clause}
  `;

  const [[cohortRows], [snapshotRows]] = await Promise.all([
    pool.query(cohortSql, [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]),
    pool.query(snapshotSql, params),
  ]);
  const cohortRow = (cohortRows as any[])[0];
  const snapshotRow = (snapshotRows as any[])[0];
  return {
    totalYtd: Number(cohortRow.totalYtd ?? 0),
    totalYtdAll: Number(cohortRow.totalYtdAll ?? 0),
    won: Number(cohortRow.won ?? 0),
    lost: Number(cohortRow.lost ?? 0),
    active: Number(snapshotRow.active ?? 0),
    withoutActivity: activityAvailable ? Number(snapshotRow.withoutActivity ?? 0) : null,
    withoutNextStep: activityAvailable ? Number(snapshotRow.withoutNextStep ?? 0) : null,
  };
}

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

export interface ActivityRates {
  inactiveDealsRatio: number | null;
  lostDealsRatio: number | null;
}

export async function computeActivityRates(
  pool: Pool,
  filters: Filters,
  activityAvailable: boolean,
  counts: OpportunityActivityCountsInternal,
): Promise<ActivityRates> {
  // Lost ÷ ALL YTD opportunities (totalYtdAll, not the now-Lost-excluding totalYtd) -- this ratio
  // IS the lost-specific widget, so its own denominator must keep counting Lost rows, unaffected
  // by the Lost-exclusion policy applied to totalYtd for display elsewhere. See
  // OpportunityActivityCountsInternal's comment.
  //
  // Tie-out example (audited 2026-09): #Lost=230, displayed #YTD (Lost-excluded)=389 ->
  // totalYtdAll = 389 + 230 = 619 -> 230 / 619 = 0.37158... -> "+37.16%" via formatVariance. That
  // is the on-screen figure this formula was flagged against -- it ties out exactly, confirming
  // this is NOT Lost/(Won+Lost) or Lost/displayed-#YTD, both of which would give a different number.
  const lostDealsRatio = safeDiv(counts.lost, counts.totalYtdAll);
  if (!activityAvailable) return { inactiveDealsRatio: null, lostDealsRatio };

  // All-time snapshot, matching computeOpportunityActivityCounts's snapshot query above --
  // openCount/atRiskCount describe current pipeline state, not a creation-date cohort (see the
  // module header comment). atRiskCount ORs the #W/O Activity and #W/O Next Step conditions rather
  // than summing their counts, so an opportunity could never be counted twice even if the
  // HasQuotation=0/HasQuotation=1 split ever stopped being mutually exclusive. Both openCount and
  // atRiskCount are scoped to SalesSegment = 'B2B' -- matching atRiskCount's own conditions -- so
  // the ratio's denominator isn't diluted by non-B2B opportunities that could never appear in the
  // numerator (see module header's "B2B segment scope" note).
  const { clause, params } = buildCrmWhereClause(filters, 'fo');
  const sql = `
    SELECT
      SUM(CASE WHEN fo.IsOpen = 1 AND fo.SalesSegment = 'B2B' THEN 1 ELSE 0 END) AS openCount,
      SUM(CASE WHEN fo.IsOpen = 1 AND (${WITHOUT_ACTIVITY_SQL} OR ${WITHOUT_NEXT_STEP_SQL}) THEN 1 ELSE 0 END) AS atRiskCount
    FROM Fact_Opportunity fo
    WHERE ${clause}
  `;
  const [rows] = await pool.query(sql, params);
  const row = (rows as any[])[0];
  const openCount = Number(row.openCount ?? 0);
  const atRiskCount = Number(row.atRiskCount ?? 0);
  return {
    inactiveDealsRatio: safeDiv(atRiskCount, openCount),
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
    'COALESCE(sap.admin_name_override, fo.Salesperson) AS salesperson',
    'fo.Stage AS stage',
    'fo.OpportunityCreatedDate AS createdDate',
    'fo.IsOpen AS isOpen',
    'fo.IsWon AS isWon',
    'fo.IsLost AS isLost',
  ];
  if (activityAvailable) {
    // Computed in SQL from the same WITHOUT_ACTIVITY_SQL/WITHOUT_NEXT_STEP_SQL fragments the
    // aggregate counts/rates above use, so the Details view's Inactive / Without Next Step filters
    // can never disagree with #W/O Activity / #W/O Next Step / Inactive Deals Ratio.
    selectParts.push(
      `(fo.IsOpen = 1 AND ${WITHOUT_ACTIVITY_SQL}) AS isInactive`,
      `(fo.IsOpen = 1 AND ${WITHOUT_NEXT_STEP_SQL}) AS isWithoutNextStep`,
    );
  }
  const sql = `SELECT ${selectParts.join(', ')} FROM Fact_Opportunity fo
    LEFT JOIN salesperson_admin_profile sap ON sap.salesperson_key = fo.SalespersonKey
    WHERE ${clause}`;
  const [rows] = await pool.query(sql, params);

  const ytdStartStr = toDateOnlyString(window.start);
  const ytdEndStr = toDateOnlyString(window.end);

  return (rows as any[]).map((r) => {
    const createdDate = r.createdDate ? toDateOnlyString(r.createdDate) : null;
    const isOpen = Number(r.isOpen) === 1;
    const isInactive = activityAvailable ? Number(r.isInactive) === 1 : null;
    const isWithoutNextStep = activityAvailable ? Number(r.isWithoutNextStep) === 1 : null;
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
      isWithoutNextStep,
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
    computeActivityRates(pool, filters, activityColumnsAvailable, counts),
    fetchLostByReason(pool, anchor, filters),
    fetchNewOpportunitiesByMonth(pool, anchor, filters),
    fetchActivityOpportunities(pool, anchor, filters, activityColumnsAvailable),
  ]);
  return { activityColumnsAvailable, counts, rates, lostByReason, newOpportunitiesByMonth, opportunities };
}
