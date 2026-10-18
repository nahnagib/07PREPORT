import { Router, type NextFunction, type Request, type Response } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../middleware/permission';
import { attachUserContext, resolveScopedFilters } from '../middleware/scopeContext';
import { allows, getRequestPermissions } from '../services/permissionService';
import type { Filters } from '../measures/filters';
import { NpsQueryError, fetchNpsDetractors, fetchNpsMeta, fetchNpsOverview, fetchNpsReach, fetchNpsTrend, parseNpsQuery } from '../measures/npsScore';

/**
 * NPS Score (Process department; measures/npsScore.ts), permission page `nps_score`:
 *
 *   GET /nps-score/meta         the three groups (labels en + ar, stars), the colour bands and targets
 *                               (config/npsThresholds.ts), the minimum number of responders, the rating date range, the
 *                               source's last sync, whether the caller may see the detractor list, process freshness
 *   GET /nps-score/overview?dateFrom=&dateTo=
 *                               NPS, CSAT, responders, promoters / passives / detractors (# and %)
 *   GET /nps-score/trend?dateFrom=&dateTo=&grain=day|month|year
 *                               NPS and responders per period for the active filters
 *   GET /nps-score/reach?dateFrom=&dateTo=
 *                               WhatsApp message counts and error groups; company/date only. Unsupported role scopes
 *                               receive no counts. Waiting until the first successful message snapshot.
 *   GET /nps-score/detractors?dateFrom=&dateTo=&page=&pageSize=
 *                               the detractor list with the customers' comments -- ONLY with View on `nps_comments`
 *
 * Reads only the v_process_nps_* views (and fact_process_nps_comment) in the warehouse pool; there are no NPS credentials
 * in the backend. Same middleware chain as every report: View on nps_score, then resolveScopedFilters (the role's data
 * scope + the salesperson lock). The global filters are the usual companyKeys / segmentKeys / channelKeys /
 * salesTeamKeys / salespersonKeys / customerKeys parameters; a bad parameter is a 400.
 */
export const npsScoreRouter = Router();

npsScoreRouter.use(requireAuth, requirePasswordChangeCleared, requirePermission('nps_score', 'view'), attachUserContext, resolveScopedFilters);

type Handler = (req: Request) => Promise<unknown>;

function handle(fn: Handler) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      if (err instanceof NpsQueryError) {
        res.status(400).json({ error: err.message });
        return;
      }
      next(err);
    }
  };
}

const scoped = (req: Request): Filters => req.scopedFilters ?? {};
const query = (req: Request) => parseNpsQuery(req.query as Record<string, unknown>);

npsScoreRouter.get(
  '/meta',
  handle(async (req) => fetchNpsMeta(pool, allows(await getRequestPermissions(req), 'nps_comments', 'view'))),
);

npsScoreRouter.get('/overview', handle((req) => fetchNpsOverview(pool, query(req), scoped(req))));

npsScoreRouter.get('/trend', handle((req) => fetchNpsTrend(pool, query(req), scoped(req))));

npsScoreRouter.get('/reach', handle((req) => fetchNpsReach(pool, query(req), scoped(req), req.userContext!)));

npsScoreRouter.get(
  '/detractors',
  requirePermission('nps_comments', 'view'),
  handle((req) => fetchNpsDetractors(pool, query(req), scoped(req))),
);
