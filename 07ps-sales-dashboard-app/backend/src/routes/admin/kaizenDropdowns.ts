import { NextFunction, Response, Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { requireAdminRole, requirePasswordChangeCleared } from '../../middleware/permission';
import { ValidationError } from '../../lib/errors';
import {
  KaizenValidationError,
  createDropdownValue,
  deleteDropdownValue,
  listDropdownValues,
  reorderDropdownValues,
  updateDropdownValue,
} from '../../services/kaizenService';

/** Kaizen Board dropdown lists (Department / Card Type / Card Priority). Admin role only -- like the
 * ETL Control Center, deliberately outside the grantable permission registry. */
export const adminKaizenDropdownsRouter = Router();

adminKaizenDropdownsRouter.use(requireAuth, requirePasswordChangeCleared, requireAdminRole);

function sendError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof KaizenValidationError) {
    res.status(400).json({ error: err.message, code: err.code, field: err.field });
    return;
  }
  if (err instanceof ValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  next(err);
}

function numberOrUndefined(value: unknown): number | undefined {
  return value === undefined || value === null || value === '' ? undefined : Number(value);
}

adminKaizenDropdownsRouter.get('/', async (_req, res, next) => {
  try {
    res.json({ rows: await listDropdownValues() });
  } catch (err) {
    next(err);
  }
});

adminKaizenDropdownsRouter.post('/', async (req, res, next) => {
  try {
    const { listKey, labelEn, labelAr, sortOrder, color, isActive } = req.body ?? {};
    const row = await createDropdownValue(
      { listKey, labelEn, labelAr, sortOrder: numberOrUndefined(sortOrder), color, isActive: isActive === undefined ? undefined : Boolean(isActive) },
      req.user!.id,
    );
    res.status(201).json({ row });
  } catch (err) {
    sendError(err, res, next);
  }
});

adminKaizenDropdownsRouter.post('/reorder', async (req, res, next) => {
  try {
    const { listKey, orderedIds } = req.body ?? {};
    await reorderDropdownValues(String(listKey), Array.isArray(orderedIds) ? orderedIds.map(Number) : [], req.user!.id);
    res.json({ rows: await listDropdownValues() });
  } catch (err) {
    sendError(err, res, next);
  }
});

adminKaizenDropdownsRouter.patch('/:id', async (req, res, next) => {
  try {
    const { labelEn, labelAr, sortOrder, color, isActive } = req.body ?? {};
    const row = await updateDropdownValue(
      Number(req.params.id),
      { labelEn, labelAr, sortOrder: numberOrUndefined(sortOrder), color, isActive: isActive === undefined ? undefined : Boolean(isActive) },
      req.user!.id,
    );
    res.json({ row });
  } catch (err) {
    sendError(err, res, next);
  }
});

adminKaizenDropdownsRouter.delete('/:id', async (req, res, next) => {
  try {
    await deleteDropdownValue(Number(req.params.id), req.user!.id);
    res.json({ success: true });
  } catch (err) {
    sendError(err, res, next);
  }
});
