import { DateTime } from 'luxon';
import type { PoolConnection } from 'mysql2/promise';
import { pool } from '../db/pool';
import { ValidationError } from '../lib/errors';
import { getAppTimezone } from '../lib/timezone';
import { writeAuditLog } from './auditLogService';

/**
 * Kaizen Board (Process department): cards entered by the Excellence Manager and the admin-managed
 * dropdown lists they reference. Schema and rationale: data/warehouse/migrations/0027_kaizen_board.sql.
 *
 * Every read excludes soft-deleted cards (deleted_at IS NOT NULL); card_no is never reused. The
 * module is English-only. Validation failures throw KaizenValidationError: a stable `code` plus the
 * message shown to the user.
 */

export const KAIZEN_LISTS = ['department', 'card_type', 'card_priority'] as const;
export type KaizenListKey = (typeof KAIZEN_LISTS)[number];
export type KaizenStatus = 'OPEN' | 'CLOSED';

export const KAIZEN_CARD_ENTITY = 'kaizen_card';
export const KAIZEN_DROPDOWN_ENTITY = 'kaizen_dropdown_value';

export class KaizenValidationError extends ValidationError {
  code: string;
  field?: string;
  constructor(code: string, message: string, field?: string) {
    super(message);
    this.code = code;
    this.field = field;
  }
}

export interface KaizenDropdownValue {
  value_id: number;
  list_key: KaizenListKey;
  label: string;
  sort_order: number;
  color: string;
  is_active: boolean;
  /** Cards (including soft-deleted ones, which still reference it) using this value. */
  usage_count: number;
}

export interface KaizenCard {
  card_no: number;
  creator_name: string;
  card_date: string;
  department_id: number;
  card_name: string;
  card_type_id: number;
  issue: string;
  root_cause: string | null;
  impact: string | null;
  priority_id: number;
  proposed_solution: string | null;
  expected_date: string | null;
  closer_date: string | null;
  responsible_party: string | null;
  status: KaizenStatus;
  source: 'MANUAL' | 'IMPORT';
  /** Open and past its Expected Date (in the app's timezone). */
  is_overdue: boolean;
  created_by_name: string | null;
  created_at: string;
  updated_by_name: string | null;
  updated_at: string;
}

/** Today's date (YYYY-MM-DD) in the business timezone, not the server's. */
export function kaizenToday(): string {
  return DateTime.now().setZone(getAppTimezone()).toISODate() as string;
}

// ---------------------------------------------------------------------------
// Dropdown values
// ---------------------------------------------------------------------------

const DROPDOWN_SELECT = `
  SELECT v.value_id, v.list_key, v.label, v.sort_order, v.color, v.is_active,
         (SELECT COUNT(*) FROM kaizen_cards c
           WHERE c.department_id = v.value_id OR c.card_type_id = v.value_id OR c.priority_id = v.value_id) AS usage_count
    FROM kaizen_dropdown_value v`;

function normalizeDropdown(row: KaizenDropdownValue): KaizenDropdownValue {
  return { ...row, is_active: Boolean(row.is_active), usage_count: Number(row.usage_count), sort_order: Number(row.sort_order) };
}

/** Every value of every list (active and inactive), in display order. */
export async function listDropdownValues(): Promise<KaizenDropdownValue[]> {
  const [rows] = await pool.query(`${DROPDOWN_SELECT} ORDER BY v.list_key, v.sort_order, v.label`);
  return (rows as KaizenDropdownValue[]).map(normalizeDropdown);
}

