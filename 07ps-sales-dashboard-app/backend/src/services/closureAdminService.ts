import { pool } from '../db/pool';
import { ValidationError } from '../lib/errors';

/**
 * Admin-controlled Forced Closures for the Critical Number page -- same overlay/history pattern as
 * holidayAdminService.ts (see that file's header, and
 * data/warehouse/migrations/0020_holidays_closures_admin.sql).
 *
 * Read by backend/src/measures/criticalNumber.ts's fetchForcedClosureRows for the Forced Closures
 * YTD card -- edits here are visible on the very next Critical Number page load, no ETL run
 * required. branch_key is an unenforced text reference to Dim_SalesTeam.SalesTeamKey (same
 * "no enforced key on the ETL side" situation companyAdminService.ts documents for etl_company_key)
 * -- validated against the live dimension on create/update, but not FK-enforced.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export interface ClosureRow {
  closure_id: number;
  branch_key: string;
  branch_name: string | null;
  company: string | null;
  closure_date: string;
  duration_days: number;
  reason: string | null;
  is_active: boolean;
  created_at: string;
  created_by_email: string | null;
  updated_at: string;
  updated_by_email: string | null;
}

// closure_date is DATE_FORMAT'd for the same reason holidayAdminService.ts's BASE_SELECT is --
// see that file's comment.
const BASE_SELECT = `
  SELECT
    c.closure_id, c.branch_key, st.SalesTeam AS branch_name, c.company,
    DATE_FORMAT(c.closure_date, '%Y-%m-%d') AS closure_date,
    c.duration_days, c.reason, c.is_active,
    c.created_at, cu.email AS created_by_email,
    c.updated_at, uu.email AS updated_by_email
  FROM forced_closures c
  LEFT JOIN dim_salesteam st ON st.SalesTeamKey = c.branch_key
  LEFT JOIN app_user cu ON cu.user_id = c.created_by
  LEFT JOIN app_user uu ON uu.user_id = c.updated_by
`;

function withBool(row: ClosureRow): ClosureRow {
  return { ...row, is_active: Boolean(row.is_active) };
}

export interface ListClosuresFilters {
  isActive?: boolean;
  branchKey?: string;
  search?: string;
  page: number;
  pageSize: number;
}

export async function listClosures(filters: ListClosuresFilters): Promise<{ rows: ClosureRow[]; total: number }> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.isActive !== undefined) {
    clauses.push('c.is_active = ?');
    params.push(filters.isActive);
  }
  if (filters.branchKey) {
    clauses.push('c.branch_key = ?');
    params.push(filters.branchKey);
  }
  if (filters.search) {
    clauses.push('(c.reason LIKE ? OR c.company LIKE ?)');
    params.push(`%${filters.search}%`, `%${filters.search}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const [countRows] = await pool.query(`SELECT COUNT(*) AS total FROM forced_closures c ${where}`, params);
  const total = (countRows as { total: number }[])[0]?.total ?? 0;

  const offset = Math.max(0, (filters.page - 1) * filters.pageSize);
  const [rows] = await pool.query(
    `${BASE_SELECT} ${where} ORDER BY c.closure_date DESC, c.branch_key LIMIT ? OFFSET ?`,
    [...params, filters.pageSize, offset],
  );
  return { rows: (rows as ClosureRow[]).map(withBool), total };
}

export async function getClosureById(id: number): Promise<ClosureRow | null> {
  const [rows] = await pool.query(`${BASE_SELECT} WHERE c.closure_id = ?`, [id]);
  const row = (rows as ClosureRow[])[0];
  return row ? withBool(row) : null;
}

async function branchExists(branchKey: string): Promise<boolean> {
  const [rows] = await pool.query('SELECT 1 FROM dim_salesteam WHERE SalesTeamKey = ? LIMIT 1', [branchKey]);
  return (rows as unknown[]).length > 0;
}

export interface BranchOption {
  branch_key: string;
  branch_name: string;
}

export async function getBranchOptions(): Promise<BranchOption[]> {
  const [rows] = await pool.query('SELECT SalesTeamKey AS branch_key, SalesTeam AS branch_name FROM dim_salesteam ORDER BY SalesTeam');
  return rows as BranchOption[];
}

async function recordHistory(
  closureId: number,
  row: { branch_key: string; company: string | null; closure_date: string; duration_days: number; reason: string | null; is_active: boolean },
  action: 'CREATE' | 'UPDATE' | 'DEACTIVATE' | 'REACTIVATE' | 'DELETE',
  actorUserId: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO forced_closures_history
       (closure_id, branch_key, company, closure_date, duration_days, reason, is_active, action, changed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [closureId, row.branch_key, row.company, row.closure_date, row.duration_days, row.reason, row.is_active, action, actorUserId],
  );
}

function validateDate(date: string): void {
  if (!DATE_ONLY.test(date)) throw new ValidationError('Closure date must be in YYYY-MM-DD format.');
}

export interface CreateClosureInput {
  branchKey: string;
  company?: string | null;
  closureDate: string;
  durationDays?: number;
  reason?: string | null;
}

export async function createClosure(input: CreateClosureInput, actorUserId: number): Promise<ClosureRow> {
  const branchKey = input.branchKey?.trim();
  if (!branchKey) throw new ValidationError('Branch is required.');
  if (!(await branchExists(branchKey))) throw new ValidationError('Invalid branch selected.');
  if (!input.closureDate) throw new ValidationError('Closure date is required.');
  validateDate(input.closureDate);
  const durationDays = input.durationDays ?? 1;
  if (durationDays < 1) throw new ValidationError('Duration must be at least 1 day.');

  const company = input.company ?? null;
  const reason = input.reason ?? null;

  const [result] = await pool.query(
    `INSERT INTO forced_closures (branch_key, company, closure_date, duration_days, reason, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [branchKey, company, input.closureDate, durationDays, reason, actorUserId, actorUserId],
  );
  const id = (result as { insertId: number }).insertId;
  await recordHistory(id, { branch_key: branchKey, company, closure_date: input.closureDate, duration_days: durationDays, reason, is_active: true }, 'CREATE', actorUserId);

  const row = await getClosureById(id);
  if (!row) throw new ValidationError('Closure not found after creation.');
  return row;
}

export interface UpdateClosureInput {
  branchKey?: string;
  company?: string | null;
  closureDate?: string;
  durationDays?: number;
  reason?: string | null;
  isActive?: boolean;
}

export async function updateClosure(id: number, input: UpdateClosureInput, actorUserId: number): Promise<ClosureRow> {
  const existing = await getClosureById(id);
  if (!existing) throw new ValidationError('Closure not found.');

  let branchKey = existing.branch_key;
  if (input.branchKey !== undefined) {
    branchKey = input.branchKey.trim();
    if (!branchKey) throw new ValidationError('Branch cannot be empty.');
    if (!(await branchExists(branchKey))) throw new ValidationError('Invalid branch selected.');
  }

  let closureDate = existing.closure_date;
  if (input.closureDate !== undefined) {
    validateDate(input.closureDate);
    closureDate = input.closureDate;
  }

  let durationDays = existing.duration_days;
  if (input.durationDays !== undefined) {
    if (input.durationDays < 1) throw new ValidationError('Duration must be at least 1 day.');
    durationDays = input.durationDays;
  }

  const company = input.company !== undefined ? input.company : existing.company;
  const reason = input.reason !== undefined ? input.reason : existing.reason;

  let isActive = existing.is_active;
  let action: 'UPDATE' | 'DEACTIVATE' | 'REACTIVATE' = 'UPDATE';
  if (input.isActive !== undefined && input.isActive !== existing.is_active) {
    action = input.isActive === false ? 'DEACTIVATE' : 'REACTIVATE';
    isActive = input.isActive;
  }

  await pool.query(
    `UPDATE forced_closures
     SET branch_key = ?, company = ?, closure_date = ?, duration_days = ?, reason = ?, is_active = ?, updated_by = ?
     WHERE closure_id = ?`,
    [branchKey, company, closureDate, durationDays, reason, isActive, actorUserId, id],
  );
  await recordHistory(id, { branch_key: branchKey, company, closure_date: closureDate, duration_days: durationDays, reason, is_active: isActive }, action, actorUserId);

  const row = await getClosureById(id);
  if (!row) throw new ValidationError('Closure not found after update.');
  return row;
}

export async function deleteClosure(id: number, actorUserId: number): Promise<void> {
  const existing = await getClosureById(id);
  if (!existing) throw new ValidationError('Closure not found.');
  await recordHistory(
    id,
    {
      branch_key: existing.branch_key,
      company: existing.company,
      closure_date: existing.closure_date,
      duration_days: existing.duration_days,
      reason: existing.reason,
      is_active: existing.is_active,
    },
    'DELETE',
    actorUserId,
  );
  await pool.query('DELETE FROM forced_closures WHERE closure_id = ?', [id]);
}
