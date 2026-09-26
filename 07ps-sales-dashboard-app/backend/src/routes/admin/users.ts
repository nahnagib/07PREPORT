import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../../middleware/permission';
import { ValidationError } from '../../lib/errors';
import {
  getEffectivePermissions,
  getUserPermissionOverrides,
  getUserRoles,
  setUserPermissionOverride,
} from '../../services/permissionService';
import { isRegisteredAction } from '../../config/permissionRegistry';
import { setUserRoles } from '../../services/roleService';
import { writeAuditLog } from '../../services/auditLogService';
import { listLoginHistory } from '../../services/loginHistoryService';
import {
  adminResetPassword,
  createUser,
  forcePasswordChange,
  getSalespersonOptions,
  getUserById,
  listRoles,
  listUsers,
  revokeSessions,
  setUserStatus,
  updateUser,
  UserStatus,
} from '../../services/userService';

export const adminUsersRouter = Router();

adminUsersRouter.use(
  requireAuth,
  requirePasswordChangeCleared,
  requirePermission('admin_users', 'view'),
);

/** Reads need View (router-level above); creating a user needs Create; every change to an existing
 * user (profile, status, password, sessions, roles, permission overrides) needs Edit. */
const canCreate = requirePermission('admin_users', 'create');
const canEdit = requirePermission('admin_users', 'edit');

function parseRoleIds(raw: unknown): number[] {
  const values = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return values.map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

function sanitizeUser(user: Awaited<ReturnType<typeof getUserById>>) {
  if (!user) return null;
  // eslint-disable-next-line no-unused-vars -- destructured only to exclude these two secrets from `safe`
  const { password_hash: _hash, password_reset_token_hash: _reset, ...safe } = user;
  return safe;
}

adminUsersRouter.get('/meta/roles', async (_req, res, next) => {
  try {
    res.json(await listRoles());
  } catch (err) {
    next(err);
  }
});

adminUsersRouter.get('/meta/salespersons', async (_req, res, next) => {
  try {
    res.json(await getSalespersonOptions());
  } catch (err) {
    next(err);
  }
});

adminUsersRouter.get('/', async (req, res, next) => {
  try {
    const page = Number(req.query.page ?? 1) || 1;
    const pageSize = Math.min(Number(req.query.pageSize ?? 25) || 25, 100);
    const { rows, total } = await listUsers({
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      status: typeof req.query.status === 'string' ? (req.query.status as UserStatus) : undefined,
      roleId: req.query.roleId ? Number(req.query.roleId) : undefined,
      page,
      pageSize,
    });
    res.json({ rows: rows.map(sanitizeUser), total, page, pageSize });
  } catch (err) {
    next(err);
  }
});

adminUsersRouter.post('/', canCreate, async (req, res, next) => {
  try {
    const { fullName, email, roleId, roleIds, tempPassword, status, salespersonKey, companyScope } = req.body ?? {};
    // roleIds (several roles) is the current shape; a single roleId is still accepted.
    const allRoleIds = parseRoleIds(roleIds ?? roleId);
    const primaryRoleId = roleId ? Number(roleId) : allRoleIds[0];
    if (!fullName || !email || !primaryRoleId) {
      res.status(400).json({ error: 'fullName, email, and at least one role are required.' });
      return;
    }
    const result = await createUser({
      fullName,
      email,
      roleId: primaryRoleId,
      extraRoleIds: allRoleIds.filter((id) => id !== primaryRoleId),
      tempPassword: tempPassword || undefined,
      status: status || undefined,
      salespersonKey: salespersonKey !== undefined && salespersonKey !== null ? Number(salespersonKey) : null,
      companyScope: companyScope || undefined,
      actorUserId: req.user!.id,
    });
    const user = await getUserById(result.userId);
    res.status(201).json({ user: sanitizeUser(user), tempPassword: result.tempPassword });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

adminUsersRouter.get('/:id', async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    const user = await getUserById(userId);
    if (!user) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }
    const [permissions, roles, overrides] = await Promise.all([
      getEffectivePermissions(userId, user.role_id),
      getUserRoles(userId, user.role_id),
      getUserPermissionOverrides(userId),
    ]);
    res.json({ user: { ...sanitizeUser(user), roles }, permissions, overrides });
  } catch (err) {
    next(err);
  }
});

adminUsersRouter.get('/:id/login-history', async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    const page = Number(req.query.page ?? 1) || 1;
    const pageSize = Math.min(Number(req.query.pageSize ?? 25) || 25, 100);
    const result = await listLoginHistory({ userId, page, pageSize });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

adminUsersRouter.patch('/:id', canEdit, async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    const { fullName, salespersonKey, companyScope } = req.body ?? {};
    await updateUser(
      userId,
      {
        fullName,
        salespersonKey: salespersonKey === undefined ? undefined : salespersonKey === null ? null : Number(salespersonKey),
        companyScope,
      },
      req.user!.id,
    );
    const user = await getUserById(userId);
    res.json({ user: sanitizeUser(user) });
  } catch (err) {
    next(err);
  }
});

