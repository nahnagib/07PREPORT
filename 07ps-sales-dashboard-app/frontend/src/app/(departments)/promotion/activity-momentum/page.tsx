'use client';
import React, { useMemo, useState } from 'react';
import { ArrowLeft, Info } from 'lucide-react';
import { AppHeader } from '../../../../components/AppHeader';
import { FilterBar } from '../../../../components/FilterBar';
import { BottomNavBar } from '../../../../components/BottomNavBar';
import { ValidationStatusBar } from '../../../../components/ValidationStatusBar';
import { RefreshFooter } from '../../../../components/RefreshFooter';
import { useBusinessUnit } from '../../../../components/BusinessUnitProvider';
import { Card, ChartPanel, DonutChart, TrendChart, DataTable, Select, Button, InsightCard, LoadingSkeleton, ErrorState, type Column } from '@07ps/ui';
import { useAuth } from '../../../../lib/AuthProvider';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useActivityMomentumOverview, useFilterOptions, useRefreshStatus } from '../../../../lib/hooks';
import type { ActivityOpportunityRow, TachometerFilters } from '../../../../lib/api';
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

const CATEGORY_PALETTE = [
  'var(--ps-color-accent)',
  'var(--ps-color-alert)',
  'var(--ps-color-gold)',
  'var(--ps-color-watch)',
  'var(--ps-color-success)',
  'var(--ps-color-last-year)',
  'var(--ps-color-neutral-text)',
];

type ActivityFilterKey = 'active' | 'lost' | 'won' | 'inactive' | 'withoutNextStep' | 'ytd';

function formatCountOrDash(v: number | null | undefined): string {
  return v != null ? v.toLocaleString() : '—';
}

function matchesActivityFilter(o: ActivityOpportunityRow, key: ActivityFilterKey | null): boolean {
  if (!key) return true;
  if (key === 'active') return o.isActive;
  if (key === 'lost') return o.isLost;
  if (key === 'won') return o.isWon;
  if (key === 'inactive') return o.isInactive === true;
  if (key === 'withoutNextStep') return o.isOpen && o.isWithoutNextStep === true;
  return o.isYtd;
}

interface OpportunityTableRow extends Record<string, unknown> {
  opportunityId: string;
  createdDate: string;
  name: string;
  customer: string;
  company: string;
  expectedRevenue: number;
  salesperson: string;
  stage: string;
}

const opportunityColumns: Column<OpportunityTableRow>[] = [
  { key: 'createdDate', header: 'Created Date' },
  { key: 'name', header: 'Opportunity Name' },
  { key: 'customer', header: 'Customer' },
  { key: 'company', header: 'Company' },
  { key: 'expectedRevenue', header: 'Expected Revenue', align: 'right', render: (r) => formatCurrency(r.expectedRevenue) },
  { key: 'salesperson', header: 'Salesperson' },
  { key: 'stage', header: 'Stage' },
];

function toTableRow(o: ActivityOpportunityRow): OpportunityTableRow {
  return {
    opportunityId: o.opportunityId,
    createdDate: o.createdDate ?? '—',
    name: o.name || '—',
    customer: o.customer ?? '—',
    company: o.company ?? '—',
    expectedRevenue: o.expectedRevenue,
    salesperson: o.salesperson ?? '—',
    stage: o.stage ?? '—',
  };
}

/**
 * Activity Momentum page (Sales, Level 3) -- eighth and final live Sales page of this build.
 * Same architecture as every other page. Two views on one page (Summary default, Opportunity
 * Activities Details reached by clicking the "Opportunity Activities" panel title -- same
 * clickable-title convention as Customer Growth's Customer Status panel).
 *
 * `#W/O Activity`, `#W/O Next Step` and the Rates panel's Inactive Deals Ratio depend on 6 columns
 * that were added to the ETL's OpportunityFactBuilder this session but not yet exported to the
 * live warehouse (the ETL wasn't re-run, by design -- see backend/src/measures/activityMomentum.ts's
 * header). `overview.data.activityColumnsAvailable` tells the frontend whether to render those
 * figures or the honest "—" placeholder; the Activity filter panel also hides the 2
 * activity-dependent options entirely while unavailable, rather than offering a filter that would
 * always return zero rows.
 */
