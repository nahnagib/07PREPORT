import { DateTime } from 'luxon';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { ValidationError } from '../lib/errors';
import { getAppTimezone } from '../lib/timezone';
import { buildWhereClause, type Filters } from '../measures/filters';

/**
 * NPS Detractor Follow-up (Process department; routes/npsFollowup.ts; docs/nps-followup.md). Schema and rationale:
 * data/warehouse/migrations/0052_nps_detractor_followup.sql.
 *
 * Cases are CREATED only by the ETL (process_nps adds one per detractor; departments/process/followup.py); people edit
 * the manual fields here. The rating's facts (company, customer, order, salesperson, branch) are read live from
 * v_process_nps_response, so every query goes through the same scoped global filters as the NPS Score page
 * (buildWhereClause on alias f). A case whose rating left the source has no view row: it is shown only while no
 * global filter or role scope applies (the filter can't be checked, so it is never shown to a scoped user).
 *
 * Times: rated_at_local, contacted_at, solved_at are Africa/Tripoli wall-clock times ("yyyy-mm-dd hh:mm:ss"); the UTC
 * columns (updated_at, source_changed_at, the history's changed_at) are sent converted to Tripoli time too.
 * Time open = rating -> solved (Solved) or -> now (open statuses); none for Cancelled / Historical.
 *   < 48 h green, 48 h .. 5 days yellow, > 5 days red.
 * Every edit carries the version it was made on; an older version is refused (FollowupConflictError, 409). Each
 * changed field is one nps_followup_audit row, in the same transaction as the update.
 */

export const FOLLOWUP_STATUSES = ['HISTORICAL', 'NEW', 'CONTACTED', 'IN_PROGRESS', 'SOLVED', 'CANCELLED'] as const;
export type FollowupStatus = (typeof FOLLOWUP_STATUSES)[number];
/** What a person may set (HISTORICAL is only ever set by the ETL's cut-over). */
export const EDITABLE_STATUSES: readonly FollowupStatus[] = ['NEW', 'CONTACTED', 'IN_PROGRESS', 'SOLVED', 'CANCELLED'];
export const OPEN_STATUSES: readonly FollowupStatus[] = ['NEW', 'CONTACTED', 'IN_PROGRESS'];
/** The board shows Solved cases of the last 30 days only (the List view shows all). */
export const BOARD_SOLVED_DAYS = 30;
export const GREEN_HOURS = 48;
export const YELLOW_HOURS = 120;
export const MAX_TEXT = 2000;
const MAX_BOARD_CASES = 2000;
export const MAX_PAGE_SIZE = 500;

export type TimeBand = 'green' | 'yellow' | 'red';

export class FollowupValidationError extends ValidationError {
  code: string;
  field?: string;
  constructor(code: string, message: string, field?: string) {
    super(message);
    this.code = code;
    this.field = field;
  }
}

/** The case was changed by someone else since it was opened: carries the current case. */
export class FollowupConflictError extends Error {
  current: FollowupCase;
  constructor(current: FollowupCase) {
    super('This case was changed by someone else. Reload it to see their changes, then edit again.');
    this.current = current;
  }
}

export interface FollowupCase {
  caseId: number;
  responseId: number;
  ratedAt: string | null;
  status: FollowupStatus;
  reasonId: number | null;
  reasonEn: string | null;
  reasonAr: string | null;
  ownerUserId: number | null;
  ownerName: string | null;
  contactedAt: string | null;
  solvedAt: string | null;
  rootCause: string | null;
  actionTaken: string | null;
  notes: string | null;
  sourceChanged: boolean;
  sourceChangedAt: string | null;
  sourceChangeReason: string | null;
  version: number;
  updatedAt: string | null;
  updatedByName: string | null;
  // read-only, from the rating (null when the rating left the source)
  company: string | null;
  customer: string | null;
  orderRef: string | null;
  deliveryCode: string | null;
  salesTeam: string | null;
  salesperson: string | null;
  teamBranch: string | null;
  hasComment: boolean;
  /** hours from the rating to solved / now; null for Cancelled and Historical */
  hoursOpen: number | null;
  timeBand: TimeBand | null;
}

