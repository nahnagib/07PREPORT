/**
 * The message reach of the gap before NPS_REACH_START -- ONE calculation for the Message reach cards
 * (fetchNpsReach) and the Response Rate (fetchNpsResponseRate), so the cards and the rate can never disagree:
 * Delivered + Read of the cards = the rate's denominator.
 *
 * The WhatsApp source never kept successful (Delivered / Read) or still-"sent" (Not Delivered) messages before
 * NPS_REACH_START (03 Oct 2026); it did keep the failed ones (Error). Ratings exist from the first rating. Per company
 * (each from its OWN first rating; the selection = the sum of its companies):
 *
 *   basis weeks     the complete Saturday–Friday weeks from NPS_REACH_START to the day before the last message load,
 *                   minus NPS_REACH_ESTIMATE_EXCLUDE_WEEKS (the Meta outage weeks)
 *   per week        the company's Delivered + Read over the basis weeks / their number (recalculated per request), or
 *                   its share of NPS_REACH_ESTIMATE_PER_WEEK
 *   gap             [max(period start, first rating), min(period end, NPS_REACH_START - 1)]
 *   reached         round(per week x gap days / 7)
 *   Delivered       round(reached x the company's measured Delivered / (Delivered + Read) over the basis weeks)
 *   Read            reached - Delivered (so Delivered + Read = reached exactly)
 *   Not Delivered   round(reached x the company's measured Not Delivered / (Delivered + Read) over the basis weeks):
 *                   the source kept none before NPS_REACH_START (0 in every gap week), so it is estimated
 *   Error           the REAL failed messages of the gap (feedback template, not a test number), by failure group
 *   Total Reach     Delivered + Read + Not Delivered + Error (no other states in the gap)
 *
 * Never derived from responders or from the rate. Outside the gap nothing is estimated.
 */
import { DateTime } from 'luxon';
import type { Pool } from 'mysql2/promise';
import type { ReachEstimateConfig } from '../config/npsReachEstimate';
import { addDaysIso, weekStartIso } from '../lib/businessWeek';
import { getAppTimezone } from '../lib/timezone';

/** not_needed: the period has no part in the gap. applied: the gap is estimated. disabled: NPS_REACH_ESTIMATE_ENABLED
 *  false. no_basis: the period touches the gap but no complete measured week can be the basis yet (and no fixed value). */
export type ReachEstimateStatus = 'not_needed' | 'applied' | 'disabled' | 'no_basis';

export interface GapCounts {
  /** Delivered + Read */
  reached: number;
  delivered: number;
  read: number;
  notDelivered: number;
  /** real (kept by the source) */
  error: number;
  totalReach: number;
}

export interface GapCompanyEstimate extends GapCounts {
  companyKey: number;
  company: string;
  from: string;
  to: string;
  days: number;
  /** days / 7 */
  weeks: number;
  /** Delivered + Read per week */
  perWeek: number;
}

export interface GapEstimate {
  status: ReachEstimateStatus;
  /** the earliest company gap start .. the latest end (null unless applied) */
  from: string | null;
  to: string | null;
  basis: 'auto' | 'fixed';
  /** the Saturdays of the weeks the automatic basis averages */
  basisWeeks: string[];
  /** complete measured weeks left out (NPS_REACH_ESTIMATE_EXCLUDE_WEEKS) */
  excludedWeeks: string[];
  byCompany: GapCompanyEstimate[];
  /** the sum of the companies */
  totals: GapCounts;
  /** the gap's real errors by failure group (they sum to totals.error) */
  errorsByGroup: { key: string; count: number }[];
  /** ratings in the companies' gaps (the Response Rate numerator adds them) */
  responders: number;
}

const ZERO: GapCounts = { reached: 0, delivered: 0, read: 0, notDelivered: 0, error: 0, totalReach: 0 };

const key = (iso: string): number => Number(iso.replace(/-/g, ''));
const isoOfKey = (k: unknown): string | null =>
  (k === null || k === undefined ? null : String(k).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'));
const daysBetweenIso = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);

/**
 * The part of the selected period with ratings but no kept messages: [max(dateFrom, firstRating), min(dateTo,
 * reachStart - 1)], inclusive. null when empty (period after the reach start, or before the first rating).
 */
export function reachGap(dateFrom: string, dateTo: string, firstRating: string | null, reachStart: string | null): { from: string; to: string; days: number } | null {
  if (!firstRating || !reachStart) return null;
  const from = dateFrom > firstRating ? dateFrom : firstRating;
  const dayBefore = addDaysIso(reachStart, -1);
  const to = dateTo < dayBefore ? dateTo : dayBefore;
  return from > to ? null : { from, to, days: daysBetweenIso(from, to) + 1 };
}

