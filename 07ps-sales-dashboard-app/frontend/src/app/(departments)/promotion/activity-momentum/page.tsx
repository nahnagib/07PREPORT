'use client';
import React, { useState } from 'react';
import { ArrowLeft, FileDown } from 'lucide-react';
import { AppHeader } from '../../../../components/AppHeader';
import { FilterBar } from '../../../../components/FilterBar';
import { BottomNavBar } from '../../../../components/BottomNavBar';
import { ValidationStatusBar } from '../../../../components/ValidationStatusBar';
import { RefreshFooter } from '../../../../components/RefreshFooter';
import { useFilterState, useScopedFilterOptions } from '../../../../components/FilterProvider';
import {
  Card,
  ChartPanel,
  DonutChart,
  TrendChart,
  DataTable,
  Select,
  Button,
  InsightCard,
  PerformanceReportTable,
  LoadingSkeleton,
  ErrorState,
  exportRowsAsPdf,
  type Column,
  type PerformanceReportRow,
  useCanExport,
} from '@07ps/ui';
import { useAuth } from '../../../../lib/AuthProvider';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useActivityMomentumOverview, useRefreshStatus } from '../../../../lib/hooks';
import type { ActivityOpportunityRow, LostReasonSlice, NewOpportunitiesMonthPoint, OpportunityActivityCounts, ActivityRates } from '../../../../lib/api';
import { formatCurrency, formatTimestamp, formatVariance, DISPLAY_LOCALE } from '../../../../lib/format';

const CATEGORY_PALETTE = [
  'var(--ps-color-accent)',
  'var(--ps-color-alert)',
  'var(--ps-color-gold)',
  'var(--ps-color-watch)',
  'var(--ps-color-success)',
  'var(--ps-color-last-year)',
  'var(--ps-color-neutral-text)',
];

type ActivityFilterKey = 'active' | 'lost' | 'won' | 'inactive' | 'withoutNextStep' | 'ytd';

function formatCountOrDash(v: number | null | undefined): string {
  return v != null ? v.toLocaleString(DISPLAY_LOCALE) : '—';
}

/** Plain-language definitions, shown on the page (no "i" icons: this page has no drill-down).
 * Every opportunity created this year is in exactly one of the five status tiles, so they add up
 * to #YTD (see backend/src/measures/activityMomentum.ts, "MUTUALLY EXCLUSIVE STATUSES"). */
const TILE_DEFINITIONS: Record<string, string> = {
  '#YTD': 'All opportunities created this year. #YTD = #Active + #Won + #Lost + #W/O Activity + #W/O Next Step',
  '#Active': 'Open opportunities that are still moving (not in either "W/O" group).',
  '#Won': 'Opportunities won.',
  '#Lost': 'Opportunities lost.',
  '#W/O Activity': 'Open B2B opportunities with no quotation, 30 days or more after they were created.',
  '#W/O Next Step': 'Open B2B opportunities whose last quotation is 30 days old or more.',
};
const RATE_DEFINITIONS = {
  inactive: 'Share of open B2B deals that have stalled for 30 days or more. Inactive Deals Ratio = (#W/O Activity + #W/O Next Step) ÷ open B2B deals',
  lost: 'Share of this year\'s opportunities that were lost. Lost Deals Ratio = #Lost ÷ #YTD',
};

// ---------------------------------------------------------------------------
// PDF summary-table export -- same exportRowsAsPdf mechanism as Revenue Trend, applied to every
// visual on this page. The Opportunity Activities table explicitly includes #Won/#Lost, and Total
// Lost Opportunity by Reason is Lost-specific.
// ---------------------------------------------------------------------------

