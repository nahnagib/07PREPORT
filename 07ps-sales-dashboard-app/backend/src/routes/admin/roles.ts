import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../../middleware/permission';
import { ValidationError } from '../../lib/errors';
import { getRolePermissionMatrix, setRolePermission } from '../../services/permissionService';

export const adminRolesRouter = Router();

adminRolesRouter.use(
  requireAuth,
  requirePasswordChangeCleared,
  requirePermission('admin_roles', 'view'),
);

adminRolesRouter.get('/', async (_req, res, next) => {
  try {
    res.json(await getRolePermissionMatrix());
  } catch (err) {
    next(err);
  }
});

adminRolesRouter.patch('/:roleId/permissions', async (req, res, next) => {
  try {
    const roleId = Number(req.params.roleId);
    const { pageKey, action, allowed } = req.body ?? {};
    if (typeof pageKey !== 'string' || (action !== 'view' && action !== 'export')) {
      res.status(400).json({ error: 'pageKey and action ("view"|"export") are required.' });
      return;
    }
    await setRolePermission(roleId, pageKey, action, Boolean(allowed));
    res.json(await getRolePermissionMatrix());
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});
