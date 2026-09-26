/**
 * Critical Number page metric definitions.
 *
 * Manual definition (07Ps_Phase1_Architecture_Standards.md Section 2.1.1 + Section 5.5 data
 * dictionary): "Critical Number: translates the annual target into a required daily value; tracks
 * working-day consumption, missing days/value, and forced closures." / "Critical Number (required
 * daily value to stay on annual pace)".
 *
 * Source tables (confirmed against the live throwaway/validation warehouse, same DB Tachometer
 * reads from -- not a second data source):
 *
 *   Metric                    | Source table(s)                        | How
 *   ---------------------------|------------------------------------------|---------------------------
 *   Daily Critical Number      | DAILY_CRITICAL_NUMBER constant (560,000)  | fixed business figure, no
 *                               |                                            | relation to Fact_Targets --
 *                               |                                            | see that constant's docstring
 *   Daily/Monthly/Yearly       | Fact_SalesLines (value)                    | actual value for the day /
 *   Counter actuals            |                                            | MTD / YTD window
 *   Working Days / Weekly Rest | Dim_Date.IsWeeklyRestDay + calendar        | see computeWorkingDays below
 *   Official Holidays /        | official_holidays / forced_closures        | admin-owned tables (Admin
 *   Forced Closures            | (Admin Panel > Holidays & Closures)        | Panel > Official Holidays /
 *                               |                                            | Forced Closures) -- Company/
 *                               |                                            | Branch columns are text, not
 *                               |                                            | FKs, matched against the
 *                               |                                            | current scope in JS, see
 *                               |                                            | offDayMatchesScope below
 *   Missing Days/Value YTD     | derived                                    | per working day: actual vs
 *                               |                                            | Daily Critical Number
 *
 * Weekly-rest-day / working-day math is done with plain UTC date arithmetic (isFriday), not a
 * Dim_Date row lookup, because Dim_Date is only populated up to "today" (it's built incrementally
 * as data lands) while a Daily Critical Number needs the FULL calendar year's working-day count,
 * including months that haven't happened yet. official_holidays/forced_closures, by contrast,
 * genuinely carry future-dated rows (e.g. Aug/Nov holidays already scheduled), so those are read
 * straight from the DB. Confirmed against the live data: every Dim_Date row with
 * IsWeeklyRestDay=1 is a Friday, and Friday is the only weekday ever flagged that way --
 * isFriday() reproduces that exactly.
 *
 * Working Days YTD deliberately excludes Weekly Rest Days + Official Holidays (both apply
 * company/enterprise-wide) but NOT Forced Closures (forced_closures rows are single-branch
 * incidents -- a closure at one branch doesn't close the whole company, so it doesn't reduce the
 * enterprise-wide Working Days count; it's surfaced on its own card instead).
 *
 * official_holidays/forced_closures replaced fact_offdays as this page's off-day source in the
 * 2026-09 admin-panel revision pass -- see the "Official Holidays / Forced Closures access"
 * section below for why (fact_offdays is ETL-owned and gets overwritten on every pipeline run).
 */

import type { Pool } from 'mysql2/promise';
import { classifyVsTarget, variancePct, TargetStatus } from './classify';
import { fetchValueVolume } from './tachometer';
import {
  buildWhereClause,
  dateOnlyUTC,
  mtdWindow,
  ytdWindow,
  type DateWindow,
  type Filters,
} from './filters';

function toDateOnlyString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isFriday(d: Date): boolean {
  return d.getUTCDay() === 5;
}

