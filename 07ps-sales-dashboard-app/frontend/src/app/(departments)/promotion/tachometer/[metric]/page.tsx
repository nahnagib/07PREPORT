'use client';
import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import { Layers, Target as TargetIcon, AlertTriangle, Award, TrendingDown } from 'lucide-react';
import { AppHeader } from '../../../../../components/AppHeader';
import { BottomNavBar } from '../../../../../components/BottomNavBar';
import { ValidationStatusBar } from '../../../../../components/ValidationStatusBar';
import {
  KpiCard,
  DataGrid,
  InsightCard,
  LoadingSkeleton,
  ErrorState,
  SemanticBadge,
  theme,
} from '@07ps/ui';
import { useAuth } from '../../../../../lib/AuthProvider';
import { PermissionGuard } from '../../../../../components/AuthGuard';
import { useTachometerBreakdown, useTachometerOverview } from '../../../../../lib/hooks';
import type {
  BreakdownGroupBy,
  BreakdownRow,
  TachometerFilters,
  TachometerMetricKey,
  TachometerOverview,
} from '../../../../../lib/api';
import {
  formatCompactCurrency,
  formatCompactVolume,
  formatCurrency,
  formatVariance,
  formatVolume,
  formatTimestamp,
  toSemanticStatus,
} from '../../../../../lib/format';

/**
 * Tachometer drill-down / detail page (Standards Section 3.3 breadcrumb requirement, Section 3.13
 * "split into a summary page + a drill-down/detail page" precedent).
 *
 * Dashboard Hub / department routing pass: moved from `app/tachometer/[metric]/page.tsx` to
 * `app/(departments)/promotion/tachometer/[metric]/page.tsx`, alongside the summary page's own
 * move. Route: /promotion/tachometer/[metric] where metric is one of
 * 'ytdValue' | 'ytdVolume' | 'mtdValue' | 'mtdVolume'. TopTabBar dropped (superseded by the
 * persistent DepartmentSidebar the `(departments)` route group's layout now provides); BottomNavBar
 * is kept alongside the sidebar per explicit user request, since it's the only nav that lists this
 * department's individual reports (and Admin). Every other piece of this page (KPI summary card,
 * breakdown chart/table, insights) is unchanged.
 *
 * Filters/anchorDate are carried forward via URL query params (not through React state/context,
 * since the summary page's filters live in local component state and this is a separate route).
 */

const METRIC_META: Record<
  TachometerMetricKey,
  { title: string; unit: 'value' | 'volume'; overviewKey: TachometerMetricKey }
> = {
  ytdValue: { title: 'YTD Value', unit: 'value', overviewKey: 'ytdValue' },
  ytdVolume: { title: 'YTD Volume', unit: 'volume', overviewKey: 'ytdVolume' },
  mtdValue: { title: 'MTD Value', unit: 'value', overviewKey: 'mtdValue' },
  mtdVolume: { title: 'MTD Volume', unit: 'volume', overviewKey: 'mtdVolume' },
};

const GROUP_BY_OPTIONS: { value: BreakdownGroupBy; label: string }[] = [
  { value: 'salesperson', label: 'Salesperson' },
  { value: 'salesTeam', label: 'Branch' },
  { value: 'segment', label: 'Customer Group' },
];

const CHART_MAX_ROWS = 12;

function parseNumArray(values: string[]): number[] {
  return values.map(Number).filter((n) => !Number.isNaN(n));
}

function isMetricKey(v: string | undefined): v is TachometerMetricKey {
  return !!v && v in METRIC_META;
}

type BreakdownTableRow = BreakdownRow & { id: string; [key: string]: unknown };

/** Quick Insights - client-side aggregate over the rows already fetched for the chart/table below,
 * same spirit as the summary page's Performance Summary. No new classification: every row's
 * `status` still comes from the server's classifyVsTarget. */
function computeBreakdownInsights(rows: BreakdownRow[]) {
  if (rows.length === 0) return null;
  const onTarget = rows.filter((r) => r.status === 'green').length;
  const critical = rows.filter((r) => r.status === 'red').length;
  const ranked = rows.filter((r) => r.variancePct !== null) as (BreakdownRow & { variancePct: number })[];
  const best = ranked.length ? ranked.reduce((a, b) => (b.variancePct > a.variancePct ? b : a)) : null;
  const worst = ranked.length ? ranked.reduce((a, b) => (b.variancePct < a.variancePct ? b : a)) : null;
  return { total: rows.length, onTarget, critical, best, worst };
}

