import { DateTime } from 'luxon';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { ValidationError } from '../lib/errors';
import { getAppTimezone } from '../lib/timezone';
import { buildWhereClause, type Filters } from '../measures/filters';
import { odooConfiguredBaseUrl, odooFormUrl } from '../lib/odooLinks';
import { NPS_SLA, caseSla, type CaseSla } from '../config/npsSla';

/**
 * NPS Detractor Follow-up (Process department; routes/npsFollowup.ts; docs/nps-followup.md). Schema and rationale:
 * data/warehouse/migrations/0052_nps_detractor_followup.sql, 0066 (stage / status), 0067 (two-level reasons).
 *
 * STAGE and STATUS are two separate things and are never mixed:
 *   stage   the workflow step people move a case through (column `stage`, editable): NEW -> CONTACTED -> IN_PROGRESS
 *           -> RESOLVED, or REJECTED; HISTORICAL = rated before the cut-over (set by the ETL only). Board columns, the
 *           Stage filter, the history.
 *   status  the outcome group OPEN / CLOSE / DISPUTED, worked out from the stage (a generated column, statusOfStage()
 *           is the same rule); nobody sets it, a client that sends `status` is refused. The badge, the Status filter,
 *           the Open / Close / Disputed KPIs. HISTORICAL has no status (NULL).
 *
 * Cases are CREATED only by the ETL (process_nps adds one per detractor; departments/process/followup.py); people edit
 * the manual fields here. The rating's facts (company, customer, order, salesperson, branch) are read live from
 * v_process_nps_response, so every query goes through the same scoped global filters as the NPS Score page
 * (buildWhereClause on alias f). A case whose rating left the source has no view row: it is shown only while no
 * global filter or role scope applies (the filter can't be checked, so it is never shown to a scoped user).
 *
 * Times: rated_at_local, contacted_at, resolved_at, rejected_at are Africa/Tripoli wall-clock times
 * ("yyyy-mm-dd hh:mm:ss"); the UTC columns (updated_at, source_changed_at, the history's changed_at) are sent converted
 * to Tripoli time too. Time open = the case's created_at -> resolved (stage Resolved) or -> now (the open stages); none
 * for Rejected / Historical. Its colour is the SLA state (config/npsSla.ts: contact within 24 h, close within 5 days).
 * Every edit carries the version it was made on; an older version is refused (FollowupConflictError, 409). Each
 * changed field is one nps_followup_audit row, in the same transaction as the update; the workflow step is recorded as
 * field `stage` only (never `status`, which follows the stage by itself).
 */

/** The workflow steps (column `stage`). */
export const FOLLOWUP_STAGES = ['HISTORICAL', 'NEW', 'CONTACTED', 'IN_PROGRESS', 'RESOLVED', 'UNRESOLVED', 'REJECTED'] as const;
export type FollowupStage = (typeof FOLLOWUP_STAGES)[number];
/** What a person may set (HISTORICAL is only ever set by the ETL's cut-over). */
export const EDITABLE_STAGES: readonly FollowupStage[] = ['NEW', 'CONTACTED', 'IN_PROGRESS', 'RESOLVED', 'UNRESOLVED', 'REJECTED'];
/** The stages whose status is OPEN (time open runs to now). */
export const OPEN_STAGES: readonly FollowupStage[] = ['NEW', 'CONTACTED', 'IN_PROGRESS'];

/** The outcome groups (the generated column `status`, migration 0066). Never written by the API. */
export const FOLLOWUP_STATUSES = ['OPEN', 'CLOSE', 'DISPUTED'] as const;
export type FollowupStatus = (typeof FOLLOWUP_STATUSES)[number];

/** The status of a stage: the same CASE as the generated column of migration 0066. HISTORICAL -> null (no badge). */
export function statusOfStage(stage: FollowupStage): FollowupStatus | null {
  if (OPEN_STAGES.includes(stage)) return 'OPEN';
  if (stage === 'RESOLVED') return 'CLOSE';
  if (stage === 'HISTORICAL') return null;
  return 'DISPUTED';
}

