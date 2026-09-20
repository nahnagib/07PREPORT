import { Router } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../middleware/permission';
import { attachUserContext, resolveScopedFilters } from '../middleware/scopeContext';
import { computeBrandPerformanceOverview } from '../measures/materialsAnalogyBrandPerformance';

/**
 * PIM Contribution "Brand Performance" endpoint. Same middleware chain and `pim_contribution`
 * permission key as the rest of that page (see `PermissionGuard pageKey="pim_contribution"` and
 * `0014_materials_analogy_pages.sql`).
 *
 * No query params are read from the client today -- Company/Category/BCG Class filtering stays a
 * client-side concern (materialsAnalogy/shared.ts's filterFacts), unchanged by this migration. But
 * `resolveScopedFilters` still runs (required for every measures route -- see its own header) and
 * its output is still passed through to the measure: for an unrestricted caller `scopedFilters` is
 * all-empty and the query stays fully unscoped, but for a SALESPERSON-tier or role-data-scope
 * -restricted caller it's forced non-empty regardless of the request, and must actually narrow the
 * query -- same `hasScope` pattern bcgMatrix.ts's own route uses, not something this route can skip
 * just because the frontend never sends filter params.
 */
export const materialsAnalogyBrandPerformanceRouter = Router();

materialsAnalogyBrandPerformanceRouter.use(
  requireAuth,
  requirePasswordChangeCleared,
  requirePermission('pim_contribution', 'view'),
  attachUserContext,
  resolveScopedFilters,
);

materialsAnalogyBrandPerformanceRouter.get('/brand-performance', async (req, res, next) => {
  try {
    const { companyKeys: _companyKeys, ...scopeFilters } = req.scopedFilters ?? {};
    const hasScope = Object.values(scopeFilters).some((v) => Array.isArray(v) && v.length > 0);
    const overview = await computeBrandPerformanceOverview(pool, hasScope ? { filters: scopeFilters } : undefined);
    res.json(overview);
  } catch (err) {
    next(err);
  }
});
