import { Router } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../middleware/permission';
import { attachUserContext } from '../middleware/scopeContext';

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
 */

export const filtersRouter = Router();

filtersRouter.use(requireAuth, requirePasswordChangeCleared, requirePermission('tachometer', 'view'), attachUserContext);

filtersRouter.get('/business-units', async (_req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT CompanyKey as company_key, Company as company_name FROM Dim_Company ORDER BY Company',
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

filtersRouter.get('/customer-groups', async (_req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT SegmentKey as segment_key, Segment as segment_name FROM Dim_Segment ORDER BY Segment',
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

filtersRouter.get('/distribution-channels', async (_req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT ChannelKey as channel_key, DistributionChannel as channel_name FROM Dim_DistributionChannel ORDER BY DistributionChannel',
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

filtersRouter.get('/branches', async (_req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT st.SalesTeamKey as sales_team_key, st.SalesTeam as sales_team_name, st.SalesCity as city, dc.CompanyKey as company_key
       FROM Dim_SalesTeam st
       LEFT JOIN Dim_Company dc ON dc.Company = st.SalesTeamCompany
       ORDER BY st.SalesTeam`,
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/**
 * A SALESPERSON-tier caller only ever sees their own name in this list (their own filter is
 * pre-selected and not editable in the UI regardless, but the list itself is scoped too -- per
 * Standards Section 5.2, scope enforcement is at the data layer, not just a disabled dropdown).
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
    res.json(rows);
  } catch (err) {
    next(err);
  }
});
