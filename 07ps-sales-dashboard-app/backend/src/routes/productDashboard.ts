import { Router } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../middleware/permission';
import { attachUserContext, resolveScopedFilters } from '../middleware/scopeContext';
import { computeProductDashboard, ProductScopeError } from '../measures/productDashboard';

/**
 * Product pages' data (measures/productDashboard.ts). One router per page so each keeps its own
 * permission key; all four serve the same measure:
 *   GET /product-dashboard/<page>/overview?company=Majaal&segmentKeys=...
 * Always the last 12 months (lib/last12Months.ts): the Product pages have no date range (2026-11-14).
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
  router.use(requireAuth, requirePasswordChangeCleared, requirePermission(pageKey, 'view'), attachUserContext, resolveScopedFilters);
  router.get('/overview', async (req, res, next) => {
    try {
      const { company } = req.query;
      const { companyKeys, segmentKeys, channelKeys, salesTeamKeys, salespersonKeys } = req.scopedFilters ?? {};
      res.json(
        await computeProductDashboard(pool, {
          company: typeof company === 'string' ? company : undefined,
          filters: { companyKeys, segmentKeys, channelKeys, salesTeamKeys, salespersonKeys },
          salespersonTier: req.userContext?.roleCode === 'SALESPERSON',
        }),
      );
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
