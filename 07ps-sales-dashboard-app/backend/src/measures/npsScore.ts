/**
 * NPS Score (Process department; routes/npsScore.ts). Reads ONLY the warehouse views of migration 0046 -- the backend
 * never connects to the NPS source (the ETL job process_nps loads it; docs/nps-etl.md).
 *
 * The formulas -- the ONE place they are defined (unit tests: measures/__tests__/npsScore.test.ts):
 *   a response is one delivery's rating; the customer answers with stars, shown on the standard NPS scale:
 *     *    أقل من المتوقع       nps_level 1   Detractor   (standard score 0-6)
 *     **   في مستوى التوقعات    nps_level 2   Passive     (7-8)
 *     ***  فاقت التوقعات        nps_level 3   Promoter    (9-10)
 *   responders = promoters + passives + detractors (ratings only: comments and blanks are never counted)
 *   NPS  = %promoters - %detractors, % = count / responders x 100, from the UNROUNDED percentages (round only for display)
 *   CSAT = (passives + promoters) / responders x 100
 * Always from the summed counts of the filtered set, never an average of row or group values. 0 responders = no value
 * (null, shown "—"); fewer than NPS_MIN_RESPONDERS (config/npsThresholds.ts) = the value is greyed with "n = x".
 *
 * Dates: RatingDateKey = the rating's local (Africa/Tripoli) date; every rating visual filters on it. The page's default
 * period is year-to-date (1 January -> today, Tripoli). Weeks are the business week, Sunday..Saturday, named by their
 * Sunday (lib/businessWeek.ts -- the Collections week).
 * Response rate = responders / (Delivered + Read) x 100: a customer can only answer a message that reached them. The
 * WhatsApp messages have no delivery / order / customer, so BOTH sides use the company and date filters only (ratings
 * by rating date, messages by message date, the same period, from NPS_REACH_START); the other filters are ignored for
 * it, never applied to one side only.
 * Follow-up: the detractor list and the follow-up charts read nps_followup_case LIVE (the follow-up page's edits show on
 * the next request; services/npsFollowupService.ts owns the time bands).
 * Filters: the global filters (company, customer group, channel, branch, salesperson, customer) through
 * buildWhereClause -- the same effective (admin-override aware) segment / branch / channel as the sales pages -- after
 * resolveScopedFilters applied the role's data scope and the salesperson lock. Parameterised SQL only.
 */
import type { Pool } from 'mysql2/promise';
import { buildWhereClause, type Filters, type UserContext } from './filters';
import { fetchDepartmentFreshness, type DepartmentFreshness } from './departmentFreshness';
import {
  CSAT_SCALE, NPS_SCALE, RESPONSE_RATE_SCALE, csatBand, minResponders, npsBand, responseRateBand, type Band, type BandScale,
} from '../config/npsThresholds';
import { addDaysIso, weekStartIso, weekStartSql } from '../lib/businessWeek';
import { odooConfiguredBaseUrl, odooFormUrl } from '../lib/odooLinks';
import { hoursOpen, nowLocal, timeBand, type FollowupStatus, type TimeBand } from '../services/npsFollowupService';

export const MAX_PAGE_SIZE = 500;
export type NpsGrain = 'week' | 'month' | 'year';
export const NPS_GRAINS: readonly NpsGrain[] = ['week', 'month', 'year'];
/** A weekly trend longer than this is refused (400): choose monthly or yearly. */
export const MAX_WEEKLY_POINTS = 400;

export class NpsQueryError extends Error {}

