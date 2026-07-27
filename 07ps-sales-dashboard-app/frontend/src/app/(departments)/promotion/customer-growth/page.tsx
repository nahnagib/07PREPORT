'use client';
import React, { useState } from 'react';
import { ArrowLeft, FileDown, Info, Layers } from 'lucide-react';
import { AppHeader } from '../../../../components/AppHeader';
import { FilterBar } from '../../../../components/FilterBar';
import { BottomNavBar } from '../../../../components/BottomNavBar';
import { ValidationStatusBar } from '../../../../components/ValidationStatusBar';
import { RefreshFooter } from '../../../../components/RefreshFooter';
import { useFilterState } from '../../../../components/FilterProvider';
import {
  Card,
  ChartPanel,
  ComboChart,
  DonutChart,
  GroupedBarChart,
  DataGrid,
  Select,
  Button,
  InsightCard,
  LoadingSkeleton,
  ErrorState,
  exportRowsAsPdf,
  type Column,
  type DataGridColumn,
} from '@07ps/ui';
import { useAuth } from '../../../../lib/AuthProvider';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useFilterOptions, useCustomerGrowthOverview, useRefreshStatus, useExportOverviewReport } from '../../../../lib/hooks';
import type {
  CustomerGrowthPeriodCounts,
  CustomerGrowthScope,
  CustomerStatusCounts,
  CustomerStatusLabel,
} from '../../../../lib/api';
import { formatCurrency, formatTimestamp, formatVariance } from '../../../../lib/format';

const CATEGORY_LETTERS = new Set(['A', 'B', 'C', 'D']);

const STATUS_SLICER_OPTIONS: { value: CustomerStatusLabel; label: string }[] = [
  { value: 'Active Retained', label: 'Active Retained' },
  { value: 'New', label: 'New' },
  { value: 'Non Active', label: 'Non Active' },
  { value: 'Reactivated', label: 'Reactivated' },
  { value: 'Other', label: 'Other' },
];

/** Y-axis tick formatter for currency values: millions with an "M" suffix -- same convention as
 * Invoices Engine / Revenue Trend's chart axes. */
function formatMillions(value: number): string {
  const fixed = (value / 1_000_000).toFixed(1);
  return `${fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed}M`;
}

function formatPlainNumber(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function formatCountOrDash(value: number | undefined): string {
  return value != null ? value.toLocaleString() : '—';
}

// ---------------------------------------------------------------------------
// PDF summary-table export -- same exportRowsAsPdf mechanism as Revenue Trend, applied to every
// summary-view visual (the Details view's Customers Table already has its own DataGrid-built-in PDF
// export, untouched here).
// ---------------------------------------------------------------------------

interface PeriodCountTableRow extends Record<string, unknown> {
  id: string;
  period: string;
  value: string;
}
const periodCountTableColumns: Column<PeriodCountTableRow>[] = [
  { key: 'period', header: 'Period' },
  { key: 'value', header: 'Value', align: 'right' },
];
function toPeriodCountTableRows(counts?: CustomerGrowthPeriodCounts): PeriodCountTableRow[] {
  if (!counts) return [];
  return [
    { id: 'lytd', period: 'LYTD', value: formatCountOrDash(counts.lytd) },
    { id: 'ytd', period: 'YTD', value: formatCountOrDash(counts.ytd) },
    { id: 'lmtd', period: 'LMTD', value: formatCountOrDash(counts.lmtd) },
    { id: 'mtd', period: 'MTD', value: formatCountOrDash(counts.mtd) },
  ];
}
function toCustomerStatusTableRows(counts?: CustomerStatusCounts): PeriodCountTableRow[] {
  if (!counts) return [];
  return [
    { id: 'activeRetained', period: 'Active Retained', value: formatCountOrDash(counts.activeRetained) },
    { id: 'nonActive', period: 'Inactive / Non-Active', value: formatCountOrDash(counts.nonActive) },
    { id: 'blocked', period: 'Blocked', value: formatCountOrDash(counts.blocked) },
    { id: 'reactivated', period: 'Reactivated', value: formatCountOrDash(counts.reactivated) },
  ];
}

interface TrendTableRow extends Record<string, unknown> {
  id: string;
  year: string;
  totalSalesValue: string;
  customerCount: number;
}
const trendTableColumns: Column<TrendTableRow>[] = [
  { key: 'year', header: 'Year' },
  { key: 'totalSalesValue', header: 'Total Sales Value', align: 'right' },
  { key: 'customerCount', header: 'Customer Count', align: 'right' },
];

interface RateTableRow extends Record<string, unknown> {
  id: string;
  metric: string;
  value: string;
}
const rateTableColumns: Column<RateTableRow>[] = [
  { key: 'metric', header: 'Metric' },
  { key: 'value', header: 'Value', align: 'right' },
];

interface ContributionTableRow extends Record<string, unknown> {
  id: string;
  label: string;
  value: string;
}
const contributionTableColumns: Column<ContributionTableRow>[] = [
  { key: 'label', header: 'Group / Customer' },
  { key: 'value', header: 'Value', align: 'right' },
];

interface CategoryTableRow extends Record<string, unknown> {
  id: string;
  label: string;
  salesLytm: string;
  salesYtm: string;
}
const categoryTableColumns: Column<CategoryTableRow>[] = [
  { key: 'label', header: 'Category / Customer' },
  { key: 'salesLytm', header: 'Sales LYTD', align: 'right' },
  { key: 'salesYtm', header: 'Sales YTD', align: 'right' },
];

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
        whiteSpace: 'nowrap',
      }}
    >
      <FileDown size={13} />
      {downloading ? 'Exporting...' : 'Export as PDF'}
    </button>
  );
}

