'use client';
import React from 'react';
import {
  Target,
  Gauge as GaugeIcon,
  CalendarDays,
  CalendarCheck2,
  CalendarOff,
  Coffee,
  TrendingDown,
  TrendingUp,
  Info,
} from 'lucide-react';
import { AppHeader } from '../../../../components/AppHeader';
import { FilterBar } from '../../../../components/FilterBar';
import { BottomNavBar } from '../../../../components/BottomNavBar';
import { ValidationStatusBar } from '../../../../components/ValidationStatusBar';
import { RefreshFooter } from '../../../../components/RefreshFooter';
import { useFilterState, useScopedFilterOptions } from '../../../../components/FilterProvider';
import {
  Card,
  DonutChart,
  LoadingSkeleton,
  ErrorState,
  Sparkline,
  CollapsibleSection,
  PerformanceReportTable,
  exportPerformanceTablePdf,
  type SemanticStatus,
  type PerformanceReportRow,
  type PerformanceTablePdfColumn,
} from '@07ps/ui';
import { useAuth } from '../../../../lib/AuthProvider';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useCriticalNumberOverview, useRefreshStatus } from '../../../../lib/hooks';
import { formatCompactCurrency, formatCurrency, formatVariance, formatTimestamp, toSemanticStatus } from '../../../../lib/format';
import type { CriticalNumberOverview } from '../../../../lib/api';

// Not in tokens.css (business-unit accent there is charcoal/blue) -- these are the two brand
// colors used specifically to tell Majaal/Tika apart in the Forced Closures branch breakdown,
// same purple/orange pairing used across the rest of this project's company-facing material.
const COMPANY_DOT_COLOR: Record<string, string> = {
  majaal: '#8B5CF6',
  tika: '#F97316',
};

function companyDotColor(company: string | null): string {
  if (!company) return 'var(--ps-color-neutral-text)';
  return COMPANY_DOT_COLOR[company.toLowerCase()] ?? 'var(--ps-color-neutral-text)';
}

function formatDayCount(n: number): string {
  return `${n} ${n === 1 ? 'day' : 'days'}`;
}