export default function TachometerMetricDetailPage() {
  const params = useParams<{ metric: string }>();
  const searchParams = useSearchParams();
  const { token, user, isSalesperson, salespersonKey, error: authError, retryAuth, logout } = useAuth();
  const [groupBy, setGroupBy] = useState<BreakdownGroupBy>('salesperson');

  const metricParam = Array.isArray(params?.metric) ? params.metric[0] : params?.metric;
  const anchorDate = searchParams.get('anchorDate') ?? new Date().toISOString().slice(0, 10);

  const urlFilters: TachometerFilters = useMemo(
    () => ({
      companyKeys: parseNumArray(searchParams.getAll('companyKeys')),
      segmentKeys: parseNumArray(searchParams.getAll('segmentKeys')),
      channelKeys: parseNumArray(searchParams.getAll('channelKeys')),
      salesTeamKeys: searchParams.getAll('salesTeamKeys'),
      salespersonKeys: parseNumArray(searchParams.getAll('salespersonKeys')),
    }),
    [searchParams],
  );

  const effectiveFilters = useMemo<TachometerFilters>(
    () =>
      isSalesperson
        ? {
            companyKeys: [],
            segmentKeys: [],
            channelKeys: [],
            salesTeamKeys: [],
            salespersonKeys: salespersonKey != null ? [salespersonKey] : [],
          }
        : urlFilters,
    [isSalesperson, salespersonKey, urlFilters],
  );

  // Eternal-skeleton fix: threads devAuth's own error/retry through, same as the summary page --
  // see hooks.ts's docstring.
  const overview = useTachometerOverview(token, anchorDate, effectiveFilters, authError, retryAuth);

  if (!isMetricKey(metricParam)) {
    return (
      <div style={{ padding: 24 }}>
        <p style={{ marginBottom: 12 }}>Unknown metric &ldquo;{metricParam}&rdquo;.</p>
        <Link href="/promotion/tachometer" style={{ color: 'var(--ps-color-accent)' }}>
          Back to Tachometer
        </Link>
      </div>
    );
  }

  return (
    <PermissionGuard pageKey="tachometer">
      <MetricDetailBody
        metricKey={metricParam}
        anchorDate={anchorDate}
        effectiveFilters={effectiveFilters}
        overview={overview}
        groupBy={groupBy}
        onGroupByChange={setGroupBy}
        token={token}
        authError={authError}
        retryAuth={retryAuth}
        roleLabel={user?.role.label ?? user?.fullName}
        onLogout={logout}
      />
    </PermissionGuard>
  );
}

