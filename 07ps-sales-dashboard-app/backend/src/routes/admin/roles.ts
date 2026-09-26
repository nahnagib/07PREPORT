import { NextFunction, Request, Response, Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../../middleware/permission';
import { ValidationError } from '../../lib/errors';
import { PERMISSION_REGISTRY } from '../../config/permissionRegistry';
import {
  ROLE_ENTITY,
  RoleInUseError,
  createRole,
  deleteRole,
  duplicateRole,
  getRoleDetail,
  listRoleTiers,
  listRolesWithStats,
  updateRole,
} from '../../services/roleService';
import {
  DATA_SCOPE_DIMENSIONS,
  addRoleDataScopeRule,
  getAllRoleDataScopeRulesWithLabels,
  removeRoleDataScopeRule,
} from '../../services/dataScopeService';
import { writeAuditLog } from '../../services/auditLogService';

/**
 * Admin Panel > Roles. Reading needs View on admin_roles; creating/duplicating needs Create,
 * renaming/permission/data-scope changes need Edit, deleting needs Delete. The protections for
 * built-in roles and the Admin role live in services/roleService.ts, so they hold for any caller.
 */
export const adminRolesRouter = Router();

adminRolesRouter.use(requireAuth, requirePasswordChangeCleared, requirePermission('admin_roles', 'view'));

function handleError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof RoleInUseError) {
    res.status(409).json({ error: err.message, code: 'ROLE_IN_USE', userCount: err.userCount });
    return;
  }
  if (err instanceof ValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  next(err);
}

function roleIdParam(req: Request): number {
  const id = Number(req.params.roleId);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError('Invalid role id.');
  return id;
}

/** Everything the Roles screen needs in one call: roles (with user counts), the permission
 * registry the matrix is built from, data-scope tiers, and every role's data-scope rules. */
adminRolesRouter.get('/', async (_req, res, next) => {
  try {
    const [roles, tiers, dataScope] = await Promise.all([
      listRolesWithStats(),
      listRoleTiers(),
      getAllRoleDataScopeRulesWithLabels(),
    ]);
    res.json({ roles, registry: PERMISSION_REGISTRY, tiers, dataScope, dimensions: DATA_SCOPE_DIMENSIONS });
  } catch (err) {
    next(err);
  }
});

adminRolesRouter.get('/:roleId', async (req, res, next) => {
  try {
    const role = await getRoleDetail(roleIdParam(req));
    if (!role) {
      res.status(404).json({ error: 'Role not found.' });
      return;
    }
    res.json({ role });
  } catch (err) {
    handleError(err, res, next);
  }
});

adminRolesRouter.post('/', requirePermission('admin_roles', 'create'), async (req, res, next) => {
  try {
    const { name, description, tierCode, permissions } = req.body ?? {};
    const role = await createRole({ label: name, description, tierCode, permissions }, req.user!.id);
    res.status(201).json({ role });
  } catch (err) {
    handleError(err, res, next);
  }
});

adminRolesRouter.post('/:roleId/duplicate', requirePermission('admin_roles', 'create'), async (req, res, next) => {
  try {
    const role = await duplicateRole(roleIdParam(req), req.user!.id);
    res.status(201).json({ role });
  } catch (err) {
    handleError(err, res, next);
  }
});

adminRolesRouter.put('/:roleId', requirePermission('admin_roles', 'edit'), async (req, res, next) => {
  try {
    const { name, description, tierCode, permissions } = req.body ?? {};
    const role = await updateRole(roleIdParam(req), { label: name, description, tierCode, permissions }, req.user!.id);
    res.json({ role });
  } catch (err) {
    handleError(err, res, next);
  }
});

adminRolesRouter.delete('/:roleId', requirePermission('admin_roles', 'delete'), async (req, res, next) => {
  try {
    const raw = req.body?.replacementRoleId ?? req.query.replacementRoleId;
    const replacement = raw === undefined || raw === null || raw === '' ? null : Number(raw);
    await deleteRole(roleIdParam(req), replacement, req.user!.id);
    res.json({ ok: true });
  } catch (err) {
    handleError(err, res, next);
  }
});

adminRolesRouter.post('/:roleId/data-scope', requirePermission('admin_roles', 'edit'), async (req, res, next) => {
  try {
    const roleId = roleIdParam(req);
    const { dimension, value } = req.body ?? {};
    if (typeof dimension !== 'string' || typeof value !== 'string') {
      res.status(400).json({ error: 'dimension and value are required.' });
      return;
    }
    await addRoleDataScopeRule(roleId, dimension, value);
    await writeAuditLog({
      entityType: ROLE_ENTITY,
      entityId: String(roleId),
      action: 'UPDATE',
      changedBy: req.user!.id,
      after: { dataScopeRuleAdded: { dimension, value } },
    });
    res.json({ dataScope: await getAllRoleDataScopeRulesWithLabels() });
  } catch (err) {
    handleError(err, res, next);
  }
});

adminRolesRouter.delete('/:roleId/data-scope/:scopeId', requirePermission('admin_roles', 'edit'), async (req, res, next) => {
  try {
    const roleId = roleIdParam(req);
    const scopeId = Number(req.params.scopeId);
    const before = (await getAllRoleDataScopeRulesWithLabels())[roleId]?.find((r) => r.scopeId === scopeId);
    await removeRoleDataScopeRule(roleId, scopeId);
    await writeAuditLog({
      entityType: ROLE_ENTITY,
      entityId: String(roleId),
      action: 'UPDATE',
      changedBy: req.user!.id,
      before: { dataScopeRuleRemoved: before ?? { scopeId } },
    });
    res.json({ dataScope: await getAllRoleDataScopeRulesWithLabels() });
  } catch (err) {
    handleError(err, res, next);
  }
});