/** Single date picker bounds (Issue #9, dashboard revision pass): today (can't view the future)
 * and Jan 1 of the current year (matches this page's YTD-only history -- there's no meaningful
 * "prior year" Working Days/Critical Number figure to show). Same UTC-based "today" FilterBar's
 * own todayIso() uses. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function yearStartIso(): string {
  return `${new Date().getUTCFullYear()}-01-01`;
}

// ---------------------------------------------------------------------------
// Executive Summary -- a C-level scannable rollup. Daily/Monthly/Yearly Counter rows reuse this
// page's own backend-computed status (classifyVsTarget); Missing Value/Days YTD have no target of
// their own (they're already a gap-vs-pace figure), so their status is a simple, documented
// ahead-of-pace/behind-pace read (green = at or ahead of pace, red = any shortfall) rather than a
// fabricated banding.
// ---------------------------------------------------------------------------

function counterTakeaway(label: string, status: string, variancePct: number | null): string {
  const variance = variancePct != null ? formatVariance(variancePct) ?? null : null;
  if (status === 'green') return `${label} is on pace${variance ? ` (${variance} vs target)` : ''}.`;
  if (status === 'yellow') return `${label} is slightly behind pace${variance ? ` (${variance} vs target)` : ''}.`;
  if (status === 'red') return `${label} is well behind pace${variance ? ` (${variance} vs target)` : ''} and needs attention.`;
  return `No target set for ${label}.`;
}

// Metric Name / Actual / Target / Variance to Target / Status / Takeaway, matching the on-page
// PerformanceReportTable's compactColumns layout (no Variance LY or Trend column in the PDF either).
const COMPACT_PDF_COLUMNS: PerformanceTablePdfColumn[] = [
  { header: 'Metric Name', getValue: (row) => row.metric },
  { header: 'Actual', getValue: (row) => row.actualLabel },
  { header: 'Target', getValue: (row) => row.targetLabel },
  { header: 'Variance to Target', getValue: (row) => (row.variancePct !== null ? `${(row.variancePct * 100).toFixed(2)}%` : '—') },
  { header: 'Status', getValue: (row) => row.status || '—' },
  { header: 'Takeaway', getValue: (row) => row.takeaway ?? '—' },
];

function toExecutiveSummaryRows(data?: CriticalNumberOverview | null): PerformanceReportRow[] {
  if (!data) return [];
  const rows: PerformanceReportRow[] = [
    {
      id: 'dailyCounter',
      metric: 'Daily Counter',
      actualLabel: formatCompactCurrency(data.dailyCounter.actual),
      actualFullValue: formatCurrency(data.dailyCounter.actual),
      targetLabel: data.dailyCounter.target != null ? formatCompactCurrency(data.dailyCounter.target) : '—',
      variancePct: data.dailyCounter.variancePct,
      varianceLyPct: null,
      status: toSemanticStatus(data.dailyCounter.status),
      takeaway: counterTakeaway('Today', data.dailyCounter.status, data.dailyCounter.variancePct),
    },
    {
      id: 'monthlyCounter',
      metric: 'Monthly Counter',
      actualLabel: formatCompactCurrency(data.monthlyCounter.actualValue),
      actualFullValue: formatCurrency(data.monthlyCounter.actualValue),
      targetLabel: formatCompactCurrency(data.monthlyCounter.periodTarget),
      variancePct: data.monthlyCounter.achievementPct != null ? data.monthlyCounter.achievementPct - 1 : null,
      varianceLyPct: null,
      status: toSemanticStatus(data.monthlyCounter.status),
      takeaway: counterTakeaway('This month', data.monthlyCounter.status, data.monthlyCounter.achievementPct != null ? data.monthlyCounter.achievementPct - 1 : null),
    },
    {
      id: 'yearlyCounter',
      metric: 'Yearly Counter',
      actualLabel: formatCompactCurrency(data.yearlyCounter.actualValue),
      actualFullValue: formatCurrency(data.yearlyCounter.actualValue),
      targetLabel: formatCompactCurrency(data.yearlyCounter.periodTarget),
      variancePct: data.yearlyCounter.achievementPct != null ? data.yearlyCounter.achievementPct - 1 : null,
      varianceLyPct: null,
      status: toSemanticStatus(data.yearlyCounter.status),
      takeaway: counterTakeaway('This year', data.yearlyCounter.status, data.yearlyCounter.achievementPct != null ? data.yearlyCounter.achievementPct - 1 : null),
    },
    {
      id: 'workingDaysYtd',
      metric: 'Working Days YTD',
      actualLabel: String(data.workingDaysYtd.value),
      targetLabel: '—',
      variancePct: null,
      varianceLyPct: data.workingDaysYtd.variancePct,
      status: 'neutral',
      takeaway: `${data.workingDaysYtd.value} working days so far this year (${data.workingDaysYtd.lastYear} same period last year).`,
    },
  ];

  const missingValue = data.missingValueYtd.value;
  const missingValueGap = missingValue == null ? null : -missingValue;
  const missingValueBehind = missingValueGap != null && missingValueGap < 0;
  rows.push({
    id: 'missingValueYtd',
    metric: 'Missing Value YTD',
    actualLabel: missingValueGap == null ? '—' : `${missingValueBehind ? '-' : '+'}${formatCompactCurrency(Math.abs(missingValueGap))}`,
    actualFullValue: missingValueGap == null ? undefined : `${missingValueBehind ? '-' : '+'}${formatCurrency(Math.abs(missingValueGap))}`,
    targetLabel: formatCompactCurrency(data.missingValueYtd.expectedValue),
    variancePct: null,
    varianceLyPct: null,
    trendValues: data.missingValueYtd.trendValues,
    status: missingValueGap == null ? 'neutral' : missingValueBehind ? 'alert' : 'success',
    takeaway:
      missingValueGap == null
        ? 'No pace data available.'
        : missingValueBehind
          ? `Sales are ${formatCompactCurrency(Math.abs(missingValueGap))} behind pace year-to-date.`
          : `Sales are ${formatCompactCurrency(Math.abs(missingValueGap))} ahead of pace year-to-date.`,
  });

  const missingDays = data.missingDaysYtd.value;
  const missingDaysGap = missingDays == null ? null : -missingDays;
  const missingDaysBehind = missingDaysGap != null && missingDaysGap < 0;
  rows.push({
    id: 'missingDaysYtd',
    metric: 'Missing Days YTD',
    actualLabel: missingDaysGap == null ? '—' : `${missingDaysBehind ? '-' : '+'}${formatDayCount(Math.round(Math.abs(missingDaysGap)))}`,
    targetLabel: formatDayCount(Math.round(data.missingDaysYtd.expectedValue)),
    variancePct: null,
    varianceLyPct: null,
    trendValues: data.missingDaysYtd.trendValues,
    status: missingDaysGap == null ? 'neutral' : missingDaysBehind ? 'alert' : 'success',
    takeaway:
      missingDaysGap == null
        ? 'No pace data available.'
        : missingDaysBehind
          ? `Sales are the equivalent of ${formatDayCount(Math.round(Math.abs(missingDaysGap)))} behind pace year-to-date.`
          : `Sales are the equivalent of ${formatDayCount(Math.round(Math.abs(missingDaysGap)))} ahead of pace year-to-date.`,
  });

  return rows;
}

/**
 * Critical Number page (Sales, Level 3) -- 07Ps_Phase1_Architecture_Standards.md Section 2.1.1:
 * "translates the annual target into a required daily value; tracks working-day consumption,
 * missing days/value, and forced closures." Second live Sales page after Tachometer; built to the
 * exact same architecture (AppHeader + FilterBar + ValidationStatusBar + BottomNavBar,
 * PermissionGuard pageKey='critical_number', same useAuth/useFilterOptions/useRefreshStatus hooks,
 * same @07ps/ui dark-theme primitives) so the two pages are indistinguishable in look/behavior per
 * Standards Section 2.1.2's "one unified platform" requirement -- see tachometer/page.tsx for the
 * shared pattern this mirrors.
 *
 * All figures come from backend/src/measures/criticalNumber.ts, computed against the same
 * throwaway/validation MySQL warehouse Tachometer reads from (Fact_SalesLines, Dim_Date) plus the
 * admin-managed official_holidays/forced_closures tables (Admin Panel > Official Holidays / Forced
 * Closures) -- there is no live Odoo or Power BI connection, and no sample/mock data path;
 * ValidationStatusBar below states this plainly, same as Tachometer. The Daily Critical Number's
 * company-wide base is a fixed 560,000 constant, unrelated to Fact_Targets, scaled by the active
 * Company/Customer Group filter selection via admin-configured percentages -- see
 * criticalNumber.ts's DAILY_CRITICAL_NUMBER and computeDailyCriticalNumber docstrings.
 */