interface MetricValueRow extends Record<string, unknown> {
  id: string;
  metric: string;
  value: string;
}
const metricValueColumns: Column<MetricValueRow>[] = [
  { key: 'metric', header: 'Metric' },
  { key: 'value', header: 'Value', align: 'right' },
];
function toCountsTableRows(counts?: OpportunityActivityCounts): MetricValueRow[] {
  if (!counts) return [];
  return [
    { id: 'ytd', metric: '#YTD', value: formatCountOrDash(counts.totalYtd) },
    { id: 'won', metric: '#Won', value: formatCountOrDash(counts.won) },
    { id: 'withoutActivity', metric: '#W/O Activity', value: formatCountOrDash(counts.withoutActivity) },
    { id: 'active', metric: '#Active', value: formatCountOrDash(counts.active) },
    { id: 'lost', metric: '#Lost', value: formatCountOrDash(counts.lost) },
    { id: 'withoutNextStep', metric: '#W/O Next Step', value: formatCountOrDash(counts.withoutNextStep) },
  ];
}
function toRatesTableRows(rates?: ActivityRates): MetricValueRow[] {
  if (!rates) return [];
  return [
    { id: 'inactive', metric: 'Inactive Deals Ratio', value: rates.inactiveDealsRatio != null ? formatVariance(rates.inactiveDealsRatio) ?? '—' : '—' },
    { id: 'lost', metric: 'Lost Deals Ratio', value: rates.lostDealsRatio != null ? formatVariance(rates.lostDealsRatio) ?? '—' : '—' },
  ];
}

// ---------------------------------------------------------------------------
// "Executive Summary" -- a C-level scannable rollup (6 rows, plain-English takeaways). Reuses the
// same 'ratio > 0.5 => alert' threshold already established for the Inactive/Lost Deals Ratio
// InsightCards above (see their `status={... > 0.5 ? 'alert' : 'neutral'}`), so this table never
// disagrees with what those cards already show for the same ratios.
//
// Formulas: see TILE_DEFINITIONS / RATE_DEFINITIONS above (and activityMomentum.ts). #W/O Activity,
// #W/O Next Step and Inactive Deals Ratio render "—" only if checkActivityColumnsAvailable() finds
// the quotation-staleness columns missing from Fact_Opportunity.
// ---------------------------------------------------------------------------

const RATIO_ALERT_THRESHOLD = 0.5;

function ratioTakeaway(label: string, ratio: number | null): string {
  if (ratio == null) return `${label} has no data available yet.`;
  const pct = formatVariance(ratio) ?? '—';
  return ratio > RATIO_ALERT_THRESHOLD
    ? `${label} is ${pct}, above the ${Math.round(RATIO_ALERT_THRESHOLD * 100)}% risk threshold.`
    : `${label} is ${pct}.`;
}

function toExecutiveSummaryRows(
  counts?: OpportunityActivityCounts,
  rates?: ActivityRates,
  newOppByMonth?: NewOpportunitiesMonthPoint[],
): PerformanceReportRow[] {
  if (!counts || !rates) return [];
  const series = newOppByMonth ?? [];
  // Current-year-only page: there is no prior-year comparison, so Variance to Last Year is "n/a".

  return [
    {
      id: 'ytd',
      metric: '#YTD',
      actualLabel: formatCountOrDash(counts.totalYtd),
      targetLabel: '—',
      variancePct: null,
      varianceLyPct: null,
      status: 'neutral',
      takeaway: `${formatCountOrDash(counts.totalYtd)} opportunities created so far this year (all statuses).`,
    },
    {
      id: 'active',
      metric: '#Active',
      actualLabel: formatCountOrDash(counts.active),
      targetLabel: '—',
      variancePct: null,
      varianceLyPct: null,
      status: 'neutral',
      takeaway: `${formatCountOrDash(counts.active)} open opportunities are still moving.`,
    },
    {
      id: 'withoutNextStep',
      metric: '#W/O Next Step',
      actualLabel: formatCountOrDash(counts.withoutNextStep),
      targetLabel: '—',
      variancePct: null,
      varianceLyPct: null,
      status: 'neutral',
      takeaway:
        counts.withoutNextStep != null
          ? `${formatCountOrDash(counts.withoutNextStep)} open B2B opportunities have had no new quotation for 30+ days.`
          : 'Next-step tracking data is not yet available.',
    },
    {
      id: 'lost',
      metric: '#Lost',
      actualLabel: formatCountOrDash(counts.lost),
      targetLabel: '—',
      variancePct: null,
      varianceLyPct: null,
      status: 'neutral',
      takeaway: `${formatCountOrDash(counts.lost)} opportunities lost so far this year.`,
    },
    {
      id: 'inactiveRatio',
      metric: 'Inactive Deals Ratio',
      actualLabel: rates.inactiveDealsRatio != null ? formatVariance(rates.inactiveDealsRatio) ?? '—' : '—',
      targetLabel: `< ${Math.round(RATIO_ALERT_THRESHOLD * 100)}%`,
      variancePct: null,
      varianceLyPct: null,
      status: rates.inactiveDealsRatio != null && rates.inactiveDealsRatio > RATIO_ALERT_THRESHOLD ? 'alert' : 'neutral',
      takeaway: ratioTakeaway('The share of open deals that are stale or missing a next step', rates.inactiveDealsRatio),
    },
    {
      id: 'lostRatio',
      metric: 'Lost Deals Ratio',
      actualLabel: rates.lostDealsRatio != null ? formatVariance(rates.lostDealsRatio) ?? '—' : '—',
      targetLabel: `< ${Math.round(RATIO_ALERT_THRESHOLD * 100)}%`,
      variancePct: null,
      varianceLyPct: null,
      status: rates.lostDealsRatio != null && rates.lostDealsRatio > RATIO_ALERT_THRESHOLD ? 'alert' : 'neutral',
      takeaway: ratioTakeaway('The share of this year\'s opportunities that were lost', rates.lostDealsRatio),
    },
  ];
}