/**
 * Customer Growth page (Sales, Level 3) -- fifth live Sales page after Tachometer, Critical
 * Number, Revenue Trend and Invoices Engine, built to the exact same architecture (AppHeader +
 * FilterBar + ValidationStatusBar + BottomNavBar, PermissionGuard pageKey='customer_growth', same
 * useAuth/useFilterOptions/useRefreshStatus hooks, same @07ps/ui primitives) so it is
 * indistinguishable in look/behavior from the rest of the platform.
 *
 * All figures come from backend/src/measures/customerGrowth.ts. Two views live on this one page,
 * toggled locally (not routed): `view === 'summary'` (default) and `view === 'details'`, reached
 * by clicking the Customer Status panel's title. Three independent interactions, same
 * self-contained pattern as Invoices Engine:
 *   1. Customers Trend: clicking a year sets/clears the page's Year filter (selectedYear) -- a
 *      real backend re-query, re-scoping every other visual (including the Details view). No
 *      drill-down mode of its own -- always click-to-filter.
 *   2. Customers Contribution donut: clicking Top 10 / Other drills the chart itself into that
 *      bucket's individual customers -- purely local state, no re-fetch (the backend already
 *      returns the ranked customer list).
 *   3. Customers Category Performance bars: same dual-mode toggle as Invoices Engine's own Sales
 *      Trend chart (categoryDrillMode). Off (default): clicking a category sets/clears the page's
 *      Category filter (selectedCategory) -- a real backend re-query, re-scoping every other
 *      visual (including the Details view) same as selectedYear. On: clicking a category drills
 *      the chart itself into that category's customers -- local-only, no re-fetch. The two modes
 *      are mutually exclusive, same as Invoices Engine's drillMode/selectedYear split.
 */
