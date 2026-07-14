'use client';
import React, { useMemo, useState } from 'react';
import { AppHeader } from '../../../../components/AppHeader';
import { FilterBar } from '../../../../components/FilterBar';
import { BottomNavBar } from '../../../../components/BottomNavBar';
import { ValidationStatusBar } from '../../../../components/ValidationStatusBar';
import { RefreshFooter } from '../../../../components/RefreshFooter';
import { useBusinessUnit } from '../../../../components/BusinessUnitProvider';
import {
  ChartPanel,
  InsightCard,
  LoadingSkeleton,
  ErrorState,
  TrendChart,
  type Column,
  type TrendPoint,
} from '@07ps/ui';
import { useAuth } from '../../../../lib/AuthProvider';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useFilterOptions, useRevenueTrendOverview, useRefreshStatus } from '../../../../lib/hooks';
import type { RevenueTrendMonthPoint, RevenueTrendVarianceCard, TachometerFilters } from '../../../../lib/api';
import { formatAsp, formatCurrency, formatTimestamp, formatVariance, formatVolume } from '../../../../lib/format';

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
  const overview = useRevenueTrendOverview(token, anchorDate, effectiveFilters, authError, retryAuth);
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
  const series = overview.data?.series ?? [];

  const valuePoints: TrendPoint[] = series.map((p) => ({ label: p.label, actual: p.value, lastYear: p.lastYearValue, target: p.targetValue }));
  const volumePoints: TrendPoint[] = series.map((p) => ({ label: p.label, actual: p.volume, lastYear: p.lastYearVolume, target: p.targetVolume }));
  const aspPoints: TrendPoint[] = series.map((p) => ({ label: p.label, actual: p.asp ?? 0, lastYear: p.lastYearAsp, target: p.targetAsp }));

  const valueTableRows = toTableRows(series, (p) => ({ actual: p.value, lastYear: p.lastYearValue, target: p.targetValue }), (v) => (v === null ? '—' : formatCurrency(v)));
  const volumeTableRows = toTableRows(series, (p) => ({ actual: p.volume, lastYear: p.lastYearVolume, target: p.targetVolume }), (v) => (v === null ? '—' : formatVolume(v)));
  const aspTableRows = toTableRows(series, (p) => ({ actual: p.asp, lastYear: p.lastYearAsp, target: p.targetAsp }), formatAspOrDash);

  const kpis = overview.data?.kpis;

  return (
    <PermissionGuard pageKey="revenue_trend">
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
