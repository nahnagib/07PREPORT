import { Router } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../middleware/permission';
import { attachUserContext, resolveScopedFilters } from '../middleware/scopeContext';
import { parsePipelineAnchor } from '../measures/filters';
import { computeActivityMomentumOverview, fetchNewOpportunitiesTrend } from '../measures/activityMomentum';
import { parseGranularity, PeriodQueryError } from '../lib/periods';

/**
 * Activity Momentum page KPI endpoint. Same middleware chain and scoping discipline as every other
 * page. See measures/activityMomentum.ts's header comment for the activity-column graceful
 * degradation (the `activityColumnsAvailable` flag on the response lets the frontend distinguish
 * "genuinely zero" from "not available until the next ETL refresh").
 * /trend?granularity=day|week|month|year (default week): the New Opportunities chart over that period window.
 */
export const activityMomentumRouter = Router();

activityMomentumRouter.use(
  requireAuth,
  requirePasswordChangeCleared,
  requirePermission('activity_momentum', 'view'),
  attachUserContext,
  resolveScopedFilters,
);

activityMomentumRouter.get('/overview', async (req, res, next) => {
  try {
    const filters = req.scopedFilters!;
    const anchor = parsePipelineAnchor(req.query.anchorDate);
    const overview = await computeActivityMomentumOverview(pool, anchor, filters);
    res.json({ anchorDate: anchor.toISOString().slice(0, 10), ...overview });
  } catch (err) {
    next(err);
  }
});

activityMomentumRouter.get('/trend', async (req, res, next) => {
  try {
    res.json(await fetchNewOpportunitiesTrend(pool, parsePipelineAnchor(req.query.anchorDate), parseGranularity(req.query.granularity), req.scopedFilters!));
  } catch (err) {
    if (err instanceof PeriodQueryError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});
