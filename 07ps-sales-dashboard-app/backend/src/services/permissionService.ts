import type { Request } from 'express';
import { ValidationError } from '../lib/errors';
import { pool } from '../db/pool';
import {
  PERMISSION_ACTIONS,
  PERMISSION_REGISTRY,
  dashboardPageKeys,
  isRegisteredAction,
  navGroupOf,
  type PermissionAction,
} from '../config/permissionRegistry';

/** The built-in super-administrator role (roles.role_name). */
export const ADMIN_ROLE_NAME = 'ADMIN';

export interface PagePermission {
  canView: boolean;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canExport: boolean;
}

export type EffectivePermissions = Record<string, PagePermission>;

const FLAG: Record<PermissionAction, keyof PagePermission> = {
  view: 'canView',
  create: 'canCreate',
  edit: 'canEdit',
  delete: 'canDelete',
  export: 'canExport',
};

export function emptyPagePermission(): PagePermission {
  return { canView: false, canCreate: false, canEdit: false, canDelete: false, canExport: false };
}

export function allows(permissions: EffectivePermissions, pageKey: string, action: PermissionAction): boolean {
  return permissions[pageKey]?.[FLAG[action]] ?? false;
}

interface GrantRow {
  page_key: string;
  action: PermissionAction;
  allowed: number | boolean | null;
}

/**
 * Pure permission evaluation (unit-tested directly):
 *
 *   - Admin (holds the ADMIN role)  -> every registered action on every registered page.
 *   - otherwise, per page+action     -> the user's own override if one exists, else allowed if ANY
 *                                        of the user's roles allows it (roles combine as a union).
 *   - only actions the registry lists for a page count; a stale row for anything else is ignored.
 *   - every action requires View: without View on a page, nothing else on it is allowed either.
 */
export function computeEffectivePermissions(input: {
  isAdmin: boolean;
  roleGrants: GrantRow[];
  overrides: GrantRow[];
}): EffectivePermissions {
  const key = (pageKey: string, action: string) => `${pageKey}\u0000${action}`;
  const roleAllowed = new Set<string>();
  for (const g of input.roleGrants) if (g.allowed) roleAllowed.add(key(g.page_key, g.action));
  const override = new Map<string, boolean>();
  for (const o of input.overrides) if (o.allowed !== null) override.set(key(o.page_key, o.action), Boolean(o.allowed));

  const result: EffectivePermissions = {};
  for (const entry of PERMISSION_REGISTRY) {
    const page = emptyPagePermission();
    for (const action of entry.actions) {
      const k = key(entry.key, action);
      page[FLAG[action]] = input.isAdmin || (override.has(k) ? override.get(k)! : roleAllowed.has(k));
    }
    if (!page.canView) {
      page.canCreate = false;
      page.canEdit = false;
      page.canDelete = false;
      page.canExport = false;
    }
    result[entry.key] = page;
  }
  return result;
}

export interface UserRoleRef {
  role_id: number;
  role_name: string;
  role_label: string;
}

/** Every business role the user holds (user_roles), falling back to app_user.role_id for a row the
 * migration hasn't reached (e.g. a user created by an older build between deploys). */
export async function getUserRoles(userId: number, fallbackRoleId?: number | null): Promise<UserRoleRef[]> {
  const [rows] = await pool.query(
    `SELECT r.role_id, r.role_name, r.role_label
       FROM user_roles ur JOIN roles r ON r.role_id = ur.role_id
      WHERE ur.user_id = ?
      ORDER BY r.role_label`,
    [userId],
  );
  const roles = rows as UserRoleRef[];
  if (roles.length > 0 || fallbackRoleId == null) return roles;
  const [fallback] = await pool.query('SELECT role_id, role_name, role_label FROM roles WHERE role_id = ?', [fallbackRoleId]);
  return fallback as UserRoleRef[];
}

/**
 * Effective permissions, computed fresh from the database on every call -- no cross-request cache,
 * so a role, permission or role-assignment change applies to the user's very next request. Within
 * one request the result is memoized on the request (see getRequestPermissions).
 */
export async function getEffectivePermissions(userId: number, roleId?: number | null): Promise<EffectivePermissions> {
  const roles = await getUserRoles(userId, roleId);
  const isAdmin = roles.some((r) => r.role_name === ADMIN_ROLE_NAME);
  if (isAdmin) return computeEffectivePermissions({ isAdmin: true, roleGrants: [], overrides: [] });

  const roleIds = roles.map((r) => r.role_id);
  let roleGrants: GrantRow[] = [];
  if (roleIds.length > 0) {
    const [grantRows] = await pool.query(
      `SELECT pg.page_key, p.action, rp.allowed
         FROM role_permissions rp
         JOIN permissions p ON p.permission_id = rp.permission_id
         JOIN pages pg ON pg.page_id = p.page_id
        WHERE rp.role_id IN (?)`,
      [roleIds],
    );
    roleGrants = grantRows as GrantRow[];
  }
  const [overrideRows] = await pool.query(
    `SELECT pg.page_key, p.action, up.allowed
       FROM user_permissions up
       JOIN permissions p ON p.permission_id = up.permission_id
       JOIN pages pg ON pg.page_id = p.page_id
      WHERE up.user_id = ?`,
    [userId],
  );
  return computeEffectivePermissions({ isAdmin: false, roleGrants, overrides: overrideRows as GrantRow[] });
}

