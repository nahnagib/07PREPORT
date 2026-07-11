import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../../middleware/permission';
import { LoginHistoryEventType, listLoginHistory } from '../../services/loginHistoryService';

export const adminLoginHistoryRouter = Router();

adminLoginHistoryRouter.use(
  requireAuth,
  requirePasswordChangeCleared,
  requirePermission('admin_login_history', 'view'),
);

adminLoginHistoryRouter.get('/', async (req, res, next) => {
  try {
    const page = Number(req.query.page ?? 1) || 1;
    const pageSize = Math.min(Number(req.query.pageSize ?? 50) || 50, 200);
    const result = await listLoginHistory({
      userId: req.query.userId ? Number(req.query.userId) : undefined,
      eventType: typeof req.query.eventType === 'string' ? (req.query.eventType as LoginHistoryEventType) : undefined,
      fromDate: typeof req.query.fromDate === 'string' ? req.query.fromDate : undefined,
      toDate: typeof req.query.toDate === 'string' ? req.query.toDate : undefined,
      page,
      pageSize,
    });
    res.json({ ...result, page, pageSize });
  } catch (err) {
    next(err);
  }
});
