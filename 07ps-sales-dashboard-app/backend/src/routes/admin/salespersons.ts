import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../../middleware/permission';
import { ValidationError } from '../../lib/errors';
import {
  getSalespersonProfileHistory,
  getSalespersonRow,
  listSalespersons,
  upsertSalespersonProfile,
} from '../../services/salespersonAdminService';

export const adminSalespersonsRouter = Router();

adminSalespersonsRouter.use(
  requireAuth,
  requirePasswordChangeCleared,
  requirePermission('admin_salespersons', 'view'),
);

adminSalespersonsRouter.get('/', async (req, res, next) => {
  try {
    const page = Number(req.query.page ?? 1) || 1;
    const pageSize = Math.min(Number(req.query.pageSize ?? 25) || 25, 100);
    const { rows, total } = await listSalespersons({
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      channelKey: req.query.channelKey ? Number(req.query.channelKey) : undefined,
      segmentKey: req.query.segmentKey ? Number(req.query.segmentKey) : undefined,
      salesTeamKey: typeof req.query.salesTeamKey === 'string' ? req.query.salesTeamKey : undefined,
      page,
      pageSize,
    });
    res.json({ rows, total, page, pageSize });
  } catch (err) {
    next(err);
  }
});

adminSalespersonsRouter.get('/:salespersonKey/history', async (req, res, next) => {
  try {
    const salespersonKey = Number(req.params.salespersonKey);
    const page = Number(req.query.page ?? 1) || 1;
    const pageSize = Math.min(Number(req.query.pageSize ?? 25) || 25, 100);
    const result = await getSalespersonProfileHistory(salespersonKey, { page, pageSize });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

adminSalespersonsRouter.patch('/:salespersonKey', async (req, res, next) => {
  try {
    const salespersonKey = Number(req.params.salespersonKey);
    const {
      adminNameOverride,
      channelKeyOverride,
      segmentKeyOverride,
      salesTeamKeyOverride,
      companyKeyOverride,
      targetOverrideAmount,
      note,
    } = req.body ?? {};
    const row = await upsertSalespersonProfile(
      salespersonKey,
      {
        adminNameOverride: adminNameOverride === undefined ? undefined : adminNameOverride,
        channelKeyOverride: channelKeyOverride === undefined ? undefined : channelKeyOverride === null ? null : Number(channelKeyOverride),
        segmentKeyOverride: segmentKeyOverride === undefined ? undefined : segmentKeyOverride === null ? null : Number(segmentKeyOverride),
        salesTeamKeyOverride: salesTeamKeyOverride === undefined ? undefined : salesTeamKeyOverride,
        companyKeyOverride: companyKeyOverride === undefined ? undefined : companyKeyOverride === null ? null : Number(companyKeyOverride),
        targetOverrideAmount: targetOverrideAmount === undefined ? undefined : targetOverrideAmount === null ? null : Number(targetOverrideAmount),
        note: note === undefined ? undefined : note,
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

/** Simple loop of single upserts, one history row per salesperson -- no separate bulk-batch
 * table, no all-or-nothing transaction. Returns per-key success/failure so a partial failure
 * (e.g. one invalid key in the batch) doesn't roll back the rest. */
adminSalespersonsRouter.post('/bulk', async (req, res, next) => {
  try {
    const { salespersonKeys, patch } = req.body ?? {};
    if (!Array.isArray(salespersonKeys) || salespersonKeys.length === 0) {
      res.status(400).json({ error: 'salespersonKeys must be a non-empty array.' });
      return;
    }
    const results: Array<{ salespersonKey: number; ok: boolean; error?: string }> = [];
    for (const key of salespersonKeys) {
      const salespersonKey = Number(key);
      try {
        await upsertSalespersonProfile(
          salespersonKey,
          {
            channelKeyOverride: patch?.channelKeyOverride === undefined ? undefined : patch.channelKeyOverride === null ? null : Number(patch.channelKeyOverride),
            segmentKeyOverride: patch?.segmentKeyOverride === undefined ? undefined : patch.segmentKeyOverride === null ? null : Number(patch.segmentKeyOverride),
            salesTeamKeyOverride: patch?.salesTeamKeyOverride === undefined ? undefined : patch.salesTeamKeyOverride,
            companyKeyOverride: patch?.companyKeyOverride === undefined ? undefined : patch.companyKeyOverride === null ? null : Number(patch.companyKeyOverride),
            targetOverrideAmount: patch?.targetOverrideAmount === undefined ? undefined : patch.targetOverrideAmount === null ? null : Number(patch.targetOverrideAmount),
            note: patch?.note === undefined ? undefined : patch.note,
          },
          req.user!.id,
        );
        results.push({ salespersonKey, ok: true });
      } catch (err) {
        results.push({ salespersonKey, ok: false, error: err instanceof ValidationError ? err.message : 'Update failed.' });
      }
    }
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

adminSalespersonsRouter.get('/:salespersonKey', async (req, res, next) => {
  try {
    const salespersonKey = Number(req.params.salespersonKey);
    const row = await getSalespersonRow(salespersonKey);
    if (!row) {
      res.status(404).json({ error: 'Salesperson not found.' });
      return;
    }
    res.json({ row });
  } catch (err) {
    next(err);
  }
});
