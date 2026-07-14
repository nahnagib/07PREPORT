'use client';
import React, { useMemo, useState } from 'react';
import { AppHeader } from '../../../../components/AppHeader';
import { FilterBar } from '../../../../components/FilterBar';
import { BottomNavBar } from '../../../../components/BottomNavBar';
import { ValidationStatusBar } from '../../../../components/ValidationStatusBar';
import { RefreshFooter } from '../../../../components/RefreshFooter';
import { useBusinessUnit } from '../../../../components/BusinessUnitProvider';
import { Card, ChartPanel, ComboChart, StackedPercentBarChart, LoadingSkeleton, ErrorState } from '@07ps/ui';
import { useAuth } from '../../../../lib/AuthProvider';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useFilterOptions, usePipelineTrendOverview, useRefreshStatus } from '../../../../lib/hooks';
import type { AgingBuckets, MonthComparisonPoint, TachometerFilters } from '../../../../lib/api';
import { formatCurrency, formatTimestamp, formatVariance } from '../../../../lib/format';

const todayIso = () => new Date().toISOString().slice(0, 10);
/** Jan 1 of the current year -- every page's date-range filter defaults to YTD (Jan 1 -> today) on
 * load, not a single-day "today" range; anchorDate itself still drives the actual YTD/MTD window
 * math (ytdWindow/mtdWindow in filters.ts), this only fixes the visible From/To fields to match. */
const ytdStartIso = () => `${new Date().getUTCFullYear()}-01-01`;

const EMPTY_FILTERS: TachometerFilters = {
  companyKeys: [],
  segmentKeys: [],
  channelKeys: [],
  salesTeamKeys: [],
  salespersonKeys: [],
};

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

/**
 * Pipeline Trend page (Sales, Level 3) -- seventh live Sales page, read-only per spec (no
 * drill-down/click-filter interactions). Same architecture as every other page. All figures come
 * from backend/src/measures/pipelineTrend.ts, including an empirically-resolved Win Rate
 * definition (Fact_Sales.IsWonQuotation is always 0 live -- see that file's header comment for
 * what's used instead).
 */
export default function PipelineTrendPage() {
  const { setBusinessUnit } = useBusinessUnit();
  const { user, isSalesperson, salespersonKey, token, error: authError, retryAuth, logout } = useAuth();
  const [anchorDate, setAnchorDate] = useState(todayIso());
  const [dateFromDate, setDateFromDate] = useState(ytdStartIso());
  const [dateToDate, setDateToDate] = useState(todayIso());
  const [filters, setFilters] = useState<TachometerFilters>(EMPTY_FILTERS);

  const effectiveFilters = useMemo<TachometerFilters>(
    () => (isSalesperson ? { ...EMPTY_FILTERS, salespersonKeys: salespersonKey != null ? [salespersonKey] : [] } : filters),
    [isSalesperson, salespersonKey, filters],
  );

  const filterOptions = useFilterOptions(token, authError, retryAuth);
  const overview = usePipelineTrendOverview(token, anchorDate, effectiveFilters, authError, retryAuth);
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
    setDateFromDate(ytdStartIso());
    setDateToDate(today);
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

  return (
    <PermissionGuard pageKey="pipeline_trend">
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
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--ps-space-3, 16px)', alignItems: 'start' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-3, 16px)' }}>
              <Card>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ps-color-text)', marginBottom: 'var(--ps-space-2, 8px)' }}>
                  Quotation Rates
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

              <ChartPanel
                title="Open Opportunities & Quotations by Aging"
                infoText="Open Opportunities and open Quotations, each as a 100%-stacked column by age bucket. A healthy pipeline concentrates in 0-30 days with low 90+."
                style={{ minHeight: 340 }}
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
              <MonthComboPanel title="Opportunities" points={opportunitiesPoints} loading={overview.loading} error={overview.error ?? undefined} onRetry={overview.retry} />
              <MonthComboPanel title="Quotations" points={quotationsPoints} loading={overview.loading} error={overview.error ?? undefined} onRetry={overview.retry} />
              <MonthComboPanel title="Sales Orders" points={salesOrdersPoints} loading={overview.loading} error={overview.error ?? undefined} onRetry={overview.retry} />
            </div>
          </div>
        </main>

        <RefreshFooter
          lastUpdate={formatTimestamp(refreshStatus.data?.lastUpdate ?? null)}
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
}: {
  title: string;
  points: ReturnType<typeof toMonthChartPoints>;
  loading: boolean;
  error?: string;
  onRetry: () => void;
}) {
  return (
    <ChartPanel title={title} style={{ minHeight: 260 }}>
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
