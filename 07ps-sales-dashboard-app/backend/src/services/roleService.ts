import type { PoolConnection } from 'mysql2/promise';
import { pool } from '../db/pool';
import { ValidationError } from '../lib/errors';
import {
  PERMISSION_REGISTRY,
  normalizePageActions,
  type PermissionAction,
} from '../config/permissionRegistry';
import { ADMIN_ROLE_NAME } from './permissionService';
import { writeAuditLog } from './auditLogService';

/**
 * Business roles: create / edit / duplicate / delete, their page permissions, and which roles each
 * user holds. Every change is written to audit_log (0025) with before/after snapshots.
 *
 * Built-in (is_system) roles can't be deleted. The Admin role is additionally locked: it can't be
 * renamed, its permissions can't be changed (it is evaluated as all-access anyway, see
 * permissionService), and the last active user holding it can't lose it.
 */

export const ROLE_ENTITY = 'role';
export const USER_ROLES_ENTITY = 'user_roles';

/** pageKey -> allowed actions (only registry actions, View implied by any other). */
export type RolePermissionSet = Record<string, PermissionAction[]>;

export interface RoleSummary {
  role_id: number;
  role_name: string;
  role_label: string;
  description: string | null;
  is_system: boolean;
  is_admin: boolean;
  default_role_tier_code: string | null;
  user_count: number;
  created_at: Date;
  updated_at: Date;
  created_by: number | null;
  created_by_name: string | null;
}

export interface RoleDetail extends RoleSummary {
  permissions: RolePermissionSet;
}

