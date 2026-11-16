import { Router } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../middleware/permission';
import { attachUserContext, resolveScopedFilters } from '../middleware/scopeContext';
import {
  computeAspCard,
  computeMtdCard,
  computeYtdCard,
  fetchMonthlySeries,
  fetchTargetForMonths,
  fetchValueVolume,
} from '../measures/tachometer';
import { lmtdWindow, lytdWindow, mtdWindow, parseAnchorDate, ytdWindow } from '../measures/filters';

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
 * Monthly trend series (Revenue/Volume/ASP/Monthly Achievement charts). Same middleware chain as
 * /overview - filters are always scope-enforced server-side regardless of what the
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
