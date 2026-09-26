import { Request, Router } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { requireAnyDashboardView, requirePasswordChangeCleared } from '../middleware/permission';
import { attachUserContext } from '../middleware/scopeContext';
import { DataScopeError, SalespersonLockError, applyRoleDataScope, applySalespersonLock, type Filters } from '../measures/filters';
import { emptySelection, type Selection } from '../filters/cascade';
import { getFilterOptions } from '../filters/optionsService';

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
 *
 * CASCADING (Company Link + Cascading Filter Bar, 2026-09): /customer-groups,
 * /distribution-channels, /branches, /salespersons each additionally accept the already-selected
 * upstream keys as query params (companyKeys/segmentKeys/channelKeys/salesTeamKeys, same names as
 * the Filters type) and narrow their result to only values relevant to that selection. With no
 * such params present, every endpoint below runs the exact same query it always has -- a "fast
 * path" with zero behavior change for any caller that doesn't opt in. /business-units stays
 * unparameterized: it's the top of a one-directional cascade, nothing is ever upstream of it.
 *
 * CROSS-FILTERING (GET /options, 2026-09): supersedes the four per-dimension cascade endpoints for
 * the Filter Bar. One call takes every current selection (+ optional date window) and returns the
 * valid options for all seven filters -- each narrowed by every OTHER filter, in any direction --
 * plus the selection with now-invalid values dropped. See filters/cascade.ts and
 * filters/optionsService.ts; the per-dimension endpoints below remain for callers that want an
 * unnarrowed full list (e.g. the role data-scope admin page).
 *
 * IMPORTANT: this narrowing is a UX/discovery concern only -- which options are *offered* -- and
 * is entirely separate from report-total computation. Company in particular is deliberately NOT
 * part of measures/filters.ts's effective-key reclassification system (see that file's
 * effectiveSegmentExpr docstring and data/warehouse/migrations/0019's header): a Company
 * assignment here never changes what any report/dashboard total is computed from. See
 * SALESPERSON_COMPANY_MAP_SQL below, which is deliberately local to this file, never exported to
 * or imported by anything in measures/.
 */

export const filtersRouter = Router();

// Shared by every report page's filter bar/footer: open to anyone who can View at least one dashboard
// (was Tachometer only, which broke the filters on every other page for a role without Tachometer).
filtersRouter.use(requireAuth, requirePasswordChangeCleared, requireAnyDashboardView, attachUserContext);

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

/** Normalizes a query param that may arrive as absent, a single value, or (repeated-key) an
 * array -- small local duplicate of middleware/scopeContext.ts's own parseNumberArray/
 * parseStringArray (not exported there), matching this codebase's established convention of
 * small per-file duplication over cross-module imports for this kind of helper. */
function parseNumberArray(raw: unknown): number[] {
  if (raw === undefined) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values.map((v) => Number(v)).filter((v) => !Number.isNaN(v));
}

function parseStringArray(raw: unknown): string[] {
  if (raw === undefined) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values.map((v) => String(v));
}

/** A plain `IN (...)` clause. Returns null (omit the clause entirely) when `values` is empty --
 * "no restriction on this dimension".
 *
 * Company matching (Exclude NULL Company Salespersons from Cascading Filters, 2026-09) used to
 * also match NULL here (an unassigned salesperson/team appeared under every company's cascade) --
 * reversed on explicit request: a salesperson/team with no company link now disappears entirely
 * from a company-narrowed cascade, exactly like everything else that doesn't match the selected
 * value. They're still fully visible whenever no companyKeys param is given at all (the fast
 * path, untouched by this function). See data/warehouse/migrations/0019's SUPERSEDED note. */
function inClause(column: string, values: Array<string | number>): { clause: string; params: Array<string | number> } | null {
  if (values.length === 0) return null;
  const placeholders = values.map(() => '?').join(', ');
  return { clause: `${column} IN (${placeholders})`, params: values };
}

/**
 * Per-salesperson resolution used ONLY by the cascading filter-option endpoints below -- never
 * imported by measures/ and never affecting report totals (see module docstring). Resolves each
 * salesperson's admin-assigned company (own override, falling back through their effective team's
 * own override, falling back to the team's raw ETL company-name string, falling back to NULL =
 * unassigned) alongside their segment/channel/sales-team override columns, so callers need only
 * one join to get every effective dimension at once. A JOIN (not a correlated subquery) --
 * embedding a correlated subquery in a DISTINCT/GROUP-BY-heavy query hits MySQL's
 * ONLY_FULL_GROUP_BY restriction, the same reason measures/tachometer.ts's GROUP_CONFIG.keyJoin
 * exists (see that file's docstring).
 */