export interface NpsQuery {
  /** yyyy-mm-dd, inclusive (local dates). */
  dateFrom: string;
  dateTo: string;
  grain: NpsGrain;
  page: number;
  pageSize: number;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function isoDate(raw: unknown, name: string, fallback: string): string {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const s = String(Array.isArray(raw) ? raw[0] : raw);
  const d = new Date(`${s}T00:00:00Z`);
  if (!ISO.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new NpsQueryError(`${name} must be a date (yyyy-mm-dd)`);
  return s;
}

function positiveInt(raw: unknown, name: string, fallback: number, max: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new NpsQueryError(`${name} must be a whole number from 1 to ${max}`);
  return n;
}

/** Today in the business time zone (Africa/Tripoli), yyyy-mm-dd. */
export function todayLocal(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tripoli', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function parseNpsQuery(q: Record<string, unknown>, now: Date = new Date()): NpsQuery {
  const today = todayLocal(now);
  const dateTo = isoDate(q.dateTo, 'dateTo', today);
  const dateFrom = isoDate(q.dateFrom, 'dateFrom', `${dateTo.slice(0, 4)}-01-01`);
  if (dateFrom > dateTo) throw new NpsQueryError('dateFrom must not be after dateTo');
  const grain = (q.grain === undefined || q.grain === '' ? 'month' : String(q.grain)) as NpsGrain;
  if (!NPS_GRAINS.includes(grain)) throw new NpsQueryError(`grain must be one of ${NPS_GRAINS.join(', ')}`);
  return {
    dateFrom,
    dateTo,
    grain,
    page: positiveInt(q.page, 'page', 1, 100_000),
    pageSize: positiveInt(q.pageSize, 'pageSize', 100, MAX_PAGE_SIZE),
  };
}

export const dateKeyOf = (iso: string): number => Number(iso.replace(/-/g, ''));

// -- formulas ----------------------------------------------------------------------------------------------------------
/** %promoters - %detractors over the responders, UNROUNDED; null without responders. */
export function npsScore(promoters: number, passives: number, detractors: number): number | null {
  const responders = promoters + passives + detractors;
  if (responders <= 0) return null;
  return (promoters / responders) * 100 - (detractors / responders) * 100;
}

/** (passives + promoters) / responders x 100, UNROUNDED; null without responders. */
export function csatScore(promoters: number, passives: number, detractors: number): number | null {
  const responders = promoters + passives + detractors;
  if (responders <= 0) return null;
  return ((passives + promoters) / responders) * 100;
}

export interface NpsCounts {
  responders: number;
  promoters: number;
  passives: number;
  detractors: number;
  /** % of responders, 0..100, unrounded; null without responders */
  promotersPct: number | null;
  passivesPct: number | null;
  detractorsPct: number | null;
  nps: number | null;
  csat: number | null;
  npsBand: Band | null;
  csatBand: Band | null;
  /** fewer responders than the minimum: show the values greyed with "n = x" */
  belowMinimum: boolean;
}

/** Counts of a filtered set (MySQL SUM() arrives as strings) -> every figure the page shows. */
export function toCounts(row: { promoters?: unknown; passives?: unknown; detractors?: unknown } | undefined, min = minResponders()): NpsCounts {
  const promoters = Number(row?.promoters ?? 0);
  const passives = Number(row?.passives ?? 0);
  const detractors = Number(row?.detractors ?? 0);
  const responders = promoters + passives + detractors;
  const pct = (n: number) => (responders > 0 ? (n / responders) * 100 : null);
  const nps = npsScore(promoters, passives, detractors);
  const csat = csatScore(promoters, passives, detractors);
  return {
    responders, promoters, passives, detractors,
    promotersPct: pct(promoters), passivesPct: pct(passives), detractorsPct: pct(detractors),
    nps, csat, npsBand: npsBand(nps), csatBand: csatBand(csat),
    belowMinimum: responders > 0 && responders < min,
  };
}

// -- SQL -----------------------------------------------------------------------------------------------------------------
interface Sql {
  sql: string;
  params: Array<string | number>;
}

/** WHERE over v_process_nps_response alias f: the rating-date range and every scoped global filter. */
export function npsWhere(q: Pick<NpsQuery, 'dateFrom' | 'dateTo'>, f: Filters, alias = 'f'): Sql {
  const scoped = buildWhereClause(f, alias, true);
  return { sql: `${alias}.RatingDateKey BETWEEN ? AND ? AND ${scoped.clause}`, params: [dateKeyOf(q.dateFrom), dateKeyOf(q.dateTo), ...scoped.params] };
}

const COUNT_COLUMNS = 'SUM(f.nps_level = 3) AS promoters, SUM(f.nps_level = 2) AS passives, SUM(f.nps_level = 1) AS detractors';

/** Every period key of the range at a grain: yyyymmdd of the week's Sunday / yyyymm / yyyy. */
export function periodsBetween(from: string, to: string, grain: NpsGrain): number[] {
  const out: number[] = [];
  if (grain === 'year') {
    for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) out.push(y);
    return out;
  }
  if (grain === 'month') {
    let y = Number(from.slice(0, 4));
    let m = Number(from.slice(5, 7));
    const end = Number(to.slice(0, 4)) * 100 + Number(to.slice(5, 7));
    while (y * 100 + m <= end) {
      out.push(y * 100 + m);
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
    return out;
  }
  for (let w = weekStartIso(from); w <= to && out.length <= MAX_WEEKLY_POINTS; w = addDaysIso(w, 7)) out.push(dateKeyOf(w));
  return out;
}

/** "20261004" (a week's Sunday) -> "2026-10-04", "202610" -> "2026-10", "2026" -> "2026". */
export function periodLabel(key: number): string {
  const s = String(key);
  if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (s.length === 6) return `${s.slice(0, 4)}-${s.slice(4, 6)}`;
  return s;
}

const ratingDate = "STR_TO_DATE(CAST(f.RatingDateKey AS CHAR), '%Y%m%d')";
const GRAIN_EXPR: Record<NpsGrain, string> = {
  week: `CAST(DATE_FORMAT(${weekStartSql(ratingDate)}, '%Y%m%d') AS UNSIGNED)`,
  month: 'FLOOR(f.RatingDateKey / 100)',
  year: 'FLOOR(f.RatingDateKey / 10000)',
};

export interface NpsOverview {
  dateFrom: string;
  dateTo: string;
  totals: NpsCounts & { withComment: number };
  minResponders: number;
}

export async function fetchNpsOverview(pool: Pool, q: NpsQuery, f: Filters): Promise<NpsOverview> {
  const w = npsWhere(q, f);
  const [rows] = await pool.query(`SELECT ${COUNT_COLUMNS}, SUM(f.has_comment) AS with_comment FROM v_process_nps_response f WHERE ${w.sql}`, w.params);
  const total = (rows as Record<string, unknown>[])[0];
  const min = minResponders();
  return { dateFrom: q.dateFrom, dateTo: q.dateTo, totals: { ...toCounts(total, min), withComment: Number(total?.with_comment ?? 0) }, minResponders: min };
}

export interface NpsTrend {
  grain: NpsGrain;
  /** NPS target (the line at 90) */
  target: number;
  /** CSAT target (the line at 95) */
  csatTarget: number;
  minResponders: number;
  /** from the first period WITH ratings to the end of the range (no empty months before the first rating) */
  points: ({ period: string } & NpsCounts)[];
}

/**
 * NPS and CSAT per week (Sunday..Saturday, named by its Sunday) / month / year for the active filters (from the response
 * view -- v_process_nps_trend is per company only). A week cut by the range counts only the ratings inside the range,
 * so the bars always add up to the period's responders.
 */
export async function fetchNpsTrend(pool: Pool, q: NpsQuery, f: Filters): Promise<NpsTrend> {
  const periods = periodsBetween(q.dateFrom, q.dateTo, q.grain);
  if (q.grain === 'week' && periods.length > MAX_WEEKLY_POINTS) {
    throw new NpsQueryError(`A weekly trend covers at most ${MAX_WEEKLY_POINTS} weeks: choose Monthly or Yearly`);
  }
  const w = npsWhere(q, f);
  const expr = GRAIN_EXPR[q.grain];
  const [rows] = await pool.query(`SELECT ${expr} AS p, ${COUNT_COLUMNS} FROM v_process_nps_response f WHERE ${w.sql} GROUP BY ${expr}`, w.params);
  const byPeriod = new Map((rows as Record<string, unknown>[]).map((r) => [Number(r.p), r]));
  const min = minResponders();
  const first = periods.findIndex((p) => byPeriod.has(p));
  return {
    grain: q.grain,
    target: NPS_SCALE.target,
    csatTarget: CSAT_SCALE.target,
    minResponders: min,
    points: (first < 0 ? [] : periods.slice(first)).map((p) => ({ period: periodLabel(p), ...toCounts(byPeriod.get(p), min) })),
  };
}

export interface NpsDetractor {
  responseId: number;
  ratedAt: string | null;
  ratingDate: string | null;
  company: string | null;
  customerKey: number;
  customer: string | null;
  orderRef: string | null;
  deliveryCode: string | null;
  salesTeam: string | null;
  salesperson: string | null;
  teamBranch: string | null;
  /** the follow-up case, read live from nps_followup_case (null only while process_nps has not created it yet) */
  caseId: number | null;
  status: FollowupStatus | null;
  /** the reason in English / Arabic; null = not yet classified */
  reason: string | null;
  reasonAr: string | null;
  owner: string | null;
  /** hours from the rating to solved (Solved) or to now (open); null for Cancelled / Historical -- the follow-up's rule */
  hoursOpen: number | null;
  timeBand: TimeBand | null;
  /** Odoo form links (lib/odooLinks.ts): the sale order, the matched picking; null without an id or an Odoo URL setting */
  orderUrl: string | null;
  deliveryUrl: string | null;
  /** the customer's comments on that delivery (masked by the ETL), oldest first; null when none */
  comment: string | null;
}

const asDate = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};
const asDateTime = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  // local (Africa/Tripoli) wall-clock time as stored, "yyyy-mm-dd hh:mm:ss"; never shifted by the server's zone
  if (v instanceof Date) return v.toISOString().slice(0, 19).replace('T', ' ');
  return String(v).slice(0, 19);
};

export interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * The detractor list (with the customers' comments): only for roles with the nps_comments permission (the route checks
 * it). Status, reason, owner and time open come from the follow-up case at request time.
 */
export async function fetchNpsDetractors(pool: Pool, q: NpsQuery, f: Filters, now: string = nowLocal()): Promise<Paged<NpsDetractor>> {
  const w = npsWhere(q, f);
  const base = odooConfiguredBaseUrl();
  const [count] = await pool.query(`SELECT COUNT(*) AS n FROM v_process_nps_response f WHERE f.nps_level = 1 AND ${w.sql}`, w.params);
  const [rows] = await pool.query(
    `SELECT f.response_id, f.rated_at_local, f.rating_date, f.company, f.CompanyKey, f.CustomerKey, f.customer, f.order_ref,
            f.delivery_code, f.SalesOrderKey, f.PickingID, f.sales_team, f.salesperson, f.team_branch,
            fc.case_id, fc.status, fc.rated_at_local AS case_rated_at, fc.solved_at,
            r.name_en AS reason_en, r.name_ar AS reason_ar, COALESCE(fc.owner_name, o.display_name) AS owner_name,
            (SELECT GROUP_CONCAT(c.comment_text ORDER BY c.commented_at_utc SEPARATOR '\\n')
               FROM fact_process_nps_comment c WHERE c.response_id = f.response_id) AS comment
       FROM v_process_nps_response f
       LEFT JOIN nps_followup_case fc ON fc.response_id = f.response_id
       LEFT JOIN nps_followup_reason r ON r.reason_id = fc.reason_id
       LEFT JOIN app_user o ON o.user_id = fc.owner_user_id
      WHERE f.nps_level = 1 AND ${w.sql}
      ORDER BY f.rated_at_local DESC, f.response_id DESC LIMIT ? OFFSET ?`,
    [...w.params, q.pageSize, (q.page - 1) * q.pageSize]);
  return {
    rows: (rows as Record<string, unknown>[]).map((r) => {
      const status = (r.status as FollowupStatus | null) ?? null;
      const hours = status
        ? hoursOpen({ status, ratedAt: asDateTime(r.case_rated_at ?? r.rated_at_local), solvedAt: asDateTime(r.solved_at) }, now)
        : null;
      const companyKey = num(r.CompanyKey);
      return {
        responseId: Number(r.response_id),
        ratedAt: asDateTime(r.rated_at_local),
        ratingDate: asDate(r.rating_date),
        company: (r.company as string) ?? null,
        customerKey: Number(r.CustomerKey),
        customer: (r.customer as string) ?? null,
        orderRef: (r.order_ref as string) ?? null,
        deliveryCode: (r.delivery_code as string) ?? null,
        salesTeam: (r.sales_team as string) ?? null,
        salesperson: (r.salesperson as string) ?? null,
        teamBranch: (r.team_branch as string) ?? null,
        caseId: num(r.case_id),
        status,
        reason: (r.reason_en as string) ?? null,
        reasonAr: (r.reason_ar as string) ?? null,
        owner: (r.owner_name as string) ?? null,
        hoursOpen: hours === null ? null : Math.round(hours * 10) / 10,
        timeBand: timeBand(hours),
        orderUrl: odooFormUrl(base, 'sale.order', num(r.SalesOrderKey), companyKey),
        deliveryUrl: odooFormUrl(base, 'stock.picking', num(r.PickingID), companyKey),
        comment: (r.comment as string) ?? null,
      };
    }),
    total: Number((count as Record<string, unknown>[])[0]?.n ?? 0),
    page: q.page,
    pageSize: q.pageSize,
  };
}

