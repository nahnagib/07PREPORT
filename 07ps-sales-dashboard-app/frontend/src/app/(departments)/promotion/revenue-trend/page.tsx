'use client';
import React, { useState } from 'react';
import { FileDown } from 'lucide-react';
import { AppHeader } from '../../../../components/AppHeader';
import { FilterBar } from '../../../../components/FilterBar';
import { BottomNavBar } from '../../../../components/BottomNavBar';
import { ValidationStatusBar } from '../../../../components/ValidationStatusBar';
import { RefreshFooter } from '../../../../components/RefreshFooter';
import { useFilterState } from '../../../../components/FilterProvider';
import {
  ChartPanel,
  InsightCard,
  LoadingSkeleton,
  ErrorState,
  TrendChart,
  exportRowsAsPdf,
  type Column,
  type TrendPoint,
} from '@07ps/ui';
import { useAuth } from '../../../../lib/AuthProvider';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useFilterOptions, useRevenueTrendOverview, useRefreshStatus, useExportOverviewReport } from '../../../../lib/hooks';
import type { RevenueTrendMonthPoint, RevenueTrendVarianceCard } from '../../../../lib/api';
import { formatAsp, formatCurrency, formatTimestamp, formatVariance, formatVolume } from '../../../../lib/format';

/** Y-axis tick formatter: currency/volume in millions with an "M" suffix (e.g. "5M", "0.3M"),
 * one decimal place unless it rounds to a whole number. */
function formatMillions(value: number): string {
  const fixed = (value / 1_000_000).toFixed(1);
  return `${fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed}M`;
}

/** ASP y-axis: plain, unprefixed number -- full LYD/2-decimal precision is reserved for the
 * hover tooltip (formatAsp), per the chart spec. */
