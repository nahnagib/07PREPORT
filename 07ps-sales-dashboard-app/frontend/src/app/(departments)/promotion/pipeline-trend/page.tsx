'use client';
import React, { useState } from 'react';
import { FileDown } from 'lucide-react';
import { AppHeader } from '../../../../components/AppHeader';
import { FilterBar } from '../../../../components/FilterBar';
import { BottomNavBar } from '../../../../components/BottomNavBar';
import { ValidationStatusBar } from '../../../../components/ValidationStatusBar';
import { RefreshFooter } from '../../../../components/RefreshFooter';
import { useFilterState } from '../../../../components/FilterProvider';
import { Card, ChartPanel, ComboChart, StackedPercentBarChart, LoadingSkeleton, ErrorState, exportRowsAsPdf, type Column } from '@07ps/ui';
import { useAuth } from '../../../../lib/AuthProvider';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useFilterOptions, usePipelineTrendOverview, useRefreshStatus, useExportOverviewReport } from '../../../../lib/hooks';
import type { AgingBuckets, AgingDistribution, MonthComparisonPoint, QuotationRates } from '../../../../lib/api';
import { formatCurrency, formatTimestamp, formatVariance } from '../../../../lib/format';

function formatMillions(value: number): string {
  const fixed = (value / 1_000_000).toFixed(1);
  return `${fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed}M`;
}

function formatPlainNumber(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function formatCountOrDash(v: number | undefined): string {
  return v != null ? v.toLocaleString() : '—';
}

function formatRatio(v: number | null | undefined): string {
  return v != null ? v.toFixed(2) : '—';
}

function toMonthChartPoints(series: MonthComparisonPoint[]) {
  return series.map((p) => ({
    label: p.label,
    countYtd: p.countYtd,
    countLytd: p.countLytd,
    valueYtd: p.valueYtd,
    valueLytd: p.valueLytd,
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

const MONTH_CHART_BARS = [
  { key: 'countYtd', name: '#YTD', color: 'var(--ps-color-accent)' },
  { key: 'countLytd', name: '#LYTD', color: 'var(--ps-color-last-year)' },
];
const MONTH_CHART_LINES = [
  { key: 'valueYtd', name: 'Value YTD', color: 'var(--ps-color-gold)', yAxisId: 'right' as const },
  { key: 'valueLytd', name: 'Value LYTD', color: 'var(--ps-color-neutral-text)', yAxisId: 'right' as const },
];

// ---------------------------------------------------------------------------
// PDF summary-table export -- same exportRowsAsPdf mechanism as Revenue Trend, applied to every
// visual on this page. Quotation Rates' table explicitly includes Won/Lost figures (the page's
// on-screen aging/month charts only show active-pipeline stages, so the export is the one place
// Won/Lost data is guaranteed to appear, per the requirement that it not be limited to what the
// charts show).
// ---------------------------------------------------------------------------

function formatCountOrDashPdf(v: number | undefined): string {
  return v != null ? v.toLocaleString() : '—';
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
    { id: 'winRate', metric: 'Win Rate YTD', value: formatVariance(rates.winRatePct) ?? '—' },
    { id: 'open', metric: 'Open Quotations YTD', value: formatCountOrDashPdf(rates.openQuotations) },
    { id: 'lost', metric: 'Lost Quotations YTD', value: formatCountOrDashPdf(rates.lostQuotations) },
    { id: 'ratio', metric: 'Won/Lost Ratio YTD', value: rates.wonLostRatio != null ? rates.wonLostRatio.toFixed(2) : '—' },
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

interface MonthTableRow extends Record<string, unknown> {
  id: string;
  month: string;
  countYtd: number;
  countLytd: number;
  valueYtd: string;
  valueLytd: string;
}
const monthTableColumns: Column<MonthTableRow>[] = [
  { key: 'month', header: 'Month' },
  { key: 'countYtd', header: '#YTD', align: 'right' },
  { key: 'countLytd', header: '#LYTD', align: 'right' },
  { key: 'valueYtd', header: 'Value YTD', align: 'right' },
  { key: 'valueLytd', header: 'Value LYTD', align: 'right' },
];
function toMonthTableRows(series: MonthComparisonPoint[]): MonthTableRow[] {
  return series.map((p) => ({
    id: p.label,
    month: p.label,
    countYtd: p.countYtd,
    countLytd: p.countLytd,
    valueYtd: formatCurrency(p.valueYtd),
    valueLytd: formatCurrency(p.valueLytd),
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
 * Pipeline Trend page (Sales, Level 3) -- seventh live Sales page, read-only per spec (no
 * drill-down/click-filter interactions). Same architecture as every other page. All figures come
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
    resetFilters,
  } = useFilterState();

  const filterOptions = useFilterOptions(token, authError, retryAuth);
  const overview = usePipelineTrendOverview(token, anchorDate, effectiveFilters, authError, retryAuth);
  const refreshStatus = useRefreshStatus(token, authError, retryAuth);
  const exportReport = useExportOverviewReport(token, anchorDate, effectiveFilters);
  const [downloadingPdf, setDownloadingPdf] = useState<string | null>(null);

  function handleReset() {
    resetFilters();
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

  function handleRefresh() {
    overview.retry();
    refreshStatus.retry();
  }

  const roleLabel = user?.role.label ?? user?.fullName;
  const lastRefreshLabel = refreshStatus.data ? formatTimestamp(refreshStatus.data.lastRefreshTime) : undefined;
  const data = overview.data;

  const opportunitiesPoints = toMonthChartPoints(data?.opportunitiesByMonth ?? []);
  const quotationsPoints = toMonthChartPoints(data?.quotationsByMonth ?? []);
  const salesOrdersPoints = toMonthChartPoints(data?.salesOrdersByMonth ?? []);

  const agingPoints = data
    ? [toAgingPercentPoint('Opportunities', data.aging.opportunities), toAgingPercentPoint('Quotations', data.aging.quotations)]
    : [];

  const rateTableRows = toRateTableRows(data?.quotationRates);
  const agingTableRows = toAgingTableRows(data?.aging);
  const opportunitiesTableRows = toMonthTableRows(data?.opportunitiesByMonth ?? []);
  const quotationsTableRows = toMonthTableRows(data?.quotationsByMonth ?? []);
  const salesOrdersTableRows = toMonthTableRows(data?.salesOrdersByMonth ?? []);

  return (
    <PermissionGuard pageKey="pipeline_trend">
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
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--ps-space-3, 16px)', alignItems: 'start' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-3, 16px)' }}>
              <Card>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--ps-space-2, 8px)', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ps-color-text)' }}>Quotation Rates</span>
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
                    <RateTile label="Win Rate YTD" value={formatVariance(data?.quotationRates.winRatePct ?? null) ?? '—'} />
                    <RateTile label="Open Quotations YTD" value={formatCountOrDash(data?.quotationRates.openQuotations)} />
                    <RateTile label="Lost Quotations YTD" value={formatCountOrDash(data?.quotationRates.lostQuotations)} />
                    <RateTile label="Won/Lost Ratio YTD" value={formatRatio(data?.quotationRates.wonLostRatio)} />
                  </div>
                )}
              </Card>

              <ChartPanel<AgingTableRow>
                title="Open Opportunities & Quotations by Aging"
                infoText="Open Opportunities and open Quotations, each as a 100%-stacked column by age bucket. A healthy pipeline concentrates in 0-30 days with low 90+."
                style={{ minHeight: 340 }}
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
                  <StackedPercentBarChart title="Open Opportunities & Quotations by Aging" showTitle={false} points={agingPoints} segments={AGING_SEGMENTS} />
                )}
              </ChartPanel>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-3, 16px)' }}>
              <MonthComboPanel
                title="Opportunities"
                points={opportunitiesPoints}
                loading={overview.loading}
                error={overview.error ?? undefined}
                onRetry={overview.retry}
                tableRows={opportunitiesTableRows}
                downloading={downloadingPdf === 'opportunities'}
                onDownloadPdf={() => handleDownloadTablePdf('opportunities', 'Opportunities', monthTableColumns, opportunitiesTableRows)}
              />
              <MonthComboPanel
                title="Quotations"
                points={quotationsPoints}
                loading={overview.loading}
                error={overview.error ?? undefined}
                onRetry={overview.retry}
                tableRows={quotationsTableRows}
                downloading={downloadingPdf === 'quotations'}
                onDownloadPdf={() => handleDownloadTablePdf('quotations', 'Quotations', monthTableColumns, quotationsTableRows)}
              />
              <MonthComboPanel
                title="Sales Orders"
                points={salesOrdersPoints}
                loading={overview.loading}
                error={overview.error ?? undefined}
                onRetry={overview.retry}
                tableRows={salesOrdersTableRows}
                downloading={downloadingPdf === 'salesOrders'}
                onDownloadPdf={() => handleDownloadTablePdf('salesOrders', 'Sales Orders', monthTableColumns, salesOrdersTableRows)}
              />
            </div>
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