export default function CriticalNumberPage() {
  const { user, isSalesperson, token, error: authError, retryAuth, logout } = useAuth();
  const {
    filters,
    effectiveFilters,
    anchorDate,
    dateFromDate,
    dateToDate,
    onFiltersChange,
    onAnchorDateChange,
    onDateRangeChange,
  } = useFilterState();

  const filterOptions = useScopedFilterOptions();
  const overview = useCriticalNumberOverview(token, anchorDate, effectiveFilters, authError, retryAuth);
  const refreshStatus = useRefreshStatus(token, authError, retryAuth);

  function buildFilterSummaryParts(): string[] {
    const parts: string[] = [];

    parts.push(`Date: ${anchorDate}`);

    if (filters.companyKeys?.length) {
      const labels = filterOptions.businessUnits.data
        ?.filter((b) => filters.companyKeys!.includes(b.company_key as number))
        .map((b) => b.company_name);
      if (labels?.length) parts.push(`Company: ${labels.join(', ')}`);
    }

    if (filters.segmentKeys?.length) {
      const labels = filterOptions.customerGroups.data
        ?.filter((s) => filters.segmentKeys!.includes(s.segment_key as number))
        .map((s) => s.segment_name);
      if (labels?.length) parts.push(`Customer Group: ${labels.join(', ')}`);
    }

    if (filters.channelKeys?.length) {
      const labels = filterOptions.distributionChannels.data
        ?.filter((c) => filters.channelKeys!.includes(c.channel_key as number))
        .map((c) => c.channel_name);
      if (labels?.length) parts.push(`Distribution Channel: ${labels.join(', ')}`);
    }

    if (filters.salesTeamKeys?.length) {
      const labels = filterOptions.branches.data
        ?.filter((b) => filters.salesTeamKeys!.includes(b.sales_team_key as string))
        .map((b) => b.sales_team_name);
      if (labels?.length) parts.push(`Branch: ${labels.join(', ')}`);
    }

    if (filters.salespersonKeys?.length) {
      const labels = filterOptions.salespersons.data
        ?.filter((s) => filters.salespersonKeys!.includes(s.salesperson_key as number))
        .map((s) => s.salesperson_name);
      if (labels?.length) parts.push(`Salesperson: ${labels.join(', ')}`);
    }

    return parts;
  }

  function buildFilterSummary(): string {
    const parts = buildFilterSummaryParts();
    return parts.length > 0 ? parts.join(' | ') : 'No filters applied';
  }

  async function handleExportTablePdf() {
    try {
      await exportPerformanceTablePdf({
        title: 'Performance Details',
        rows: toExecutiveSummaryRows(data),
        columns: COMPACT_PDF_COLUMNS,
        filterParts: buildFilterSummaryParts(),
        exportedByEmail: user?.email,
        fileName: 'critical-number-performance-details',
      });
    } catch (err) {
      console.error('PDF export failed:', err);
    }
  }

  const roleLabel = user?.role.label ?? user?.fullName;
  const lastRefreshLabel = refreshStatus.data ? formatTimestamp(refreshStatus.data.lastRefreshTime) : undefined;
  const data = overview.data;

  return (
    <PermissionGuard pageKey="critical_number">
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', paddingBottom: 64 }}>
        <AppHeader
          pageTitle="Promotion Dashboard"
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
          showDateRange={false}
          showSingleDate
          dateMin={yearStartIso()}
          dateMax={todayIso()}
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
        />

        <ValidationStatusBar
          isStale={refreshStatus.data?.isStale}
          isInverted={refreshStatus.data?.isInverted}
          refreshCheck={refreshStatus.data?.refreshCheck}
          lastRefreshTime={lastRefreshLabel}
        />

        <main style={{ flex: 1, padding: 'var(--ps-space-4, 24px)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)' }}>
            {data?.isFallback && (
              <FallbackDataNotice anchorDate={data.anchorDate} daysAgo={data.fallbackDaysAgo} />
            )}

            {/* Section 1 -- Hero Metrics: Daily/Monthly/Yearly counters side by side on top, the
                Daily Critical Number card centered below them. */}
            <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-3, 16px)' }}>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                  gap: 'var(--ps-space-3, 16px)',
                  alignItems: 'stretch',
                }}
              >
                <DailyCounterCard counter={data?.dailyCounter} loading={overview.loading} error={overview.error ?? undefined} onRetry={overview.retry} />
                <PeriodCounterCard
                  title="Monthly Counter"
                  counter={data?.monthlyCounter}
                  loading={overview.loading}
                  error={overview.error ?? undefined}
                  onRetry={overview.retry}
                />
                <PeriodCounterCard
                  title="Yearly Counter"
                  counter={data?.yearlyCounter}
                  loading={overview.loading}
                  error={overview.error ?? undefined}
                  onRetry={overview.retry}
                />
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(260px, 480px)',
                  justifyContent: 'center',
                }}
              >
                <DailyCriticalNumberCard value={data?.dailyCriticalNumber ?? null} loading={overview.loading} error={overview.error ?? undefined} onRetry={overview.retry} isAdmin={user?.role.name === 'ADMIN'} />
              </div>
            </section>

            {/* Section 2 -- Working Days: calendar/off-day accounting, YTD. */}
            <section
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: 'var(--ps-space-3, 16px)',
              }}
            >
              <WorkingDaysCard
                value={data?.workingDaysYtd.value}
                loading={overview.loading}
                error={overview.error ?? undefined}
                onRetry={overview.retry}
              />
              <OfficialHolidaysCard data={data?.officialHolidaysYtd} loading={overview.loading} error={overview.error ?? undefined} onRetry={overview.retry} />
              <ForcedClosuresCard data={data?.forcedClosuresYtd} loading={overview.loading} error={overview.error ?? undefined} onRetry={overview.retry} />
              <SimpleCountCard
                title="Weekly Rest Days YTD"
                icon={Coffee}
                value={data?.weeklyRestDaysYtd.value}
                caption="Standard weekly off"
                loading={overview.loading}
                error={overview.error ?? undefined}
                onRetry={overview.retry}
              />
            </section>

            {/* Section 3 -- Impact Analysis: missing value / missing days YTD. Value-first order
                (LYD amount before the day count) per the dashboard revision pass. */}
            <section
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
                gap: 'var(--ps-space-3, 16px)',
              }}
            >
              <ImpactCard
                title="Missing Value YTD"
                description="Net gap vs. pace: (Working Days YTD x Daily Critical Number) minus Actual YTD Value -- positive means ahead of pace, negative means behind (surplus days offset shortfall days)"
                value={data?.missingValueYtd.value ?? null}
                formatMagnitude={formatCompactCurrency}
                formatFullMagnitude={formatCurrency}
                trendValues={data?.missingValueYtd.trendValues ?? []}
                trendPct={data?.missingValueYtd.trendPct ?? null}
                sparklineLabel="Cumulative missing value, as of each month-end this year"
                axisTooltip="X-axis: each month of this year, left to right (running total as of that month's end). Y-axis: cumulative gap (LYD) = Actual Value minus (Working Days Elapsed x Daily Critical Number) to that point -- a running total, not that month's own isolated result."
                loading={overview.loading}
                error={overview.error ?? undefined}
                onRetry={overview.retry}
              />
              <ImpactCard
                title="Missing Days YTD"
                description="Missing Value YTD expressed in day-equivalents (Missing Value / Daily Critical Number)"
                value={data?.missingDaysYtd.value ?? null}
                formatMagnitude={formatDayCount}
                trendValues={data?.missingDaysYtd.trendValues ?? []}
                trendPct={data?.missingDaysYtd.trendPct ?? null}
                sparklineLabel="Cumulative days behind pace, last 30 days"
                axisTooltip="X-axis: each of the last 30 calendar days, left to right (running total as of that day). Y-axis: cumulative gap expressed as a number of days at the Daily Critical Number -- a running total, not that single day's own result."
                loading={overview.loading}
                error={overview.error ?? undefined}
                onRetry={overview.retry}
              />
            </section>

            {!overview.loading && !overview.error && (
              <PerformanceReportTable
                title="Performance Details"
                rows={toExecutiveSummaryRows(data)}
                showStatus
                showTakeaway
                compactColumns
                filtersSummary={buildFilterSummary()}
                onExportPdf={handleExportTablePdf}
              />
            )}
          </div>
        </main>

        <RefreshFooter
          lastUpdate={formatTimestamp(refreshStatus.data?.lastUpdate ?? null)}
          lastOrderCreated={formatTimestamp(refreshStatus.data?.lastOrderCreated ?? null)}
          lastRefreshTime={formatTimestamp(refreshStatus.data?.lastRefreshTime ?? null)}
        />

        <BottomNavBar active="Critical Number" />
      </div>
    </PermissionGuard>
  );
}

