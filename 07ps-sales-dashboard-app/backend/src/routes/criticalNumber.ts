import { Router } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../middleware/permission';
import { attachUserContext, resolveScopedFilters } from '../middleware/scopeContext';
import { dateOnlyUTC } from '../measures/filters';
import {
  computeDailyCriticalNumber,
  computeDailyCounter,
  computeMonthlyCounter,
  computeYearlyCounter,
  computeWorkingDaysYtd,
  computeOfficialHolidaysYtd,
  computeForcedClosuresYtd,
  computeMissingSummary,
  weeklyRestDaysYtd,
  fetchCompanyNamesByKey,
  fetchLastAvailableDate,
} from '../measures/criticalNumber';

/**
 * Critical Number page KPI endpoint. Same middleware chain and scoping discipline as
 * routes/tachometer.ts -- every query goes through resolveScopedFilters before any measures
 * function runs, and every metric is computed by src/measures/criticalNumber.ts (see that file's
 * header for the source-table mapping and the working-day/off-day definitions used throughout).
 *
 * One /overview endpoint, not one per card: the page needs the daily critical number, all three
 * counters, and all six calendar/impact cards on a single load, and several of them share the same
 * underlying working-days computation -- fetching them together lets computeDailyCriticalNumber's
 * result be reused instead of recomputed per card.
 */
export const criticalNumberRouter = Router();

criticalNumberRouter.use(
  requireAuth,
  requirePasswordChangeCleared,
  requirePermission('critical_number', 'view'),
  attachUserContext,
  resolveScopedFilters,
);

function todayUTC(): Date {
  const now = new Date();
  return dateOnlyUTC(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
}

function parseAnchorDate(raw: unknown): Date {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return todayUTC();
  }
  const [y, m, d] = raw.split('-').map(Number);
  return dateOnlyUTC(y, m, d);
}

const MS_PER_DAY = 86_400_000;

criticalNumberRouter.get('/overview', async (req, res, next) => {
  try {
    const filters = req.scopedFilters!;
    const requestedAnchor = parseAnchorDate(req.query.anchorDate);

    // Fallback: if the caller is asking for today specifically (no explicit historical date was
    // picked) and the ETL hasn't loaded today's data yet, show the most recent available day's
    // figures instead of an empty/zeroed-out "today" -- see fetchLastAvailableDate's docstring.
    // A deliberately-picked historical date with genuinely no data is left alone: that's a real
    // "no data on this date" answer, not an ETL-lag artifact.
    const isRequestingToday = requestedAnchor.getTime() === todayUTC().getTime();
    const lastAvailableDate = isRequestingToday ? await fetchLastAvailableDate(pool) : null;
    const isFallback =
      isRequestingToday && lastAvailableDate !== null && lastAvailableDate.getTime() < requestedAnchor.getTime();
    const anchor = isFallback ? (lastAvailableDate as Date) : requestedAnchor;
    const fallbackDaysAgo = isFallback ? Math.round((requestedAnchor.getTime() - anchor.getTime()) / MS_PER_DAY) : 0;

    const companyNamesByKey = await fetchCompanyNamesByKey(pool);
    const dailyCriticalNumber = await computeDailyCriticalNumber(pool, anchor, filters, companyNamesByKey);

    const [
      dailyCounter,
      monthlyCounter,
      yearlyCounter,
      workingDaysYtd,
      officialHolidaysYtd,
      forcedClosuresYtd,
      missing,
    ] = await Promise.all([
      computeDailyCounter(pool, anchor, filters, dailyCriticalNumber),
      computeMonthlyCounter(pool, anchor, filters, companyNamesByKey, dailyCriticalNumber),
      computeYearlyCounter(pool, anchor, filters, companyNamesByKey, dailyCriticalNumber),
      computeWorkingDaysYtd(pool, anchor, filters, companyNamesByKey),
      computeOfficialHolidaysYtd(pool, anchor, filters, companyNamesByKey),
      computeForcedClosuresYtd(pool, anchor, filters, companyNamesByKey),
      computeMissingSummary(pool, anchor, filters, companyNamesByKey, dailyCriticalNumber),
    ]);

    res.json({
      anchorDate: anchor.toISOString().slice(0, 10),
      isFallback,
      fallbackDaysAgo,
      requestedDate: requestedAnchor.toISOString().slice(0, 10),
      dailyCriticalNumber,
      dailyCounter,
      monthlyCounter,
      yearlyCounter,
      workingDaysYtd,
      officialHolidaysYtd,
      forcedClosuresYtd,
      weeklyRestDaysYtd: { value: weeklyRestDaysYtd(anchor) },
      missingDaysYtd: missing.missingDays,
      missingValueYtd: missing.missingValue,
    });
  } catch (err) {
    next(err);
  }
});
