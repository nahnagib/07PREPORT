import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../../middleware/permission';
import { ValidationError } from '../../lib/errors';
import {
  createCustomerGroup,
  deleteCustomerGroup,
  getCustomerGroupById,
  getEtlSegmentOptions,
  listCustomerGroups,
  updateCustomerGroup,
} from '../../services/customerGroupAdminService';

export const adminCustomerGroupsRouter = Router();

adminCustomerGroupsRouter.use(
  requireAuth,
  requirePasswordChangeCleared,
  requirePermission('admin_customer_groups', 'view'),
);

adminCustomerGroupsRouter.get('/etl-options', async (_req, res, next) => {
  try {
    res.json(await getEtlSegmentOptions());
  } catch (err) {
    next(err);
  }
});

adminCustomerGroupsRouter.get('/', async (req, res, next) => {
  try {
    const page = Number(req.query.page ?? 1) || 1;
    const pageSize = Math.min(Number(req.query.pageSize ?? 50) || 50, 200);
    const { rows, total } = await listCustomerGroups({
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

adminCustomerGroupsRouter.post('/', requirePermission('admin_customer_groups', 'create'), async (req, res, next) => {
  try {
    const { name, definition, etlSegmentKey, displayOrder, criticalNumberPct } = req.body ?? {};
    const row = await createCustomerGroup(
      {
        name,
        definition: definition === undefined ? undefined : definition,
        etlSegmentKey: etlSegmentKey === undefined || etlSegmentKey === null ? null : Number(etlSegmentKey),
        displayOrder: displayOrder === undefined ? undefined : Number(displayOrder),
        criticalNumberPct: criticalNumberPct === undefined ? undefined : Number(criticalNumberPct),
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

adminCustomerGroupsRouter.get('/:id', async (req, res, next) => {
  try {
    const row = await getCustomerGroupById(Number(req.params.id));
    if (!row) {
      res.status(404).json({ error: 'Customer group not found.' });
      return;
    }
    res.json({ row });
  } catch (err) {
    next(err);
  }
});

adminCustomerGroupsRouter.patch('/:id', requirePermission('admin_customer_groups', 'edit'), async (req, res, next) => {
  try {
    const { name, definition, etlSegmentKey, displayOrder, criticalNumberPct, isActive } = req.body ?? {};
    const row = await updateCustomerGroup(
      Number(req.params.id),
      {
        name: name === undefined ? undefined : name,
        definition: definition === undefined ? undefined : definition,
        etlSegmentKey: etlSegmentKey === undefined ? undefined : etlSegmentKey === null ? null : Number(etlSegmentKey),
        displayOrder: displayOrder === undefined ? undefined : Number(displayOrder),
        criticalNumberPct: criticalNumberPct === undefined ? undefined : Number(criticalNumberPct),
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

adminCustomerGroupsRouter.delete('/:id', requirePermission('admin_customer_groups', 'delete'), async (req, res, next) => {
  try {
    await deleteCustomerGroup(Number(req.params.id), req.user!.id);
    res.json({ success: true });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});
