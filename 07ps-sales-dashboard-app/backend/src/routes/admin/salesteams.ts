import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../../middleware/permission';
import { ValidationError } from '../../lib/errors';
import {
  bulkUpdateSalesTeamCompany,
  bulkUpdateSalesTeamSegment,
  getSalesTeamProfileHistory,
  getSalesTeamRow,
  listSalesTeams,
  upsertSalesTeamProfile,
} from '../../services/salesTeamAdminService';

export const adminSalesTeamsRouter = Router();

adminSalesTeamsRouter.use(
  requireAuth,
  requirePasswordChangeCleared,
  requirePermission('admin_salesteams', 'view'),
);

adminSalesTeamsRouter.get('/', async (req, res, next) => {
  try {
    const page = Number(req.query.page ?? 1) || 1;
    const pageSize = Math.min(Number(req.query.pageSize ?? 25) || 25, 100);
    const { rows, total } = await listSalesTeams({
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      segmentKey: req.query.segmentKey ? Number(req.query.segmentKey) : undefined,
      page,
      pageSize,
    });
    res.json({ rows, total, page, pageSize });
  } catch (err) {
    next(err);
  }
});

adminSalesTeamsRouter.get('/:salesTeamKey/history', async (req, res, next) => {
  try {
    const page = Number(req.query.page ?? 1) || 1;
    const pageSize = Math.min(Number(req.query.pageSize ?? 25) || 25, 100);
    const result = await getSalesTeamProfileHistory(req.params.salesTeamKey, { page, pageSize });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

adminSalesTeamsRouter.patch('/:salesTeamKey', requirePermission('admin_salesteams', 'edit'), async (req, res, next) => {
  try {
    const { teamNameOverride, teamCode, segmentKeyOverride, companyKeyOverride, targetOverrideAmount, note } =
      req.body ?? {};
    const row = await upsertSalesTeamProfile(
      req.params.salesTeamKey,
      {
        teamNameOverride: teamNameOverride === undefined ? undefined : teamNameOverride,
        teamCode: teamCode === undefined ? undefined : String(teamCode),
        segmentKeyOverride: segmentKeyOverride === undefined ? undefined : segmentKeyOverride === null ? null : Number(segmentKeyOverride),
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

/** Restricted to Customer Group only -- "No bulk Name/Code edit (too risky)" per the approved
 * feedback. The request body only ever accepts segmentKeyOverride; any other field is ignored,
 * not silently applied. */
adminSalesTeamsRouter.post('/bulk', requirePermission('admin_salesteams', 'edit'), async (req, res, next) => {
  try {
    const { salesTeamKeys, patch } = req.body ?? {};
    if (!Array.isArray(salesTeamKeys) || salesTeamKeys.length === 0) {
      res.status(400).json({ error: 'salesTeamKeys must be a non-empty array.' });
      return;
    }
    const segmentKeyOverride =
      patch?.segmentKeyOverride === undefined ? undefined : patch.segmentKeyOverride === null ? null : Number(patch.segmentKeyOverride);
    if (segmentKeyOverride === undefined) {
      res.status(400).json({ error: 'Bulk update only supports segmentKeyOverride.' });
      return;
    }
    const results = await bulkUpdateSalesTeamSegment(salesTeamKeys.map(String), segmentKeyOverride, req.user!.id);
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

/** Company Link + Cascading Filter Bar, 2026-09 -- a separate route (not folded into /bulk above)
 * so that route's existing "segment only, rejects anything else" guard stays intact and easy to
 * reason about. Same restricted-to-one-field shape, just companyKeyOverride instead. */
adminSalesTeamsRouter.post('/bulk-company', requirePermission('admin_salesteams', 'edit'), async (req, res, next) => {
  try {
    const { salesTeamKeys, patch } = req.body ?? {};
    if (!Array.isArray(salesTeamKeys) || salesTeamKeys.length === 0) {
      res.status(400).json({ error: 'salesTeamKeys must be a non-empty array.' });
      return;
    }
    const companyKeyOverride =
      patch?.companyKeyOverride === undefined ? undefined : patch.companyKeyOverride === null ? null : Number(patch.companyKeyOverride);
    if (companyKeyOverride === undefined) {
      res.status(400).json({ error: 'Bulk update only supports companyKeyOverride.' });
      return;
    }
    const results = await bulkUpdateSalesTeamCompany(salesTeamKeys.map(String), companyKeyOverride, req.user!.id);
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

adminSalesTeamsRouter.get('/:salesTeamKey', async (req, res, next) => {
  try {
    const row = await getSalesTeamRow(req.params.salesTeamKey);
    if (!row) {
      res.status(404).json({ error: 'Sales team not found.' });
      return;
    }
    res.json({ row });
  } catch (err) {
    next(err);
  }
});
