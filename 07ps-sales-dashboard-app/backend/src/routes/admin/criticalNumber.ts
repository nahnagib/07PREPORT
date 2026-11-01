import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { requireAdminRole, requirePasswordChangeCleared } from '../../middleware/permission';
import { ValidationError } from '../../lib/errors';
import { createCriticalNumberChange, getCriticalNumberAdminView } from '../../services/criticalNumberAdminService';

/** Admin > Critical Number: the dated Daily Critical Number base value. Admin role only -- like the ETL Control
 * Center, deliberately outside the grantable permission registry, so no other role can be given it. */
export const adminCriticalNumberRouter = Router();

adminCriticalNumberRouter.use(requireAuth, requirePasswordChangeCleared, requireAdminRole);

adminCriticalNumberRouter.get('/', async (_req, res, next) => {
  try {
    res.json(await getCriticalNumberAdminView());
  } catch (err) {
    next(err);
  }
});

/** { value, effectiveFrom: 'YYYY-MM-DD', note?, confirmLargeChange? } -> a new history row; returns the fresh view. */
adminCriticalNumberRouter.post('/', async (req, res, next) => {
  try {
    const { value, effectiveFrom, note, confirmLargeChange } = req.body ?? {};
    res.status(201).json(await createCriticalNumberChange({ value, effectiveFrom, note, confirmLargeChange }, req.user!.id));
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});
