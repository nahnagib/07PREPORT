'use client';
import React, { useState } from 'react';
import { FileDown } from 'lucide-react';
import { AppHeader } from '../../../../components/AppHeader';
import { FilterBar } from '../../../../components/FilterBar';
import { BottomNavBar } from '../../../../components/BottomNavBar';
import { ValidationStatusBar } from '../../../../components/ValidationStatusBar';
import { RefreshFooter } from '../../../../components/RefreshFooter';
import { useFilterState, useScopedFilterOptions } from '../../../../components/FilterProvider';
import { standardFilterBarProps } from '../../../../components/standardFilterBarProps';
import {
  ChartPanel,
  InsightCard,
  LoadingSkeleton,
  ErrorState,
  TrendChart,
  chartColors,
  exportRowsAsPdf,
  exportPerformanceTablePdf,
  PerformanceReportTable,
  SEMANTIC_STATUS_LABEL,
  type Column,
  type TrendPoint,
  type PerformanceReportRow,
  type PerformanceTablePdfColumn,
  useCanExport,
} from '@07ps/ui';
import { useAuth } from '../../../../lib/AuthProvider';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { usePeriodTrend, useRevenueTrendOverview, useRefreshStatus } from '../../../../lib/hooks';
import type { PeriodGranularity, RevenueTrendPeriodPoint, RevenueTrendPeriods, RevenueTrendPerformanceRow, RevenueTrendVarianceCard } from '../../../../lib/api';
import { DEFAULT_GRANULARITY, formatChange, usePeriodWindow, type PeriodWindowView } from '../../../../lib/periods';
import { PeriodTrendSelector } from '../../../../components/PeriodTrendSelector';
import { formatAsp, formatCompactNumber, formatCurrency, formatTimestamp, formatVariance, formatVolume, toSemanticStatus, DISPLAY_LOCALE } from '../../../../lib/format';
import { vh } from '../../../../lib/visualHelp';

/** ASP y-axis: plain, unprefixed number -- full LYD/2-decimal precision is reserved for the
 * hover tooltip (formatAsp), per the chart spec. */
function formatPlainNumber(value: number): string {
  return value.toLocaleString(DISPLAY_LOCALE, { maximumFractionDigits: 0 });
}

function formatAspOrDash(value: number | null): string {
  return value === null ? '—' : formatAsp(value);
}

// ---------------------------------------------------------------------------
// Performance Details -- the page's single summary table: Value / Volume / ASP x YTD / MTD. Every
// figure comes from the backend's performanceDetails rows (the same computeYtdCard/computeMtdCard
// cards the variance cards and the Tachometer use), so a row can never disagree with them. "Last" is
// LYTD on a YTD row and LMTD on an MTD row (both are the same window one year back, as on the
// Tachometer); Variance to Last / Variance to Target are (actual - base) / base, same as there.
// ---------------------------------------------------------------------------

function varianceTakeaway(label: string, status: string, variancePct: number | null): string {
  const varianceLabel = variancePct != null ? formatVariance(variancePct) ?? null : null;
  if (status === 'green') return `${label} is on target${varianceLabel ? ` (${varianceLabel})` : ''}.`;
  if (status === 'yellow') return `${label} is slightly behind target${varianceLabel ? ` (${varianceLabel})` : ''}.`;
  if (status === 'red') return `${label} is well behind target${varianceLabel ? ` (${varianceLabel})` : ''} and needs attention.`;
  return `No target set for ${label}.`;
}

const PERFORMANCE_ROW_META: Record<
  RevenueTrendPerformanceRow['metric'],
  { name: string; format: (v: number | null) => string; ytdTakeaway: string; mtdTakeaway: string }
> = {
  value: { name: 'Value', format: (v) => (v === null ? '—' : formatCurrency(v)), ytdTakeaway: 'Sales value YTD', mtdTakeaway: 'Sales value this month' },
  volume: { name: 'Volume', format: (v) => (v === null ? '—' : formatVolume(v)), ytdTakeaway: 'Sales volume YTD', mtdTakeaway: 'Sales volume this month' },
  asp: { name: 'ASP', format: formatAspOrDash, ytdTakeaway: 'Average selling price YTD', mtdTakeaway: 'Average selling price this month' },
};

