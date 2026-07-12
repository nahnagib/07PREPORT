import { Router } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../middleware/permission';
import { attachUserContext, resolveScopedFilters } from '../middleware/scopeContext';
import { dateOnlyUTC } from '../measures/filters';
import { computeRevenueTrendKpis, fetchRevenueTrendSeries } from '../measures/revenueTrend';

/**
 * Revenue Trend page KPI endpoint. Same middleware chain and scoping discipline as
 * routes/tachometer.ts and routes/criticalNumber.ts -- every query goes through
 * resolveScopedFilters before any measures function runs.
 *
 * One /overview endpoint: the page needs the monthly Value/Volume/ASP series (for the three MoM
 * line charts) and the six MTD/YTD variance KPI cards on a single load.
 */
export const revenueTrendRouter = Router();

revenueTrendRouter.use(
  requireAuth,
  requirePasswordChangeCleared,
  requirePermission('revenue_trend', 'view'),
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

revenueTrendRouter.get('/overview', async (req, res, next) => {
  try {
    const filters = req.scopedFilters!;
    const anchor = parseAnchorDate(req.query.anchorDate);

    const [series, kpis] = await Promise.all([
      fetchRevenueTrendSeries(pool, anchor, filters),
      computeRevenueTrendKpis(pool, anchor, filters),
    ]);

    res.json({
      anchorDate: anchor.toISOString().slice(0, 10),
      series,
      kpis,
    });
  } catch (err) {
    next(err);
  }
});
