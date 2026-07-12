import { Router } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../middleware/permission';
import { attachUserContext, resolveScopedFilters } from '../middleware/scopeContext';
import { dateOnlyUTC } from '../measures/filters';
import { computeCustomerGrowthOverview, type CustomerGrowthScope } from '../measures/customerGrowth';

/**
 * Customer Growth page KPI endpoint. Same middleware chain and scoping discipline as
 * routes/invoicesEngine.ts -- every query goes through resolveScopedFilters before any measures
 * function runs.
 *
 * One /overview endpoint: the page needs the Zone A KPI panels, Rates, Customers Trend, Customers
 * Contribution, Customers Category Performance, and the Details view's Customers Table on a single
 * load. `selectedYear` is optional and comes from a Customers Trend bar click (page-filter mode,
 * not drill-down) -- see measures/customerGrowth.ts's header comment for exactly which query
 * honors it and which (Customers Trend itself) deliberately ignores it.
 */
export const customerGrowthRouter = Router();

customerGrowthRouter.use(
  requireAuth,
  requirePasswordChangeCleared,
  requirePermission('customer_growth', 'view'),
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

function parseSelectedYear(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || !/^\d{4}$/.test(raw)) return undefined;
  return Number(raw);
}

customerGrowthRouter.get('/overview', async (req, res, next) => {
  try {
    const filters = req.scopedFilters!;
    const anchor = parseAnchorDate(req.query.anchorDate);
    const selectedYear = parseSelectedYear(req.query.selectedYear);
    const scope: CustomerGrowthScope = { year: selectedYear };

    const overview = await computeCustomerGrowthOverview(pool, anchor, filters, scope);

    res.json({
      anchorDate: anchor.toISOString().slice(0, 10),
      selectedYear: selectedYear ?? null,
      ...overview,
    });
  } catch (err) {
    next(err);
  }
});