function toPerformanceRows(details?: RevenueTrendPerformanceRow[]): PerformanceReportRow[] {
  return (details ?? []).map((r) => {
    const meta = PERFORMANCE_ROW_META[r.metric];
    const period = r.period.toUpperCase();
    return {
      id: r.key,
      metric: `${meta.name} (${period})`,
      actualLabel: meta.format(r.actual),
      targetLabel: meta.format(r.target),
      variancePct: r.variancePct,
      varianceLyPct: r.varianceLastPct,
      lytdLabel: meta.format(r.last),
      lytdFullValue: `${r.period === 'ytd' ? 'LYTD' : 'LMTD'}: ${meta.format(r.last)}`,
      status: toSemanticStatus(r.status),
      takeaway: varianceTakeaway(r.period === 'ytd' ? meta.ytdTakeaway : meta.mtdTakeaway, r.status, r.variancePct),
    };
  });
}

// Matches PerformanceReportTable's showLytdColumn layout (Metric Name / Actual / Last / Target /
// Variance to Last / Variance to Target / Status / Takeaway), so the PDF mirrors the on-screen table.
function pct(v: number | null): string {
  return v !== null ? `${(v * 100).toFixed(2)}%` : '—';
}
const PERFORMANCE_PDF_COLUMNS: PerformanceTablePdfColumn[] = [
  { header: 'Metric Name', getValue: (row) => row.metric },
  { header: 'Actual', getValue: (row) => row.actualLabel },
  { header: 'Last', getValue: (row) => row.lytdLabel ?? '—' },
  { header: 'Target', getValue: (row) => row.targetLabel },
  { header: 'Variance to Last', getValue: (row) => pct(row.varianceLyPct) },
  { header: 'Variance to Target', getValue: (row) => pct(row.variancePct) },
  { header: 'Status', getValue: (row) => (row.status ? SEMANTIC_STATUS_LABEL[row.status] : '—') },
  { header: 'Takeaway', getValue: (row) => row.takeaway ?? '—' },
];

interface TrendTableRow extends Record<string, unknown> {
  period: string;
  actual: string;
  lastYear: string;
  target: string;
  change: string;
}

/** Period / Actual / Same period LY / Target (Monthly and Yearly only) / change against the previous period (DoD / WoW /
 * MoM / YoY, following the granularity). */
function trendTableColumns(win: PeriodWindowView, hasTarget: boolean): Column<TrendTableRow>[] {
  return [
    { key: 'period', header: 'Period' },
    { key: 'actual', header: 'Actual', align: 'right' },
    { key: 'lastYear', header: 'Same period LY', align: 'right' },
    ...(hasTarget ? [{ key: 'target', header: 'Target', align: 'right' } as Column<TrendTableRow>] : []),
    { key: 'change', header: `Change ${win.changeLabel}`, align: 'right' },
  ];
}

function toTableRows(
  points: RevenueTrendPeriodPoint[],
  win: PeriodWindowView,
  pick: (p: RevenueTrendPeriodPoint) => { actual: number | null; lastYear: number | null; target: number | null; change: number | null },
  formatter: (v: number | null) => string,
): TrendTableRow[] {
  return points.map((p) => {
    const { actual, lastYear, target, change } = pick(p);
    return {
      period: `${win.title(p.start)}${p.inProgress ? ' (in progress)' : ''}`,
      actual: formatter(actual),
      lastYear: formatter(lastYear),
      target: formatter(target),
      change: formatChange(change, win.granularity) ?? '—',
    };
  });
}

/** The chart points of one measure: actual, the same period last year and (Monthly / Yearly) the target. ASP is null
 * where nothing was sold, so its line shows a gap instead of a fake 0. */