interface ReasonTableRow extends Record<string, unknown> {
  id: string;
  reason: string;
  count: number;
}
const reasonTableColumns: Column<ReasonTableRow>[] = [
  { key: 'reason', header: 'Reason' },
  { key: 'count', header: 'Count', align: 'right' },
];
function toReasonTableRows(rows?: LostReasonSlice[]): ReasonTableRow[] {
  return (rows ?? []).map((r) => ({ id: r.reason, reason: r.reason, count: r.count }));
}

interface NewOppTableRow extends Record<string, unknown> {
  id: string;
  month: string;
  countYtd: number;
}
const newOppTableColumns: Column<NewOppTableRow>[] = [
  { key: 'month', header: 'Month' },
  { key: 'countYtd', header: '#YTD', align: 'right' },
];
function toNewOppTableRows(rows?: NewOpportunitiesMonthPoint[]): NewOppTableRow[] {
  return (rows ?? []).map((p) => ({ id: p.label, month: p.label, countYtd: p.countYtd }));
}

/** Resolves each column's formatted string, falling back to the render function -- same convention
 * as pipeline-health/page.tsx's PDF exports, copied per-page rather than shared. */
function rowsToPdfRows<T extends Record<string, unknown>>(columns: Column<T>[], rows: T[]): string[][] {
  return rows.map((row) => columns.map((c) => (c.render ? String(c.render(row)) : String(row[c.key] ?? ''))));
}

/** Same visual shell as Revenue Trend's ExportPdfButton -- copied per-page rather than shared, same
 * convention that component already established. */
function ExportPdfButton({ onClick, downloading, disabled }: { onClick: () => void; downloading: boolean; disabled?: boolean }) {
  // Hidden without Export permission on this page (the backend refuses the export anyway).
  const canExport = useCanExport();
  if (!canExport) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={downloading || disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11,
        fontWeight: 600,
        color: 'var(--ps-color-muted-text)',
        background: 'var(--ps-color-muted-bg)',
        border: '1px solid var(--ps-color-border)',
        borderRadius: 6,
        padding: '4px 10px',
        cursor: downloading || disabled ? 'not-allowed' : 'pointer',
        opacity: downloading || disabled ? 0.5 : 1,
      }}
    >
      <FileDown size={13} />
      {downloading ? 'Exporting...' : 'Export as PDF'}
    </button>
  );
}

/** Each flag comes from the backend's single status classification (one status per row), so every
 * option lists exactly its tile's count; no filter / 'ytd' lists all of #YTD. */
function matchesActivityFilter(o: ActivityOpportunityRow, key: ActivityFilterKey | null): boolean {
  if (key === 'active') return o.isActive;
  if (key === 'lost') return o.isLost;
  if (key === 'won') return o.isWon;
  if (key === 'inactive') return o.isInactive === true;
  if (key === 'withoutNextStep') return o.isWithoutNextStep === true;
  return o.isYtd;
}

interface OpportunityTableRow extends Record<string, unknown> {
  opportunityId: string;
  createdDate: string;
  name: string;
  customer: string;
  company: string;
  expectedRevenue: number;
  salesperson: string;
  stage: string;
}