/** Shown in place of an error when today's ETL data hasn't landed yet -- the cards below display
 * the most recent available day's figures instead (see routes/criticalNumber.ts's isFallback
 * logic), and this banner is what makes that substitution obvious rather than silent. Disappears
 * on its own next time the page re-fetches once today's data actually arrives -- no manual reset
 * needed, since isFallback is recomputed fresh on every /overview call. */
function FallbackDataNotice({ anchorDate, daysAgo }: { anchorDate: string; daysAgo: number }) {
  return (
    <div
      role="note"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 16px',
        borderRadius: 8,
        background: 'var(--ps-color-watch)',
        color: '#1a1a1a',
        fontSize: 13,
        fontWeight: 600,
      }}
    >
      <Info size={16} aria-hidden style={{ flexShrink: 0 }} />
      <span>
        Showing data from {anchorDate} ({daysAgo} {daysAgo === 1 ? 'day' : 'days'} ago) -- today&apos;s data isn&apos;t available yet.
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section 1 cards
// ---------------------------------------------------------------------------

function DailyCriticalNumberCard({
  value,
  loading,
  error,
  onRetry,
  isAdmin,
}: {
  value: number | null;
  loading: boolean;
  error?: string;
  onRetry: () => void;
  isAdmin: boolean;
}) {
  if (loading) {
    return (
      <Card style={{ width: '100%' }}>
        <LoadingSkeleton variant="kpi" />
      </Card>
    );
  }
  if (error) {
    return (
      <Card style={{ width: '100%' }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Daily Critical Number</div>
        <ErrorState message={error} onRetry={onRetry} />
      </Card>
    );
  }
  return (
    <Card
      style={{
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        textAlign: 'center',
        gap: 6,
        borderLeft: '4px solid var(--ps-color-accent)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--ps-color-muted-text)' }}>
        <Target size={16} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>Daily Critical Number</span>
      </div>
      <div
        style={{
          fontSize: 40,
          fontWeight: 700,
          color: 'var(--ps-color-text)',
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1.1,
        }}
        title={value != null ? formatCurrency(value) : undefined}
      >
        {value != null ? formatCompactCurrency(value) : '—'}
      </div>
      {isAdmin && (
        <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', maxWidth: 320 }}>
          Baseline daily sales target -- the figure every Daily/Monthly/Yearly Counter below is measured against. Scales with
          the active Company/Customer Group filters (Admin Panel &gt; Companies / Customer Groups sets each one's share).
        </div>
      )}
    </Card>
  );
}

/** Shared Achieved/Remaining donut segment colors for the Daily/Monthly/Yearly counters (Issue #2-4,
 * dashboard revision pass) -- blue for the achieved portion, light gray (the same track color
 * RangeBar/ProgressBar used) for what's left to reach target. */
const ACHIEVED_COLOR = 'var(--ps-color-accent)';
const REMAINING_COLOR = 'var(--ps-color-border)';

function achievedVsRemainingSegments(actual: number, target: number | null) {
  if (target == null || target <= 0) {
    return [{ id: 'achieved', label: 'Achieved', value: Math.max(actual, 0) || 1, color: ACHIEVED_COLOR }];
  }
  const remaining = Math.max(0, target - actual);
  return [
    { id: 'achieved', label: 'Achieved', value: Math.max(0, actual), color: ACHIEVED_COLOR },
    { id: 'remaining', label: 'Remaining', value: remaining, color: REMAINING_COLOR },
  ];
}

function DailyCounterCard({
  counter,
  loading,
  error,
  onRetry,
}: {
  counter?: { actual: number; target: number | null; status: string; variancePct: number | null };
  loading: boolean;
  error?: string;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <Card style={{ width: '100%' }}>
        <LoadingSkeleton variant="kpi" />
      </Card>
    );
  }
  if (error) {
    return (
      <Card style={{ width: '100%' }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Daily Counter</div>
        <ErrorState message={error} onRetry={onRetry} />
      </Card>
    );
  }
  const status = toSemanticStatus((counter?.status as any) ?? 'no_target');
  const actual = counter?.actual ?? 0;
  const target = counter?.target ?? null;

  return (
    <Card style={{ width: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: 'var(--ps-color-muted-text)', display: 'flex', flexShrink: 0 }}>
            <GaugeIcon size={16} />
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ps-color-muted-text)' }}>Daily Counter</span>
        </div>
        <PaceBadge status={status} />
      </div>

      <DonutChart
        showTitle={false}
        segments={achievedVsRemainingSegments(actual, target)}
        valueFormatter={(v) => formatCompactCurrency(v)}
        legendTitle="Today"
        height={200}
        centerLabel="Today"
        centerSubLabel={formatCompactCurrency(actual)}
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 8,
          marginTop: 8,
          borderTop: '1px solid var(--ps-color-border)',
          paddingTop: 8,
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ps-color-text)' }} title={target != null ? formatCurrency(target) : undefined}>
            {target != null ? formatCompactCurrency(target) : '—'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginTop: 2 }}>Target</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ps-color-text)' }}>{formatVariance(counter?.variancePct ?? null) ?? '—'}</div>
          <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginTop: 2 }}>Variance</div>
        </div>
      </div>
    </Card>
  );
}

