'use client';
import React, { useEffect, useRef, useState } from 'react';
import { FileDown, X } from 'lucide-react';
import { AppHeader } from '../../../../components/AppHeader';
import { FilterBar } from '../../../../components/FilterBar';
import { BottomNavBar } from '../../../../components/BottomNavBar';
import { ValidationStatusBar } from '../../../../components/ValidationStatusBar';
import { RefreshFooter } from '../../../../components/RefreshFooter';
import { useFilterState, useScopedFilterOptions } from '../../../../components/FilterProvider';
import {
  Card,
  ChartPanel,
  ComboChart,
  DataGrid,
  type DataGridColumn,
  StackedPercentBarChart,
  LoadingSkeleton,
  ErrorState,
  exportRowsAsPdf,
  type Column,
  useCanExport,
  VisualInfoIcons,
} from '@07ps/ui';
import { useAuth } from '../../../../lib/AuthProvider';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { usePeriodTrend, usePipelineTrendAgingDetails, usePipelineTrendOverview, useRefreshStatus } from '../../../../lib/hooks';
import type {
  AgingBucketKey,
  AgingBuckets,
  AgingCategory,
  AgingDetailRow,
  AgingDistribution,
  PeriodComparisonPoint,
  PeriodGranularity,
  PipelineTrendPeriods,
  QuotationRates,
} from '../../../../lib/api';
import { DEFAULT_GRANULARITY, formatChange, usePeriodWindow, type PeriodWindowView } from '../../../../lib/periods';
import { PeriodTrendSelector } from '../../../../components/PeriodTrendSelector';
import { formatCompactNumber, formatCurrency, formatPercent, formatTimestamp, DISPLAY_LOCALE } from '../../../../lib/format';
import { vh, type VisualHelpId } from '../../../../lib/visualHelp';
import { formatWinLossRatio } from '../../../../lib/winLoss';
import { stageFilterOptions } from '../../../../lib/pipelineStages';

function formatPlainNumber(value: number): string {
  return value.toLocaleString(DISPLAY_LOCALE, { maximumFractionDigits: 0 });
}

function formatCountOrDash(v: number | undefined): string {
  return v != null ? v.toLocaleString(DISPLAY_LOCALE) : '—';
}

/** Won/Lost Ratio YTD: "19.87 : 1" (shared formatter; "All won" with no lost, "—" with neither). */
function formatRatio(rates?: QuotationRates): string {
  return rates ? formatWinLossRatio(rates.wonQuotations, rates.lostQuotations) : '—';
}

function toPeriodChartPoints(series: PeriodComparisonPoint[], win: PeriodWindowView) {
  return series.map((p) => ({
    label: win.label(p.start),
    count: p.count,
    value: p.value,
    countChange: p.countChangePct,
  }));
}

function toAgingPercentPoint(label: string, b: AgingBuckets) {
  const total = b.b0to30 + b.b30to60 + b.b60to90 + b.b90plus;
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);
  return {
    label,
    b0to30: pct(b.b0to30),
    b30to60: pct(b.b30to60),
    b60to90: pct(b.b60to90),
    b90plus: pct(b.b90plus),
  };
}

const AGING_SEGMENTS = [
  { key: 'b0to30', name: '0-30 days', color: 'var(--ps-color-success)' },
  { key: 'b30to60', name: '30-60 days', color: 'var(--ps-color-watch)' },
  { key: 'b60to90', name: '60-90 days', color: 'var(--ps-color-alert)' },
  { key: 'b90plus', name: '90+ days', color: 'var(--ps-neutral-charcoal)' },
];

/** Aging bar label -> drill-down category (the two bars are built from these labels below). */
const AGING_CATEGORY_BY_LABEL: Record<string, AgingCategory> = { Opportunities: 'opportunities', Quotations: 'quotations' };
const AGING_CATEGORY_LABEL: Record<AgingCategory, string> = { opportunities: 'Opportunities', quotations: 'Quotations' };