const opportunityColumns: Column<OpportunityTableRow>[] = [
  { key: 'createdDate', header: 'Created Date' },
  { key: 'name', header: 'Opportunity Name' },
  { key: 'customer', header: 'Customer' },
  { key: 'company', header: 'Company' },
  { key: 'expectedRevenue', header: 'Expected Revenue', align: 'right', render: (r) => formatCurrency(r.expectedRevenue) },
  { key: 'salesperson', header: 'Salesperson' },
  { key: 'stage', header: 'Stage' },
];

function toTableRow(o: ActivityOpportunityRow): OpportunityTableRow {
  return {
    opportunityId: o.opportunityId,
    createdDate: o.createdDate ?? '—',
    name: o.name || '—',
    customer: o.customer ?? '—',
    company: o.company ?? '—',
    expectedRevenue: o.expectedRevenue,
    salesperson: o.salesperson ?? '—',
    stage: o.stage ?? '—',
  };
}

/**
 * Activity Momentum page (Sales, Level 3) -- eighth and final live Sales page of this build.
 * Same architecture as every other page. Two views on one page (Summary default, Opportunity
 * Activities Details reached by clicking the "Opportunity Activities" panel title -- same
 * clickable-title convention as Customer Growth's Customer Status panel).
 *
 * `#W/O Activity`, `#W/O Next Step` and the Rates panel's Inactive Deals Ratio are computed from
 * Fact_Opportunity's quotation-staleness columns (HasQuotation/LastQuotationDate/
 * DaysSinceLastQuotation/OpportunityAge/SalesSegment) -- see
 * backend/src/measures/activityMomentum.ts's header for the full definitions and the 2026-09-17
 * correction (an earlier session built these against a different, never-deployed set of columns).
 * `overview.data.activityColumnsAvailable` still gates rendering as a defensive check in case those
 * columns are ever missing from the schema again; the Activity filter panel also hides the 2
 * activity-dependent options entirely while unavailable, rather than offering a filter that would
 * always return zero rows.
 */
