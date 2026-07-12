'use client';
import React, { useMemo, useState } from 'react';
import { ArrowLeft, Info } from 'lucide-react';
import { AppHeader } from '../../../../components/AppHeader';
import { FilterBar } from '../../../../components/FilterBar';
import { BottomNavBar } from '../../../../components/BottomNavBar';
import { ValidationStatusBar } from '../../../../components/ValidationStatusBar';
import { RefreshFooter } from '../../../../components/RefreshFooter';
import { useBusinessUnit } from '../../../../components/BusinessUnitProvider';
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
  type DataGridColumn,
} from '@07ps/ui';
import { useAuth } from '../../../../lib/AuthProvider';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useFilterOptions, useCustomerGrowthOverview, useRefreshStatus } from '../../../../lib/hooks';
import type {
  CustomerGrowthPeriodCounts,
  CustomerGrowthScope,
  CustomerStatusCounts,
  CustomerStatusLabel,
  TachometerFilters,
} from '../../../../lib/api';
import { formatCurrency, formatTimestamp, formatVariance } from '../../../../lib/format';

const todayIso = () => new Date().toISOString().slice(0, 10);

const EMPTY_FILTERS: TachometerFilters = {
  companyKeys: [],
  segmentKeys: [],
  channelKeys: [],
  salesTeamKeys: [],
  salespersonKeys: [],
};

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
 *      real backend re-query, re-scoping every other visual (including the Details view).
 *   2. Customers Contribution donut: clicking Top 10 / Other drills the chart itself into that
 *      bucket's individual customers -- purely local state, no re-fetch (the backend already
 *      returns the ranked customer list).
 *   3. Customers Category Performance bars: clicking a category drills into that category's
 *      customers -- same local-only, no-refetch pattern.
 */