/** The board shows Resolved cases of the last 30 days only (the List view shows all; Rejected has no window). */
export const BOARD_RESOLVED_DAYS = 30;
/** The note an "Other" reason requires (nps_followup_case.reason_note, migration 0067). */
export const MAX_REASON_NOTE = 200;
export const MAX_TEXT = 2000;
/** The free-text case owner (migration 0059). */
export const MAX_OWNER = 120;
/** `owners` filter value meaning "no owner yet". */
export const NO_OWNER = '__none__';
const MAX_BOARD_CASES = 2000;
export const MAX_PAGE_SIZE = 500;


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
  /** the workflow step (editable) */
  stage: FollowupStage;
  /** the outcome group, worked out from the stage (read-only); null for Historical */
  status: FollowupStatus | null;
  /** dim_nps_reason (migration 0067): a sub-reason, a category's "Not specified" row, or Other */
  reasonId: number | null;
  categoryKey: string | null;
  categoryEn: string | null;
  categoryAr: string | null;
  /** null = the category's "Not specified" row (or Other) */
  subReasonEn: string | null;
  subReasonAr: string | null;
  /** "Category › Sub-reason" (or "… › Not specified", or "Other"); null = not classified */
  reasonLabelEn: string | null;
  reasonLabelAr: string | null;
  /** the note an "Other" reason requires */
  reasonNote: string | null;
  ownerUserId: number | null;
  ownerName: string | null;
  contactedAt: string | null;
  resolvedAt: string | null;
  /** when the stage became Rejected (set by the API, read-only) */
  rejectedAt: string | null;
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
  /** Odoo form links (lib/odooLinks.ts) of the sale order and the matched picking; null without an id or an Odoo URL setting */
  orderUrl: string | null;
  deliveryUrl: string | null;
  /** when process_nps created the case (Tripoli wall-clock): the start of both SLAs */
  createdAt: string | null;
  /** hours from created_at to resolved / now (= sla.hours); null for Rejected and Historical */
  hoursOpen: number | null;
  /** the SLA state (config/npsSla.ts): colour, rule, how far past the limit */
  sla: CaseSla;
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
  /** workflow steps (`stages=`) */
  stages: FollowupStage[];
  /** outcome groups (`statuses=`): OPEN / CLOSE / DISPUTED */
  statuses: FollowupStatus[];
  /** reason categories (`categories=`, category keys) */
  categories: string[];
  /** exact reasons (`reasonIds=`, dim_nps_reason ids) */
  reasonIds: number[];
  /** owner names (free text, migration 0059); NO_OWNER = no owner yet */
  owners: string[];
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

const NOT_SPECIFIED_AR = 'غير محدد';

/** A reason as one English (or Arabic) line: "Delivery & Logistics › Late deliveries", "… › Not specified", "Other". */
export function reasonLabel(category: string | null, subReason: string | null, requiresNote: boolean, notSpecified = 'Not specified'): string | null {
  if (!category) return null;
  if (subReason) return `${category} › ${subReason}`;
  return requiresNote ? category : `${category} › ${notSpecified}`;
}

// -- query parsing ---------------------------------------------------------------------------------------------------------
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const KEY = /^[a-z0-9_]{1,40}$/;

