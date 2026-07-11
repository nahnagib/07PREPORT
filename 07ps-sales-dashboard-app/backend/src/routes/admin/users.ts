import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../../middleware/permission';
import { ValidationError } from '../../lib/errors';
import { setUserPermissionOverride, getEffectivePermissions } from '../../services/permissionService';
import { listLoginHistory } from '../../services/loginHistoryService';
import {
  adminResetPassword,
  changeUserRole,
  createUser,
  forcePasswordChange,
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

adminUsersRouter.post('/', async (req, res, next) => {
  try {
    const { fullName, email, roleId, tempPassword, status, salespersonKey, companyScope } = req.body ?? {};
    if (!fullName || !email || !roleId) {
      res.status(400).json({ error: 'fullName, email, and roleId are required.' });
      return;
    }
    const result = await createUser({
      fullName,
      email,
      roleId: Number(roleId),
      tempPassword: tempPassword || undefined,
      status: status || undefined,
      salespersonKey: salespersonKey !== undefined && salespersonKey !== null ? Number(salespersonKey) : null,
      companyScope: companyScope || undefined,
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
    const permissions = await getEffectivePermissions(userId, user.role_id);
    res.json({ user: sanitizeUser(user), permissions });
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

adminUsersRouter.patch('/:id', async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    const { fullName, salespersonKey, companyScope } = req.body ?? {};
    await updateUser(userId, {
      fullName,
      salespersonKey: salespersonKey === undefined ? undefined : salespersonKey === null ? null : Number(salespersonKey),
      companyScope,
    });
    const user = await getUserById(userId);
    res.json({ user: sanitizeUser(user) });
  } catch (err) {
    next(err);
  }
});

const VALID_STATUSES: UserStatus[] = ['ACTIVE', 'INACTIVE', 'LOCKED', 'PENDING_PASSWORD_CHANGE'];

adminUsersRouter.post('/:id/status', async (req, res, next) => {
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
    next(err);
  }
});

adminUsersRouter.post('/:id/reset-password', async (req, res, next) => {
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

adminUsersRouter.post('/:id/force-password-change', async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    await forcePasswordChange(userId);
    const user = await getUserById(userId);
    res.json({ user: sanitizeUser(user) });
  } catch (err) {
    next(err);
  }
});

adminUsersRouter.patch('/:id/role', async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    const { roleId } = req.body ?? {};
    if (!roleId) {
      res.status(400).json({ error: 'roleId is required.' });
      return;
    }
    await changeUserRole(userId, Number(roleId));
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

adminUsersRouter.patch('/:id/permissions', async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    const { overrides } = req.body ?? {};
    if (!Array.isArray(overrides)) {
      res.status(400).json({ error: 'overrides must be an array of { pageKey, action, allowed }.' });
      return;
    }
    for (const override of overrides) {
      const { pageKey, action, allowed } = override ?? {};
      if (typeof pageKey !== 'string' || (action !== 'view' && action !== 'export')) {
        res.status(400).json({ error: 'Each override needs a pageKey and action of "view"|"export".' });
        return;
      }
      await setUserPermissionOverride(userId, pageKey, action, allowed === null ? null : Boolean(allowed));
    }
    const user = await getUserById(userId);
    const permissions = await getEffectivePermissions(userId, user?.role_id ?? null);
    res.json({ permissions });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

adminUsersRouter.post('/:id/revoke-sessions', async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    await revokeSessions(userId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
