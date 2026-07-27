'use client';
import React, { useState } from 'react';
import { ArrowLeft, FileDown, Layers } from 'lucide-react';
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
  FunnelChart,
  GroupedBarChart,
  DataTable,
  Button,
  ProgressBar,
  SemanticBadge,
  LoadingSkeleton,
  ErrorState,
  exportRowsAsPdf,
  type Column,
} from '@07ps/ui';
import { useAuth } from '../../../../lib/AuthProvider';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useFilterOptions, usePipelineHealthOverview, useRefreshStatus, useExportOverviewReport } from '../../../../lib/hooks';
import type {
  FunnelDeliveryRecord,
  FunnelOpportunityIds,
  FunnelSalesRecord,
  FunnelStageRecords,
  OpportunityDetailRow,
  StageBenchmarkRow,
} from '../../../../lib/api';
import { formatCurrency, formatTimestamp, toSemanticStatus } from '../../../../lib/format';

// Fixed: --ps-color-watch previously reused here shares the exact same hex as --ps-color-gold
// (#b8860b), so Quotations and Deliveries rendered as indistinguishable brownish-gold trapezoids/
// legend dots. --ps-color-trend-target (a distinct purple, already used for "Target" series
// elsewhere) replaces it with a genuinely distinct 4th hue.
const FUNNEL_COLORS = ['var(--ps-color-accent)', 'var(--ps-color-gold)', 'var(--ps-color-success)', 'var(--ps-color-trend-target)'];
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

type DetailsFilter = { type: 'month' | 'stage' | 'bucket' | 'funnelStage'; value: string } | null;

const FUNNEL_STAGE_LABELS: Record<string, string> = {
  leads: 'Leads',
  opportunities: 'Opportunities',
  quotations: 'Quotations',
  salesOrders: 'Sales Orders',
  deliveries: 'Deliveries',
};

interface OpportunityTableRow extends Record<string, unknown> {
  opportunityId: string;
  name: string;
  customer: string;
  company: string;
  stage: string;
  probability: string;
  expectedCloseDate: string;
  expectedRevenue: number;
  salesperson: string;
  createdDate: string;
}

const opportunityColumns: Column<OpportunityTableRow>[] = [
  { key: 'name', header: 'Opportunity Name' },
  { key: 'stage', header: 'Stage' },
  { key: 'probability', header: 'Probability %' },
  { key: 'expectedCloseDate', header: 'Expected Close Date' },
  { key: 'expectedRevenue', header: 'Value', align: 'right', render: (r) => formatCurrency(r.expectedRevenue) },
  { key: 'customer', header: 'Customer' },
  { key: 'company', header: 'Company' },
  { key: 'salesperson', header: 'Salesperson' },
  { key: 'createdDate', header: 'Created Date' },
];

function toTableRow(o: OpportunityDetailRow): OpportunityTableRow {
  return {
    opportunityId: o.opportunityId,
    name: o.name || '—',
    customer: o.customer ?? '—',
    company: o.company ?? '—',
    stage: o.stage ?? '—',
    probability: o.probabilityBucket ?? '—',
    expectedCloseDate: o.expectedCloseDate ?? '—',
    expectedRevenue: o.expectedRevenue,
    salesperson: o.salesperson ?? '—',
    createdDate: o.createdDate ?? '—',
  };
}

// ---------------------------------------------------------------------------
// Funnel stage records (Quotations / Sales Orders / Deliveries) -- these 3 stages now drill down
// into their own real records (see backend/src/measures/pipelineHealth.ts's FunnelStageRecords),
// not a resolved-back list of Opportunities. Quotations and Sales Orders share the same Fact_Sales-
// derived shape; Deliveries comes from Fact_Delivery and has its own.
// ---------------------------------------------------------------------------

type StageRecordKind = 'quotations' | 'salesOrders' | 'deliveries';

function isStageRecordKind(id: string): id is StageRecordKind {
  return id === 'quotations' || id === 'salesOrders' || id === 'deliveries';
}

function getStageRecords(kind: StageRecordKind, records?: FunnelStageRecords): (FunnelSalesRecord | FunnelDeliveryRecord)[] {
  if (!records) return [];
  return records[kind];
}

interface StageSalesTableRow extends Record<string, unknown> {
  id: string;
  orderNumber: string;
  customer: string;
  company: string;
  salesperson: string;
  documentDate: string;
  value: number;
}

