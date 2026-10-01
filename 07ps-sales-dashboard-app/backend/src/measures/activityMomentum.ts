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
 * MUTUALLY EXCLUSIVE STATUSES (2026-09-30) -- supersedes the Lost-exclusion policy that used to be
 * described here for the #YTD tile and the New Opportunities chart. The six Zone A tiles must
 * reconcile: #YTD = #Active + #Won + #Lost + #W/O Activity + #W/O Next Step. Before this fix they
 * did not (e.g. 2026-01-01..2026-09-30, no filters: #YTD 459 vs. a tile sum of 793) because
 *   1. #W/O Activity and #W/O Next Step were subsets of #Active (all three were `IsOpen = 1`), so
 *      every stale open deal was counted twice;
 *   2. #YTD excluded Lost while #Lost was still shown as one of its parts;
 *   3. one opportunity carries both IsWon = 1 and IsLost = 1, so it was in #Won and #Lost.
 * Every YTD opportunity is now classified exactly once by activityStatusCaseSql() (first match wins:
 * Lost, Won, W/O Activity, W/O Next Step, Active), #YTD counts all of them (Lost included), and the
 * Details view's filter flags come from the same CASE, so the table always matches the tiles. A row
 * that is neither open, won nor lost (none in the live data) is counted in `unclassified` and in
 * #YTD, so the page can show the gap instead of silently not adding up. #Active therefore now means
 * "open and moving" (open, not W/O Activity, not W/O Next Step). The New Opportunities chart counts
 * every created opportunity too (Lost included), so its months sum to #YTD. lostDealsRatio is
 * unchanged in value: #Lost / all YTD opportunities, which is now simply #Lost / #YTD.
 *
 * YEAR-TO-DATE ONLY (2026-09-21): every figure on this page is now scoped to opportunities CREATED
 * from Jan 1 of the current year through the (clamped, see filters.ts's parsePipelineAnchor)
 * anchor. That supersedes the all-time "snapshot" scoping described in the next paragraph: the
 * snapshot figures (`active`/`withoutActivity`/`withoutNextStep`, at-risk ratio, the details array)
 * still describe CURRENT state, but only of this year's origination cohort -- nothing created in a
 * previous year is fetched or calculated. The New Opportunities chart is the current year only
 * (January through the anchor's month), with no prior-year series.
 *
 * Cohort vs. snapshot scoping (fixed 2026-09, superseded by the YTD-only rule above for the
 * creation-date window): `totalYtdAll`/`totalYtd`/`won`/`lost` describe *this
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
import { buildCrmWhereClause, parsePipelineAnchor, ytdWindow, type Filters } from './filters';

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

/** One status per opportunity, first match wins -- the single source of truth for the Zone A
 * tiles and the Details view's filter flags (see "MUTUALLY EXCLUSIVE STATUSES" in the header).
 * Lost is checked before Won so the one live row flagged both counts as Lost, consistent with the
 * Lost-by-Reason chart and with excludeLostClause everywhere else. Without the activity columns
 * the two stale buckets don't exist and those opportunities stay in 'active'. */
export function activityStatusCaseSql(activityAvailable: boolean): string {
  const staleBranches = activityAvailable
    ? `WHEN fo.IsOpen = 1 AND ${WITHOUT_ACTIVITY_SQL} THEN 'withoutActivity'
      WHEN fo.IsOpen = 1 AND ${WITHOUT_NEXT_STEP_SQL} THEN 'withoutNextStep'`
    : '';
  return `CASE
      WHEN COALESCE(fo.IsLost, 0) = 1 THEN 'lost'
      WHEN fo.IsWon = 1 THEN 'won'
      ${staleBranches}
      WHEN fo.IsOpen = 1 THEN 'active'
      ELSE 'unclassified'
    END`;
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

/** Mutually exclusive: totalYtd = active + won + lost + withoutActivity + withoutNextStep +
 * unclassified (the last is 0 in the live data; see the module header). */
export interface OpportunityActivityCounts {
  totalYtd: number;
  won: number;
  withoutActivity: number | null;
  active: number;
  lost: number;
  withoutNextStep: number | null;
  /** YTD opportunities that are neither open, won nor lost -- in #YTD, in no other tile. */
  unclassified: number;
}

/** Internal-only extension of OpportunityActivityCounts: totalYtdAll is what computeActivityRates
 * divides Lost by. Since the 2026-09-30 status fix #YTD itself counts every YTD opportunity, so the
 * two are always equal; the field is kept so the ratio's denominator is explicit. */
export interface OpportunityActivityCountsInternal extends OpportunityActivityCounts {
  totalYtdAll: number;
}

/** Zone A tiles: every opportunity created in the anchor's YTD window, each counted in exactly
 * one status (activityStatusCaseSql), so the tiles add up to #YTD. */
export async function computeOpportunityActivityCounts(
  pool: Pool,
  anchor: Date,
  filters: Filters,
  activityAvailable: boolean,
): Promise<OpportunityActivityCountsInternal> {
  const window = ytdWindow(anchor);
  const { clause, params } = buildCrmWhereClause(filters, 'fo');
  const sql = `
    SELECT
      COUNT(*) AS totalYtd,
      SUM(CASE WHEN t.status = 'active' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN t.status = 'won' THEN 1 ELSE 0 END) AS won,
      SUM(CASE WHEN t.status = 'lost' THEN 1 ELSE 0 END) AS lost,
      SUM(CASE WHEN t.status = 'withoutActivity' THEN 1 ELSE 0 END) AS withoutActivity,
      SUM(CASE WHEN t.status = 'withoutNextStep' THEN 1 ELSE 0 END) AS withoutNextStep,
      SUM(CASE WHEN t.status = 'unclassified' THEN 1 ELSE 0 END) AS unclassified
    FROM (
      SELECT ${activityStatusCaseSql(activityAvailable)} AS status
      FROM Fact_Opportunity fo
      WHERE DATE(fo.OpportunityCreatedDate) BETWEEN ? AND ? AND ${clause}
    ) t
  `;
  const [rows] = await pool.query(sql, [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]);
  const row = (rows as any[])[0] ?? {};
  const totalYtd = Number(row.totalYtd ?? 0);
  return {
    totalYtd,
    totalYtdAll: totalYtd,
    won: Number(row.won ?? 0),
    lost: Number(row.lost ?? 0),
    active: Number(row.active ?? 0),
    withoutActivity: activityAvailable ? Number(row.withoutActivity ?? 0) : null,
    withoutNextStep: activityAvailable ? Number(row.withoutNextStep ?? 0) : null,
    unclassified: Number(row.unclassified ?? 0),
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
  anchor: Date = parsePipelineAnchor(undefined),
): Promise<ActivityRates> {
  // Lost ÷ ALL YTD opportunities (= #Lost ÷ #YTD since #YTD now counts every status). Tie-out
  // (audited 2026-09): 230 lost of 619 YTD opportunities -> 37.16%.
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
  const window = ytdWindow(anchor);
  const { clause, params } = buildCrmWhereClause(filters, 'fo');
  const sql = `
    SELECT
      SUM(CASE WHEN fo.IsOpen = 1 AND fo.SalesSegment = 'B2B' THEN 1 ELSE 0 END) AS openCount,
      SUM(CASE WHEN fo.IsOpen = 1 AND (${WITHOUT_ACTIVITY_SQL} OR ${WITHOUT_NEXT_STEP_SQL}) THEN 1 ELSE 0 END) AS atRiskCount
    FROM Fact_Opportunity fo
    WHERE DATE(fo.OpportunityCreatedDate) BETWEEN ? AND ? AND ${clause}
  `;
  const [rows] = await pool.query(sql, [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]);
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
// New Opportunities by month -- current year only, January through the anchor's month (no
// prior-year series).
// ---------------------------------------------------------------------------

export interface NewOpportunitiesMonthPoint {
  month: number;
  label: string;
  countYtd: number;
}

/** Every opportunity created in the month, Lost included, so the months sum to the #YTD tile (see
 * "MUTUALLY EXCLUSIVE STATUSES" in the module header). */
async function fetchNewOpportunitiesByMonth(pool: Pool, anchor: Date, filters: Filters): Promise<NewOpportunitiesMonthPoint[]> {
  const year = anchor.getUTCFullYear();
  const throughMonth = anchor.getUTCMonth() + 1;
  const { clause, params } = buildCrmWhereClause(filters, 'fo');
  const sql = `
    SELECT YEAR(fo.OpportunityCreatedDate) AS yr, MONTH(fo.OpportunityCreatedDate) AS mo, COUNT(*) AS cnt
    FROM Fact_Opportunity fo
    WHERE YEAR(fo.OpportunityCreatedDate) = ? AND ${clause}
    GROUP BY YEAR(fo.OpportunityCreatedDate), MONTH(fo.OpportunityCreatedDate)
  `;
  const [rows] = await pool.query(sql, [year, ...params]);
  const byYearMonth = new Map<string, number>();
  for (const r of rows as any[]) byYearMonth.set(`${r.yr}-${r.mo}`, Number(r.cnt));
  return Array.from({ length: throughMonth }, (_, i) => i + 1).map((m) => ({
    month: m,
    label: MONTH_LABELS[m - 1],
    countYtd: byYearMonth.get(`${year}-${m}`) ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Opportunity table -- current-year opportunities only, same shape as Pipeline Health's Opportunity
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
  // Same status CASE as the Zone A tiles, so every Details filter lists exactly its tile's count.
  selectParts.push(`${activityStatusCaseSql(activityAvailable)} AS activityStatus`);
  const sql = `SELECT ${selectParts.join(', ')} FROM Fact_Opportunity fo
    LEFT JOIN salesperson_admin_profile sap ON sap.salesperson_key = fo.SalespersonKey
    WHERE DATE(fo.OpportunityCreatedDate) BETWEEN ? AND ? AND ${clause}`;
  const [rows] = await pool.query(sql, [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]);

  const ytdStartStr = toDateOnlyString(window.start);
  const ytdEndStr = toDateOnlyString(window.end);

  return (rows as any[]).map((r) => {
    const createdDate = r.createdDate ? toDateOnlyString(r.createdDate) : null;
    const isOpen = Number(r.isOpen) === 1;
    const status = String(r.activityStatus);
    const isInactive = activityAvailable ? status === 'withoutActivity' : null;
    const isWithoutNextStep = activityAvailable ? status === 'withoutNextStep' : null;
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
      isWon: status === 'won',
      isLost: status === 'lost',
      isActive: status === 'active',
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
    computeActivityRates(pool, filters, activityColumnsAvailable, counts, anchor),
    fetchLostByReason(pool, anchor, filters),
    fetchNewOpportunitiesByMonth(pool, anchor, filters),
    fetchActivityOpportunities(pool, anchor, filters, activityColumnsAvailable),
  ]);
  return { activityColumnsAvailable, counts, rates, lostByReason, newOpportunitiesByMonth, opportunities };
}