function formatPlainNumber(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function formatAspOrDash(value: number | null): string {
  return value === null ? '—' : formatAsp(value);
}

interface TrendTableRow extends Record<string, unknown> {
  month: string;
  actual: string;
  lastYear: string;
  target: string;
}

const trendTableColumns: Column<TrendTableRow>[] = [
  { key: 'month', header: 'Month' },
  { key: 'actual', header: 'Actual', align: 'right' },
  { key: 'lastYear', header: 'Y-1', align: 'right' },
  { key: 'target', header: 'Target', align: 'right' },
];

function toTableRows(
  series: RevenueTrendMonthPoint[],
  pick: (p: RevenueTrendMonthPoint) => { actual: number | null; lastYear: number | null; target: number | null },
  formatter: (v: number | null) => string,
): TrendTableRow[] {
  return series.map((p) => {
    const { actual, lastYear, target } = pick(p);
    return { month: p.label, actual: formatter(actual), lastYear: formatter(lastYear), target: formatter(target) };
  });
}

/** "Export as PDF" header action for a ChartPanel's data table -- same visual shell and
 * disabled/loading treatment as pipeline-health/page.tsx's own handleDownloadPdf button, so PDF
 * export reads as one consistent affordance across the app rather than a page-specific one-off. */
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
 * Revenue Trend page (Sales, Level 3) -- third live Sales page after Tachometer and Critical
 * Number, built to the exact same architecture (AppHeader + FilterBar + ValidationStatusBar +
 * BottomNavBar, PermissionGuard pageKey='revenue_trend', same useAuth/useFilterOptions/
 * useRefreshStatus hooks, same @07ps/ui primitives) so it is indistinguishable in look/behavior
 * from the rest of the platform.
 *
 * All figures come from backend/src/measures/revenueTrend.ts, which reuses the exact same
 * fetchValueVolume/fetchTargetForMonths/computeMtdCard/computeYtdCard/computeAspCard primitives
 * Tachometer's own cards are built on -- a Revenue Trend figure can never disagree with the
 * equivalent Tachometer card for the same anchor/filters.
 */
export default function RevenueTrendPage() {
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
  const overview = useRevenueTrendOverview(token, anchorDate, effectiveFilters, authError, retryAuth);
  const refreshStatus = useRefreshStatus(token, authError, retryAuth);
  const exportReport = useExportOverviewReport(token, anchorDate, effectiveFilters);
  const [downloadingPdf, setDownloadingPdf] = useState<string | null>(null);

  function handleReset() {
    resetFilters();
  }

  function handleRefresh() {
    overview.retry();
    refreshStatus.retry();
  }

  const roleLabel = user?.role.label ?? user?.fullName;
  const lastRefreshLabel = refreshStatus.data ? formatTimestamp(refreshStatus.data.lastRefreshTime) : undefined;
  const series = overview.data?.series ?? [];

  const valuePoints: TrendPoint[] = series.map((p) => ({ label: p.label, actual: p.value, lastYear: p.lastYearValue, target: p.targetValue }));
  const volumePoints: TrendPoint[] = series.map((p) => ({ label: p.label, actual: p.volume, lastYear: p.lastYearVolume, target: p.targetVolume }));
  const aspPoints: TrendPoint[] = series.map((p) => ({ label: p.label, actual: p.asp ?? 0, lastYear: p.lastYearAsp, target: p.targetAsp }));

  const valueTableRows = toTableRows(series, (p) => ({ actual: p.value, lastYear: p.lastYearValue, target: p.targetValue }), (v) => (v === null ? '—' : formatCurrency(v)));
  const volumeTableRows = toTableRows(series, (p) => ({ actual: p.volume, lastYear: p.lastYearVolume, target: p.targetVolume }), (v) => (v === null ? '—' : formatVolume(v)));
  const aspTableRows = toTableRows(series, (p) => ({ actual: p.asp, lastYear: p.lastYearAsp, target: p.targetAsp }), formatAspOrDash);

  const kpis = overview.data?.kpis;

  // Exports the full series (every month, not just what's visible without scrolling) -- same
  // trendTableColumns/rows the expanded table view renders, so the PDF always matches it exactly.
  async function handleDownloadTablePdf(key: string, title: string, rows: TrendTableRow[]) {
    setDownloadingPdf(key);
    try {
      await exportRowsAsPdf({
        title,
        columns: trendTableColumns.map((c) => ({ header: c.header, align: c.align })),
        rows: rows.map((row) => [row.month, row.actual, row.lastYear, row.target]),
        fileName: `${title.toLowerCase().replace(/\s+/g, '-')}`,
      });
    } finally {
      setDownloadingPdf(null);
    }
  }

  return (
    <PermissionGuard pageKey="revenue_trend">
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
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))',
              gap: 'var(--ps-space-3, 16px)',
              alignItems: 'stretch',
            }}
          >
            <ChartPanel<TrendTableRow>
              title="MoM Value"
              infoText="Monthly Actual vs Y-1 vs Target value."
              style={{ minHeight: 360 }}
              tableColumns={overview.error ? undefined : trendTableColumns}
              tableRows={overview.error ? undefined : valueTableRows}
              getRowId={(row) => row.month}
              headerActions={
                !overview.error && (
                  <ExportPdfButton
                    downloading={downloadingPdf === 'value'}
                    disabled={valueTableRows.length === 0}
                    onClick={() => handleDownloadTablePdf('value', 'MoM Value', valueTableRows)}
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
                  title="MoM Value"
                  showTitle={false}
                  points={valuePoints}
                  valueFormatter={formatMillions}
                  tooltipValueFormatter={(v) => formatCurrency(v)}
                  lastYearColor="var(--ps-color-trend-y1)"
                  targetColor="var(--ps-color-trend-target)"
                />
              )}
            </ChartPanel>

            <ChartPanel<TrendTableRow>
              title="MoM Volume"
              infoText="Monthly Actual vs Y-1 vs Target volume."
              style={{ minHeight: 360 }}
              tableColumns={overview.error ? undefined : trendTableColumns}
              tableRows={overview.error ? undefined : volumeTableRows}
              getRowId={(row) => row.month}
              headerActions={
                !overview.error && (
                  <ExportPdfButton
                    downloading={downloadingPdf === 'volume'}
                    disabled={volumeTableRows.length === 0}
                    onClick={() => handleDownloadTablePdf('volume', 'MoM Volume', volumeTableRows)}
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
                  title="MoM Volume"
                  showTitle={false}
                  points={volumePoints}
                  valueFormatter={formatMillions}
                  tooltipValueFormatter={(v) => formatVolume(v)}
                  lastYearColor="var(--ps-color-trend-y1)"
                  targetColor="var(--ps-color-trend-target)"
                />
              )}
            </ChartPanel>

            <ChartPanel<TrendTableRow>
              title="MoM ASP"
              infoText="Monthly Average Selling Price: Actual vs Y-1 vs Target."
              style={{ minHeight: 360 }}
              tableColumns={overview.error ? undefined : trendTableColumns}
              tableRows={overview.error ? undefined : aspTableRows}
              getRowId={(row) => row.month}
              headerActions={
                !overview.error && (
                  <ExportPdfButton
                    downloading={downloadingPdf === 'asp'}
                    disabled={aspTableRows.length === 0}
                    onClick={() => handleDownloadTablePdf('asp', 'MoM ASP', aspTableRows)}
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
                  title="MoM ASP"
                  showTitle={false}
                  points={aspPoints}
                  valueFormatter={formatPlainNumber}
                  tooltipValueFormatter={(v) => formatAsp(v)}
                  lastYearColor="var(--ps-color-trend-y1)"
                  targetColor="var(--ps-color-trend-target)"
                />
              )}
            </ChartPanel>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gridTemplateRows: 'repeat(2, 1fr)',
                gap: 'var(--ps-space-3, 16px)',
                minHeight: 360,
              }}
            >
              <VarianceCard title="Value Variance to YTD Target" card={kpis?.valueVarianceYtd} loading={overview.loading} error={overview.error ?? undefined} onRetry={overview.retry} />
              <VarianceCard title="Volume Variance to YTD Target" card={kpis?.volumeVarianceYtd} loading={overview.loading} error={overview.error ?? undefined} onRetry={overview.retry} />
              <VarianceCard title="ASP Variance to YTD Target" card={kpis?.aspVarianceYtd} loading={overview.loading} error={overview.error ?? undefined} onRetry={overview.retry} />
              <VarianceCard title="Value Variance to MTD Target" card={kpis?.valueVarianceMtd} loading={overview.loading} error={overview.error ?? undefined} onRetry={overview.retry} />
              <VarianceCard title="Volume Variance to MTD Target" card={kpis?.volumeVarianceMtd} loading={overview.loading} error={overview.error ?? undefined} onRetry={overview.retry} />
              <VarianceCard title="ASP Variance to MTD Target" card={kpis?.aspVarianceMtd} loading={overview.loading} error={overview.error ?? undefined} onRetry={overview.retry} />
            </div>
          </div>
        </main>

        <RefreshFooter
          lastUpdate={formatTimestamp(refreshStatus.data?.lastUpdate ?? null)}
          lastOrderCreated={formatTimestamp(refreshStatus.data?.lastOrderCreated ?? null)}
          lastRefreshTime={formatTimestamp(refreshStatus.data?.lastRefreshTime ?? null)}
        />

        <BottomNavBar active="Revenue Trend" />
      </div>
    </PermissionGuard>
  );
}