export default function CustomerGrowthPage() {
  const { user, isSalesperson, token, error: authError, retryAuth, logout } = useAuth();
  const {
    effectiveFilters,
    anchorDate,
    dateFromDate,
    dateToDate,
    onFiltersChange,
    onAnchorDateChange,
    onDateRangeChange,
    resetFilters,
  } = useFilterState();

  const [view, setView] = useState<'summary' | 'details'>('summary');
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const [contributionDrill, setContributionDrill] = useState<'top10' | 'other' | null>(null);
  // Customers Category Performance chart's dual-mode interaction, same drillMode/drilledYear vs
  // selectedYear split as Invoices Engine's Sales Trend chart: categoryDrillMode toggles whether a
  // click drills the chart itself into that category's customers (categoryDrill, local-only) or
  // sets the page's Category filter (selectedCategory, a real backend re-query) instead. Off by
  // default, same as Invoices Engine's own drillMode.
  const [categoryDrillMode, setCategoryDrillMode] = useState(false);
  const [categoryDrill, setCategoryDrill] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<CustomerStatusLabel | null>(null);
  // Customer filter: unlike the other 5 FilterBar dimensions, this isn't backend-wired (no Customer
  // dimension in the shared filter-options endpoint -- see FilterBar.tsx's fallback) -- it's built
  // client-side from this page's own customersTable response and narrows the two per-customer-list
  // visuals below (Customer Details table, Customers Contribution donut) rather than triggering a
  // re-fetch. Page-local, not synced through FilterProvider, since no other page has this dimension.
  const [selectedCustomerKeys, setSelectedCustomerKeys] = useState<string[]>([]);

  const scope: CustomerGrowthScope = { selectedYear, selectedCategory };

  const filterOptions = useFilterOptions(token, authError, retryAuth);
  const overview = useCustomerGrowthOverview(token, anchorDate, effectiveFilters, scope, authError, retryAuth);
  const refreshStatus = useRefreshStatus(token, authError, retryAuth);
  const exportReport = useExportOverviewReport(token, anchorDate, effectiveFilters);
  const [downloadingPdf, setDownloadingPdf] = useState<string | null>(null);

  async function handleDownloadTablePdf<T extends Record<string, unknown>>(key: string, title: string, columns: Column<T>[], rows: T[]) {
    setDownloadingPdf(key);
    try {
      await exportRowsAsPdf({
        title,
        columns: columns.map((c) => ({ header: c.header, align: c.align })),
        rows: rows.map((row) => columns.map((c) => String(row[c.key] ?? ''))),
        fileName: title.toLowerCase().replace(/\s+/g, '-'),
      });
    } finally {
      setDownloadingPdf(null);
    }
  }

  function handleReset() {
    resetFilters();
    setView('summary');
    setSelectedYear(null);
    setContributionDrill(null);
    setCategoryDrillMode(false);
    setCategoryDrill(null);
    setSelectedCategory(null);
    setStatusFilter(null);
    setSelectedCustomerKeys([]);
  }

  function handleRefresh() {
    overview.retry();
    refreshStatus.retry();
  }

  function handleTrendCategoryClick(label: string) {
    const year = Number(label);
    if (Number.isNaN(year)) return;
    setSelectedYear((prev) => (prev === year ? null : year));
  }

  function handleTrendAreaClick() {
    setSelectedYear(null);
  }

  function handleContributionSegmentClick(id: string) {
    if (contributionDrill === null) {
      if (id === 'top10' || id === 'other') setContributionDrill(id);
    }
    // Already drilled: individual-customer segments have no further drill level -- use the "Back
    // to groups" link above the chart instead (same convention as Invoices Engine's Sales Trend
    // drill-down banner).
  }

  function handleCategoryClick(label: string) {
    if (!CATEGORY_LETTERS.has(label)) return;
    if (categoryDrillMode) {
      if (categoryDrill == null) setCategoryDrill(label);
      // Already drilled into one category's customers -- no further drill level defined here.
      return;
    }
    setSelectedCategory((prev) => (prev === label ? null : label));
  }

  /** Mutually exclusive per the same convention Invoices Engine's Sales Trend drillMode toggle
   * follows: entering drill-down clears any active Category page-filter (its own click behavior
   * takes over instead); leaving it clears the in-chart drill. */
  function toggleCategoryDrillMode() {
    setCategoryDrillMode((prev) => {
      const next = !prev;
      if (next) setSelectedCategory(null);
      else setCategoryDrill(null);
      return next;
    });
  }

  /** Back button (Details view -> Summary view): resets the Status Slicer selection (a
   * details-view-local control with nothing to preserve once the table it filters is no longer
   * visible), but leaves selectedYear -- a genuine page-level filter -- intact, same "only reset
   * the state that's actually local to the interaction being exited" convention Invoices Engine's
   * drill-mode toggle already follows. */
  function handleBackToSummary() {
    setView('summary');
    setStatusFilter(null);
  }

  const roleLabel = user?.role.label ?? user?.fullName;
  const lastRefreshLabel = refreshStatus.data ? formatTimestamp(refreshStatus.data.lastRefreshTime) : undefined;

  const data = overview.data;
  const kpis = data?.kpis;

  const trendPoints = (data?.customersTrend ?? []).map((y) => ({
    label: y.label,
    totalSalesValue: y.totalSalesValue,
    customerCount: y.customerCount,
  }));

  // Customer filter options: built from this page's own customer list (no shared Customer
  // dimension exists -- see FilterBar's fallback), sorted for a stable, scannable dropdown.
  const customerOptions = (data?.customersTable ?? [])
    .map((r) => ({ value: String(r.customerKey), label: r.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const hasCustomerSelection = selectedCustomerKeys.length > 0;

  const contribution = data?.customersContribution;
  const contributionCustomers = (contribution?.customers ?? []).filter(
    (c) => !hasCustomerSelection || selectedCustomerKeys.includes(String(c.customerKey)),
  );
  const top10 = contributionCustomers.slice(0, 10);
  const otherIndividual = contributionCustomers.slice(10);
  const top10Total = top10.reduce((sum, c) => sum + c.value, 0);
  // The remainder bucket (customers beyond what the backend's ranked list returns) has no
  // per-customer breakdown to filter against, so it's only folded in when no Customer selection is
  // active -- otherwise "Other Customers" would silently include customers outside the selection.
  const otherTotal = otherIndividual.reduce((sum, c) => sum + c.value, 0) + (hasCustomerSelection ? 0 : contribution?.remainderValue ?? 0);

  const contributionSegments =
    contributionDrill === null
      ? [
          { id: 'top10', label: 'Top 10 Customers', value: top10Total, color: 'var(--ps-color-accent)' },
          { id: 'other', label: 'Other Customers', value: otherTotal, color: 'var(--ps-color-last-year)' },
        ]
      : contributionDrill === 'top10'
      ? top10.map((c) => ({ id: String(c.customerKey), label: c.name, value: c.value, color: 'var(--ps-color-accent)' }))
      : [
          ...otherIndividual.map((c) => ({ id: String(c.customerKey), label: c.name, value: c.value, color: 'var(--ps-color-last-year)' })),
          ...(!hasCustomerSelection && contribution && contribution.remainderCount > 0
            ? [{ id: 'remainder', label: `+${contribution.remainderCount} more`, value: contribution.remainderValue, color: 'var(--ps-color-watch)' }]
            : []),
        ];

  const categoryRows = data?.categoryPerformance ?? [];
  const drilledCategoryRow = categoryDrill ? categoryRows.find((c) => c.category === categoryDrill) : undefined;
  const categoryChartPoints = drilledCategoryRow
    ? drilledCategoryRow.customers.map((c) => ({ label: c.name, salesLytm: c.salesLytm, salesYtm: c.salesYtm }))
    : categoryRows.map((c) => ({ label: c.category, salesLytm: c.salesLytm, salesYtm: c.salesYtm }));

  const tableRows = (data?.customersTable ?? [])
    .filter((r) => !statusFilter || r.status === statusFilter)
    .filter((r) => !hasCustomerSelection || selectedCustomerKeys.includes(String(r.customerKey)))
    .map((r) => ({
      customerKey: r.customerKey,
      name: r.name,
      ytdValue: r.ytdValue,
      lastPurchaseDate: r.lastPurchaseDate ?? '—',
      firstPurchaseDate: r.firstPurchaseDate ?? '—',
      groupClass: `${r.customerSegment ?? '—'} / ${r.customerClass ?? '—'}`,
    }));

  const newCustomersTableRows = toPeriodCountTableRows(kpis?.newCustomers);
  const totalCustomersTableRows = toPeriodCountTableRows(kpis?.totalCustomers);
  const customerStatusTableRows = toCustomerStatusTableRows(kpis?.customerStatus);

  const trendTableRows: TrendTableRow[] = trendPoints.map((p) => ({
    id: p.label,
    year: p.label,
    totalSalesValue: formatCurrency(p.totalSalesValue),
    customerCount: p.customerCount,
  }));

  const rateTableRows: RateTableRow[] = [
    { id: 'acquisition', metric: 'Customer Acquisition', value: data?.rates.customerAcquisitionPct != null ? formatVariance(data.rates.customerAcquisitionPct) ?? '—' : '—' },
    { id: 'growth', metric: 'Customer Growth', value: data?.rates.customerGrowthPct != null ? formatVariance(data.rates.customerGrowthPct) ?? '—' : '—' },
    { id: 'retention', metric: 'Retention Rate', value: data?.rates.retentionRatePct != null ? formatVariance(data.rates.retentionRatePct) ?? '—' : '—' },
    { id: 'churn', metric: 'Churn Rate', value: data?.rates.churnRatePct != null ? formatVariance(data.rates.churnRatePct) ?? '—' : '—' },
  ];

  const contributionTableRows: ContributionTableRow[] = contributionSegments.map((s) => ({
    id: s.id,
    label: s.label,
    value: formatCurrency(s.value),
  }));

  const categoryTableRows: CategoryTableRow[] = categoryChartPoints.map((p, i) => ({
    id: `${p.label}-${i}`,
    label: p.label,
    salesLytm: formatCurrency(p.salesLytm),
    salesYtm: formatCurrency(p.salesYtm),
  }));

  return (
    <PermissionGuard pageKey="customer_growth">
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', paddingBottom: 64 }}>
        <AppHeader
          pageTitle="Promotion Dashboard"
          anchorDate={anchorDate}
          onAnchorDateChange={onAnchorDateChange}
          onRefresh={handleRefresh}
          lastRefreshTime={lastRefreshLabel}
          roleLabel={roleLabel}
          onLogout={logout}
          showDateInput={false}
        />

        <FilterBar
          filters={effectiveFilters}
          onChange={onFiltersChange}
          onReset={handleReset}
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
          customerOptions={customerOptions}
          customerValue={selectedCustomerKeys}
          onCustomerChange={setSelectedCustomerKeys}
          onExportReport={exportReport.exportReport}
          isExporting={exportReport.isExporting}
          exportError={exportReport.error}
        />

        <ValidationStatusBar
          isStale={refreshStatus.data?.isStale}
          isInverted={refreshStatus.data?.isInverted}
          lastRefreshTime={lastRefreshLabel}
        />

        <main style={{ flex: 1, padding: 'var(--ps-space-4, 24px)' }}>
          {view === 'summary' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)' }}>
              {/* Zone A -- KPI Indicators */}
              <div className="ps-invoices-kpi-row">
                <CountMetricPanel
                  title="New Customers"
                  counts={kpis?.newCustomers}
                  loading={overview.loading}
                  error={overview.error ?? undefined}
                  onRetry={overview.retry}
                  tableRows={newCustomersTableRows}
                  downloading={downloadingPdf === 'newCustomers'}
                  onDownloadPdf={() => handleDownloadTablePdf('newCustomers', 'New Customers', periodCountTableColumns, newCustomersTableRows)}
                />
                <CountMetricPanel
                  title="Total Customers"
                  counts={kpis?.totalCustomers}
                  loading={overview.loading}
                  error={overview.error ?? undefined}
                  onRetry={overview.retry}
                  tableRows={totalCustomersTableRows}
                  downloading={downloadingPdf === 'totalCustomers'}
                  onDownloadPdf={() => handleDownloadTablePdf('totalCustomers', 'Total Customers', periodCountTableColumns, totalCustomersTableRows)}
                />
                <CustomerStatusPanel
                  counts={kpis?.customerStatus}
                  loading={overview.loading}
                  error={overview.error ?? undefined}
                  onRetry={overview.retry}
                  onTitleClick={() => setView('details')}
                  downloading={downloadingPdf === 'customerStatus'}
                  onDownloadPdf={() => handleDownloadTablePdf('customerStatus', 'Customer Status', periodCountTableColumns, customerStatusTableRows)}
                />
              </div>

              {/* Zone B -- Customers Trend (left) + Rates (right) */}
              <div className="ps-invoices-zone">
                <ChartPanel<TrendTableRow>
                  title="Customers Trend"
                  infoText="Total Sales Value and Customer Count by year. Click a year to set it as the page's active filter; click it again to clear."
                  style={{ minHeight: 380 }}
                  tableColumns={overview.error ? undefined : trendTableColumns}
                  tableRows={overview.error ? undefined : trendTableRows}
                  getRowId={(row) => row.id}
                  headerActions={
                    !overview.error && (
                      <ExportPdfButton
                        downloading={downloadingPdf === 'trend'}
                        disabled={trendTableRows.length === 0}
                        onClick={() => handleDownloadTablePdf('trend', 'Customers Trend', trendTableColumns, trendTableRows)}
                      />
                    )
                  }
                >
                  {overview.loading ? (
                    <LoadingSkeleton variant="chart" />
                  ) : overview.error ? (
                    <ErrorState message={overview.error} onRetry={overview.retry} />
                  ) : (
                    <ComboChart
                      title="Customers Trend"
                      showTitle={false}
                      points={trendPoints}
                      bars={[{ key: 'totalSalesValue', name: 'Total Sales Value', color: 'var(--ps-color-accent)' }]}
                      lines={[{ key: 'customerCount', name: 'Customer Count', color: 'var(--ps-color-last-year)', yAxisId: 'right' }]}
                      leftAxisFormatter={formatMillions}
                      rightAxisFormatter={formatPlainNumber}
                      tooltipFormatters={{
                        totalSalesValue: (v) => formatCurrency(v),
                        customerCount: (v) => v.toLocaleString(),
                      }}
                      onCategoryClick={handleTrendCategoryClick}
                      onAreaClick={handleTrendAreaClick}
                      highlightedCategory={selectedYear != null ? String(selectedYear) : null}
                    />
                  )}
                </ChartPanel>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-2, 8px)' }}>
                  {!overview.error && (
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <ExportPdfButton
                        downloading={downloadingPdf === 'rates'}
                        disabled={rateTableRows.length === 0}
                        onClick={() => handleDownloadTablePdf('rates', 'Rates', rateTableColumns, rateTableRows)}
                      />
                    </div>
                  )}
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(2, 1fr)',
                      gridTemplateRows: 'repeat(2, 1fr)',
                      gap: 'var(--ps-space-3, 16px)',
                      flex: 1,
                    }}
                  >
                    <RateCard
                      label="Customer Acquisition"
                      pct={data?.rates.customerAcquisitionPct ?? null}
                      goodBadApplies
                      loading={overview.loading}
                    />
                    <RateCard
                      label="Customer Growth"
                      pct={data?.rates.customerGrowthPct ?? null}
                      goodBadApplies
                      loading={overview.loading}
                    />
                    <RateCard
                      label="Retention Rate"
                      pct={data?.rates.retentionRatePct ?? null}
                      goodBadApplies={false}
                      loading={overview.loading}
                    />
                    <RateCard
                      label="Churn Rate"
                      pct={data?.rates.churnRatePct ?? null}
                      goodBadApplies={false}
                      loading={overview.loading}
                    />
                  </div>
                </div>
              </div>

              {/* Zone C -- Customers Contribution (left) + Customers Category Performance (right) */}
              <div className="ps-invoices-zone">
                <ChartPanel<ContributionTableRow>
                  title="Customers Contribution"
                  infoText="Share of total sales value contributed by the Top 10 customers vs. every other customer, year-to-date."
                  style={{ minHeight: 380 }}
                  tableColumns={overview.error ? undefined : contributionTableColumns}
                  tableRows={overview.error ? undefined : contributionTableRows}
                  getRowId={(row) => row.id}
                  headerActions={
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <DrillIndicator hint="Click Top 10 or Other to drill into that group's customers" />
                      {!overview.error && (
                        <ExportPdfButton
                          downloading={downloadingPdf === 'contribution'}
                          disabled={contributionTableRows.length === 0}
                          onClick={() => handleDownloadTablePdf('contribution', 'Customers Contribution', contributionTableColumns, contributionTableRows)}
                        />
                      )}
                    </div>
                  }
                >
                  {overview.loading ? (
                    <LoadingSkeleton variant="chart" />
                  ) : overview.error ? (
                    <ErrorState message={overview.error} onRetry={overview.retry} />
                  ) : (
                    <>
                      {contributionDrill && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                          <span style={{ fontSize: 12, color: 'var(--ps-color-muted-text)' }}>
                            Showing {contributionDrill === 'top10' ? 'Top 10' : 'Other'} customers
                          </span>
                          <button
                            type="button"
                            onClick={() => setContributionDrill(null)}
                            style={{
                              fontSize: 11,
                              fontWeight: 600,
                              color: 'var(--ps-color-accent)',
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                              padding: 0,
                              textDecoration: 'underline',
                            }}
                          >
                            Back to groups
                          </button>
                        </div>
                      )}
                      <DonutChart
                        title="Customers Contribution"
                        showTitle={false}
                        segments={contributionSegments}
                        valueFormatter={(v) => formatCurrency(v)}
                        legendTitle="Group"
                        onSegmentClick={handleContributionSegmentClick}
                      />
                    </>
                  )}
                </ChartPanel>

                <ChartPanel<CategoryTableRow>
                  title="Customers Category Performance"
                  infoText="Sales LYTD vs. Sales YTD by Customer Category (A highest value - D lowest). Enable drill-down to click a category and see its individual customers, or leave it off to click a category and set it as the page's active filter."
                  style={{ minHeight: 380 }}
                  tableColumns={overview.error ? undefined : categoryTableColumns}
                  tableRows={overview.error ? undefined : categoryTableRows}
                  getRowId={(row) => row.id}
                  headerActions={
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <DrillToggle active={categoryDrillMode} onToggle={toggleCategoryDrillMode} />
                      {!overview.error && (
                        <ExportPdfButton
                          downloading={downloadingPdf === 'category'}
                          disabled={categoryTableRows.length === 0}
                          onClick={() => handleDownloadTablePdf('category', 'Customers Category Performance', categoryTableColumns, categoryTableRows)}
                        />
                      )}
                    </div>
                  }
                >
                  {overview.loading ? (
                    <LoadingSkeleton variant="chart" />
                  ) : overview.error ? (
                    <ErrorState message={overview.error} onRetry={overview.retry} />
                  ) : (
                    <>
                      {categoryDrill && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                          <span style={{ fontSize: 12, color: 'var(--ps-color-muted-text)' }}>Showing Category {categoryDrill} customers</span>
                          <button
                            type="button"
                            onClick={() => setCategoryDrill(null)}
                            style={{
                              fontSize: 11,
                              fontWeight: 600,
                              color: 'var(--ps-color-accent)',
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                              padding: 0,
                              textDecoration: 'underline',
                            }}
                          >
                            Back to categories
                          </button>
                        </div>
                      )}
                      <GroupedBarChart
                        title="Customers Category Performance"
                        showTitle={false}
                        points={categoryChartPoints}
                        bars={[
                          { key: 'salesLytm', name: 'Sales LYTD', color: 'var(--ps-color-last-year)' },
                          { key: 'salesYtm', name: 'Sales YTD', color: 'var(--ps-color-accent)' },
                        ]}
                        valueFormatter={formatMillions}
                        tooltipFormatters={{ salesLytm: (v) => formatCurrency(v), salesYtm: (v) => formatCurrency(v) }}
                        onCategoryClick={handleCategoryClick}
                        highlightedCategory={!drilledCategoryRow && selectedCategory != null ? selectedCategory : null}
                      />
                    </>
                  )}
                </ChartPanel>
              </div>
            </div>
          ) : (
            <div className="ps-invoices-zone">
              <ChartPanel title="Customers Table" style={{ minHeight: 480 }}>
                {overview.loading ? (
                  <LoadingSkeleton variant="chart" />
                ) : overview.error ? (
                  <ErrorState message={overview.error} onRetry={overview.retry} />
                ) : (
                  <DataGrid columns={customerTableColumns} rows={tableRows} getRowId={(row) => String(row.customerKey)} fileName="customers-table" />
                )}
              </ChartPanel>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-3, 16px)' }}>
                <CustomerStatusPanel
                  counts={kpis?.customerStatus}
                  loading={overview.loading}
                  error={overview.error ?? undefined}
                  onRetry={overview.retry}
                  downloading={downloadingPdf === 'customerStatus'}
                  onDownloadPdf={() => handleDownloadTablePdf('customerStatus', 'Customer Status', periodCountTableColumns, customerStatusTableRows)}
                />

                <Card>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ps-color-text)', marginBottom: 'var(--ps-space-2, 8px)' }}>
                    Status Slicer
                  </div>
                  <Select
                    label="Customer Status"
                    options={STATUS_SLICER_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                    value={statusFilter ? [statusFilter] : []}
                    onChange={(v) => setStatusFilter((v[0] as CustomerStatusLabel) ?? null)}
                    multiSelect={false}
                  />
                </Card>

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

        <BottomNavBar active="Customer Growth" />
      </div>
    </PermissionGuard>
  );
}

