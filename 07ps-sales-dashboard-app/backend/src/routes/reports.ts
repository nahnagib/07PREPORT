/**
 * Overview Report -- an on-demand PDF snapshot of the CURRENT sales situation for whatever filters
 * are on screen, aggregating all 8 dashboard pages into one document.
 *
 * NOT the same thing as the Python `reporting/` pipeline at the repo root: that is a separately
 * scheduled Sales Predictive Report over full unfiltered history, with forecasting. This endpoint
 * instead calls the exact same measures/*.ts functions each page's own /overview route already
 * calls (see services/reportSections.ts), so the PDF can never silently diverge from what's on
 * screen -- and it does no forecasting at all, current-state only.
 */
import { Router } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { requirePasswordChangeCleared } from '../middleware/permission';
import { attachUserContext, resolveScopedFilters } from '../middleware/scopeContext';
import { dateOnlyUTC, Filters } from '../measures/filters';
import { getEffectivePermissions } from '../services/permissionService';
import { SECTION_BUILDERS, SECTION_ORDER, ReportSection } from '../services/reportSections';
import { buildObservations, buildRisks } from '../services/reportObservations';
import { executiveSummary } from '../services/reportNarrative';
import { renderOverviewReportPdf, OverviewReportPayload } from '../services/reportPdf';

/** Resolves each active filter dimension's raw keys to display names, "Company: Majaal, Waha"
 * style -- the same admin_ and Dim_ lookups routes/filters.ts's own dropdown endpoints already query
 * by key, just narrowed to exactly the keys already selected instead of a role-scoped full list.
 * Kept local to this route (matching filters.ts's own "small per-file duplication over cross-module
 * imports" convention) since the Overview Report PDF is the only caller. */
async function resolveFilterSummaryParts(filters: Filters): Promise<string[]> {
  const parts: string[] = [];

  if (filters.companyKeys?.length) {
    const placeholders = filters.companyKeys.map(() => '?').join(', ');
    const [rows] = await pool.query(
      `SELECT name FROM admin_company WHERE etl_company_key IN (${placeholders})`,
      filters.companyKeys,
    );
    const names = (rows as { name: string }[]).map((r) => r.name);
    if (names.length) parts.push(`Company: ${names.join(', ')}`);
  }

  if (filters.segmentKeys?.length) {
    const placeholders = filters.segmentKeys.map(() => '?').join(', ');
    const [rows] = await pool.query(
      `SELECT name FROM admin_customer_group WHERE etl_segment_key IN (${placeholders})`,
      filters.segmentKeys,
    );
    const names = (rows as { name: string }[]).map((r) => r.name);
    if (names.length) parts.push(`Customer Group: ${names.join(', ')}`);
  }

  if (filters.channelKeys?.length) {
    const placeholders = filters.channelKeys.map(() => '?').join(', ');
    const [rows] = await pool.query(
      `SELECT name FROM admin_distribution_channel WHERE etl_channel_key IN (${placeholders})`,
      filters.channelKeys,
    );
    const names = (rows as { name: string }[]).map((r) => r.name);
    if (names.length) parts.push(`Distribution Channel: ${names.join(', ')}`);
  }

  if (filters.salesTeamKeys?.length) {
    const placeholders = filters.salesTeamKeys.map(() => '?').join(', ');
    const [rows] = await pool.query(
      `SELECT COALESCE(stap.team_name_override, st.SalesTeam) as name
       FROM Dim_SalesTeam st
       LEFT JOIN sales_team_admin_profile stap ON stap.sales_team_key = st.SalesTeamKey
       WHERE st.SalesTeamKey IN (${placeholders})`,
      filters.salesTeamKeys,
    );
    const names = (rows as { name: string }[]).map((r) => r.name);
    if (names.length) parts.push(`Branch: ${names.join(', ')}`);
  }

  if (filters.salespersonKeys?.length) {
    const placeholders = filters.salespersonKeys.map(() => '?').join(', ');
    const [rows] = await pool.query(
      `SELECT COALESCE(sap.admin_name_override, ds.salesperson) as name
       FROM Dim_Salesperson ds
       LEFT JOIN salesperson_admin_profile sap ON sap.salesperson_key = ds.SalespersonKey
       WHERE ds.SalespersonKey IN (${placeholders})`,
      filters.salespersonKeys,
    );
    const names = (rows as { name: string }[]).map((r) => r.name);
    if (names.length) parts.push(`Salesperson: ${names.join(', ')}`);
  }

  return parts;
}

export const reportsRouter = Router();

reportsRouter.use(requireAuth, requirePasswordChangeCleared, attachUserContext, resolveScopedFilters);

function parseAnchorDate(raw: unknown): Date {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const now = new Date();
    return dateOnlyUTC(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
  }
  const [y, m, d] = raw.split('-').map(Number);
  return dateOnlyUTC(y, m, d);
}

function sectionHasData(section: ReportSection): boolean {
  return section.kpis.some((k) => k.actual !== null && k.actual !== 0);
}

reportsRouter.get('/overview', async (req, res, next) => {
  try {
    const filters = req.scopedFilters!;
    const anchor = parseAnchorDate(req.query.anchorDate);
    const user = req.user!;

    // Single query for all 8 pages' export permission, rather than 8 round-trips.
    const permissions = await getEffectivePermissions(user.id, user.roleId);

    const sections: ReportSection[] = await Promise.all(
      SECTION_ORDER.map(async (pageKey) => {
        const canExport = permissions[pageKey]?.canExport ?? false;
        if (!canExport) {
          return {
            pageKey,
            label: pageKey.replace(/_/g, ' '),
            omitted: true,
            omittedReason: 'Insufficient export permission for this page.',
            kpis: [],
          } satisfies ReportSection;
        }
        try {
          return await SECTION_BUILDERS[pageKey](pool, anchor, filters);
        } catch (err) {
          // A single page's data failing must not take down the whole report.
          // eslint-disable-next-line no-console
          console.error(`[reports/overview] section "${pageKey}" failed:`, err);
          return {
            pageKey,
            label: pageKey.replace(/_/g, ' '),
            omitted: true,
            omittedReason: 'This section is temporarily unavailable.',
            kpis: [],
          } satisfies ReportSection;
        }
      }),
    );

    const includedSections = sections.filter((s) => !s.omitted);
    const anyData = includedSections.some(sectionHasData);
    if (!anyData) {
      res.status(422).json({ error: 'No data for the selected filters.' });
      return;
    }

    const observations = buildObservations(includedSections);
    const risks = buildRisks(includedSections);
    const omittedPageKeys = sections.filter((s) => s.omitted).map((s) => s.pageKey);
    const filterSummaryParts = await resolveFilterSummaryParts(filters);

    const payload: OverviewReportPayload = {
      anchorDate: anchor.toISOString().slice(0, 10),
      generatedAt: new Date().toISOString(),
      filterSummaryParts,
      exportedByEmail: user.email,
      sections: includedSections,
      omittedPageKeys,
      executiveSummary: executiveSummary(includedSections, filters, observations[0] ?? null),
      observations,
      risks,
    };

    const pdfBuffer = await renderOverviewReportPdf(payload);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Promotion_Overview_${payload.anchorDate}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    next(err);
  }
});