export async function getDropdownValue(id: number): Promise<KaizenDropdownValue | null> {
  const [rows] = await pool.query(`${DROPDOWN_SELECT} WHERE v.value_id = ?`, [id]);
  const row = (rows as KaizenDropdownValue[])[0];
  return row ? normalizeDropdown(row) : null;
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export interface DropdownInput {
  listKey?: string;
  label?: string;
  sortOrder?: number;
  color?: string;
  isActive?: boolean;
}

async function labelTaken(listKey: string, label: string, excludeId: number): Promise<boolean> {
  const [rows] = await pool.query(
    'SELECT 1 FROM kaizen_dropdown_value WHERE list_key = ? AND label = ? AND value_id <> ? LIMIT 1',
    [listKey, label, excludeId],
  );
  return (rows as unknown[]).length > 0;
}

async function validateDropdown(listKey: string, label: string, color: string, sortOrder: number, excludeId: number) {
  if (!KAIZEN_LISTS.includes(listKey as KaizenListKey)) throw new KaizenValidationError('dropdown.list', 'Unknown list.', 'listKey');
  if (!label) throw new KaizenValidationError('dropdown.label', 'Label is required.', 'label');
  if (label.length > 100) throw new KaizenValidationError('dropdown.labelLength', 'Labels are limited to 100 characters.', 'label');
  if (!COLOR_RE.test(color)) throw new KaizenValidationError('dropdown.color', 'Colour must be a hex value like #4d88c4.', 'color');
  if (!Number.isInteger(sortOrder)) throw new KaizenValidationError('dropdown.sortOrder', 'Sort order must be a whole number.', 'sortOrder');
  if (await labelTaken(listKey, label, excludeId)) {
    throw new KaizenValidationError('dropdown.duplicate', `"${label}" already exists in this list.`, 'label');
  }
}

export async function createDropdownValue(input: DropdownInput, actorUserId: number): Promise<KaizenDropdownValue> {
  const listKey = String(input.listKey ?? '');
  const label = (input.label ?? '').trim();
  const color = (input.color ?? '#4d88c4').trim();
  let sortOrder = input.sortOrder;
  if (sortOrder === undefined) {
    const [rows] = await pool.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM kaizen_dropdown_value WHERE list_key = ?', [listKey]);
    sortOrder = Number((rows as { next: number }[])[0]?.next ?? 1);
  }
  await validateDropdown(listKey, label, color, sortOrder, -1);
  const [result] = await pool.query(
    `INSERT INTO kaizen_dropdown_value (list_key, label, sort_order, color, is_active, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [listKey, label, sortOrder, color, input.isActive ?? true, actorUserId, actorUserId],
  );
  const row = await getDropdownValue((result as { insertId: number }).insertId);
  if (!row) throw new ValidationError('Value not found after creation.');
  await writeAuditLog({ entityType: KAIZEN_DROPDOWN_ENTITY, entityId: String(row.value_id), action: 'CREATE', changedBy: actorUserId, after: row });
  return row;
}

export async function updateDropdownValue(id: number, input: DropdownInput, actorUserId: number): Promise<KaizenDropdownValue> {
  const existing = await getDropdownValue(id);
  if (!existing) throw new KaizenValidationError('dropdown.notFound', 'Value not found.');
  const label = input.label !== undefined ? input.label.trim() : existing.label;
  const color = input.color !== undefined ? input.color.trim() : existing.color;
  const sortOrder = input.sortOrder !== undefined ? input.sortOrder : existing.sort_order;
  const isActive = input.isActive !== undefined ? input.isActive : existing.is_active;
  await validateDropdown(existing.list_key, label, color, sortOrder, id);
  await pool.query(
    'UPDATE kaizen_dropdown_value SET label = ?, sort_order = ?, color = ?, is_active = ?, updated_by = ? WHERE value_id = ?',
    [label, sortOrder, color, isActive, actorUserId, id],
  );
  const row = await getDropdownValue(id);
  if (!row) throw new ValidationError('Value not found after update.');
  await writeAuditLog({ entityType: KAIZEN_DROPDOWN_ENTITY, entityId: String(id), action: 'UPDATE', changedBy: actorUserId, before: existing, after: row });
  return row;
}

/** Rewrites one list's sort order to match `orderedIds` (1, 2, 3, ...). Every id must belong to
 * the list, and every value of the list must be present. */
export async function reorderDropdownValues(listKey: string, orderedIds: number[], actorUserId: number): Promise<void> {
  if (!KAIZEN_LISTS.includes(listKey as KaizenListKey)) throw new KaizenValidationError('dropdown.list', 'Unknown list.');
  const [rows] = await pool.query('SELECT value_id FROM kaizen_dropdown_value WHERE list_key = ?', [listKey]);
  const ids = new Set((rows as { value_id: number }[]).map((r) => r.value_id));
  if (orderedIds.length !== ids.size || new Set(orderedIds).size !== ids.size || !orderedIds.every((id) => ids.has(id))) {
    throw new KaizenValidationError('dropdown.reorder', 'The new order must list every value of this list exactly once.');
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const [index, id] of orderedIds.entries()) {
      await conn.query('UPDATE kaizen_dropdown_value SET sort_order = ?, updated_by = ? WHERE value_id = ?', [index + 1, actorUserId, id]);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  await writeAuditLog({ entityType: KAIZEN_DROPDOWN_ENTITY, entityId: listKey, action: 'UPDATE', changedBy: actorUserId, after: { order: orderedIds } });
}

/** Hard delete, only for a value no card has ever used (soft-deleted cards count too: they still
 * reference it). A used value can only be deactivated. */
export async function deleteDropdownValue(id: number, actorUserId: number): Promise<void> {
  const existing = await getDropdownValue(id);
  if (!existing) throw new KaizenValidationError('dropdown.notFound', 'Value not found.');
  if (existing.usage_count > 0) {
    throw new KaizenValidationError(
      'dropdown.inUse',
      `This value is used by ${existing.usage_count} card(s) and can only be deactivated, not deleted.`,
    );
  }
  await pool.query('DELETE FROM kaizen_dropdown_value WHERE value_id = ?', [id]);
  await writeAuditLog({ entityType: KAIZEN_DROPDOWN_ENTITY, entityId: String(id), action: 'DELETE', changedBy: actorUserId, before: existing });
}

// ---------------------------------------------------------------------------
// Cards: filters
// ---------------------------------------------------------------------------

export interface KaizenFilters {
  dateFrom?: string;
  dateTo?: string;
  departmentIds?: number[];
  typeIds?: number[];
  priorityIds?: number[];
  status?: KaizenStatus;
  search?: string;
  overdue?: boolean;
  /** Exact Card Creator (case-insensitive, per the column collation). */
  creator?: string;
  /** Exact Responsible Party; '' means "(Not assigned)". */
  responsibleParty?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidIsoDate(value: string): boolean {
  return ISO_DATE.test(value) && DateTime.fromISO(value).isValid;
}

/** WHERE clause over kaizen_cards aliased `c`; always excludes soft-deleted cards. */
export function buildCardWhere(filters: KaizenFilters): { where: string; params: unknown[] } {
  const clauses = ['c.deleted_at IS NULL'];
  const params: unknown[] = [];
  if (filters.dateFrom && isValidIsoDate(filters.dateFrom)) {
    clauses.push('c.card_date >= ?');
    params.push(filters.dateFrom);
  }
  if (filters.dateTo && isValidIsoDate(filters.dateTo)) {
    clauses.push('c.card_date <= ?');
    params.push(filters.dateTo);
  }
  const inList = (column: string, ids?: number[]) => {
    if (ids && ids.length > 0) {
      clauses.push(`${column} IN (?)`);
      params.push(ids);
    }
  };
  inList('c.department_id', filters.departmentIds);
  inList('c.card_type_id', filters.typeIds);
  inList('c.priority_id', filters.priorityIds);
  if (filters.status === 'OPEN' || filters.status === 'CLOSED') {
    clauses.push('c.status = ?');
    params.push(filters.status);
  }
  if (filters.overdue) {
    clauses.push("c.status = 'OPEN' AND c.expected_date IS NOT NULL AND c.expected_date < ?");
    params.push(kaizenToday());
  }
  if (filters.creator !== undefined && filters.creator !== '') {
    clauses.push('c.creator_name = ?');
    params.push(filters.creator.trim());
  }
  if (filters.responsibleParty !== undefined) {
    if (filters.responsibleParty.trim() === '') {
      clauses.push("(c.responsible_party IS NULL OR c.responsible_party = '')");
    } else {
      clauses.push('c.responsible_party = ?');
      params.push(filters.responsibleParty.trim());
    }
  }
  const search = filters.search?.trim();
  if (search) {
    const like = `%${search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const no = Number(search.replace(/^#/, ''));
    clauses.push(
      `(c.card_name LIKE ? OR c.issue LIKE ? OR c.creator_name LIKE ? OR c.responsible_party LIKE ?${Number.isInteger(no) && no > 0 ? ' OR c.card_no = ?' : ''})`,
    );
    params.push(like, like, like, like);
    if (Number.isInteger(no) && no > 0) params.push(no);
  }
  return { where: `WHERE ${clauses.join(' AND ')}`, params };
}

// ---------------------------------------------------------------------------
// Cards: reads
// ---------------------------------------------------------------------------

const CARD_SELECT = `
  SELECT c.card_no, c.creator_name, DATE_FORMAT(c.card_date, '%Y-%m-%d') AS card_date, c.department_id, c.card_name,
         c.card_type_id, c.issue, c.root_cause, c.impact, c.priority_id, c.proposed_solution,
         DATE_FORMAT(c.expected_date, '%Y-%m-%d') AS expected_date, DATE_FORMAT(c.closer_date, '%Y-%m-%d') AS closer_date,
         c.responsible_party, c.status, c.source,
         cu.display_name AS created_by_name, c.created_at, uu.display_name AS updated_by_name, c.updated_at
    FROM kaizen_cards c
    LEFT JOIN app_user cu ON cu.user_id = c.created_by
    LEFT JOIN app_user uu ON uu.user_id = c.updated_by`;

const SORT_COLUMNS: Record<string, string> = {
  card_no: 'c.card_no',
  card_date: 'c.card_date',
  card_name: 'c.card_name',
  status: 'c.status',
  expected_date: 'c.expected_date',
  closer_date: 'c.closer_date',
  responsible_party: 'c.responsible_party',
};

function withOverdue(row: KaizenCard, today: string): KaizenCard {
  return {
    ...row,
    card_no: Number(row.card_no),
    is_overdue: row.status === 'OPEN' && row.expected_date !== null && row.expected_date < today,
  };
}

/** Upper bound on one list response; the Kaizen table is small (tens to hundreds of cards). */
export const KAIZEN_LIST_LIMIT = 5000;

export async function listCards(
  filters: KaizenFilters,
  sort: { by?: string; dir?: string } = {},
): Promise<{ rows: KaizenCard[]; total: number }> {
  const { where, params } = buildCardWhere(filters);
  const column = SORT_COLUMNS[sort.by ?? ''] ?? 'c.card_no';
  const dir = sort.dir === 'asc' ? 'ASC' : 'DESC';
  const [countRows] = await pool.query(`SELECT COUNT(*) AS total FROM kaizen_cards c ${where}`, params);
  const total = Number((countRows as { total: number }[])[0]?.total ?? 0);
  const [rows] = await pool.query(`${CARD_SELECT} ${where} ORDER BY ${column} ${dir}, c.card_no DESC LIMIT ?`, [
    ...params,
    KAIZEN_LIST_LIMIT,
  ]);
  const today = kaizenToday();
  return { rows: (rows as KaizenCard[]).map((r) => withOverdue(r, today)), total };
}

export async function getCard(cardNo: number): Promise<KaizenCard | null> {
  const [rows] = await pool.query(`${CARD_SELECT} WHERE c.card_no = ? AND c.deleted_at IS NULL`, [cardNo]);
  const row = (rows as KaizenCard[])[0];
  return row ? withOverdue(row, kaizenToday()) : null;
}

/** Distinct previously used values, for the form's autocomplete (keeps spelling consistent). */
export async function getSuggestions(): Promise<{ responsibleParties: string[]; creators: string[] }> {
  const [rp] = await pool.query(
    `SELECT responsible_party AS v FROM kaizen_cards
      WHERE deleted_at IS NULL AND responsible_party IS NOT NULL AND responsible_party <> ''
      GROUP BY responsible_party ORDER BY COUNT(*) DESC, responsible_party LIMIT 500`,
  );
  const [cr] = await pool.query(
    `SELECT creator_name AS v FROM kaizen_cards WHERE deleted_at IS NULL
      GROUP BY creator_name ORDER BY COUNT(*) DESC, creator_name LIMIT 500`,
  );
  return {
    responsibleParties: (rp as { v: string }[]).map((r) => r.v),
    creators: (cr as { v: string }[]).map((r) => r.v),
  };
}

// ---------------------------------------------------------------------------
// Cards: validation + writes
// ---------------------------------------------------------------------------

export interface CardInput {
  creatorName?: unknown;
  cardDate?: unknown;
  departmentId?: unknown;
  cardName?: unknown;
  cardTypeId?: unknown;
  issue?: unknown;
  rootCause?: unknown;
  impact?: unknown;
  priorityId?: unknown;
  proposedSolution?: unknown;
  expectedDate?: unknown;
  closerDate?: unknown;
  responsibleParty?: unknown;
  status?: unknown;
}

/** The validated, database-ready shape of a card. */
export interface CardValues {
  creator_name: string;
  card_date: string;
  department_id: number;
  card_name: string;
  card_type_id: number;
  issue: string;
  root_cause: string | null;
  impact: string | null;
  priority_id: number;
  proposed_solution: string | null;
  expected_date: string | null;
  closer_date: string | null;
  responsible_party: string | null;
  status: KaizenStatus;
}

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

function optionalText(value: unknown): string | null {
  const t = text(value);
  return t === '' ? null : t;
}

function optionalDate(value: unknown, field: string, code: string, label: string): string | null {
  const t = text(value);
  if (t === '') return null;
  if (!isValidIsoDate(t)) throw new KaizenValidationError(code, `${label} is not a valid date.`, field);
  return t;
}

/**
 * Pure field rules (unit-tested): required fields, lengths, date formats and ordering, and the
 * Status/Closer Date pairing. Dropdown existence/activeness needs the database and is checked by
 * assertDropdowns.
 */
export function validateCardValues(input: CardInput): CardValues {
  const creator_name = text(input.creatorName);
  if (!creator_name) throw new KaizenValidationError('card.creatorRequired', 'Card Creator is required.', 'creatorName');
  if (creator_name.length > 150) throw new KaizenValidationError('card.creatorLength', 'Card Creator is limited to 150 characters.', 'creatorName');

  const card_date = text(input.cardDate);
  if (!card_date) throw new KaizenValidationError('card.dateRequired', 'Date is required.', 'cardDate');
  if (!isValidIsoDate(card_date)) throw new KaizenValidationError('card.dateInvalid', 'Date is not a valid date.', 'cardDate');

  const card_name = text(input.cardName);
  if (!card_name) throw new KaizenValidationError('card.nameRequired', 'Card Name is required.', 'cardName');
  if (card_name.length > 200) throw new KaizenValidationError('card.nameLength', 'Card Name is limited to 200 characters.', 'cardName');

  const idOf = (value: unknown, field: string, code: string, label: string): number => {
    const n = Number(value);
    if (value === undefined || value === null || value === '' || !Number.isInteger(n) || n <= 0) {
      throw new KaizenValidationError(code, `${label} is required.`, field);
    }
    return n;
  };
  const department_id = idOf(input.departmentId, 'departmentId', 'card.departmentRequired', 'Department');
  const card_type_id = idOf(input.cardTypeId, 'cardTypeId', 'card.typeRequired', 'Card Type');
  const priority_id = idOf(input.priorityId, 'priorityId', 'card.priorityRequired', 'Card Priority');

  const issue = text(input.issue);
  if (!issue) throw new KaizenValidationError('card.issueRequired', 'Issue is required.', 'issue');

  const expected_date = optionalDate(input.expectedDate, 'expectedDate', 'card.expectedInvalid', 'Expected Date');
  if (expected_date && expected_date < card_date) {
    throw new KaizenValidationError('card.expectedBeforeDate', 'Expected Date cannot be before the card Date.', 'expectedDate');
  }

  const statusText = text(input.status).toUpperCase() || 'OPEN';
  if (statusText !== 'OPEN' && statusText !== 'CLOSED') throw new KaizenValidationError('card.statusInvalid', 'Status must be Open or Closed.', 'status');
  const status = statusText as KaizenStatus;

  const closer_date = optionalDate(input.closerDate, 'closerDate', 'card.closerInvalid', 'Closer Date');
  if (status === 'CLOSED' && !closer_date) {
    throw new KaizenValidationError('card.closerRequired', 'Closer Date is required when the card is Closed.', 'closerDate');
  }
  if (status === 'OPEN' && closer_date) {
    throw new KaizenValidationError('card.closerOnlyWhenClosed', 'Closer Date must be empty while the card is Open.', 'closerDate');
  }
  if (closer_date && closer_date < card_date) {
    throw new KaizenValidationError('card.closerBeforeDate', 'Closer Date cannot be before the card Date.', 'closerDate');
  }

  const responsible_party = optionalText(input.responsibleParty);
  if (responsible_party && responsible_party.length > 150) {
    throw new KaizenValidationError('card.responsibleLength', 'Responsible Party is limited to 150 characters.', 'responsibleParty');
  }

  return {
    creator_name,
    card_date,
    department_id,
    card_name,
    card_type_id,
    issue,
    root_cause: optionalText(input.rootCause),
    impact: optionalText(input.impact),
    priority_id,
    proposed_solution: optionalText(input.proposedSolution),
    expected_date,
    closer_date,
    responsible_party,
    status,
  };
}

const LIST_FIELD: Record<KaizenListKey, { field: string; code: string }> = {
  department: { field: 'departmentId', code: 'card.departmentInvalid' },
  card_type: { field: 'cardTypeId', code: 'card.typeInvalid' },
  card_priority: { field: 'priorityId', code: 'card.priorityInvalid' },
};

/** Each dropdown id must exist in its own list and be active -- unless the card already had that
 * value (a deactivated value stays on the cards that use it; it just can't be newly chosen). */
async function assertDropdowns(values: CardValues, previous: CardValues | null): Promise<void> {
  const checks: [KaizenListKey, number, number | undefined][] = [
    ['department', values.department_id, previous?.department_id],
    ['card_type', values.card_type_id, previous?.card_type_id],
    ['card_priority', values.priority_id, previous?.priority_id],
  ];
  for (const [listKey, id, prevId] of checks) {
    const [rows] = await pool.query('SELECT is_active FROM kaizen_dropdown_value WHERE value_id = ? AND list_key = ?', [id, listKey]);
    const row = (rows as { is_active: number }[])[0];
    const { field, code } = LIST_FIELD[listKey];
    if (!row) throw new KaizenValidationError(code, 'Selected value does not exist.', field);
    if (!row.is_active && id !== prevId) throw new KaizenValidationError('card.valueInactive', 'Selected value is no longer active.', field);
  }
}

const INSERT_COLUMNS = [
  'creator_name', 'card_date', 'department_id', 'card_name', 'card_type_id', 'issue', 'root_cause', 'impact',
  'priority_id', 'proposed_solution', 'expected_date', 'closer_date', 'responsible_party', 'status',
] as const;

/** Inserts a validated card. `cardNo` is only passed by the one-time import (to keep the numbers
 * already written on the physical board); normal entry always takes the next number. */
export async function insertCardValues(
  db: Pick<PoolConnection, 'query'> | typeof pool,
  values: CardValues,
  actorUserId: number,
  opts: { cardNo?: number; source?: 'MANUAL' | 'IMPORT' } = {},
): Promise<number> {
  const columns = [...INSERT_COLUMNS, 'source', 'created_by', 'updated_by'];
  const params: unknown[] = [...INSERT_COLUMNS.map((c) => values[c]), opts.source ?? 'MANUAL', actorUserId, actorUserId];
  if (opts.cardNo !== undefined) {
    columns.unshift('card_no');
    params.unshift(opts.cardNo);
  }
  const [result] = await db.query(
    `INSERT INTO kaizen_cards (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    params,
  );
  return (result as { insertId: number }).insertId;
}

export async function createCard(input: CardInput, actorUserId: number): Promise<KaizenCard> {
  const values = validateCardValues(input);
  await assertDropdowns(values, null);
  const cardNo = await insertCardValues(pool, values, actorUserId);
  const card = await getCard(cardNo);
  if (!card) throw new ValidationError('Card not found after creation.');
  await writeAuditLog({ entityType: KAIZEN_CARD_ENTITY, entityId: String(cardNo), action: 'CREATE', changedBy: actorUserId, after: card });
  return card;
}

function cardToInput(card: KaizenCard): CardInput {
  return {
    creatorName: card.creator_name,
    cardDate: card.card_date,
    departmentId: card.department_id,
    cardName: card.card_name,
    cardTypeId: card.card_type_id,
    issue: card.issue,
    rootCause: card.root_cause,
    impact: card.impact,
    priorityId: card.priority_id,
    proposedSolution: card.proposed_solution,
    expectedDate: card.expected_date,
    closerDate: card.closer_date,
    responsibleParty: card.responsible_party,
    status: card.status,
  };
}

/** Partial update: fields left out keep their current value; the merged card is validated whole. */
export async function updateCard(cardNo: number, input: CardInput, actorUserId: number): Promise<KaizenCard> {
  const existing = await getCard(cardNo);
  if (!existing) throw new KaizenValidationError('card.notFound', 'Card not found.');
  const merged: CardInput = { ...cardToInput(existing) };
  for (const [key, value] of Object.entries(input)) if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  const values = validateCardValues(merged);
  await assertDropdowns(values, validateCardValues(cardToInput(existing)));
  await pool.query(
    `UPDATE kaizen_cards SET ${INSERT_COLUMNS.map((c) => `${c} = ?`).join(', ')}, updated_by = ? WHERE card_no = ? AND deleted_at IS NULL`,
    [...INSERT_COLUMNS.map((c) => values[c]), actorUserId, cardNo],
  );
  const card = await getCard(cardNo);
  if (!card) throw new ValidationError('Card not found after update.');
  await writeAuditLog({ entityType: KAIZEN_CARD_ENTITY, entityId: String(cardNo), action: 'UPDATE', changedBy: actorUserId, before: existing, after: card });
  return card;
}

/** Quick "Close card": Status = Closed with the given Closer Date (default today). */
export async function closeCard(cardNo: number, closerDate: unknown, actorUserId: number): Promise<KaizenCard> {
  const date = text(closerDate) || kaizenToday();
  return updateCard(cardNo, { status: 'CLOSED', closerDate: date }, actorUserId);
}

/** Soft delete: the row (and its number) stays; it just drops out of every list and the dashboard. */
export async function deleteCard(cardNo: number, actorUserId: number): Promise<void> {
  const existing = await getCard(cardNo);
  if (!existing) throw new KaizenValidationError('card.notFound', 'Card not found.');
  await pool.query('UPDATE kaizen_cards SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ? WHERE card_no = ?', [actorUserId, cardNo]);
  await writeAuditLog({ entityType: KAIZEN_CARD_ENTITY, entityId: String(cardNo), action: 'DELETE', changedBy: actorUserId, before: existing });
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface KaizenCountByValue {
  value_id: number;
  count: number;
}

export interface KaizenDashboard {
  total: number;
  open: number;
  closed: number;
  overdue: number;
  /** Mean (Closer Date - Date) in days over Closed cards; null when none are closed. */
  avgDaysToClose: number | null;
  closedCount: number;
  topDepartment: KaizenCountByValue | null;
  topSubmitter: { name: string; count: number } | null;
  topType: KaizenCountByValue | null;
  byDepartment: KaizenCountByValue[];
  byPriority: KaizenCountByValue[];
  byType: KaizenCountByValue[];
  /** Every Responsible Party, most cards first, split by status; name null = "(Not assigned)". */
  byResponsible: { name: string | null; count: number; open: number; closed: number }[];
}

async function countBy(column: string, where: string, params: unknown[]): Promise<KaizenCountByValue[]> {
  // Ties broken by the list's own sort order, so "top" is stable and matches the chart order.
  const [rows] = await pool.query(
    `SELECT c.${column} AS value_id, COUNT(*) AS count
       FROM kaizen_cards c JOIN kaizen_dropdown_value v ON v.value_id = c.${column}
       ${where}
      GROUP BY c.${column}, v.sort_order
      ORDER BY count DESC, v.sort_order`,
    params,
  );
  return (rows as KaizenCountByValue[]).map((r) => ({ value_id: Number(r.value_id), count: Number(r.count) }));
}

export async function getDashboard(filters: Pick<KaizenFilters, 'dateFrom' | 'dateTo' | 'departmentIds'>): Promise<KaizenDashboard> {
  const { where, params } = buildCardWhere(filters);
  const [summaryRows] = await pool.query(
    `SELECT COUNT(*) AS total,
            SUM(c.status = 'OPEN') AS open_count,
            SUM(c.status = 'CLOSED') AS closed_count,
            SUM(c.status = 'OPEN' AND c.expected_date IS NOT NULL AND c.expected_date < ?) AS overdue_count,
            AVG(CASE WHEN c.status = 'CLOSED' THEN DATEDIFF(c.closer_date, c.card_date) END) AS avg_days
       FROM kaizen_cards c ${where}`,
    [kaizenToday(), ...params],
  );
  const s = (summaryRows as Record<string, unknown>[])[0] ?? {};

  const [byDepartment, byPriority, byType] = await Promise.all([
    countBy('department_id', where, params),
    countBy('priority_id', where, params),
    countBy('card_type_id', where, params),
  ]);

  const [submitterRows] = await pool.query(
    `SELECT MIN(c.creator_name) AS name, COUNT(*) AS count FROM kaizen_cards c ${where}
      GROUP BY c.creator_name ORDER BY count DESC, name LIMIT 1`,
    params,
  );
  const [responsibleRows] = await pool.query(
    `SELECT NULLIF(TRIM(c.responsible_party), '') AS name, COUNT(*) AS count,
            SUM(c.status = 'OPEN') AS open_count, SUM(c.status = 'CLOSED') AS closed_count
       FROM kaizen_cards c ${where}
      GROUP BY NULLIF(TRIM(c.responsible_party), '') ORDER BY count DESC, name IS NULL, name`,
    params,
  );
  const submitter = (submitterRows as { name: string; count: number }[])[0];
  const closedCount = Number(s.closed_count ?? 0);
  const avg = s.avg_days === null || s.avg_days === undefined ? null : Number(s.avg_days);

  return {
    total: Number(s.total ?? 0),
    open: Number(s.open_count ?? 0),
    closed: closedCount,
    overdue: Number(s.overdue_count ?? 0),
    avgDaysToClose: closedCount > 0 && avg !== null ? Math.round(avg * 10) / 10 : null,
    closedCount,
    topDepartment: byDepartment[0] ?? null,
    topSubmitter: submitter ? { name: submitter.name, count: Number(submitter.count) } : null,
    topType: byType[0] ?? null,
    byDepartment,
    byPriority,
    byType,
    byResponsible: (responsibleRows as { name: string | null; count: number; open_count: number; closed_count: number }[]).map((r) => ({
      name: r.name,
      count: Number(r.count),
      open: Number(r.open_count),
      closed: Number(r.closed_count),
    })),
  };
}
