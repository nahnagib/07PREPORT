import { Request, Router } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../middleware/permission';
import { attachUserContext } from '../middleware/scopeContext';
import type { Filters } from '../measures/filters';

/**
 * Filter value-list endpoints for the Tachometer Filters Panel (Standards Section 3.4/4).
 *
 * Queries the powerBI_Data warehouse tables with the proper case-sensitive table/column names:
 *
 *   Business Unit / Company -> Dim_Company
 *   Customer Group          -> Dim_Segment (NOT Dim_Customer -- see filters.ts's module docstring
 *                               in src/measures for the full "why")
 *   Distribution Channel    -> Dim_DistributionChannel
 *   Branch                  -> Dim_SalesTeam
 *   Sales Person            -> Dim_Salesperson
 *
 * No POS endpoint here -- confirmed unused in the real data, and a working-but-empty filter
 * is worse than an absent one.
 *
 * Every list below is also narrowed to the caller's role_data_scope rules (if any), same
 * precedent /salespersons already set for SALESPERSON-tier users: a restricted role's dropdown
 * should only ever offer values that would survive resolveScopedFilters anyway, rather than
 * showing options that just get rejected or silently overridden on the next request.
 */

export const filtersRouter = Router();

filtersRouter.use(requireAuth, requirePasswordChangeCleared, requirePermission('tachometer', 'view'), attachUserContext);

/** Values this dimension is restricted to by the caller's role, or null if unrestricted. */
function allowedValues(req: Request, dimension: keyof Filters): Set<string> | null {
  const rules = (req.userContext?.dataScopeRules ?? []).filter((r) => r.dimension === dimension);
  return rules.length > 0 ? new Set(rules.map((r) => r.value)) : null;
}

function scopeRows<T extends Record<string, unknown>>(
  rows: T[],
  keyField: keyof T,
  allowed: Set<string> | null,
): T[] {
  if (!allowed) return rows;
  return rows.filter((row) => allowed.has(String(row[keyField])));
}

filtersRouter.get('/business-units', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT CompanyKey as company_key, Company as company_name FROM Dim_Company ORDER BY Company',
    );
    res.json(scopeRows(rows as Record<string, unknown>[], 'company_key', allowedValues(req, 'companyKeys')));
  } catch (err) {
    next(err);
  }
});

filtersRouter.get('/customer-groups', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT SegmentKey as segment_key, Segment as segment_name FROM Dim_Segment ORDER BY Segment',
    );
    res.json(scopeRows(rows as Record<string, unknown>[], 'segment_key', allowedValues(req, 'segmentKeys')));
  } catch (err) {
    next(err);
  }
});

filtersRouter.get('/distribution-channels', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT ChannelKey as channel_key, DistributionChannel as channel_name FROM Dim_DistributionChannel ORDER BY DistributionChannel',
    );
    res.json(scopeRows(rows as Record<string, unknown>[], 'channel_key', allowedValues(req, 'channelKeys')));
  } catch (err) {
    next(err);
  }
});

filtersRouter.get('/branches', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT st.SalesTeamKey as sales_team_key, st.SalesTeam as sales_team_name, st.SalesCity as city, dc.CompanyKey as company_key
       FROM Dim_SalesTeam st
       LEFT JOIN Dim_Company dc ON dc.Company = st.SalesTeamCompany
       ORDER BY st.SalesTeam`,
    );
    res.json(scopeRows(rows as Record<string, unknown>[], 'sales_team_key', allowedValues(req, 'salesTeamKeys')));
  } catch (err) {
    next(err);
  }
});

/**
 * A SALESPERSON-tier caller only ever sees their own name in this list (their own filter is
 * pre-selected and not editable in the UI regardless, but the list itself is scoped too -- per
 * Standards Section 5.2, scope enforcement is at the data layer, not just a disabled dropdown).
 * A role with a salespersonKeys data-scope rule gets the same treatment via scopeRows below.
 */
filtersRouter.get('/salespersons', async (req, res, next) => {
  try {
    if (req.userContext?.roleCode === 'SALESPERSON') {
      const [rows] = await pool.query(
        'SELECT SalespersonKey as salesperson_key, salesperson as salesperson_name FROM Dim_Salesperson WHERE SalespersonKey = ?',
        [req.userContext.salespersonKey],
      );
      res.json(rows);
      return;
    }
    const [rows] = await pool.query(
      'SELECT SalespersonKey as salesperson_key, salesperson as salesperson_name FROM Dim_Salesperson ORDER BY salesperson',
    );
    res.json(scopeRows(rows as Record<string, unknown>[], 'salesperson_key', allowedValues(req, 'salespersonKeys')));
  } catch (err) {
    next(err);
  }
});