/** Thrown when deleting a role that still has users and no replacement role was given. */
export class RoleInUseError extends ValidationError {
  constructor(public readonly userCount: number) {
    super(`This role is assigned to ${userCount} user(s). Choose a replacement role for them before deleting it.`);
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const SUMMARY_SELECT = `
  SELECT r.role_id, r.role_name, r.role_label, r.description, r.is_system, r.default_role_tier_code,
         r.created_at, r.updated_at, r.created_by, cu.display_name AS created_by_name,
         (SELECT COUNT(*) FROM user_roles ur WHERE ur.role_id = r.role_id) AS user_count
    FROM roles r
    LEFT JOIN app_user cu ON cu.user_id = r.created_by`;

function toSummary(row: Record<string, unknown>): RoleSummary {
  return {
    role_id: Number(row.role_id),
    role_name: String(row.role_name),
    role_label: String(row.role_label),
    description: (row.description as string | null) ?? null,
    is_system: Boolean(row.is_system),
    is_admin: row.role_name === ADMIN_ROLE_NAME,
    default_role_tier_code: (row.default_role_tier_code as string | null) ?? null,
    user_count: Number(row.user_count ?? 0),
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
    created_by: row.created_by == null ? null : Number(row.created_by),
    created_by_name: (row.created_by_name as string | null) ?? null,
  };
}

export async function listRolesWithStats(): Promise<RoleSummary[]> {
  const [rows] = await pool.query(`${SUMMARY_SELECT} ORDER BY r.is_system DESC, r.role_label`);
  return (rows as Record<string, unknown>[]).map(toSummary);
}

async function getRoleSummary(roleId: number, db: Pick<PoolConnection, 'query'> = pool): Promise<RoleSummary | null> {
  const [rows] = await db.query(`${SUMMARY_SELECT} WHERE r.role_id = ?`, [roleId]);
  const row = (rows as Record<string, unknown>[])[0];
  return row ? toSummary(row) : null;
}

/** The role's allowed actions per registry page. The Admin role always reports everything. */
export async function getRolePermissionSet(
  roleId: number,
  db: Pick<PoolConnection, 'query'> = pool,
): Promise<RolePermissionSet> {
  const role = await getRoleSummary(roleId, db);
  if (role?.is_admin) return fullPermissionSet();
  const [rows] = await db.query(
    `SELECT pg.page_key, p.action
       FROM role_permissions rp
       JOIN permissions p ON p.permission_id = rp.permission_id
       JOIN pages pg ON pg.page_id = p.page_id
      WHERE rp.role_id = ? AND rp.allowed = TRUE`,
    [roleId],
  );
  const raw: Record<string, string[]> = {};
  for (const r of rows as { page_key: string; action: string }[]) (raw[r.page_key] ??= []).push(r.action);
  return normalizePermissionSet(raw, { dropViewless: true });
}

export async function getRoleDetail(roleId: number): Promise<RoleDetail | null> {
  const summary = await getRoleSummary(roleId);
  if (!summary) return null;
  return { ...summary, permissions: await getRolePermissionSet(roleId) };
}

export function fullPermissionSet(): RolePermissionSet {
  const out: RolePermissionSet = {};
  for (const e of PERMISSION_REGISTRY) out[e.key] = [...e.actions];
  return out;
}

/**
 * Cleans a requested permission set: unknown pages and actions a page doesn't have are dropped,
 * and View is added wherever any other action is present. With `dropViewless` (used when reading
 * stored rows) a page whose stored rows lack View is treated as no access instead -- that matches
 * how permissions are evaluated (no View means nothing on that page applies).
 */
export function normalizePermissionSet(
  input: Record<string, readonly string[]> | undefined,
  opts: { dropViewless?: boolean } = {},
): RolePermissionSet {
  const out: RolePermissionSet = {};
  for (const [pageKey, actions] of Object.entries(input ?? {})) {
    if (!Array.isArray(actions)) continue;
    if (opts.dropViewless && !actions.includes('view')) continue;
    const normalized = normalizePageActions(pageKey, actions);
    if (normalized.length > 0) out[pageKey] = normalized;
  }
  return out;
}

function samePermissionSets(a: RolePermissionSet, b: RolePermissionSet): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const x = [...(a[k] ?? [])].sort().join(',');
    const y = [...(b[k] ?? [])].sort().join(',');
    if (x !== y) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-unused-vars -- parameter name in a function type, not a variable
async function withTransaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function writePermissionSet(conn: PoolConnection, roleId: number, permissions: RolePermissionSet): Promise<void> {
  await conn.query('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
  const pairs: [string, string][] = [];
  for (const [pageKey, actions] of Object.entries(permissions)) for (const a of actions) pairs.push([pageKey, a]);
  if (pairs.length === 0) return;
  const [rows] = await conn.query(
    `SELECT p.permission_id, pg.page_key, p.action FROM permissions p JOIN pages pg ON pg.page_id = p.page_id
      WHERE (pg.page_key, p.action) IN (?)`,
    [pairs],
  );
  const ids = (rows as { permission_id: number }[]).map((r) => [roleId, r.permission_id, true]);
  if (ids.length) await conn.query('INSERT INTO role_permissions (role_id, permission_id, allowed) VALUES ?', [ids]);
}

function cleanLabel(label: unknown): string {
  if (typeof label !== 'string') throw new ValidationError('Role name is required.');
  const trimmed = label.trim().replace(/\s+/g, ' ');
  if (trimmed.length < 2 || trimmed.length > 60) throw new ValidationError('Role name must be 2-60 characters.');
  return trimmed;
}

function cleanDescription(description: unknown): string | null {
  if (description == null) return null;
  if (typeof description !== 'string') throw new ValidationError('Description must be text.');
  const trimmed = description.trim();
  if (trimmed.length > 500) throw new ValidationError('Description must be 500 characters or fewer.');
  return trimmed || null;
}

async function assertLabelFree(label: string, exceptRoleId: number | null, db: Pick<PoolConnection, 'query'>): Promise<void> {
  const [rows] = await db.query('SELECT role_id FROM roles WHERE role_label = ? AND role_id <> ?', [label, exceptRoleId ?? 0]);
  if ((rows as unknown[]).length > 0) throw new ValidationError(`A role named "${label}" already exists.`);
}

async function assertTier(tierCode: unknown, db: Pick<PoolConnection, 'query'>): Promise<string> {
  if (typeof tierCode !== 'string' || !tierCode) throw new ValidationError('A data-scope tier is required.');
  const [rows] = await db.query('SELECT role_code FROM role_tier WHERE role_code = ?', [tierCode]);
  if ((rows as unknown[]).length === 0) throw new ValidationError(`Unknown data-scope tier: ${tierCode}`);
  return tierCode;
}

/** Internal code (roles.role_name, VARCHAR(30)) for a custom role, derived from its display name.
 * Always "C_"-prefixed so a custom role can never collide with a built-in code such as ADMIN or
 * SALESPERSON that the code checks by name. */
export function roleCodeFromLabel(label: string): string {
  const slug = label
    .toUpperCase()
    .normalize('NFKD')
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
  return `C_${slug || 'ROLE'}`;
}

async function uniqueRoleCode(label: string, db: Pick<PoolConnection, 'query'>): Promise<string> {
  const base = roleCodeFromLabel(label);
  for (let i = 1; i < 1000; i += 1) {
    const candidate = i === 1 ? base : `${base.slice(0, 26)}_${i}`;
    const [rows] = await db.query('SELECT 1 FROM roles WHERE role_name = ?', [candidate]);
    if ((rows as unknown[]).length === 0) return candidate;
  }
  throw new ValidationError('Could not generate a unique role code.');
}

function snapshot(role: RoleSummary, permissions: RolePermissionSet) {
  return {
    name: role.role_label,
    code: role.role_name,
    description: role.description,
    dataScopeTier: role.default_role_tier_code,
    permissions,
  };
}

export interface RoleInput {
  label: unknown;
  description?: unknown;
  tierCode?: unknown;
  permissions?: Record<string, readonly string[]>;
}

export async function createRole(input: RoleInput, actorId: number): Promise<RoleDetail> {
  const label = cleanLabel(input.label);
  const description = cleanDescription(input.description);
  const permissions = normalizePermissionSet(input.permissions);
  const roleId = await withTransaction(async (conn) => {
    await assertLabelFree(label, null, conn);
    const tier = await assertTier(input.tierCode ?? 'BI00_EXECUTIVE', conn);
    const code = await uniqueRoleCode(label, conn);
    const [result] = await conn.query(
      `INSERT INTO roles (role_name, role_label, description, default_role_tier_code, is_system, created_by)
       VALUES (?, ?, ?, ?, FALSE, ?)`,
      [code, label, description, tier, actorId],
    );
    const id = (result as { insertId: number }).insertId;
    await writePermissionSet(conn, id, permissions);
    return id;
  });
  const created = (await getRoleDetail(roleId))!;
  await writeAuditLog({
    entityType: ROLE_ENTITY,
    entityId: String(roleId),
    action: 'CREATE',
    changedBy: actorId,
    after: snapshot(created, created.permissions),
  });
  return created;
}

export async function updateRole(roleId: number, input: Partial<RoleInput>, actorId: number): Promise<RoleDetail> {
  const before = await getRoleDetail(roleId);
  if (!before) throw new ValidationError('Role not found.');

  const label = input.label === undefined ? before.role_label : cleanLabel(input.label);
  const description = input.description === undefined ? before.description : cleanDescription(input.description);
  const permissions = input.permissions === undefined ? before.permissions : normalizePermissionSet(input.permissions);
  const tierInput = input.tierCode === undefined ? before.default_role_tier_code : input.tierCode;

  if (before.is_admin) {
    if (label !== before.role_label) throw new ValidationError('The Admin role cannot be renamed.');
    if (!samePermissionSets(permissions, before.permissions)) {
      throw new ValidationError("The Admin role's permissions cannot be changed: it always has full access.");
    }
    if (tierInput !== before.default_role_tier_code) throw new ValidationError("The Admin role's data scope cannot be changed.");
  }

  await withTransaction(async (conn) => {
    if (label !== before.role_label) await assertLabelFree(label, roleId, conn);
    const tier = await assertTier(tierInput, conn);
    await conn.query('UPDATE roles SET role_label = ?, description = ?, default_role_tier_code = ? WHERE role_id = ?', [
      label,
      description,
      tier,
      roleId,
    ]);
    if (!before.is_admin && input.permissions !== undefined) await writePermissionSet(conn, roleId, permissions);
    if (tier !== before.default_role_tier_code) {
      // Keep the data-scope tier record (user_role) in step for users whose primary role this is.
      const [users] = await conn.query('SELECT user_id FROM app_user WHERE role_id = ?', [roleId]);
      for (const u of users as { user_id: number }[]) await syncTier(conn, u.user_id, tier);
    }
  });

  const after = (await getRoleDetail(roleId))!;
  await writeAuditLog({
    entityType: ROLE_ENTITY,
    entityId: String(roleId),
    action: 'UPDATE',
    changedBy: actorId,
    before: snapshot(before, before.permissions),
    after: snapshot(after, after.permissions),
  });
  return after;
}

/** "<name> (copy)", then "<name> (copy 2)", ... -- whichever is free. */
async function copyLabel(label: string): Promise<string> {
  for (let i = 1; i < 1000; i += 1) {
    const suffix = i === 1 ? ' (copy)' : ` (copy ${i})`;
    const candidate = `${label.slice(0, 60 - suffix.length)}${suffix}`;
    const [rows] = await pool.query('SELECT 1 FROM roles WHERE role_label = ?', [candidate]);
    if ((rows as unknown[]).length === 0) return candidate;
  }
  throw new ValidationError('Could not find a free name for the copy.');
}

/** New, non-system role with the source role's permissions, data-scope tier and data-scope rules. */
export async function duplicateRole(sourceRoleId: number, actorId: number): Promise<RoleDetail> {
  const source = await getRoleDetail(sourceRoleId);
  if (!source) throw new ValidationError('Role not found.');
  const created = await createRole(
    {
      label: await copyLabel(source.role_label),
      description: source.description,
      tierCode: source.default_role_tier_code ?? 'BI00_EXECUTIVE',
      permissions: source.permissions,
    },
    actorId,
  );
  await pool.query(
    `INSERT IGNORE INTO role_data_scope (role_id, dimension, value)
     SELECT ?, dimension, value FROM role_data_scope WHERE role_id = ?`,
    [created.role_id, sourceRoleId],
  );
  return created;
}

export async function deleteRole(roleId: number, replacementRoleId: number | null, actorId: number): Promise<void> {
  const role = await getRoleDetail(roleId);
  if (!role) throw new ValidationError('Role not found.');
  if (role.is_system) throw new ValidationError('Built-in roles cannot be deleted.');

  const [assigned] = await pool.query('SELECT user_id FROM user_roles WHERE role_id = ?', [roleId]);
  const userIds = (assigned as { user_id: number }[]).map((r) => r.user_id);
  let replacement: RoleSummary | null = null;
  if (userIds.length > 0) {
    if (replacementRoleId == null) throw new RoleInUseError(userIds.length);
    if (replacementRoleId === roleId) throw new ValidationError('The replacement role must be a different role.');
    replacement = await getRoleSummary(replacementRoleId);
    if (!replacement) throw new ValidationError('Replacement role not found.');
  }

  await withTransaction(async (conn) => {
    for (const userId of userIds) {
      await conn.query('INSERT IGNORE INTO user_roles (user_id, role_id, assigned_by) VALUES (?, ?, ?)', [userId, replacement!.role_id, actorId]);
      await conn.query('DELETE FROM user_roles WHERE user_id = ? AND role_id = ?', [userId, roleId]);
    }
    const [primaries] = await conn.query('SELECT user_id FROM app_user WHERE role_id = ?', [roleId]);
    for (const u of primaries as { user_id: number }[]) {
      await conn.query('UPDATE app_user SET role_id = ? WHERE user_id = ?', [replacement!.role_id, u.user_id]);
      await syncTier(conn, u.user_id, replacement!.default_role_tier_code);
    }
    await conn.query('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
    await conn.query('DELETE FROM role_data_scope WHERE role_id = ?', [roleId]);
    await conn.query('DELETE FROM roles WHERE role_id = ?', [roleId]);
  });

  await writeAuditLog({
    entityType: ROLE_ENTITY,
    entityId: String(roleId),
    action: 'DELETE',
    changedBy: actorId,
    before: { ...snapshot(role, role.permissions), userCount: userIds.length },
    after: replacement ? { reassignedUsersTo: replacement.role_label, userIds } : undefined,
  });
}

// ---------------------------------------------------------------------------
// User <-> role assignment
// ---------------------------------------------------------------------------

/** Mirrors the primary role's data-scope tier into user_role (0009), which is what the scope lock
 * and role_dashboard_access read. */
async function syncTier(db: Pick<PoolConnection, 'query'>, userId: number, tierCode: string | null): Promise<void> {
  await db.query('DELETE FROM user_role WHERE user_id = ?', [userId]);
  if (tierCode) await db.query('INSERT INTO user_role (user_id, role_code) VALUES (?, ?)', [userId, tierCode]);
}

async function roleLabels(roleIds: number[], db: Pick<PoolConnection, 'query'> = pool): Promise<string[]> {
  if (roleIds.length === 0) return [];
  const [rows] = await db.query('SELECT role_label FROM roles WHERE role_id IN (?) ORDER BY role_label', [roleIds]);
  return (rows as { role_label: string }[]).map((r) => r.role_label);
}

async function adminRoleId(db: Pick<PoolConnection, 'query'> = pool): Promise<number | null> {
  const [rows] = await db.query('SELECT role_id FROM roles WHERE role_name = ?', [ADMIN_ROLE_NAME]);
  return (rows as { role_id: number }[])[0]?.role_id ?? null;
}

/** Users other than `userId` who hold the Admin role and can still sign in. */
export async function countOtherActiveAdmins(userId: number, db: Pick<PoolConnection, 'query'> = pool): Promise<number> {
  const adminId = await adminRoleId(db);
  if (adminId == null) return 0;
  const [rows] = await db.query(
    `SELECT COUNT(*) AS n FROM user_roles ur JOIN app_user u ON u.user_id = ur.user_id
      WHERE ur.role_id = ? AND ur.user_id <> ? AND u.status IN ('ACTIVE', 'PENDING_PASSWORD_CHANGE')`,
    [adminId, userId],
  );
  return Number((rows as { n: number }[])[0]?.n ?? 0);
}

export async function userHoldsAdmin(userId: number, db: Pick<PoolConnection, 'query'> = pool): Promise<boolean> {
  const adminId = await adminRoleId(db);
  if (adminId == null) return false;
  const [rows] = await db.query('SELECT 1 FROM user_roles WHERE user_id = ? AND role_id = ?', [userId, adminId]);
  return (rows as unknown[]).length > 0;
}

export async function getUserRoleIds(userId: number, db: Pick<PoolConnection, 'query'> = pool): Promise<number[]> {
  const [rows] = await db.query('SELECT role_id FROM user_roles WHERE user_id = ? ORDER BY role_id', [userId]);
  return (rows as { role_id: number }[]).map((r) => r.role_id);
}

/**
 * Replaces a user's roles. The primary role (app_user.role_id: data-scope tier + data-scope rules)
 * is `primaryRoleId` when given, otherwise the current primary if it's still assigned, otherwise the
 * first of `roleIds`. Refuses to take the Admin role away from the last active admin.
 */
export async function setUserRoles(
  userId: number,
  roleIds: number[],
  actorId: number | null,
  primaryRoleId?: number | null,
): Promise<void> {
  const ids = Array.from(new Set(roleIds.map(Number).filter((n) => Number.isInteger(n) && n > 0)));
  if (ids.length === 0) throw new ValidationError('A user needs at least one role.');

  const [roleRows] = await pool.query('SELECT role_id, default_role_tier_code FROM roles WHERE role_id IN (?)', [ids]);
  const found = roleRows as { role_id: number; default_role_tier_code: string | null }[];
  if (found.length !== ids.length) throw new ValidationError('Unknown role.');

  const [userRows] = await pool.query('SELECT role_id FROM app_user WHERE user_id = ?', [userId]);
  const currentPrimary = (userRows as { role_id: number | null }[])[0];
  if (!currentPrimary) throw new ValidationError('User not found.');

  const beforeIds = await getUserRoleIds(userId);
  const adminId = await adminRoleId();
  if (adminId != null && beforeIds.includes(adminId) && !ids.includes(adminId) && (await countOtherActiveAdmins(userId)) === 0) {
    throw new ValidationError('This is the last active Admin. Assign the Admin role to another user first.');
  }

  let primary = currentPrimary.role_id != null && ids.includes(currentPrimary.role_id) ? currentPrimary.role_id : ids[0];
  if (primaryRoleId != null) {
    if (!ids.includes(Number(primaryRoleId))) throw new ValidationError('The primary role must be one of the assigned roles.');
    primary = Number(primaryRoleId);
  }
  const primaryTier = found.find((r) => r.role_id === primary)?.default_role_tier_code ?? null;

  await withTransaction(async (conn) => {
    await conn.query('DELETE FROM user_roles WHERE user_id = ? AND role_id NOT IN (?)', [userId, ids]);
    for (const id of ids) {
      await conn.query('INSERT IGNORE INTO user_roles (user_id, role_id, assigned_by) VALUES (?, ?, ?)', [userId, id, actorId]);
    }
    await conn.query('UPDATE app_user SET role_id = ? WHERE user_id = ?', [primary, userId]);
    await syncTier(conn, userId, primaryTier);
  });

  const beforeSorted = [...beforeIds].sort().join(',');
  const afterSorted = [...ids].sort().join(',');
  if (beforeSorted !== afterSorted || currentPrimary.role_id !== primary) {
    await writeAuditLog({
      entityType: USER_ROLES_ENTITY,
      entityId: String(userId),
      action: 'UPDATE',
      changedBy: actorId,
      before: { roles: await roleLabels(beforeIds), primaryRole: (await roleLabels(currentPrimary.role_id ? [currentPrimary.role_id] : []))[0] ?? null },
      after: { roles: await roleLabels(ids), primaryRole: (await roleLabels([primary]))[0] ?? null },
    });
  }
}

/** Blocks disabling/locking the last active admin (they would lock everyone out of the panel). */
export async function assertCanDeactivate(userId: number): Promise<void> {
  if ((await userHoldsAdmin(userId)) && (await countOtherActiveAdmins(userId)) === 0) {
    throw new ValidationError('This is the last active Admin and cannot be disabled or locked.');
  }
}

/** Data-scope tiers for the role form's picker. */
export async function listRoleTiers(): Promise<{ role_code: string; role_label: string; scope_description: string }[]> {
  const [rows] = await pool.query('SELECT role_code, role_label, scope_description FROM role_tier ORDER BY role_code');
  return rows as never;
}

