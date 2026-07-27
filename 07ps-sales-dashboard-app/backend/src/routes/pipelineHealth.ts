import { Router } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../middleware/permission';
import { attachUserContext, resolveScopedFilters } from '../middleware/scopeContext';
import { dateOnlyUTC } from '../measures/filters';
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
 * The funnel/Stage Benchmark are YTD-scoped (see measures/pipelineHealth.ts's header comment), so
 * they need an anchor date same as every other page's YTD figures -- there's no page-level date
 * control for it (the frontend doesn't send one), so it defaults to today, same fallback
 * convention as activityMomentum's parseAnchorDate.
 */
export const pipelineHealthRouter = Router();

pipelineHealthRouter.use(
  requireAuth,
  requirePasswordChangeCleared,
  requirePermission('pipeline_health', 'view'),
  attachUserContext,
  resolveScopedFilters,
);

function parseAnchorDate(raw: unknown): Date {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const now = new Date();
    return dateOnlyUTC(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
  }
  const [y, m, d] = raw.split('-').map(Number);
  return dateOnlyUTC(y, m, d);
}

pipelineHealthRouter.get('/overview', async (req, res, next) => {
  try {
    const filters = req.scopedFilters!;
    const anchor = parseAnchorDate(req.query.anchorDate);
    const overview = await computePipelineHealthOverview(pool, anchor, filters);
    res.json(overview);
  } catch (err) {
    next(err);
  }
});
