import { Router } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../middleware/permission';
import { attachUserContext, resolveScopedFilters } from '../middleware/scopeContext';
import { computeBcgMatrixOverview } from '../measures/materialsAnalogyBcg';

/**
 * BCG Matrix page endpoint. Same middleware chain as every other page (see
 * routes/pipelineHealth.ts) -- `resolveScopedFilters` both parses segmentKeys/channelKeys/
 * salesTeamKeys/salespersonKeys off the query string AND applies the salesperson RBAC lock/role
 * data scope, exactly like every other filtered page. `fromDate`/`toDate` are the only params
 * this route reads itself (Filters has no date-range concept). fact_bcgmatrix's own YTD/LYTD
 * figures are still computed entirely by the ETL on its existing cadence -- these params only
 * narrow WHICH already-classified products are returned (see BcgProductScope's header in
 * materialsAnalogyBcg.ts), never a period recomputation.
 */
export const bcgMatrixRouter = Router();

bcgMatrixRouter.use(
  requireAuth,
  requirePasswordChangeCleared,
  requirePermission('bcg_matrix', 'view'),
  attachUserContext,
  resolveScopedFilters,
);

bcgMatrixRouter.get('/overview', async (req, res, next) => {
  try {
    const { fromDate, toDate } = req.query;
    const { companyKeys: _companyKeys, ...scopeFilters } = req.scopedFilters ?? {};
    const hasScope = fromDate || toDate || Object.values(scopeFilters).some((v) => Array.isArray(v) && v.length > 0);
    const overview = await computeBcgMatrixOverview(
      pool,
      hasScope
        ? {
            filters: scopeFilters,
            fromDate: typeof fromDate === 'string' ? fromDate : undefined,
            toDate: typeof toDate === 'string' ? toDate : undefined,
          }
        : undefined,
    );
    res.json(overview);
  } catch (err) {
    next(err);
  }
});
