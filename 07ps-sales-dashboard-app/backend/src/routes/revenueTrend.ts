import { Router } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../middleware/permission';
import { attachUserContext, resolveScopedFilters } from '../middleware/scopeContext';
import { dateOnlyUTC } from '../measures/filters';
import { computeRevenueTrendFigures, fetchRevenueTrendPeriods } from '../measures/revenueTrend';
import { parseGranularity, PeriodQueryError } from '../lib/periods';

/**
 * Revenue Trend page KPI endpoint. Same middleware chain and scoping discipline as
 * routes/tachometer.ts and routes/criticalNumber.ts -- every query goes through
 * resolveScopedFilters before any measures function runs.
 *
 * /overview: the six MTD/YTD variance KPI cards and the Performance Details rows.
 * /trend?granularity=day|week|month|year (default week): the Value / Volume / ASP trend points of that period window
 * (lib/periods.ts), so switching the period selector reloads only the three charts.
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

    const { kpis, performanceDetails } = await computeRevenueTrendFigures(pool, anchor, filters);

    res.json({
      anchorDate: anchor.toISOString().slice(0, 10),
      kpis,
      performanceDetails,
    });
  } catch (err) {
    next(err);
  }
});

revenueTrendRouter.get('/trend', async (req, res, next) => {
  try {
    const trend = await fetchRevenueTrendPeriods(pool, parseAnchorDate(req.query.anchorDate), parseGranularity(req.query.granularity), req.scopedFilters!);
    res.json(trend);
  } catch (err) {
    if (err instanceof PeriodQueryError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});
