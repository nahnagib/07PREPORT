import { Router, type NextFunction, type Request, type Response } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../middleware/permission';
import { attachUserContext, resolveScopedFilters } from '../middleware/scopeContext';
import { computeProductDashboard, ProductScopeError, withoutProfit } from '../measures/productDashboard';
import { allows, getRequestPermissions } from '../services/permissionService';
import { computeSkuTrend, computeSkuTrendSkus, SkuTrendQueryError } from '../measures/skuTrend';
import { businessToday, parseGranularity, PeriodQueryError } from '../lib/periods';

/**
 * Product pages' data (measures/productDashboard.ts). One router per page so each keeps its own
 * permission key; all four serve the same measure:
 *   GET /product-dashboard/<page>/overview?company=Majaal&fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD
 *   GET /product-dashboard/<page>/products  (same params): the status cards' SKUs, one row each (BCG status table)
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
  // /overview: the page's data. /products (2026-11-15, the BCG page's status table): the SKUs behind the Total SKUs /
  // Product Status cards, one row per SKU, grouped exactly as the cards count them (measures skuListOf).
  const handler = (withSkus: boolean) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { company, fromDate, toDate } = req.query;
      const { companyKeys, segmentKeys, channelKeys, salesTeamKeys, salespersonKeys } = req.scopedFilters ?? {};
      const computed = await computeProductDashboard(pool, {
        fromDate: typeof fromDate === 'string' ? fromDate : undefined,
        toDate: typeof toDate === 'string' ? toDate : undefined,
        company: typeof company === 'string' ? company : undefined,
        filters: { companyKeys, segmentKeys, channelKeys, salesTeamKeys, salespersonKeys },
        salespersonTier: req.userContext?.roleCode === 'SALESPERSON',
        includeSkuList: withSkus,
      });
      const overview = allows(await getRequestPermissions(req), 'profit_data', 'view') ? computed : withoutProfit(computed);
      if (!withSkus) {
        res.json(overview);
        return;
      }
      const { view, period, asOfDate, profitAccess, statusSummary, statusSummaryError, skuList } = overview;
      res.json({ view, period, asOfDate, profitAccess, statusSummary, statusSummaryError, skus: skuList ?? [] });
    } catch (err) {
      if (err instanceof ProductScopeError) {
        res.status(403).json({ error: 'Forbidden: request is outside your assigned scope.' });
        return;
      }
      next(err);
    }
  };
  router.get('/overview', handler(false));
  router.get('/products', handler(true));
  if (pageKey === PRODUCT_DASHBOARD_PAGES['bcg-matrix']) {
    // SKU Trend (2026-11-16, measures/skuTrend.ts): ?granularity=week|month|year&company=Tika&toDate=YYYY-MM-DD, the
    // Active / Non Active / Dormant SKUs of every period of the window ending with the To Date (default today);
    // /sku-trend/skus adds &period=<period start>&status=all|active|nonActive|dormant: the SKUs behind the total bar (all) or one status line point.
    const trendQuery = (req: Request) => {
      const { company, toDate } = req.query;
      if (toDate !== undefined && (typeof toDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(toDate))) throw new PeriodQueryError('toDate must be YYYY-MM-DD');
      // like the Product Status cards: only the role's companies narrow the SKUs (no Customer Group / Channel / ...)
      return {
        granularity: parseGranularity(req.query.granularity),
        to: typeof toDate === 'string' ? toDate : businessToday(),
        company: typeof company === 'string' ? company : undefined,
        filters: { companyKeys: req.scopedFilters?.companyKeys },
      };
    };
    const trendHandler = (skus: boolean) => async (req: Request, res: Response, next: NextFunction) => {
      try {
        const q = trendQuery(req);
        res.json(skus
          ? await computeSkuTrendSkus(pool, { ...q, period: String(req.query.period ?? ''), status: String(req.query.status ?? '') })
          : await computeSkuTrend(pool, q));
      } catch (err) {
        if (err instanceof PeriodQueryError || err instanceof SkuTrendQueryError) {
          res.status(400).json({ error: err.message });
          return;
        }
        if (err instanceof ProductScopeError) {
          res.status(403).json({ error: 'Forbidden: request is outside your assigned scope.' });
          return;
        }
        next(err);
      }
    };
    router.get('/sku-trend', trendHandler(false));
    router.get('/sku-trend/skus', trendHandler(true));
  }
  return router;
}

/** The Product pages filter on Company and Date only: the user-picked dimension filters are ignored (the role scope is
 * applied by resolveScopedFilters from the user's role, not from these params). */
const USER_DIMENSION_PARAMS = ['segmentKeys', 'channelKeys', 'salesTeamKeys', 'salespersonKeys', 'customerKeys'];
function dropUserFilters(req: Request, _res: Response, next: NextFunction): void {
  for (const key of USER_DIMENSION_PARAMS) delete (req.query as Record<string, unknown>)[key];
  next();
}