export interface FollowupHistoryRow {
  changedAt: string;
  changedBy: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

export interface FollowupDetail extends FollowupCase {
  /** the customer's comments on that delivery; null without View on nps_comments or when there are none */
  comment: string | null;
  history: FollowupHistoryRow[];
}

export interface FollowupQuery {
  dateFrom?: string;
  dateTo?: string;
  statuses: FollowupStatus[];
  reasonIds: number[];
  /** 0 = no owner yet */
  ownerIds: number[];
  sourceChanged?: boolean;
  search?: string;
  page: number;
  pageSize: number;
}

// -- time helpers --------------------------------------------------------------------------------------------------------

/** Now as a Tripoli wall-clock string "yyyy-mm-dd hh:mm:ss". */
export function nowLocal(now: Date = new Date()): string {
  return DateTime.fromJSDate(now).setZone(getAppTimezone()).toFormat('yyyy-MM-dd HH:mm:ss');
}

const wall = (s: string): number => Date.parse(`${s.replace(' ', 'T')}Z`);

export function hoursBetween(from: string, to: string): number {
  return (wall(to) - wall(from)) / 3_600_000;
}

export function timeBand(hours: number | null): TimeBand | null {
  if (hours === null) return null;
  if (hours < GREEN_HOURS) return 'green';
  if (hours <= YELLOW_HOURS) return 'yellow';
  return 'red';
}

export function hoursOpen(c: Pick<FollowupCase, 'status' | 'ratedAt' | 'solvedAt'>, now: string): number | null {
  if (!c.ratedAt || c.status === 'CANCELLED' || c.status === 'HISTORICAL') return null;
  const end = c.status === 'SOLVED' ? c.solvedAt : now;
  return end ? Math.max(0, hoursBetween(c.ratedAt, end)) : null;
}

function asWall(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  // DATETIME as stored (the pool reads it as UTC, so toISOString gives the wall-clock value back unchanged)
  if (v instanceof Date) return v.toISOString().slice(0, 19).replace('T', ' ');
  return String(v).slice(0, 19).replace('T', ' ');
}

/** A UTC DATETIME (updated_at, the history, source_changed_at) as Tripoli wall-clock time. */
export function utcToLocal(v: unknown): string | null {
  const s = asWall(v);
  return s ? DateTime.fromSQL(s, { zone: 'utc' }).setZone(getAppTimezone()).toFormat('yyyy-MM-dd HH:mm:ss') : null;
}

// -- query parsing ---------------------------------------------------------------------------------------------------------
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function listOf(value: unknown): string[] {
  return (Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value])
    .flatMap((v) => String(v).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
}

function intList(value: unknown, name: string, allowZero = false): number[] {
  return listOf(value).map((s) => {
    const n = Number(s);
    if (!Number.isInteger(n) || n < (allowZero ? 0 : 1)) throw new FollowupValidationError('query', `${name} must be whole numbers`);
    return n;
  });
}

function optionalDate(value: unknown, name: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  const s = String(value);
  if (!ISO.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw new FollowupValidationError('query', `${name} must be a date (yyyy-mm-dd)`);
  return s;
}

export function parseFollowupQuery(q: Record<string, unknown>): FollowupQuery {
  const statuses = listOf(q.statuses).map((s) => s.toUpperCase());
  for (const s of statuses) {
    if (!FOLLOWUP_STATUSES.includes(s as FollowupStatus)) throw new FollowupValidationError('query', `Unknown status ${s}`);
  }
  const page = q.page === undefined ? 1 : Number(q.page);
  const pageSize = q.pageSize === undefined ? 100 : Number(q.pageSize);
  if (!Number.isInteger(page) || page < 1) throw new FollowupValidationError('query', 'page must be a whole number from 1');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new FollowupValidationError('query', `pageSize must be a whole number from 1 to ${MAX_PAGE_SIZE}`);
  }
  const sc = q.sourceChanged === undefined || q.sourceChanged === '' ? undefined : q.sourceChanged === 'true' || q.sourceChanged === '1';
  return {
    dateFrom: optionalDate(q.dateFrom, 'dateFrom'),
    dateTo: optionalDate(q.dateTo, 'dateTo'),
    statuses: statuses as FollowupStatus[],
    reasonIds: intList(q.reasonIds, 'reasonIds'),
    ownerIds: intList(q.ownerIds, 'ownerIds', true),
    sourceChanged: sc,
    search: typeof q.search === 'string' && q.search.trim() ? q.search.trim().slice(0, 100) : undefined,
    page,
    pageSize,
  };
}

// -- SQL -------------------------------------------------------------------------------------------------------------------
const SELECT = `
  SELECT c.case_id, c.response_id, c.rated_at_local, c.status, c.reason_id, r.name_en AS reason_en, r.name_ar AS reason_ar,
         c.owner_user_id, o.display_name AS owner_name, c.contacted_at, c.solved_at, c.root_cause, c.action_taken, c.notes,
         c.source_changed, c.source_changed_at, c.source_change_reason, c.version, c.updated_at, u.display_name AS updated_by_name,
         f.company, f.customer, f.order_ref, f.delivery_code, f.sales_team, f.salesperson, f.team_branch, f.has_comment
    FROM nps_followup_case c
    LEFT JOIN v_process_nps_response f ON f.response_id = c.response_id
    LEFT JOIN nps_followup_reason r ON r.reason_id = c.reason_id
    LEFT JOIN app_user o ON o.user_id = c.owner_user_id
    LEFT JOIN app_user u ON u.user_id = c.updated_by`;

interface Where {
  sql: string;
  params: Array<string | number>;
}

/** The scoped global filters on the rating (alias f) plus the follow-up's own filters. */
export function followupWhere(q: Partial<FollowupQuery>, f: Filters): Where {
  const scoped = buildWhereClause(f, 'f', true);
  const parts = [scoped.clause];
  const params: Array<string | number> = [...scoped.params];
  if (q.dateFrom) {
    parts.push('c.rated_at_local >= ?');
    params.push(`${q.dateFrom} 00:00:00`);
  }
  if (q.dateTo) {
    parts.push('c.rated_at_local < DATE_ADD(?, INTERVAL 1 DAY)');
    params.push(q.dateTo);
  }
  if (q.statuses?.length) {
    parts.push(`c.status IN (${q.statuses.map(() => '?').join(', ')})`);
    params.push(...q.statuses);
  }
  if (q.reasonIds?.length) {
    parts.push(`c.reason_id IN (${q.reasonIds.map(() => '?').join(', ')})`);
    params.push(...q.reasonIds);
  }
  if (q.ownerIds?.length) {
    const ids = q.ownerIds.filter((n) => n > 0);
    const alts = [...(ids.length ? [`c.owner_user_id IN (${ids.map(() => '?').join(', ')})`] : []), ...(q.ownerIds.includes(0) ? ['c.owner_user_id IS NULL'] : [])];
    parts.push(`(${alts.join(' OR ')})`);
    params.push(...ids);
  }
  if (q.sourceChanged !== undefined) {
    parts.push('c.source_changed = ?');
    params.push(q.sourceChanged ? 1 : 0);
  }
  if (q.search) {
    parts.push('(f.customer LIKE ? OR f.order_ref LIKE ? OR f.delivery_code LIKE ? OR CAST(c.case_id AS CHAR) = ?)');
    const like = `%${q.search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    params.push(like, like, like, q.search.replace(/^#/, ''));
  }
  return { sql: parts.join(' AND '), params };
}

function toCase(r: Record<string, unknown>, now: string): FollowupCase {
  const base = {
    caseId: Number(r.case_id),
    responseId: Number(r.response_id),
    ratedAt: asWall(r.rated_at_local),
    status: r.status as FollowupStatus,
    reasonId: r.reason_id === null || r.reason_id === undefined ? null : Number(r.reason_id),
    reasonEn: (r.reason_en as string) ?? null,
    reasonAr: (r.reason_ar as string) ?? null,
    ownerUserId: r.owner_user_id === null || r.owner_user_id === undefined ? null : Number(r.owner_user_id),
    ownerName: (r.owner_name as string) ?? null,
    contactedAt: asWall(r.contacted_at),
    solvedAt: asWall(r.solved_at),
    rootCause: (r.root_cause as string) ?? null,
    actionTaken: (r.action_taken as string) ?? null,
    notes: (r.notes as string) ?? null,
    sourceChanged: Boolean(Number(r.source_changed)),
    sourceChangedAt: utcToLocal(r.source_changed_at),
    sourceChangeReason: (r.source_change_reason as string) ?? null,
    version: Number(r.version),
    updatedAt: utcToLocal(r.updated_at),
    updatedByName: (r.updated_by_name as string) ?? null,
    company: (r.company as string) ?? null,
    customer: (r.customer as string) ?? null,
    orderRef: (r.order_ref as string) ?? null,
    deliveryCode: (r.delivery_code as string) ?? null,
    salesTeam: (r.sales_team as string) ?? null,
    salesperson: (r.salesperson as string) ?? null,
    teamBranch: (r.team_branch as string) ?? null,
    hasComment: Boolean(Number(r.has_comment ?? 0)),
  };
  const hours = hoursOpen(base, now);
  return { ...base, hoursOpen: hours === null ? null : Math.round(hours * 10) / 10, timeBand: timeBand(hours) };
}

// -- reads -----------------------------------------------------------------------------------------------------------------

export interface FollowupBoard {
  cases: FollowupCase[];
  truncated: boolean;
  kpis: { open: number; openOver5Days: number; solved30Days: number; solvedWithin48h: number; noReason: number; cancelled: number };
  now: string;
}

/** The board: every non-Historical case matching the filters; Solved only when solved in the last 30 days. */
export async function fetchBoard(pool: Pool, q: FollowupQuery, f: Filters, now: string = nowLocal()): Promise<FollowupBoard> {
  const w = followupWhere({ ...q, statuses: q.statuses.filter((s) => s !== 'HISTORICAL') }, f);
  const solvedFrom = DateTime.fromISO(now.replace(' ', 'T'), { zone: 'utc' }).minus({ days: BOARD_SOLVED_DAYS }).toFormat('yyyy-MM-dd HH:mm:ss');
  const [rows] = await pool.query(
    `${SELECT} WHERE c.status <> 'HISTORICAL' AND (c.status <> 'SOLVED' OR c.solved_at >= ?) AND ${w.sql}
      ORDER BY c.rated_at_local ASC, c.case_id ASC LIMIT ?`,
    [solvedFrom, ...w.params, MAX_BOARD_CASES + 1]);
  const all = (rows as Record<string, unknown>[]).map((r) => toCase(r, now));
  const cases = all.slice(0, MAX_BOARD_CASES);
  const open = cases.filter((c) => OPEN_STATUSES.includes(c.status));
  const solved = cases.filter((c) => c.status === 'SOLVED');
  return {
    cases,
    truncated: all.length > MAX_BOARD_CASES,
    kpis: {
      open: open.length,
      openOver5Days: open.filter((c) => c.timeBand === 'red').length,
      solved30Days: solved.length,
      solvedWithin48h: solved.filter((c) => c.timeBand === 'green').length,
      noReason: cases.filter((c) => c.status !== 'CANCELLED' && c.reasonId === null).length,
      cancelled: cases.filter((c) => c.status === 'CANCELLED').length,
    },
    now,
  };
}

export interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

const LIST_ORDER = 'ORDER BY c.rated_at_local DESC, c.case_id DESC';

/** The List view: every case (Historical included), newest rating first. */
export async function fetchCases(pool: Pool, q: FollowupQuery, f: Filters, now: string = nowLocal()): Promise<Paged<FollowupCase>> {
  const w = followupWhere(q, f);
  const [count] = await pool.query(
    `SELECT COUNT(*) AS n FROM nps_followup_case c LEFT JOIN v_process_nps_response f ON f.response_id = c.response_id WHERE ${w.sql}`, w.params);
  const [rows] = await pool.query(`${SELECT} WHERE ${w.sql} ${LIST_ORDER} LIMIT ? OFFSET ?`, [...w.params, q.pageSize, (q.page - 1) * q.pageSize]);
  return {
    rows: (rows as Record<string, unknown>[]).map((r) => toCase(r, now)),
    total: Number((count as Record<string, unknown>[])[0]?.n ?? 0),
    page: q.page,
    pageSize: q.pageSize,
  };
}

/** Every matching case for the Excel export (no paging), with the comments when the caller may export them. */
export async function fetchCasesForExport(pool: Pool, q: FollowupQuery, f: Filters, withComments: boolean, now: string = nowLocal()) {
  const w = followupWhere(q, f);
  const commentCol = withComments
    ? `, (SELECT GROUP_CONCAT(m.comment_text ORDER BY m.commented_at_utc SEPARATOR '\\n') FROM fact_process_nps_comment m WHERE m.response_id = c.response_id) AS comment`
    : '';
  const [rows] = await pool.query(`${SELECT.replace('f.has_comment', `f.has_comment${commentCol}`)} WHERE ${w.sql} ${LIST_ORDER}`, w.params);
  return (rows as Record<string, unknown>[]).map((r) => ({ ...toCase(r, now), comment: withComments ? ((r.comment as string) ?? null) : null }));
}

async function findCase(db: Pool | PoolConnection, caseId: number, f: Filters, now: string, lock = false): Promise<FollowupCase | null> {
  const w = followupWhere({}, f);
  const [rows] = await db.query(`${SELECT} WHERE c.case_id = ? AND ${w.sql}${lock ? ' FOR UPDATE' : ''}`, [caseId, ...w.params]);
  const r = (rows as Record<string, unknown>[])[0];
  return r ? toCase(r, now) : null;
}

export async function fetchCase(pool: Pool, caseId: number, f: Filters, canSeeComments: boolean, now: string = nowLocal()): Promise<FollowupDetail | null> {
  const c = await findCase(pool, caseId, f, now);
  if (!c) return null;
  let comment: string | null = null;
  if (canSeeComments) {
    const [rows] = await pool.query(
      `SELECT GROUP_CONCAT(m.comment_text ORDER BY m.commented_at_utc SEPARATOR '\\n') AS comment FROM fact_process_nps_comment m WHERE m.response_id = ?`,
      [c.responseId]);
    comment = ((rows as Record<string, unknown>[])[0]?.comment as string) ?? null;
  }
  const [hist] = await pool.query(
    `SELECT a.changed_at, a.field, a.old_value, a.new_value, a.changed_by, u.display_name
       FROM nps_followup_audit a LEFT JOIN app_user u ON u.user_id = a.changed_by
      WHERE a.case_id = ? ORDER BY a.changed_at DESC, a.audit_id DESC`, [caseId]);
  return {
    ...c,
    comment,
    history: (hist as Record<string, unknown>[]).map((h) => ({
      changedAt: utcToLocal(h.changed_at) ?? '',
      changedBy: h.changed_by === null ? 'NPS refresh (process_nps)' : ((h.display_name as string) ?? `user #${h.changed_by}`),
      field: String(h.field),
      oldValue: (h.old_value as string) ?? null,
      newValue: (h.new_value as string) ?? null,
    })),
  };
}