export interface NpsMeta {
  /** the three groups: the labels of dim_process_nps_level (migration 0047), the stars and the source answer */
  levels: { level: number; key: string; labelEn: string; labelAr: string; sourceText: string; stars: number }[];
  firstRatingDate: string | null;
  lastRatingDate: string | null;
  lastRatingAt: string | null;
  /** the source's own sync bookkeeping (sync_state); null when the source has none */
  sourceLastSync: string | null;
  minResponders: number;
  /** config/npsThresholds.ts, so the page never keeps its own copy */
  thresholds: { nps: BandScale; csat: BandScale; responseRate: BandScale };
  canSeeDetractors: boolean;
  freshness: DepartmentFreshness;
}

export async function fetchNpsMeta(pool: Pool, canSeeDetractors: boolean): Promise<NpsMeta> {
  const [levels] = await pool.query('SELECT nps_level, level_key, label_en, label_ar, source_text FROM dim_process_nps_level ORDER BY nps_level DESC');
  const [range] = await pool.query(
    'SELECT MIN(rating_date) AS first_date, MAX(rating_date) AS last_date, MAX(rated_at_local) AS last_at FROM v_process_nps_response');
  const [sync] = await pool.query('SELECT MAX(last_successful_sync) AS at FROM raw_nps_sync_state');
  const r = (range as Record<string, unknown>[])[0];
  return {
    levels: (levels as Record<string, unknown>[]).map((l) => ({
      level: Number(l.nps_level), key: String(l.level_key), labelEn: String(l.label_en), labelAr: String(l.label_ar),
      sourceText: String(l.source_text), stars: Number(l.nps_level),
    })),
    firstRatingDate: asDate(r?.first_date),
    lastRatingDate: asDate(r?.last_date),
    lastRatingAt: asDateTime(r?.last_at),
    sourceLastSync: asDateTime((sync as Record<string, unknown>[])[0]?.at),
    minResponders: minResponders(),
    thresholds: { nps: NPS_SCALE, csat: CSAT_SCALE, responseRate: RESPONSE_RATE_SCALE },
    canSeeDetractors,
    freshness: await fetchDepartmentFreshness(pool, 'process'),
  };
}