/** Same visual shell as @07ps/ui's SemanticBadge (Standards Section 3.9/5.10 semantic pill), but
 * with pace-specific wording -- SemanticBadge's label map is fixed platform-wide vocabulary shared
 * by every page (Tachometer included), so it isn't forked just for this card's "pace" framing.
 * Same status -> color mapping, so it never disagrees with what SemanticBadge would show for the
 * same status.
 *
 * "Critical" -> "Underperforming" (Issue #5, dashboard revision pass): this page isn't about
 * critical *issues*, it's about pace against a sales target, and "Critical" read as alarming/
 * ambiguous. Page-local wording change only -- SemanticBadge itself (still "Critical" for 'alert')
 * is shared verbatim by Tachometer/Pipeline Health/Product Lifecycle and is untouched. */
function PaceBadge({ status }: { status: SemanticStatus }) {
  const label: Record<SemanticStatus, string> = {
    success: 'On Pace',
    watch: 'Behind Pace',
    alert: 'Underperforming',
    neutral: 'No Target',
  };
  const colorVar: Record<SemanticStatus, string> = {
    success: 'var(--ps-color-success)',
    watch: 'var(--ps-color-watch)',
    alert: 'var(--ps-color-alert)',
    neutral: 'var(--ps-color-neutral-text)',
  };
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        color: colorVar[status],
        border: `1px solid ${colorVar[status]}`,
        whiteSpace: 'nowrap',
      }}
    >
      <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: colorVar[status], flexShrink: 0 }} />
      {label[status]}
    </span>
  );
}

