'use client';
import React, { useMemo, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
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
  FunnelChart,
  GroupedBarChart,
  DataTable,
  Button,
  ProgressBar,
  SemanticBadge,
  LoadingSkeleton,
  ErrorState,
  type Column,
} from '@07ps/ui';
import { useAuth } from '../../../../lib/AuthProvider';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useFilterOptions, usePipelineHealthOverview, useRefreshStatus } from '../../../../lib/hooks';
import type { OpportunityDetailRow, StageBenchmarkRow, TachometerFilters } from '../../../../lib/api';
import { formatCurrency, formatTimestamp, toSemanticStatus } from '../../../../lib/format';

const todayIso = () => new Date().toISOString().slice(0, 10);

const EMPTY_FILTERS: TachometerFilters = {
  companyKeys: [],
  segmentKeys: [],
  channelKeys: [],
  salesTeamKeys: [],
  salespersonKeys: [],
};

const FUNNEL_COLORS = ['var(--ps-color-accent)', 'var(--ps-color-gold)', 'var(--ps-color-success)', 'var(--ps-color-watch)', 'var(--ps-color-alert)'];
const CATEGORY_PALETTE = [
  'var(--ps-color-accent)',
  'var(--ps-color-success)',
  'var(--ps-color-gold)',
  'var(--ps-color-watch)',
  'var(--ps-color-alert)',
  'var(--ps-color-last-year)',
  'var(--ps-color-neutral-text)',
];

function formatMillions(value: number): string {
  const fixed = (value / 1_000_000).toFixed(1);
  return `${fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed}M`;
}