// Message reach has no customer/order/salesperson link. User-selected filters may be ignored with a label;
// mandatory role restrictions may never be dropped to produce broader company totals.
const REACH_UNSUPPORTED = ['segmentKeys', 'channelKeys', 'salesTeamKeys', 'salespersonKeys', 'customerKeys'] as const;

export interface NpsReach {
  status: 'waiting' | 'restricted' | 'ready';
  dateFrom: string;
  dateTo: string;
  companyAndDateOnly: boolean;
  loadedAt: string | null;
  /** NPS_REACH_START of the last load (the ETL's setting; no earlier message is counted), null = all history */
  reachStart: string | null;
  totals: { totalReach: number; delivered: number; notDelivered: number; read: number; error: number; otherState: number } | null;
  errors: { key: string; label: string; fixable: boolean; hint: string; count: number }[];
}

export async function fetchNpsReach(pool: Pool, q: NpsQuery, f: Filters, user: UserContext): Promise<NpsReach> {
  const base: NpsReach = {
    status: 'waiting', dateFrom: q.dateFrom, dateTo: q.dateTo,
    companyAndDateOnly: REACH_UNSUPPORTED.some((key) => (f[key]?.length ?? 0) > 0),
    loadedAt: null, reachStart: null, totals: null, errors: [],
  };
  if (user.roleCode === 'SALESPERSON' || user.dataScopeRules?.some((r) => r.dimension !== 'companyKeys')) {
    return { ...base, status: 'restricted' };
  }
  const [stateRows] = await pool.query('SELECT loaded_at_utc, reach_start FROM process_nps_reach_state WHERE singleton_id = 1');
  const state = (stateRows as Record<string, unknown>[])[0];
  if (!state) return base;

  const company = f.companyKeys ?? [];
  const where = `f.MessageDateKey BETWEEN ? AND ?${company.length ? ` AND f.CompanyKey IN (${company.map(() => '?').join(', ')})` : ''}`;
  const params = [dateKeyOf(q.dateFrom), dateKeyOf(q.dateTo), ...company];
  const [rows] = await pool.query(
    `SELECT SUM(f.total_reach) AS total_reach, SUM(f.delivered) AS delivered,
            SUM(f.not_delivered) AS not_delivered, SUM(f.read_count) AS read_count,
            SUM(f.error_count) AS error_count, SUM(f.other_state) AS other_state
       FROM v_process_nps_reach f WHERE ${where}`, params);
  const [errors] = await pool.query(
    `SELECT f.failure_group, f.label_en, f.is_fixable, f.hint, SUM(f.errors) AS errors
       FROM v_process_nps_message_error f WHERE ${where}
      GROUP BY f.failure_group, f.label_en, f.is_fixable, f.hint, f.sort_order ORDER BY f.sort_order`, params);
  const r = (rows as Record<string, unknown>[])[0];
  return {
    ...base, status: 'ready', loadedAt: asDateTime(state.loaded_at_utc), reachStart: asDate(state.reach_start),
    totals: {
      totalReach: Number(r?.total_reach ?? 0), delivered: Number(r?.delivered ?? 0),
      notDelivered: Number(r?.not_delivered ?? 0), read: Number(r?.read_count ?? 0),
      error: Number(r?.error_count ?? 0), otherState: Number(r?.other_state ?? 0),
    },
    errors: (errors as Record<string, unknown>[]).map((r) => ({
      key: String(r.failure_group), label: String(r.label_en), fixable: Number(r.is_fixable) === 1,
      hint: String(r.hint), count: Number(r.errors),
    })),
  };
}