export interface FollowupOptions {
  statuses: readonly FollowupStatus[];
  reasons: FollowupReason[];
  owners: { userId: number; name: string }[];
}

export async function fetchOptions(pool: Pool): Promise<FollowupOptions> {
  const [owners] = await pool.query("SELECT user_id, display_name FROM app_user WHERE is_active = 1 AND status <> 'INACTIVE' ORDER BY display_name");
  return {
    statuses: FOLLOWUP_STATUSES,
    reasons: await listReasons(pool),
    owners: (owners as Record<string, unknown>[]).map((o) => ({ userId: Number(o.user_id), name: String(o.display_name) })),
  };
}

// -- edit --------------------------------------------------------------------------------------------------------------------

export interface CaseInput {
  version?: unknown;
  status?: unknown;
  reasonId?: unknown;
  ownerUserId?: unknown;
  contactedAt?: unknown;
  solvedAt?: unknown;
  rootCause?: unknown;
  actionTaken?: unknown;
  notes?: unknown;
}

const WALL_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/;

function wallInput(v: unknown, field: string, label: string): string | null {
  if (v === null || v === '') return null;
  const s = String(v).trim();
  if (!WALL_RE.test(s) || Number.isNaN(wall(s.length === 16 ? `${s}:00` : s))) {
    throw new FollowupValidationError(`case.${field}`, `${label} must be a date and time.`, field);
  }
  const out = s.replace('T', ' ');
  return out.length === 16 ? `${out}:00` : out;
}

