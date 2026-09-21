import { Router } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../middleware/permission';
import { attachUserContext, resolveScopedFilters } from '../middleware/scopeContext';
import { parsePipelineAnchor } from '../measures/filters';
import { computeActivityMomentumOverview } from '../measures/activityMomentum';

/**
 * Activity Momentum page KPI endpoint. Same middleware chain and scoping discipline as every other
 * page. See measures/activityMomentum.ts's header comment for the activity-column graceful
 * degradation (the `activityColumnsAvailable` flag on the response lets the frontend distinguish
 * "genuinely zero" from "not available until the next ETL refresh").
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