function PeriodCounterCard({
  title,
  counter,
  loading,
  error,
  onRetry,
}: {
  title: string;
  counter?: {
    workingDaysElapsed: number;
    workingDaysTotal: number;
    achievementPct: number | null;
    status: string;
    actualValue: number;
    expectedValue: number;
    gapValue: number;
    periodTarget: number;
  };
  loading: boolean;
  error?: string;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <Card style={{ width: '100%' }}>
        <LoadingSkeleton variant="kpi" />
      </Card>
    );
  }
  if (error) {
    return (
      <Card style={{ width: '100%' }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{title}</div>
        <ErrorState message={error} onRetry={onRetry} />
      </Card>
    );
  }
  const status = toSemanticStatus((counter?.status as any) ?? 'no_target');
  const elapsed = counter?.workingDaysElapsed ?? 0;
  const total = counter?.workingDaysTotal ?? 0;
  const actual = counter?.actualValue ?? 0;
  const periodTarget = counter?.periodTarget ?? null;
  const pct = counter?.achievementPct != null ? Math.round(counter.achievementPct * 100) : null;
  const gap = counter?.gapValue ?? null;
  const ahead = gap != null && gap >= 0;

  return (
    <Card style={{ width: '100%', textAlign: 'center' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ps-color-muted-text)' }}>{title}</span>
        <PaceBadge status={status} />
      </div>

      <DonutChart
        showTitle={false}
        segments={achievedVsRemainingSegments(actual, periodTarget)}
        valueFormatter={(v) => formatCompactCurrency(v)}
        legendTitle={`${elapsed} / ${total} Working Days`}
        height={200}
        centerLabel={`${elapsed} / ${total}`}
        centerSubLabel="Working Days"
      />

      <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', marginTop: 4 }}>
        {pct != null ? `${pct}% of pace achieved` : 'No target set'}
      </div>
      {gap != null && (
        <div
          title={formatCurrency(Math.abs(gap))}
          style={{
            fontSize: 13,
            fontWeight: 700,
            marginTop: 4,
            color: ahead ? 'var(--ps-color-success)' : 'var(--ps-color-alert)',
          }}
        >
          {ahead ? '+' : '-'}
          {formatCompactCurrency(Math.abs(gap))} vs pace
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Section 2 cards
// ---------------------------------------------------------------------------

function WorkingDaysCard({
  value,
  loading,
  error,
  onRetry,
}: {
  value?: number;
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
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Working Days YTD</div>
        <ErrorState message={error} onRetry={onRetry} />
      </Card>
    );
  }
  return (
    <Card style={{ width: '100%', height: '100%', borderLeft: '4px solid var(--ps-color-success)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--ps-color-muted-text)', marginBottom: 8 }}>
        <CalendarCheck2 size={16} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>Working Days YTD</span>
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--ps-color-text)' }}>{value ?? '—'}</div>
      <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)' }}>days</div>
    </Card>
  );
}

function OfficialHolidaysCard({
  data,
  loading,
  error,
  onRetry,
}: {
  data?: { value: number; items: { date: string; company: string | null; branch: string | null; holidayName: string | null }[] };
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
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Official Holidays YTD</div>
        <ErrorState message={error} onRetry={onRetry} />
      </Card>
    );
  }
  return (
    <Card style={{ width: '100%', height: '100%', borderLeft: '4px solid var(--ps-color-accent)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--ps-color-muted-text)', marginBottom: 8 }}>
        <CalendarDays size={16} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>Official Holidays YTD</span>
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--ps-color-text)' }}>{data?.value ?? 0}</div>
      <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginBottom: 8 }}>days</div>
      <CollapsibleSection title="Holiday List" defaultOpen={false}>
        {data && data.items.length > 0 ? (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {data.items.map((item, i) => (
              <li key={`${item.date}-${i}`} style={{ fontSize: 12, color: 'var(--ps-color-text)', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span>{item.date}</span>
                <span dir="auto" style={{ color: 'var(--ps-color-muted-text)', textAlign: 'right' }}>{item.holidayName || 'Public Holiday'}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)' }}>No holidays recorded year-to-date.</div>
        )}
      </CollapsibleSection>
    </Card>
  );
}

/** One branch's date+reason to a single hover-tooltip line -- a branch can close on separate
 * occasions for different reasons, so the tooltip lists every occurrence, most recent first
 * (already sorted that way by computeForcedClosuresYtd), not just the row's total day count. */
function occurrencesTooltip(occurrences: { date: string; reason: string | null }[]): string {
  return occurrences.map((o) => `${o.date} — ${o.reason || 'No reason recorded'}`).join('\n');
}

function ForcedClosuresCard({
  data,
  loading,
  error,
  onRetry,
}: {
  data?: {
    value: number;
    branches: { branch: string; branchName: string; company: string | null; days: number; occurrences: { date: string; reason: string | null }[] }[];
  };
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
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Forced Closures YTD</div>
        <ErrorState message={error} onRetry={onRetry} />
      </Card>
    );
  }
  return (
    <Card style={{ width: '100%', height: '100%', borderLeft: '4px solid var(--ps-color-watch)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--ps-color-muted-text)', marginBottom: 8 }}>
        <CalendarOff size={16} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>Forced Closures YTD</span>
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--ps-color-text)' }}>{data?.value ?? 0}</div>
      <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginBottom: 8 }}>branch-days</div>
      <CollapsibleSection title="Branch Breakdown" defaultOpen={false}>
        {data && data.branches.length > 0 ? (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {data.branches.map((b, i) => (
              <li
                key={`${b.branch}-${i}`}
                title={occurrencesTooltip(b.occurrences)}
                style={{ fontSize: 12, color: 'var(--ps-color-text)', display: 'flex', alignItems: 'center', gap: 6, cursor: 'help' }}
              >
                <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: companyDotColor(b.company), flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={b.branch}>
                    {b.branchName}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--ps-color-muted-text)' }}>{b.branch}</div>
                </span>
                <span style={{ color: 'var(--ps-color-muted-text)', flexShrink: 0 }}>{formatDayCount(b.days)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)' }}>No forced closures recorded year-to-date.</div>
        )}
      </CollapsibleSection>
    </Card>
  );
}

