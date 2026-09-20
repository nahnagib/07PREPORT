import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../../middleware/permission';
import { ValidationError } from '../../lib/errors';
import {
  createDistributionChannel,
  deleteDistributionChannel,
  getDistributionChannelById,
  getEtlChannelOptions,
  listDistributionChannels,
  updateDistributionChannel,
} from '../../services/distributionChannelAdminService';

export const adminDistributionChannelsRouter = Router();

adminDistributionChannelsRouter.use(
  requireAuth,
  requirePasswordChangeCleared,
  requirePermission('admin_distribution_channels', 'view'),
);

adminDistributionChannelsRouter.get('/etl-options', async (_req, res, next) => {
  try {
    res.json(await getEtlChannelOptions());
  } catch (err) {
    next(err);
  }
});

adminDistributionChannelsRouter.get('/', async (req, res, next) => {
  try {
    const page = Number(req.query.page ?? 1) || 1;
    const pageSize = Math.min(Number(req.query.pageSize ?? 50) || 50, 200);
    const { rows, total } = await listDistributionChannels({
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

adminDistributionChannelsRouter.post('/', async (req, res, next) => {
  try {
    const { name, definition, etlChannelKey, displayOrder } = req.body ?? {};
    const row = await createDistributionChannel(
      {
        name,
        definition: definition === undefined ? undefined : definition,
        etlChannelKey: etlChannelKey === undefined || etlChannelKey === null ? null : Number(etlChannelKey),
        displayOrder: displayOrder === undefined ? undefined : Number(displayOrder),
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

adminDistributionChannelsRouter.get('/:id', async (req, res, next) => {
  try {
    const row = await getDistributionChannelById(Number(req.params.id));
    if (!row) {
      res.status(404).json({ error: 'Distribution channel not found.' });
      return;
    }
    res.json({ row });
  } catch (err) {
    next(err);
  }
});

adminDistributionChannelsRouter.patch('/:id', async (req, res, next) => {
  try {
    const { name, definition, etlChannelKey, displayOrder, isActive } = req.body ?? {};
    const row = await updateDistributionChannel(
      Number(req.params.id),
      {
        name: name === undefined ? undefined : name,
        definition: definition === undefined ? undefined : definition,
        etlChannelKey: etlChannelKey === undefined ? undefined : etlChannelKey === null ? null : Number(etlChannelKey),
        displayOrder: displayOrder === undefined ? undefined : Number(displayOrder),
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

adminDistributionChannelsRouter.delete('/:id', async (req, res, next) => {
  try {
    await deleteDistributionChannel(Number(req.params.id), req.user!.id);
    res.json({ success: true });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});
