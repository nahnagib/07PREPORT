import { Router, type NextFunction, type Request, type Response } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../middleware/permission';
import { attachUserContext, resolveScopedFilters } from '../middleware/scopeContext';
import { computeProductDashboard, ProductScopeError, withoutProfit } from '../measures/productDashboard';
import { allows, getRequestPermissions } from '../services/permissionService';

/**
 * Product pages' data (measures/productDashboard.ts). One router per page so each keeps its own
 * permission key; all four serve the same measure:
 *   GET /product-dashboard/<page>/overview?company=Majaal&fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD
 * Filters (2026-11-14, round 2): Company and Date only. No dates = the Last 12 Months (lib/last12Months.ts). The
 * Customer Group / Channel / Branch / Salesperson / Customer params are dropped before resolveScopedFilters, so only the
 * role's data scope and the salesperson lock narrow the sales. Profit data (profit, GP%, cost, missing-cost flags) is
 * sent only with View on `profit_data` (withoutProfit).
 * Same middleware chain as every other page: resolveScopedFilters parses the Customer Group /
 * Channel / Branch / Salesperson filters and applies the salesperson RBAC lock / role data scope.
 * `company` (Majaal / Tika) selects the company view; without it every company's products are listed side by side
 * (one company per row). companyKeys is forwarded only as the role's data scope. A SALESPERSON-tier caller only gets
 * products with sales (stock-only / never-sold products are hidden for them).
 */
export const PRODUCT_DASHBOARD_PAGES = {
  'bcg-matrix': 'bcg_matrix',
  'stock-velocity': 'stock_velocity',
  'pim-contribution': 'pim_contribution',
  'product-lifecycle': 'product_lifecycle',
} as const;

export function productDashboardRouter(pageKey: string): Router {
  const router = Router();
  router.use(requireAuth, requirePasswordChangeCleared, requirePermission(pageKey, 'view'), attachUserContext, dropUserFilters, resolveScopedFilters);
  router.get('/overview', async (req, res, next) => {
    try {
      const { company, fromDate, toDate } = req.query;
      const { companyKeys, segmentKeys, channelKeys, salesTeamKeys, salespersonKeys } = req.scopedFilters ?? {};
      const overview = await computeProductDashboard(pool, {
          fromDate: typeof fromDate === 'string' ? fromDate : undefined,
          toDate: typeof toDate === 'string' ? toDate : undefined,
          company: typeof company === 'string' ? company : undefined,
          filters: { companyKeys, segmentKeys, channelKeys, salesTeamKeys, salespersonKeys },
          salespersonTier: req.userContext?.roleCode === 'SALESPERSON',
        });
      res.json(allows(await getRequestPermissions(req), 'profit_data', 'view') ? overview : withoutProfit(overview));
    } catch (err) {
      if (err instanceof ProductScopeError) {
        res.status(403).json({ error: 'Forbidden: request is outside your assigned scope.' });
        return;
      }
      next(err);
    }
  });
  return router;
}

/** The Product pages filter on Company and Date only: the user-picked dimension filters are ignored (the role scope is
 * applied by resolveScopedFilters from the user's role, not from these params). */
const USER_DIMENSION_PARAMS = ['segmentKeys', 'channelKeys', 'salesTeamKeys', 'salespersonKeys', 'customerKeys'];
function dropUserFilters(req: Request, _res: Response, next: NextFunction): void {
  for (const key of USER_DIMENSION_PARAMS) delete (req.query as Record<string, unknown>)[key];
  next();
}