type AgingSelection = { category: AgingCategory; bucket: AgingBucketKey };

function agingDetailColumns(category: AgingCategory, rows: AgingDetailRow[]): DataGridColumn<AgingDetailRow & Record<string, unknown>>[] {
  const isOpp = category === 'opportunities';
  // Opportunities: the Stage column sorts and filters in pipeline order (backend config/pipelineStages.ts).
  const stageSort = isOpp
    ? {
        sortValue: (r: AgingDetailRow) => r.stagePosition ?? Number.MAX_SAFE_INTEGER,
        filterOptions: stageFilterOptions(rows.map((r) => ({ stage: r.status ?? '—', stagePosition: r.stagePosition }))),
      }
    : {};
  return [
    { key: 'name', header: isOpp ? 'Opportunity' : 'Quotation', width: 220 },
    { key: 'customer', header: 'Customer', width: 200, rawValue: (r) => r.customer ?? '—' },
    { key: 'salesperson', header: 'Salesperson', width: 160, rawValue: (r) => r.salesperson ?? '—' },
    { key: 'date', header: isOpp ? 'Created' : 'Quotation Date', width: 120, rawValue: (r) => r.date ?? '—' },
    { key: 'ageDays', header: 'Age (days)', align: 'right', width: 100 },
    { key: 'value', header: isOpp ? 'Expected Value' : 'Value', align: 'right', width: 140, render: (r) => formatCurrency(r.value) },
    { key: 'status', header: isOpp ? 'Stage' : 'Status', width: 130, rawValue: (r) => r.status ?? '—', ...stageSort },
  ];
}

const PERIOD_CHART_BARS = [
  { key: 'count', name: 'Count', color: 'var(--ps-color-accent)' },
];
const PERIOD_CHART_LINES = [
  { key: 'value', name: 'Value', color: 'var(--ps-color-gold)', yAxisId: 'right' as const },
];

// ---------------------------------------------------------------------------
// PDF summary-table export -- same exportRowsAsPdf mechanism as Revenue Trend, applied to every
// visual on this page. Quotation Rates' table explicitly includes Won/Lost figures (the page's
// on-screen aging/month charts only show active-pipeline stages, so the export is the one place
// Won/Lost data is guaranteed to appear, per the requirement that it not be limited to what the
// charts show).
// ---------------------------------------------------------------------------

function formatCountOrDashPdf(v: number | undefined): string {
  return v != null ? v.toLocaleString(DISPLAY_LOCALE) : '—';
}

interface RateTableRow extends Record<string, unknown> {
  id: string;
  metric: string;
  value: string;
}
const rateTableColumns: Column<RateTableRow>[] = [
  { key: 'metric', header: 'Metric' },
  { key: 'value', header: 'Value', align: 'right' },
];
function toRateTableRows(rates?: QuotationRates): RateTableRow[] {
  if (!rates) return [];
  return [
    { id: 'total', metric: 'Total Quotations YTD', value: formatCountOrDashPdf(rates.totalQuotations) },
    { id: 'won', metric: 'Won Quotations YTD', value: formatCountOrDashPdf(rates.wonQuotations) },
    { id: 'winRate', metric: 'Win Rate YTD', value: formatPercent(rates.winRatePct) ?? '—' },
    { id: 'open', metric: 'Open Quotations YTD', value: formatCountOrDashPdf(rates.openQuotations) },
    { id: 'lost', metric: 'Lost Quotations YTD', value: formatCountOrDashPdf(rates.lostQuotations) },
    { id: 'ratio', metric: 'Won/Lost Ratio YTD', value: formatRatio(rates) },
  ];
}

