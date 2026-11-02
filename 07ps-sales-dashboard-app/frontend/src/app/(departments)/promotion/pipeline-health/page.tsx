'use client';
import React, { useState } from 'react';
import { ArrowLeft, FileDown, Layers } from 'lucide-react';
import { AppHeader } from '../../../../components/AppHeader';
import { FilterBar } from '../../../../components/FilterBar';
import { OpportunityChainView } from '../../../../components/OpportunityChainView';
import { OdooLink } from '../../../../components/OdooLink';
import { rowsToPdfRows } from '../../../../lib/pdfRows';
import { BottomNavBar } from '../../../../components/BottomNavBar';
import { ValidationStatusBar } from '../../../../components/ValidationStatusBar';
import { RefreshFooter } from '../../../../components/RefreshFooter';
import { useFilterState, useScopedFilterOptions } from '../../../../components/FilterProvider';
import {
  Card,
  ChartPanel,
  ComboChart,
  DonutChart,
  FunnelChart,
  GroupedBarChart,
  DataGrid,
  Button,
  ProgressBar,
  SemanticBadge,
  LoadingSkeleton,
  ErrorState,
  exportRowsAsPdf,
  exportPerformanceTablePdf,
  PerformanceReportTable,
  SEMANTIC_STATUS_LABEL,
  type Column,
  type DataGridColumn,
  type PerformanceReportRow,
  type PerformanceTablePdfColumn,
  useCanExport,
  VisualInfoIcons,
} from '@07ps/ui';
import { useAuth } from '../../../../lib/AuthProvider';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { usePipelineHealthOverview, useRefreshStatus } from '../../../../lib/hooks';
import type {
  DataQualityOverview,
  FunnelDeliveryRecord,
  FunnelOpportunityIds,
  FunnelSalesRecord,
  FunnelStageRecords,
  OpportunityDetailRow,
  OpportunityStatus,
  PipelineHealthOverview,
  StageBenchmarkRow,
} from '../../../../lib/api';
import { formatCurrency, formatTimestamp, toSemanticStatus, DISPLAY_LOCALE } from '../../../../lib/format';
import { vh } from '../../../../lib/visualHelp';

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

/** Opportunity by Status slice colours (Odoo won_status): Won = success, Lost = alert, Pending (open) = accent. */
const STATUS_COLORS: Record<OpportunityStatus, string> = {
  Won: 'var(--ps-color-success)',
  Lost: 'var(--ps-color-alert)',
  Pending: 'var(--ps-color-accent)',
};

function formatMillions(value: number): string {
  const fixed = (value / 1_000_000).toFixed(1);
  return `${fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed}M`;
}

function formatPlainNumber(value: number): string {
  return value.toLocaleString(DISPLAY_LOCALE, { maximumFractionDigits: 0 });
}

function formatPct(v: number | null): string {
  return v != null ? `${(v * 100).toFixed(1)}%` : '—';
}

// ---------------------------------------------------------------------------
// Performance Details -- the page's single, C-level scannable summary table. Reuses
// PerformanceReportTable/SemanticBadge exactly like every other status surface on this page; the 3 Stage Benchmark rows and the Data Quality row carry a real,
// backend-computed status (classifyVsTarget / classifyRate respectively), the rest are
// informational (no target in this page's data model) and stay 'neutral'.
// ---------------------------------------------------------------------------

function stageBenchmarkTakeaway(row: StageBenchmarkRow): string {
  const actual = formatPct(row.actualPct);
  const target = formatPct(row.targetPct);
  if (row.status === 'green') return `${row.transition} conversion is on target at ${actual}.`;
  if (row.status === 'yellow') return `${row.transition} conversion is slightly behind target (${actual} vs ${target}).`;
  if (row.status === 'red') return `${row.transition} conversion is well behind target (${actual} vs ${target}) and needs attention.`;
  return `No target set for ${row.transition}.`;
}

function dataQualityTakeaway(dq: DataQualityOverview): string {
  const pct = formatPct(dq.dirtyPct);
  if (dq.status === 'green') return `Pipeline data is clean -- only ${pct} of records have an issue.`;
  if (dq.status === 'yellow') return `${pct} of pipeline records have a data issue -- worth a look.`;
  if (dq.status === 'red') return `${pct} of pipeline records have a data issue -- figures on this page may be understated.`;
  return 'No opportunity records to validate for the current filters.';
}