const stageSalesColumns: Column<StageSalesTableRow>[] = [
  { key: 'orderNumber', header: 'Order Number' },
  { key: 'documentDate', header: 'Date' },
  { key: 'value', header: 'Value', align: 'right', render: (r) => formatCurrency(r.value) },
  { key: 'customer', header: 'Customer' },
  { key: 'company', header: 'Company' },
  { key: 'salesperson', header: 'Salesperson' },
];

function toStageSalesRows(records: FunnelSalesRecord[]): StageSalesTableRow[] {
  return records.map((r, i) => ({
    id: `${r.orderNumber || 'row'}-${i}`,
    orderNumber: r.orderNumber || '—',
    customer: r.customer ?? '—',
    company: r.company ?? '—',
    salesperson: r.salesperson ?? '—',
    documentDate: r.documentDate ?? '—',
    value: r.value,
  }));
}

interface StageDeliveryTableRow extends Record<string, unknown> {
  id: string;
  orderNumber: string;
  customer: string;
  company: string;
  salesperson: string;
  orderDate: string;
  deliveryStatus: string;
}

const stageDeliveryColumns: Column<StageDeliveryTableRow>[] = [
  { key: 'orderNumber', header: 'Order Number' },
  { key: 'orderDate', header: 'Order Date' },
  { key: 'deliveryStatus', header: 'Status' },
  { key: 'customer', header: 'Customer' },
  { key: 'company', header: 'Company' },
  { key: 'salesperson', header: 'Salesperson' },
];

function toStageDeliveryRows(records: FunnelDeliveryRecord[]): StageDeliveryTableRow[] {
  return records.map((r, i) => ({
    id: `${r.orderNumber || 'row'}-${i}`,
    orderNumber: r.orderNumber ?? '—',
    customer: r.customer ?? '—',
    company: r.company ?? '—',
    salesperson: r.salesperson ?? '—',
    orderDate: r.orderDate ?? '—',
    deliveryStatus: r.deliveryStatus ?? '—',
  }));
}

/** Same "resolve each column's formatted string, falling back to the render function" convention
 * already used inline for the Opportunity Details PDF export -- factored out so the new stage-
 * record PDF exports (linked and "with no Opportunities") can reuse it too. */
function rowsToPdfRows<T extends Record<string, unknown>>(columns: Column<T>[], rows: T[]): string[][] {
  return rows.map((row) => columns.map((c) => (c.render ? String(c.render(row)) : String(row[c.key] ?? ''))));
}

/** Month/bucket drill-downs (Expected Closure / Probabilities Distribution) additionally require
 * `isOpen`, matching those charts' own Won/Lost-exclusion at the API level (see
 * backend/src/measures/pipelineHealth.ts's Won/Lost-exclusion policy). Stage does NOT require it --
 * Opportunity by Stage is the page's one deliberate exception that keeps Won/Lost. funnelStage
 * matches by an ID list that's already IsOpen-scoped at the query level, so no extra check needed
 * there either. */
// ---------------------------------------------------------------------------
// Summary-view chart PDF exports -- same exportRowsAsPdf mechanism as the drill-down tables above
// and as Revenue Trend's per-chart tables, applied to the 4 summary charts + Stage Benchmark. Each
// chart's table rows are the exact same data already driving the chart, so the "expand to table"
// view and the PDF export can never disagree.
// ---------------------------------------------------------------------------

interface FunnelTableRow extends Record<string, unknown> {
  id: string;
  stage: string;
  count: number;
  value: number;
}
const funnelTableColumns: Column<FunnelTableRow>[] = [
  { key: 'stage', header: 'Stage' },
  { key: 'count', header: 'Count', align: 'right' },
  { key: 'value', header: 'Value', align: 'right', render: (r) => formatCurrency(r.value) },
];

interface BenchmarkTableRow extends Record<string, unknown> {
  id: string;
  transition: string;
  actualPct: string;
  targetPct: string;
}
const benchmarkTableColumns: Column<BenchmarkTableRow>[] = [
  { key: 'transition', header: 'Transition' },
  { key: 'actualPct', header: 'Actual %', align: 'right' },
  { key: 'targetPct', header: 'Target %', align: 'right' },
];