interface AgingTableRow extends Record<string, unknown> {
  id: string;
  category: string;
  b0to30: number;
  b30to60: number;
  b60to90: number;
  b90plus: number;
}
const agingTableColumns: Column<AgingTableRow>[] = [
  { key: 'category', header: 'Category' },
  { key: 'b0to30', header: '0-30 days', align: 'right' },
  { key: 'b30to60', header: '30-60 days', align: 'right' },
  { key: 'b60to90', header: '60-90 days', align: 'right' },
  { key: 'b90plus', header: '90+ days', align: 'right' },
];
function toAgingTableRows(aging?: AgingDistribution): AgingTableRow[] {
  if (!aging) return [];
  const row = (id: string, category: string, b: AgingBuckets): AgingTableRow => ({
    id,
    category,
    b0to30: b.b0to30,
    b30to60: b.b30to60,
    b60to90: b.b60to90,
    b90plus: b.b90plus,
  });
  return [row('opportunities', 'Opportunities', aging.opportunities), row('quotations', 'Quotations', aging.quotations)];
}

interface PeriodTableRow extends Record<string, unknown> {
  id: string;
  period: string;
  count: number;
  value: string;
  change: string;
}
function periodTableColumns(changeLabel: string): Column<PeriodTableRow>[] {
  return [
    { key: 'period', header: 'Period' },
    { key: 'count', header: 'Count', align: 'right' },
    { key: 'value', header: 'Value', align: 'right' },
    { key: 'change', header: `Count change ${changeLabel}`, align: 'right' },
  ];
}
function toPeriodTableRows(series: PeriodComparisonPoint[], win: PeriodWindowView): PeriodTableRow[] {
  return series.map((p) => ({
    id: p.start,
    period: `${win.title(p.start)}${p.inProgress ? ' (in progress)' : ''}`,
    count: p.count,
    value: formatCurrency(p.value),
    change: formatChange(p.countChangePct, win.granularity) ?? '—',
  }));
}

/** Resolves each column's formatted string, falling back to the render function -- same convention
 * already used on pipeline-health/page.tsx's PDF exports, copied here rather than shared since
 * neither page imports from the other. */
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

/**
 * Pipeline Trend page (Sales, Level 3) -- seventh live Sales page. Its one interaction is the aging
 * drill-down: clicking a bucket of the Opportunities / Quotations aging bar lists the open records
 * behind it (names, customer, salesperson). Same architecture as every other page. All figures come
 * from backend/src/measures/pipelineTrend.ts, including an empirically-resolved Win Rate
 * definition (Fact_Sales.IsWonQuotation is always 0 live -- see that file's header comment for
 * what's used instead).
 */
