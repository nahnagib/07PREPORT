import { Router } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../middleware/permission';
import { attachUserContext, resolveScopedFilters } from '../middleware/scopeContext';
import { dateOnlyUTC } from '../measures/filters';
import {
  computeAspCard,
  computeBreakdown,
  computeMtdCard,
  computeYtdCard,
  fetchMonthlySeries,
  fetchTargetForMonths,
  fetchValueVolume,
  type GroupBy,
  type Metric,
  type Period,
} from '../measures/tachometer';
import { lmtdWindow, lytdWindow, mtdWindow, ytdWindow } from '../measures/filters';

/**
 * Tachometer page KPI endpoints. Every query goes through resolveScopedFilters (Standards Section
 * 5.2 -- application-level scope enforcement, see middleware/scopeContext.ts) before any measures
 * function runs, and every metric is computed by src/measures/tachometer.ts, which is a 1:1 port
 * of the validated data/warehouse/measures/tachometer.py (see
 * data/ingestion/tachometer_kpi_validation.md for the reconciliation this logic was validated
 * against).
 *
 * One comprehensive /overview endpoint, not six separate per-metric endpoints: the page needs all
 * four gauges (YTD/MTD Value/Volume) plus both ASP cards on a single load, and a single endpoint
 * avoids six round trips for what is, in practice, always fetched together. Each returned card
 * already includes LYTD/LMTD, FLY/FLM, FY/FM Target, target-to-date, classification, and variance
 * -- the full metric table from the manual, per gauge.
 */

export const tachometerRouter = Router();

tachometerRouter.use(
  requireAuth,
  requirePasswordChangeCleared,
  requirePermission('tachometer', 'view'),
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

tachometerRouter.get('/overview', async (req, res, next) => {
  try {
    const filters = req.scopedFilters!;
    const anchor = parseAnchorDate(req.query.anchorDate);

    const [ytdValue, ytdVolume, mtdValue, mtdVolume] = await Promise.all([
      computeYtdCard(pool, anchor, filters, 'value'),
      computeYtdCard(pool, anchor, filters, 'volume'),
      computeMtdCard(pool, anchor, filters, 'value'),
      computeMtdCard(pool, anchor, filters, 'volume'),
    ]);

    const [ytdVV, ytdTarget, mtdVV, mtdTarget, lytdVV, lmtdVV] = await Promise.all([
      fetchValueVolume(pool, ytdWindow(anchor), filters),
      fetchTargetForMonths(pool, anchor.getUTCFullYear(), filters),
      fetchValueVolume(pool, mtdWindow(anchor), filters),
      fetchTargetForMonths(pool, anchor.getUTCFullYear(), filters, {
        month: anchor.getUTCMonth() + 1,
      }),
      // Same-period-last-year value/volume, purely for AspCard.lastYearAsp (the "Variance vs LY"
      // tile) -- ytdValue/mtdValue above already fetch this window for the currency/volume cards,
      // but ASP needs its own value+volume pair (not just the pre-computed lastYearSamePeriod
      // currency total) to derive last year's ASP the same JS-side value/volume way actualAsp is.
      fetchValueVolume(pool, lytdWindow(anchor), filters),
      fetchValueVolume(pool, lmtdWindow(anchor), filters),
    ]);

    const aspYtd = computeAspCard(ytdVV, ytdTarget, lytdVV);
    const aspMtd = computeAspCard(mtdVV, mtdTarget, lmtdVV);

    res.json({
      anchorDate: anchor.toISOString().slice(0, 10),
      ytdValue,
      ytdVolume,
      mtdValue,
      mtdVolume,
      aspYtd,
      aspMtd,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Drill-down breakdown for one metric card, grouped by a filter dimension. Powers the new
 * per-metric detail page reached by clicking a Tachometer gauge card: e.g. "YTD Value by
 * Salesperson". Carries the exact same scoped filters/anchorDate as /overview (via the same
 * requireAuth/attachUserContext/resolveScopedFilters chain above), so a breakdown is always
 * scoped identically to whatever the summary page was showing when the user clicked through.
 *
 * metric: 'ytdValue' | 'ytdVolume' | 'mtdValue' | 'mtdVolume' (matches the 4 gauge cards 1:1).
 * groupBy: 'salesperson' | 'salesTeam' | 'segment' (whichever dimension the caller wants; the
 * frontend defaults to 'salesperson' with a toggle, per the confirmed scope -- "whichever the
 * current filters allow").
 */
const METRIC_CONFIG: Record<string, { period: Period; metric: Metric }> = {
  ytdValue: { period: 'ytd', metric: 'value' },
  ytdVolume: { period: 'ytd', metric: 'volume' },
  mtdValue: { period: 'mtd', metric: 'value' },
  mtdVolume: { period: 'mtd', metric: 'volume' },
};

const VALID_GROUP_BY: GroupBy[] = ['salesperson', 'salesTeam', 'segment'];

tachometerRouter.get('/breakdown', async (req, res, next) => {
  try {
    const filters = req.scopedFilters!;
    const anchor = parseAnchorDate(req.query.anchorDate);

    const metricKey = typeof req.query.metric === 'string' ? req.query.metric : '';
    const config = METRIC_CONFIG[metricKey];
    if (!config) {
      res.status(400).json({
        error: `Invalid metric "${metricKey}". Expected one of: ${Object.keys(METRIC_CONFIG).join(', ')}`,
      });
      return;
    }

    const groupByRaw = typeof req.query.groupBy === 'string' ? req.query.groupBy : 'salesperson';
    if (!VALID_GROUP_BY.includes(groupByRaw as GroupBy)) {
      res.status(400).json({
        error: `Invalid groupBy "${groupByRaw}". Expected one of: ${VALID_GROUP_BY.join(', ')}`,
      });
      return;
    }
    const groupBy = groupByRaw as GroupBy;

    const rows = await computeBreakdown(pool, anchor, filters, config.period, config.metric, groupBy);

    res.json({
      anchorDate: anchor.toISOString().slice(0, 10),
      metric: metricKey,
      groupBy,
      rows,
    });
  } catch (err) {
    next(err);
  }
});


/**
 * Monthly trend series (Revenue/Volume/ASP/Monthly Achievement charts). Same middleware chain as
 * /overview and /breakdown - filters are always scope-enforced server-side regardless of what the
 * client sends.
 */
tachometerRouter.get('/trend', async (req, res, next) => {
  try {
    const filters = req.scopedFilters!;
    const anchor = parseAnchorDate(req.query.anchorDate);
    const points = await fetchMonthlySeries(pool, anchor, filters);
    res.json({
      anchorDate: anchor.toISOString().slice(0, 10),
      points,
    });
  } catch (err) {
    next(err);
  }
});
