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
 * Dates: RatingDateKey = the rating's local (Africa/Tripoli) date; every rating visual filters on it.
 * Filters: the global filters (company, customer group, channel, branch, salesperson, customer) through
 * buildWhereClause -- the same effective (admin-override aware) segment / branch / channel as the sales pages -- after
 * resolveScopedFilters applied the role's data scope and the salesperson lock. Parameterised SQL only.
 */
import type { Pool } from 'mysql2/promise';
import { buildWhereClause, type Filters, type UserContext } from './filters';
import { fetchDepartmentFreshness, type DepartmentFreshness } from './departmentFreshness';
import { CSAT_SCALE, NPS_SCALE, csatBand, minResponders, npsBand, type Band, type BandScale } from '../config/npsThresholds';

export const MAX_PAGE_SIZE = 500;
export type NpsGrain = 'day' | 'month' | 'year';
export const NPS_GRAINS: readonly NpsGrain[] = ['day', 'month', 'year'];
/** A daily trend longer than this is refused (400): choose monthly or yearly. */
export const MAX_DAILY_POINTS = 731;

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

/** Every period key of the range at a grain: yyyymmdd / yyyymm / yyyy. */
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
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    out.push(dateKeyOf(d.toISOString().slice(0, 10)));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** "20261005" -> "2026-10-05", "202610" -> "2026-10", "2026" -> "2026". */
export function periodLabel(key: number): string {
  const s = String(key);
  if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (s.length === 6) return `${s.slice(0, 4)}-${s.slice(4, 6)}`;
  return s;
}

const GRAIN_EXPR: Record<NpsGrain, string> = {
  day: 'f.RatingDateKey',
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
  target: number;
  minResponders: number;
  points: ({ period: string } & NpsCounts)[];
}

/** NPS per day / month / year for the active filters (from the response view -- v_process_nps_trend is per company only). */
export async function fetchNpsTrend(pool: Pool, q: NpsQuery, f: Filters): Promise<NpsTrend> {
  const periods = periodsBetween(q.dateFrom, q.dateTo, q.grain);
  if (q.grain === 'day' && periods.length > MAX_DAILY_POINTS) {
    throw new NpsQueryError(`A daily trend covers at most ${MAX_DAILY_POINTS} days: choose Monthly or Yearly`);
  }
  const w = npsWhere(q, f);
  const expr = GRAIN_EXPR[q.grain];
  const [rows] = await pool.query(`SELECT ${expr} AS p, ${COUNT_COLUMNS} FROM v_process_nps_response f WHERE ${w.sql} GROUP BY ${expr}`, w.params);
  const byPeriod = new Map((rows as Record<string, unknown>[]).map((r) => [Number(r.p), r]));
  const min = minResponders();
  return {
    grain: q.grain,
    target: NPS_SCALE.target,
    minResponders: min,
    points: periods.map((p) => ({ period: periodLabel(p), ...toCounts(byPeriod.get(p), min) })),
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
  /** the follow-up (section 5): no source yet -> null */
  status: string | null;
  reason: string | null;
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

/** The detractor list (with the customers' comments): only for roles with the nps_comments permission (the route checks it). */
export async function fetchNpsDetractors(pool: Pool, q: NpsQuery, f: Filters): Promise<Paged<NpsDetractor>> {
  const w = npsWhere(q, f);
  const [count] = await pool.query(`SELECT COUNT(*) AS n FROM v_process_nps_response f WHERE f.nps_level = 1 AND ${w.sql}`, w.params);
  const [rows] = await pool.query(
    `SELECT f.response_id, f.rated_at_local, f.rating_date, f.company, f.CustomerKey, f.customer, f.order_ref, f.delivery_code,
            f.sales_team, f.salesperson, f.team_branch,
            (SELECT GROUP_CONCAT(c.comment_text ORDER BY c.commented_at_utc SEPARATOR '\\n')
               FROM fact_process_nps_comment c WHERE c.response_id = f.response_id) AS comment
       FROM v_process_nps_response f WHERE f.nps_level = 1 AND ${w.sql}
      ORDER BY f.rated_at_local DESC, f.response_id DESC LIMIT ? OFFSET ?`,
    [...w.params, q.pageSize, (q.page - 1) * q.pageSize]);
  return {
    rows: (rows as Record<string, unknown>[]).map((r) => ({
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
      status: null,
      reason: null,
      comment: (r.comment as string) ?? null,
    })),
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
  thresholds: { nps: BandScale; csat: BandScale };
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
    thresholds: { nps: NPS_SCALE, csat: CSAT_SCALE },
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