export default function PipelineTrendPage() {
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

  const filterOptions = useScopedFilterOptions();
  const overview = usePipelineTrendOverview(token, anchorDate, effectiveFilters, authError, retryAuth);
  // The Opportunities / Quotations / Sales Orders charts follow one period selector (Weekly on every load).
  const [granularity, setGranularity] = useState<PeriodGranularity>(DEFAULT_GRANULARITY);
  const win = usePeriodWindow(granularity);
  const trend = usePeriodTrend<PipelineTrendPeriods>(token, 'pipeline-trend', anchorDate, effectiveFilters, granularity, authError, retryAuth);
  const trendData = trend.data?.granularity === granularity ? trend.data : null;
  const trendLoading = trend.loading || (trend.data !== null && !trendData);
  const periodColumns = periodTableColumns(win.changeLabel);
  const refreshStatus = useRefreshStatus(token, authError, retryAuth);
  const [downloadingPdf, setDownloadingPdf] = useState<string | null>(null);
  const [agingSelection, setAgingSelection] = useState<AgingSelection | null>(null);
  const agingDetails = usePipelineTrendAgingDetails(token, anchorDate, effectiveFilters, agingSelection, authError, retryAuth);
  const agingDrillRef = useRef<HTMLDivElement>(null);

  // Bring the drill-down into view when a bucket is clicked (it renders below both chart columns).
  useEffect(() => {
    if (agingSelection) agingDrillRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [agingSelection]);

  function handleAgingSegmentClick(label: string, segmentKey: string) {
    const category = AGING_CATEGORY_BY_LABEL[label];
    if (!category || !AGING_SEGMENTS.some((s) => s.key === segmentKey)) return;
    setAgingSelection({ category, bucket: segmentKey as AgingBucketKey });
  }

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

  const roleLabel = user?.role.label ?? user?.fullName;
  const lastRefreshLabel = refreshStatus.data ? formatTimestamp(refreshStatus.data.lastRefreshTime) : undefined;
  const data = overview.data;

  const opportunitiesSeries = trendData?.opportunities.points ?? [];
  const quotationsSeries = trendData?.quotations.points ?? [];
  const salesOrdersSeries = trendData?.salesOrders.points ?? [];

  const agingPoints = data
    ? [toAgingPercentPoint('Opportunities', data.aging.opportunities), toAgingPercentPoint('Quotations', data.aging.quotations)]
    : [];

  const rateTableRows = toRateTableRows(data?.quotationRates);
  const agingTableRows = toAgingTableRows(data?.aging);
  const opportunitiesTableRows = toPeriodTableRows(opportunitiesSeries, win);
  const quotationsTableRows = toPeriodTableRows(quotationsSeries, win);
  const salesOrdersTableRows = toPeriodTableRows(salesOrdersSeries, win);

  return (
    <PermissionGuard pageKey="pipeline_trend">
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

        <main style={{ flex: 1, padding: 'var(--ps-space-4, 24px)' }}>
          {/* alignItems left at its CSS Grid default ('stretch') rather than 'start' -- with
              'start' each column's height was just the sum of its own children, so the left
              column (Rates card + 1 aging chart) ended up visibly shorter than the right column
              (3 stacked combo-chart panels), leaving dead space under the Aging card. 'stretch'
              makes both column divs fill the row's full height (the taller column's height), and
              the Aging ChartPanel below picks up `flex: 1` to grow into that column's leftover
              space instead of leaving it empty. */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--ps-space-3, 16px)' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-3, 16px)' }}>
              <Card>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--ps-space-2, 8px)', gap: 8 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ps-color-text)' }}>Quotation Rates</span>
                    <VisualInfoIcons title="Quotation Rates" {...vh('promotion.pipelineTrend.quotationRates')} />
                  </span>
                  {!overview.error && (
                    <ExportPdfButton
                      downloading={downloadingPdf === 'rates'}
                      disabled={rateTableRows.length === 0}
                      onClick={() => handleDownloadTablePdf('rates', 'Quotation Rates', rateTableColumns, rateTableRows)}
                    />
                  )}
                </div>
                {overview.loading ? (
                  <LoadingSkeleton variant="kpi" />
                ) : overview.error ? (
                  <ErrorState message={overview.error} onRetry={overview.retry} />
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                    <RateTile label="Total Quotations YTD" value={formatCountOrDash(data?.quotationRates.totalQuotations)} />
                    <RateTile label="Won Quotations YTD" value={formatCountOrDash(data?.quotationRates.wonQuotations)} />
                    <RateTile label="Win Rate YTD" value={formatPercent(data?.quotationRates.winRatePct ?? null) ?? '—'} />
                    <RateTile label="Open Quotations YTD" value={formatCountOrDash(data?.quotationRates.openQuotations)} />
                    <RateTile label="Lost Quotations YTD" value={formatCountOrDash(data?.quotationRates.lostQuotations)} />
                    <RateTile label="Won/Lost Ratio YTD" value={formatRatio(data?.quotationRates)} />
                  </div>
                )}
              </Card>

              <ChartPanel<AgingTableRow>
                title="Open Opportunities & Quotations by Aging"
                {...vh('promotion.pipelineTrend.aging')}
                style={{ minHeight: 340, flex: '1 1 auto', height: 'auto' }}
                tableColumns={overview.error ? undefined : agingTableColumns}
                tableRows={overview.error ? undefined : agingTableRows}
                getRowId={(row) => row.id}
                headerActions={
                  !overview.error && (
                    <ExportPdfButton
                      downloading={downloadingPdf === 'aging'}
                      disabled={agingTableRows.length === 0}
                      onClick={() => handleDownloadTablePdf('aging', 'Open Opportunities & Quotations by Aging', agingTableColumns, agingTableRows)}
                    />
                  )
                }
              >
                {overview.loading ? (
                  <LoadingSkeleton variant="chart" />
                ) : overview.error ? (
                  <ErrorState message={overview.error} onRetry={overview.retry} />
                ) : (
                  <StackedPercentBarChart
                    title="Open Opportunities & Quotations by Aging"
                    showTitle={false}
                    points={agingPoints}
                    segments={AGING_SEGMENTS}
                    orientation="horizontal"
                    onSegmentClick={handleAgingSegmentClick}
                  />
                )}
              </ChartPanel>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-3, 16px)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                <span style={{ fontSize: 13, color: 'var(--ps-color-muted-text)' }} data-testid="trend-window">Trends: the {win.windowLabel}</span>
                <PeriodTrendSelector value={granularity} onChange={setGranularity} label="Pipeline Trend period" />
              </div>
              <PeriodComboPanel
                title="Opportunities"
                helpId="promotion.pipelineTrend.opportunities"
                series={opportunitiesSeries}
                win={win}
                columns={periodColumns}
                loading={trendLoading}
                error={trend.error ?? undefined}
                onRetry={trend.retry}
                tableRows={opportunitiesTableRows}
                downloading={downloadingPdf === 'opportunities'}
                onDownloadPdf={() => handleDownloadTablePdf('opportunities', `Opportunities · ${win.name}`, periodColumns, opportunitiesTableRows)}
              />
              <PeriodComboPanel
                title="Quotations"
                helpId="promotion.pipelineTrend.quotations"
                series={quotationsSeries}
                win={win}
                columns={periodColumns}
                loading={trendLoading}
                error={trend.error ?? undefined}
                onRetry={trend.retry}
                tableRows={quotationsTableRows}
                downloading={downloadingPdf === 'quotations'}
                onDownloadPdf={() => handleDownloadTablePdf('quotations', `Quotations · ${win.name}`, periodColumns, quotationsTableRows)}
              />
              <PeriodComboPanel
                title="Sales Orders"
                helpId="promotion.pipelineTrend.salesOrders"
                series={salesOrdersSeries}
                win={win}
                columns={periodColumns}
                loading={trendLoading}
                error={trend.error ?? undefined}
                onRetry={trend.retry}
                tableRows={salesOrdersTableRows}
                downloading={downloadingPdf === 'salesOrders'}
                onDownloadPdf={() => handleDownloadTablePdf('salesOrders', `Sales Orders · ${win.name}`, periodColumns, salesOrdersTableRows)}
              />
            </div>

            {/* Aging drill-down: full page width, under both chart columns. */}
            {agingSelection && data && (
              <div ref={agingDrillRef} style={{ gridColumn: '1 / -1', minWidth: 0, scrollMarginTop: 16 }}>
                <AgingDrillPanel
                  selection={agingSelection}
                  expectedCount={data.aging[agingSelection.category][agingSelection.bucket]}
                  details={agingDetails}
                  onClose={() => setAgingSelection(null)}
                />
              </div>
            )}
          </div>
        </main>

        <RefreshFooter
          lastUpdate={formatTimestamp(refreshStatus.data?.lastUpdate ?? null)}
          lastOrderCreated={formatTimestamp(refreshStatus.data?.lastOrderCreated ?? null)}
          lastRefreshTime={formatTimestamp(refreshStatus.data?.lastRefreshTime ?? null)}
        />

        <BottomNavBar active="Pipeline Trend" />
      </div>
    </PermissionGuard>
  );
}