function MetricDetailBody({
  metricKey,
  anchorDate,
  effectiveFilters,
  overview,
  groupBy,
  onGroupByChange,
  token,
  authError,
  retryAuth,
  roleLabel,
  onLogout,
}: {
  metricKey: TachometerMetricKey;
  anchorDate: string;
  effectiveFilters: TachometerFilters;
  overview: ReturnType<typeof useTachometerOverview>;
  groupBy: BreakdownGroupBy;
  onGroupByChange: (g: BreakdownGroupBy) => void;
  token: string | null;
  authError: string | null;
  retryAuth: () => void;
  roleLabel?: string;
  onLogout?: () => void;
}) {
  const router = useRouter();
  const meta = METRIC_META[metricKey];
  const fmt = meta.unit === 'value' ? formatCompactCurrency : formatCompactVolume;
  const fmtFull = meta.unit === 'value' ? formatCurrency : formatVolume;
  const card = overview.data?.[meta.overviewKey];

  const breakdown = useTachometerBreakdown(token, anchorDate, effectiveFilters, metricKey, groupBy, authError, retryAuth);

  const rows: BreakdownTableRow[] = (breakdown.data?.rows ?? []).map((r) => ({
    ...r,
    id: String(r.groupKey ?? r.groupLabel),
  }));

  const insights = useMemo(() => computeBreakdownInsights(breakdown.data?.rows ?? []), [breakdown.data]);

  const groupLabelHeader = GROUP_BY_OPTIONS.find((o) => o.value === groupBy)?.label ?? 'Group';

  function handleAnchorDateChange(next: string) {
    const params = new URLSearchParams(Array.from(new URLSearchParams(window.location.search).entries()));
    params.set('anchorDate', next);
    router.replace(`/promotion/tachometer/${metricKey}?${params.toString()}`);
  }

  function handleRefresh() {
    overview.retry();
    breakdown.retry();
  }

  function buildFilterSummary(): string {
    const parts: string[] = [];

    // Date
    if (anchorDate) {
      parts.push(`Date: ${anchorDate}`);
    }

    // Group by
    parts.push(`Group by: ${groupLabelHeader}`);

    return parts.length > 0 ? parts.join(' | ') : 'No filters applied';
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', paddingBottom: 64 }}>
      <AppHeader
        pageTitle={`${meta.title} — Breakdown`}
        anchorDate={anchorDate}
        onAnchorDateChange={handleAnchorDateChange}
        onRefresh={handleRefresh}
        roleLabel={roleLabel}
        onLogout={onLogout}
        showDateInput={false}
      />

      <ValidationStatusBar />

      <main style={{ flex: 1, padding: 'var(--ps-space-4, 24px)' }}>
          {/* --- Large KPI Summary Card (Full Width) --- */}
          <div style={{ display: 'flex', width: '100%', marginBottom: 'var(--ps-space-4, 24px)' }}>
            <KpiCard
              title={meta.title}
              variant="gauge"
              actual={card?.actual ?? 0}
              targetToDate={card?.targetToDate ?? null}
              status={toSemanticStatus(card?.status ?? 'no_target')}
              actualLabel={fmt(card?.actual ?? 0)}
              actualFullValue={fmtFull(card?.actual ?? 0)}
              targetLabel={card?.targetToDate != null ? fmt(card.targetToDate) : undefined}
              referenceMetrics={
                card
                  ? [
                      { label: 'Variance', value: formatVariance(card.variancePct) ?? '—' },
                      {
                        label: 'FY/FM Target',
                        value: fmt(card.fullPeriodTarget),
                        fullValue: fmtFull(card.fullPeriodTarget),
                      },
                    ]
                  : []
              }
              loading={overview.loading}
              error={overview.error ?? undefined}
              onRetry={overview.retry}
              fullWidth={true}
            />
          </div>


          {/* --- Quick Insights Panel --- */}
          {insights && (
            <section style={{ marginBottom: 'var(--ps-space-4, 24px)' }}>
              <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 'var(--ps-space-2, 8px)' }}>Quick Insights</h2>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                  gap: 'var(--ps-space-3, 16px)',
                }}
              >
                <InsightCard icon={Layers} label="Total Groups" value={String(insights.total)} status="neutral" />
                <InsightCard
                  icon={TargetIcon}
                  label="On Target"
                  value={`${insights.onTarget} / ${insights.total}`}
                  status={insights.onTarget > 0 ? 'success' : 'neutral'}
                />
                <InsightCard
                  icon={AlertTriangle}
                  label="Critical"
                  value={`${insights.critical} / ${insights.total}`}
                  status={insights.critical > 0 ? 'alert' : 'success'}
                />
                <InsightCard
                  icon={Award}
                  label="Top Performer"
                  value={insights.best?.groupLabel ?? '—'}
                  caption={insights.best ? formatVariance(insights.best.variancePct) : undefined}
                  status="success"
                />
                <InsightCard
                  icon={TrendingDown}
                  label="Needs Attention"
                  value={insights.worst?.groupLabel ?? '—'}
                  caption={insights.worst ? formatVariance(insights.worst.variancePct) : undefined}
                  status="alert"
                />
              </div>
            </section>
          )}

          {/* --- Interactive Data Table --- design-system-enforcement pass: wrapped in the same
              Card shell (radius/border/background/shadow) and header-row treatment as
              PerformanceReportTable, so the breakdown table has real card depth instead of
              floating bare against the page background. */}
          <div
            className="ps-card"
            style={{
              borderRadius: 'var(--ps-card-radius, 14px)',
              border: '1px solid var(--ps-color-border)',
              background: 'var(--ps-card-bg)',
              boxShadow: 'var(--ps-card-shadow)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                padding: '12px 16px',
                borderBottom: '1px solid var(--ps-color-border)',
              }}
            >
              <h2 style={{ fontSize: theme.table.titleFontSize, fontWeight: 700, margin: 0 }}>Full Breakdown</h2>
            </div>
            <div style={{ padding: 'var(--ps-space-3, 16px)' }}>
              {breakdown.loading && <LoadingSkeleton variant="table" />}
              {breakdown.error && <ErrorState message={breakdown.error} onRetry={breakdown.retry} />}
              {!breakdown.loading && !breakdown.error && rows.length === 0 && (
                <p style={{ fontSize: 13, color: 'var(--ps-color-muted-text)' }}>No rows for the current filters.</p>
              )}
              {!breakdown.loading && !breakdown.error && rows.length > 0 && (
                <DataGrid<BreakdownTableRow>
                  getRowId={(r) => r.id}
                  fileName={`${metricKey}-breakdown-by-${groupBy}`}
                  filtersSummary={buildFilterSummary()}
                  columns={[
                    { key: 'groupLabel', header: groupLabelHeader },
                    {
                      key: 'actual',
                      header: 'Actual',
                      align: 'right',
                      render: (r) => <span title={fmtFull(r.actual)}>{fmt(r.actual)}</span>,
                      rawValue: (r) => r.actual,
                    },
                    {
                      key: 'targetToDate',
                      header: 'Target-to-date',
                      align: 'right',
                      render: (r) =>
                        r.targetToDate !== null ? <span title={fmtFull(r.targetToDate)}>{fmt(r.targetToDate)}</span> : '—',
                      rawValue: (r) => r.targetToDate ?? '',
                    },
                    {
                      key: 'variancePct',
                      header: 'Variance',
                      align: 'right',
                      render: (r) => formatVariance(r.variancePct) ?? '—',
                      rawValue: (r) => (r.variancePct !== null ? `${(r.variancePct * 100).toFixed(2)}%` : ''),
                    },
                    {
                      key: 'status',
                      header: 'Status',
                      render: (r) => <SemanticBadge status={toSemanticStatus(r.status)} />,
                      rawValue: (r) => r.status,
                    },
                  ]}
                  rows={rows}
                />
              )}
            </div>
          </div>
      </main>

      <BottomNavBar active="Tachometer" />
    </div>
  );
}