/** Per-request memo: several checks in one request load permissions once. Keyed by the request
 * object, so it's dropped with the request -- nothing is cached across requests. */
const requestPermissions = new WeakMap<Request, Promise<EffectivePermissions>>();

/** The request user's effective permissions, loaded once per request however many checks run. */
export function getRequestPermissions(req: Request): Promise<EffectivePermissions> {
  if (!req.user) return Promise.resolve({});
  let pending = requestPermissions.get(req);
  if (!pending) {
    pending = getEffectivePermissions(req.user.id, req.user.roleId);
    requestPermissions.set(req, pending);
  }
  return pending;
}

export async function hasPermission(
  userId: number,
  roleId: number | null,
  pageKey: string,
  action: PermissionAction,
): Promise<boolean> {
  return allows(await getEffectivePermissions(userId, roleId), pageKey, action);
}

/** True when the user can View at least one dashboard page -- the gate for shared, page-agnostic
 * dashboard endpoints (filter options, refresh status). */
export function canViewAnyDashboard(permissions: EffectivePermissions): boolean {
  return dashboardPageKeys().some((k) => allows(permissions, k, 'view'));
}

/**
 * Brings `pages` / `permissions` in line with the registry: inserts any page or page+action the
 * registry has and the database doesn't, and refreshes each page's label/group/order. Never deletes
 * (a page removed from the registry simply stops being evaluated). Also keeps the Admin role's rows
 * complete. Runs at backend startup; idempotent.
 */
export async function syncPermissionRegistry(): Promise<void> {
  // Before migration 0026 the action column only knows view/export, and a non-strict server would
  // silently store the new actions as ''. Skip until the migration has run.
  const [colRows] = await pool.query(
    `SELECT COLUMN_TYPE AS type FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'permissions' AND COLUMN_NAME = 'action'`,
  );
  const columnType = String((colRows as { type: string }[])[0]?.type ?? '');
  const missing = PERMISSION_ACTIONS.filter((a) => !columnType.includes(`'${a}'`));
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[permissions] registry sync skipped: permissions.action lacks ${missing.join(', ')} -- apply migration 0026_roles_permissions.sql.`,
    );
    return;
  }
  for (const [index, entry] of PERMISSION_REGISTRY.entries()) {
    await pool.query(
      `INSERT INTO pages (page_key, page_label, nav_group, sort_order) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE page_label = VALUES(page_label), nav_group = VALUES(nav_group), sort_order = VALUES(sort_order)`,
      [entry.key, entry.label, navGroupOf(entry.group), index + 1],
    );
    for (const action of entry.actions) {
      await pool.query(
        `INSERT IGNORE INTO permissions (page_id, action)
         SELECT page_id, ? FROM pages WHERE page_key = ?`,
        [action, entry.key],
      );
    }
  }
  await pool.query(
    `INSERT IGNORE INTO role_permissions (role_id, permission_id, allowed)
     SELECT r.role_id, p.permission_id, TRUE FROM roles r JOIN permissions p ON TRUE WHERE r.role_name = ?`,
    [ADMIN_ROLE_NAME],
  );
}

/** permission_id for a registered page+action, or a ValidationError. */
export async function getPermissionId(pageKey: string, action: string): Promise<number> {
  if (!isRegisteredAction(pageKey, action)) throw new ValidationError(`Unknown page/action: ${pageKey}/${action}`);
  const [rows] = await pool.query(
    `SELECT p.permission_id FROM permissions p JOIN pages pg ON pg.page_id = p.page_id
     WHERE pg.page_key = ? AND p.action = ?`,
    [pageKey, action],
  );
  const permissionId = (rows as { permission_id: number }[])[0]?.permission_id;
  if (!permissionId) throw new ValidationError(`Unknown page/action: ${pageKey}/${action}`);
  return permissionId;
}

/** Upserts (or clears, when allowed === null) one user's override for one page+action. */
export async function setUserPermissionOverride(
  userId: number,
  pageKey: string,
  action: PermissionAction,
  allowed: boolean | null,
): Promise<void> {
  const permissionId = await getPermissionId(pageKey, action);
  if (allowed === null) {
    await pool.query('DELETE FROM user_permissions WHERE user_id = ? AND permission_id = ?', [userId, permissionId]);
    return;
  }
  await pool.query(
    `INSERT INTO user_permissions (user_id, permission_id, allowed) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE allowed = VALUES(allowed)`,
    [userId, permissionId, allowed],
  );
}

/** A user's raw overrides as { pageKey: { action: allowed } }, for the User Details screen. */
export async function getUserPermissionOverrides(userId: number): Promise<Record<string, Partial<Record<PermissionAction, boolean>>>> {
  const [rows] = await pool.query(
    `SELECT pg.page_key, p.action, up.allowed
       FROM user_permissions up
       JOIN permissions p ON p.permission_id = up.permission_id
       JOIN pages pg ON pg.page_id = p.page_id
      WHERE up.user_id = ?`,
    [userId],
  );
  const out: Record<string, Partial<Record<PermissionAction, boolean>>> = {};
  for (const r of rows as GrantRow[]) {
    out[r.page_key] = out[r.page_key] ?? {};
    out[r.page_key][r.action] = Boolean(r.allowed);
  }
  return out;
}
