import { Router } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../middleware/permission';
import { attachUserContext, resolveScopedFilters } from '../middleware/scopeContext';
import { computePipelineHealthOverview } from '../measures/pipelineHealth';

/**
 * Pipeline Health page KPI endpoint. Same middleware chain and scoping discipline as every other
 * page -- every query goes through resolveScopedFilters before any measures function runs.
 *
 * One /overview endpoint: the funnel, Stage Benchmark, Expected Closure Opportunity chart,
 * Opportunity by Stage donut, Probabilities Distribution, and the full Opportunity Details array
 * (shared drill-through target for all 3 drillable visuals -- filtered client-side by whichever of
 * month/stage/probability-bucket was clicked, same convention as Customer Growth's Customers Table).
 *
 * No anchorDate: unlike every other page, this page's figures are all-time (the funnel/benchmark
 * represent the pipeline's overall conversion structure, not a period snapshot) -- see
 * measures/pipelineHealth.ts's header comment.
 */
export const pipelineHealthRouter = Router();

pipelineHealthRouter.use(
  requireAuth,
  requirePasswordChangeCleared,
  requirePermission('pipeline_health', 'view'),
  attachUserContext,
  resolveScopedFilters,
);

pipelineHealthRouter.get('/overview', async (req, res, next) => {
  try {
    const filters = req.scopedFilters!;
    const overview = await computePipelineHealthOverview(pool, filters);
    res.json(overview);
  } catch (err) {
    next(err);
  }
});