function SimpleCountCard({
  title,
  icon: Icon,
  value,
  caption,
  loading,
  error,
  onRetry,
}: {
  title: string;
  icon: React.ComponentType<{ size?: number | string }>;
  value?: number;
  caption?: string;
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
  return (
    <Card style={{ width: '100%', height: '100%', borderLeft: '4px solid var(--ps-color-success)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--ps-color-muted-text)', marginBottom: 8 }}>
        <Icon size={16} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>{title}</span>
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--ps-color-text)' }}>{value ?? '—'}</div>
      <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginBottom: 8 }}>days</div>
      {caption && <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)' }}>{caption}</div>}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Section 3 cards
// ---------------------------------------------------------------------------

function ImpactCard({
  title,
  description,
  value,
  formatMagnitude,
  formatFullMagnitude,
  trendValues,
  trendPct,
  sparklineLabel,
  axisTooltip,
  loading,
  error,
  onRetry,
}: {
  title: string;
  description: string;
  /** Raw signed backend figure: Target YTD minus Actual YTD -- positive = behind pace (a
   * shortfall), negative = ahead of pace (a surplus). See criticalNumber.ts's computeMissingSummary
   * docstring. Displayed sign-flipped (Actual - Target) so ahead-of-pace reads as a positive/green
   * number, matching PeriodCounterCard's gapValue convention (Issue #8, dashboard revision pass). */
  value: number | null;
  formatMagnitude: (absoluteValue: number) => string;
  formatFullMagnitude?: (absoluteValue: number) => string;
  trendValues: number[];
  trendPct: number | null;
  sparklineLabel: string;
  /** Hover tooltip (native title attribute) on the trend chart, explaining what its X and Y axes
   * plot -- the sparkline itself is axis-less by design, so this is the only place that meaning is
   * surfaced. */
  axisTooltip: string;
  loading: boolean;
  error?: string;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <Card style={{ width: '100%' }}>
        <LoadingSkeleton variant="kpi" />
      </Card>
    );
  }
  if (error) {
    return (
      <Card style={{ width: '100%' }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{title}</div>
        <ErrorState message={error} onRetry={onRetry} />
      </Card>
    );
  }
  // Lower is better for both of these metrics: a rising trend is a worsening trend.
  const improving = trendPct != null && trendPct <= 0;
  const TrendIcon = improving ? TrendingDown : TrendingUp;
  const trendStatus = trendPct == null ? 'neutral' : improving ? 'success' : 'alert';

  const gap = value == null ? null : -value;
  const behind = gap != null && gap < 0;
  const gapColor = gap == null ? 'var(--ps-color-text)' : behind ? 'var(--ps-color-alert)' : 'var(--ps-color-success)';
  const valueLabel = gap == null ? '—' : `${behind ? '-' : '+'}${formatMagnitude(Math.abs(gap))}`;
  const valueFullLabel = gap == null || !formatFullMagnitude ? undefined : `${behind ? '-' : '+'}${formatFullMagnitude(Math.abs(gap))}`;

  return (
    <Card style={{ width: '100%', borderLeft: `4px solid ${gapColor}` }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ps-color-muted-text)', marginBottom: 8 }}>{title}</div>
      <div style={{ fontSize: 30, fontWeight: 700, color: gapColor, marginBottom: 10 }} title={valueFullLabel}>
        {valueLabel}
      </div>
      <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginTop: -6, marginBottom: 10 }}>
        {gap == null ? '' : behind ? 'Behind pace' : 'Ahead of / on pace'}
      </div>

      {trendValues.length > 1 && (
        <div style={{ borderTop: '1px solid var(--ps-color-border)', paddingTop: 10, marginBottom: 10 }} title={axisTooltip}>
          <Sparkline values={trendValues} status={trendStatus as any} label={sparklineLabel} width={260} height={44} />
        </div>
      )}

      {trendPct != null && (
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 12,
            fontWeight: 600,
            marginBottom: 10,
            color: improving ? 'var(--ps-color-success)' : 'var(--ps-color-alert)',
          }}
        >
          <TrendIcon size={13} />
          {improving ? 'Improving' : 'Worsening'} {formatVariance(trendPct)}
        </div>
      )}

      <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)' }}>{description}</div>
    </Card>
  );
}