interface ClosureTableRow extends Record<string, unknown> {
  id: string;
  month: string;
  expectedCount: number;
  expectedValue: number;
}
const closureTableColumns: Column<ClosureTableRow>[] = [
  { key: 'month', header: 'Month' },
  { key: 'expectedCount', header: 'Expected Count', align: 'right' },
  { key: 'expectedValue', header: 'Expected Value', align: 'right', render: (r) => formatCurrency(r.expectedValue) },
];

interface StageValueTableRow extends Record<string, unknown> {
  id: string;
  stage: string;
  value: number;
}
const stageValueTableColumns: Column<StageValueTableRow>[] = [
  { key: 'stage', header: 'Stage' },
  { key: 'value', header: 'Value', align: 'right', render: (r) => formatCurrency(r.value) },
];

interface ProbabilityTableRow extends Record<string, unknown> {
  id: string;
  bucket: string;
  count: number;
}
const probabilityTableColumns: Column<ProbabilityTableRow>[] = [
  { key: 'bucket', header: 'Probability Bucket' },
  { key: 'count', header: 'Opportunities', align: 'right' },
];

function matchesFilter(o: OpportunityDetailRow, filter: DetailsFilter, funnelIds?: FunnelOpportunityIds): boolean {
  if (!filter) return true;
  if (filter.type === 'month') return o.isOpen && o.expectedCloseMonth === filter.value;
  if (filter.type === 'stage') return (o.stage ?? 'Unspecified') === filter.value;
  if (filter.type === 'funnelStage') {
    const ids = funnelIds?.[filter.value as keyof FunnelOpportunityIds];
    return ids != null && ids.includes(o.opportunityId);
  }
  return o.isOpen && o.probabilityBucket === filter.value;
}

function detailsFilterLabel(filter: DetailsFilter): string {
  if (!filter) return '';
  if (filter.type === 'month') return `Expected to close in ${filter.value}`;
  if (filter.type === 'stage') return `Stage: ${filter.value}`;
  if (filter.type === 'funnelStage') return `Full Pipeline: ${FUNNEL_STAGE_LABELS[filter.value] ?? filter.value}`;
  return `Probability: ${filter.value}`;
}

/** Widget name + active-filter-value pair for the drill-down table's PDF export header -- distinct
 * from detailsFilterLabel (which reads as a full sentence for the on-screen panel title): the PDF
 * wants "<Widget Name> — <filter value>" (e.g. "Opportunity by Stage — Qualified"), not the
 * sentence form. */
function widgetNameForFilter(filter: DetailsFilter): string {
  if (!filter) return 'Opportunity Details';
  if (filter.type === 'month') return 'Expected Closure Opportunity';
  if (filter.type === 'stage') return 'Opportunity by Stage';
  if (filter.type === 'funnelStage') return 'Full Pipeline';
  return 'Probabilities Distribution';
}

