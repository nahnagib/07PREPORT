import { ValidationError } from '../lib/errors';
import { pool } from '../db/pool';

export interface PagePermission {
  canView: boolean;
  canExport: boolean;
}

export type EffectivePermissions = Record<string, PagePermission>;

interface PermissionRow {
  page_key: string;
  action: 'view' | 'export';
  allowed: number | null;
}

/**
 * Effective permission = per-user override (user_permissions) if one exists for that page+action,
 * else the user's role default (role_permissions), else deny. Computed fresh on every call (no
 * caching) so an admin changing a role's or a user's permissions takes effect on the very next
 * request -- consistent with how requireAuth re-loads role/status fresh rather than trusting the
 * (deliberately minimal, long-lived) JWT.
 */
export async function getEffectivePermissions(
  userId: number,
  roleId: number | null,
): Promise<EffectivePermissions> {
  const [rows] = await pool.query(
    `SELECT pg.page_key, p.action, COALESCE(up.allowed, rp.allowed, FALSE) AS allowed
     FROM pages pg
     JOIN permissions p ON p.page_id = pg.page_id
     LEFT JOIN role_permissions rp ON rp.permission_id = p.permission_id AND rp.role_id = ?
     LEFT JOIN user_permissions up ON up.permission_id = p.permission_id AND up.user_id = ?`,
    [roleId, userId],
  );

  const result: EffectivePermissions = {};
  for (const row of rows as PermissionRow[]) {
    if (!result[row.page_key]) {
      result[row.page_key] = { canView: false, canExport: false };
    }
    const allowed = Boolean(row.allowed);
    if (row.action === 'view') result[row.page_key].canView = allowed;
    else result[row.page_key].canExport = allowed;
  }
  return result;
}

export async function hasPermission(
  userId: number,
  roleId: number | null,
  pageKey: string,
  action: 'view' | 'export',
): Promise<boolean> {
  const permissions = await getEffectivePermissions(userId, roleId);
  const page = permissions[pageKey];
  if (!page) return false;
  return action === 'view' ? page.canView : page.canExport;
}

export interface RoleMatrixRow {
  role_id: number;
  role_name: string;
  role_label: string;
}

export interface RolePermissionMatrix {
  roles: RoleMatrixRow[];
  pages: { page_id: number; page_key: string; page_label: string; nav_group: string | null }[];
  // roleId -> pageKey -> { canView, canExport }
  matrix: Record<number, EffectivePermissions>;
}

/** Powers the Role & Permission Management admin page: every role x every page, defaults only
 * (per-user overrides are edited on the User Details page, not here). */
export async function getRolePermissionMatrix(): Promise<RolePermissionMatrix> {
  const [roleRows] = await pool.query('SELECT role_id, role_name, role_label FROM roles ORDER BY role_id');
  const [pageRows] = await pool.query(
    'SELECT page_id, page_key, page_label, nav_group FROM pages ORDER BY sort_order',
  );
  const [permRows] = await pool.query(
    `SELECT rp.role_id, pg.page_key, p.action, rp.allowed
     FROM role_permissions rp
     JOIN permissions p ON p.permission_id = rp.permission_id
     JOIN pages pg ON pg.page_id = p.page_id`,
  );

  const matrix: Record<number, EffectivePermissions> = {};
  for (const row of permRows as (PermissionRow & { role_id: number })[]) {
    matrix[row.role_id] = matrix[row.role_id] ?? {};
    if (!matrix[row.role_id][row.page_key]) {
      matrix[row.role_id][row.page_key] = { canView: false, canExport: false };
    }
    const allowed = Boolean(row.allowed);
    if (row.action === 'view') matrix[row.role_id][row.page_key].canView = allowed;
    else matrix[row.role_id][row.page_key].canExport = allowed;
  }

  return {
    roles: roleRows as RoleMatrixRow[],
    pages: pageRows as RolePermissionMatrix['pages'],
    matrix,
  };
}

/** Upserts one role's default permission for one page+action. */
export async function setRolePermission(
  roleId: number,
  pageKey: string,
  action: 'view' | 'export',
  allowed: boolean,
): Promise<void> {
  // Guard rail: the Admin role must always be able to reach the admin panel itself, or a
  // well-intentioned permission edit could lock every administrator out with no recovery path
  // short of direct DB access (there is no superuser bypass in this system by design).
  if (!allowed && action === 'view' && (pageKey === 'admin_users' || pageKey === 'admin_roles')) {
    const [roleRows] = await pool.query('SELECT role_name FROM roles WHERE role_id = ?', [roleId]);
    const roleName = (roleRows as { role_name: string }[])[0]?.role_name;
    if (roleName === 'ADMIN') {
      throw new ValidationError(
        'The Admin role must always retain access to User Management and Role & Permission Management.',
      );
    }
  }

  const [permRows] = await pool.query(
    `SELECT p.permission_id FROM permissions p JOIN pages pg ON pg.page_id = p.page_id
     WHERE pg.page_key = ? AND p.action = ?`,
    [pageKey, action],
  );
  const permissionId = (permRows as { permission_id: number }[])[0]?.permission_id;
  if (!permissionId) throw new ValidationError(`Unknown page/action: ${pageKey}/${action}`);

  await pool.query(
    `INSERT INTO role_permissions (role_id, permission_id, allowed) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE allowed = VALUES(allowed)`,
    [roleId, permissionId, allowed],
  );
}

/** Upserts (or clears, when allowed === null) one user's override for one page+action. */
export async function setUserPermissionOverride(
  userId: number,
  pageKey: string,
  action: 'view' | 'export',
  allowed: boolean | null,
): Promise<void> {
  const [permRows] = await pool.query(
    `SELECT p.permission_id FROM permissions p JOIN pages pg ON pg.page_id = p.page_id
     WHERE pg.page_key = ? AND p.action = ?`,
    [pageKey, action],
  );
  const permissionId = (permRows as { permission_id: number }[])[0]?.permission_id;
  if (!permissionId) throw new ValidationError(`Unknown page/action: ${pageKey}/${action}`);

  if (allowed === null) {
    await pool.query('DELETE FROM user_permissions WHERE user_id = ? AND permission_id = ?', [
      userId,
      permissionId,
    ]);
    return;
  }

  await pool.query(
    `INSERT INTO user_permissions (user_id, permission_id, allowed) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE allowed = VALUES(allowed)`,
    [userId, permissionId, allowed],
  );
}

export async function listPages(): Promise<
  { page_id: number; page_key: string; page_label: string; nav_group: string | null; sort_order: number }[]
> {
  const [rows] = await pool.query('SELECT * FROM pages ORDER BY sort_order');
  return rows as never;
}