// -- follow-up (live) --------------------------------------------------------------------------------------------------
export type FollowupBucket = 'solved_48h' | 'solved_5d' | 'solved_late' | 'pending';

export interface NpsFollowupSummary {
  dateFrom: string;
  dateTo: string;
  /** detractor ratings of the filters = the Detractors box = the detractor list */
  detractors: number;
  /** followed-up cases charted (not Historical, not Cancelled) */
  charted: number;
  /** left out of both charts, shown under them */
  cancelled: number;
  historical: number;
  /** detractors without a case yet (process_nps creates them on its next run); 0 normally */
  noCase: number;
  /** Solved in < 48 h (green), 48 h .. 5 days (yellow), > 5 days (red); Pending = New / Contacted / In progress (black) */
  byStatus: { key: FollowupBucket; count: number }[];
  /** reasonId null = "Not yet classified" */
  byReason: { reasonId: number | null; label: string; labelAr: string | null; count: number }[];
  now: string;
}

const BUCKET_OF_BAND: Record<TimeBand, FollowupBucket> = { green: 'solved_48h', yellow: 'solved_5d', red: 'solved_late' };
export const NOT_CLASSIFIED = 'Not yet classified';

/**
 * Detractors by status and by reason, from nps_followup_case at request time (an edit on the follow-up page shows on
 * the next load), for the same detractors as the Detractors box: rating date, global filters, role scope. Historical
 * (rated before NPS_FOLLOWUP_START) and Cancelled cases are left out of both charts and counted separately.
 */
