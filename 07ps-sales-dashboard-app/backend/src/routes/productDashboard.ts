import { Router } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../middleware/permission';
import { attachUserContext, resolveScopedFilters } from '../middleware/scopeContext';
import { computeProductDashboard } from '../measures/productDashboard';

/**
 * Product pages' data (measures/productDashboard.ts). One router per page so each keeps its own
 * permission key; all four serve the same measure:
 *   GET /product-dashboard/<page>/overview?fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD&segmentKeys=...
 * Same middleware chain as every other page: resolveScopedFilters parses the Customer Group /
 * Channel / Branch / Salesperson filters and applies the salesperson RBAC lock / role data scope.
 * Company is a page-level pill (client-side), so companyKeys is not forwarded.
 */
export const PRODUCT_DASHBOARD_PAGES = {
  'bcg-matrix': 'bcg_matrix',
  'stock-velocity': 'stock_velocity',
  'pim-contribution': 'pim_contribution',
  'product-lifecycle': 'product_lifecycle',
} as const;

export function productDashboardRouter(pageKey: string): Router {
  const router = Router();
  router.use(requireAuth, requirePasswordChangeCleared, requirePermission(pageKey, 'view'), attachUserContext, resolveScopedFilters);
  router.get('/overview', async (req, res, next) => {
    try {
      const { fromDate, toDate } = req.query;
      const { segmentKeys, channelKeys, salesTeamKeys, salespersonKeys } = req.scopedFilters ?? {};
      res.json(
        await computeProductDashboard(pool, {
          fromDate: typeof fromDate === 'string' ? fromDate : undefined,
          toDate: typeof toDate === 'string' ? toDate : undefined,
          filters: { segmentKeys, channelKeys, salesTeamKeys, salespersonKeys },
        }),
      );
    } catch (err) {
      next(err);
    }
  });
  return router;
}