/**
 * One of the six MTD/YTD variance KPI cards. Reuses @07ps/ui's InsightCard directly -- flag=0
 * ("bad") gets the alert-tinted card background (accentBg=true), flag=1 ("good") renders on the
 * plain/default card surface (accentBg=false), per the "hard on/off, not a gradient" spec. Same
 * success/alert status-tint convention InsightCard already uses everywhere else in the app.
 */
function VarianceCard({
  title,
  card,
  loading,
  error,
  onRetry,
}: {
  title: string;
  card?: RevenueTrendVarianceCard;
  loading: boolean;
  error?: string;
  onRetry: () => void;
}) {
  if (error) {
    return (
      <div style={{ borderRadius: 'var(--ps-card-radius, 14px)', border: '1px solid var(--ps-color-border)', padding: 'var(--ps-card-padding, 16px)', height: '100%' }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--ps-color-muted-text)' }}>{title}</div>
        <ErrorState message={error} onRetry={onRetry} />
      </div>
    );
  }
  const bad = card?.flag === 0;
  return (
    <InsightCard
      label={title}
      value={card ? formatVariance(card.variancePct) ?? '—' : '—'}
      status={card == null ? 'neutral' : bad ? 'alert' : 'success'}
      accentBg={bad}
      loading={loading}
    />
  );
}
