import { addDaysIso, weekStartIso, weekStartSql } from './businessWeek';
import { getAppTimezone } from './timezone';

/**
 * The ONE period window of every time-trend visual (Daily / Weekly / Monthly / Yearly selector). Each granularity has a
 * fixed number of periods that always ends with the CURRENT period (partial, flagged inProgress):
 *   day   = the last 30 days incl. today
 *   week  = the last 12 business weeks (Saturday..Friday, lib/businessWeek.ts) incl. the current one
 *   month = the last 12 calendar months incl. the current one
 *   year  = the last 5 calendar years incl. the current one
 * The window runs from the first period's start to `today` (nothing after today exists yet). Bucketing is done in SQL with
 * periodBucketSql on the row's DATE, while the WHERE stays a plain range on the date column (periodRangeSql), so the
 * existing date indexes are still used. Periods without rows are filled by the caller (0 for counts and sums, null for
 * ratios): every trend always has exactly 30 / 12 / 12 / 5 points. Pure ISO-date arithmetic at UTC noon.
 */
export type PeriodGranularity = 'day' | 'week' | 'month' | 'year';
export const PERIOD_GRANULARITIES: readonly PeriodGranularity[] = ['day', 'week', 'month', 'year'];
export const DEFAULT_GRANULARITY: PeriodGranularity = 'week';
export const PERIOD_COUNT: Record<PeriodGranularity, number> = { day: 30, week: 12, month: 12, year: 5 };

export class PeriodQueryError extends Error {
  readonly status = 400;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const toDate = (iso: string) => new Date(`${iso}T12:00:00Z`);

/** Today (yyyy-mm-dd) in the business time zone (APP_TIMEZONE). */
export function businessToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: getAppTimezone(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** "today" of a page whose anchorDate is a yyyy-mm-dd query value (the page's own date, default today). */
export function anchorToday(anchor: Date): string {
  return anchor.toISOString().slice(0, 10);
}

/** Missing = the default (Weekly); anything else that is not a granularity is a 400. */
export function parseGranularity(raw: unknown): PeriodGranularity {
  if (raw === undefined || raw === '') return DEFAULT_GRANULARITY;
  if (typeof raw === 'string' && (PERIOD_GRANULARITIES as readonly string[]).includes(raw)) return raw as PeriodGranularity;
  throw new PeriodQueryError('granularity must be day, week, month or year');
}

function addMonthsIso(iso: string, n: number): string {
  const d = toDate(iso);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

/** First day of the period holding `iso`: the day, the Saturday of its week, the 1st of its month, 1 January. */
export function periodStartIso(iso: string, g: PeriodGranularity): string {
  if (g === 'day') return iso;
  if (g === 'week') return weekStartIso(iso);
  if (g === 'month') return `${iso.slice(0, 7)}-01`;
  return `${iso.slice(0, 4)}-01-01`;
}

/** The start of the period `n` periods after (negative = before) the one starting at `start`. */
export function shiftPeriod(start: string, g: PeriodGranularity, n: number): string {
  if (g === 'day') return addDaysIso(start, n);
  if (g === 'week') return addDaysIso(start, 7 * n);
  return addMonthsIso(start, g === 'month' ? n : 12 * n);
}

export function periodEndIso(start: string, g: PeriodGranularity): string {
  return addDaysIso(shiftPeriod(start, g, 1), -1);
}

export interface TrendPeriod {
  /** yyyy-mm-dd, the period's first day (its key) */
  start: string;
  /** yyyy-mm-dd, the period's last day (may be after today for the current period) */
  end: string;
  /** the current period: its data is still coming in (refreshed every 30 minutes) */
  inProgress: boolean;
}

export interface PeriodWindow {
  granularity: PeriodGranularity;
  /** the first period's start */
  from: string;
  /** today: the last day with data */
  to: string;
  periods: TrendPeriod[];
  /** the period just before the window, for the first point's period-over-period change */
  previous: { start: string; end: string };
}

/** The fixed window of `g` ending with the period holding `today` (yyyy-mm-dd, business time zone). */
export function periodWindow(g: PeriodGranularity, today: string): PeriodWindow {
  if (!ISO.test(today)) throw new PeriodQueryError('today must be YYYY-MM-DD');
  const current = periodStartIso(today, g);
  const n = PERIOD_COUNT[g];
  const periods: TrendPeriod[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const start = shiftPeriod(current, g, -i);
    periods.push({ start, end: periodEndIso(start, g), inProgress: i === 0 });
  }
  const prev = shiftPeriod(current, g, -n);
  return { granularity: g, from: periods[0].start, to: today, periods, previous: { start: prev, end: periodEndIso(prev, g) } };
}

/** SQL expression: the start ('yyyy-mm-dd' string) of the period holding the DATE expression `dateExpr`. Used in SELECT /
 * GROUP BY only -- filter with periodRangeSql so the date index still applies. */
export function periodBucketSql(g: PeriodGranularity, dateExpr: string): string {
  if (g === 'day') return `DATE_FORMAT(${dateExpr}, '%Y-%m-%d')`;
  if (g === 'week') return `DATE_FORMAT(${weekStartSql(dateExpr)}, '%Y-%m-%d')`;
  if (g === 'month') return `DATE_FORMAT(${dateExpr}, '%Y-%m-01')`;
  return `DATE_FORMAT(${dateExpr}, '%Y-01-01')`;
}

/** WHERE fragment + params: `column` from `from` through the whole day `to` (>= from AND < the day after to), a plain
 * range on the column, so its index still applies; right for DATE and DATETIME columns alike. */
export function periodRangeSql(column: string, from: string, to: string): { sql: string; params: string[] } {
  return { sql: `${column} >= ? AND ${column} < ?`, params: [from, addDaysIso(to, 1)] };
}

/** The same period one year earlier, for a "same period last year" series: 52 weeks (364 days, same weekdays) back for
 * day and week, one calendar year back for month and year. The SQL interval moves a row's date FORWARD onto this year's
 * axis; lastYearIso moves a window date back. */
export function lastYearInterval(g: PeriodGranularity): string {
  return g === 'day' || g === 'week' ? 'INTERVAL 364 DAY' : 'INTERVAL 1 YEAR';
}

export function lastYearIso(iso: string, g: PeriodGranularity): string {
  if (g === 'day' || g === 'week') return addDaysIso(iso, -364);
  const y = Number(iso.slice(0, 4)) - 1;
  const md = iso.slice(5);
  return md === '02-29' ? `${y}-02-28` : `${y}-${md}`;
}

/** One point per period of the window, in order: `make(period, row)` with the period's row (undefined = no data). */
// eslint-disable-next-line no-unused-vars -- the base rule (no TS plugin here) flags parameter names in a function type
export function fillPeriods<R, P>(w: PeriodWindow, rows: Map<string, R>, make: (period: TrendPeriod, row: R | undefined) => P): P[] {
  return w.periods.map((p) => make(p, rows.get(p.start)));
}

/** Rows keyed by their period start column (`p` by default), as returned by a periodBucketSql GROUP BY. */
export function byPeriod<R extends Record<string, unknown>>(rows: R[], key = 'p'): Map<string, R> {
  return new Map(rows.map((r) => [String(r[key]), r]));
}

/** (current - previous) / previous; null when either is missing or the previous is 0. */
export function changePct(current: number | null | undefined, previous: number | null | undefined): number | null {
  if (current === null || current === undefined || previous === null || previous === undefined || previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}