function textInput(v: unknown, field: string, label: string): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s.length > MAX_TEXT) throw new FollowupValidationError(`case.${field}`, `${label} is limited to ${MAX_TEXT} characters.`, field);
  return s || null;
}

function idInput(v: unknown, field: string, label: string): number | null {
  if (v === null || v === '' || v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new FollowupValidationError(`case.${field}`, `${label} is not valid.`, field);
  return n;
}

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** The field values after the edit, validated against each other and the rating. Pure (unit-tested). */
export function applyEdit(existing: FollowupCase, input: CaseInput, now: string) {
  const next = {
    status: existing.status,
    reasonId: existing.reasonId,
    ownerUserId: existing.ownerUserId,
    contactedAt: existing.contactedAt,
    solvedAt: existing.solvedAt,
    rootCause: existing.rootCause,
    actionTaken: existing.actionTaken,
    notes: existing.notes,
  };
  if (has(input, 'status')) {
    const s = String(input.status ?? '').toUpperCase() as FollowupStatus;
    if (!EDITABLE_STATUSES.includes(s)) {
      throw new FollowupValidationError('case.status', 'Status must be New, Contacted, In progress, Solved or Cancelled.', 'status');
    }
    next.status = s;
  }
  if (has(input, 'reasonId')) next.reasonId = idInput(input.reasonId, 'reasonId', 'Reason');
  if (has(input, 'ownerUserId')) next.ownerUserId = idInput(input.ownerUserId, 'ownerUserId', 'Owner');
  if (has(input, 'contactedAt')) next.contactedAt = wallInput(input.contactedAt, 'contactedAt', 'Contacted at');
  if (has(input, 'solvedAt')) next.solvedAt = wallInput(input.solvedAt, 'solvedAt', 'Solved at');
  if (has(input, 'rootCause')) next.rootCause = textInput(input.rootCause, 'rootCause', 'Root cause');
  if (has(input, 'actionTaken')) next.actionTaken = textInput(input.actionTaken, 'actionTaken', 'Action taken');
  if (has(input, 'notes')) next.notes = textInput(input.notes, 'notes', 'Notes');

  if (next.status === 'HISTORICAL' && (has(input, 'contactedAt') || has(input, 'solvedAt'))) {
    throw new FollowupValidationError('case.status', 'Move a Historical case to a follow-up status first.', 'status');
  }
  // reaching a status fills its time when it is empty
  if (['CONTACTED', 'IN_PROGRESS', 'SOLVED'].includes(next.status) && !next.contactedAt && next.status !== existing.status) next.contactedAt = now;
  if (next.status === 'SOLVED') {
    if (!next.solvedAt) next.solvedAt = now;
    if (next.reasonId === null) throw new FollowupValidationError('case.reasonRequired', 'Choose a reason before marking the case Solved.', 'reasonId');
  } else {
    next.solvedAt = null;
  }
  if (next.status === 'CANCELLED' && !next.notes) {
    throw new FollowupValidationError('case.cancelNote', 'Say in the notes why the case is cancelled.', 'notes');
  }
  for (const [field, label, value] of [['contactedAt', 'Contacted at', next.contactedAt], ['solvedAt', 'Solved at', next.solvedAt]] as const) {
    if (!value) continue;
    if (existing.ratedAt && value < existing.ratedAt) throw new FollowupValidationError(`case.${field}`, `${label} can't be before the rating (${existing.ratedAt.slice(0, 16)}).`, field);
    if (hoursBetween(now, value) > 0.25) throw new FollowupValidationError(`case.${field}`, `${label} can't be in the future.`, field);
  }
  if (next.solvedAt && next.contactedAt && next.solvedAt < next.contactedAt) {
    throw new FollowupValidationError('case.solvedAt', "Solved at can't be before Contacted at.", 'solvedAt');
  }
  return next;
}

const AUDIT_FIELDS: { key: keyof ReturnType<typeof applyEdit>; column: string; field: string }[] = [
  { key: 'status', column: 'status', field: 'status' },
  { key: 'reasonId', column: 'reason_id', field: 'reason' },
  { key: 'ownerUserId', column: 'owner_user_id', field: 'owner' },
  { key: 'contactedAt', column: 'contacted_at', field: 'contacted_at' },
  { key: 'solvedAt', column: 'solved_at', field: 'solved_at' },
  { key: 'rootCause', column: 'root_cause', field: 'root_cause' },
  { key: 'actionTaken', column: 'action_taken', field: 'action_taken' },
  { key: 'notes', column: 'notes', field: 'notes' },
];

export async function updateCase(pool: Pool, caseId: number, input: CaseInput, f: Filters, actorUserId: number, now: string = nowLocal()): Promise<FollowupCase> {
  const version = Number(input.version);
  if (!Number.isInteger(version) || version < 1) throw new FollowupValidationError('case.version', 'The case version is missing; reload the case.');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const existing = await findCase(conn, caseId, f, now, true);
    if (!existing) throw new FollowupValidationError('case.notFound', 'Case not found.');
    if (existing.version !== version) throw new FollowupConflictError(existing);
    const next = applyEdit(existing, input, now);
    if (next.reasonId !== null && next.reasonId !== existing.reasonId) {
      const [r] = await conn.query('SELECT is_active FROM nps_followup_reason WHERE reason_id = ?', [next.reasonId]);
      const row = (r as Record<string, unknown>[])[0];
      if (!row || !Number(row.is_active)) throw new FollowupValidationError('case.reasonId', 'Choose an active reason.', 'reasonId');
    }
    if (next.ownerUserId !== null && next.ownerUserId !== existing.ownerUserId) {
      const [u] = await conn.query('SELECT 1 FROM app_user WHERE user_id = ? AND is_active = 1', [next.ownerUserId]);
      if (!(u as unknown[]).length) throw new FollowupValidationError('case.ownerUserId', 'Choose an active user as the owner.', 'ownerUserId');
    }
    const changed = AUDIT_FIELDS.filter((a) => (existing[a.key] ?? null) !== (next[a.key] ?? null));
    if (changed.length) {
      await conn.query(
        `UPDATE nps_followup_case SET ${changed.map((a) => `${a.column} = ?`).join(', ')}, version = version + 1, updated_by = ?, updated_at = UTC_TIMESTAMP()
          WHERE case_id = ? AND version = ?`,
        [...changed.map((a) => next[a.key] ?? null), actorUserId, caseId, version]);
      const names = await displayNames(conn, existing, next);
      for (const a of changed) {
        await conn.query(
          'INSERT INTO nps_followup_audit (case_id, changed_by, changed_at, field, old_value, new_value) VALUES (?, ?, UTC_TIMESTAMP(), ?, ?, ?)',
          [caseId, actorUserId, a.field, names.old(a.key), names.new(a.key)]);
      }
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return (await findCase(pool, caseId, f, now)) as FollowupCase;
}

/** History keeps readable values (the reason's English name, the owner's name), so it still reads after renames. */
async function displayNames(conn: PoolConnection, before: FollowupCase, after: ReturnType<typeof applyEdit>) {
  const reasonIds = [before.reasonId, after.reasonId].filter((n): n is number => n !== null);
  const userIds = [before.ownerUserId, after.ownerUserId].filter((n): n is number => n !== null);
  const reasons = new Map<number, string>();
  const users = new Map<number, string>();
  if (reasonIds.length) {
    const [r] = await conn.query(`SELECT reason_id, name_en FROM nps_followup_reason WHERE reason_id IN (${reasonIds.map(() => '?').join(', ')})`, reasonIds);
    for (const x of r as Record<string, unknown>[]) reasons.set(Number(x.reason_id), String(x.name_en));
  }
  if (userIds.length) {
    const [u] = await conn.query(`SELECT user_id, display_name FROM app_user WHERE user_id IN (${userIds.map(() => '?').join(', ')})`, userIds);
    for (const x of u as Record<string, unknown>[]) users.set(Number(x.user_id), String(x.display_name));
  }
  const show = (key: string, v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    if (key === 'reasonId') return reasons.get(Number(v)) ?? String(v);
    if (key === 'ownerUserId') return users.get(Number(v)) ?? String(v);
    return String(v);
  };
  return {
    old: (key: string) => show(key, (before as unknown as Record<string, unknown>)[key]),
    new: (key: string) => show(key, (after as unknown as Record<string, unknown>)[key]),
  };
}

// -- reasons -------------------------------------------------------------------------------------------------------------

export interface FollowupReason {
  reasonId: number;
  nameEn: string;
  nameAr: string;
  sortOrder: number;
  isActive: boolean;
  /** cases using it (a used reason can't be deleted, only deactivated) */
  usageCount: number;
}

export async function listReasons(pool: Pool): Promise<FollowupReason[]> {
  const [rows] = await pool.query(
    `SELECT r.reason_id, r.name_en, r.name_ar, r.sort_order, r.is_active,
            (SELECT COUNT(*) FROM nps_followup_case c WHERE c.reason_id = r.reason_id) AS usage_count
       FROM nps_followup_reason r ORDER BY r.sort_order, r.name_en`);
  return (rows as Record<string, unknown>[]).map((r) => ({
    reasonId: Number(r.reason_id),
    nameEn: String(r.name_en),
    nameAr: String(r.name_ar),
    sortOrder: Number(r.sort_order),
    isActive: Boolean(Number(r.is_active)),
    usageCount: Number(r.usage_count),
  }));
}

export interface ReasonInput {
  nameEn?: unknown;
  nameAr?: unknown;
  sortOrder?: unknown;
  isActive?: unknown;
}

function reasonName(v: unknown, field: 'nameEn' | 'nameAr', label: string): string {
  const s = String(v ?? '').trim();
  if (!s) throw new FollowupValidationError(`reason.${field}`, `${label} is required.`, field);
  if (s.length > 100) throw new FollowupValidationError(`reason.${field}`, `${label} is limited to 100 characters.`, field);
  return s;
}

async function nameTaken(pool: Pool, nameEn: string, excludeId: number): Promise<boolean> {
  const [rows] = await pool.query('SELECT 1 FROM nps_followup_reason WHERE name_en = ? AND reason_id <> ? LIMIT 1', [nameEn, excludeId]);
  return (rows as unknown[]).length > 0;
}

export async function createReason(pool: Pool, input: ReasonInput, actorUserId: number): Promise<FollowupReason> {
  const nameEn = reasonName(input.nameEn, 'nameEn', 'English name');
  const nameAr = reasonName(input.nameAr, 'nameAr', 'Arabic name');
  if (await nameTaken(pool, nameEn, -1)) throw new FollowupValidationError('reason.duplicate', `"${nameEn}" already exists.`, 'nameEn');
  let sortOrder = input.sortOrder === undefined || input.sortOrder === '' ? undefined : Number(input.sortOrder);
  if (sortOrder === undefined) {
    const [r] = await pool.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM nps_followup_reason');
    sortOrder = Number((r as Record<string, unknown>[])[0]?.next ?? 1);
  }
  if (!Number.isInteger(sortOrder)) throw new FollowupValidationError('reason.sortOrder', 'Sort order must be a whole number.', 'sortOrder');
  const [res] = await pool.query(
    'INSERT INTO nps_followup_reason (name_en, name_ar, sort_order, is_active, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)',
    [nameEn, nameAr, sortOrder, input.isActive === undefined ? 1 : input.isActive ? 1 : 0, actorUserId, actorUserId]);
  const id = Number((res as { insertId: number }).insertId);
  return (await listReasons(pool)).find((r) => r.reasonId === id) as FollowupReason;
}

export async function updateReason(pool: Pool, id: number, input: ReasonInput, actorUserId: number): Promise<FollowupReason> {
  const existing = (await listReasons(pool)).find((r) => r.reasonId === id);
  if (!existing) throw new FollowupValidationError('reason.notFound', 'Reason not found.');
  const nameEn = input.nameEn === undefined ? existing.nameEn : reasonName(input.nameEn, 'nameEn', 'English name');
  const nameAr = input.nameAr === undefined ? existing.nameAr : reasonName(input.nameAr, 'nameAr', 'Arabic name');
  const sortOrder = input.sortOrder === undefined || input.sortOrder === '' ? existing.sortOrder : Number(input.sortOrder);
  if (!Number.isInteger(sortOrder)) throw new FollowupValidationError('reason.sortOrder', 'Sort order must be a whole number.', 'sortOrder');
  if (await nameTaken(pool, nameEn, id)) throw new FollowupValidationError('reason.duplicate', `"${nameEn}" already exists.`, 'nameEn');
  const isActive = input.isActive === undefined ? existing.isActive : Boolean(input.isActive);
  await pool.query(
    'UPDATE nps_followup_reason SET name_en = ?, name_ar = ?, sort_order = ?, is_active = ?, updated_by = ?, updated_at = UTC_TIMESTAMP() WHERE reason_id = ?',
    [nameEn, nameAr, sortOrder, isActive ? 1 : 0, actorUserId, id]);
  return (await listReasons(pool)).find((r) => r.reasonId === id) as FollowupReason;
}

export async function deleteReason(pool: Pool, id: number): Promise<void> {
  const existing = (await listReasons(pool)).find((r) => r.reasonId === id);
  if (!existing) throw new FollowupValidationError('reason.notFound', 'Reason not found.');
  if (existing.usageCount > 0) {
    throw new FollowupValidationError('reason.inUse', `"${existing.nameEn}" is used by ${existing.usageCount} case(s). Deactivate it instead.`);
  }
  await pool.query('DELETE FROM nps_followup_reason WHERE reason_id = ?', [id]);
}
