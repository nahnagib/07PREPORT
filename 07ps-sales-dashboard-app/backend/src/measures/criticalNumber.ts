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
 *   Metric                    | Source table(s)                    | How
 *   ---------------------------|-------------------------------------|---------------------------
 *   Daily Critical Number      | Fact_Targets (Target_Revenue)       | FY target (scope-filtered)
 *                               |                                     | / working days in the FY
 *   Daily/Monthly/Yearly       | Fact_SalesLines (value)             | actual value for the day /
 *   Counter actuals            |                                     | MTD / YTD window
 *   Working Days / Weekly Rest | Dim_Date.IsWeeklyRestDay + calendar  | see computeWorkingDays below
 *   Official Holidays /        | Fact_OffDays (OffDayType='official' | Fact_OffDays' Company/Branch
 *   Forced Closures            | / 'unexpected')                     | columns are text, not FKs --
 *                               |                                     | matched against the current
 *                               |                                     | scope in JS, see
 *                               |                                     | offDayMatchesScope below
 *   Missing Days/Value YTD     | derived                             | per working day: actual vs
 *                               |                                     | Daily Critical Number
 *
 * Weekly-rest-day / working-day math is done with plain UTC date arithmetic (isFriday), not a
 * Dim_Date row lookup, because Dim_Date is only populated up to "today" (it's built incrementally
 * as data lands) while a Daily Critical Number needs the FULL calendar year's working-day count,
 * including months that haven't happened yet. Fact_OffDays, by contrast, genuinely does carry
 * future-dated rows (e.g. Aug/Nov holidays already scheduled), so those are read straight from the
 * DB. Confirmed against the live data: every Dim_Date row with IsWeeklyRestDay=1 is a Friday, and
 * Friday is the only weekday ever flagged that way -- isFriday() reproduces that exactly.
 *
 * Working Days YTD deliberately excludes Weekly Rest Days + Official Holidays (both apply
 * company/enterprise-wide) but NOT Forced Closures (Fact_OffDays 'unexpected' rows are single-
 * branch incidents -- a closure at one branch doesn't close the whole company, so it doesn't
 * reduce the enterprise-wide Working Days count; it's surfaced on its own card instead). This
 * reproduces the reference mockup's numbers exactly against the real warehouse (155 working days
 * YTD = calendar days YTD (192) - weekly rest (28) - official holidays scope-matched (9), as of
 * anchor 2026-07-11).
 */

import type { Pool } from 'mysql2/promise';
import { classifyVsTarget, variancePct, TargetStatus } from './classify';
import { fetchTargetForMonths, fetchValueVolume } from './tachometer';
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
// Fact_OffDays access
// ---------------------------------------------------------------------------

export type OffDayType = 'official' | 'unexpected';

interface OffDayRow {
  date: Date;
  company: string | null;
  branch: string | null;
  holidayName: string | null;
  reason: string | null;
}