function filterValueForPdf(filter: DetailsFilter): string | undefined {
  if (!filter) return undefined;
  if (filter.type === 'funnelStage') return FUNNEL_STAGE_LABELS[filter.value] ?? filter.value;
  return filter.value;
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

  const [view, setView] = useState<'summary' | 'details' | 'stageRecords'>('summary');
  const [detailsFilter, setDetailsFilter] = useState<DetailsFilter>(null);
  const [stageRecordKind, setStageRecordKind] = useState<StageRecordKind | null>(null);
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [downloadingStagePdf, setDownloadingStagePdf] = useState<'linked' | 'unlinked' | null>(null);
  const [downloadingChartPdf, setDownloadingChartPdf] = useState<string | null>(null);

  const filterOptions = useFilterOptions(token, authError, retryAuth);
  const overview = usePipelineHealthOverview(token, effectiveFilters, authError, retryAuth);
  const refreshStatus = useRefreshStatus(token, authError, retryAuth);
  const exportReport = useExportOverviewReport(token, anchorDate, effectiveFilters);

  function handleReset() {
    resetFilters();
    setView('summary');
    setDetailsFilter(null);
    setStageRecordKind(null);
  }

  function handleRefresh() {
    overview.retry();
    refreshStatus.retry();
  }

  function openDetails(filter: DetailsFilter) {
    setDetailsFilter(filter);
    setView('details');
  }

  /** Opportunities still routes to the shared Opportunity Details view (unchanged); Quotations/
   * Sales Orders/Deliveries route to the new stage-records view instead, since those now show the
   * stage's own real records rather than a resolved-back list of Opportunities. */
  function handleFunnelStageClick(id: string) {
    if (isStageRecordKind(id)) {
      setStageRecordKind(id);
      setView('stageRecords');
    } else {
      openDetails({ type: 'funnelStage', value: id });
    }
  }

  function handleBackToSummary() {
    setView('summary');
    setDetailsFilter(null);
    setStageRecordKind(null);
  }

  const roleLabel = user?.role.label ?? user?.fullName;
  const lastRefreshLabel = refreshStatus.data ? formatTimestamp(refreshStatus.data.lastRefreshTime) : undefined;

  const data = overview.data;

  // Leads deliberately excluded from this visual (per the B2B/YTD "Full Pipeline" spec, the
  // pipeline starts at Opportunities) -- Stage Benchmark's own "Lead -> Opportunity" row still
  // covers that transition separately, unaffected by this.
  const funnelStages = data
    ? [
        { id: 'opportunities', label: 'Opportunities', value: data.funnel.opportunities, secondaryValue: data.funnelValues.opportunities, color: FUNNEL_COLORS[0] },
        { id: 'quotations', label: 'Quotations', value: data.funnel.quotations, secondaryValue: data.funnelValues.quotations, color: FUNNEL_COLORS[1] },
        { id: 'salesOrders', label: 'Sales Orders', value: data.funnel.salesOrders, secondaryValue: data.funnelValues.salesOrders, color: FUNNEL_COLORS[2] },
        { id: 'deliveries', label: 'Deliveries', value: data.funnel.deliveries, secondaryValue: data.funnelValues.deliveries, color: FUNNEL_COLORS[3] },
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

  const filteredOpportunities = (data?.opportunities ?? [])
    .filter((o) => matchesFilter(o, detailsFilter, data?.funnelOpportunityIds))
    .map(toTableRow);

  const funnelTableRows: FunnelTableRow[] = funnelStages.map((s) => ({ id: s.id, stage: s.label, count: s.value, value: s.secondaryValue ?? 0 }));
  const benchmarkTableRows: BenchmarkTableRow[] = (data?.stageBenchmark ?? []).map((row) => ({
    id: row.transition,
    transition: row.transition,
    actualPct: formatPct(row.actualPct),
    targetPct: formatPct(row.targetPct),
  }));
  const closureTableRows: ClosureTableRow[] = closurePoints.map((p) => ({ id: p.label, month: p.label, expectedCount: p.expectedCount, expectedValue: p.expectedValue }));
  const stageValueTableRows: StageValueTableRow[] = stageSegments.map((s) => ({ id: s.id, stage: s.label, value: s.value }));
  const probabilityTableRows: ProbabilityTableRow[] = probabilityPoints.map((p) => ({ id: p.label, bucket: p.label, count: p.count }));

  async function handleDownloadChartPdf<T extends Record<string, unknown>>(key: string, title: string, columns: Column<T>[], rows: T[]) {
    setDownloadingChartPdf(key);
    try {
      await exportRowsAsPdf({
        title,
        columns: columns.map((c) => ({ header: c.header, align: c.align })),
        rows: rowsToPdfRows(columns, rows),
        fileName: title.toLowerCase().replace(/\s+/g, '-'),
      });
    } finally {
      setDownloadingChartPdf(null);
    }
  }

  async function handleDownloadPdf() {
    setDownloadingPdf(true);
    try {
      await exportRowsAsPdf({
        title: widgetNameForFilter(detailsFilter),
        subtitle: filterValueForPdf(detailsFilter),
        columns: opportunityColumns.map((c) => ({ header: c.header, align: c.align })),
        rows: rowsToPdfRows(opportunityColumns, filteredOpportunities),
        fileName: `${widgetNameForFilter(detailsFilter).toLowerCase().replace(/\s+/g, '-')}-opportunities`,
      });
    } finally {
      setDownloadingPdf(false);
    }
  }

  const isDeliveryStage = stageRecordKind === 'deliveries';
  const activeStageRecords = stageRecordKind ? getStageRecords(stageRecordKind, data?.funnelStageRecords) : [];
  const linkedStageRecords = activeStageRecords.filter((r) => r.opportunityId != null);
  const unlinkedStageRecords = activeStageRecords.filter((r) => r.opportunityId == null);
  const linkedStageRows = isDeliveryStage
    ? toStageDeliveryRows(linkedStageRecords as FunnelDeliveryRecord[])
    : toStageSalesRows(linkedStageRecords as FunnelSalesRecord[]);
  const stageColumns = isDeliveryStage ? stageDeliveryColumns : stageSalesColumns;

  /** `linked` picks which subset gets exported: the same records shown in the drill-down table
   * (true), or the "with no Opportunities" set the table deliberately excludes (false). */
  async function handleDownloadStagePdf(linked: boolean) {
    if (!stageRecordKind) return;
    const label = FUNNEL_STAGE_LABELS[stageRecordKind];
    const subset = linked ? linkedStageRecords : unlinkedStageRecords;
    const rows = isDeliveryStage ? toStageDeliveryRows(subset as FunnelDeliveryRecord[]) : toStageSalesRows(subset as FunnelSalesRecord[]);
    setDownloadingStagePdf(linked ? 'linked' : 'unlinked');
    try {
      await exportRowsAsPdf({
        title: linked ? label : `${label} with no Opportunities`,
        columns: stageColumns.map((c) => ({ header: c.header, align: c.align })),
        rows: rowsToPdfRows(stageColumns as Column<Record<string, unknown>>[], rows),
        fileName: linked ? `${label.toLowerCase().replace(/\s+/g, '-')}` : `${label.toLowerCase().replace(/\s+/g, '-')}-no-opportunities`,
      });
    } finally {
      setDownloadingStagePdf(null);
    }
  }

  return (
    <PermissionGuard pageKey="pipeline_health">
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
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--ps-space-3, 16px)' }}>
              {/* Top-left -- Full Pipeline Funnel + Stage Benchmark */}
              <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 'var(--ps-space-3, 16px)' }}>
                <ChartPanel<FunnelTableRow>
                  title="Full Pipeline"
                  infoText="Opportunities → Quotations → Sales Orders → Deliveries (B2B, YTD). Hover a stage for its count and value; click a stage to see the underlying opportunities."
                  style={{ minHeight: 380 }}
                  tableColumns={overview.error ? undefined : funnelTableColumns}
                  tableRows={overview.error ? undefined : funnelTableRows}
                  getRowId={(row) => row.id}
                  headerActions={
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <DrillIndicator hint="Click a stage to see its underlying opportunities" />
                      {!overview.error && (
                        <PdfButton
                          label="Export as PDF"
                          downloading={downloadingChartPdf === 'funnel'}
                          disabled={funnelTableRows.length === 0}
                          onClick={() => handleDownloadChartPdf('funnel', 'Full Pipeline', funnelTableColumns, funnelTableRows)}
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
                    <FunnelChart
                      title="Full Pipeline"
                      showTitle={false}
                      stages={funnelStages}
                      secondaryValueFormatter={(v) => formatCurrency(v)}
                      onStageClick={handleFunnelStageClick}
                    />
                  )}
                </ChartPanel>

                <Card style={{ width: '100%', height: '100%' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--ps-space-2, 8px)', gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ps-color-text)' }}>Stage Benchmark</span>
                    {!overview.error && (
                      <PdfButton
                        label="Export as PDF"
                        downloading={downloadingChartPdf === 'benchmark'}
                        disabled={benchmarkTableRows.length === 0}
                        onClick={() => handleDownloadChartPdf('benchmark', 'Stage Benchmark', benchmarkTableColumns, benchmarkTableRows)}
                      />
                    )}
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
              <ChartPanel<ClosureTableRow>
                title="Expected Closure Opportunity"
                infoText="Expected Opportunity Count and Value by expected closure month. Click a month to see those opportunities."
                style={{ minHeight: 380 }}
                tableColumns={overview.error ? undefined : closureTableColumns}
                tableRows={overview.error ? undefined : closureTableRows}
                getRowId={(row) => row.id}
                headerActions={
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <DrillIndicator hint="Click a month to see its expected-closure opportunities" />
                    {!overview.error && (
                      <PdfButton
                        label="Export as PDF"
                        downloading={downloadingChartPdf === 'closure'}
                        disabled={closureTableRows.length === 0}
                        onClick={() => handleDownloadChartPdf('closure', 'Expected Closure Opportunity', closureTableColumns, closureTableRows)}
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
              <ChartPanel<StageValueTableRow>
                title="Opportunity by Stage"
                infoText="Opportunity value by current CRM stage, including Won/Lost. Click a segment to see those opportunities."
                style={{ minHeight: 380 }}
                tableColumns={overview.error ? undefined : stageValueTableColumns}
                tableRows={overview.error ? undefined : stageValueTableRows}
                getRowId={(row) => row.id}
                headerActions={
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <DrillIndicator hint="Click a stage segment to see its opportunities" />
                    {!overview.error && (
                      <PdfButton
                        label="Export as PDF"
                        downloading={downloadingChartPdf === 'stage'}
                        disabled={stageValueTableRows.length === 0}
                        onClick={() => handleDownloadChartPdf('stage', 'Opportunity by Stage', stageValueTableColumns, stageValueTableRows)}
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
              <ChartPanel<ProbabilityTableRow>
                title="Probabilities Distribution"
                infoText="Open opportunity count by probability bucket (10-90%). Click a bucket to see those opportunities."
                style={{ minHeight: 380 }}
                tableColumns={overview.error ? undefined : probabilityTableColumns}
                tableRows={overview.error ? undefined : probabilityTableRows}
                getRowId={(row) => row.id}
                headerActions={
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <DrillIndicator hint="Click a probability bucket to see its opportunities" />
                    {!overview.error && (
                      <PdfButton
                        label="Export as PDF"
                        downloading={downloadingChartPdf === 'probability'}
                        disabled={probabilityTableRows.length === 0}
                        onClick={() => handleDownloadChartPdf('probability', 'Probabilities Distribution', probabilityTableColumns, probabilityTableRows)}
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
          ) : view === 'details' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-3, 16px)' }}>
              <ChartPanel
                title={`Opportunity Details${detailsFilter ? ` — ${detailsFilterLabel(detailsFilter)}` : ''}`}
                style={{ minHeight: 480 }}
                headerActions={
                  <PdfButton
                    label="Download as PDF"
                    downloading={downloadingPdf}
                    disabled={filteredOpportunities.length === 0}
                    onClick={handleDownloadPdf}
                  />
                }
              >
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
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-3, 16px)' }}>
              <ChartPanel
                title={`${stageRecordKind ? FUNNEL_STAGE_LABELS[stageRecordKind] : ''} — Full Pipeline`}
                infoText="Records linked to an Opportunity (B2B, YTD). Use the second button to export the ones with no linked Opportunity instead."
                style={{ minHeight: 480 }}
                headerActions={
                  <div style={{ display: 'flex', gap: 8 }}>
                    <PdfButton
                      label="Download as PDF"
                      downloading={downloadingStagePdf === 'linked'}
                      disabled={linkedStageRecords.length === 0}
                      onClick={() => handleDownloadStagePdf(true)}
                    />
                    <PdfButton
                      label={`${stageRecordKind ? FUNNEL_STAGE_LABELS[stageRecordKind] : ''} with no Opportunities`}
                      downloading={downloadingStagePdf === 'unlinked'}
                      disabled={unlinkedStageRecords.length === 0}
                      onClick={() => handleDownloadStagePdf(false)}
                    />
                  </div>
                }
              >
                {overview.loading ? (
                  <LoadingSkeleton variant="chart" />
                ) : overview.error ? (
                  <ErrorState message={overview.error} onRetry={overview.retry} />
                ) : isDeliveryStage ? (
                  <DataTable columns={stageDeliveryColumns} rows={linkedStageRows as StageDeliveryTableRow[]} getRowId={(row) => row.id} />
                ) : (
                  <DataTable columns={stageSalesColumns} rows={linkedStageRows as StageSalesTableRow[]} getRowId={(row) => row.id} />
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

        <BottomNavBar active="Pipeline Health" />
      </div>
    </PermissionGuard>
  );
}

/** Same visual shell as the page's original inline "Download as PDF" button -- factored out once a
 * second and third instance of it were needed (linked-only / "with no Opportunities" for the new
 * stage-records view) so all three read as one consistent affordance instead of copies drifting. */
function PdfButton({
  label,
  downloading,
  disabled,
  onClick,
}: {
  label: string;
  downloading: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
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
      {downloading ? 'Exporting...' : label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Drill-down affordance badge -- visually matches Invoices Engine / Customer Growth's DrillToggle
// (same icon, label, sizing, and default/inactive styling) but is a static indicator, not a mode
// toggle: the charts below drill straight into detail on click already, with no separate
// enable-drill-mode step, so there's no on/off state for a button to control. This just tells
// users the chart is clickable, matching the Sales Trend chart's visual pattern.
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