/** The records behind one clicked aging bucket, as a sortable / filterable / exportable table. */
function AgingDrillPanel({
  selection,
  expectedCount,
  details,
  onClose,
}: {
  selection: AgingSelection;
  /** The bucket's count from the chart -- the list is built from the same query conditions, so its
   * length should always match. */
  expectedCount: number;
  details: ReturnType<typeof usePipelineTrendAgingDetails>;
  onClose: () => void;
}) {
  const bucketName = AGING_SEGMENTS.find((s) => s.key === selection.bucket)?.name ?? selection.bucket;
  const categoryName = AGING_CATEGORY_LABEL[selection.category];
  const rows = (details.data?.rows ?? []) as (AgingDetailRow & Record<string, unknown>)[];
  return (
    <ChartPanel
      title={`Open ${categoryName} — ${bucketName}`}
      {...vh('promotion.pipelineTrend.agingDrill')}
      style={{ minHeight: 240 }}
      headerActions={
        <button
          type="button"
          onClick={onClose}
          aria-label="Close drill-down"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ps-color-muted-text)', display: 'flex' }}
        >
          <X size={18} />
        </button>
      }
    >
      {details.loading ? (
        <LoadingSkeleton variant="chart" />
      ) : details.error ? (
        <ErrorState message={details.error} onRetry={details.retry} />
      ) : (
        <>
          <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', marginBottom: 8 }}>
            {rows.length.toLocaleString(DISPLAY_LOCALE)} open {categoryName.toLowerCase()} aged {bucketName}, oldest first.
            {rows.length !== expectedCount && ` (The chart counted ${expectedCount.toLocaleString(DISPLAY_LOCALE)} -- data may have refreshed since; reload the page.)`}
          </div>
          <DataGrid
            columns={agingDetailColumns(selection.category, rows)}
            rows={rows}
            getRowId={(row) => row.id}
            fileName={`aging-${selection.category}-${selection.bucket}`}
            pageSize={25}
          />
        </>
      )}
    </ChartPanel>
  );
}