const SALESPERSON_COMPANY_MAP_SQL = `
  SELECT
    ds.SalespersonKey AS salesperson_key,
    sap.admin_name_override,
    sap.segment_key_override,
    sap.channel_key_override,
    sap.sales_team_key_override,
    COALESCE(sap.company_key_override, stap.company_key_override, dc.CompanyKey) AS effective_company_key
  FROM Dim_Salesperson ds
  LEFT JOIN salesperson_admin_profile sap ON sap.salesperson_key = ds.SalespersonKey
  LEFT JOIN Dim_SalesTeam st ON st.SalesTeamKey = COALESCE(sap.sales_team_key_override, ds.SalesTeamKey)
  LEFT JOIN sales_team_admin_profile stap ON stap.sales_team_key = st.SalesTeamKey
  LEFT JOIN Dim_Company dc ON dc.Company = st.SalesTeamCompany
`;

/** Same channel-inference CASE logic as measures/filters.ts's effectiveChannelExpr, restated
 * against SALESPERSON_COMPANY_MAP_SQL's joined columns (aliased `sec`) instead of a correlated
 * subquery -- these cascading endpoints already join `sec` for company/segment/team resolution,
 * so this reuses that join rather than adding a second subquery per row. Keep in sync with
 * effectiveChannelExpr's CASE branches if that majority-vote rule ever changes. */
function cascadeEffectiveChannelExpr(secAlias: string, factAlias: string): string {
  const effSeg = `COALESCE(${secAlias}.segment_key_override, ${factAlias}.SegmentKey)`;
  return `COALESCE(
    ${secAlias}.channel_key_override,
    CASE
      WHEN ${factAlias}.ChannelKey <> 1 THEN ${factAlias}.ChannelKey
      WHEN ${effSeg} IN (2, 3) THEN 3
      WHEN ${effSeg} IN (1, 4) THEN 2
      ELSE 1
    END
  )`;
}

/**
 * Business Unit / Customer Group / Distribution Channel now read from the admin-controlled
 * reference-data layer (admin_company/admin_customer_group/admin_distribution_channel -- see
 * data/warehouse/migrations/0018_reference_data_admin.sql) instead of the raw Dim_* tables
 * directly, so an admin's display name/order/active-state edits on
 * /admin/companies//admin/customer-groups//admin/distribution-channels show up here. Only rows
 * with a live etl_*_key are returned -- a purely custom (unlinked) reference-data row has nothing
 * in Fact_SalesLines/Fact_Targets to filter by, so it's a dead-end option here even though it's
 * visible on the admin page itself. The response shape (company_key/company_name etc.) and the
 * role_data_scope enforcement below (scopeRows/allowedValues) are unchanged -- both still key off
 * the live ETL value, exactly what every report measure filters by.
 *
 * No cascading params here -- Company is the top of the cascade, nothing is ever upstream of it
 * (see module docstring).
 */