function toExecutiveSummaryRows(data?: PipelineHealthOverview | null): PerformanceReportRow[] {
  if (!data) return [];
  // "Last" is "—" on every row: this page has no prior-period (LYTD/LMTD) figure -- every funnel
  // count is a YTD point-in-time figure and the benchmarks are rates against fixed targets -- so
  // Variance to Last is "—" too (agreed with the business; Last column kept for the shared layout).
  const funnelRow = (id: string, metric: string, count: number, value: number | null, takeaway: string): PerformanceReportRow => ({
    id,
    metric,
    actualLabel: formatPlainNumber(count),
    actualFullValue: value != null ? formatCurrency(value) : undefined,
    targetLabel: '—',
    variancePct: null,
    varianceLyPct: null,
    status: 'neutral',
    takeaway,
  });
  const rows: PerformanceReportRow[] = [
    funnelRow('leads', 'Leads (YTD, B2B)', data.funnel.leads, null, `${formatPlainNumber(data.funnel.leads)} B2B leads created so far this year.`),
    funnelRow(
      'opportunities',
      'Open Opportunities (YTD, B2B)',
      data.funnel.opportunities,
      data.funnelValues.opportunities,
      `${formatPlainNumber(data.funnel.opportunities)} open opportunities created YTD, worth ${formatCurrency(data.funnelValues.opportunities)}.`,
    ),
    funnelRow(
      'quotations',
      'Quotations (YTD, B2B)',
      data.funnel.quotations,
      data.funnelValues.quotations,
      `${formatPlainNumber(data.funnel.quotations)} quotations issued YTD, worth ${formatCurrency(data.funnelValues.quotations)}.`,
    ),
    funnelRow(
      'salesOrders',
      'Sales Orders (YTD, B2B)',
      data.funnel.salesOrders,
      data.funnelValues.salesOrders,
      `${formatPlainNumber(data.funnel.salesOrders)} sales orders YTD, worth ${formatCurrency(data.funnelValues.salesOrders)}.`,
    ),
    funnelRow(
      'deliveries',
      'Deliveries (YTD, B2B)',
      data.funnel.deliveries,
      data.funnelValues.deliveries,
      `${formatPlainNumber(data.funnel.deliveries)} deliveries YTD, worth ${formatCurrency(data.funnelValues.deliveries)}.`,
    ),
  ];
  for (const b of data.stageBenchmark) {
    rows.push({
      id: `benchmark-${b.transition}`,
      metric: b.transition,
      actualLabel: formatPct(b.actualPct),
      targetLabel: formatPct(b.targetPct),
      variancePct: b.variancePct,
      varianceLyPct: null,
      status: toSemanticStatus(b.status),
      takeaway: stageBenchmarkTakeaway(b),
    });
  }
  if (data.dataQuality) rows.push({
    id: 'dataQuality',
    metric: 'Data Quality',
    actualLabel: formatPct(data.dataQuality.dirtyPct),
    targetLabel: `< ${formatPct(0.02)} dirty`,
    variancePct: null,
    varianceLyPct: null,
    status: toSemanticStatus(data.dataQuality.status),
    takeaway: dataQualityTakeaway(data.dataQuality),
  });
  return rows;
}

// Matches PerformanceReportTable's showLytdColumn layout so the PDF mirrors the on-screen table.
function pctLabel(v: number | null): string {
  return v !== null ? `${(v * 100).toFixed(2)}%` : '—';
}
const PERFORMANCE_PDF_COLUMNS: PerformanceTablePdfColumn[] = [
  { header: 'Metric Name', getValue: (row) => row.metric },
  { header: 'Actual', getValue: (row) => row.actualLabel },
  { header: 'Last', getValue: (row) => row.lytdLabel ?? '—' },
  { header: 'Target', getValue: (row) => row.targetLabel },
  { header: 'Variance to Last', getValue: (row) => pctLabel(row.varianceLyPct) },
  { header: 'Variance to Target', getValue: (row) => pctLabel(row.variancePct) },
  { header: 'Status', getValue: (row) => (row.status ? SEMANTIC_STATUS_LABEL[row.status] : '—') },
  { header: 'Takeaway', getValue: (row) => row.takeaway ?? '—' },
];