function toTrendPoints(points: RevenueTrendPeriodPoint[], win: PeriodWindowView, pick: (p: RevenueTrendPeriodPoint) => [number | null, number | null, number | null]): TrendPoint[] {
  return points.map((p) => {
    const [actual, lastYear, target] = pick(p);
    return { label: win.label(p.start), actual: actual as number, lastYear, target };
  });
}

/** "Export as PDF" header action for a ChartPanel's data table -- same visual shell and
 * disabled/loading treatment as pipeline-health/page.tsx's own handleDownloadPdf button, so PDF
 * export reads as one consistent affordance across the app rather than a page-specific one-off. */
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
  const filterState = useFilterState();
  const { effectiveFilters, anchorDate, dateFromDate, dateToDate, onAnchorDateChange } = filterState;

  const filterOptions = useScopedFilterOptions();
  const overview = useRevenueTrendOverview(token, anchorDate, effectiveFilters, authError, retryAuth);
  // The period selector: Weekly on every load, per page (not saved). Only the three trends reload when it changes.
  const [granularity, setGranularity] = useState<PeriodGranularity>(DEFAULT_GRANULARITY);
  const win = usePeriodWindow(granularity);
  const trend = usePeriodTrend<RevenueTrendPeriods>(token, 'revenue-trend', anchorDate, effectiveFilters, granularity, authError, retryAuth);
  const refreshStatus = useRefreshStatus(token, authError, retryAuth);
  const [downloadingPdf, setDownloadingPdf] = useState<string | null>(null);

  const roleLabel = user?.role.label ?? user?.fullName;
  const lastRefreshLabel = refreshStatus.data ? formatTimestamp(refreshStatus.data.lastRefreshTime) : undefined;
  // Show the points of the granularity just asked for (a slow previous response never relabels the axis).
  const series = trend.data?.granularity === granularity ? trend.data.points : [];
  const hasTarget = trend.data?.hasTarget ?? false;
  const inProgressLabel = win.inProgressLabel(series);
  const tooltipTitle = win.tooltipTitle(series);
  const tableColumns = trendTableColumns(win, hasTarget);

  const valuePoints = toTrendPoints(series, win, (p) => [p.value, p.lastYearValue, p.targetValue]);
  const volumePoints = toTrendPoints(series, win, (p) => [p.volume, p.lastYearVolume, p.targetVolume]);
  const aspPoints = toTrendPoints(series, win, (p) => [p.asp, p.lastYearAsp, p.targetAsp]);

  const money = (v: number | null) => (v === null ? '—' : formatCurrency(v));
  const qty = (v: number | null) => (v === null ? '—' : formatVolume(v));
  const valueTableRows = toTableRows(series, win, (p) => ({ actual: p.value, lastYear: p.lastYearValue, target: p.targetValue, change: p.valueChangePct }), money);
  const volumeTableRows = toTableRows(series, win, (p) => ({ actual: p.volume, lastYear: p.lastYearVolume, target: p.targetVolume, change: p.volumeChangePct }), qty);
  const aspTableRows = toTableRows(series, win, (p) => ({ actual: p.asp, lastYear: p.lastYearAsp, target: p.targetAsp, change: p.aspChangePct }), formatAspOrDash);
  const trendLoading = trend.loading || (trend.data !== null && trend.data.granularity !== granularity);

  const kpis = overview.data?.kpis;

  function buildFilterSummaryParts(): string[] {
    const f = effectiveFilters;
    const parts: string[] = [];
    if (dateFromDate && dateToDate) {
      parts.push(dateFromDate === dateToDate ? `Date: ${dateFromDate}` : `Date Range: ${dateFromDate} to ${dateToDate}`);
    }
    const add = (label: string, names?: (string | number | null)[]) => {
      if (names?.length) parts.push(`${label}: ${names.join(', ')}`);
    };
    if (f.companyKeys?.length) {
      add('Company', filterOptions.businessUnits.data?.filter((b) => f.companyKeys!.includes(b.company_key as number)).map((b) => b.company_name));
    }
    if (f.segmentKeys?.length) {
      add('Customer Group', filterOptions.customerGroups.data?.filter((s) => f.segmentKeys!.includes(s.segment_key as number)).map((s) => s.segment_name));
    }
    if (f.channelKeys?.length) {
      add('Distribution Channel', filterOptions.distributionChannels.data?.filter((c) => f.channelKeys!.includes(c.channel_key as number)).map((c) => c.channel_name));
    }
    if (f.salesTeamKeys?.length) {
      add('Branch', filterOptions.branches.data?.filter((b) => f.salesTeamKeys!.includes(b.sales_team_key as string)).map((b) => b.sales_team_name));
    }
    if (f.salespersonKeys?.length) {
      add('Salesperson', filterOptions.salespersons.data?.filter((s) => f.salespersonKeys!.includes(s.salesperson_key as number)).map((s) => s.salesperson_name));
    }
    return parts;
  }

  async function handleExportPerformanceTablePdf() {
    try {
      await exportPerformanceTablePdf({
        title: 'Performance Details',
        rows: toPerformanceRows(overview.data?.performanceDetails),
        columns: PERFORMANCE_PDF_COLUMNS,
        filterParts: buildFilterSummaryParts(),
        exportedByEmail: user?.email,
      });
    } catch (err) {
      console.error('PDF export failed:', err);
    }
  }

  // Exports every period of the window -- the same columns / rows the expanded table view renders, so the PDF always
  // matches it exactly.
  async function handleDownloadTablePdf(key: string, title: string, rows: TrendTableRow[]) {
    setDownloadingPdf(key);
    try {
      await exportRowsAsPdf({
        title: `${title} · ${win.name}`,
        columns: tableColumns.map((c) => ({ header: c.header, align: c.align })),
        rows: rows.map((row) => tableColumns.map((c) => String(row[c.key as keyof TrendTableRow] ?? ''))),
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
          anchorDate={anchorDate}
          onAnchorDateChange={onAnchorDateChange}
          roleLabel={roleLabel}
          onLogout={logout}
          showDateInput={false}
        />

        <FilterBar {...standardFilterBarProps({ state: filterState, options: filterOptions, isSalesperson, refresh: refreshStatus.data })} />

        <ValidationStatusBar
          isStale={refreshStatus.data?.isStale}
          isInverted={refreshStatus.data?.isInverted}
          refreshCheck={refreshStatus.data?.refreshCheck}
          lastRefreshTime={lastRefreshLabel}
        />

        <main style={{ flex: 1, padding: 'var(--ps-space-4, 24px)' }}>
          <div
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 'var(--ps-space-3, 16px)' }}
          >
            <span style={{ fontSize: 13, color: 'var(--ps-color-muted-text)' }} data-testid="trend-window">
              Trends: the {win.windowLabel}
              {hasTarget ? '' : ' · target shown on Monthly and Yearly only'}
            </span>
            <PeriodTrendSelector value={granularity} onChange={setGranularity} label="Revenue Trend period" />
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))',
              gap: 'var(--ps-space-3, 16px)',
              alignItems: 'stretch',
            }}
          >
            <ChartPanel<TrendTableRow>
              title="Value trend"
              {...vh('promotion.revenueTrend.valueTrend')}
              style={{ minHeight: 360 }}
              tableColumns={trend.error ? undefined : tableColumns}
              tableRows={trend.error ? undefined : valueTableRows}
              getRowId={(row) => row.period}
              headerActions={
                !trend.error && (
                  <ExportPdfButton
                    downloading={downloadingPdf === 'value'}
                    disabled={valueTableRows.length === 0}
                    onClick={() => handleDownloadTablePdf('value', 'Value trend', valueTableRows)}
                  />
                )
              }
            >
              {trendLoading ? (
                <LoadingSkeleton variant="chart" />
              ) : trend.error ? (
                <ErrorState message={trend.error} onRetry={trend.retry} />
              ) : (
                <TrendChart
                  title="Value trend"
                  showTitle={false}
                  points={valuePoints}
                  actualLabel="Value"
                  lastYearLabel="Same period LY"
                  inProgressLabel={inProgressLabel}
                  tooltipLabelFormatter={tooltipTitle}
                  valueFormatter={formatCompactNumber}
                  tooltipValueFormatter={(v) => formatCurrency(v)}
                  lastYearColor={chartColors.lastYear}
                  targetColor={chartColors.target}
                />
              )}
            </ChartPanel>

            <ChartPanel<TrendTableRow>
              title="Volume trend"
              {...vh('promotion.revenueTrend.volumeTrend')}
              style={{ minHeight: 360 }}
              tableColumns={trend.error ? undefined : tableColumns}
              tableRows={trend.error ? undefined : volumeTableRows}
              getRowId={(row) => row.period}
              headerActions={
                !trend.error && (
                  <ExportPdfButton
                    downloading={downloadingPdf === 'volume'}
                    disabled={volumeTableRows.length === 0}
                    onClick={() => handleDownloadTablePdf('volume', 'Volume trend', volumeTableRows)}
                  />
                )
              }
            >
              {trendLoading ? (
                <LoadingSkeleton variant="chart" />
              ) : trend.error ? (
                <ErrorState message={trend.error} onRetry={trend.retry} />
              ) : (
                <TrendChart
                  title="Volume trend"
                  showTitle={false}
                  points={volumePoints}
                  actualLabel="Volume"
                  lastYearLabel="Same period LY"
                  inProgressLabel={inProgressLabel}
                  tooltipLabelFormatter={tooltipTitle}
                  valueFormatter={formatCompactNumber}
                  tooltipValueFormatter={(v) => formatVolume(v)}
                  lastYearColor={chartColors.lastYear}
                  targetColor={chartColors.target}
                />
              )}
            </ChartPanel>

            <ChartPanel<TrendTableRow>
              title="ASP trend"
              {...vh('promotion.revenueTrend.aspTrend')}
              style={{ minHeight: 360 }}
              tableColumns={trend.error ? undefined : tableColumns}
              tableRows={trend.error ? undefined : aspTableRows}
              getRowId={(row) => row.period}
              headerActions={
                !trend.error && (
                  <ExportPdfButton
                    downloading={downloadingPdf === 'asp'}
                    disabled={aspTableRows.length === 0}
                    onClick={() => handleDownloadTablePdf('asp', 'ASP trend', aspTableRows)}
                  />
                )
              }
            >
              {trendLoading ? (
                <LoadingSkeleton variant="chart" />
              ) : trend.error ? (
                <ErrorState message={trend.error} onRetry={trend.retry} />
              ) : (
                <TrendChart
                  title="ASP trend"
                  showTitle={false}
                  points={aspPoints}
                  actualLabel="ASP"
                  lastYearLabel="Same period LY"
                  inProgressLabel={inProgressLabel}
                  tooltipLabelFormatter={tooltipTitle}
                  valueFormatter={formatPlainNumber}
                  tooltipValueFormatter={(v) => formatAsp(v)}
                  lastYearColor={chartColors.lastYear}
                  targetColor={chartColors.target}
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

          {!overview.loading && !overview.error && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--ps-space-4, 24px)',
                marginTop: 'var(--ps-space-4, 24px)',
              }}
            >
              <PerformanceReportTable
                title="Performance Details"
                {...vh('promotion.revenueTrend.details')}
                rows={toPerformanceRows(overview.data?.performanceDetails)}
                showLytdColumn
                lastColumnLabel="Last"
                showStatus
                showTakeaway
                onExportPdf={handleExportPerformanceTablePdf}
              />
            </div>
          )}
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
      {...vh('promotion.revenueTrend.varianceCard')}
      value={card ? formatVariance(card.variancePct) ?? '—' : '—'}
      status={card == null ? 'neutral' : bad ? 'alert' : 'success'}
      accentBg={bad}
      loading={loading}
    />
  );
}