const VALID_STATUSES: UserStatus[] = ['ACTIVE', 'INACTIVE', 'LOCKED', 'PENDING_PASSWORD_CHANGE'];

adminUsersRouter.post('/:id/status', canEdit, async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    const { status } = req.body ?? {};
    if (!VALID_STATUSES.includes(status)) {
      res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
      return;
    }
    await setUserStatus(userId, status, req.user!.email);
    const user = await getUserById(userId);
    res.json({ user: sanitizeUser(user) });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

adminUsersRouter.post('/:id/reset-password', canEdit, async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    const { tempPassword } = req.body ?? {};
    const result = await adminResetPassword(userId, tempPassword || undefined);
    res.json(result);
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

adminUsersRouter.post('/:id/force-password-change', canEdit, async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    await forcePasswordChange(userId);
    const user = await getUserById(userId);
    res.json({ user: sanitizeUser(user) });
  } catch (err) {
    next(err);
  }
});

/** Replaces the user's roles: { roleIds: number[], primaryRoleId?: number }. */
adminUsersRouter.put('/:id/roles', canEdit, async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    const { roleIds, primaryRoleId } = req.body ?? {};
    await setUserRoles(userId, parseRoleIds(roleIds), req.user!.id, primaryRoleId ? Number(primaryRoleId) : null);
    const user = await getUserById(userId);
    res.json({ user: { ...sanitizeUser(user), roles: await getUserRoles(userId, user?.role_id) } });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

/** Older single-role form, kept for compatibility: the user ends up with exactly this one role. */
adminUsersRouter.patch('/:id/role', canEdit, async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    const { roleId } = req.body ?? {};
    if (!roleId) {
      res.status(400).json({ error: 'roleId is required.' });
      return;
    }
    await setUserRoles(userId, [Number(roleId)], req.user!.id, Number(roleId));
    const user = await getUserById(userId);
    res.json({ user: sanitizeUser(user) });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

adminUsersRouter.patch('/:id/permissions', canEdit, async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    const { overrides } = req.body ?? {};
    if (!Array.isArray(overrides)) {
      res.status(400).json({ error: 'overrides must be an array of { pageKey, action, allowed }.' });
      return;
    }
    for (const override of overrides) {
      const { pageKey, action } = override ?? {};
      if (typeof pageKey !== 'string' || typeof action !== 'string' || !isRegisteredAction(pageKey, action)) {
        res.status(400).json({ error: 'Each override needs a registered pageKey and action.' });
        return;
      }
    }
    const before = await getUserPermissionOverrides(userId);
    for (const { pageKey, action, allowed } of overrides) {
      await setUserPermissionOverride(userId, pageKey, action, allowed === null || allowed === undefined ? null : Boolean(allowed));
    }
    const after = await getUserPermissionOverrides(userId);
    await writeAuditLog({
      entityType: 'user_permission_overrides',
      entityId: String(userId),
      action: 'UPDATE',
      changedBy: req.user!.id,
      before,
      after,
    });
    const user = await getUserById(userId);
    const permissions = await getEffectivePermissions(userId, user?.role_id ?? null);
    res.json({ permissions, overrides: after });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

adminUsersRouter.post('/:id/revoke-sessions', canEdit, async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    await revokeSessions(userId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
