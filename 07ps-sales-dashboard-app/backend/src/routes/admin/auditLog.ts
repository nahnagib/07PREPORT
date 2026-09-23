import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { requireAdminRole, requirePasswordChangeCleared } from '../../middleware/permission';
import { listAuditEntityTypes, listAuditLog } from '../../services/auditLogService';

/**
 * Read-only view of audit_log for the admin Audit Log screen. Admin-role-only (requireAdminRole),
 * like the ETL Control Center whose uploads it mainly shows -- entries carry file paths and
 * before/after snapshots that are not meant for delegated roles.
 */
export const adminAuditLogRouter = Router();

adminAuditLogRouter.use(requireAuth, requirePasswordChangeCleared, requireAdminRole);

adminAuditLogRouter.get('/', async (req, res, next) => {
  try {
    const page = Math.max(Number(req.query.page ?? 1) || 1, 1);
    const pageSize = Math.min(Math.max(Number(req.query.pageSize ?? 25) || 25, 1), 100);
    const entityType = typeof req.query.entityType === 'string' && req.query.entityType ? req.query.entityType : undefined;
    const entityId = typeof req.query.entityId === 'string' && req.query.entityId ? req.query.entityId : undefined;
    const result = await listAuditLog({ entityType, entityId, page, pageSize });
    res.json({ ...result, page, pageSize });
  } catch (err) {
    next(err);
  }
});

adminAuditLogRouter.get('/entity-types', async (_req, res, next) => {
  try {
    res.json({ entityTypes: await listAuditEntityTypes() });
  } catch (err) {
    next(err);
  }
});
