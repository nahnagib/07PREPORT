import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../../middleware/permission';
import { ValidationError } from '../../lib/errors';
import { getRolePermissionMatrix, setRolePermission } from '../../services/permissionService';
import {
  DATA_SCOPE_DIMENSIONS,
  addRoleDataScopeRule,
  getAllRoleDataScopeRulesWithLabels,
  removeRoleDataScopeRule,
} from '../../services/dataScopeService';

export const adminRolesRouter = Router();

adminRolesRouter.use(
  requireAuth,
  requirePasswordChangeCleared,
  requirePermission('admin_roles', 'view'),
);

/** Same "whole matrix, single source of truth" shape the page-permission table already used --
 * dataScope/dimensions are additive fields, so existing clients that only read
 * roles/pages/matrix are unaffected. */
async function getRoleAdminView() {
  const [matrix, dataScope] = await Promise.all([
    getRolePermissionMatrix(),
    getAllRoleDataScopeRulesWithLabels(),
  ]);
  return { ...matrix, dataScope, dimensions: DATA_SCOPE_DIMENSIONS };
}

adminRolesRouter.get('/', async (_req, res, next) => {
  try {
    res.json(await getRoleAdminView());
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
    res.json(await getRoleAdminView());
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

adminRolesRouter.post('/:roleId/data-scope', async (req, res, next) => {
  try {
    const roleId = Number(req.params.roleId);
    const { dimension, value } = req.body ?? {};
    if (typeof dimension !== 'string' || typeof value !== 'string') {
      res.status(400).json({ error: 'dimension and value are required.' });
      return;
    }
    await addRoleDataScopeRule(roleId, dimension, value);
    res.json(await getRoleAdminView());
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

adminRolesRouter.delete('/:roleId/data-scope/:scopeId', async (req, res, next) => {
  try {
    const roleId = Number(req.params.roleId);
    const scopeId = Number(req.params.scopeId);
    await removeRoleDataScopeRule(roleId, scopeId);
    res.json(await getRoleAdminView());
  } catch (err) {
    next(err);
  }
});
