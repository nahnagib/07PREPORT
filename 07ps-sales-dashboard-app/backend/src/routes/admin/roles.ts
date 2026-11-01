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
  addRoleScopeRule,
  getAllRoleDataScopeRulesWithLabels,
  getDimensionValues,
  removeRoleScopeRule,
  setRoleScopeRule,
  updateRoleScopeRule,
  type DataScopeRuleWithLabels,
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
 * registry the matrix is built from, data-scope tiers and every role's data-scope rules
 * ({ dimension, ruleNo, operator: 'in' | 'not_in', values }; several rules per dimension since 0056, all applying).
 * The value picker loads its options per dimension below. */
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

/** Every value of one data-scope dimension for the Roles page's value picker: [{ value, label }], the whole dim
 * table, Unknown / Unassigned included -- never narrowed by the signed-in admin's own data scope (this router has no
 * scope middleware; services/dataScopeService.ts getDimensionValues reads the table directly). */
adminRolesRouter.get('/dimension-values/:dimension', async (req, res, next) => {
  try {
    res.json({ dimension: req.params.dimension, values: await getDimensionValues(req.params.dimension) });
  } catch (err) {
    handleError(err, res, next);
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

function ruleNoParam(req: Request): number {
  const n = Number(req.params.ruleNo);
  if (!Number.isInteger(n) || n <= 0) throw new ValidationError('Invalid rule number.');
  return n;
}

/** A rule as the audit log stores it (keys only, no labels). */
function auditRule(rule: Pick<DataScopeRuleWithLabels, 'dimension' | 'ruleNo' | 'operator'> & { values: (string | { value: string })[] }) {
  return {
    dimension: rule.dimension,
    ruleNo: rule.ruleNo,
    operator: rule.operator,
    values: rule.values.map((v) => (typeof v === 'string' ? v : v.value)),
  };
}

async function savedRule(roleId: number, dimension: string, ruleNo?: number): Promise<DataScopeRuleWithLabels[]> {
  const rules = ((await getAllRoleDataScopeRulesWithLabels())[roleId] ?? []).filter((r) => r.dimension === dimension);
  return ruleNo === undefined ? rules : rules.filter((r) => r.ruleNo === ruleNo);
}

/**
 * Adds a rule: { dimension, operator: 'in' | 'not_in', values: [...] } (2026-10-21). A dimension may hold several
 * rules; all of them apply (AND). Validated server-side (services/dataScopeService.ts addRoleScopeRule): known
 * dimension and operator, at least one value, every value an existing key, and the dimension's rules together must
 * still match some value ("is A" AND "is not A" is refused).
 */
adminRolesRouter.post('/:roleId/data-scope', requirePermission('admin_roles', 'edit'), async (req, res, next) => {
  try {
    const roleId = roleIdParam(req);
    if (!(await getRoleDetail(roleId))) {
      res.status(404).json({ error: 'Role not found.' });
      return;
    }
    const rule = await addRoleScopeRule(roleId, req.body ?? {});
    await writeAuditLog({
      entityType: ROLE_ENTITY,
      entityId: String(roleId),
      action: 'UPDATE',
      changedBy: req.user!.id,
      after: { dataScopeRuleAdded: auditRule(rule) },
    });
    res.status(201).json({ dataScope: await getAllRoleDataScopeRulesWithLabels() });
  } catch (err) {
    handleError(err, res, next);
  }
});

/** Replaces one rule of a dimension ({ operator, values }); the dimension's other rules stay as they are. */
adminRolesRouter.put('/:roleId/data-scope/:dimension/:ruleNo', requirePermission('admin_roles', 'edit'), async (req, res, next) => {
  try {
    const roleId = roleIdParam(req);
    const ruleNo = ruleNoParam(req);
    if (!(await getRoleDetail(roleId))) {
      res.status(404).json({ error: 'Role not found.' });
      return;
    }
    const [before] = await savedRule(roleId, req.params.dimension, ruleNo);
    const rule = await updateRoleScopeRule(roleId, ruleNo, { ...(req.body ?? {}), dimension: req.params.dimension });
    await writeAuditLog({
      entityType: ROLE_ENTITY,
      entityId: String(roleId),
      action: 'UPDATE',
      changedBy: req.user!.id,
      before: before ? { dataScopeRule: auditRule(before) } : undefined,
      after: { dataScopeRule: auditRule(rule) },
    });
    res.json({ dataScope: await getAllRoleDataScopeRulesWithLabels() });
  } catch (err) {
    handleError(err, res, next);
  }
});

/** Removes one rule of a dimension; the dimension's other rules keep applying. */
adminRolesRouter.delete('/:roleId/data-scope/:dimension/:ruleNo', requirePermission('admin_roles', 'edit'), async (req, res, next) => {
  try {
    const roleId = roleIdParam(req);
    const ruleNo = ruleNoParam(req);
    const [before] = await savedRule(roleId, req.params.dimension, ruleNo);
    await removeRoleScopeRule(roleId, req.params.dimension, ruleNo);
    await writeAuditLog({
      entityType: ROLE_ENTITY,
      entityId: String(roleId),
      action: 'UPDATE',
      changedBy: req.user!.id,
      before: { dataScopeRuleRemoved: before ? auditRule(before) : { dimension: req.params.dimension, ruleNo } },
    });
    res.json({ dataScope: await getAllRoleDataScopeRulesWithLabels() });
  } catch (err) {
    handleError(err, res, next);
  }
});

/**
 * Sets ONE rule as the dimension's only rule: { operator: 'in' | 'not_in', values: [...] }, replacing every rule the
 * dimension had -- the one-rule-per-dimension endpoint from 2026-10-15, kept for existing callers (the Roles page now
 * uses the per-rule endpoints above).
 */
adminRolesRouter.put('/:roleId/data-scope/:dimension', requirePermission('admin_roles', 'edit'), async (req, res, next) => {
  try {
    const roleId = roleIdParam(req);
    if (!(await getRoleDetail(roleId))) {
      res.status(404).json({ error: 'Role not found.' });
      return;
    }
    const before = await savedRule(roleId, req.params.dimension);
    const rule = await setRoleScopeRule(roleId, { ...(req.body ?? {}), dimension: req.params.dimension });
    await writeAuditLog({
      entityType: ROLE_ENTITY,
      entityId: String(roleId),
      action: 'UPDATE',
      changedBy: req.user!.id,
      before: before.length > 0 ? { dataScopeRules: before.map(auditRule) } : undefined,
      after: { dataScopeRule: auditRule(rule) },
    });
    res.json({ dataScope: await getAllRoleDataScopeRulesWithLabels() });
  } catch (err) {
    handleError(err, res, next);
  }
});

/** Removes every rule of one dimension (= no restriction on that dimension). */
adminRolesRouter.delete('/:roleId/data-scope/:dimension', requirePermission('admin_roles', 'edit'), async (req, res, next) => {
  try {
    const roleId = roleIdParam(req);
    const before = await savedRule(roleId, req.params.dimension);
    await removeRoleScopeRule(roleId, req.params.dimension);
    await writeAuditLog({
      entityType: ROLE_ENTITY,
      entityId: String(roleId),
      action: 'UPDATE',
      changedBy: req.user!.id,
      before: { dataScopeRuleRemoved: before.length > 0 ? before.map(auditRule) : { dimension: req.params.dimension } },
    });
    res.json({ dataScope: await getAllRoleDataScopeRulesWithLabels() });
  } catch (err) {
    handleError(err, res, next);
  }
});