function RateTile({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: 'var(--ps-color-muted-bg)', borderRadius: 'var(--ps-card-radius-sm, 10px)', padding: '10px 8px', textAlign: 'center' }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--ps-color-text)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div style={{ fontSize: 10, color: 'var(--ps-color-muted-text)', marginTop: 2 }}>{label}</div>
    </div>
  );
}

function MonthComboPanel({
  title,
  points,
  loading,
  error,
  onRetry,
  tableRows,
  downloading,
  onDownloadPdf,
}: {
  title: string;
  points: ReturnType<typeof toMonthChartPoints>;
  loading: boolean;
  error?: string;
  onRetry: () => void;
  tableRows: MonthTableRow[];
  downloading: boolean;
  onDownloadPdf: () => void;
}) {
  return (
    <ChartPanel<MonthTableRow>
      title={title}
      style={{ minHeight: 260 }}
      tableColumns={error ? undefined : monthTableColumns}
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
          bars={MONTH_CHART_BARS}
          lines={MONTH_CHART_LINES}
          leftAxisFormatter={formatPlainNumber}
          rightAxisFormatter={formatMillions}
          tooltipFormatters={{
            countYtd: (v) => v.toLocaleString(),
            countLytd: (v) => v.toLocaleString(),
            valueYtd: (v) => formatCurrency(v),
            valueLytd: (v) => formatCurrency(v),
          }}
          height={220}
        />
      )}
    </ChartPanel>
  );
}
