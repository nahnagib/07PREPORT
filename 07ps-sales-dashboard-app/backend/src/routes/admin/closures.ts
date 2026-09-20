import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../../middleware/permission';
import { ValidationError } from '../../lib/errors';
import {
  createClosure,
  deleteClosure,
  getBranchOptions,
  getClosureById,
  listClosures,
  updateClosure,
} from '../../services/closureAdminService';

export const adminClosuresRouter = Router();

adminClosuresRouter.use(
  requireAuth,
  requirePasswordChangeCleared,
  requirePermission('admin_closures', 'view'),
);

adminClosuresRouter.get('/branch-options', async (_req, res, next) => {
  try {
    res.json(await getBranchOptions());
  } catch (err) {
    next(err);
  }
});

adminClosuresRouter.get('/', async (req, res, next) => {
  try {
    const page = Number(req.query.page ?? 1) || 1;
    const pageSize = Math.min(Number(req.query.pageSize ?? 50) || 50, 200);
    const { rows, total } = await listClosures({
      isActive: req.query.isActive === undefined ? undefined : req.query.isActive === 'true',
      branchKey: typeof req.query.branchKey === 'string' ? req.query.branchKey : undefined,
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      page,
      pageSize,
    });
    res.json({ rows, total, page, pageSize });
  } catch (err) {
    next(err);
  }
});

adminClosuresRouter.post('/', async (req, res, next) => {
  try {
    const { branchKey, company, closureDate, durationDays, reason } = req.body ?? {};
    const row = await createClosure(
      {
        branchKey,
        company: company === undefined || company === '' ? null : company,
        closureDate,
        durationDays: durationDays === undefined ? undefined : Number(durationDays),
        reason: reason === undefined || reason === '' ? null : reason,
      },
      req.user!.id,
    );
    res.status(201).json({ row });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

adminClosuresRouter.get('/:id', async (req, res, next) => {
  try {
    const row = await getClosureById(Number(req.params.id));
    if (!row) {
      res.status(404).json({ error: 'Closure not found.' });
      return;
    }
    res.json({ row });
  } catch (err) {
    next(err);
  }
});

adminClosuresRouter.patch('/:id', async (req, res, next) => {
  try {
    const { branchKey, company, closureDate, durationDays, reason, isActive } = req.body ?? {};
    const row = await updateClosure(
      Number(req.params.id),
      {
        branchKey: branchKey === undefined ? undefined : branchKey,
        company: company === undefined ? undefined : company === '' ? null : company,
        closureDate: closureDate === undefined ? undefined : closureDate,
        durationDays: durationDays === undefined ? undefined : Number(durationDays),
        reason: reason === undefined ? undefined : reason === '' ? null : reason,
        isActive: isActive === undefined ? undefined : Boolean(isActive),
      },
      req.user!.id,
    );
    res.json({ row });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

adminClosuresRouter.delete('/:id', async (req, res, next) => {
  try {
    await deleteClosure(Number(req.params.id), req.user!.id);
    res.json({ success: true });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});
