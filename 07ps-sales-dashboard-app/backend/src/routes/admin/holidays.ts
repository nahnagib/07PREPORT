import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../../middleware/permission';
import { ValidationError } from '../../lib/errors';
import {
  createHoliday,
  deleteHoliday,
  getHolidayById,
  listHolidays,
  updateHoliday,
} from '../../services/holidayAdminService';

export const adminHolidaysRouter = Router();

adminHolidaysRouter.use(
  requireAuth,
  requirePasswordChangeCleared,
  requirePermission('admin_holidays', 'view'),
);

adminHolidaysRouter.get('/', async (req, res, next) => {
  try {
    const page = Number(req.query.page ?? 1) || 1;
    const pageSize = Math.min(Number(req.query.pageSize ?? 50) || 50, 200);
    const { rows, total } = await listHolidays({
      isActive: req.query.isActive === undefined ? undefined : req.query.isActive === 'true',
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      page,
      pageSize,
    });
    res.json({ rows, total, page, pageSize });
  } catch (err) {
    next(err);
  }
});

adminHolidaysRouter.post('/', async (req, res, next) => {
  try {
    const { holidayName, holidayDate, recurring, company } = req.body ?? {};
    const row = await createHoliday(
      {
        holidayName,
        holidayDate,
        recurring: recurring === undefined ? undefined : Boolean(recurring),
        company: company === undefined || company === '' ? null : company,
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

adminHolidaysRouter.get('/:id', async (req, res, next) => {
  try {
    const row = await getHolidayById(Number(req.params.id));
    if (!row) {
      res.status(404).json({ error: 'Holiday not found.' });
      return;
    }
    res.json({ row });
  } catch (err) {
    next(err);
  }
});

adminHolidaysRouter.patch('/:id', async (req, res, next) => {
  try {
    const { holidayName, holidayDate, recurring, company, isActive } = req.body ?? {};
    const row = await updateHoliday(
      Number(req.params.id),
      {
        holidayName: holidayName === undefined ? undefined : holidayName,
        holidayDate: holidayDate === undefined ? undefined : holidayDate,
        recurring: recurring === undefined ? undefined : Boolean(recurring),
        company: company === undefined ? undefined : company === '' ? null : company,
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

adminHolidaysRouter.delete('/:id', async (req, res, next) => {
  try {
    await deleteHoliday(Number(req.params.id), req.user!.id);
    res.json({ success: true });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});