export async function fetchNpsFollowupSummary(pool: Pool, q: NpsQuery, f: Filters, now: string = nowLocal()): Promise<NpsFollowupSummary> {
  const w = npsWhere(q, f);
  const [rows] = await pool.query(
    `SELECT fc.case_id, fc.status, fc.rated_at_local, fc.solved_at, fc.reason_id, r.name_en, r.name_ar, r.sort_order
       FROM v_process_nps_response f
       LEFT JOIN nps_followup_case fc ON fc.response_id = f.response_id
       LEFT JOIN nps_followup_reason r ON r.reason_id = fc.reason_id
      WHERE f.nps_level = 1 AND ${w.sql}`, w.params);
  const list = rows as Record<string, unknown>[];
  const buckets: Record<FollowupBucket, number> = { solved_48h: 0, solved_5d: 0, solved_late: 0, pending: 0 };
  const reasons = new Map<number | null, { reasonId: number | null; label: string; labelAr: string | null; count: number; sort: number }>();
  let cancelled = 0;
  let historical = 0;
  let noCase = 0;
  for (const r of list) {
    const status = (r.status as FollowupStatus | null) ?? null;
    if (status === null) noCase += 1;
    else if (status === 'CANCELLED') cancelled += 1;
    else if (status === 'HISTORICAL') historical += 1;
    else {
      if (status === 'SOLVED') {
        const band = timeBand(hoursOpen({ status, ratedAt: asDateTime(r.rated_at_local), solvedAt: asDateTime(r.solved_at) }, now));
        buckets[band ? BUCKET_OF_BAND[band] : 'solved_late'] += 1;
      } else buckets.pending += 1;
      const id = num(r.reason_id);
      const entry = reasons.get(id) ?? {
        reasonId: id,
        label: id === null ? NOT_CLASSIFIED : String(r.name_en),
        labelAr: id === null ? null : ((r.name_ar as string) ?? null),
        count: 0,
        sort: id === null ? Number.MAX_SAFE_INTEGER : Number(r.sort_order ?? 0),
      };
      entry.count += 1;
      reasons.set(id, entry);
    }
  }
  const charted = buckets.solved_48h + buckets.solved_5d + buckets.solved_late + buckets.pending;
  return {
    dateFrom: q.dateFrom,
    dateTo: q.dateTo,
    detractors: list.length,
    charted,
    cancelled,
    historical,
    noCase,
    byStatus: (Object.keys(buckets) as FollowupBucket[]).map((key) => ({ key, count: buckets[key] })),
    byReason: [...reasons.values()]
      .sort((a, b) => b.count - a.count || a.sort - b.sort || a.label.localeCompare(b.label))
      .map(({ reasonId, label, labelAr, count }) => ({ reasonId, label, labelAr, count })),
    now,
  };
}

// -- response rate ------------------------------------------------------------------------------------------------------
export interface NpsResponseRate {
  status: 'waiting' | 'restricted' | 'ready';
  /** the period counted: the page's range, starting no earlier than reachStart */
  dateFrom: string;
  dateTo: string;
  /** NPS_REACH_START of the last message load: before it there are no delivered / read messages */
  reachStart: string | null;
  /** a team / salesperson / segment / customer filter is set and was ignored for this card */
  companyAndDateOnly: boolean;
  responders: number;
  delivered: number;
  read: number;
  /** Delivered + Read: the messages that reached the customer (the denominator) */
  reached: number;
  totalReach: number;
  /** responders / reached x 100, unrounded; null when nothing reached anyone */
  rate: number | null;
  /** responders / Total Reach x 100 (the tooltip's second view) */
  rateOfReach: number | null;
  band: Band | null;
  target: number;
  /** rate - target, in points */
  variancePts: number | null;
  /** per business week (Sunday..Saturday) of the period, for the sparkline */
  weekly: { weekStart: string; responders: number; reached: number; rate: number | null }[];
}

/** n / d x 100, unrounded; null when d is 0. */
export const ratePct = (n: number, d: number): number | null => (d > 0 ? (n / d) * 100 : null);