function RateTile({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: 'var(--ps-color-muted-bg)', borderRadius: 'var(--ps-card-radius-sm, 10px)', padding: '10px 8px', textAlign: 'center' }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--ps-color-text)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div style={{ fontSize: 10, color: 'var(--ps-color-muted-text)', marginTop: 2 }}>{label}</div>
    </div>
  );
}

function PeriodComboPanel({
  title,
  helpId,
  series,
  win,
  columns,
  loading,
  error,
  onRetry,
  tableRows,
  downloading,
  onDownloadPdf,
}: {
  title: string;
  helpId: VisualHelpId;
  series: PeriodComparisonPoint[];
  win: PeriodWindowView;
  columns: Column<PeriodTableRow>[];
  loading: boolean;
  error?: string;
  onRetry: () => void;
  tableRows: PeriodTableRow[];
  downloading: boolean;
  onDownloadPdf: () => void;
}) {
  const points = toPeriodChartPoints(series, win);
  return (
    <ChartPanel<PeriodTableRow>
      title={title}
      {...vh(helpId)}
      style={{ minHeight: 260 }}
      tableColumns={error ? undefined : columns}
      tableRows={error ? undefined : tableRows}
      getRowId={(row) => row.id}
      headerActions={
        !error && <ExportPdfButton downloading={downloading} disabled={tableRows.length === 0} onClick={onDownloadPdf} />
      }
    >
      {loading ? (
        <LoadingSkeleton variant="chart" />
      ) : error ? (
        <ErrorState message={error} onRetry={onRetry} />
      ) : (
        <ComboChart
          title={title}
          showTitle={false}
          points={points}
          bars={PERIOD_CHART_BARS}
          lines={PERIOD_CHART_LINES}
          leftAxisFormatter={formatPlainNumber}
          rightAxisFormatter={formatCompactNumber}
          tooltipFormatters={{
            count: (v, p) => {
              const change = typeof p?.countChange === 'number' ? formatChange(p.countChange, win.granularity) : null;
              return change ? `${v.toLocaleString(DISPLAY_LOCALE)} (${change})` : v.toLocaleString(DISPLAY_LOCALE);
            },
            value: (v) => formatCurrency(v),
          }}
          tooltipLabelFormatter={win.tooltipTitle(series)}
          inProgressLabel={win.inProgressLabel(series)}
          height={220}
        />
      )}
    </ChartPanel>
  );
}