export default function ActivityMomentumPage() {
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

  const [view, setView] = useState<'summary' | 'details'>('summary');
  const [activityFilter, setActivityFilter] = useState<ActivityFilterKey | null>(null);

  const filterOptions = useFilterOptions(token, authError, retryAuth);
  const overview = useActivityMomentumOverview(token, anchorDate, effectiveFilters, authError, retryAuth);
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
    setView('summary');
    setActivityFilter(null);
  }

  function handleRefresh() {
    overview.retry();
    refreshStatus.retry();
  }

  function handleBackToSummary() {
    setView('summary');
    setActivityFilter(null);
  }

  const roleLabel = user?.role.label ?? user?.fullName;
  const lastRefreshLabel = refreshStatus.data ? formatTimestamp(refreshStatus.data.lastRefreshTime) : undefined;
  const data = overview.data;
  const activityAvailable = data?.activityColumnsAvailable ?? false;

  const lostByReasonSegments = (data?.lostByReason ?? []).map((r, i) => ({
    id: r.reason,
    label: r.reason,
    value: r.count,
    color: CATEGORY_PALETTE[i % CATEGORY_PALETTE.length],
  }));

  const newOpportunitiesPoints = (data?.newOpportunitiesByMonth ?? []).map((p) => ({
    label: p.label,
    actual: p.countYtd,
    lastYear: p.countLytd,
    target: null,
  }));

  const activityFilterOptions = [
    { value: 'active', label: 'Active' },
    { value: 'lost', label: 'Lost' },
    { value: 'won', label: 'Won' },
    ...(activityAvailable ? [{ value: 'inactive', label: 'Inactive' }, { value: 'withoutNextStep', label: 'Without Next Step' }] : []),
    { value: 'ytd', label: 'YTD' },
  ];

  const filteredOpportunities = (data?.opportunities ?? []).filter((o) => matchesActivityFilter(o, activityFilter)).map(toTableRow);
  const totalsRow: Partial<OpportunityTableRow> = {
    createdDate: 'Total',
    expectedRevenue: filteredOpportunities.reduce((sum, r) => sum + r.expectedRevenue, 0),
  };

  return (
    <PermissionGuard pageKey="activity_momentum">
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
          {view === 'summary' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)' }}>
              {/* Zone A -- Opportunity Activities (left) + Rates (right) */}
              <div className="ps-invoices-zone">
                <ActivityCountsPanel
                  counts={data?.counts}
                  activityAvailable={activityAvailable}
                  loading={overview.loading}
                  error={overview.error ?? undefined}
                  onRetry={overview.retry}
                  onTitleClick={() => setView('details')}
                />

                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gridTemplateRows: '1fr 1fr', gap: 'var(--ps-space-3, 16px)' }}>
                  <InsightCard
                    label="Inactive Deals Ratio"
                    value={data?.rates.inactiveDealsRatio != null ? formatVariance(data.rates.inactiveDealsRatio) ?? '—' : '—'}
                    status={data?.rates.inactiveDealsRatio != null && data.rates.inactiveDealsRatio > 0.5 ? 'alert' : 'neutral'}
                    accentBg={data?.rates.inactiveDealsRatio != null && data.rates.inactiveDealsRatio > 0.5}
                    loading={overview.loading}
                  />
                  <InsightCard
                    label="Lost Deals Ratio"
                    value={data?.rates.lostDealsRatio != null ? formatVariance(data.rates.lostDealsRatio) ?? '—' : '—'}
                    status={data?.rates.lostDealsRatio != null && data.rates.lostDealsRatio > 0.5 ? 'alert' : 'neutral'}
                    accentBg={data?.rates.lostDealsRatio != null && data.rates.lostDealsRatio > 0.5}
                    loading={overview.loading}
                  />
                </div>
              </div>

              {/* Zone B -- Total Lost Opportunity by Reason (left) + New Opportunities (right) */}
              <div className="ps-invoices-zone">
                <ChartPanel title="Total Lost Opportunity by Reason" style={{ minHeight: 360 }}>
                  {overview.loading ? (
                    <LoadingSkeleton variant="chart" />
                  ) : overview.error ? (
                    <ErrorState message={overview.error} onRetry={overview.retry} />
                  ) : (
                    <DonutChart title="Total Lost Opportunity by Reason" showTitle={false} segments={lostByReasonSegments} legendTitle="Reason" />
                  )}
                </ChartPanel>

                <ChartPanel title="New Opportunities" style={{ minHeight: 360 }}>
                  {overview.loading ? (
                    <LoadingSkeleton variant="chart" />
                  ) : overview.error ? (
                    <ErrorState message={overview.error} onRetry={overview.retry} />
                  ) : (
                    <TrendChart
                      title="New Opportunities"
                      showTitle={false}
                      points={newOpportunitiesPoints}
                      actualLabel="YTD"
                      lastYearLabel="LYTD"
                      valueFormatter={(v) => v.toLocaleString()}
                    />
                  )}
                </ChartPanel>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-3, 16px)' }}>
              <div className="ps-invoices-zone">
                <ActivityCountsPanel
                  counts={data?.counts}
                  activityAvailable={activityAvailable}
                  loading={overview.loading}
                  error={overview.error ?? undefined}
                  onRetry={overview.retry}
                />

                <Card>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ps-color-text)', marginBottom: 'var(--ps-space-2, 8px)' }}>
                    Activity Filter
                  </div>
                  <Select
                    label="Opportunity Status"
                    options={activityFilterOptions}
                    value={activityFilter ? [activityFilter] : []}
                    onChange={(v) => setActivityFilter((v[0] as ActivityFilterKey) ?? null)}
                    multiSelect={false}
                  />
                </Card>
              </div>

              <ChartPanel title="Opportunity Table" style={{ minHeight: 480 }}>
                {overview.loading ? (
                  <LoadingSkeleton variant="chart" />
                ) : overview.error ? (
                  <ErrorState message={overview.error} onRetry={overview.retry} />
                ) : (
                  <DataTable columns={opportunityColumns} rows={filteredOpportunities} totalsRow={totalsRow} getRowId={(row) => row.opportunityId} />
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
          lastRefreshTime={formatTimestamp(refreshStatus.data?.lastRefreshTime ?? null)}
        />

        <BottomNavBar active="Activity Momentum" />
      </div>
    </PermissionGuard>
  );
}