// ---------------------------------------------------------------------------
// Customers Table columns (Details view) -- YTD Value sorts/exports on the raw number, displays
// formatted currency, same convention as every other DataGrid numeric column in this app.
// ---------------------------------------------------------------------------

interface CustomerTableGridRow extends Record<string, unknown> {
  customerKey: number;
  name: string;
  ytdValue: number;
  lastPurchaseDate: string;
  firstPurchaseDate: string;
  groupClass: string;
}

const customerTableColumns: DataGridColumn<CustomerTableGridRow>[] = [
  { key: 'name', header: 'Customer Name', width: 220 },
  { key: 'ytdValue', header: 'YTD Value', align: 'right', width: 140, render: (r) => formatCurrency(r.ytdValue), rawValue: (r) => r.ytdValue },
  { key: 'lastPurchaseDate', header: 'Last Purchase Date', width: 150 },
  { key: 'firstPurchaseDate', header: 'First Purchase Date', width: 150 },
  { key: 'groupClass', header: 'Customer Group / Class', width: 180 },
];

// ---------------------------------------------------------------------------
// Zone A -- "New Customers" / "Total Customers" 2x2 LYTD/YTD/LMTD/MTD panel.
// ---------------------------------------------------------------------------

function CountMetricPanel({
  title,
  infoText,
  counts,
  loading,
  error,
  onRetry,
  tableRows,
  downloading,
  onDownloadPdf,
}: {
  title: string;
  infoText?: string;
  counts?: CustomerGrowthPeriodCounts;
  loading: boolean;
  error?: string;
  onRetry: () => void;
  tableRows?: PeriodCountTableRow[];
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
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{title}</div>
        <ErrorState message={error} onRetry={onRetry} />
      </Card>
    );
  }

  const tiles = [
    { label: 'LYTD', value: counts?.lytd },
    { label: 'YTD', value: counts?.ytd },
    { label: 'LMTD', value: counts?.lmtd },
    { label: 'MTD', value: counts?.mtd },
  ];

  return (
    <Card style={{ width: '100%', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 'var(--ps-space-2, 8px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ps-color-text)' }}>{title}</span>
          {infoText && (
            <span title={infoText} aria-label={infoText} style={{ color: 'var(--ps-color-muted-text)', display: 'inline-flex', cursor: 'help', flexShrink: 0 }}>
              <Info size={13} />
            </span>
          )}
        </div>
        {onDownloadPdf && (
          <ExportPdfButton downloading={!!downloading} disabled={!tableRows || tableRows.length === 0} onClick={onDownloadPdf} />
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {tiles.map((t) => (
          <div
            key={t.label}
            style={{
              background: 'var(--ps-color-muted-bg)',
              borderRadius: 'var(--ps-card-radius-sm, 10px)',
              padding: '10px 8px',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--ps-color-text)', fontVariantNumeric: 'tabular-nums' }}>
              {formatCountOrDash(t.value)}
            </div>
            <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginTop: 2 }}>{t.label}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// "Customer Status" panel -- shared between Zone A (clickable title -> Details view) and the
// Details view's own header block (not clickable, kept visible for context while filtering).
// ---------------------------------------------------------------------------

const CUSTOMER_STATUS_INFO =
  'Active Retained: purchased YTD and LYTD. Non-Active: purchased LYTD, not YTD. Reactivated: purchased YTD, not LYTD, with purchase history before LYTD. Blocked: flagged in the operational system, independent of purchasing behavior.';

function CustomerStatusPanel({
  counts,
  loading,
  error,
  onRetry,
  onTitleClick,
  downloading,
  onDownloadPdf,
}: {
  counts?: CustomerStatusCounts;
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
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Customer Status</div>
        <ErrorState message={error} onRetry={onRetry} />
      </Card>
    );
  }

  const tiles = [
    { label: 'Active Retained', value: counts?.activeRetained },
    { label: 'Inactive / Non-Active', value: counts?.nonActive },
    { label: 'Blocked', value: counts?.blocked },
    { label: 'Reactivated', value: counts?.reactivated },
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
              title="View Customer Status details"
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
              Customer Status
            </span>
          ) : (
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ps-color-text)' }}>Customer Status</span>
          )}
          <span title={CUSTOMER_STATUS_INFO} aria-label={CUSTOMER_STATUS_INFO} style={{ color: 'var(--ps-color-muted-text)', display: 'inline-flex', cursor: 'help', flexShrink: 0 }}>
            <Info size={13} />
          </span>
        </div>
        {onDownloadPdf && (
          <ExportPdfButton downloading={!!downloading} disabled={!counts} onClick={onDownloadPdf} />
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {tiles.map((t) => (
          <div
            key={t.label}
            style={{
              background: 'var(--ps-color-muted-bg)',
              borderRadius: 'var(--ps-card-radius-sm, 10px)',
              padding: '10px 8px',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--ps-color-text)', fontVariantNumeric: 'tabular-nums' }}>
              {formatCountOrDash(t.value)}
            </div>
            <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginTop: 2 }}>{t.label}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Zone B (right) -- one Rate card. Acquisition/Growth get the alert/success good-bad treatment
// (negative = alert, same convention as Revenue Trend's VarianceCard); Retention/Churn have no
// defined threshold anywhere else in the app, so they render on the plain/neutral card surface.
// ---------------------------------------------------------------------------

function RateCard({
  label,
  pct,
  goodBadApplies,
  loading,
}: {
  label: string;
  pct: number | null;
  goodBadApplies: boolean;
  loading: boolean;
}) {
  const bad = goodBadApplies && pct != null && pct < 0;
  return (
    <InsightCard
      label={label}
      value={pct != null ? formatVariance(pct) ?? '—' : '—'}
      status={!goodBadApplies || pct == null ? 'neutral' : bad ? 'alert' : 'success'}
      accentBg={goodBadApplies && bad}
      loading={loading}
    />
  );
}

// ---------------------------------------------------------------------------
// Customers Category Performance chart's drill-down mode toggle -- identical shape/styling to
// Invoices Engine's own Sales Trend DrillToggle (bordered, muted-bg, 6px radius small header
// control), just re-labeled for this chart's Category -> Customer drill level.
// ---------------------------------------------------------------------------

function DrillToggle({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      title={
        active
          ? 'Drill-down mode on — click a category to break it out by customer'
          : 'Enable drill-down mode (Category → Customer)'
      }
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 11,
        fontWeight: 600,
        padding: '4px 9px',
        borderRadius: 6,
        border: `1px solid ${active ? 'var(--ps-color-accent)' : 'var(--ps-color-border)'}`,
        background: active ? 'var(--ps-color-accent-bg)' : 'var(--ps-color-muted-bg)',
        color: active ? 'var(--ps-color-accent)' : 'var(--ps-color-muted-text)',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      <Layers size={12} />
      Drill-down
    </button>
  );
}

// ---------------------------------------------------------------------------
// Customers Contribution donut's drill-down affordance -- same icon/label/sizing as DrillToggle
// above, but a static indicator rather than a mode toggle: the donut drills straight into Top 10 /
// Other on click already, with no separate enable-drill-mode step, so there's no on/off state for
// a button to control. This just signals the chart is clickable, matching Sales Trend's pattern.
// ---------------------------------------------------------------------------

function DrillIndicator({ hint }: { hint: string }) {
  return (
    <span
      title={hint}
      aria-label={hint}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 11,
        fontWeight: 600,
        padding: '4px 9px',
        borderRadius: 6,
        border: '1px solid var(--ps-color-border)',
        background: 'var(--ps-color-muted-bg)',
        color: 'var(--ps-color-muted-text)',
        cursor: 'help',
        whiteSpace: 'nowrap',
      }}
    >
      <Layers size={12} />
      Drill-down
    </span>
  );
}