filtersRouter.get('/business-units', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT etl_company_key as company_key, name as company_name
       FROM admin_company WHERE is_active = 1 AND etl_company_key IS NOT NULL
       ORDER BY display_order, name`,
    );
    res.json(scopeRows(rows as Record<string, unknown>[], 'company_key', allowedValues(req, 'companyKeys')));
  } catch (err) {
    next(err);
  }
});

filtersRouter.get('/customer-groups', async (req, res, next) => {
  try {
    const companyKeys = parseNumberArray(req.query.companyKeys);

    let rows: Record<string, unknown>[];
    if (companyKeys.length === 0) {
      [rows] = (await pool.query(
        `SELECT etl_segment_key as segment_key, name as segment_name
         FROM admin_customer_group WHERE is_active = 1 AND etl_segment_key IS NOT NULL
         ORDER BY display_order, name`,
      )) as [Record<string, unknown>[], unknown];
    } else {
      const companyClause = inClause('sec.effective_company_key', companyKeys)!;
      [rows] = (await pool.query(
        `SELECT DISTINCT acg.etl_segment_key as segment_key, acg.name as segment_name, acg.display_order
         FROM Fact_SalesLines fsl
         JOIN (${SALESPERSON_COMPANY_MAP_SQL}) sec ON sec.salesperson_key = fsl.SalespersonKey
         JOIN admin_customer_group acg ON acg.etl_segment_key = COALESCE(sec.segment_key_override, fsl.SegmentKey)
         WHERE ${companyClause.clause}
           AND acg.is_active = 1 AND acg.etl_segment_key IS NOT NULL
         ORDER BY acg.display_order, acg.name`,
        companyClause.params,
      )) as [Record<string, unknown>[], unknown];
    }
    res.json(scopeRows(rows, 'segment_key', allowedValues(req, 'segmentKeys')));
  } catch (err) {
    next(err);
  }
});

filtersRouter.get('/distribution-channels', async (req, res, next) => {
  try {
    const companyKeys = parseNumberArray(req.query.companyKeys);
    const segmentKeys = parseNumberArray(req.query.segmentKeys);

    let rows: Record<string, unknown>[];
    if (companyKeys.length === 0 && segmentKeys.length === 0) {
      [rows] = (await pool.query(
        `SELECT etl_channel_key as channel_key, name as channel_name
         FROM admin_distribution_channel WHERE is_active = 1 AND etl_channel_key IS NOT NULL
         ORDER BY display_order, name`,
      )) as [Record<string, unknown>[], unknown];
    } else {
      const clauses: string[] = [];
      const params: Array<string | number> = [];
      const companyClause = inClause('sec.effective_company_key', companyKeys);
      if (companyClause) {
        clauses.push(companyClause.clause);
        params.push(...companyClause.params);
      }
      const segmentClause = inClause('COALESCE(sec.segment_key_override, fsl.SegmentKey)', segmentKeys);
      if (segmentClause) {
        clauses.push(segmentClause.clause);
        params.push(...segmentClause.params);
      }
      clauses.push('adc.is_active = 1', 'adc.etl_channel_key IS NOT NULL');
      [rows] = (await pool.query(
        `SELECT DISTINCT adc.etl_channel_key as channel_key, adc.name as channel_name, adc.display_order
         FROM Fact_SalesLines fsl
         JOIN (${SALESPERSON_COMPANY_MAP_SQL}) sec ON sec.salesperson_key = fsl.SalespersonKey
         JOIN admin_distribution_channel adc ON adc.etl_channel_key = ${cascadeEffectiveChannelExpr('sec', 'fsl')}
         WHERE ${clauses.join(' AND ')}
         ORDER BY adc.display_order, adc.name`,
        params,
      )) as [Record<string, unknown>[], unknown];
    }
    res.json(scopeRows(rows, 'channel_key', allowedValues(req, 'channelKeys')));
  } catch (err) {
    next(err);
  }
});

/**
 * sales_team_name reads through sales_team_admin_profile.team_name_override (falling back to the
 * raw Dim_SalesTeam name) -- the reclassification design (see filters.ts's effectiveSalesTeamExpr)
 * means a team's admin-set name should show up everywhere the team is offered as a filter, same as
 * business-units/customer-groups/distribution-channels already do above.
 *
 * Two distinct query shapes, not one parameterized query: team membership by Company alone is a
 * fixed attribute (the team's own admin-assigned company, or its raw ETL company) -- no
 * Fact_SalesLines touch needed. Segment/Channel narrowing DOES need Fact_SalesLines, since
 * segment/channel are per-transaction facts, not team attributes.
 */
filtersRouter.get('/branches', async (req, res, next) => {
  try {
    const companyKeys = parseNumberArray(req.query.companyKeys);
    const segmentKeys = parseNumberArray(req.query.segmentKeys);
    const channelKeys = parseNumberArray(req.query.channelKeys);

    let rows: Record<string, unknown>[];
    if (companyKeys.length === 0 && segmentKeys.length === 0 && channelKeys.length === 0) {
      [rows] = (await pool.query(
        `SELECT st.SalesTeamKey as sales_team_key, COALESCE(stap.team_name_override, st.SalesTeam) as sales_team_name,
                st.SalesCity as city, dc.CompanyKey as company_key
         FROM Dim_SalesTeam st
         LEFT JOIN Dim_Company dc ON dc.Company = st.SalesTeamCompany
         LEFT JOIN sales_team_admin_profile stap ON stap.sales_team_key = st.SalesTeamKey
         ORDER BY st.SalesTeam`,
      )) as [Record<string, unknown>[], unknown];
    } else if (segmentKeys.length === 0 && channelKeys.length === 0) {
      // Company-only narrowing -- the team's own admin-assigned (or raw ETL) company is enough,
      // no Fact_SalesLines touch needed.
      const companyClause = inClause('COALESCE(stap.company_key_override, dc.CompanyKey)', companyKeys)!;
      [rows] = (await pool.query(
        `SELECT st.SalesTeamKey as sales_team_key, COALESCE(stap.team_name_override, st.SalesTeam) as sales_team_name,
                st.SalesCity as city, dc.CompanyKey as company_key
         FROM Dim_SalesTeam st
         LEFT JOIN Dim_Company dc ON dc.Company = st.SalesTeamCompany
         LEFT JOIN sales_team_admin_profile stap ON stap.sales_team_key = st.SalesTeamKey
         WHERE ${companyClause.clause}
         ORDER BY st.SalesTeam`,
        companyClause.params,
      )) as [Record<string, unknown>[], unknown];
    } else {
      const clauses: string[] = [];
      const params: Array<string | number> = [];
      const companyClause = inClause('sec.effective_company_key', companyKeys);
      if (companyClause) {
        clauses.push(companyClause.clause);
        params.push(...companyClause.params);
      }
      const segmentClause = inClause('COALESCE(sec.segment_key_override, fsl.SegmentKey)', segmentKeys);
      if (segmentClause) {
        clauses.push(segmentClause.clause);
        params.push(...segmentClause.params);
      }
      const channelClause = inClause(cascadeEffectiveChannelExpr('sec', 'fsl'), channelKeys);
      if (channelClause) {
        clauses.push(channelClause.clause);
        params.push(...channelClause.params);
      }
      [rows] = (await pool.query(
        `SELECT DISTINCT st.SalesTeamKey as sales_team_key, COALESCE(stap.team_name_override, st.SalesTeam) as sales_team_name,
                st.SalesCity as city, dc.CompanyKey as company_key, st.SalesTeam
         FROM Fact_SalesLines fsl
         JOIN (${SALESPERSON_COMPANY_MAP_SQL}) sec ON sec.salesperson_key = fsl.SalespersonKey
         JOIN Dim_SalesTeam st ON st.SalesTeamKey = COALESCE(sec.sales_team_key_override, fsl.SalesTeamKey)
         LEFT JOIN Dim_Company dc ON dc.Company = st.SalesTeamCompany
         LEFT JOIN sales_team_admin_profile stap ON stap.sales_team_key = st.SalesTeamKey
         WHERE ${clauses.join(' AND ')}
         ORDER BY st.SalesTeam`,
        params,
      )) as [Record<string, unknown>[], unknown];
    }
    res.json(scopeRows(rows, 'sales_team_key', allowedValues(req, 'salesTeamKeys')));
  } catch (err) {
    next(err);
  }
});

/**
 * A SALESPERSON-tier caller only ever sees their own name in this list (their own filter is
 * pre-selected and not editable in the UI regardless, but the list itself is scoped too -- per
 * Standards Section 5.2, scope enforcement is at the data layer, not just a disabled dropdown).
 * A role with a salespersonKeys data-scope rule gets the same treatment via scopeRows below.
 * Narrowing is meaningless for that one-row response, so the SALESPERSON-tier branch never takes
 * the narrowed path below regardless of what query params are present.
 *
 * salesperson_name reads through salesperson_admin_profile.admin_name_override (falling back to
 * the raw Dim_Salesperson name), same pattern as /branches above.
 */
filtersRouter.get('/salespersons', async (req, res, next) => {
  try {
    if (req.userContext?.roleCode === 'SALESPERSON') {
      const [rows] = await pool.query(
        `SELECT ds.SalespersonKey as salesperson_key, COALESCE(sap.admin_name_override, ds.salesperson) as salesperson_name
         FROM Dim_Salesperson ds
         LEFT JOIN salesperson_admin_profile sap ON sap.salesperson_key = ds.SalespersonKey
         WHERE ds.SalespersonKey = ?`,
        [req.userContext.salespersonKey],
      );
      res.json(rows);
      return;
    }

    const companyKeys = parseNumberArray(req.query.companyKeys);
    const segmentKeys = parseNumberArray(req.query.segmentKeys);
    const channelKeys = parseNumberArray(req.query.channelKeys);
    const salesTeamKeys = parseStringArray(req.query.salesTeamKeys);

    let rows: Record<string, unknown>[];
    if (companyKeys.length === 0 && segmentKeys.length === 0 && channelKeys.length === 0 && salesTeamKeys.length === 0) {
      [rows] = (await pool.query(
        `SELECT ds.SalespersonKey as salesperson_key, COALESCE(sap.admin_name_override, ds.salesperson) as salesperson_name
         FROM Dim_Salesperson ds
         LEFT JOIN salesperson_admin_profile sap ON sap.salesperson_key = ds.SalespersonKey
         ORDER BY ds.salesperson`,
      )) as [Record<string, unknown>[], unknown];
    } else {
      const clauses: string[] = [];
      const params: Array<string | number> = [];
      const companyClause = inClause('sec.effective_company_key', companyKeys);
      if (companyClause) {
        clauses.push(companyClause.clause);
        params.push(...companyClause.params);
      }
      const segmentClause = inClause('COALESCE(sec.segment_key_override, fsl.SegmentKey)', segmentKeys);
      if (segmentClause) {
        clauses.push(segmentClause.clause);
        params.push(...segmentClause.params);
      }
      const channelClause = inClause(cascadeEffectiveChannelExpr('sec', 'fsl'), channelKeys);
      if (channelClause) {
        clauses.push(channelClause.clause);
        params.push(...channelClause.params);
      }
      const teamClause = inClause('COALESCE(sec.sales_team_key_override, fsl.SalesTeamKey)', salesTeamKeys);
      if (teamClause) {
        clauses.push(teamClause.clause);
        params.push(...teamClause.params);
      }
      [rows] = (await pool.query(
        `SELECT DISTINCT ds.SalespersonKey AS salesperson_key, COALESCE(sec.admin_name_override, ds.salesperson) AS salesperson_name, ds.salesperson
         FROM Fact_SalesLines fsl
         JOIN Dim_Salesperson ds ON ds.SalespersonKey = fsl.SalespersonKey
         JOIN (${SALESPERSON_COMPANY_MAP_SQL}) sec ON sec.salesperson_key = fsl.SalespersonKey
         WHERE ${clauses.join(' AND ')}
         ORDER BY ds.salesperson`,
        params,
      )) as [Record<string, unknown>[], unknown];
    }
    res.json(scopeRows(rows, 'salesperson_key', allowedValues(req, 'salespersonKeys')));
  } catch (err) {
    next(err);
  }
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseIsoDate(raw: unknown): string | null {
  return typeof raw === 'string' && ISO_DATE.test(raw) ? raw : null;
}

/**
 * Cross-filtered options for all seven filters in one round trip.
 *
 * Query: companyKeys/segmentKeys/channelKeys/salesTeamKeys/salespersonKeys/customerKeys (each
 * repeatable; absent = All) and optional dateFrom/dateTo (YYYY-MM-DD, inclusive; the option lists
 * only reflect sales inside that window). Response: { filters, options, hasData } -- `filters` is
 * the selection with values that are no longer valid removed (the client adopts it).
 *
 * The caller's role data scope / salesperson lock is applied as a hard wall, never as something a
 * request can widen: values outside it are neither offered nor kept in `filters`. Unlike the report
 * endpoints, a selection outside scope is pruned silently rather than answered with a 403 -- this
 * endpoint's job is to say what is selectable.
 */
filtersRouter.get('/options', async (req, res, next) => {
  try {
    const q = req.query;
    const isSalesperson = req.userContext?.roleCode === 'SALESPERSON';

    const selection: Selection = {
      ...emptySelection(),
      companyKeys: parseNumberArray(q.companyKeys).map(String),
      segmentKeys: parseNumberArray(q.segmentKeys).map(String),
      channelKeys: parseNumberArray(q.channelKeys).map(String),
      salesTeamKeys: parseStringArray(q.salesTeamKeys),
      salespersonKeys: parseNumberArray(q.salespersonKeys).map(String),
      customerKeys: parseNumberArray(q.customerKeys).map(String),
    };

    let scope: Partial<Selection> = {};
    try {
      const roleScope = applyRoleDataScope({}, req.userContext?.dataScopeRules ?? []);
      const locked = applySalespersonLock(roleScope, req.userContext!);
      const asStrings = (v: Array<string | number> | undefined) => (v ?? []).map(String);
      scope = {
        companyKeys: asStrings(locked.companyKeys),
        segmentKeys: asStrings(locked.segmentKeys),
        channelKeys: asStrings(locked.channelKeys),
        salesTeamKeys: asStrings(locked.salesTeamKeys),
        salespersonKeys: asStrings(locked.salespersonKeys),
      };
    } catch (err) {
      if (err instanceof SalespersonLockError || err instanceof DataScopeError) {
        res.status(403).json({ error: 'Forbidden: request is outside your assigned scope.' });
        return;
      }
      throw err;
    }
    if (isSalesperson) {
      // Same as applySalespersonLock: every other dimension is meaningless once pinned to one person.
      selection.companyKeys = [];
      selection.segmentKeys = [];
      selection.channelKeys = [];
      selection.salesTeamKeys = [];
      selection.salespersonKeys = [];
    }

    let from = parseIsoDate(q.dateFrom);
    const to = parseIsoDate(q.dateTo);
    if (from && to && from > to) from = to;

    res.json(await getFilterOptions({ from, to }, selection, scope));
  } catch (err) {
    next(err);
  }
});