function addDaysUTC(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

function countCalendarDays(window: DateWindow): number {
  return Math.round((window.end.getTime() - window.start.getTime()) / 86_400_000) + 1;
}

function countWeeklyRestDays(window: DateWindow): number {
  let count = 0;
  for (let cur = window.start; cur.getTime() <= window.end.getTime(); cur = addDaysUTC(cur, 1)) {
    if (isFriday(cur)) count += 1;
  }
  return count;
}

function yearWindow(year: number): DateWindow {
  return { start: dateOnlyUTC(year, 1, 1), end: dateOnlyUTC(year, 12, 31) };
}

function monthWindowFull(year: number, month1to12: number): DateWindow {
  const start = dateOnlyUTC(year, month1to12, 1);
  const lastDay = new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
  return { start, end: dateOnlyUTC(year, month1to12, lastDay) };
}

/** Same-day-of-year window one calendar year earlier (used for the Working Days YTD vs LYTD comparison). */
function shiftYearBack(window: DateWindow): DateWindow {
  return {
    start: dateOnlyUTC(window.start.getUTCFullYear() - 1, window.start.getUTCMonth() + 1, window.start.getUTCDate()),
    end: dateOnlyUTC(window.end.getUTCFullYear() - 1, window.end.getUTCMonth() + 1, window.end.getUTCDate()),
  };
}

// ---------------------------------------------------------------------------
// Official Holidays / Forced Closures access
//
// Admin-managed (Admin Panel > Official Holidays / Forced Closures) -- these two tables replaced
// fact_offdays as this page's off-day source in the 2026-09 admin-panel revision pass.
// fact_offdays is ETL-owned (resynced from OffDays.xlsx every pipeline run), so an admin-added row
// there would be silently wiped on the next run; official_holidays/forced_closures are plain
// admin-owned reference tables (see data/warehouse/migrations/0020_holidays_closures_admin.sql)
// that the ETL never touches, so Admin Panel edits take effect immediately and stay put.
// ---------------------------------------------------------------------------

export type OffDayType = 'official' | 'unexpected';

interface OffDayRow {
  date: Date;
  company: string | null;
  branch: string | null;
  holidayName: string | null;
  reason: string | null;
}

/** official_holidays -> OffDayRow, one row per calendar-day occurrence within `window`. A
 * `recurring` row's stored `holiday_date` is just a reference year -- it's re-anchored to every
 * calendar year the window spans, matched by (month, day), so e.g. a recurring Jan 1 holiday
 * stored as 2026-01-01 also fires for a 2027 or 2028 window. */
async function fetchOfficialHolidayRows(pool: Pool, window: DateWindow): Promise<OffDayRow[]> {
  const sql = `
    SELECT holiday_name AS holidayName, holiday_date AS holidayDate, recurring, company
    FROM official_holidays
    WHERE is_active = 1
      AND (recurring = 1 OR holiday_date BETWEEN ? AND ?)
  `;
  const [rows] = await pool.query(sql, [toDateOnlyString(window.start), toDateOnlyString(window.end)]);
  const out: OffDayRow[] = [];
  for (const r of rows as any[]) {
    const stored = r.holidayDate as Date;
    const toRow = (occurrence: Date): OffDayRow => ({
      date: occurrence,
      company: r.company ?? null,
      branch: null,
      holidayName: r.holidayName ?? null,
      reason: null,
    });
    if (!r.recurring) {
      out.push(toRow(new Date(Date.UTC(stored.getFullYear(), stored.getMonth(), stored.getDate()))));
      continue;
    }
    const month = stored.getMonth();
    const day = stored.getDate();
    for (let year = window.start.getUTCFullYear(); year <= window.end.getUTCFullYear(); year += 1) {
      const occurrence = new Date(Date.UTC(year, month, day));
      if (occurrence.getTime() >= window.start.getTime() && occurrence.getTime() <= window.end.getTime()) {
        out.push(toRow(occurrence));
      }
    }
  }
  return out;
}

/** forced_closures -> OffDayRow, one row per calendar-day occurrence within `window`. A closure
 * can span multiple days (`duration_days`); each covered day is expanded into its own OffDayRow
 * (clipped to `window`) so per-day occurrence lists/counts work exactly as before. */
async function fetchForcedClosureRows(pool: Pool, window: DateWindow): Promise<OffDayRow[]> {
  // Fetch any closure whose [closure_date, closure_date + duration_days - 1] span could overlap
  // the window at all, then expand + clip in JS below.
  const sql = `
    SELECT branch_key AS branch, company, closure_date AS closureDate, duration_days AS durationDays, reason
    FROM forced_closures
    WHERE is_active = 1
      AND closure_date <= ?
      AND DATE_ADD(closure_date, INTERVAL duration_days - 1 DAY) >= ?
  `;
  const [rows] = await pool.query(sql, [toDateOnlyString(window.end), toDateOnlyString(window.start)]);
  const out: OffDayRow[] = [];
  for (const r of rows as any[]) {
    const start = r.closureDate as Date;
    const startUtc = new Date(Date.UTC(start.getFullYear(), start.getMonth(), start.getDate()));
    const duration = Math.max(1, Number(r.durationDays) || 1);
    for (let i = 0; i < duration; i += 1) {
      const occurrence = addDaysUTC(startUtc, i);
      if (occurrence.getTime() >= window.start.getTime() && occurrence.getTime() <= window.end.getTime()) {
        out.push({ date: occurrence, company: r.company ?? null, branch: r.branch, holidayName: null, reason: r.reason ?? null });
      }
    }
  }
  return out;
}

async function fetchOffDayRows(pool: Pool, type: OffDayType, window: DateWindow): Promise<OffDayRow[]> {
  return type === 'official' ? fetchOfficialHolidayRows(pool, window) : fetchForcedClosureRows(pool, window);
}

/**
 * Most recent calendar date the ETL has actually loaded (Dim_Date is built incrementally as data
 * lands -- see this file's header note -- so its MAX(Date) is a direct signal of "how far the
 * pipeline has caught up", independent of any Company/Branch filter scope). Used by the
 * /critical-number/overview route to detect "today hasn't loaded yet" and fall back to the last
 * available day instead of showing today's (empty) figures. Returns null only for a completely
 * empty warehouse (no Dim_Date rows at all).
 */
export async function fetchLastAvailableDate(pool: Pool): Promise<Date | null> {
  const [rows] = await pool.query('SELECT MAX(Date) AS lastDate FROM dim_date');
  const row = (rows as any[])[0];
  if (!row?.lastDate) return null;
  const d = row.lastDate as Date;
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

async function fetchCompanyNamesByKey(pool: Pool): Promise<Map<number, string>> {
  const [rows] = await pool.query('SELECT CompanyKey AS companyKey, Company AS company FROM dim_company');
  const map = new Map<number, string>();
  for (const r of rows as any[]) map.set(Number(r.companyKey), String(r.company));
  return map;
}

/**
 * An official_holidays/forced_closures row applies to the current filter scope if:
 *  - its Company is null (official, country-wide holidays apply regardless of company filter), OR
 *    it matches one of the selected companyKeys (case-insensitive -- source data mixes "Majaal"
 *    and "TIKA" casing);
 *  - AND, if it has a Branch (forced closures always do), that branch is unfiltered or matches one
 *    of the selected salesTeamKeys.
 */
function offDayMatchesScope(row: OffDayRow, filters: Filters, companyNamesByKey: Map<number, string>): boolean {
  if (row.company && filters.companyKeys && filters.companyKeys.length > 0) {
    const allowedNames = filters.companyKeys.map((k) => companyNamesByKey.get(k)?.toLowerCase());
    if (!allowedNames.includes(row.company.toLowerCase())) return false;
  }
  if (row.branch && filters.salesTeamKeys && filters.salesTeamKeys.length > 0) {
    if (!filters.salesTeamKeys.includes(row.branch)) return false;
  }
  return true;
}

/** Working days = calendar days - weekly rest days - scope-matched official holidays. Forced
 * closures are NOT subtracted here -- see module docstring. */
async function computeWorkingDays(
  pool: Pool,
  window: DateWindow,
  filters: Filters,
  companyNamesByKey: Map<number, string>,
): Promise<number> {
  const totalDays = countCalendarDays(window);
  const restDays = countWeeklyRestDays(window);
  const officialRows = await fetchOffDayRows(pool, 'official', window);
  const officialCount = officialRows.filter(
    (r) => offDayMatchesScope(r, filters, companyNamesByKey) && !isFriday(r.date),
  ).length;
  return Math.max(0, totalDays - restDays - officialCount);
}

// ---------------------------------------------------------------------------
// Daily Critical Number
// ---------------------------------------------------------------------------

/**
 * Company-wide daily sales target, LYD 560,000/day -- a fixed business constant, not derived from
 * Fact_Targets. Confirmed with the business owner (2026-09-14 revision pass): "560 is a critical
 * number, it has no relation with the target." Previously this was computed as Full-Year Target
 * Revenue / working days in the year (per-company/segment scope-aware); that formula produced
 * ~LYD 559K against the live Fact_Targets data, which read as "wrong" because the two numbers were
 * never meant to be the same thing -- the Critical Number is a flat operational pace goal, the FY
 * Target is a separate planning figure.
 *
 * SUPERSEDED IN PART (2026-09, dynamic Company/Customer Group breakdown pass): this remains the
 * company-wide *base* figure with no filter applied, but computeDailyCriticalNumber below now
 * scales it by admin-configured Company/Customer Group percentages when those filters are active
 * -- see that function's docstring. The working-days denominator downstream (Monthly/Yearly
 * Counters, Missing Value/Days) was always scope-aware via holiday/closure matching; now the
 * numerator is too.
 */
export const DAILY_CRITICAL_NUMBER = 560_000;

/** Sum of admin_company.critical_number_pct for the given etl_company_keys (active rows only).
 * Returns 100 (i.e. "no scaling") when companyKeys is empty -- no Company filter means the full
 * base applies, same as selecting every company whose percentages sum to 100.
 *
 * A company_id present in companyKeys but absent from the query result (deactivated, or simply no
 * admin_company row for that etl_company_key) contributes 0 to the sum by construction -- that's
 * the intended "default 0% until an admin sets a real percentage" behavior, not an error, so it
 * needs no special handling here.
 *
 * The try/catch below is a *different* case: the query itself failing (e.g. critical_number_pct
 * not existing yet on this DB -- see migration 0021_critical_number_allocation.sql, which this
 * column shipped in but that was applied to the warehouse separately from this code going live,
 * so there was a window where every filtered Critical Number request 500'd). Every widget on the
 * Critical Number page shares this one dailyCriticalNumber computation (see
 * routes/criticalNumber.ts's single /overview endpoint), so an uncaught error here previously took
 * the entire page down instead of just this scaling factor -- degrade to unscaled (100, "ignore
 * the Company dimension") and log loudly instead.
 */
async function sumCompanyPct(pool: Pool, companyKeys: number[]): Promise<number> {
  if (companyKeys.length === 0) return 100;
  const placeholders = companyKeys.map(() => '?').join(',');
  try {
    const [rows] = await pool.query(
      `SELECT critical_number_pct AS pct FROM admin_company WHERE is_active = 1 AND etl_company_key IN (${placeholders})`,
      companyKeys,
    );
    return (rows as { pct: number }[]).reduce((sum, r) => sum + Number(r.pct), 0);
  } catch (err) {
    console.error(
      `[criticalNumber] sumCompanyPct failed for companyKeys=${JSON.stringify(companyKeys)}; ` +
        'falling back to unscaled (100%) rather than failing the whole Critical Number page.',
      err,
    );
    return 100;
  }
}

/** Sum of admin_customer_group.critical_number_pct for the given etl_segment_keys (active rows
 * only). Returns 100 (i.e. "no scaling") when segmentKeys is empty. Same "missing row = 0
 * contribution by construction, query failure = caught and degraded" split as sumCompanyPct
 * above. */
async function sumSegmentPct(pool: Pool, segmentKeys: number[]): Promise<number> {
  if (segmentKeys.length === 0) return 100;
  const placeholders = segmentKeys.map(() => '?').join(',');
  try {
    const [rows] = await pool.query(
      `SELECT critical_number_pct AS pct FROM admin_customer_group WHERE is_active = 1 AND etl_segment_key IN (${placeholders})`,
      segmentKeys,
    );
    return (rows as { pct: number }[]).reduce((sum, r) => sum + Number(r.pct), 0);
  } catch (err) {
    console.error(
      `[criticalNumber] sumSegmentPct failed for segmentKeys=${JSON.stringify(segmentKeys)}; ` +
        'falling back to unscaled (100%) rather than failing the whole Critical Number page.',
      err,
    );
    return 100;
  }
}

/**
 * Daily Critical Number, scaled by the active Company/Customer Group filter selection using the
 * admin-configured percentage breakdowns (Admin Panel > Companies / Customer Groups,
 * critical_number_pct column -- see data/warehouse/migrations/0021_critical_number_allocation.sql):
 *
 *   No Company filter and no Customer Group filter -> DAILY_CRITICAL_NUMBER unchanged.
 *   Company filter only                             -> base x (sum of selected companies' pct / 100).
 *   Customer Group filter only                       -> base x (sum of selected groups' pct / 100).
 *   Both                                              -> base x companyFactor x groupFactor (the two
 *                                                        factors cascade/multiply, they don't add).
 *
 * Multi-select within one dimension sums that dimension's percentages (e.g. selecting both Majaal
 * and Tika => 47.44 + 52.56 = 100%, i.e. the same as not filtering by Company at all). A selected
 * company/group with no admin-configured percentage yet (or none found, e.g. deactivated)
 * contributes 0 to that sum, per this feature's "default 0% until an admin sets a real percentage"
 * design -- so filtering to only such a company/group correctly yields a 0 Daily Critical Number
 * rather than silently falling back to the full base.
 *
 * This is the single source computeDailyCounter/computeMonthlyCounter/computeYearlyCounter/
 * computeMissingSummary all take their `dailyCriticalNumber` argument from (see
 * routes/criticalNumber.ts), so the scaled figure automatically flows through to every Daily/
 * Monthly/Yearly Counter, Missing Value/Days YTD, and their variance calculations -- not just the
 * Daily Critical Number display card.
 *
 * Kept async (Promise<number>) so every existing call site (routes/criticalNumber.ts) needs no
 * signature changes from before this feature.
 */
export async function computeDailyCriticalNumber(
  pool: Pool,
  _anchor: Date,
  filters: Filters,
  _companyNamesByKey: Map<number, string>,
): Promise<number> {
  const [companyPct, segmentPct] = await Promise.all([
    sumCompanyPct(pool, filters.companyKeys ?? []),
    sumSegmentPct(pool, filters.segmentKeys ?? []),
  ]);
  return DAILY_CRITICAL_NUMBER * (companyPct / 100) * (segmentPct / 100);
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

export interface DailyCounter {
  actual: number;
  target: number | null;
  status: TargetStatus;
  variancePct: number | null;
}

export async function computeDailyCounter(pool: Pool, anchor: Date, filters: Filters, dailyCriticalNumber: number): Promise<DailyCounter> {
  const vv = await fetchValueVolume(pool, { start: anchor, end: anchor }, filters);
  const target = dailyCriticalNumber > 0 ? dailyCriticalNumber : null;
  return {
    actual: vv.value,
    target,
    status: classifyVsTarget(vv.value, target),
    variancePct: variancePct(vv.value, target),
  };
}

export interface PeriodCounter {
  workingDaysElapsed: number;
  workingDaysTotal: number;
  achievementPct: number | null;
  status: TargetStatus;
  /** Cumulative actual value so far in the period (MTD/YTD), same figure the status/achievementPct
   * above are derived from -- exposed directly so the frontend can render the value gap without
   * re-deriving it from achievementPct (which loses precision once rounded for display). */
  actualValue: number;
  /** workingDaysElapsed * dailyCriticalNumber -- what the pace-based target says should have been
   * achieved by now. */
  expectedValue: number;
  /** actualValue - expectedValue: negative = behind pace, positive = ahead of pace. */
  gapValue: number;
  /** workingDaysTotal * dailyCriticalNumber -- the FULL month/year target (not just the
   * elapsed-to-date pace target above). Used by the frontend's donut chart to show
   * Achieved-vs-Remaining against the whole period, distinct from expectedValue/gapValue which
   * stay elapsed-based for the pace/status badge. */
  periodTarget: number;
}

async function computePeriodCounter(
  pool: Pool,
  elapsedWindow: DateWindow,
  fullWindow: DateWindow,
  filters: Filters,
  companyNamesByKey: Map<number, string>,
  dailyCriticalNumber: number,
): Promise<PeriodCounter> {
  const [workingDaysElapsed, workingDaysTotal, actualVv] = await Promise.all([
    computeWorkingDays(pool, elapsedWindow, filters, companyNamesByKey),
    computeWorkingDays(pool, fullWindow, filters, companyNamesByKey),
    fetchValueVolume(pool, elapsedWindow, filters),
  ]);
  const expectedToDate = workingDaysElapsed * dailyCriticalNumber;
  return {
    workingDaysElapsed,
    workingDaysTotal,
    achievementPct: expectedToDate > 0 ? actualVv.value / expectedToDate : null,
    status: classifyVsTarget(actualVv.value, expectedToDate > 0 ? expectedToDate : null),
    actualValue: actualVv.value,
    expectedValue: expectedToDate,
    gapValue: actualVv.value - expectedToDate,
    periodTarget: workingDaysTotal * dailyCriticalNumber,
  };
}

export async function computeMonthlyCounter(
  pool: Pool,
  anchor: Date,
  filters: Filters,
  companyNamesByKey: Map<number, string>,
  dailyCriticalNumber: number,
): Promise<PeriodCounter> {
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth() + 1;
  return computePeriodCounter(
    pool,
    mtdWindow(anchor),
    monthWindowFull(year, month),
    filters,
    companyNamesByKey,
    dailyCriticalNumber,
  );
}

export async function computeYearlyCounter(
  pool: Pool,
  anchor: Date,
  filters: Filters,
  companyNamesByKey: Map<number, string>,
  dailyCriticalNumber: number,
): Promise<PeriodCounter> {
  const year = anchor.getUTCFullYear();
  return computePeriodCounter(pool, ytdWindow(anchor), yearWindow(year), filters, companyNamesByKey, dailyCriticalNumber);
}

// ---------------------------------------------------------------------------
// Working Days / Weekly Rest / Official Holidays / Forced Closures YTD cards
// ---------------------------------------------------------------------------

export interface WorkingDaysCard {
  value: number;
  lastYear: number;
  variancePct: number | null;
}

export async function computeWorkingDaysYtd(
  pool: Pool,
  anchor: Date,
  filters: Filters,
  companyNamesByKey: Map<number, string>,
): Promise<WorkingDaysCard> {
  const ytd = ytdWindow(anchor);
  const [value, lastYear] = await Promise.all([
    computeWorkingDays(pool, ytd, filters, companyNamesByKey),
    computeWorkingDays(pool, shiftYearBack(ytd), filters, companyNamesByKey),
  ]);
  return { value, lastYear, variancePct: variancePct(value, lastYear) };
}

export function weeklyRestDaysYtd(anchor: Date): number {
  return countWeeklyRestDays(ytdWindow(anchor));
}

export interface OffDayItem {
  date: string;
  company: string | null;
  branch: string | null;
  /** HR-maintained holiday name (e.g. "Eid al-Fitr") from Fact_OffDays.HolidayName -- null when HR
   * hasn't filled it in for that row yet, in which case the frontend falls back to a generic label. */
  holidayName: string | null;
}

export interface OfficialHolidaysCard {
  value: number;
  items: OffDayItem[];
}

export async function computeOfficialHolidaysYtd(
  pool: Pool,
  anchor: Date,
  filters: Filters,
  companyNamesByKey: Map<number, string>,
): Promise<OfficialHolidaysCard> {
  const rows = (await fetchOffDayRows(pool, 'official', ytdWindow(anchor))).filter((r) =>
    offDayMatchesScope(r, filters, companyNamesByKey),
  );
  return {
    value: rows.length,
    items: rows
      .map((r) => ({ date: toDateOnlyString(r.date), company: r.company, branch: r.branch, holidayName: r.holidayName }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/** One individual closure day within a branch's group -- the hover/tap detail the frontend shows
 * per row, since a branch can be closed on different dates for different reasons (e.g. a storm one
 * week, a road closure another). */
export interface ForcedClosureOccurrence {
  date: string;
  reason: string | null;
}

export interface ForcedClosureBranchSummary {
  branch: string;
  /** Human-readable branch/team name from dim_salesteam (e.g. "Factory Outlet") -- falls back to
   * the branch code itself if the code doesn't resolve (shouldn't happen for real data, but a
   * closure record referencing a retired/renamed team shouldn't disappear from the list). */
  branchName: string;
  company: string | null;
  days: number;
  /** Every individual closure day for this branch, most recent first -- the reason text moved here
   * (out of an always-visible line) since a branch repeating in the list once per distinct reason
   * read as noisy/repetitive; the frontend now shows one row per branch and surfaces this list in a
   * hover/tap tooltip instead. */
  occurrences: ForcedClosureOccurrence[];
}

export interface ForcedClosuresCard {
  value: number;
  branches: ForcedClosureBranchSummary[];
}

/** sales_team_key -> sales_team_name, for labeling Fact_OffDays' branch codes (Fact_OffDays.Branch
 * carries the raw dim_sales_team key, e.g. 'TK-BEN-BC-03', not a display name -- see this file's
 * header note on Fact_OffDays' Branch column). Same table/columns routes/filters.ts's /branches
 * endpoint already reads for the Branch filter dropdown. */
async function fetchBranchNamesByKey(pool: Pool): Promise<Map<string, string>> {
  // "key" is a reserved word in MySQL and can't be used bare as a column alias.
  const [rows] = await pool.query('SELECT SalesTeamKey AS branchKey, SalesTeam AS branchName FROM dim_salesteam');
  const map = new Map<string, string>();
  for (const r of rows as any[]) map.set(String(r.branchKey), String(r.branchName));
  return map;
}

export async function computeForcedClosuresYtd(
  pool: Pool,
  anchor: Date,
  filters: Filters,
  companyNamesByKey: Map<number, string>,
): Promise<ForcedClosuresCard> {
  const [rowsRaw, branchNamesByKey] = await Promise.all([
    fetchOffDayRows(pool, 'unexpected', ytdWindow(anchor)),
    fetchBranchNamesByKey(pool),
  ]);
  const rows = rowsRaw.filter((r) => offDayMatchesScope(r, filters, companyNamesByKey));
  // Grouped by branch alone (one row per branch, not per branch+reason) -- every individual
  // closure day (with its own date + reason) is collected into `occurrences` for that branch, so
  // the summary list doesn't repeat the same branch once per distinct reason.
  const byBranch = new Map<string, ForcedClosureBranchSummary & { occurrenceObjs: { date: Date; reason: string | null }[] }>();
  for (const r of rows) {
    const branch = r.branch ?? 'Unassigned';
    const existing = byBranch.get(branch);
    if (existing) {
      existing.days += 1;
      existing.occurrenceObjs.push({ date: r.date, reason: r.reason ?? null });
    } else {
      byBranch.set(branch, {
        branch,
        branchName: branchNamesByKey.get(branch) ?? branch,
        company: r.company,
        days: 1,
        occurrences: [],
        occurrenceObjs: [{ date: r.date, reason: r.reason ?? null }],
      });
    }
  }
  const branches = Array.from(byBranch.values())
    .sort((a, b) => b.days - a.days)
    .map(({ occurrenceObjs, ...summary }) => ({
      ...summary,
      occurrences: occurrenceObjs
        .sort((a, b) => b.date.getTime() - a.date.getTime())
        .map((o) => ({ date: toDateOnlyString(o.date), reason: o.reason })),
    }));
  return { value: rows.length, branches };
}

// ---------------------------------------------------------------------------
// Missing Days YTD / Missing Value YTD
// ---------------------------------------------------------------------------

/** DateKey (YYYYMMDD) -> actual value, for every day with at least one sale in the window. */
async function fetchDailyActuals(pool: Pool, window: DateWindow, filters: Filters): Promise<Map<number, number>> {
  const { clause, params } = buildWhereClause(filters, 'fsl', true);
  const sql = `
    SELECT fsl.DateKey AS dateKey, COALESCE(SUM(fsl.Value), 0) AS value
    FROM fact_saleslines fsl
    WHERE fsl.DateKey BETWEEN ? AND ?
      AND ${clause}
    GROUP BY fsl.DateKey
  `;
  const startKey = Number(toDateOnlyString(window.start).replace(/-/g, ''));
  const endKey = Number(toDateOnlyString(window.end).replace(/-/g, ''));
  const [rows] = await pool.query(sql, [startKey, endKey, ...params]);
  const map = new Map<number, number>();
  for (const r of rows as any[]) map.set(Number(r.dateKey), Number(r.value));
  return map;
}

function dateKeyOf(d: Date): number {
  return Number(toDateOnlyString(d).replace(/-/g, ''));
}

export interface MissingDaysCard {
  value: number;
  trendValues: number[];
  trendPct: number | null;
  /** Working Days YTD (cumWorkingDays as of the anchor date) -- the "expected days consumed"
   * figure this row's day-equivalent gap is measured against, replacing the old 'On pace' string
   * placeholder in the Performance Details table's Target column. */
  expectedValue: number;
}

export interface MissingValueCard {
  value: number;
  trendValues: number[];
  trendPct: number | null;
  /** Working Days YTD x Daily Critical Number, as of the anchor date -- same pace-adjusted
   * "expected value as of today" methodology as PeriodCounter.expectedValue (see that field's
   * docstring), replacing the old 'On pace' string placeholder in the Performance Details table's
   * Target column. */
  expectedValue: number;
}

function trendPctFromHalves(series: number[]): number | null {
  if (series.length < 2) return null;
  const mid = Math.floor(series.length / 2);
  const first = series.slice(0, mid);
  const second = series.slice(mid);
  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
  const firstAvg = avg(first);
  const secondAvg = avg(second);
  if (firstAvg === 0) return null;
  return (secondAvg - firstAvg) / firstAvg;
}

export interface MissingSummary {
  missingDays: MissingDaysCard;
  missingValue: MissingValueCard;
}

/** One calendar day of the YTD pace walk shared by computeMissingSummary and
 * computeMissingTrend: whether it counts as a working day (not a Friday, not a scope-matched
 * official holiday -- same rule as computeWorkingDays) and that day's own actual sales value. */
export interface PaceDay {
  date: Date;
  isWorkingDay: boolean;
  actual: number;
}

async function fetchYtdPaceDays(
  pool: Pool,
  anchor: Date,
  filters: Filters,
  companyNamesByKey: Map<number, string>,
): Promise<PaceDay[]> {
  const ytd = ytdWindow(anchor);
  const [dailyActuals, officialRows] = await Promise.all([
    fetchDailyActuals(pool, ytd, filters),
    fetchOffDayRows(pool, 'official', ytd),
  ]);
  const scopedHolidayDateKeys = new Set(
    officialRows.filter((r) => offDayMatchesScope(r, filters, companyNamesByKey)).map((r) => dateKeyOf(r.date)),
  );
  const days: PaceDay[] = [];
  for (let cur = ytd.start; cur.getTime() <= ytd.end.getTime(); cur = addDaysUTC(cur, 1)) {
    const key = dateKeyOf(cur);
    days.push({
      date: cur,
      isWorkingDay: !isFriday(cur) && !scopedHolidayDateKeys.has(key),
      actual: dailyActuals.get(key) ?? 0,
    });
  }
  return days;
}

/**
 * Net-aggregate gap against the flat Daily Critical Number (dashboard revision pass -- replaces an
 * earlier unnetted per-day-shortfall sum, which read as far worse than actual YTD performance
 * because it never let surplus days offset shortfall days):
 *
 *   Total Expected YTD = Working Days YTD x Daily Critical Number
 *   Missing Value YTD  = Total Expected YTD - Actual YTD Value
 *   Missing Days YTD   = Missing Value YTD / Daily Critical Number
 *
 * Signed, not floored at zero (2026-09 revision): a positive value means behind pace (shortfall),
 * a negative value means ahead of pace (surplus) -- previously both were clamped to
 * max(0, ...), which made overperformance invisible (always read "0 missing" instead of showing
 * the surplus). The frontend displays the sign flipped (Actual - Target, so ahead reads positive/
 * green) to match PeriodCounterCard's gapValue convention.
 *
 * Actual YTD Value is the full-window actual (every calendar day, matching the Yearly Counter's
 * own actualValue) -- pace is measured cumulatively, not day by day, so a big sales day fully
 * offsets a slow one instead of being invisible to this metric.
 *
 * Trend series are the running value of this same net formula evaluated as of each earlier
 * point (last 30 calendar days for Missing Days, each month-end for Missing Value) -- a
 * cumulative-so-far reading, not that single day/month's own isolated result.
 *
 * In-progress day (2026-09 round 2 fix): when `inProgressDate` is the anchor (i.e. the anchor is
 * the current business day), that day is walked for the headline figures -- unchanged, so they
 * still agree with the Yearly Counter's gapValue -- but left OUT of both trend series. A day still
 * being traded contributes its full Daily Critical Number to the expected side while only a
 * partial (often zero, before the first ETL load) actual, so plotting it made every sparkline end
 * in a spurious ~1-day plunge.
 */
export async function computeMissingSummary(
  pool: Pool,
  anchor: Date,
  filters: Filters,
  companyNamesByKey: Map<number, string>,
  dailyCriticalNumber: number,
  inProgressDate: Date | null = null,
): Promise<MissingSummary> {
  const days = await fetchYtdPaceDays(pool, anchor, filters, companyNamesByKey);

  let cumWorkingDays = 0;
  let cumActual = 0;
  const dailyRunningMissingDays: number[] = [];
  const monthlyRunningMissingValue = new Map<string, number>(); // 'YYYY-MM' -> running value as of that month's last walked day

  for (const day of days) {
    cumActual += day.actual;
    if (day.isWorkingDay) cumWorkingDays += 1;
    if (inProgressDate && day.date.getTime() >= inProgressDate.getTime()) continue;

    const runningMissingValue = dailyCriticalNumber > 0 ? cumWorkingDays * dailyCriticalNumber - cumActual : 0;
    const runningMissingDays = dailyCriticalNumber > 0 ? runningMissingValue / dailyCriticalNumber : 0;

    dailyRunningMissingDays.push(runningMissingDays);
    const cur = day.date;
    const monthKey = `${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, '0')}`;
    monthlyRunningMissingValue.set(monthKey, runningMissingValue);
  }

  const expectedValueToDate = cumWorkingDays * dailyCriticalNumber;
  const missingValue = dailyCriticalNumber > 0 ? expectedValueToDate - cumActual : 0;
  const missingDays = dailyCriticalNumber > 0 ? Math.round(missingValue / dailyCriticalNumber) : 0;

  const last30 = dailyRunningMissingDays.slice(-30);
  const monthlySeries = Array.from(monthlyRunningMissingValue.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v);

  return {
    missingDays: {
      value: missingDays,
      trendValues: last30,
      trendPct: trendPctFromHalves(last30),
      expectedValue: cumWorkingDays,
    },
    missingValue: {
      value: missingValue,
      trendValues: monthlySeries,
      trendPct: trendPctFromHalves(monthlySeries),
      expectedValue: expectedValueToDate,
    },
  };
}

// ---------------------------------------------------------------------------
// Missing Value / Missing Days -- expanded-view breakdown (Daily / Weekly / Monthly)
// ---------------------------------------------------------------------------

export type MissingTrendGranularity = 'daily' | 'weekly' | 'monthly';

/**
 * One row of the expanded Missing Value / Missing Days view. Gap sign follows what the page
 * DISPLAYS (Actual - Target: negative = behind pace, positive = ahead), not computeMissingSummary's
 * raw Target - Actual, so the chart/table read the same way as the card's headline figure.
 */
export interface MissingTrendPeriod {
  /** Stable id: the period's first date (YYYY-MM-DD). */
  key: string;
  /** First / last calendar date the period covers, clipped to the YTD window (YYYY-MM-DD). */
  start: string;
  end: string;
  workingDays: number;
  /** workingDays x Daily Critical Number -- the pace target for this period alone. */
  target: number;
  actual: number;
  /** actual - target for this period alone. */
  gapValue: number;
  /** gapValue / Daily Critical Number. */
  gapDays: number;
  /** Running totals from Jan 1 through this period's end -- the values the trend chart plots. */
  cumulativeTarget: number;
  cumulativeActual: number;
  cumulativeGap: number;
  cumulativeGapDays: number;
  /** True when the period contains the in-progress (current, still-trading) day: its actual is
   * partial, so the frontend marks it rather than presenting it as a finished result. */
  inProgress: boolean;
}

function periodKeyOf(date: Date, granularity: MissingTrendGranularity): string {
  if (granularity === 'daily') return toDateOnlyString(date);
  if (granularity === 'monthly') return toDateOnlyString(date).slice(0, 7);
  // Weekly: Saturday-to-Friday business weeks (Friday is the weekly rest day), keyed by the
  // Saturday that starts the week.
  const daysSinceSaturday = (date.getUTCDay() + 1) % 7;
  return toDateOnlyString(addDaysUTC(date, -daysSinceSaturday));
}

/**
 * Buckets the YTD pace walk into daily / weekly / monthly periods. Pure (no DB access), so the
 * aggregation is unit-tested directly -- see criticalNumber.test.ts.
 */
export function bucketPaceDays(
  days: PaceDay[],
  dailyCriticalNumber: number,
  granularity: MissingTrendGranularity,
  inProgressDate: Date | null,
): MissingTrendPeriod[] {
  const periods: MissingTrendPeriod[] = [];
  const byKey = new Map<string, MissingTrendPeriod>();
  let cumTarget = 0;
  let cumActual = 0;
  for (const day of days) {
    const key = periodKeyOf(day.date, granularity);
    let period = byKey.get(key);
    if (!period) {
      period = {
        key: toDateOnlyString(day.date),
        start: toDateOnlyString(day.date),
        end: toDateOnlyString(day.date),
        workingDays: 0,
        target: 0,
        actual: 0,
        gapValue: 0,
        gapDays: 0,
        cumulativeTarget: 0,
        cumulativeActual: 0,
        cumulativeGap: 0,
        cumulativeGapDays: 0,
        inProgress: false,
      };
      byKey.set(key, period);
      periods.push(period);
    }
    const dayTarget = day.isWorkingDay ? dailyCriticalNumber : 0;
    cumTarget += dayTarget;
    cumActual += day.actual;
    period.end = toDateOnlyString(day.date);
    if (day.isWorkingDay) period.workingDays += 1;
    period.target += dayTarget;
    period.actual += day.actual;
    period.cumulativeTarget = cumTarget;
    period.cumulativeActual = cumActual;
    if (inProgressDate && day.date.getTime() === inProgressDate.getTime()) period.inProgress = true;
  }
  for (const p of periods) {
    p.gapValue = p.actual - p.target;
    p.cumulativeGap = p.cumulativeActual - p.cumulativeTarget;
    p.gapDays = dailyCriticalNumber > 0 ? p.gapValue / dailyCriticalNumber : 0;
    p.cumulativeGapDays = dailyCriticalNumber > 0 ? p.cumulativeGap / dailyCriticalNumber : 0;
  }
  return periods;
}

export interface MissingTrend {
  daily: MissingTrendPeriod[];
  weekly: MissingTrendPeriod[];
  monthly: MissingTrendPeriod[];
}

export async function computeMissingTrend(
  pool: Pool,
  anchor: Date,
  filters: Filters,
  companyNamesByKey: Map<number, string>,
  dailyCriticalNumber: number,
  inProgressDate: Date | null,
): Promise<MissingTrend> {
  const days = await fetchYtdPaceDays(pool, anchor, filters, companyNamesByKey);
  return {
    daily: bucketPaceDays(days, dailyCriticalNumber, 'daily', inProgressDate),
    weekly: bucketPaceDays(days, dailyCriticalNumber, 'weekly', inProgressDate),
    monthly: bucketPaceDays(days, dailyCriticalNumber, 'monthly', inProgressDate),
  };
}

export { fetchCompanyNamesByKey };