function listOf(value: unknown): string[] {
  return (Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value])
    .flatMap((v) => String(v).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `owners=A,B` or repeated; each trimmed, at most 20, each at most MAX_OWNER characters. */
function ownerList(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return [];
  const raw = (Array.isArray(value) ? value : [value]).flatMap((v) => String(v).split(','));
  const out = [...new Set(raw.map((s) => s.trim()).filter(Boolean))];
  if (out.length > 20 || out.some((s) => s.length > MAX_OWNER)) throw new FollowupValidationError('query', 'owners is not valid');
  return out;
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

/** Upper-cased values of one of the two lists; a value of the other list is refused, so a mix-up never filters silently. */
function enumList<T extends string>(value: unknown, allowed: readonly T[], what: 'stage' | 'status'): T[] {
  const out = listOf(value).map((s) => s.toUpperCase());
  for (const s of out) if (!allowed.includes(s as T)) throw new FollowupValidationError('query', `Unknown ${what} ${s}`);
  return out as T[];
}

export function parseFollowupQuery(q: Record<string, unknown>): FollowupQuery {
  const categories = listOf(q.categories).map((s) => s.toLowerCase());
  if (categories.some((c) => !KEY.test(c))) throw new FollowupValidationError('query', 'categories is not valid');
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
    stages: enumList(q.stages, FOLLOWUP_STAGES, 'stage'),
    statuses: enumList(q.statuses, FOLLOWUP_STATUSES, 'status'),
    categories,
    reasonIds: intList(q.reasonIds, 'reasonIds'),
    owners: ownerList(q.owners),
    sourceChanged: sc,
    search: typeof q.search === 'string' && q.search.trim() ? q.search.trim().slice(0, 100) : undefined,
    page,
    pageSize,
  };
}

// -- SQL -------------------------------------------------------------------------------------------------------------------
const FROM = `
    FROM nps_followup_case c
    LEFT JOIN v_process_nps_response f ON f.response_id = c.response_id
    LEFT JOIN dim_nps_reason r ON r.reason_id = c.reason_id`;

const SELECT = `
  SELECT c.case_id, c.response_id, c.rated_at_local, c.created_at, c.stage, c.status, c.reason_id, c.reason_note,
         r.category_key, r.category_en, r.category_ar, r.sub_reason_en, r.sub_reason_ar, r.requires_note,
         c.owner_user_id, COALESCE(c.owner_name, o.display_name) AS owner_name, c.contacted_at, c.resolved_at, c.rejected_at,
         c.root_cause, c.action_taken, c.notes,
         c.source_changed, c.source_changed_at, c.source_change_reason, c.version, c.updated_at, u.display_name AS updated_by_name,
         f.company, f.customer, f.order_ref, f.delivery_code, f.sales_team, f.salesperson, f.team_branch,
         f.CompanyKey, f.SalesOrderKey, f.PickingID, f.has_comment${FROM}
    LEFT JOIN app_user o ON o.user_id = c.owner_user_id
    LEFT JOIN app_user u ON u.user_id = c.updated_by`;

interface Where {
  sql: string;
  params: Array<string | number>;
}

const marks = (xs: unknown[]) => xs.map(() => '?').join(', ');

/** The scoped global filters on the rating (alias f) plus the follow-up's own filters (case c, reason r). */
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
  if (q.stages?.length) {
    parts.push(`c.stage IN (${marks(q.stages)})`);
    params.push(...q.stages);
  }
  if (q.statuses?.length) {
    parts.push(`c.status IN (${marks(q.statuses)})`);
    params.push(...q.statuses);
  }
  if (q.categories?.length) {
    parts.push(`r.category_key IN (${marks(q.categories)})`);
    params.push(...q.categories);
  }
  if (q.reasonIds?.length) {
    parts.push(`c.reason_id IN (${marks(q.reasonIds)})`);
    params.push(...q.reasonIds);
  }
  if (q.owners?.length) {
    // owner_name holds every owner since migration 0059 (old user owners were copied into it)
    const names = q.owners.filter((n) => n !== NO_OWNER);
    const alts = [...(names.length ? [`c.owner_name IN (${marks(names)})`] : []), ...(q.owners.includes(NO_OWNER) ? ['c.owner_name IS NULL'] : [])];
    parts.push(`(${alts.join(' OR ')})`);
    params.push(...names);
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

const idOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function toCase(r: Record<string, unknown>, now: string): FollowupCase {
  const odoo = odooConfiguredBaseUrl();
  const companyKey = idOrNull(r.CompanyKey);
  const base = {
    caseId: Number(r.case_id),
    responseId: Number(r.response_id),
    ratedAt: asWall(r.rated_at_local),
    stage: r.stage as FollowupStage,
    // the generated column (0066), never computed here, so the API shows exactly what the database holds
    status: (r.status as FollowupStatus | null) ?? null,
    reasonId: idOrNull(r.reason_id),
    categoryKey: strOrNull(r.category_key),
    categoryEn: strOrNull(r.category_en),
    categoryAr: strOrNull(r.category_ar),
    subReasonEn: strOrNull(r.sub_reason_en),
    subReasonAr: strOrNull(r.sub_reason_ar),
    reasonLabelEn: reasonLabel(strOrNull(r.category_en), strOrNull(r.sub_reason_en), Number(r.requires_note ?? 0) === 1),
    reasonLabelAr: reasonLabel(strOrNull(r.category_ar), strOrNull(r.sub_reason_ar), Number(r.requires_note ?? 0) === 1, NOT_SPECIFIED_AR),
    reasonNote: strOrNull(r.reason_note),
    ownerUserId: idOrNull(r.owner_user_id),
    ownerName: strOrNull(r.owner_name),
    contactedAt: asWall(r.contacted_at),
    resolvedAt: asWall(r.resolved_at),
    rejectedAt: asWall(r.rejected_at),
    rootCause: strOrNull(r.root_cause),
    actionTaken: strOrNull(r.action_taken),
    notes: strOrNull(r.notes),
    sourceChanged: Boolean(Number(r.source_changed)),
    sourceChangedAt: utcToLocal(r.source_changed_at),
    sourceChangeReason: strOrNull(r.source_change_reason),
    version: Number(r.version),
    updatedAt: utcToLocal(r.updated_at),
    updatedByName: strOrNull(r.updated_by_name),
    company: strOrNull(r.company),
    customer: strOrNull(r.customer),
    orderRef: strOrNull(r.order_ref),
    deliveryCode: strOrNull(r.delivery_code),
    salesTeam: strOrNull(r.sales_team),
    salesperson: strOrNull(r.salesperson),
    teamBranch: strOrNull(r.team_branch),
    hasComment: Boolean(Number(r.has_comment ?? 0)),
    orderUrl: odooFormUrl(odoo, 'sale.order', idOrNull(r.SalesOrderKey), companyKey),
    deliveryUrl: odooFormUrl(odoo, 'stock.picking', idOrNull(r.PickingID), companyKey),
    createdAt: utcToLocal(r.created_at),
  };
  const sla = caseSla(base, now);
  return { ...base, hoursOpen: sla.hours, sla };
}

// -- reads -----------------------------------------------------------------------------------------------------------------

export interface FollowupKpis {
  /** from STATUS: every case of the filters with a status (Historical has none), Resolved of any date included */
  open: number;
  close: number;
  disputed: number;
  /** open + close + disputed */
  total: number;
  /** shares of total, 0..100 unrounded; null when total = 0 */
  openShare: number | null;
  closeShare: number | null;
  disputedShare: number | null;
  /** from the STAGE and the SLA (config/npsSla.ts), the board's cases */
  /** open more than closeDays (Close SLA missed) */
  closeSlaMissed: number;
  /** open more than contactHours without contacted_at (Contact SLA missed) */
  contactSlaMissed: number;
  resolved30Days: number;
  /** of those, resolved within closeDays */
  resolvedInSla: number;
  /** board cases (Rejected excepted) without a reason */
  noReason: number;
}

export interface FollowupBoard {
  cases: FollowupCase[];
  truncated: boolean;
  kpis: FollowupKpis;
  now: string;
}

const share = (n: number, total: number): number | null => (total > 0 ? (n / total) * 100 : null);

/**
 * The board: every non-Historical case matching the filters; Resolved only when resolved in the last 30 days (Rejected
 * has no window). The Open / Close / Disputed KPIs count every case of the filters by status (not only the 30 days).
 */
export async function fetchBoard(pool: Pool, q: FollowupQuery, f: Filters, now: string = nowLocal()): Promise<FollowupBoard> {
  const w = followupWhere({ ...q, stages: q.stages.filter((s) => s !== 'HISTORICAL') }, f);
  const resolvedFrom = DateTime.fromISO(now.replace(' ', 'T'), { zone: 'utc' }).minus({ days: BOARD_RESOLVED_DAYS }).toFormat('yyyy-MM-dd HH:mm:ss');
  const [rows] = await pool.query(
    `${SELECT} WHERE c.stage <> 'HISTORICAL' AND (c.stage <> 'RESOLVED' OR c.resolved_at >= ?) AND ${w.sql}
      ORDER BY c.rated_at_local ASC, c.case_id ASC LIMIT ?`,
    [resolvedFrom, ...w.params, MAX_BOARD_CASES + 1]);
  const [byStatus] = await pool.query(
    `SELECT c.status, COUNT(*) AS n ${FROM} WHERE c.status IS NOT NULL AND ${w.sql} GROUP BY c.status`, w.params);
  const counts: Record<FollowupStatus, number> = { OPEN: 0, CLOSE: 0, DISPUTED: 0 };
  for (const r of byStatus as Record<string, unknown>[]) {
    if (FOLLOWUP_STATUSES.includes(r.status as FollowupStatus)) counts[r.status as FollowupStatus] = Number(r.n);
  }
  const total = counts.OPEN + counts.CLOSE + counts.DISPUTED;

  const all = (rows as Record<string, unknown>[]).map((r) => toCase(r, now));
  const cases = all.slice(0, MAX_BOARD_CASES);
  const open = cases.filter((c) => OPEN_STAGES.includes(c.stage));
  const resolved = cases.filter((c) => c.stage === 'RESOLVED');
  return {
    cases,
    truncated: all.length > MAX_BOARD_CASES,
    kpis: {
      open: counts.OPEN,
      close: counts.CLOSE,
      disputed: counts.DISPUTED,
      total,
      openShare: share(counts.OPEN, total),
      closeShare: share(counts.CLOSE, total),
      disputedShare: share(counts.DISPUTED, total),
      closeSlaMissed: open.filter((c) => c.sla.rule === 'close_missed').length,
      contactSlaMissed: open.filter((c) => !c.contactedAt && (c.sla.exactHours ?? 0) > NPS_SLA.contactHours).length,
      resolved30Days: resolved.length,
      resolvedInSla: resolved.filter((c) => c.sla.rule === 'resolved_in_sla').length,
      noReason: cases.filter((c) => c.stage !== 'REJECTED' && c.reasonId === null).length,
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
  const [count] = await pool.query(`SELECT COUNT(*) AS n ${FROM} WHERE ${w.sql}`, w.params);
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
  /** the workflow steps (Stage filter, the case's Stage field) */
  stages: readonly FollowupStage[];
  /** the outcome groups (Status filter) */
  statuses: readonly FollowupStatus[];
  reasons: FollowupReason[];
  /** Owner names already used on cases plus active users' names: suggestions for the free-text Owner field and the
   *  Owner filter's choices. Sorted, unique. */
  owners: string[];
}

export async function fetchOptions(pool: Pool): Promise<FollowupOptions> {
  const [owners] = await pool.query(
    `SELECT DISTINCT owner_name AS name FROM nps_followup_case WHERE owner_name IS NOT NULL AND owner_name <> ''
     UNION
     SELECT display_name AS name FROM app_user WHERE is_active = 1 AND status <> 'INACTIVE'
     ORDER BY name`);
  return {
    stages: FOLLOWUP_STAGES,
    statuses: FOLLOWUP_STATUSES,
    reasons: await listReasons(pool),
    owners: [...new Set((owners as Record<string, unknown>[]).map((o) => String(o.name).trim()).filter(Boolean))],
  };
}

// -- edit --------------------------------------------------------------------------------------------------------------------

export interface CaseInput {
  version?: unknown;
  stage?: unknown;
  /** refused: the status is worked out from the stage */
  status?: unknown;
  reasonId?: unknown;
  reasonNote?: unknown;
  /** free text (migration 0059); '' or null clears it */
  owner?: unknown;
  contactedAt?: unknown;
  resolvedAt?: unknown;
  /** refused: set when the stage becomes Rejected */
  rejectedAt?: unknown;
  rootCause?: unknown;
  actionTaken?: unknown;
  notes?: unknown;
}

/** What applyEdit needs to know of the reason the case will have (looked up by updateCase). */
export interface ReasonRule {
  requiresNote: boolean;
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

function textInput(v: unknown, field: string, label: string, max = MAX_TEXT): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s.length > max) throw new FollowupValidationError(`case.${field}`, `${label} is limited to ${max} characters.`, field);
  return s || null;
}

function ownerInput(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (s.length > MAX_OWNER) throw new FollowupValidationError('case.owner', `Owner is limited to ${MAX_OWNER} characters.`, 'owner');
  return s || null;
}

function idInput(v: unknown, field: string, label: string): number | null {
  if (v === null || v === '' || v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new FollowupValidationError(`case.${field}`, `${label} is not valid.`, field);
  return n;
}

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** The reason id the edit leads to (validated), so updateCase can look the reason up before applyEdit. */
export function nextReasonId(existing: Pick<FollowupCase, 'reasonId'>, input: CaseInput): number | null {
  return has(input, 'reasonId') ? idInput(input.reasonId, 'reasonId', 'Reason') : existing.reasonId;
}

/**
 * The field values after the edit, validated against each other and the rating. Pure (unit-tested). `reason` is the
 * rule of the reason the case will have (undefined = not looked up: the note is kept as it is).
 * Never returns `status`: it follows the stage in the database (generated column).
 */
export function applyEdit(existing: FollowupCase, input: CaseInput, now: string, reason?: ReasonRule | null) {
  if (has(input, 'status')) {
    throw new FollowupValidationError('case.statusReadOnly', "Status can't be set: it follows the stage. Change the stage instead.", 'status');
  }
  if (has(input, 'rejectedAt')) {
    throw new FollowupValidationError('case.rejectedAtReadOnly', 'Rejected at is set when the stage becomes Rejected.', 'rejectedAt');
  }
  const next = {
    stage: existing.stage,
    reasonId: existing.reasonId,
    reasonNote: existing.reasonNote,
    ownerName: existing.ownerName,
    contactedAt: existing.contactedAt,
    resolvedAt: existing.resolvedAt,
    rejectedAt: existing.rejectedAt,
    rootCause: existing.rootCause,
    actionTaken: existing.actionTaken,
    notes: existing.notes,
  };
  if (has(input, 'stage')) {
    const s = String(input.stage ?? '').toUpperCase() as FollowupStage;
    if (!EDITABLE_STAGES.includes(s)) {
      throw new FollowupValidationError('case.stage', 'Stage must be New, Contacted, In progress, Resolved, Unresolved or Rejected.', 'stage');
    }
    next.stage = s;
  }
  next.reasonId = nextReasonId(existing, input);
  if (has(input, 'reasonNote')) next.reasonNote = textInput(input.reasonNote, 'reasonNote', 'The reason note', MAX_REASON_NOTE);
  if (has(input, 'owner')) next.ownerName = ownerInput(input.owner);
  if (has(input, 'contactedAt')) next.contactedAt = wallInput(input.contactedAt, 'contactedAt', 'Contacted at');
  if (has(input, 'resolvedAt')) next.resolvedAt = wallInput(input.resolvedAt, 'resolvedAt', 'Resolved at');
  if (has(input, 'rootCause')) next.rootCause = textInput(input.rootCause, 'rootCause', 'Root cause');
  if (has(input, 'actionTaken')) next.actionTaken = textInput(input.actionTaken, 'actionTaken', 'Action taken');
  if (has(input, 'notes')) next.notes = textInput(input.notes, 'notes', 'Notes');

  if (next.stage === 'HISTORICAL' && (has(input, 'contactedAt') || has(input, 'resolvedAt'))) {
    throw new FollowupValidationError('case.stage', 'Move a Historical case to a follow-up stage first.', 'stage');
  }
  // reaching a stage fills its time when it is empty
  if (['CONTACTED', 'IN_PROGRESS', 'RESOLVED'].includes(next.stage) && !next.contactedAt && next.stage !== existing.stage) next.contactedAt = now;
  if (next.stage === 'RESOLVED') {
    if (!next.resolvedAt) next.resolvedAt = now;
    if (next.reasonId === null) throw new FollowupValidationError('case.reasonRequired', 'Choose a reason before moving the case to Resolved.', 'reasonId');
  } else {
    next.resolvedAt = null;
  }
  // rejected_at: when the stage became Rejected (kept while it stays Rejected), cleared when it leaves
  if (next.stage === 'REJECTED') {
    next.rejectedAt = existing.stage === 'REJECTED' ? (existing.rejectedAt ?? now) : now;
    if (!next.notes) throw new FollowupValidationError('case.rejectNote', 'Say in the notes why the case is rejected.', 'notes');
  } else {
    next.rejectedAt = null;
  }
  // the note belongs to a reason that requires one (Other) and goes with it
  if (next.reasonId === null || (reason && !reason.requiresNote)) next.reasonNote = null;
  // asked when Other is chosen or its note is cleared (a case moved to Other by migration 0067 keeps working without one)
  if (reason?.requiresNote && !next.reasonNote && (next.reasonId !== existing.reasonId || has(input, 'reasonNote'))) {
    throw new FollowupValidationError('case.reasonNote', 'Say in a short note what the "Other" reason is.', 'reasonNote');
  }
  for (const [field, label, value] of [['contactedAt', 'Contacted at', next.contactedAt], ['resolvedAt', 'Resolved at', next.resolvedAt]] as const) {
    if (!value) continue;
    if (existing.ratedAt && value < existing.ratedAt) throw new FollowupValidationError(`case.${field}`, `${label} can't be before the rating (${existing.ratedAt.slice(0, 16)}).`, field);
    if (hoursBetween(now, value) > 0.25) throw new FollowupValidationError(`case.${field}`, `${label} can't be in the future.`, field);
  }
  if (next.resolvedAt && next.contactedAt && next.resolvedAt < next.contactedAt) {
    throw new FollowupValidationError('case.resolvedAt', "Resolved at can't be before Contacted at.", 'resolvedAt');
  }
  return next;
}

type Edited = ReturnType<typeof applyEdit>;

/**
 * The columns an edit writes and the history field each one is recorded under. `status` is never written (generated
 * column) and never audited; rejected_at is written with the stage but not audited (the stage row has the time).
 */
const WRITE_FIELDS: { key: keyof Edited; column: string; field: string | null }[] = [
  { key: 'stage', column: 'stage', field: 'stage' },
  { key: 'reasonId', column: 'reason_id', field: 'reason' },
  { key: 'reasonNote', column: 'reason_note', field: 'reason_note' },
  { key: 'ownerName', column: 'owner_name', field: 'owner' },
  { key: 'contactedAt', column: 'contacted_at', field: 'contacted_at' },
  { key: 'resolvedAt', column: 'resolved_at', field: 'resolved_at' },
  { key: 'rejectedAt', column: 'rejected_at', field: null },
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
    const reasonId = nextReasonId(existing, input);
    let rule: ReasonRule | null = null;
    if (reasonId !== null) {
      const reason = (await listReasons(conn, reasonId))[0];
      if (!reason) throw new FollowupValidationError('case.reasonId', 'Choose a reason from the list.', 'reasonId');
      // a new choice must be pickable (an active sub-reason, or Other); a kept one stays even when deactivated since
      if (reasonId !== existing.reasonId && !reason.pickable) {
        throw new FollowupValidationError('case.reasonId', 'Choose an active sub-reason (or Other).', 'reasonId');
      }
      rule = { requiresNote: reason.requiresNote };
    }
    const next = applyEdit(existing, input, now, rule);
    const changed = WRITE_FIELDS.filter((a) => (existing[a.key] ?? null) !== (next[a.key] ?? null));
    if (changed.length) {
      // a typed owner replaces the old user link (pre-0059), so clearing the text really clears the owner
      const ownerChanged = changed.some((a) => a.key === 'ownerName');
      await conn.query(
        `UPDATE nps_followup_case SET ${changed.map((a) => `${a.column} = ?`).join(', ')}${ownerChanged ? ', owner_user_id = NULL' : ''}, version = version + 1, updated_by = ?, updated_at = UTC_TIMESTAMP()
          WHERE case_id = ? AND version = ?`,
        [...changed.map((a) => next[a.key] ?? null), actorUserId, caseId, version]);
      const names = await displayNames(conn, existing, next);
      for (const a of changed) {
        if (!a.field) continue;
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

/** History keeps readable values (the reason's English line, the owner's name), so it still reads after renames. */
async function displayNames(conn: PoolConnection, before: FollowupCase, after: Edited) {
  const reasonIds = [before.reasonId, after.reasonId].filter((n): n is number => n !== null);
  const reasons = new Map<number, string>();
  if (reasonIds.length) {
    for (const r of await listReasons(conn, ...reasonIds)) reasons.set(r.reasonId, r.labelEn);
  }
  const show = (key: string, v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    if (key === 'reasonId') return reasons.get(Number(v)) ?? String(v);
    return String(v);
  };
  return {
    old: (key: string) => show(key, (before as unknown as Record<string, unknown>)[key]),
    new: (key: string) => show(key, (after as unknown as Record<string, unknown>)[key]),
  };
}

// -- reasons (dim_nps_reason, migration 0067) ------------------------------------------------------------------------------

/**
 * One row of the two-level list. A row with subReasonEn null is its CATEGORY's row: "Not specified" (cases migrated
 * without a known sub-reason point to it; never offered in the picker), or the category Other (requiresNote: offered,
 * with a required note). Every other row is a sub-reason.
 */
export interface FollowupReason {
  reasonId: number;
  reasonKey: string;
  categoryKey: string;
  categoryEn: string;
  categoryAr: string;
  subReasonEn: string | null;
  subReasonAr: string | null;
  categorySort: number;
  sortOrder: number;
  requiresNote: boolean;
  isActive: boolean;
  /** the category's own row is active (a deactivated category hides all its sub-reasons from the picker) */
  categoryActive: boolean;
  /** a person may choose it on a case: an active sub-reason of an active category, or an active Other */
  pickable: boolean;
  /** "Category › Sub-reason" (or "Category › Not specified", or "Other") */
  labelEn: string;
  labelAr: string;
  /** cases using it (a used reason can't be deleted, only deactivated) */
  usageCount: number;
}

/** The whole list in display order, or only the given ids. */
export async function listReasons(db: Pool | PoolConnection, ...ids: number[]): Promise<FollowupReason[]> {
  const [rows] = await db.query(
    `SELECT r.reason_id, r.reason_key, r.category_key, r.category_en, r.category_ar, r.sub_reason_en, r.sub_reason_ar,
            r.category_sort, r.sort_order, r.requires_note, r.is_active, COALESCE(k.is_active, 1) AS category_active,
            (SELECT COUNT(*) FROM nps_followup_case c WHERE c.reason_id = r.reason_id) AS usage_count
       FROM dim_nps_reason r
       LEFT JOIN dim_nps_reason k ON k.reason_key = r.category_key
      ${ids.length ? `WHERE r.reason_id IN (${marks(ids)})` : ''}
      ORDER BY r.category_sort, r.category_key, r.sub_reason_en IS NOT NULL, r.sort_order, r.sub_reason_en`, ids);
  return (rows as Record<string, unknown>[]).map((r) => {
    const sub = strOrNull(r.sub_reason_en);
    const requiresNote = Boolean(Number(r.requires_note));
    const isActive = Boolean(Number(r.is_active));
    const categoryActive = Boolean(Number(r.category_active));
    return {
      reasonId: Number(r.reason_id),
      reasonKey: String(r.reason_key),
      categoryKey: String(r.category_key),
      categoryEn: String(r.category_en),
      categoryAr: String(r.category_ar),
      subReasonEn: sub,
      subReasonAr: strOrNull(r.sub_reason_ar),
      categorySort: Number(r.category_sort),
      sortOrder: Number(r.sort_order),
      requiresNote,
      isActive,
      categoryActive,
      pickable: isActive && categoryActive && (sub !== null || requiresNote),
      labelEn: reasonLabel(String(r.category_en), sub, requiresNote) as string,
      labelAr: reasonLabel(String(r.category_ar), strOrNull(r.sub_reason_ar), requiresNote, NOT_SPECIFIED_AR) as string,
      usageCount: Number(r.usage_count),
    };
  });
}

export interface ReasonInput {
  /** new sub-reason: the category it belongs to (an existing category key) */
  categoryKey?: unknown;
  /** new category, or renaming a category (on its category row) */
  categoryEn?: unknown;
  categoryAr?: unknown;
  subReasonEn?: unknown;
  subReasonAr?: unknown;
  sortOrder?: unknown;
  isActive?: unknown;
}

function reasonName(v: unknown, field: keyof ReasonInput, label: string): string {
  const s = String(v ?? '').trim();
  if (!s) throw new FollowupValidationError(`reason.${field}`, `${label} is required.`, field);
  if (s.length > 100) throw new FollowupValidationError(`reason.${field}`, `${label} is limited to 100 characters.`, field);
  return s;
}

function sortInput(v: unknown, fallback: number): number {
  const n = v === undefined || v === '' || v === null ? fallback : Number(v);
  if (!Number.isInteger(n)) throw new FollowupValidationError('reason.sortOrder', 'Sort order must be a whole number.', 'sortOrder');
  return n;
}

/** "Late deliveries" -> "late_deliveries" (a key part; never empty). */
export function slugOf(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'reason';
}

async function freeKey(pool: Pool, wanted: string): Promise<string> {
  const [rows] = await pool.query('SELECT reason_key FROM dim_nps_reason WHERE reason_key = ? OR reason_key LIKE ?', [wanted, `${wanted}\\_%`]);
  const taken = new Set((rows as Record<string, unknown>[]).map((r) => String(r.reason_key)));
  if (!taken.has(wanted)) return wanted;
  for (let i = 2; ; i += 1) if (!taken.has(`${wanted}_${i}`)) return `${wanted}_${i}`;
}

/**
 * Adds a sub-reason (`categoryKey` of an existing category + subReasonEn/Ar) or a category (categoryEn/Ar, no
 * categoryKey: its "Not specified" row is created). Names are unique within their level.
 */
export async function createReason(pool: Pool, input: ReasonInput, actorUserId: number): Promise<FollowupReason> {
  const all = await listReasons(pool);
  const isActive = input.isActive === undefined ? 1 : input.isActive ? 1 : 0;
  let id: number;
  if (input.categoryKey !== undefined && input.categoryKey !== null && input.categoryKey !== '') {
    const category = all.find((r) => r.subReasonEn === null && r.categoryKey === String(input.categoryKey));
    if (!category) throw new FollowupValidationError('reason.categoryKey', 'Choose an existing category.', 'categoryKey');
    if (category.requiresNote) throw new FollowupValidationError('reason.categoryKey', `"${category.categoryEn}" has no sub-reasons.`, 'categoryKey');
    const subEn = reasonName(input.subReasonEn, 'subReasonEn', 'English name');
    const subAr = reasonName(input.subReasonAr, 'subReasonAr', 'Arabic name');
    const siblings = all.filter((r) => r.categoryKey === category.categoryKey && r.subReasonEn !== null);
    if (siblings.some((r) => r.subReasonEn?.toLowerCase() === subEn.toLowerCase())) {
      throw new FollowupValidationError('reason.duplicate', `"${subEn}" already exists in ${category.categoryEn}.`, 'subReasonEn');
    }
    const sortOrder = sortInput(input.sortOrder, Math.max(0, ...siblings.map((r) => r.sortOrder)) + 1);
    const key = await freeKey(pool, `${category.categoryKey}.${slugOf(subEn)}`);
    const [res] = await pool.query(
      `INSERT INTO dim_nps_reason (reason_key, category_key, category_en, category_ar, sub_reason_en, sub_reason_ar, category_sort, sort_order,
                                   requires_note, is_active, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, FALSE, ?, ?, ?)`,
      [key, category.categoryKey, category.categoryEn, category.categoryAr, subEn, subAr, category.categorySort, sortOrder, isActive, actorUserId, actorUserId]);
    id = Number((res as { insertId: number }).insertId);
  } else {
    const catEn = reasonName(input.categoryEn, 'categoryEn', 'English name');
    const catAr = reasonName(input.categoryAr, 'categoryAr', 'Arabic name');
    if (all.some((r) => r.subReasonEn === null && r.categoryEn.toLowerCase() === catEn.toLowerCase())) {
      throw new FollowupValidationError('reason.duplicate', `"${catEn}" already exists.`, 'categoryEn');
    }
    // a key never contains a dot (sub-reason keys are "<category>.<sub>")
    const key = await freeKey(pool, slugOf(catEn));
    const categorySort = sortInput(input.sortOrder, Math.max(0, ...all.map((r) => r.categorySort)) + 1);
    const [res] = await pool.query(
      `INSERT INTO dim_nps_reason (reason_key, category_key, category_en, category_ar, sub_reason_en, sub_reason_ar, category_sort, sort_order,
                                   requires_note, is_active, created_by, updated_by) VALUES (?, ?, ?, ?, NULL, NULL, ?, 0, FALSE, ?, ?, ?)`,
      [key, key, catEn, catAr, categorySort, isActive, actorUserId, actorUserId]);
    id = Number((res as { insertId: number }).insertId);
  }
  return (await listReasons(pool, id))[0];
}

/**
 * A category row: renames the category (on every row of it), moves it (sortOrder = its place among the categories),
 * (de)activates it. A sub-reason row: renames, reorders, (de)activates it.
 */
export async function updateReason(pool: Pool, id: number, input: ReasonInput, actorUserId: number): Promise<FollowupReason> {
  const all = await listReasons(pool);
  const existing = all.find((r) => r.reasonId === id);
  if (!existing) throw new FollowupValidationError('reason.notFound', 'Reason not found.');
  const isActive = input.isActive === undefined ? existing.isActive : Boolean(input.isActive);
  if (existing.subReasonEn === null) {
    const catEn = input.categoryEn === undefined ? existing.categoryEn : reasonName(input.categoryEn, 'categoryEn', 'English name');
    const catAr = input.categoryAr === undefined ? existing.categoryAr : reasonName(input.categoryAr, 'categoryAr', 'Arabic name');
    if (all.some((r) => r.subReasonEn === null && r.reasonId !== id && r.categoryEn.toLowerCase() === catEn.toLowerCase())) {
      throw new FollowupValidationError('reason.duplicate', `"${catEn}" already exists.`, 'categoryEn');
    }
    const categorySort = sortInput(input.sortOrder, existing.categorySort);
    await pool.query(
      'UPDATE dim_nps_reason SET category_en = ?, category_ar = ?, category_sort = ?, updated_by = ?, updated_at = UTC_TIMESTAMP() WHERE category_key = ?',
      [catEn, catAr, categorySort, actorUserId, existing.categoryKey]);
    await pool.query('UPDATE dim_nps_reason SET is_active = ? WHERE reason_id = ?', [isActive ? 1 : 0, id]);
  } else {
    const subEn = input.subReasonEn === undefined ? existing.subReasonEn : reasonName(input.subReasonEn, 'subReasonEn', 'English name');
    const subAr = input.subReasonAr === undefined ? existing.subReasonAr : reasonName(input.subReasonAr, 'subReasonAr', 'Arabic name');
    if (all.some((r) => r.categoryKey === existing.categoryKey && r.reasonId !== id && r.subReasonEn?.toLowerCase() === subEn.toLowerCase())) {
      throw new FollowupValidationError('reason.duplicate', `"${subEn}" already exists in ${existing.categoryEn}.`, 'subReasonEn');
    }
    const sortOrder = sortInput(input.sortOrder, existing.sortOrder);
    await pool.query(
      'UPDATE dim_nps_reason SET sub_reason_en = ?, sub_reason_ar = ?, sort_order = ?, is_active = ?, updated_by = ?, updated_at = UTC_TIMESTAMP() WHERE reason_id = ?',
      [subEn, subAr, sortOrder, isActive ? 1 : 0, actorUserId, id]);
  }
  return (await listReasons(pool, id))[0];
}

/** Only an unused row; a category only when it has no sub-reason left. */
export async function deleteReason(pool: Pool, id: number): Promise<void> {
  const all = await listReasons(pool);
  const existing = all.find((r) => r.reasonId === id);
  if (!existing) throw new FollowupValidationError('reason.notFound', 'Reason not found.');
  if (existing.usageCount > 0) {
    throw new FollowupValidationError('reason.inUse', `"${existing.labelEn}" is used by ${existing.usageCount} case(s). Deactivate it instead.`);
  }
  if (existing.subReasonEn === null && all.some((r) => r.categoryKey === existing.categoryKey && r.reasonId !== id)) {
    throw new FollowupValidationError('reason.hasSubReasons', `Delete the sub-reasons of "${existing.categoryEn}" first, or deactivate it.`);
  }
  await pool.query('DELETE FROM dim_nps_reason WHERE reason_id = ?', [id]);
}