// ---------------------------------------------------------------------------
// Zone A / Details view shared "Opportunity Activities" 2x3 counts panel. Title is clickable only
// in Summary view (onTitleClick passed); Details view keeps it visible but non-clickable, same
// convention as Customer Growth's Customer Status panel.
// ---------------------------------------------------------------------------

function ActivityCountsPanel({
  counts,
  activityAvailable,
  loading,
  error,
  onRetry,
  onTitleClick,
}: {
  counts?: { totalYtd: number; won: number; withoutActivity: number | null; active: number; lost: number; withoutNextStep: number | null };
  activityAvailable: boolean;
  loading: boolean;
  error?: string;
  onRetry: () => void;
  onTitleClick?: () => void;
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
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Opportunity Activities</div>
        <ErrorState message={error} onRetry={onRetry} />
      </Card>
    );
  }

  const tiles = [
    { label: '#YTD', value: counts?.totalYtd },
    { label: '#Won', value: counts?.won },
    { label: '#W/O Activity', value: counts?.withoutActivity },
    { label: '#Active', value: counts?.active },
    { label: '#Lost', value: counts?.lost },
    { label: '#W/O Next Step', value: counts?.withoutNextStep },
  ];

  return (
    <Card style={{ width: '100%', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 'var(--ps-space-2, 8px)' }}>
        {onTitleClick ? (
          <span
            role="button"
            tabIndex={0}
            onClick={onTitleClick}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onTitleClick();
              }
            }}
            title="View Opportunity Activities details"
            style={{ fontSize: 13, fontWeight: 700, color: 'var(--ps-color-text)', cursor: 'pointer' }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = 'var(--ps-color-accent)';
              e.currentTarget.style.textDecoration = 'underline';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = 'var(--ps-color-text)';
              e.currentTarget.style.textDecoration = 'none';
            }}
          >
            Opportunity Activities
          </span>
        ) : (
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ps-color-text)' }}>Opportunity Activities</span>
        )}
        <span
          title={
            activityAvailable
              ? 'YTD opportunity counts by activity status.'
              : 'YTD opportunity counts by activity status. #W/O Activity and #W/O Next Step need a data refresh not yet run -- they show — until then.'
          }
          aria-label="Opportunity Activities definitions"
          style={{ color: 'var(--ps-color-muted-text)', display: 'inline-flex', cursor: 'help' }}
        >
          <Info size={13} />
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
        {tiles.map((t) => (
          <div key={t.label} style={{ background: 'var(--ps-color-muted-bg)', borderRadius: 'var(--ps-card-radius-sm, 10px)', padding: '10px 8px', textAlign: 'center' }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--ps-color-text)', fontVariantNumeric: 'tabular-nums' }}>
              {formatCountOrDash(t.value)}
            </div>
            <div style={{ fontSize: 10, color: 'var(--ps-color-muted-text)', marginTop: 2 }}>{t.label}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}