export default function ActivityMomentumPage() {
  const { user, isSalesperson, token, error: authError, retryAuth, logout } = useAuth();
  const {
    effectiveFilters,
    anchorDate,
    dateFromDate,
    dateToDate,
    onFiltersChange,
    onAnchorDateChange,
    onDateRangeChange,
  } = useFilterState();

  const [view, setView] = useState<'summary' | 'details'>('summary');
  const [activityFilter, setActivityFilter] = useState<ActivityFilterKey | null>(null);

  const filterOptions = useScopedFilterOptions();
  const overview = useActivityMomentumOverview(token, anchorDate, effectiveFilters, authError, retryAuth);
  const refreshStatus = useRefreshStatus(token, authError, retryAuth);
  const [downloadingPdf, setDownloadingPdf] = useState<string | null>(null);

  async function handleDownloadTablePdf<T extends Record<string, unknown>>(key: string, title: string, columns: Column<T>[], rows: T[]) {
    setDownloadingPdf(key);
    try {
      await exportRowsAsPdf({
        title,
        columns: columns.map((c) => ({ header: c.header, align: c.align })),
        rows: rowsToPdfRows(columns, rows),
        fileName: title.toLowerCase().replace(/\s+/g, '-'),
      });
    } finally {
      setDownloadingPdf(null);
    }
  }

  function handleBackToSummary() {
    setView('summary');
    setActivityFilter(null);
  }

  const roleLabel = user?.role.label ?? user?.fullName;
  const lastRefreshLabel = refreshStatus.data ? formatTimestamp(refreshStatus.data.lastRefreshTime) : undefined;
  const data = overview.data;
  const activityAvailable = data?.activityColumnsAvailable ?? false;

  const lostByReasonSegments = (data?.lostByReason ?? []).map((r, i) => ({
    id: r.reason,
    label: r.reason,
    value: r.count,
    color: CATEGORY_PALETTE[i % CATEGORY_PALETTE.length],
  }));

  const newOpportunitiesPoints = (data?.newOpportunitiesByMonth ?? []).map((p) => ({
    label: p.label,
    actual: p.countYtd,
    target: null,
  }));

  const activityFilterOptions = [
    { value: 'active', label: 'Active' },
    { value: 'lost', label: 'Lost' },
    { value: 'won', label: 'Won' },
    ...(activityAvailable ? [{ value: 'inactive', label: 'W/O Activity' }, { value: 'withoutNextStep', label: 'W/O Next Step' }] : []),
    { value: 'ytd', label: 'YTD' },
  ];

  const filteredOpportunities = (data?.opportunities ?? []).filter((o) => matchesActivityFilter(o, activityFilter)).map(toTableRow);
  const totalsRow: Partial<OpportunityTableRow> = {
    createdDate: 'Total',
    expectedRevenue: filteredOpportunities.reduce((sum, r) => sum + r.expectedRevenue, 0),
  };

  // Counts + Rates combined into one "Opportunity Activities" export (both are Zone A KPI figures,
  // including #Won/#Lost) rather than a separate button for the two floating Rate InsightCards.
  const countsAndRatesTableRows = [...toCountsTableRows(data?.counts), ...toRatesTableRows(data?.rates)];
  const reasonTableRows = toReasonTableRows(data?.lostByReason);
  const newOppTableRows = toNewOppTableRows(data?.newOpportunitiesByMonth);

  return (
    <PermissionGuard pageKey="activity_momentum">
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', paddingBottom: 64 }}>
        <AppHeader
          pageTitle="Promotion Dashboard"
          anchorDate={anchorDate}
          onAnchorDateChange={onAnchorDateChange}
          roleLabel={roleLabel}
          onLogout={logout}
          showDateInput={false}
        />

        <FilterBar
          filters={effectiveFilters}
          onChange={onFiltersChange}
          anchorDate={anchorDate}
          onAnchorDateChange={onAnchorDateChange}
          businessUnits={filterOptions.businessUnits.data ?? []}
          customerGroups={filterOptions.customerGroups.data ?? []}
          distributionChannels={filterOptions.distributionChannels.data ?? []}
          branches={filterOptions.branches.data ?? []}
          salespersons={filterOptions.salespersons.data ?? []}
          isSalesperson={isSalesperson}
          lastUpdate={refreshStatus.data?.lastUpdate ?? null}
          lastOrderCreated={refreshStatus.data?.lastOrderCreated ?? null}
          lastRefreshTime={refreshStatus.data?.lastRefreshTime ?? null}
          dateFromDate={dateFromDate}
          dateToDate={dateToDate}
          onDateRangeChange={onDateRangeChange}
          ytdOnly
        />

        <ValidationStatusBar
          isStale={refreshStatus.data?.isStale}
          isInverted={refreshStatus.data?.isInverted}
          refreshCheck={refreshStatus.data?.refreshCheck}
          lastRefreshTime={lastRefreshLabel}
        />

        <main style={{ flex: 1, padding: 'var(--ps-space-4, 24px)' }}>
          {view === 'summary' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)' }}>
              {/* Zone A -- Opportunity Activities (left) + Rates (right) */}
              <div className="ps-invoices-zone">
                <ActivityCountsPanel
                  counts={data?.counts}
                  activityAvailable={activityAvailable}
                  loading={overview.loading}
                  error={overview.error ?? undefined}
                  onRetry={overview.retry}
                  onTitleClick={() => setView('details')}
                  downloading={downloadingPdf === 'counts'}
                  onDownloadPdf={() => handleDownloadTablePdf('counts', 'Opportunity Activities', metricValueColumns, countsAndRatesTableRows)}
                />

                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gridTemplateRows: '1fr 1fr', gap: 'var(--ps-space-3, 16px)' }}>
                  <InsightCard
                    label="Inactive Deals Ratio"
                    value={data?.rates.inactiveDealsRatio != null ? formatVariance(data.rates.inactiveDealsRatio) ?? '—' : '—'}
                    caption={RATE_DEFINITIONS.inactive}
                    status={data?.rates.inactiveDealsRatio != null && data.rates.inactiveDealsRatio > 0.5 ? 'alert' : 'neutral'}
                    accentBg={data?.rates.inactiveDealsRatio != null && data.rates.inactiveDealsRatio > 0.5}
                    loading={overview.loading}
                  />
                  <InsightCard
                    label="Lost Deals Ratio"
                    value={data?.rates.lostDealsRatio != null ? formatVariance(data.rates.lostDealsRatio) ?? '—' : '—'}
                    caption={RATE_DEFINITIONS.lost}
                    status={data?.rates.lostDealsRatio != null && data.rates.lostDealsRatio > 0.5 ? 'alert' : 'neutral'}
                    accentBg={data?.rates.lostDealsRatio != null && data.rates.lostDealsRatio > 0.5}
                    loading={overview.loading}
                  />
                </div>
              </div>

              {/* Zone B -- Total Lost Opportunity by Reason (left) + New Opportunities (right) */}
              <div className="ps-invoices-zone">
                <ChartPanel<ReasonTableRow>
                  title="Total Lost Opportunity by Reason"
                  style={{ minHeight: 360 }}
                  tableColumns={overview.error ? undefined : reasonTableColumns}
                  tableRows={overview.error ? undefined : reasonTableRows}
                  getRowId={(row) => row.id}
                  headerActions={
                    !overview.error && (
                      <ExportPdfButton
                        downloading={downloadingPdf === 'reason'}
                        disabled={reasonTableRows.length === 0}
                        onClick={() => handleDownloadTablePdf('reason', 'Total Lost Opportunity by Reason', reasonTableColumns, reasonTableRows)}
                      />
                    )
                  }
                >
                  {overview.loading ? (
                    <LoadingSkeleton variant="chart" />
                  ) : overview.error ? (
                    <ErrorState message={overview.error} onRetry={overview.retry} />
                  ) : (
                    <DonutChart
                      title="Total Lost Opportunity by Reason"
                      showTitle={false}
                      segments={lostByReasonSegments}
                      legendTitle="Reason"
                      showPercentLabels
                    />
                  )}
                </ChartPanel>

                <ChartPanel<NewOppTableRow>
                  title="New Opportunities"
                  style={{ minHeight: 360 }}
                  tableColumns={overview.error ? undefined : newOppTableColumns}
                  tableRows={overview.error ? undefined : newOppTableRows}
                  getRowId={(row) => row.id}
                  headerActions={
                    !overview.error && (
                      <ExportPdfButton
                        downloading={downloadingPdf === 'newOpp'}
                        disabled={newOppTableRows.length === 0}
                        onClick={() => handleDownloadTablePdf('newOpp', 'New Opportunities', newOppTableColumns, newOppTableRows)}
                      />
                    )
                  }
                >
                  {overview.loading ? (
                    <LoadingSkeleton variant="chart" />
                  ) : overview.error ? (
                    <ErrorState message={overview.error} onRetry={overview.retry} />
                  ) : (
                    <TrendChart
                      title="New Opportunities"
                      showTitle={false}
                      points={newOpportunitiesPoints}
                      actualLabel="YTD"
                      valueFormatter={(v) => v.toLocaleString(DISPLAY_LOCALE)}
                    />
                  )}
                </ChartPanel>
              </div>

              {!overview.loading && !overview.error && (
                <PerformanceReportTable
                  title="Performance Details"
                  rows={toExecutiveSummaryRows(data?.counts, data?.rates, data?.newOpportunitiesByMonth)}
                  showStatus
                  showTakeaway
                />
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-3, 16px)' }}>
              <div className="ps-invoices-zone">
                <ActivityCountsPanel
                  counts={data?.counts}
                  activityAvailable={activityAvailable}
                  loading={overview.loading}
                  error={overview.error ?? undefined}
                  onRetry={overview.retry}
                  downloading={downloadingPdf === 'counts'}
                  onDownloadPdf={() => handleDownloadTablePdf('counts', 'Opportunity Activities', metricValueColumns, countsAndRatesTableRows)}
                />

                <Card>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ps-color-text)', marginBottom: 'var(--ps-space-2, 8px)' }}>
                    Activity Filter
                  </div>
                  <Select
                    label="Opportunity Status"
                    options={activityFilterOptions}
                    value={activityFilter ? [activityFilter] : []}
                    onChange={(v) => setActivityFilter((v[0] as ActivityFilterKey) ?? null)}
                    multiSelect={false}
                  />
                </Card>
              </div>

              <ChartPanel
                title="Opportunity Table"
                style={{ minHeight: 480 }}
                headerActions={
                  !overview.error && (
                    <ExportPdfButton
                      downloading={downloadingPdf === 'table'}
                      disabled={filteredOpportunities.length === 0}
                      onClick={() =>
                        handleDownloadTablePdf(
                          'table',
                          `Opportunity Table${activityFilter ? ` — ${activityFilter}` : ''}`,
                          opportunityColumns,
                          filteredOpportunities,
                        )
                      }
                    />
                  )
                }
              >
                {overview.loading ? (
                  <LoadingSkeleton variant="chart" />
                ) : overview.error ? (
                  <ErrorState message={overview.error} onRetry={overview.retry} />
                ) : (
                  <DataTable columns={opportunityColumns} rows={filteredOpportunities} totalsRow={totalsRow} getRowId={(row) => row.opportunityId} />
                )}
              </ChartPanel>

              <div>
                <Button variant="secondary" onClick={handleBackToSummary}>
                  <ArrowLeft size={14} />
                  Back
                </Button>
              </div>
            </div>
          )}
        </main>

        <RefreshFooter
          lastUpdate={formatTimestamp(refreshStatus.data?.lastUpdate ?? null)}
          lastOrderCreated={formatTimestamp(refreshStatus.data?.lastOrderCreated ?? null)}
          lastRefreshTime={formatTimestamp(refreshStatus.data?.lastRefreshTime ?? null)}
        />

        <BottomNavBar active="Activity Momentum" />
      </div>
    </PermissionGuard>
  );
}

