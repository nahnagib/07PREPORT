import { pool } from '../db/pool';
import { ValidationError } from '../lib/errors';
import { generateTempPassword, hashPassword, validatePasswordPolicy } from '../lib/password';
import { sendTempPasswordEmail } from './emailService';
import { recordLoginHistory } from './loginHistoryService';

export type UserStatus = 'ACTIVE' | 'INACTIVE' | 'LOCKED' | 'PENDING_PASSWORD_CHANGE';

export interface AppUserRow {
  user_id: number;
  email: string;
  display_name: string;
  company_scope: 'ALL' | 'MAJAAL' | 'TIKA';
  salesperson_key: number | null;
  is_active: number;
  created_at: Date;
  password_hash: string;
  status: UserStatus;
  must_change_password: number;
  last_login_at: Date | null;
  updated_at: Date;
  failed_login_count: number;
  password_changed_at: Date | null;
  password_reset_token_hash: string | null;
  password_reset_expires_at: Date | null;
  sessions_revoked_at: Date | null;
  role_id: number | null;
  role_name?: string | null;
  role_label?: string | null;
  role_tier_code?: string | null;
}

export interface RoleRow {
  role_id: number;
  role_name: string;
  role_label: string;
  default_role_tier_code: string | null;
  is_system: number;
}

const USER_WITH_ROLE_SELECT = `
  SELECT au.*, r.role_name, r.role_label, r.default_role_tier_code AS role_tier_code
  FROM app_user au
  LEFT JOIN roles r ON r.role_id = au.role_id
`;

export async function getUserByEmail(email: string): Promise<AppUserRow | null> {
  const [rows] = await pool.query(`${USER_WITH_ROLE_SELECT} WHERE au.email = ?`, [email]);
  return (rows as AppUserRow[])[0] ?? null;
}

export async function getUserById(userId: number): Promise<AppUserRow | null> {
  const [rows] = await pool.query(`${USER_WITH_ROLE_SELECT} WHERE au.user_id = ?`, [userId]);
  return (rows as AppUserRow[])[0] ?? null;
}

export async function listRoles(): Promise<RoleRow[]> {
  const [rows] = await pool.query('SELECT * FROM roles ORDER BY role_id');
  return rows as RoleRow[];
}

export async function getRoleById(roleId: number): Promise<RoleRow | null> {
  const [rows] = await pool.query('SELECT * FROM roles WHERE role_id = ?', [roleId]);
  return (rows as RoleRow[])[0] ?? null;
}

/** Keeps the existing role_tier-based data-scope assignment (user_role table) in sync with a
 * user's current business role's default scope tier. This is the ONLY place that table is
 * written from the auth module -- applySalespersonLock/filters.ts read scope off req.user
 * directly (see middleware/auth.ts), so user_role stays purely a record for the rest of the app
 * (e.g. role_dashboard_access) to keep working unmodified. */
async function syncRoleTierAssignment(userId: number, roleTierCode: string | null): Promise<void> {
  await pool.query('DELETE FROM user_role WHERE user_id = ?', [userId]);
  if (roleTierCode) {
    await pool.query('INSERT INTO user_role (user_id, role_code) VALUES (?, ?)', [userId, roleTierCode]);
  }
}

export interface CreateUserInput {
  fullName: string;
  email: string;
  roleId: number;
  status?: UserStatus;
  tempPassword?: string;
  salespersonKey?: number | null;
  companyScope?: 'ALL' | 'MAJAAL' | 'TIKA';
  sendEmail?: boolean;
}

export interface CreateUserResult {
  userId: number;
  tempPassword: string;
}

export async function createUser(input: CreateUserInput): Promise<CreateUserResult> {
  const existing = await getUserByEmail(input.email);
  if (existing) {
    throw new ValidationError('A user with this email already exists.');
  }
  const role = await getRoleById(input.roleId);
  if (!role) {
    throw new ValidationError('Unknown role.');
  }

  const tempPassword = input.tempPassword ?? generateTempPassword();
  const policyError = validatePasswordPolicy(tempPassword);
  if (policyError) {
    throw new ValidationError(policyError);
  }
  const passwordHash = await hashPassword(tempPassword);
  const status = input.status ?? 'PENDING_PASSWORD_CHANGE';
  const companyScope =
    input.companyScope ?? (role.role_name === 'TIKA_CEO' ? 'TIKA' : 'ALL');

  const [result] = await pool.query(
    `INSERT INTO app_user
       (email, display_name, company_scope, salesperson_key, is_active,
        password_hash, status, must_change_password, role_id)
     VALUES (?, ?, ?, ?, TRUE, ?, ?, TRUE, ?)`,
    [
      input.email,
      input.fullName,
      companyScope,
      input.salespersonKey ?? null,
      passwordHash,
      status,
      input.roleId,
    ],
  );
  const userId = (result as { insertId: number }).insertId;
  await syncRoleTierAssignment(userId, role.default_role_tier_code);

  if (input.sendEmail !== false) {
    await sendTempPasswordEmail(input.email, input.fullName, tempPassword);
  }

  return { userId, tempPassword };
}

