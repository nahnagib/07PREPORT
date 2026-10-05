import { Router, type Request, type Response, type NextFunction } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../middleware/permission';
import { attachUserContext, resolveScopedFilters } from '../middleware/scopeContext';
import type { Filters } from '../measures/filters';
import { fetchDepartmentFreshness } from '../measures/departmentFreshness';
import {
  DebtQueryError,
  fetchDebtCustomers,
  fetchDebtDrilldown,
  fetchDebtMeta,
  fetchDebtOverview,
  fetchDebtTrend,
  parseDebtQuery,
  parseDrill,
} from '../measures/debtReport';

/**
 * Debt Report (Finance / Price department; measures/debtReport.ts), permission page `debt_report`:
 *
 *   GET /debt-report/meta       snapshots, filter options (currencies too), labels (en + ar), size tiers, the report
 *                               exclusions, Odoo link base, finance freshness
 *   GET /debt-report/overview   per currency: KPIs, aging distribution, overdue by customer (top 15) / salesperson / team
 *   GET /debt-report/trend      open / overdue / not due per snapshot date and currency
 *   GET /debt-report/customers  one row per company + customer + currency
 *   GET /debt-report/drilldown?kind=customer|aging|salesperson|team|account&key=<key>&currency=<code>
 *                               the open lines behind one chart point / table row, in that currency
 *
 * Every endpoint leaves out the excluded segments and sales teams (cfg_finance_report_exclusion; measures/debtReport.ts
 * EXCLUDED_TEAMS_CONDITION) -- no parameter can bring them back.
 *
 * Same middleware chain as every page: View on debt_report (403 otherwise -- a role without the grant, e.g.
 * Salesperson by default, gets 403 on every endpoint), then resolveScopedFilters (role data scope + salesperson lock:
 * a salesperson is forced to their own SalespersonKey and asking for another one is a 403). Company / salesperson /
 * team / customer filters are the usual companyKeys / salespersonKeys / salesTeamKeys / customerKeys parameters; the
 * page's own parameters are parsed by parseDebtQuery (400 on a bad value).
 */
export const debtReportRouter = Router();

debtReportRouter.use(requireAuth, requirePasswordChangeCleared, requirePermission('debt_report', 'view'), attachUserContext, resolveScopedFilters);

type Handler = (req: Request) => Promise<unknown>;

function handle(fn: Handler) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      if (err instanceof DebtQueryError) {
        res.status(400).json({ error: err.message });
        return;
      }
      next(err);
    }
  };
}

const scoped = (req: Request): Filters => req.scopedFilters ?? {};

debtReportRouter.get(
  '/meta',
  handle(async (req) => ({
    ...(await fetchDebtMeta(pool, parseDebtQuery(req.query as Record<string, unknown>), scoped(req))),
    freshness: await fetchDepartmentFreshness(pool, 'finance'),
  })),
);

debtReportRouter.get(
  '/overview',
  handle((req) => fetchDebtOverview(pool, parseDebtQuery(req.query as Record<string, unknown>), scoped(req))),
);

debtReportRouter.get(
  '/trend',
  handle((req) => fetchDebtTrend(pool, parseDebtQuery(req.query as Record<string, unknown>), scoped(req))),
);

debtReportRouter.get(
  '/customers',
  handle((req) => fetchDebtCustomers(pool, parseDebtQuery(req.query as Record<string, unknown>), scoped(req))),
);

debtReportRouter.get(
  '/drilldown',
  handle((req) => {
    const query = req.query as Record<string, unknown>;
    return fetchDebtDrilldown(pool, parseDebtQuery(query), scoped(req), parseDrill(query));
  }),
);
