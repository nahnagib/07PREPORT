/**
 * Tachometer filter model, date-window logic, and the Salesperson RBAC lock.
 *
 * Ported 1:1 from data/warehouse/measures/filters.py (the validated Python reference).
 *
 * Filter -> warehouse dimension mapping (confirmed against the real SalesModel_OneOutput.xlsx
 * export and the loaded schema, not assumed from names):
 *
 *   Business Unit / Company   -> dim_company.company_key        (Tika, Majaal)
 *   Customer Group            -> dim_segment.segment_key        (NOT a "customer" table -- see
 *                                                                  note below)
 *   Distribution Channel      -> dim_distribution_channel.channel_key
 *   Branch                    -> dim_sales_team.sales_team_key  (see note below)
 *   Sales Person              -> dim_salesperson.salesperson_key
 *   POS                       -> NOT WIRED. Confirmed unused in the real data -- see note below.
 *
 * Customer Group -> dim_segment, not dim_customer.CustomerSegment
 * ------------------------------------------------------------------
 * dim_customer.CustomerSegment only ever takes 'B2B'/'B2C'/'Unknown' in the real export (12,094 /
 * 1,843 / 80 of 14,017 customers) -- no 'Corporate' or 'Internal Company' value exists there. The
 * manual's four groups are backed by dim_segment/segment_key instead: B2B (1), B2C (2), Backoffice
 * (3), Inter Company (4), Unknown (5) -- "Backoffice"/"Inter Company" are the same two groups the
 * manual labels "Corporate"/"Internal Company" under different internal names. segment_key is
 * what every fact table's filter column actually uses; the label mapping belongs at the
 * presentation layer.
 *
 * Branch -> dim_sales_team, not a separate Branch/Location dimension
 * ----------------------------------------------------------------------
 * There is no standalone Branch/Location table anywhere in the export. dim_sales_team already
 * carries one row per physical team/branch combination (28 rows, each with a city).
 *
 * POS -> confirmed inactive, not wired
 * ----------------------------------------
 * Searched every column header across all 28 sheets in the real export; nothing POS-related
 * exists. Matches the manual's own "Inactive (not used)" note. No POS filter is implemented.
 */

// Multi-select: each field is an array of selected keys. An empty/undefined array means "no
// restriction on this dimension" (matches the old null/undefined single-value behavior). Multiple
// values within one field are OR'd together (IN (...)); different fields are AND'd together.
export interface Filters {
  companyKeys?: number[]; // Business Unit / Company
  segmentKeys?: number[]; // Customer Group (see module docstring)
  channelKeys?: number[]; // Distribution Channel
  salesTeamKeys?: string[]; // Branch
  salespersonKeys?: number[]; // Sales Person
}

export const EMPTY_FILTERS: Filters = {};

// Column name each Filters field maps to on Fact_SalesLines / Fact_Orders / Fact_Targets --
// all these tables use identical column names for these five, so one clause-builder works for all.
const FILTER_COLUMNS: Record<keyof Filters, string> = {
  companyKeys: 'CompanyKey',
  segmentKeys: 'SegmentKey',
  channelKeys: 'ChannelKey',
  salesTeamKeys: 'SalesTeamKey',
  salespersonKeys: 'SalespersonKey',
};

/**
 * Build a parametrized SQL WHERE fragment (without the leading 'WHERE') and its params.
 *
 * Returns ("1=1", []) if no filters are set, so callers can always do
 * `WHERE ${dateClause} AND ${filterClause}` without special-casing "no filters".
 */
export function buildWhereClause(
  filters: Filters,
  tableAlias = '',
): { clause: string; params: Array<string | number> } {
  const prefix = tableAlias ? `${tableAlias}.` : '';
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  (Object.keys(FILTER_COLUMNS) as Array<keyof Filters>).forEach((field) => {
    const values = filters[field];
    if (values && values.length > 0) {
      const placeholders = values.map(() => '?').join(', ');
      clauses.push(`${prefix}${FILTER_COLUMNS[field]} IN (${placeholders})`);
      params.push(...values);
    }
  });

  if (clauses.length === 0) {
    return { clause: '1=1', params: [] };
  }
  return { clause: clauses.join(' AND '), params };
}

// ---------------------------------------------------------------------------
// Salesperson RBAC lock (role_tier = 'SALESPERSON')
// ---------------------------------------------------------------------------

export interface UserContext {
  roleCode: string;
  salespersonKey?: number | null;
}

export class SalespersonLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SalespersonLockError';
  }
}

/**
 * Enforce the manual's rule: "For sales users, all filters are locked except the assigned
 * salesperson. Each salesperson sees only their own data."
 *
 * Behavior for a SALESPERSON-tier user:
 *   - companyKeys/segmentKeys/channelKeys/salesTeamKeys are forced to empty (unlocked filters are
 *     meaningless once salespersonKeys pins the result to one person's own records; forcing them
 *     off rather than silently intersecting them avoids a UI bug where a stale Company selection
 *     makes a salesperson's own dashboard show zero rows).
 *   - salespersonKeys is forced to [the user's own dim_salesperson key] from app_user, regardless
 *     of whatever was passed in. If the caller explicitly passed a *different* salespersonKey, that
 *     is treated as a bug/attempted scope escape and throws rather than silently overriding it.
 *
 * Any other roleCode is returned unchanged -- this function only ever restricts, never expands, a
 * caller's filters.
 */
