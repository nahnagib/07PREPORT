import { pool } from '../db/pool';
import { ValidationError } from '../lib/errors';

/**
 * Admin-controlled Official Holidays for the Critical Number page -- same overlay/history pattern
 * as companyAdminService.ts (see that file's header, and
 * data/warehouse/migrations/0020_holidays_closures_admin.sql), just without an ETL-link concept
 * (a holiday has no corresponding Dim_* row to link against).
 *
 * Read by backend/src/measures/criticalNumber.ts's fetchOfficialHolidayRows for the Working Days /
 * Official Holidays YTD / Missing Value/Days measures -- edits here are visible on the very next
 * Critical Number page load, no ETL run required.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export interface HolidayRow {
  holiday_id: number;
  holiday_name: string;
  holiday_date: string;
  recurring: boolean;
  company: string | null;
  is_active: boolean;
  created_at: string;
  created_by_email: string | null;
  updated_at: string;
  updated_by_email: string | null;
}

// DATE_FORMAT'd rather than selected raw -- mysql2 (no dateStrings option set, see db/pool.ts)
// returns a plain DATE column as a JS Date, which res.json()'s JSON.stringify would turn into a
// full ISO datetime ("2026-01-01T00:00:00.000Z") instead of the plain "2026-01-01" a native
// <input type="date"> needs back verbatim.
const BASE_SELECT = `
  SELECT
    h.holiday_id, h.holiday_name, DATE_FORMAT(h.holiday_date, '%Y-%m-%d') AS holiday_date,
    h.recurring, h.company, h.is_active,
    h.created_at, cu.email AS created_by_email,
    h.updated_at, uu.email AS updated_by_email
  FROM official_holidays h
  LEFT JOIN app_user cu ON cu.user_id = h.created_by
  LEFT JOIN app_user uu ON uu.user_id = h.updated_by
`;

function withBool(row: HolidayRow): HolidayRow {
  return { ...row, recurring: Boolean(row.recurring), is_active: Boolean(row.is_active) };
}

export interface ListHolidaysFilters {
  isActive?: boolean;
  search?: string;
  page: number;
  pageSize: number;
}

export async function listHolidays(filters: ListHolidaysFilters): Promise<{ rows: HolidayRow[]; total: number }> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.isActive !== undefined) {
    clauses.push('h.is_active = ?');
    params.push(filters.isActive);
  }
  if (filters.search) {
    clauses.push('(h.holiday_name LIKE ? OR h.company LIKE ?)');
    params.push(`%${filters.search}%`, `%${filters.search}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const [countRows] = await pool.query(`SELECT COUNT(*) AS total FROM official_holidays h ${where}`, params);
  const total = (countRows as { total: number }[])[0]?.total ?? 0;

  const offset = Math.max(0, (filters.page - 1) * filters.pageSize);
  const [rows] = await pool.query(
    `${BASE_SELECT} ${where} ORDER BY h.holiday_date, h.holiday_name LIMIT ? OFFSET ?`,
    [...params, filters.pageSize, offset],
  );
  return { rows: (rows as HolidayRow[]).map(withBool), total };
}

export async function getHolidayById(id: number): Promise<HolidayRow | null> {
  const [rows] = await pool.query(`${BASE_SELECT} WHERE h.holiday_id = ?`, [id]);
  const row = (rows as HolidayRow[])[0];
  return row ? withBool(row) : null;
}

async function recordHistory(
  holidayId: number,
  row: { holiday_name: string; holiday_date: string; recurring: boolean; company: string | null; is_active: boolean },
  action: 'CREATE' | 'UPDATE' | 'DEACTIVATE' | 'REACTIVATE' | 'DELETE',
  actorUserId: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO official_holidays_history
       (holiday_id, holiday_name, holiday_date, recurring, company, is_active, action, changed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [holidayId, row.holiday_name, row.holiday_date, row.recurring, row.company, row.is_active, action, actorUserId],
  );
}

function validateDate(date: string): void {
  if (!DATE_ONLY.test(date)) throw new ValidationError('Holiday date must be in YYYY-MM-DD format.');
}

export interface CreateHolidayInput {
  holidayName: string;
  holidayDate: string;
  recurring?: boolean;
  company?: string | null;
}

export async function createHoliday(input: CreateHolidayInput, actorUserId: number): Promise<HolidayRow> {
  const holidayName = input.holidayName?.trim();
  if (!holidayName) throw new ValidationError('Holiday name is required.');
  if (!input.holidayDate) throw new ValidationError('Holiday date is required.');
  validateDate(input.holidayDate);

  const recurring = input.recurring ?? false;
  const company = input.company ?? null;

  const [result] = await pool.query(
    `INSERT INTO official_holidays (holiday_name, holiday_date, recurring, company, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [holidayName, input.holidayDate, recurring, company, actorUserId, actorUserId],
  );
  const id = (result as { insertId: number }).insertId;
  await recordHistory(id, { holiday_name: holidayName, holiday_date: input.holidayDate, recurring, company, is_active: true }, 'CREATE', actorUserId);

  const row = await getHolidayById(id);
  if (!row) throw new ValidationError('Holiday not found after creation.');
  return row;
}

export interface UpdateHolidayInput {
  holidayName?: string;
  holidayDate?: string;
  recurring?: boolean;
  company?: string | null;
  isActive?: boolean;
}

export async function updateHoliday(id: number, input: UpdateHolidayInput, actorUserId: number): Promise<HolidayRow> {
  const existing = await getHolidayById(id);
  if (!existing) throw new ValidationError('Holiday not found.');

  let holidayName = existing.holiday_name;
  if (input.holidayName !== undefined) {
    holidayName = input.holidayName.trim();
    if (!holidayName) throw new ValidationError('Holiday name cannot be empty.');
  }

  let holidayDate = existing.holiday_date;
  if (input.holidayDate !== undefined) {
    validateDate(input.holidayDate);
    holidayDate = input.holidayDate;
  }

  const recurring = input.recurring !== undefined ? input.recurring : existing.recurring;
  const company = input.company !== undefined ? input.company : existing.company;

  let isActive = existing.is_active;
  let action: 'UPDATE' | 'DEACTIVATE' | 'REACTIVATE' = 'UPDATE';
  if (input.isActive !== undefined && input.isActive !== existing.is_active) {
    action = input.isActive === false ? 'DEACTIVATE' : 'REACTIVATE';
    isActive = input.isActive;
  }

  await pool.query(
    `UPDATE official_holidays
     SET holiday_name = ?, holiday_date = ?, recurring = ?, company = ?, is_active = ?, updated_by = ?
     WHERE holiday_id = ?`,
    [holidayName, holidayDate, recurring, company, isActive, actorUserId, id],
  );
  await recordHistory(id, { holiday_name: holidayName, holiday_date: holidayDate, recurring, company, is_active: isActive }, action, actorUserId);

  const row = await getHolidayById(id);
  if (!row) throw new ValidationError('Holiday not found after update.');
  return row;
}

export async function deleteHoliday(id: number, actorUserId: number): Promise<void> {
  const existing = await getHolidayById(id);
  if (!existing) throw new ValidationError('Holiday not found.');
  await recordHistory(
    id,
    {
      holiday_name: existing.holiday_name,
      holiday_date: existing.holiday_date,
      recurring: existing.recurring,
      company: existing.company,
      is_active: existing.is_active,
    },
    'DELETE',
    actorUserId,
  );
  await pool.query('DELETE FROM official_holidays WHERE holiday_id = ?', [id]);
}