export interface ListUsersFilters {
  search?: string;
  status?: UserStatus;
  roleId?: number;
  page: number;
  pageSize: number;
}

export async function listUsers(
  filters: ListUsersFilters,
): Promise<{ rows: AppUserRow[]; total: number }> {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filters.search) {
    clauses.push('(au.email LIKE ? OR au.display_name LIKE ?)');
    params.push(`%${filters.search}%`, `%${filters.search}%`);
  }
  if (filters.status) {
    clauses.push('au.status = ?');
    params.push(filters.status);
  }
  if (filters.roleId !== undefined) {
    clauses.push('au.role_id = ?');
    params.push(filters.roleId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const [countRows] = await pool.query(`SELECT COUNT(*) AS total FROM app_user au ${where}`, params);
  const total = (countRows as { total: number }[])[0]?.total ?? 0;

  const offset = Math.max(0, (filters.page - 1) * filters.pageSize);
  const [rows] = await pool.query(
    `${USER_WITH_ROLE_SELECT} ${where} ORDER BY au.created_at DESC LIMIT ? OFFSET ?`,
    [...params, filters.pageSize, offset],
  );

  return { rows: rows as AppUserRow[], total };
}

export interface UpdateUserInput {
  fullName?: string;
  salespersonKey?: number | null;
  companyScope?: 'ALL' | 'MAJAAL' | 'TIKA';
}

export async function updateUser(userId: number, input: UpdateUserInput): Promise<void> {
  const fields: string[] = [];
  const params: unknown[] = [];
  if (input.fullName !== undefined) {
    fields.push('display_name = ?');
    params.push(input.fullName);
  }
  if (input.salespersonKey !== undefined) {
    fields.push('salesperson_key = ?');
    params.push(input.salespersonKey);
  }
  if (input.companyScope !== undefined) {
    fields.push('company_scope = ?');
    params.push(input.companyScope);
  }
  if (fields.length === 0) return;
  params.push(userId);
  await pool.query(`UPDATE app_user SET ${fields.join(', ')} WHERE user_id = ?`, params);
}

export async function setUserStatus(
  userId: number,
  status: UserStatus,
  actorEmail: string,
): Promise<void> {
  await pool.query('UPDATE app_user SET status = ?, failed_login_count = 0 WHERE user_id = ?', [
    status,
    userId,
  ]);
  const user = await getUserById(userId);
  await recordLoginHistory({
    userId,
    emailAttempted: user?.email ?? '',
    eventType: 'ACCOUNT_STATUS_CHANGED',
  });
  void actorEmail; // reserved for a future actor-attribution column; not modeled yet
}

export async function changeUserRole(userId: number, roleId: number): Promise<void> {
  const role = await getRoleById(roleId);
  if (!role) throw new ValidationError('Unknown role.');
  await pool.query('UPDATE app_user SET role_id = ? WHERE user_id = ?', [roleId, userId]);
  await syncRoleTierAssignment(userId, role.default_role_tier_code);
}

export async function forcePasswordChange(userId: number): Promise<void> {
  await pool.query(
    `UPDATE app_user SET must_change_password = TRUE,
       status = IF(status = 'ACTIVE', 'PENDING_PASSWORD_CHANGE', status)
     WHERE user_id = ?`,
    [userId],
  );
  const user = await getUserById(userId);
  await recordLoginHistory({
    userId,
    emailAttempted: user?.email ?? '',
    eventType: 'FORCE_PASSWORD_CHANGE_SET',
  });
}

/** Admin-triggered reset: generates (or accepts) a new temp password, emails it, and revokes
 * every existing session for the user immediately (the "instantly invalid" half of the token
 * expiration requirement). */
export async function adminResetPassword(
  userId: number,
  explicitTempPassword?: string,
): Promise<{ tempPassword: string }> {
  const user = await getUserById(userId);
  if (!user) throw new ValidationError('User not found.');

  const tempPassword = explicitTempPassword ?? generateTempPassword();
  const policyError = validatePasswordPolicy(tempPassword);
  if (policyError) throw new ValidationError(policyError);
  const passwordHash = await hashPassword(tempPassword);

  await pool.query(
    `UPDATE app_user
     SET password_hash = ?, must_change_password = TRUE,
         status = IF(status = 'ACTIVE', 'PENDING_PASSWORD_CHANGE', status),
         password_changed_at = CURRENT_TIMESTAMP, sessions_revoked_at = CURRENT_TIMESTAMP,
         failed_login_count = 0
     WHERE user_id = ?`,
    [passwordHash, userId],
  );

  await sendTempPasswordEmail(user.email, user.display_name, tempPassword);
  await recordLoginHistory({ userId, emailAttempted: user.email, eventType: 'PASSWORD_CHANGED' });

  return { tempPassword };
}

export async function revokeSessions(userId: number): Promise<void> {
  await pool.query('UPDATE app_user SET sessions_revoked_at = CURRENT_TIMESTAMP WHERE user_id = ?', [
    userId,
  ]);
  const user = await getUserById(userId);
  await recordLoginHistory({
    userId,
    emailAttempted: user?.email ?? '',
    eventType: 'SESSIONS_REVOKED',
  });
}