/**
 * The complete business weeks (Saturday..Friday, named by their Saturday) from reachStart to the day before the last
 * message load (the load day itself is partial). A week that starts before reachStart is never complete.
 */
export function completeMeasuredWeeks(reachStart: string, loadedLocalDate: string): string[] {
  let sat = weekStartIso(reachStart);
  if (sat < reachStart) sat = addDaysIso(sat, 7);
  const lastFullDay = addDaysIso(loadedLocalDate, -1);
  const out: string[] = [];
  for (; addDaysIso(sat, 6) <= lastFullDay; sat = addDaysIso(sat, 7)) out.push(sat);
  return out;
}

/** The Tripoli date of process_nps_reach_state.loaded_at_utc ("yyyy-mm-dd hh:mm:ss" UTC); null without a load. */
export function loadedLocalDate(loadedAtUtc: string | null): string | null {
  if (!loadedAtUtc) return null;
  const d = DateTime.fromSQL(loadedAtUtc, { zone: 'utc' });
  return d.isValid ? d.setZone(getAppTimezone()).toISODate() : null;
}

/** One company's gap counts from its reached, mix and Not Delivered ratio, and its real errors. */
export function splitGap(reached: number, deliveredShare: number, notDeliveredPerReached: number, error: number): GapCounts {
  const delivered = Math.round(reached * deliveredShare);
  const notDelivered = Math.round(reached * notDeliveredPerReached);
  return { reached, delivered, read: reached - delivered, notDelivered, error, totalReach: reached + notDelivered + error };
}

const sumCounts = (rows: GapCounts[]): GapCounts => rows.reduce((t, r) => ({
  reached: t.reached + r.reached, delivered: t.delivered + r.delivered, read: t.read + r.read,
  notDelivered: t.notDelivered + r.notDelivered, error: t.error + r.error, totalReach: t.totalReach + r.totalReach,
}), { ...ZERO });

/**
 * The gap estimate for a period and the selected companies (empty = every company with ratings). `reachStart` and
 * `loadedAtUtc` come from process_nps_reach_state (the caller already read it).
 */