function formatPlainNumber(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function formatPct(v: number | null): string {
  return v != null ? `${(v * 100).toFixed(1)}%` : '—';
}

type DetailsFilter = { type: 'month' | 'stage' | 'bucket'; value: string } | null;

interface OpportunityTableRow extends Record<string, unknown> {
  opportunityId: string;
  name: string;
  customer: string;
  company: string;
  expectedRevenue: number;
  salesperson: string;
  stage: string;
  createdDate: string;
}

const opportunityColumns: Column<OpportunityTableRow>[] = [
  { key: 'name', header: 'Opportunity Name' },
  { key: 'customer', header: 'Customer' },
  { key: 'company', header: 'Company' },
  { key: 'expectedRevenue', header: 'Expected Revenue', align: 'right', render: (r) => formatCurrency(r.expectedRevenue) },
  { key: 'salesperson', header: 'Salesperson' },
  { key: 'stage', header: 'Stage' },
  { key: 'createdDate', header: 'Created Date' },
];

function toTableRow(o: OpportunityDetailRow): OpportunityTableRow {
  return {
    opportunityId: o.opportunityId,
    name: o.name || '—',
    customer: o.customer ?? '—',
    company: o.company ?? '—',
    expectedRevenue: o.expectedRevenue,
    salesperson: o.salesperson ?? '—',
    stage: o.stage ?? '—',
    createdDate: o.createdDate ?? '—',
  };
}

function matchesFilter(o: OpportunityDetailRow, filter: DetailsFilter): boolean {
  if (!filter) return true;
  if (filter.type === 'month') return o.expectedCloseMonth === filter.value;
  if (filter.type === 'stage') return (o.stage ?? 'Unspecified') === filter.value;
  return o.probabilityBucket === filter.value;
}

function detailsFilterLabel(filter: DetailsFilter): string {
  if (!filter) return '';
  if (filter.type === 'month') return `Expected to close in ${filter.value}`;
  if (filter.type === 'stage') return `Stage: ${filter.value}`;
  return `Probability: ${filter.value}`;
}

/**
 * Pipeline Health page (Sales, Level 3) -- sixth live Sales page, first to consume CRM/pipeline
 * data (Fact_Lead/Fact_Opportunity/Fact_Sales/Fact_Delivery) rather than the sales-revenue facts
 * every prior page reads. Same architecture as every other page (AppHeader + FilterBar +
 * ValidationStatusBar + BottomNavBar, PermissionGuard pageKey='pipeline_health'). Unlike every
 * other page, this one has no anchorDate-scoped figures at all -- see
 * backend/src/measures/pipelineHealth.ts's header comment for why the funnel/benchmark are
 * deliberately all-time, not YTD.
 *
 * One shared Details view, reached by clicking any of the 3 drillable Summary visuals (a month bar
 * in Expected Closure Opportunity, a stage segment in Opportunity by Stage, or a probability bucket
 * bar in Probabilities Distribution) -- `detailsFilter` records which one, and the Details view's
 * table narrows to just that slice of the shared Opportunity Details array.
 */
export default function PipelineHealthPage() {
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
  const [detailsFilter, setDetailsFilter] = useState<DetailsFilter>(null);

  const filterOptions = useFilterOptions(token, authError, retryAuth);
  const overview = usePipelineHealthOverview(token, effectiveFilters, authError, retryAuth);
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
    setDetailsFilter(null);
  }

  function handleRefresh() {
    overview.retry();
    refreshStatus.retry();
  }

  function openDetails(filter: DetailsFilter) {
    setDetailsFilter(filter);
    setView('details');
  }

  function handleBackToSummary() {
    setView('summary');
    setDetailsFilter(null);
  }

  const roleLabel = user?.role.label ?? user?.fullName;
  const lastRefreshLabel = refreshStatus.data ? formatTimestamp(refreshStatus.data.lastRefreshTime) : undefined;

  const data = overview.data;

  const funnelStages = data
    ? [
        { id: 'leads', label: 'Leads', value: data.funnel.leads, color: FUNNEL_COLORS[0] },
        { id: 'opportunities', label: 'Opportunities', value: data.funnel.opportunities, color: FUNNEL_COLORS[1] },
        { id: 'quotations', label: 'Quotations', value: data.funnel.quotations, color: FUNNEL_COLORS[2] },
        { id: 'salesOrders', label: 'Sales Orders', value: data.funnel.salesOrders, color: FUNNEL_COLORS[3] },
        { id: 'deliveries', label: 'Deliveries', value: data.funnel.deliveries, color: FUNNEL_COLORS[4] },
      ]
    : [];

  const closurePoints = (data?.expectedClosureByMonth ?? []).map((p) => ({
    label: p.label,
    expectedCount: p.expectedCount,
    expectedValue: p.expectedValue,
  }));

  const stageSegments = (data?.opportunityByStage ?? []).map((s, i) => ({
    id: s.stage,
    label: s.stage,
    value: s.value,
    color: CATEGORY_PALETTE[i % CATEGORY_PALETTE.length],
  }));

  const probabilityPoints = (data?.probabilityDistribution ?? []).map((p) => ({ label: p.bucket, count: p.count }));

  const filteredOpportunities = (data?.opportunities ?? []).filter((o) => matchesFilter(o, detailsFilter)).map(toTableRow);

  return (
    <PermissionGuard pageKey="pipeline_health">
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
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--ps-space-3, 16px)' }}>
              {/* Top-left -- Full Pipeline Funnel + Stage Benchmark */}
              <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 'var(--ps-space-3, 16px)' }}>
                <ChartPanel title="Full Pipeline" style={{ minHeight: 380 }}>
                  {overview.loading ? (
                    <LoadingSkeleton variant="chart" />
                  ) : overview.error ? (
                    <ErrorState message={overview.error} onRetry={overview.retry} />
                  ) : (
                    <FunnelChart title="Full Pipeline" showTitle={false} stages={funnelStages} />
                  )}
                </ChartPanel>

                <Card style={{ width: '100%', height: '100%' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ps-color-text)', marginBottom: 'var(--ps-space-2, 8px)' }}>
                    Stage Benchmark
                  </div>
                  {overview.loading ? (
                    <LoadingSkeleton variant="kpi" />
                  ) : overview.error ? (
                    <ErrorState message={overview.error} onRetry={overview.retry} />
                  ) : (
                    (data?.stageBenchmark ?? []).map((row) => <BenchmarkRow key={row.transition} row={row} />)
                  )}
                </Card>
              </div>

              {/* Top-right -- Expected Closure Opportunity */}
              <ChartPanel
                title="Expected Closure Opportunity"
                infoText="Expected Opportunity Count and Value by expected closure month. Click a month to see those opportunities."
                style={{ minHeight: 380 }}
              >
                {overview.loading ? (
                  <LoadingSkeleton variant="chart" />
                ) : overview.error ? (
                  <ErrorState message={overview.error} onRetry={overview.retry} />
                ) : (
                  <ComboChart
                    title="Expected Closure Opportunity"
                    showTitle={false}
                    points={closurePoints}
                    bars={[{ key: 'expectedCount', name: 'Expected Opportunity Count', color: 'var(--ps-color-accent)' }]}
                    lines={[{ key: 'expectedValue', name: 'Expected Opportunity Value', color: 'var(--ps-color-last-year)', yAxisId: 'right' }]}
                    leftAxisFormatter={formatPlainNumber}
                    rightAxisFormatter={formatMillions}
                    tooltipFormatters={{
                      expectedCount: (v) => v.toLocaleString(),
                      expectedValue: (v) => formatCurrency(v),
                    }}
                    onCategoryClick={(label) => openDetails({ type: 'month', value: label })}
                  />
                )}
              </ChartPanel>

              {/* Bottom-left -- Opportunity by Stage */}
              <ChartPanel title="Opportunity by Stage" style={{ minHeight: 380 }}>
                {overview.loading ? (
                  <LoadingSkeleton variant="chart" />
                ) : overview.error ? (
                  <ErrorState message={overview.error} onRetry={overview.retry} />
                ) : (
                  <DonutChart
                    title="Opportunity by Stage"
                    showTitle={false}
                    segments={stageSegments}
                    valueFormatter={(v) => formatCurrency(v)}
                    legendTitle="Stage"
                    onSegmentClick={(id) => openDetails({ type: 'stage', value: id })}
                  />
                )}
              </ChartPanel>

              {/* Bottom-right -- Probabilities Distribution */}
              <ChartPanel
                title="Probabilities Distribution"
                infoText="Open opportunity count by probability bucket (10-90%). Click a bucket to see those opportunities."
                style={{ minHeight: 380 }}
              >
                {overview.loading ? (
                  <LoadingSkeleton variant="chart" />
                ) : overview.error ? (
                  <ErrorState message={overview.error} onRetry={overview.retry} />
                ) : (
                  <GroupedBarChart
                    title="Probabilities Distribution"
                    showTitle={false}
                    points={probabilityPoints}
                    bars={[{ key: 'count', name: 'Opportunities', color: 'var(--ps-color-accent)' }]}
                    valueFormatter={formatPlainNumber}
                    tooltipFormatters={{ count: (v) => v.toLocaleString() }}
                    onCategoryClick={(label) => openDetails({ type: 'bucket', value: label })}
                  />
                )}
              </ChartPanel>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-3, 16px)' }}>
              <ChartPanel title={`Opportunity Details${detailsFilter ? ` — ${detailsFilterLabel(detailsFilter)}` : ''}`} style={{ minHeight: 480 }}>
                {overview.loading ? (
                  <LoadingSkeleton variant="chart" />
                ) : overview.error ? (
                  <ErrorState message={overview.error} onRetry={overview.retry} />
                ) : (
                  <DataTable columns={opportunityColumns} rows={filteredOpportunities} getRowId={(row) => row.opportunityId} />
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
          lastRefreshTime={formatTimestamp(refreshStatus.data?.lastRefreshTime ?? null)}
        />

        <BottomNavBar active="Pipeline Health" />
      </div>
    </PermissionGuard>
  );
}

// ---------------------------------------------------------------------------
// Stage Benchmark row -- actual vs target %, reusing ProgressBar + SemanticBadge exactly as
// everywhere else in this app (both driven by the same classifyVsTarget result).
// ---------------------------------------------------------------------------

function BenchmarkRow({ row }: { row: StageBenchmarkRow }) {
  const status = toSemanticStatus(row.status);
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ps-color-text)' }}>{row.transition}</span>
        <SemanticBadge status={status} />
      </div>
      <ProgressBar actual={row.actualPct ?? 0} targetToDate={row.targetPct} status={status} label={`${row.transition}: ${formatPct(row.actualPct)} of ${formatPct(row.targetPct)} target`} />
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 11, color: 'var(--ps-color-muted-text)' }}>
        <span>Actual: {formatPct(row.actualPct)}</span>
        <span>Target: {formatPct(row.targetPct)}</span>
      </div>
    </div>
  );
}