async function fetchOffDayRows(pool: Pool, type: OffDayType, window: DateWindow): Promise<OffDayRow[]> {
  // HolidayName/Reason now exist on fact_offdays (confirmed via SHOW COLUMNS against the live
  // warehouse after the latest OffDays.xlsx resync) -- previously this table only had
  // DateKey/Date/OffDayType/Country/Company/Branch/IsActive, so these were hardcoded to null here
  // to avoid an "Unknown column" error on every request. Selected directly now; still nullable
  // (HR may leave either blank for a given row), which every consumer already handles by falling
  // back to generic label text.
  const sql = `
    SELECT Date AS date, Company AS company, Branch AS branch, HolidayName AS holidayName, Reason AS reason
    FROM fact_offdays
    WHERE OffDayType = ? AND IsActive = 1 AND Date BETWEEN ? AND ?
  `;
  const [rows] = await pool.query(sql, [type, toDateOnlyString(window.start), toDateOnlyString(window.end)]);
  return (rows as any[]).map((r) => ({
    date: new Date(Date.UTC(r.date.getFullYear(), r.date.getMonth(), r.date.getDate())),
    company: r.company,
    branch: r.branch,
    holidayName: r.holidayName ?? null,
    reason: r.reason ?? null,
  }));
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
 * A Fact_OffDays row applies to the current filter scope if:
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
 * The required daily value to stay on the current filter scope's annual pace: Full-Year Target
 * Revenue / total working days in the year (weekly rest + official holidays only, per
 * computeWorkingDays). Deliberately static across the year (not re-derived from remaining
 * target/remaining days) -- matches the reference mockup's "updates when Company/Segment filter
 * changes" behavior, not a catch-up-pace number that would also move day to day.
 */
export async function computeDailyCriticalNumber(
  pool: Pool,
  anchor: Date,
  filters: Filters,
  companyNamesByKey: Map<number, string>,
): Promise<number> {
  const year = anchor.getUTCFullYear();
  const [fyTarget, workingDaysInYear] = await Promise.all([
    fetchTargetForMonths(pool, year, filters),
    computeWorkingDays(pool, yearWindow(year), filters, companyNamesByKey),
  ]);
  if (workingDaysInYear <= 0) return 0;
  return fyTarget.targetRevenue / workingDaysInYear;
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
  const { clause, params } = buildWhereClause(filters, 'fsl');
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
}

export interface MissingValueCard {
  value: number;
  trendValues: number[];
  trendPct: number | null;
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

/**
 * Net-aggregate shortfall against the flat Daily Critical Number (dashboard revision pass --
 * replaces an earlier unnetted per-day-shortfall sum, which read as far worse than actual YTD
 * performance because it never let surplus days offset shortfall days):
 *
 *   Total Expected YTD = Working Days YTD x Daily Critical Number
 *   Missing Value YTD  = max(0, Total Expected YTD - Actual YTD Value)
 *   Missing Days YTD   = Missing Value YTD / Daily Critical Number
 *
 * Actual YTD Value is the full-window actual (every calendar day, matching the Yearly Counter's
 * own actualValue) -- pace is measured cumulatively, not day by day, so a big sales day fully
 * offsets a slow one instead of being invisible to this metric.
 *
 * Trend series are the running value of this same net formula evaluated as of each earlier
 * point (last 30 calendar days for Missing Days, each month-end for Missing Value) -- a
 * cumulative-so-far reading, not that single day/month's own isolated result.
 */
export async function computeMissingSummary(
  pool: Pool,
  anchor: Date,
  filters: Filters,
  companyNamesByKey: Map<number, string>,
  dailyCriticalNumber: number,
): Promise<MissingSummary> {
  const ytd = ytdWindow(anchor);
  const [dailyActuals, officialRows] = await Promise.all([
    fetchDailyActuals(pool, ytd, filters),
    fetchOffDayRows(pool, 'official', ytd),
  ]);
  const scopedHolidayDateKeys = new Set(
    officialRows.filter((r) => offDayMatchesScope(r, filters, companyNamesByKey)).map((r) => dateKeyOf(r.date)),
  );

  let cumWorkingDays = 0;
  let cumActual = 0;
  const dailyRunningMissingDays: number[] = [];
  const monthlyRunningMissingValue = new Map<string, number>(); // 'YYYY-MM' -> running value as of that month's last walked day

  for (let cur = ytd.start; cur.getTime() <= ytd.end.getTime(); cur = addDaysUTC(cur, 1)) {
    const key = dateKeyOf(cur);
    const isWorkingDay = !isFriday(cur) && !scopedHolidayDateKeys.has(key);
    const actual = dailyActuals.get(key) ?? 0;
    cumActual += actual;
    if (isWorkingDay) cumWorkingDays += 1;

    const runningMissingValue = dailyCriticalNumber > 0 ? Math.max(0, cumWorkingDays * dailyCriticalNumber - cumActual) : 0;
    const runningMissingDays = dailyCriticalNumber > 0 ? runningMissingValue / dailyCriticalNumber : 0;

    dailyRunningMissingDays.push(runningMissingDays);
    const monthKey = `${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, '0')}`;
    monthlyRunningMissingValue.set(monthKey, runningMissingValue);
  }

  const missingValue = dailyCriticalNumber > 0 ? Math.max(0, cumWorkingDays * dailyCriticalNumber - cumActual) : 0;
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
    },
    missingValue: {
      value: missingValue,
      trendValues: monthlySeries,
      trendPct: trendPctFromHalves(monthlySeries),
    },
  };
}

export { fetchCompanyNamesByKey };