export default function CustomerGrowthPage() {
  const { setBusinessUnit } = useBusinessUnit();
  const { user, isSalesperson, salespersonKey, token, error: authError, retryAuth, logout } = useAuth();
  const [anchorDate, setAnchorDate] = useState(todayIso());
  const [dateFromDate, setDateFromDate] = useState(todayIso());
  const [dateToDate, setDateToDate] = useState(todayIso());
  const [filters, setFilters] = useState<TachometerFilters>(EMPTY_FILTERS);

  const effectiveFilters = useMemo<TachometerFilters>(
    () => (isSalesperson ? { ...EMPTY_FILTERS, salespersonKeys: salespersonKey != null ? [salespersonKey] : [] } : filters),
    [isSalesperson, salespersonKey, filters],
  );

  const [view, setView] = useState<'summary' | 'details'>('summary');
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const [contributionDrill, setContributionDrill] = useState<'top10' | 'other' | null>(null);
  const [categoryDrill, setCategoryDrill] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<CustomerStatusLabel | null>(null);

  const scope: CustomerGrowthScope = { selectedYear };

  const filterOptions = useFilterOptions(token, authError, retryAuth);
  const overview = useCustomerGrowthOverview(token, anchorDate, effectiveFilters, scope, authError, retryAuth);
  const refreshStatus = useRefreshStatus(token, authError, retryAuth);

  function handleFiltersChange(next: TachometerFilters) {
    setFilters(next);
    const companyKeys = next.companyKeys ?? [];
    if (companyKeys.length === 1 && companyKeys[0] === 1) setBusinessUnit('majaal');
    else if (companyKeys.length === 1 && companyKeys[0] === 2) setBusinessUnit('tika');
    else setBusinessUnit('all');
  }

  function handleDateRangeChange(from: string, to: string) {
    setDateFromDate(from);
    setDateToDate(to);
    setAnchorDate(from);
  }

  function handleReset() {
    setFilters(EMPTY_FILTERS);
    setBusinessUnit('all');
    const today = todayIso();
    setAnchorDate(today);
    setDateFromDate(today);
    setDateToDate(today);
    setView('summary');
    setSelectedYear(null);
    setContributionDrill(null);
    setCategoryDrill(null);
    setStatusFilter(null);
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
    if (categoryDrill) return; // already drilled into one category -- no further level defined
    if (CATEGORY_LETTERS.has(label)) setCategoryDrill(label);
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

  const contribution = data?.customersContribution;
  const contributionCustomers = contribution?.customers ?? [];
  const top10 = contributionCustomers.slice(0, 10);
  const otherIndividual = contributionCustomers.slice(10);
  const top10Total = top10.reduce((sum, c) => sum + c.value, 0);
  const otherTotal = otherIndividual.reduce((sum, c) => sum + c.value, 0) + (contribution?.remainderValue ?? 0);

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
          ...(contribution && contribution.remainderCount > 0
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
    .map((r) => ({
      customerKey: r.customerKey,
      name: r.name,
      ytdValue: r.ytdValue,
      lastPurchaseDate: r.lastPurchaseDate ?? '—',
      firstPurchaseDate: r.firstPurchaseDate ?? '—',
      groupClass: `${r.customerSegment ?? '—'} / ${r.customerClass ?? '—'}`,
    }));

  return (
    <PermissionGuard pageKey="customer_growth">
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', paddingBottom: 64 }}>
        <AppHeader
          pageTitle="Sales Executive Dashboard"
          anchorDate={anchorDate}
          onAnchorDateChange={setAnchorDate}
          onRefresh={handleRefresh}
          lastRefreshTime={lastRefreshLabel}
          roleLabel={roleLabel}
          onLogout={logout}
          showDateInput={false}
        />

        <FilterBar
          filters={effectiveFilters}
          onChange={handleFiltersChange}
          onReset={handleReset}
          anchorDate={anchorDate}
          onAnchorDateChange={setAnchorDate}
          businessUnits={filterOptions.businessUnits.data ?? []}
          customerGroups={filterOptions.customerGroups.data ?? []}
          distributionChannels={filterOptions.distributionChannels.data ?? []}
          branches={filterOptions.branches.data ?? []}
          salespersons={filterOptions.salespersons.data ?? []}
          isSalesperson={isSalesperson}
          lastRefreshTime={refreshStatus.data?.lastRefreshTime ?? null}
          dateFromDate={dateFromDate}
          dateToDate={dateToDate}
          onDateRangeChange={handleDateRangeChange}
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
                />
                <CountMetricPanel
                  title="Total Customers"
                  infoText="Number of distinct customers who generated sales within each timeframe."
                  counts={kpis?.totalCustomers}
                  loading={overview.loading}
                  error={overview.error ?? undefined}
                  onRetry={overview.retry}
                />
                <CustomerStatusPanel
                  counts={kpis?.customerStatus}
                  loading={overview.loading}
                  error={overview.error ?? undefined}
                  onRetry={overview.retry}
                  onTitleClick={() => setView('details')}
                />
              </div>

              {/* Zone B -- Customers Trend (left) + Rates (right) */}
              <div className="ps-invoices-zone">
                <ChartPanel
                  title="Customers Trend"
                  infoText="Total Sales Value and Customer Count by year. Click a year to set it as the page's active filter; click it again to clear."
                  style={{ minHeight: 380 }}
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

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(2, 1fr)',
                    gridTemplateRows: 'repeat(2, 1fr)',
                    gap: 'var(--ps-space-3, 16px)',
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

              {/* Zone C -- Customers Contribution (left) + Customers Category Performance (right) */}
              <div className="ps-invoices-zone">
                <ChartPanel title="Customers Contribution" infoText="Share of total sales value contributed by the Top 10 customers vs. every other customer, year-to-date." style={{ minHeight: 380 }}>
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

                <ChartPanel title="Customers Category Performance" infoText="Sales LYTD vs. Sales YTD by Customer Category (A highest value - D lowest). Click a category to see its individual customers." style={{ minHeight: 380 }}>
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
}: {
  title: string;
  infoText?: string;
  counts?: CustomerGrowthPeriodCounts;
  loading: boolean;
  error?: string;
  onRetry: () => void;
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 'var(--ps-space-2, 8px)' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ps-color-text)' }}>{title}</span>
        {infoText && (
          <span title={infoText} aria-label={infoText} style={{ color: 'var(--ps-color-muted-text)', display: 'inline-flex', cursor: 'help' }}>
            <Info size={13} />
          </span>
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
}: {
  counts?: CustomerStatusCounts;
  loading: boolean;
  error?: string;
  onRetry: () => void;
  onTitleClick?: () => void;
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 'var(--ps-space-2, 8px)' }}>
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
        <span title={CUSTOMER_STATUS_INFO} aria-label={CUSTOMER_STATUS_INFO} style={{ color: 'var(--ps-color-muted-text)', display: 'inline-flex', cursor: 'help' }}>
          <Info size={13} />
        </span>
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
