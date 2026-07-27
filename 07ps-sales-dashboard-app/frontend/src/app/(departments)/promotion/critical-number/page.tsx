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
import { useFilterState } from '../../../../components/FilterProvider';
import { Card, SemanticBadge, LoadingSkeleton, ErrorState, ProgressBar, Sparkline, CollapsibleSection, type SemanticStatus } from '@07ps/ui';
import { useAuth } from '../../../../lib/AuthProvider';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useFilterOptions, useCriticalNumberOverview, useRefreshStatus, useExportOverviewReport } from '../../../../lib/hooks';
import { formatCompactCurrency, formatCurrency, formatVariance, formatTimestamp, toSemanticStatus } from '../../../../lib/format';

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
 * throwaway/validation MySQL warehouse Tachometer reads from (Fact_SalesLines, Fact_Targets,
 * Fact_OffDays, Dim_Date) -- there is no live Odoo or Power BI connection, and no sample/mock data
 * path; ValidationStatusBar below states this plainly, same as Tachometer.
 */
export default function CriticalNumberPage() {
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
  const overview = useCriticalNumberOverview(token, anchorDate, effectiveFilters, authError, retryAuth);
  const refreshStatus = useRefreshStatus(token, authError, retryAuth);
  const exportReport = useExportOverviewReport(token, anchorDate, effectiveFilters);

  function handleReset() {
    resetFilters();
  }

  function handleRefresh() {
    overview.retry();
    refreshStatus.retry();
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
                <DailyCriticalNumberCard value={data?.dailyCriticalNumber ?? null} loading={overview.loading} error={overview.error ?? undefined} onRetry={overview.retry} />
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
                description="Net shortfall vs. pace: (Working Days YTD x Daily Critical Number) minus Actual YTD Value, floored at zero -- surplus days offset shortfall days"
                valueLabel={data ? formatCompactCurrency(data.missingValueYtd.value) : '—'}
                valueFullLabel={data ? formatCurrency(data.missingValueYtd.value) : undefined}
                trendValues={data?.missingValueYtd.trendValues ?? []}
                trendPct={data?.missingValueYtd.trendPct ?? null}
                sparklineLabel="Cumulative missing value, as of each month-end this year"
                axisTooltip="X-axis: each month of this year, left to right (running total as of that month's end). Y-axis: cumulative missing value (LYD) = (Working Days Elapsed x Daily Critical Number) minus Actual Value to that point, floored at zero -- a running total, not that month's own isolated result."
                loading={overview.loading}
                error={overview.error ?? undefined}
                onRetry={overview.retry}
              />
              <ImpactCard
                title="Missing Days YTD"
                description="Missing Value YTD expressed in day-equivalents (Missing Value / Daily Critical Number)"
                valueLabel={data ? formatDayCount(data.missingDaysYtd.value) : '—'}
                trendValues={data?.missingDaysYtd.trendValues ?? []}
                trendPct={data?.missingDaysYtd.trendPct ?? null}
                sparklineLabel="Cumulative days behind pace, last 30 days"
                axisTooltip="X-axis: each of the last 30 calendar days, left to right (running total as of that day). Y-axis: cumulative shortfall expressed as a number of days at the Daily Critical Number -- a running total, not that single day's own result."
                loading={overview.loading}
                error={overview.error ?? undefined}
                onRetry={overview.retry}
              />
            </section>
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
}: {
  value: number | null;
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
      <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', maxWidth: 320 }}>
        Required daily value to stay on this year&apos;s pace. Recalculates when Company or Customer Group filters change.
      </div>
    </Card>
  );
}

const rangeBarFillColor: Record<SemanticStatus, string> = {
  success: 'var(--ps-color-success)',
  watch: 'var(--ps-color-watch)',
  alert: 'var(--ps-color-alert)',
  neutral: 'var(--ps-color-neutral-text)',
};

/** Horizontal linear bar over an arbitrary [min, max] range (not [0, target] like @07ps/ui's
 * ProgressBar) -- same thin-pill visual as ProgressBar/the Monthly-Yearly Counter bars, just with
 * a caller-supplied floor instead of always starting at zero. Used for Daily Counter's straight
 * 0..Daily Critical Number scale, replacing the old semi-circular gauge. */
function RangeBar({ value, min, max, status }: { value: number; min: number; max: number; status: SemanticStatus }) {
  const span = max - min;
  const ratio = span > 0 ? Math.max(0, Math.min(1, (value - min) / span)) : 0;
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      style={{ width: '100%', height: 6, borderRadius: 999, background: 'var(--ps-color-border)', overflow: 'hidden' }}
    >
      <div
        style={{
          width: `${ratio * 100}%`,
          height: '100%',
          borderRadius: 999,
          background: rangeBarFillColor[status],
          transition: 'width 0.2s ease-out',
        }}
      />
    </div>
  );
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
  const hasTarget = target != null && target > 0;
  const min = 0;
  const max = hasTarget ? target : Math.max(actual, 1);

  return (
    <Card style={{ width: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: 'var(--ps-color-muted-text)', display: 'flex', flexShrink: 0 }}>
            <GaugeIcon size={16} />
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ps-color-muted-text)' }}>Daily Counter</span>
        </div>
        <SemanticBadge status={status} />
      </div>

      <div
        style={{ fontSize: 32, fontWeight: 700, color: 'var(--ps-color-text)', textAlign: 'center', margin: '4px 0 16px' }}
        title={formatCurrency(actual)}
      >
        {formatCompactCurrency(actual)}
      </div>

      <RangeBar value={actual} min={min} max={max} status={status} />
      {hasTarget && (
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ps-color-text)' }}>{formatCompactCurrency(min)}</div>
            <div style={{ fontSize: 9, color: 'var(--ps-color-muted-text)' }}>0</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ps-color-text)' }} title={formatCurrency(max)}>{formatCompactCurrency(max)}</div>
            <div style={{ fontSize: 9, color: 'var(--ps-color-muted-text)' }}>Critical Number</div>
          </div>
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 8,
          marginTop: 16,
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
 * same status. */
function PaceBadge({ status }: { status: SemanticStatus }) {
  const label: Record<SemanticStatus, string> = {
    success: 'Ahead of Pace',
    watch: 'Behind Pace',
    alert: 'Critical',
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
  const pct = counter?.achievementPct != null ? Math.round(counter.achievementPct * 100) : null;
  const gap = counter?.gapValue ?? null;
  const ahead = gap != null && gap >= 0;

  return (
    <Card style={{ width: '100%', textAlign: 'center' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ps-color-muted-text)' }}>{title}</span>
        <PaceBadge status={status} />
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--ps-color-text)', marginBottom: 4 }}>
        {elapsed} / {total} <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ps-color-muted-text)' }}>Days</span>
      </div>
      <ProgressBar actual={elapsed} targetToDate={total || null} status={status} label={`${elapsed} of ${total} working days elapsed`} />
      <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', marginTop: 8 }}>
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
  valueLabel,
  valueFullLabel,
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
  valueLabel: string;
  valueFullLabel?: string;
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

  return (
    <Card style={{ width: '100%', borderLeft: `4px solid var(--ps-color-alert)` }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ps-color-muted-text)', marginBottom: 8 }}>{title}</div>
      <div style={{ fontSize: 30, fontWeight: 700, color: 'var(--ps-color-text)', marginBottom: 10 }} title={valueFullLabel}>
        {valueLabel}
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