export function applySalespersonLock(filters: Filters, user: UserContext): Filters {
  if (user.roleCode !== 'SALESPERSON') {
    return filters;
  }

  if (user.salespersonKey === null || user.salespersonKey === undefined) {
    throw new SalespersonLockError(
      'User has SALESPERSON role but no salespersonKey on app_user -- cannot scope any query. ' +
        'This is a data setup problem (app_user row is missing salesperson_key), not something ' +
        'to default around.',
    );
  }

  const requestedOtherKey = (filters.salespersonKeys ?? []).find((k) => k !== user.salespersonKey);
  if (requestedOtherKey !== undefined) {
    throw new SalespersonLockError(
      `SALESPERSON-tier user (salespersonKey=${user.salespersonKey}) requested data for a ` +
        `different salespersonKey=${requestedOtherKey}. Refusing rather than silently ` +
        `redirecting or silently honoring it.`,
    );
  }

  return {
    companyKeys: [],
    segmentKeys: [],
    channelKeys: [],
    salesTeamKeys: [],
    salespersonKeys: [user.salespersonKey],
  };
}

// ---------------------------------------------------------------------------
// Date windows: MTD / YTD / LMTD / LYTD / FLM / FLY
//
// All dates are represented as plain `Date` objects at UTC midnight to avoid timezone drift --
// callers should construct anchors via `dateOnlyUTC(y, m, d)` below rather than `new Date()`
// directly.
// ---------------------------------------------------------------------------

export interface DateWindow {
  start: Date;
  end: Date;
}

export function dateOnlyUTC(year: number, month1to12: number, day: number): Date {
  return new Date(Date.UTC(year, month1to12 - 1, day));
}

function daysInMonth(year: number, month1to12: number): number {
  // Day 0 of the next month = last day of this month.
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

/** Month-to-Date: start of the selected month through the selected date (inclusive). */
export function mtdWindow(anchor: Date): DateWindow {
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth() + 1;
  return { start: dateOnlyUTC(y, m, 1), end: anchor };
}

/** Year-to-Date: start of the selected year through the selected date (inclusive). */
export function ytdWindow(anchor: Date): DateWindow {
  const y = anchor.getUTCFullYear();
  return { start: dateOnlyUTC(y, 1, 1), end: anchor };
}

/**
 * Same month/day, prior year. Feb 29 on a non-leap prior year falls back to Feb 28 -- the only
 * case this can't map 1:1, and this is the conventional resolution.
 */
function shiftOneYearBack(anchor: Date): Date {
  const y = anchor.getUTCFullYear() - 1;
  const m = anchor.getUTCMonth() + 1;
  const d = anchor.getUTCDate();
  if (m === 2 && d === 29 && daysInMonth(y, 2) < 29) {
    return dateOnlyUTC(y, 2, 28);
  }
  return dateOnlyUTC(y, m, d);
}

/** Last-year MTD: same day-of-month/month window, one calendar year earlier. */
export function lmtdWindow(anchor: Date): DateWindow {
  return mtdWindow(shiftOneYearBack(anchor));
}

/** Last-year YTD: same year-to-date window, one calendar year earlier. */
export function lytdWindow(anchor: Date): DateWindow {
  return ytdWindow(shiftOneYearBack(anchor));
}

/** Full Last Year: the entire calendar year before the selected date's year. */
export function flyWindow(anchor: Date): DateWindow {
  const y = anchor.getUTCFullYear() - 1;
  return { start: dateOnlyUTC(y, 1, 1), end: dateOnlyUTC(y, 12, 31) };
}

/** Full Last Month: the entire calendar month before the selected date's month. */
export function flmWindow(anchor: Date): DateWindow {
  const anchorY = anchor.getUTCFullYear();
  const anchorM = anchor.getUTCMonth() + 1;
  let y: number;
  let m: number;
  if (anchorM === 1) {
    y = anchorY - 1;
    m = 12;
  } else {
    y = anchorY;
    m = anchorM - 1;
  }
  const lastDay = daysInMonth(y, m);
  return { start: dateOnlyUTC(y, m, 1), end: dateOnlyUTC(y, m, lastDay) };
}

// ---------------------------------------------------------------------------
// FY/FM Target-to-date proration (simple calendar-day method, confirmed with the project owner;
// the vendored pipeline has no existing proration logic for this).
// ---------------------------------------------------------------------------

/**
 * Fraction of the selected month elapsed as of the selected date (day_of_month / days_in_month).
 * Used to prorate a Full-Month Target down to a Month-to-Date target-to-date figure:
 *   MTD Target-to-date = FM Target * monthElapsedFraction(anchor)
 */
export function monthElapsedFraction(anchor: Date): number {
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth() + 1;
  const d = anchor.getUTCDate();
  return d / daysInMonth(y, m);
}

export function prorateMtdTarget(
  fmTarget: number | null | undefined,
  anchor: Date,
): number | null {
  if (fmTarget === null || fmTarget === undefined) {
    return null;
  }
  return fmTarget * monthElapsedFraction(anchor);
}

/**
 * YTD Target-to-date = sum of FULL targets for months fully completed before the selected month,
 * plus the current (partial) month's target prorated by day-of-month.
 *
 * This deliberately does NOT divide the Full-Year Target by 365/366 and multiply by day-of-year --
 * fact_target_plan's monthly target figures are not uniform month to month (real data ranges from
 * roughly LYD 60K to LYD 1.8M per team per month), so a flat annual-ratio approach would misstate
 * a to-date figure for a business with seasonal monthly targets.
 */
export function prorateYtdTarget(
  completedMonthsTargetSum: number | null | undefined,
  fmTargetCurrentMonth: number | null | undefined,
  anchor: Date,
): number | null {
  if (
    (completedMonthsTargetSum === null || completedMonthsTargetSum === undefined) &&
    (fmTargetCurrentMonth === null || fmTargetCurrentMonth === undefined)
  ) {
    return null;
  }
  const completed = completedMonthsTargetSum ?? 0;
  const currentProrated = prorateMtdTarget(fmTargetCurrentMonth, anchor) ?? 0;
  return completed + currentProrated;
}