type DetailsFilter = { type: 'month' | 'stage' | 'bucket' | 'funnelStage' | 'status'; value: string } | null;

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
  odooUrl: string | null;
  customerOdooUrl: string | null;
}

// Row-level tables (opportunities, quotations / sales orders / deliveries) use DataGrid like the other detail tables:
// click-to-sort headers, search + column filters, Export CSV and Export as PDF of the filtered, sorted rows.
const opportunityColumns: DataGridColumn<OpportunityTableRow>[] = [
  { key: 'name', header: 'Opportunity Name', rawValue: (r) => r.name, render: (r) => <OdooLink href={r.odooUrl}>{r.name}</OdooLink> },
  { key: 'stage', header: 'Stage' },
  { key: 'probability', header: 'Probability %' },
  { key: 'expectedCloseDate', header: 'Expected Close Date' },
  { key: 'expectedRevenue', header: 'Value', align: 'right', render: (r) => formatCurrency(r.expectedRevenue) },
  { key: 'customer', header: 'Customer', rawValue: (r) => r.customer, render: (r) => <OdooLink href={r.customerOdooUrl}>{r.customer}</OdooLink> },
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
    odooUrl: o.odooUrl ?? null,
    customerOdooUrl: o.customerOdooUrl ?? null,
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
  odooUrl: string | null;
  customerOdooUrl: string | null;
}

const stageSalesColumns: DataGridColumn<StageSalesTableRow>[] = [
  { key: 'orderNumber', header: 'Order Number', rawValue: (r) => r.orderNumber, render: (r) => <OdooLink href={r.odooUrl}>{r.orderNumber}</OdooLink> },
  { key: 'documentDate', header: 'Date' },
  { key: 'value', header: 'Value', align: 'right', render: (r) => formatCurrency(r.value) },
  { key: 'customer', header: 'Customer', rawValue: (r) => r.customer, render: (r) => <OdooLink href={r.customerOdooUrl}>{r.customer}</OdooLink> },
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
    odooUrl: r.odooUrl ?? null,
    customerOdooUrl: r.customerOdooUrl ?? null,
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
  deliveryReference: string;
  odooUrl: string | null;
  orderOdooUrl: string | null;
  customerOdooUrl: string | null;
}