/**
 * Response rate: ratings (rating date) / messages that reached the customer (message date), company and date only, over
 * the same period from NPS_REACH_START. The same role restriction as the reach panel: a scope on anything but the
 * company can't be applied to messages, so those roles get no figure (never filtered ratings over unfiltered messages).
 */
export async function fetchNpsResponseRate(pool: Pool, q: NpsQuery, f: Filters, user: UserContext): Promise<NpsResponseRate> {
  const empty: NpsResponseRate = {
    status: 'waiting', dateFrom: q.dateFrom, dateTo: q.dateTo, reachStart: null,
    companyAndDateOnly: REACH_UNSUPPORTED.some((key) => (f[key]?.length ?? 0) > 0),
    responders: 0, delivered: 0, read: 0, reached: 0, totalReach: 0, rate: null, rateOfReach: null, band: null,
    target: RESPONSE_RATE_SCALE.target, variancePts: null, weekly: [],
  };
  if (user.roleCode === 'SALESPERSON' || user.dataScopeRules?.some((r) => r.dimension !== 'companyKeys')) return { ...empty, status: 'restricted' };
  const [stateRows] = await pool.query('SELECT reach_start FROM process_nps_reach_state WHERE singleton_id = 1');
  const state = (stateRows as Record<string, unknown>[])[0];
  if (!state) return empty;
  const reachStart = asDate(state.reach_start);
  const dateFrom = reachStart && reachStart > q.dateFrom ? reachStart : q.dateFrom;
  const ready: NpsResponseRate = { ...empty, status: 'ready', reachStart, dateFrom };
  if (dateFrom > q.dateTo) return ready;

  const company = f.companyKeys ?? [];
  const inCompany = (alias: string) => (company.length ? ` AND ${alias}.CompanyKey IN (${company.map(() => '?').join(', ')})` : '');
  const range = [dateKeyOf(dateFrom), dateKeyOf(q.dateTo)];
  const messageDate = "STR_TO_DATE(CAST(m.MessageDateKey AS CHAR), '%Y%m%d')";
  const [ratingRows] = await pool.query(
    `SELECT DATE_FORMAT(${weekStartSql(ratingDate)}, '%Y-%m-%d') AS wk, COUNT(*) AS n
       FROM v_process_nps_response f WHERE f.RatingDateKey BETWEEN ? AND ?${inCompany('f')} GROUP BY wk`, [...range, ...company]);
  const [messageRows] = await pool.query(
    `SELECT DATE_FORMAT(${weekStartSql(messageDate)}, '%Y-%m-%d') AS wk, SUM(m.delivered) AS delivered,
            SUM(m.read_count) AS read_count, SUM(m.total_reach) AS total_reach
       FROM v_process_nps_reach m WHERE m.MessageDateKey BETWEEN ? AND ?${inCompany('m')} GROUP BY wk`, [...range, ...company]);
  const ratings = new Map((ratingRows as Record<string, unknown>[]).map((r) => [String(r.wk), Number(r.n)]));
  const messages = new Map((messageRows as Record<string, unknown>[]).map((r) => [String(r.wk), r]));
  let responders = 0;
  let delivered = 0;
  let read = 0;
  let totalReach = 0;
  const weekly: NpsResponseRate['weekly'] = [];
  for (let wk = weekStartIso(dateFrom); wk <= q.dateTo; wk = addDaysIso(wk, 7)) {
    const n = ratings.get(wk) ?? 0;
    const m = messages.get(wk);
    const d = Number(m?.delivered ?? 0);
    const rd = Number(m?.read_count ?? 0);
    responders += n;
    delivered += d;
    read += rd;
    totalReach += Number(m?.total_reach ?? 0);
    weekly.push({ weekStart: wk, responders: n, reached: d + rd, rate: ratePct(n, d + rd) });
  }
  const reached = delivered + read;
  const rate = ratePct(responders, reached);
  return {
    ...ready, responders, delivered, read, reached, totalReach, rate, rateOfReach: ratePct(responders, totalReach),
    band: responseRateBand(rate), variancePts: rate === null ? null : rate - RESPONSE_RATE_SCALE.target, weekly,
  };
}
