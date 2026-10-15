import { Router, type Request, type Response, type NextFunction } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../middleware/permission';
import { attachUserContext, resolveScopedFilters } from '../middleware/scopeContext';
import type { Filters } from '../measures/filters';
import { applyRoleDataScope, applySalespersonLock } from '../measures/filters';
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
import { attachCreditZones, fetchDebtAging, parseAgingQuery } from '../measures/debtAging';
import { fetchCollectionsDrilldown, fetchCollectionsTrend, parseCollectionsQuery } from '../measures/debtCollections';

/**
 * Debt Report (Finance / Price department; measures/debtReport.ts), permission page `debt_report`:
 *
 *   GET /debt-report/meta       snapshots, filter options (currencies too), labels (en + ar), size tiers, the report
 *                               exclusions, Odoo link base, finance freshness
 *   GET /debt-report/overview   per currency: KPIs, aging distribution, overdue by customer (top 15) / salesperson / team
 *   GET /debt-report/trend      open / overdue / not due per snapshot date and currency (null = no row for the filters
 *                               on that snapshot, e.g. a company not yet extracted then)
 *   GET /debt-report/collections-trend?currency=&grain=day|week|month&from=&to=
 *                               collections against earlier invoices (measures/debtCollections.ts): overdue / not yet due;
 *                               same-day sales and advances excluded; payment count, collection rate; default the last 12 weeks (Sunday..Saturday)
 *   GET /debt-report/collections-drilldown?currency=&grain=&period=<first day>
 *                               the payments of one period and the invoices they were applied to
 *   GET /debt-report/customers  one row per company + customer + currency, each with its customer's credit-policy zone
 *   GET /debt-report/drilldown?kind=customer|aging|salesperson|team|account&key=<key>&currency=<code>
 *                               the open lines behind one chart point / table row, in that currency
 *   GET /debt-report/aging?currency=<code>|allCurrencies=true&term=<payment term key>
 *                               Credit Policy Escalation: one customer per dot, placed by the days past due of its
 *                               unpaid invoice with the earliest due date, in the zones of config/creditPolicy.ts
 *                               (measures/debtAging.ts)
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
    ...(await fetchDebtMeta(pool, parseDebtQuery(req.query as Record<string, unknown>), scoped(req),
      applySalespersonLock(applyRoleDataScope({}, req.userContext?.dataScopeRules ?? []), req.userContext!))),
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
  '/collections-trend',
  handle((req) => fetchCollectionsTrend(pool, parseCollectionsQuery(req.query as Record<string, unknown>), scoped(req))),
);

debtReportRouter.get(
  '/collections-drilldown',
  handle((req) => {
    const query = req.query as Record<string, unknown>;
    return fetchCollectionsDrilldown(pool, parseCollectionsQuery(query), scoped(req), String(query.period ?? ''));
  }),
);

debtReportRouter.get(
  '/customers',
  handle(async (req) => {
    const q = parseDebtQuery(req.query as Record<string, unknown>);
    // every row carries its customer's credit-policy zone, exactly as the escalation chart places it
    return attachCreditZones(pool, q, scoped(req), await fetchDebtCustomers(pool, q, scoped(req)));
  }),
);

debtReportRouter.get(
  '/drilldown',
  handle((req) => {
    const query = req.query as Record<string, unknown>;
    return fetchDebtDrilldown(pool, parseDebtQuery(query), scoped(req), parseDrill(query));
  }),
);

debtReportRouter.get(
  '/aging',
  handle((req) => fetchDebtAging(pool, parseAgingQuery(req.query as Record<string, unknown>), scoped(req))),
);
