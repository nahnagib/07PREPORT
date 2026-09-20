'use client';
import React, { useState } from 'react';
import { ArrowLeft, FileDown, Info } from 'lucide-react';
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
} from '@07ps/ui';
import { useAuth } from '../../../../lib/AuthProvider';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useActivityMomentumOverview, useRefreshStatus } from '../../../../lib/hooks';
import type { ActivityOpportunityRow, LostReasonSlice, NewOpportunitiesMonthPoint, OpportunityActivityCounts, ActivityRates } from '../../../../lib/api';
import { formatCurrency, formatTimestamp, formatVariance } from '../../../../lib/format';

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
  return v != null ? v.toLocaleString() : '—';
}

// ---------------------------------------------------------------------------
// PDF summary-table export -- same exportRowsAsPdf mechanism as Revenue Trend, applied to every
// visual on this page. The Opportunity Activities table explicitly includes #Won/#Lost, and Total
// Lost Opportunity by Reason is Lost-specific, so Won/Lost data is covered even though the on-screen
// New Opportunities trend (like elsewhere on this page) excludes Lost by design.
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
// Formula audit (per KPI, matching backend/src/measures/activityMomentum.ts exactly):
//  - #YTD / #Active / #Lost: plain counts, always available (no activity-column gate).
//  - #W/O Next Step, Inactive Deals Ratio: render "—" only when checkActivityColumnsAvailable()
//    (activityMomentum.ts:63-88) finds the 6 CRM activity columns (HasNextStep/HasRecentActivity/
//    IsInactive/...) don't exist yet on the live table (ETL population pass not run yet). Both are
//    all-time snapshots of current pipeline state (not filtered by this year's creation-date
//    cohort), and Inactive Deals Ratio's numerator is a single distinct at-risk count (Inactive OR
//    Without Next Step), not a sum of the two -- see activityMomentum.ts's module header ("Cohort
//    vs. snapshot scoping" / "Ratio double-counting", fixed 2026-09).
//  - Lost Deals Ratio = #Lost / (#YTD[displayed, Lost-excluded] + #Lost), i.e. Lost / total YTD
//    opportunities of every status (activityMomentum.ts:178-182's `totalYtdAll`). This ties out
//    against the example the ratio was flagged with: #Lost=230, displayed #YTD=389 ->
//    230 / (389 + 230) = 230 / 619 = 37.16%, exactly matching the "+37.16%" on screen. It is
//    deliberately NOT Lost/(Won+Lost) or Lost/displayed-#YTD -- see that file's header comment for
//    why the ratio's own denominator must stay Lost-inclusive even though the tile-level #YTD
//    excludes Lost.
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
  const sumYtd = series.reduce((s, p) => s + p.countYtd, 0);
  const sumLytd = series.reduce((s, p) => s + p.countLytd, 0);
  const ytdVarianceLy = sumLytd > 0 ? (sumYtd - sumLytd) / sumLytd : null;

  return [
    {
      id: 'ytd',
      metric: '#YTD',
      actualLabel: formatCountOrDash(counts.totalYtd),
      targetLabel: '—',
      variancePct: null,
      varianceLyPct: ytdVarianceLy,
      status: 'neutral',
      takeaway: `${formatCountOrDash(counts.totalYtd)} new opportunities created so far this year${
        ytdVarianceLy != null ? ` (${formatVariance(ytdVarianceLy)} vs last year)` : ''
      }.`,
    },
    {
      id: 'active',
      metric: '#Active',
      actualLabel: formatCountOrDash(counts.active),
      targetLabel: '—',
      variancePct: null,
      varianceLyPct: null,
      status: 'neutral',
      takeaway: `${formatCountOrDash(counts.active)} opportunities are currently open and active.`,
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
          ? `${formatCountOrDash(counts.withoutNextStep)} open opportunities have no next step scheduled.`
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
  countLytd: number;
}
const newOppTableColumns: Column<NewOppTableRow>[] = [
  { key: 'month', header: 'Month' },
  { key: 'countYtd', header: '#YTD', align: 'right' },
  { key: 'countLytd', header: '#LYTD', align: 'right' },
];
function toNewOppTableRows(rows?: NewOpportunitiesMonthPoint[]): NewOppTableRow[] {
  return (rows ?? []).map((p) => ({ id: p.label, month: p.label, countYtd: p.countYtd, countLytd: p.countLytd }));
}

/** Resolves each column's formatted string, falling back to the render function -- same convention
 * as pipeline-health/page.tsx's PDF exports, copied per-page rather than shared. */
function rowsToPdfRows<T extends Record<string, unknown>>(columns: Column<T>[], rows: T[]): string[][] {
  return rows.map((row) => columns.map((c) => (c.render ? String(c.render(row)) : String(row[c.key] ?? ''))));
}

/** Same visual shell as Revenue Trend's ExportPdfButton -- copied per-page rather than shared, same
 * convention that component already established. */
function ExportPdfButton({ onClick, downloading, disabled }: { onClick: () => void; downloading: boolean; disabled?: boolean }) {
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

/** Lost-exclusion policy: the default view (no filter selected -- a general, not lost-specific
 * listing) and the 'ytd' filter (mirrors the #YTD tile, which now excludes Lost too, see
 * activityMomentum.ts's module header) both exclude Lost. 'active'/'won'/'inactive'/
 * 'withoutNextStep' need no extra check: 'active'/'inactive'/'withoutNextStep' already imply
 * IsOpen, which is mutually exclusive with Lost by construction, and 'won' can't overlap Lost
 * either. 'lost' is the lost-specific filter and stays exactly as-is. */
function matchesActivityFilter(o: ActivityOpportunityRow, key: ActivityFilterKey | null): boolean {
  if (!key) return !o.isLost;
  if (key === 'active') return o.isActive;
  if (key === 'lost') return o.isLost;
  if (key === 'won') return o.isWon;
  if (key === 'inactive') return o.isInactive === true;
  if (key === 'withoutNextStep') return o.isOpen && o.isWithoutNextStep === true;
  return o.isYtd && !o.isLost;
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
    lastYear: p.countLytd,
    target: null,
  }));

  const activityFilterOptions = [
    { value: 'active', label: 'Active' },
    { value: 'lost', label: 'Lost' },
    { value: 'won', label: 'Won' },
    ...(activityAvailable ? [{ value: 'inactive', label: 'Inactive' }, { value: 'withoutNextStep', label: 'Without Next Step' }] : []),
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
          dateFromDate={dateFromDate}
          dateToDate={dateToDate}
          onDateRangeChange={onDateRangeChange}
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
                    infoText="Measures the share of currently-open opportunities that are stale (inactive) or missing a next step, as of the last data refresh. Formula: distinct count of open opportunities where Inactive OR Without Next Step ÷ Open Opportunities (all-time snapshot, not limited to this year's cohort)."
                    status={data?.rates.inactiveDealsRatio != null && data.rates.inactiveDealsRatio > 0.5 ? 'alert' : 'neutral'}
                    accentBg={data?.rates.inactiveDealsRatio != null && data.rates.inactiveDealsRatio > 0.5}
                    loading={overview.loading}
                  />
                  <InsightCard
                    label="Lost Deals Ratio"
                    value={data?.rates.lostDealsRatio != null ? formatVariance(data.rates.lostDealsRatio) ?? '—' : '—'}
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
                      lastYearLabel="LYTD"
                      valueFormatter={(v) => v.toLocaleString()}
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
  counts?: { totalYtd: number; won: number; withoutActivity: number | null; active: number; lost: number; withoutNextStep: number | null };
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
    {
      label: '#W/O Activity',
      value: counts?.withoutActivity,
      infoText: 'Open opportunities with no update in the last 14 days (HasRecentActivity). A different, shorter-window signal than the Rates panel\'s "Inactive" (30+ days) -- not the same count.',
    },
    { label: '#Active', value: counts?.active },
    { label: '#Lost', value: counts?.lost },
    {
      label: '#W/O Next Step',
      value: counts?.withoutNextStep,
      infoText: 'Open opportunities that have an existing quotation but no meaningful follow-up action for an extended period.',
    },
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
          <span
            title={
              activityAvailable
                ? 'YTD opportunity counts by activity status.'
                : 'YTD opportunity counts by activity status. #W/O Activity and #W/O Next Step need a data refresh not yet run -- they show — until then.'
            }
            aria-label="Opportunity Activities definitions"
            style={{ color: 'var(--ps-color-muted-text)', display: 'inline-flex', cursor: 'help', flexShrink: 0 }}
          >
            <Info size={13} />
          </span>
        </div>
        {onDownloadPdf && (
          <ExportPdfButton downloading={!!downloading} disabled={!counts} onClick={onDownloadPdf} />
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
        {tiles.map((t) => (
          <div key={t.label} style={{ background: 'var(--ps-color-muted-bg)', borderRadius: 'var(--ps-card-radius-sm, 10px)', padding: '10px 8px', textAlign: 'center' }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--ps-color-text)', fontVariantNumeric: 'tabular-nums' }}>
              {formatCountOrDash(t.value)}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3, marginTop: 2 }}>
              <span style={{ fontSize: 10, color: 'var(--ps-color-muted-text)' }}>{t.label}</span>
              {'infoText' in t && t.infoText && (
                <span
                  title={t.infoText}
                  aria-label={t.infoText}
                  style={{ color: 'var(--ps-color-muted-text)', display: 'inline-flex', cursor: 'help' }}
                >
                  <Info size={10} />
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