// "Order Number" is the sale order's number (v_sales_deliveries.OrderNumber), so it opens the sale.order; the picking
// itself (WH/OUT/...) is the "Delivery" column and opens the stock.picking.
const stageDeliveryColumns: DataGridColumn<StageDeliveryTableRow>[] = [
  { key: 'orderNumber', header: 'Order Number', rawValue: (r) => r.orderNumber, render: (r) => <OdooLink href={r.orderOdooUrl}>{r.orderNumber}</OdooLink> },
  { key: 'deliveryReference', header: 'Delivery', rawValue: (r) => r.deliveryReference, render: (r) => <OdooLink href={r.odooUrl}>{r.deliveryReference}</OdooLink> },
  { key: 'orderDate', header: 'Order Date' },
  { key: 'deliveryStatus', header: 'Status' },
  { key: 'customer', header: 'Customer', rawValue: (r) => r.customer, render: (r) => <OdooLink href={r.customerOdooUrl}>{r.customer}</OdooLink> },
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
    deliveryReference: r.deliveryReference ?? '—',
    odooUrl: r.odooUrl ?? null,
    orderOdooUrl: r.orderOdooUrl ?? null,
    customerOdooUrl: r.customerOdooUrl ?? null,
  }));
}

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
  reachedPct: string;
}
const funnelTableColumns: Column<FunnelTableRow>[] = [
  { key: 'stage', header: 'Stage' },
  { key: 'count', header: 'Count', align: 'right' },
  { key: 'value', header: 'Value', align: 'right', render: (r) => formatCurrency(r.value) },
  { key: 'reachedPct', header: '% of opportunities created that reached it', align: 'right' },
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

interface StatusTableRow extends Record<string, unknown> {
  id: string;
  status: string;
  count: number;
  share: string;
  expectedRevenue: number;
}
const statusTableColumns: Column<StatusTableRow>[] = [
  { key: 'status', header: 'Status' },
  { key: 'count', header: 'Opportunities', align: 'right' },
  { key: 'share', header: 'Share', align: 'right' },
  { key: 'expectedRevenue', header: 'Expected Revenue', align: 'right', render: (r) => formatCurrency(r.expectedRevenue) },
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

/** Stage-based drill-downs (month / stage / bucket) list open opportunities only (status Pending), matching their charts
 * (backend/src/measures/pipelineHealth.ts's status policy); a status slice lists that status; funnelStage matches by
 * an ID list that is already open-only at the query level. */
function matchesFilter(o: OpportunityDetailRow, filter: DetailsFilter, funnelIds?: FunnelOpportunityIds): boolean {
  if (!filter) return true;
  if (filter.type === 'status') return o.status === filter.value;
  if (filter.type === 'month') return o.isOpen && o.expectedCloseMonth === filter.value;
  if (filter.type === 'stage') return o.isOpen && (o.stage ?? 'Unspecified') === filter.value;
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
  if (filter.type === 'status') return `Status: ${filter.value}`;
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
  if (filter.type === 'status') return 'Opportunity by Status';
  if (filter.type === 'funnelStage') return 'Full Pipeline';
  return 'Probabilities Distribution';
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
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
  } = useFilterState();

  const [view, setView] = useState<'summary' | 'details' | 'stageRecords' | 'chain'>('summary');
  const [detailsFilter, setDetailsFilter] = useState<DetailsFilter>(null);
  const [stageRecordKind, setStageRecordKind] = useState<StageRecordKind | null>(null);
  const [downloadingUnlinkedPdf, setDownloadingUnlinkedPdf] = useState(false);
  const [downloadingChartPdf, setDownloadingChartPdf] = useState<string | null>(null);

  const filterOptions = useScopedFilterOptions();
  const overview = usePipelineHealthOverview(token, effectiveFilters, authError, retryAuth);
  const refreshStatus = useRefreshStatus(token, authError, retryAuth);

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
  // Funnel % (2026-11-02, same base as Stage Benchmark, option A): the share of ALL opportunities created in the period
  // (Pending + Won + Lost) that reached each step -- so no step can pass 100%. The bars keep their own counts (the
  // Opportunities bar = open only), which is why the Opportunities row shows no %. Before, each bar was divided by the
  // open-only Opportunities bar while Quotations also counted won/lost deals (e.g. 183%).
  const cohort = data?.benchmarkCohort;
  const reachedShare = (n: number | undefined) => (cohort && cohort.opportunities > 0 && n != null ? n / cohort.opportunities : null);
  const funnelStages = data
    ? [
        { id: 'opportunities', label: 'Opportunities', value: data.funnel.opportunities, secondaryValue: data.funnelValues.opportunities, pct: null, color: FUNNEL_COLORS[0] },
        { id: 'quotations', label: 'Quotations', value: data.funnel.quotations, secondaryValue: data.funnelValues.quotations, pct: reachedShare(cohort?.quotations), color: FUNNEL_COLORS[1] },
        { id: 'salesOrders', label: 'Sales Orders', value: data.funnel.salesOrders, secondaryValue: data.funnelValues.salesOrders, pct: reachedShare(cohort?.salesOrders), color: FUNNEL_COLORS[2] },
        { id: 'deliveries', label: 'Deliveries', value: data.funnel.deliveries, secondaryValue: data.funnelValues.deliveries, pct: reachedShare(cohort?.deliveries), color: FUNNEL_COLORS[3] },
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

  const statusSlices = data?.opportunitiesByStatus.slices ?? [];
  const statusTotal = statusSlices.reduce((sum, s) => sum + s.count, 0);
  const statusSegments = statusSlices
    .filter((s) => s.count > 0)
    .map((s) => ({
      id: s.status,
      label: s.status,
      value: s.count,
      color: STATUS_COLORS[s.status],
      tooltipNote: `Expected revenue: ${formatCurrency(s.expectedRevenue)}`,
    }));
  const statusTableRows: StatusTableRow[] = statusSlices.map((s) => ({
    id: s.status,
    status: s.status,
    count: s.count,
    share: statusTotal > 0 ? `${((s.count / statusTotal) * 100).toFixed(1)}%` : '0.0%',
    expectedRevenue: s.expectedRevenue,
  }));

  const probabilityPoints = (data?.probabilityDistribution ?? []).map((p) => ({ label: p.bucket, count: p.count }));

  const filteredOpportunities = (data?.opportunities ?? [])
    .filter((o) => matchesFilter(o, detailsFilter, data?.funnelOpportunityIds))
    .map(toTableRow);

  const funnelTableRows: FunnelTableRow[] = funnelStages.map((s) => ({ id: s.id, stage: s.label, count: s.value, value: s.secondaryValue ?? 0, reachedPct: s.pct == null ? '—' : formatPct(s.pct) }));
  const benchmarkTableRows: BenchmarkTableRow[] = (data?.stageBenchmark ?? []).map((row) => ({
    id: row.transition,
    transition: row.transition,
    actualPct: formatPct(row.actualPct),
    targetPct: formatPct(row.targetPct),
  }));
  const closureTableRows: ClosureTableRow[] = closurePoints.map((p) => ({ id: p.label, month: p.label, expectedCount: p.expectedCount, expectedValue: p.expectedValue }));
  const stageValueTableRows: StageValueTableRow[] = stageSegments.map((s) => ({ id: s.id, stage: s.label, value: s.value }));
  const probabilityTableRows: ProbabilityTableRow[] = probabilityPoints.map((p) => ({ id: p.label, bucket: p.label, count: p.count }));

  // Filters applied / Exported by come from the shared PDF export context (PdfExportContextBridge).
  async function handleExportPerformanceTablePdf() {
    try {
      await exportPerformanceTablePdf({
        title: 'Performance Details',
        rows: toExecutiveSummaryRows(data),
        columns: PERFORMANCE_PDF_COLUMNS,
      });
    } catch (err) {
      console.error('PDF export failed:', err);
    }
  }

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

  // DataGrid's Export CSV / Export as PDF file name and PDF title, e.g. "opportunity-by-stage-proposal-opportunities".
  const detailsFileName = slug(
    [widgetNameForFilter(detailsFilter), filterValueForPdf(detailsFilter), 'opportunities'].filter(Boolean).join(' '),
  );
  const detailsFilterParts = detailsFilter ? [`${widgetNameForFilter(detailsFilter)}: ${filterValueForPdf(detailsFilter)}`] : undefined;

  const isDeliveryStage = stageRecordKind === 'deliveries';
  const activeStageRecords = stageRecordKind ? getStageRecords(stageRecordKind, data?.funnelStageRecords) : [];
  const linkedStageRecords = activeStageRecords.filter((r) => r.opportunityId != null);
  const unlinkedStageRecords = activeStageRecords.filter((r) => r.opportunityId == null);
  const linkedStageRows = isDeliveryStage
    ? toStageDeliveryRows(linkedStageRecords as FunnelDeliveryRecord[])
    : toStageSalesRows(linkedStageRecords as FunnelSalesRecord[]);
  const stageColumns = isDeliveryStage ? stageDeliveryColumns : stageSalesColumns;
  const stageLabel = stageRecordKind ? FUNNEL_STAGE_LABELS[stageRecordKind] : '';

  /** The "with no Opportunities" set the drill-down table deliberately excludes -- exported on its own; the table's
   * rows themselves export through DataGrid's Export CSV / Export as PDF. */
  async function handleDownloadUnlinkedStagePdf() {
    if (!stageRecordKind) return;
    const rows = isDeliveryStage
      ? toStageDeliveryRows(unlinkedStageRecords as FunnelDeliveryRecord[])
      : toStageSalesRows(unlinkedStageRecords as FunnelSalesRecord[]);
    setDownloadingUnlinkedPdf(true);
    try {
      await exportRowsAsPdf({
        title: `${stageLabel} with no Opportunities`,
        columns: stageColumns.map((c) => ({ header: c.header, align: c.align })),
        rows: rowsToPdfRows(stageColumns as Column<Record<string, unknown>>[], rows),
        fileName: `${slug(stageLabel)}-no-opportunities`,
      });
    } finally {
      setDownloadingUnlinkedPdf(false);
    }
  }

  return (
    <PermissionGuard pageKey="pipeline_health">
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', paddingBottom: 64 }}>
        <AppHeader
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

        {user?.isAdmin === true && (
          <DataQualityCard dataQuality={overview.data?.dataQuality} loading={overview.loading} />
        )}

        <main style={{ flex: 1, padding: 'var(--ps-space-4, 24px)' }}>
          {view === 'summary' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--ps-space-3, 16px)' }}>
              {/* Top-left -- Full Pipeline Funnel + Stage Benchmark */}
              <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 'var(--ps-space-3, 16px)' }}>
                <ChartPanel<FunnelTableRow>
                  title="Full Pipeline"
                  {...vh('promotion.pipelineHealth.fullPipeline')}
                  style={{ minHeight: 380 }}
                  tableColumns={overview.error ? undefined : funnelTableColumns}
                  tableRows={overview.error ? undefined : funnelTableRows}
                  getRowId={(row) => row.id}
                  headerActions={
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {!overview.error && (
                        <Button variant="secondary" onClick={() => setView('chain')} disabled={overview.loading}>
                          <Layers size={14} />
                          Opportunity chain
                        </Button>
                      )}
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
                    <>
                      <FunnelChart
                        title="Full Pipeline"
                        showTitle={false}
                        stages={funnelStages}
                        secondaryValueFormatter={(v) => formatCurrency(v)}
                        onStageClick={handleFunnelStageClick}
                      />
                      {cohort && (
                        <div data-testid="funnel-pct-base" style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginTop: 6 }}>
                          % = share of the {cohort.opportunities.toLocaleString(DISPLAY_LOCALE)} opportunities created this year (Pending, Won and Lost) that reached each step.
                        </div>
                      )}
                    </>
                  )}
                </ChartPanel>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-3, 16px)', minHeight: 0 }}>
                <TotalPipelineValueCard openPipeline={data?.openPipeline} loading={overview.loading} error={overview.error ?? undefined} onRetry={overview.retry} />
                <Card style={{ width: '100%', flex: 1, minHeight: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--ps-space-2, 8px)', gap: 8 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ps-color-text)' }}>Stage Benchmark</span>
                      <VisualInfoIcons title="Stage Benchmark" {...vh('promotion.pipelineHealth.stageBenchmark')} />
                    </span>
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
              </div>

              {/* Top-right -- Expected Closure Opportunity */}
              <ChartPanel<ClosureTableRow>
                title="Expected Closure Opportunity"
                {...vh('promotion.pipelineHealth.expectedClosure')}
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
                      expectedCount: (v) => v.toLocaleString(DISPLAY_LOCALE),
                      expectedValue: (v) => formatCurrency(v),
                    }}
                    onCategoryClick={(label) => openDetails({ type: 'month', value: label })}
                  />
                )}
              </ChartPanel>

              {/* Opportunity by Stage (open only) */}
              <ChartPanel<StageValueTableRow>
                title="Opportunity by Stage"
                {...vh('promotion.pipelineHealth.byStage')}
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
                    showPercentLabels
                  />
                )}
              </ChartPanel>

              {/* Opportunity by Status -- the outcome (Odoo won_status: Won / Lost / Pending), never the stage; same row and
                  height as Opportunity by Stage so the two read side by side */}
              <ChartPanel<StatusTableRow>
                title="Opportunity by Status"
                {...vh('promotion.pipelineHealth.byStatus')}
                style={{ minHeight: 380 }}
                tableColumns={overview.error ? undefined : statusTableColumns}
                tableRows={overview.error ? undefined : statusTableRows}
                getRowId={(row) => row.id}
                headerActions={
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <DrillIndicator hint="Click a status to see its opportunities" />
                    {!overview.error && (
                      <PdfButton
                        label="Export as PDF"
                        downloading={downloadingChartPdf === 'status'}
                        disabled={statusTotal === 0}
                        onClick={() => handleDownloadChartPdf('status', 'Opportunity by Status', statusTableColumns, statusTableRows)}
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
                    title="Opportunity by Status"
                    showTitle={false}
                    segments={statusSegments}
                    valueFormatter={(v) => `${v.toLocaleString(DISPLAY_LOCALE)} opportunit${v === 1 ? 'y' : 'ies'}`}
                    legendTitle="Status"
                    centerLabel={statusTotal.toLocaleString(DISPLAY_LOCALE)}
                    centerSubLabel="Opportunities"
                    onSegmentClick={(id) => openDetails({ type: 'status', value: id })}
                    showPercentLabels
                  />
                )}
              </ChartPanel>

              {/* Probabilities Distribution */}
              <ChartPanel<ProbabilityTableRow>
                title="Probabilities Distribution"
                {...vh('promotion.pipelineHealth.probability')}
                style={{ minHeight: 380, gridColumn: '1 / -1' }}
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
                    tooltipFormatters={{ count: (v) => v.toLocaleString(DISPLAY_LOCALE) }}
                    onCategoryClick={(label) => openDetails({ type: 'bucket', value: label })}
                  />
                )}
              </ChartPanel>
            </div>

            {!overview.loading && !overview.error && (
              <PerformanceReportTable
                title="Performance Details"
                {...vh('promotion.pipelineHealth.details')}
                rows={toExecutiveSummaryRows(data)}
                showStatus
                showTakeaway
                onExportPdf={handleExportPerformanceTablePdf}
              />
            )}
            </div>
          ) : view === 'chain' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-3, 16px)' }}>
              <ChartPanel
                title="Full Pipeline — Opportunity chain"
                {...vh('promotion.pipelineHealth.chain')}
                style={{ minHeight: 480 }}
              >
                {overview.loading ? (
                  <LoadingSkeleton variant="chart" />
                ) : overview.error ? (
                  <ErrorState message={overview.error} onRetry={overview.retry} />
                ) : (
                  <OpportunityChainView chains={data?.opportunityChains} />
                )}
              </ChartPanel>

              <div>
                <Button variant="secondary" onClick={handleBackToSummary}>
                  <ArrowLeft size={14} />
                  Back
                </Button>
              </div>
            </div>
          ) : view === 'details' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-3, 16px)' }}>
              <ChartPanel
                title={`Opportunity Details${detailsFilter ? ` — ${detailsFilterLabel(detailsFilter)}` : ''}`}
                {...vh('promotion.pipelineHealth.opportunityDetails')}
                style={{ minHeight: 480 }}
              >
                {overview.loading ? (
                  <LoadingSkeleton variant="chart" />
                ) : overview.error ? (
                  <ErrorState message={overview.error} onRetry={overview.retry} />
                ) : (
                  <DataGrid<OpportunityTableRow>
                    columns={opportunityColumns}
                    rows={filteredOpportunities}
                    getRowId={(row) => row.opportunityId}
                    fileName={detailsFileName}
                    extraFilterParts={detailsFilterParts}
                    pageSize={25}
                  />
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
                {...vh('promotion.pipelineHealth.stageRecords')}
                style={{ minHeight: 480 }}
                headerActions={
                  <PdfButton
                    label={`${stageLabel} with no Opportunities`}
                    downloading={downloadingUnlinkedPdf}
                    disabled={unlinkedStageRecords.length === 0}
                    onClick={handleDownloadUnlinkedStagePdf}
                  />
                }
              >
                {overview.loading ? (
                  <LoadingSkeleton variant="chart" />
                ) : overview.error ? (
                  <ErrorState message={overview.error} onRetry={overview.retry} />
                ) : isDeliveryStage ? (
                  <DataGrid<StageDeliveryTableRow>
                    key="deliveries"
                    columns={stageDeliveryColumns}
                    rows={linkedStageRows as StageDeliveryTableRow[]}
                    getRowId={(row) => row.id}
                    fileName={slug(stageLabel)}
                    pageSize={25}
                  />
                ) : (
                  <DataGrid<StageSalesTableRow>
                    key={stageRecordKind ?? 'sales'}
                    columns={stageSalesColumns}
                    rows={linkedStageRows as StageSalesTableRow[]}
                    getRowId={(row) => row.id}
                    fileName={slug(stageLabel)}
                    pageSize={25}
                  />
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

// ---------------------------------------------------------------------------
// Data Quality indicator -- surfaces the count/% of Fact_Opportunity records with a broken or
// missing field (see backend/src/measures/dataQuality.ts). Status/thresholds are computed on the
// backend (classifyRate against DATA_QUALITY_YELLOW_PCT/RED_PCT), same "backend decides, frontend
// just relabels" convention as every other status badge on this page.
// ---------------------------------------------------------------------------

function DataQualityCard({ dataQuality, loading }: { dataQuality?: DataQualityOverview; loading: boolean }) {
  if (loading && !dataQuality) return null;
  if (!dataQuality) return null;

  const status = toSemanticStatus(dataQuality.status);
  const issuesWithCounts = dataQuality.issues.filter((issue) => issue.count > 0);

  return (
    <div style={{ padding: '0 var(--ps-space-4, 24px)', marginTop: 'var(--ps-space-3, 16px)' }}>
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ps-color-text)' }}>Data Quality</span>
            <VisualInfoIcons title="Data Quality" {...vh('promotion.pipelineHealth.dataQuality')} />
            <span style={{ fontSize: 12, color: 'var(--ps-color-muted-text)' }}>
              {dataQuality.dirtyRecords} of {dataQuality.totalRecords} records ({formatPct(dataQuality.dirtyPct)}) have an issue
            </span>
          </div>
          <SemanticBadge status={status} />
        </div>
        {issuesWithCounts.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', marginTop: 8, fontSize: 11, color: 'var(--ps-color-muted-text)' }}>
            {issuesWithCounts.map((issue) => (
              <span key={issue.key}>
                {issue.label}: <strong style={{ color: 'var(--ps-color-text)' }}>{issue.count}</strong>
              </span>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

/** Total expected revenue of open (Pending) opportunities -- the same population as Opportunity by Stage and the Pending
 * slice of Opportunity by Status (the backend takes it from that slice, so the three always agree). */
function TotalPipelineValueCard({
  openPipeline,
  loading,
  error,
  onRetry,
}: {
  openPipeline?: { count: number; value: number };
  loading: boolean;
  error?: string;
  onRetry: () => void;
}) {
  return (
    <Card style={{ width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ps-color-text)' }}>Total Pipeline Value</span>
        <VisualInfoIcons title="Total Pipeline Value" {...vh('promotion.pipelineHealth.totalPipelineValue')} />
      </div>
      {loading ? (
        <LoadingSkeleton variant="kpi" />
      ) : error ? (
        <ErrorState message={error} onRetry={onRetry} />
      ) : (
        <>
          <div data-testid="total-pipeline-value" style={{ fontSize: 22, fontWeight: 700, color: 'var(--ps-color-text)', fontVariantNumeric: 'tabular-nums' }}>
            {formatCurrency(openPipeline?.value ?? 0)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginTop: 2 }}>
            {(openPipeline?.count ?? 0).toLocaleString(DISPLAY_LOCALE)} open opportunit{openPipeline?.count === 1 ? 'y' : 'ies'}
          </div>
        </>
      )}
    </Card>
  );
}

function BenchmarkRow({ row }: { row: StageBenchmarkRow }) {
  const status = toSemanticStatus(row.status);
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ps-color-text)' }}>{row.transition}</span>
        <SemanticBadge status={status} />
      </div>
      <ProgressBar actual={row.actualPct ?? 0} targetToDate={row.targetPct} status={status} label={`${row.transition}: ${formatPct(row.actualPct)} of ${formatPct(row.targetPct)} target`} />
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2, fontSize: 11, color: 'var(--ps-color-muted-text)' }}>
        <span>Actual: {formatPct(row.actualPct)} ({row.toCount.toLocaleString(DISPLAY_LOCALE)} of {row.fromCount.toLocaleString(DISPLAY_LOCALE)})</span>
        <span>Target: {formatPct(row.targetPct)}</span>
      </div>
    </div>
  );
}