// ---------------------------------------------------------------------------
// Zone A / Details view shared "Opportunity Activities" 2x3 counts panel. Title is clickable only
// in Summary view (onTitleClick passed); Details view keeps it visible but non-clickable, same
// convention as Customer Growth's Customer Status panel.
// ---------------------------------------------------------------------------

function ActivityCountsPanel({
  counts,
  activityAvailable,
  loading,
  error,
  onRetry,
  onTitleClick,
  downloading,
  onDownloadPdf,
}: {
  counts?: OpportunityActivityCounts;
  activityAvailable: boolean;
  loading: boolean;
  error?: string;
  onRetry: () => void;
  onTitleClick?: () => void;
  downloading?: boolean;
  onDownloadPdf?: () => void;
}) {
  if (loading) {
    return (
      <Card style={{ width: '100%', height: '100%' }}>
        <LoadingSkeleton variant="kpi" />
      </Card>
    );
  }
  if (error) {
    return (
      <Card style={{ width: '100%', height: '100%' }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Opportunity Activities</div>
        <ErrorState message={error} onRetry={onRetry} />
      </Card>
    );
  }

  const tiles = [
    { label: '#YTD', value: counts?.totalYtd },
    { label: '#Won', value: counts?.won },
    { label: '#W/O Activity', value: counts?.withoutActivity },
    { label: '#Active', value: counts?.active },
    { label: '#Lost', value: counts?.lost },
    { label: '#W/O Next Step', value: counts?.withoutNextStep },
  ];

  return (
    <Card style={{ width: '100%', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 'var(--ps-space-2, 8px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          {onTitleClick ? (
            <span
              role="button"
              tabIndex={0}
              onClick={onTitleClick}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onTitleClick();
                }
              }}
              title="View Opportunity Activities details"
              style={{ fontSize: 13, fontWeight: 700, color: 'var(--ps-color-text)', cursor: 'pointer' }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = 'var(--ps-color-accent)';
                e.currentTarget.style.textDecoration = 'underline';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = 'var(--ps-color-text)';
                e.currentTarget.style.textDecoration = 'none';
              }}
            >
              Opportunity Activities
            </span>
          ) : (
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ps-color-text)' }}>Opportunity Activities</span>
          )}
        </div>
        {onDownloadPdf && (
          <ExportPdfButton downloading={!!downloading} disabled={!counts} onClick={onDownloadPdf} />
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
        {tiles.map((t) => (
          <div
            key={t.label}
            title={TILE_DEFINITIONS[t.label]}
            style={{ background: 'var(--ps-color-muted-bg)', borderRadius: 'var(--ps-card-radius-sm, 10px)', padding: '10px 8px', textAlign: 'center' }}
          >
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--ps-color-text)', fontVariantNumeric: 'tabular-nums' }}>
              {formatCountOrDash(t.value)}
            </div>
            <div style={{ fontSize: 10, color: 'var(--ps-color-muted-text)', marginTop: 2 }}>{t.label}</div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginTop: 8 }}>
        Each opportunity created this year is counted in one group only: #YTD = #Active + #Won + #Lost + #W/O Activity + #W/O Next Step.
        {!activityAvailable && ' #W/O Activity and #W/O Next Step show — until the data refresh adds them (their opportunities are in #Active meanwhile).'}
        {counts && counts.unclassified > 0 && ` ${formatCountOrDash(counts.unclassified)} opportunities have no status (not open, won or lost) and are only in #YTD.`}
      </div>
    </Card>
  );
}