export async function estimateGapReach(
  pool: Pool, period: { dateFrom: string; dateTo: string }, companyKeys: number[], reachStart: string | null,
  loadedAtUtc: string | null, cfg: ReachEstimateConfig,
): Promise<GapEstimate> {
  const none = (status: ReachEstimateStatus): GapEstimate => ({
    status, from: null, to: null, basis: cfg.fixedPerWeek !== null ? 'fixed' : 'auto', basisWeeks: [], excludedWeeks: [],
    byCompany: [], totals: { ...ZERO }, errorsByGroup: [], responders: 0,
  });
  if (!cfg.enabled) return none('disabled');
  if (!reachStart) return none('not_needed');

  // 1. each company's own gap, from its own first rating
  const inCompany = (alias: string) => (companyKeys.length ? ` AND ${alias}.CompanyKey IN (${companyKeys.map(() => '?').join(', ')})` : '');
  const [firstRows] = await pool.query(
    `SELECT f.CompanyKey AS company_key, MIN(f.RatingDateKey) AS first_key, MAX(f.company) AS company
       FROM v_process_nps_response f WHERE 1 = 1${inCompany('f')} GROUP BY f.CompanyKey`, companyKeys);
  const gaps = (firstRows as Record<string, unknown>[])
    .map((r) => ({ companyKey: Number(r.company_key), company: String(r.company ?? r.company_key), gap: reachGap(period.dateFrom, period.dateTo, isoOfKey(r.first_key), reachStart) }))
    .filter((g): g is { companyKey: number; company: string; gap: { from: string; to: string; days: number } } => g.gap !== null)
    .sort((a, b) => a.companyKey - b.companyKey);
  if (gaps.length === 0) return none('not_needed');

  // 2. the basis: complete measured weeks minus the excluded ones, per company (messages only -- never ratings)
  const loadedLocal = loadedLocalDate(loadedAtUtc);
  const complete = loadedLocal ? completeMeasuredWeeks(reachStart, loadedLocal) : [];
  const excluded = complete.filter((w) => cfg.excludeWeeks.includes(w));
  const basisWeeks = complete.filter((w) => !cfg.excludeWeeks.includes(w));
  const keys = gaps.map((g) => g.companyKey);
  const inGaps = ` AND m.CompanyKey IN (${keys.map(() => '?').join(', ')})`;
  type Mix = { reached: number; delivered: number; notDelivered: number };
  const mix = new Map<number, Mix>(keys.map((k) => [k, { reached: 0, delivered: 0, notDelivered: 0 }]));
  const mixWeeks = basisWeeks.length ? basisWeeks : complete; // a fixed value still needs a mix; never empty when auto
  if (mixWeeks.length) {
    const ranges = mixWeeks.map(() => '(m.MessageDateKey BETWEEN ? AND ?)').join(' OR ');
    const [mixRows] = await pool.query(
      `SELECT m.CompanyKey AS company_key, SUM(m.delivered) AS delivered, SUM(m.read_count) AS read_count, SUM(m.not_delivered) AS not_delivered
         FROM v_process_nps_reach m WHERE (${ranges})${inGaps} GROUP BY m.CompanyKey`,
      [...mixWeeks.flatMap((w) => [key(w), key(addDaysIso(w, 6))]), ...keys]);
    for (const r of mixRows as Record<string, unknown>[]) {
      const d = Number(r.delivered ?? 0);
      mix.set(Number(r.company_key), { reached: d + Number(r.read_count ?? 0), delivered: d, notDelivered: Number(r.not_delivered ?? 0) });
    }
  }
  const basisTotal = [...mix.values()].reduce((n, m) => n + m.reached, 0);
  if (cfg.fixedPerWeek === null && (basisWeeks.length === 0 || basisTotal <= 0)) return none('no_basis');

  // 3. the gap's REAL errors (the source kept failed messages), per company inside its own gap, by failure group
  const gapRanges = gaps.map(() => '(m.CompanyKey = ? AND m.MessageDateKey BETWEEN ? AND ?)').join(' OR ');
  const gapParams = gaps.flatMap((g) => [g.companyKey, key(g.gap.from), key(g.gap.to)]);
  const [errorRows] = await pool.query(
    `SELECT m.CompanyKey AS company_key, m.failure_group, COUNT(*) AS n FROM fact_process_nps_message m
      WHERE m.box = 'error' AND m.is_feedback_template = 1 AND m.is_test_number = 0 AND (${gapRanges})
      GROUP BY m.CompanyKey, m.failure_group`, gapParams);
  const errorsOf = new Map<number, number>();
  const groups = new Map<string, number>();
  for (const r of errorRows as Record<string, unknown>[]) {
    const n = Number(r.n ?? 0);
    errorsOf.set(Number(r.company_key), (errorsOf.get(Number(r.company_key)) ?? 0) + n);
    groups.set(String(r.failure_group), (groups.get(String(r.failure_group)) ?? 0) + n);
  }

  // 4. the gap's ratings (the Response Rate numerator adds them)
  const ratingRanges = gaps.map(() => '(f.CompanyKey = ? AND f.RatingDateKey BETWEEN ? AND ?)').join(' OR ');
  const [ratingRows] = await pool.query(`SELECT COUNT(*) AS n FROM v_process_nps_response f WHERE ${ratingRanges}`, gapParams);
  const responders = Number((ratingRows as Record<string, unknown>[])[0]?.n ?? 0);

  // 5. per company: per week x gap weeks, split by the company's own measured mix
  const byCompany = gaps.map(({ companyKey, company, gap }) => {
    const m = mix.get(companyKey) ?? { reached: 0, delivered: 0, notDelivered: 0 };
    const perWeek = cfg.fixedPerWeek !== null
      ? cfg.fixedPerWeek * (basisTotal > 0 ? m.reached / basisTotal : 1 / gaps.length)
      : m.reached / basisWeeks.length;
    const reached = Math.round((perWeek * gap.days) / 7);
    const counts = splitGap(reached, m.reached > 0 ? m.delivered / m.reached : 0, m.reached > 0 ? m.notDelivered / m.reached : 0,
      errorsOf.get(companyKey) ?? 0);
    return { companyKey, company, from: gap.from, to: gap.to, days: gap.days, weeks: gap.days / 7, perWeek, ...counts };
  });
  return {
    status: 'applied',
    from: byCompany.reduce((a, c) => (c.from < a ? c.from : a), byCompany[0].from),
    to: byCompany.reduce((a, c) => (c.to > a ? c.to : a), byCompany[0].to),
    basis: cfg.fixedPerWeek !== null ? 'fixed' : 'auto',
    basisWeeks: cfg.fixedPerWeek !== null ? [] : basisWeeks,
    excludedWeeks: excluded,
    byCompany,
    totals: sumCounts(byCompany),
    errorsByGroup: [...groups.entries()].map(([k, count]) => ({ key: k, count })).sort((a, b) => b.count - a.count),
    responders,
  };
}
