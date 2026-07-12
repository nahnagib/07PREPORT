'use client';
import React, { useMemo, useState } from 'react';
import { Layers } from 'lucide-react';
import { AppHeader } from '../../../../components/AppHeader';
import { FilterBar } from '../../../../components/FilterBar';
import { BottomNavBar } from '../../../../components/BottomNavBar';
import { ValidationStatusBar } from '../../../../components/ValidationStatusBar';
import { RefreshFooter } from '../../../../components/RefreshFooter';
import { useBusinessUnit } from '../../../../components/BusinessUnitProvider';
import { Card, ChartPanel, ComboChart, DonutChart, LoadingSkeleton, ErrorState } from '@07ps/ui';
import { useAuth } from '../../../../lib/AuthProvider';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useFilterOptions, useInvoicesEngineOverview, useRefreshStatus } from '../../../../lib/hooks';
import type { InvoiceStats, InvoicesEngineKpis, InvoicesEngineScope, InvoiceYearClassBreakdown, TachometerFilters } from '../../../../lib/api';
import { formatCurrency, formatTimestamp, formatVolume } from '../../../../lib/format';

const todayIso = () => new Date().toISOString().slice(0, 10);

const EMPTY_FILTERS: TachometerFilters = {
  companyKeys: [],
  segmentKeys: [],
  channelKeys: [],
  salesTeamKeys: [],
  salespersonKeys: [],
};

const INVOICE_CLASS_LABELS: Record<string, string> = {
  A: 'Class A (> 50K)',
  B: 'Class B (25K – 50K)',
  C: 'Class C (5K – 25K)',
  D: 'Class D (< 5K)',
};

// Categorical (non-status) reuse of existing brand hues -- Invoice Class is a size segment, not a
// good/bad signal, so this deliberately avoids --ps-color-alert (reserved for "bad" everywhere
// else on the platform). Same "borrow a couple of brand hues for a category dimension that has no
// dedicated token" convention as Critical Number page's COMPANY_DOT_COLOR.
const INVOICE_CLASS_COLOR: Record<string, string> = {
  A: 'var(--ps-color-accent)',
  B: 'var(--ps-color-gold)',
  C: 'var(--ps-color-success)',
  D: 'var(--ps-color-watch)',
};

function invoiceClassColor(cls: string): string {
  return INVOICE_CLASS_COLOR[cls] ?? 'var(--ps-color-neutral-text)';
}

/** 2-decimal K/M abbreviation, no currency prefix -- matches this page's own spec examples
 * ("6.10K", "10.46K"), distinct from the shared formatCompactCurrency's 1-decimal/"LYD "-prefixed
 * convention used elsewhere on the platform. Full LYD precision is still always one hover away via
 * the `title` attribute (formatCurrency). */
function formatInvoiceValue(value: number | null): string {
  if (value === null) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatLines(value: number | null): string {
  if (value === null) return '—';
  return value.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function formatVolumeOrDash(value: number | null): string {
  return value === null ? '—' : formatVolume(value);
}

/** Y-axis tick formatter for currency values: millions with an "M" suffix, one decimal place
 * unless it rounds to a whole number -- same convention as Revenue Trend's chart axes. */
function formatMillions(value: number): string {
  const fixed = (value / 1_000_000).toFixed(1);
  return `${fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed}M`;
}

function formatThousands(value: number): string {
  const fixed = (value / 1_000).toFixed(1);
  return `${fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed}K`;
}

function formatPlainNumber(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

/**
 * Invoices Engine page (Sales, Level 3) -- fourth live Sales page after Tachometer, Critical
 * Number and Revenue Trend, built to the exact same architecture (AppHeader + FilterBar +
 * ValidationStatusBar + BottomNavBar, PermissionGuard pageKey='invoices_engine', same
 * useAuth/useFilterOptions/useRefreshStatus hooks, same @07ps/ui primitives) so it is
 * indistinguishable in look/behavior from the rest of the platform.
 *
 * All figures come from backend/src/measures/invoicesEngine.ts, which reads Fact_SalesLines at its
 * real invoice-line grain -- the same table/filter-column shape Tachometer/Revenue Trend already
 * read, just with the per-line InvoiceKey/InvoiceValue/Invoice Class columns those pages never
 * needed.
 *
 * Three page-specific interactions, all backed by real backend re-queries (not just client-side
 * re-rendering of an already-fetched payload):
 *   1. Sales Trend, drill-down mode ON: clicking a year re-renders the chart itself into that
 *      year's Invoice Class breakdown (drilledYear) -- scoped to the chart only.
 *   2. Sales Trend, drill-down mode OFF: clicking a year (bar or line point) sets it as the page's
 *      Year filter (selectedYear) -- every other visual re-fetches scoped to it, while Sales Trend
 *      itself keeps showing the full series with that year highlighted/dimmed.
 *   3. Invoices Classification: clicking a segment sets it as the page's Invoice Class filter
 *      (selectedInvoiceClass) -- same re-fetch/self-exclusion pattern, mirrored the other way
 *      around (every visual except the donut itself narrows).
 * selectedYear/selectedInvoiceClass compose with each other and with the sidebar's own filters --
 * see backend/src/routes/invoicesEngine.ts's header comment for exactly which query honors which
 * scope field. Invoices Trend never produces a selection of its own; it's always fully scoped by
 * whichever of the other two is active, and is otherwise a read-only trend view (no info icon, no
 * click affordance beyond the standard hover tooltip).
 */
export default function InvoicesEnginePage() {
  const { setBusinessUnit } = useBusinessUnit();
  const { user, isSalesperson, salespersonKey, token, error: authError, retryAuth, logout } = useAuth();
  const [anchorDate, setAnchorDate] = useState(todayIso());
  const [dateFromDate, setDateFromDate] = useState(todayIso());
  const [dateToDate, setDateToDate] = useState(todayIso());
  const [filters, setFilters] = useState<TachometerFilters>(EMPTY_FILTERS);

  const effectiveFilters = useMemo<TachometerFilters>(
    () => (isSalesperson ? { ...EMPTY_FILTERS, salespersonKeys: salespersonKey != null ? [salespersonKey] : [] } : filters),
    [isSalesperson, salespersonKey, filters],
  );

  // Sales Trend chart interaction: drillMode toggles what clicking a year does. Off (default) ->
  // clicking a year sets it as the page's Year filter (selectedYear), re-scoping every other
  // visual via a real backend re-query. On -> clicking a year drills the chart itself into that
  // year's Invoice Class breakdown (drilledYear), page-scope untouched. Invoices Classification's
  // segment click (selectedInvoiceClass) is the same page-filter pattern as selectedYear, just
  // sourced from a different chart. All reset on Reset Filters, same as every other page-local UI
  // state on filter reset.
  const [drillMode, setDrillMode] = useState(false);
  const [drilledYear, setDrilledYear] = useState<number | null>(null);
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const [selectedInvoiceClass, setSelectedInvoiceClass] = useState<string | null>(null);

  const scope: InvoicesEngineScope = { selectedYear, selectedInvoiceClass };

  const filterOptions = useFilterOptions(token, authError, retryAuth);
  const overview = useInvoicesEngineOverview(token, anchorDate, effectiveFilters, scope, authError, retryAuth);
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
    setDateFromDate(today);
    setDateToDate(today);
    setDrillMode(false);
    setDrilledYear(null);
    setSelectedYear(null);
    setSelectedInvoiceClass(null);
  }

  function handleRefresh() {
    overview.retry();
    refreshStatus.retry();
  }

  function handleSalesTrendCategoryClick(label: string) {
    if (drillMode) {
      if (drilledYear == null) {
        const year = Number(label);
        if (!Number.isNaN(year)) setDrilledYear(year);
      }
      // Already drilled into one year's class breakdown -- no further drill level defined here.
      return;
    }
    const year = Number(label);
    if (Number.isNaN(year)) return;
    setSelectedYear((prev) => (prev === year ? null : year));
  }

  /** The "click empty space to clear" half of Sales Trend's page-filter toggle (Section 1's Mode
   * B) -- only meaningful outside drill-down mode, where a click has nothing to clear. */
  function handleSalesTrendAreaClick() {
    if (drillMode) return;
    setSelectedYear(null);
  }

  function handleClassificationSegmentClick(invoiceClass: string) {
    setSelectedInvoiceClass((prev) => (prev === invoiceClass ? null : invoiceClass));
  }

  function toggleDrillMode() {
    setDrillMode((prev) => {
      const next = !prev;
      // Mutually exclusive per spec: entering drill-down clears any active Year page-filter (its
      // own click behavior takes over instead); leaving it clears the in-chart drill.
      if (next) setSelectedYear(null);
      else setDrilledYear(null);
      return next;
    });
  }

  const roleLabel = user?.role.label ?? user?.fullName;
  const lastRefreshLabel = refreshStatus.data ? formatTimestamp(refreshStatus.data.lastRefreshTime) : undefined;

  const data = overview.data;
  const kpis = data?.kpis;

  const drilledYearData: InvoiceYearClassBreakdown | undefined =
    drillMode && drilledYear != null ? data?.salesTrend.byYearClass.find((y) => y.year === drilledYear) : undefined;

  const salesTrendPoints = drilledYearData
    ? drilledYearData.classes.map((c) => ({
        label: INVOICE_CLASS_LABELS[c.invoiceClass]?.split(' (')[0] ?? c.invoiceClass,
        invoiceSalesValue: c.invoiceSalesValue,
        invoiceCount: c.invoiceCount,
      }))
    : (data?.salesTrend.byYear ?? []).map((y) => ({
        label: y.label,
        invoiceSalesValue: y.invoiceSalesValue,
        invoiceCount: y.invoiceCount,
      }));

  const invoicesTrendPoints = (data?.invoicesTrend ?? []).map((y) => ({
    label: y.label,
    avgSalesPerInvoice: y.avgSalesPerInvoice ?? 0,
    avgLinesPerInvoice: y.avgLinesPerInvoice ?? 0,
    avgVolumePerInvoice: y.avgVolumePerInvoice ?? 0,
  }));

  const classificationSegments = (data?.classification ?? []).map((c) => ({
    id: c.invoiceClass,
    label: INVOICE_CLASS_LABELS[c.invoiceClass] ?? c.invoiceClass,
    value: c.value,
    color: invoiceClassColor(c.invoiceClass),
  }));

  return (
    <PermissionGuard pageKey="invoices_engine">
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)' }}>
            {/* Zone A -- KPI Indicators */}
            <div className="ps-invoices-kpi-row">
              <MetricPanel
                title="# of Lines per Invoice"
                kpis={kpis}
                pick={(s) => s.avgLinesPerInvoice}
                formatter={formatLines}
                loading={overview.loading}
                error={overview.error ?? undefined}
                onRetry={overview.retry}
              />
              <MetricPanel
                title="Sales per Invoice"
                kpis={kpis}
                pick={(s) => s.avgSalesPerInvoice}
                formatter={formatInvoiceValue}
                fullFormatter={(v) => (v === null ? undefined : formatCurrency(v))}
                loading={overview.loading}
                error={overview.error ?? undefined}
                onRetry={overview.retry}
              />
              <MetricPanel
                title="Volume per Invoice"
                kpis={kpis}
                pick={(s) => s.avgVolumePerInvoice}
                formatter={formatVolumeOrDash}
                loading={overview.loading}
                error={overview.error ?? undefined}
                onRetry={overview.retry}
              />
            </div>

            {/* Zone B -- Sales Trend (left) + Total Invoices KPI cards (right) */}
            <div className="ps-invoices-zone">
              <ChartPanel
                title="Sales Trend"
                infoText="Invoice Sales Value and # of Invoices by year. Enable drill-down, then click a year to break it out by Invoice Class."
                style={{ minHeight: 380 }}
                headerActions={<DrillToggle active={drillMode} onToggle={toggleDrillMode} />}
              >
                {overview.loading ? (
                  <LoadingSkeleton variant="chart" />
                ) : overview.error ? (
                  <ErrorState message={overview.error} onRetry={overview.retry} />
                ) : (
                  <>
                    {drilledYearData && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                        <span style={{ fontSize: 12, color: 'var(--ps-color-muted-text)' }}>
                          Showing {drilledYearData.year} by Invoice Class
                        </span>
                        <button
                          type="button"
                          onClick={() => setDrilledYear(null)}
                          style={{
                            fontSize: 11,
                            fontWeight: 600,
                            color: 'var(--ps-color-accent)',
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            padding: 0,
                            textDecoration: 'underline',
                          }}
                        >
                          Back to all years
                        </button>
                      </div>
                    )}
                    <ComboChart
                      title="Sales Trend"
                      showTitle={false}
                      points={salesTrendPoints}
                      bars={[{ key: 'invoiceSalesValue', name: 'Invoice Sales Value', color: 'var(--ps-color-accent)' }]}
                      lines={[{ key: 'invoiceCount', name: '# of Invoices', color: 'var(--ps-color-last-year)', yAxisId: 'right' }]}
                      leftAxisFormatter={formatMillions}
                      rightAxisFormatter={formatThousands}
                      tooltipFormatters={{
                        invoiceSalesValue: (v) => formatCurrency(v),
                        invoiceCount: (v) => v.toLocaleString(),
                      }}
                      onCategoryClick={handleSalesTrendCategoryClick}
                      onAreaClick={handleSalesTrendAreaClick}
                      highlightedCategory={!drilledYearData && selectedYear != null ? String(selectedYear) : null}
                    />
                  </>
                )}
              </ChartPanel>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(2, 1fr)',
                  gridTemplateRows: 'repeat(2, 1fr)',
                  gap: 'var(--ps-space-3, 16px)',
                }}
              >
                <TotalInvoicesCard
                  label="YTD Total # of Invoices"
                  value={kpis?.ytd.invoiceCount}
                  loading={overview.loading}
                  error={overview.error ?? undefined}
                  onRetry={overview.retry}
                />
                <TotalInvoicesCard
                  label="LYTD Total # of Invoices"
                  value={kpis?.lytd.invoiceCount}
                  loading={overview.loading}
                  error={overview.error ?? undefined}
                  onRetry={overview.retry}
                />
                <TotalInvoicesCard
                  label="MTD Total # of Invoices"
                  value={kpis?.mtd.invoiceCount}
                  loading={overview.loading}
                  error={overview.error ?? undefined}
                  onRetry={overview.retry}
                />
                <TotalInvoicesCard
                  label="LMTD Total # of Invoices"
                  value={kpis?.lmtd.invoiceCount}
                  loading={overview.loading}
                  error={overview.error ?? undefined}
                  onRetry={overview.retry}
                />
              </div>
            </div>

            {/* Zone C -- Invoices Trend (left) + Invoices Classification donut (right) */}
            <div className="ps-invoices-zone">
              <ChartPanel title="Invoices Trend" style={{ minHeight: 380 }}>
                {overview.loading ? (
                  <LoadingSkeleton variant="chart" />
                ) : overview.error ? (
                  <ErrorState message={overview.error} onRetry={overview.retry} />
                ) : (
                  <ComboChart
                    title="Invoices Trend"
                    showTitle={false}
                    points={invoicesTrendPoints}
                    bars={[{ key: 'avgSalesPerInvoice', name: 'Avg Sales per Invoice', color: 'var(--ps-color-accent)' }]}
                    lines={[
                      { key: 'avgLinesPerInvoice', name: 'Avg Lines per Invoice', color: 'var(--ps-color-success)', yAxisId: 'right' },
                      { key: 'avgVolumePerInvoice', name: 'Avg Volume per Invoice', color: 'var(--ps-color-watch)', yAxisId: 'right' },
                    ]}
                    leftAxisFormatter={formatThousands}
                    rightAxisFormatter={formatPlainNumber}
                    tooltipFormatters={{
                      avgSalesPerInvoice: (v) => formatCurrency(v),
                      avgLinesPerInvoice: (v) => formatLines(v),
                      avgVolumePerInvoice: (v) => formatVolume(v),
                    }}
                  />
                )}
              </ChartPanel>

              <ChartPanel title="Invoices Classification" infoText="Invoice value by Invoice Class, year-to-date." style={{ minHeight: 380 }}>
                {overview.loading ? (
                  <LoadingSkeleton variant="chart" />
                ) : overview.error ? (
                  <ErrorState message={overview.error} onRetry={overview.retry} />
                ) : (
                  <DonutChart
                    title="Invoices Classification"
                    showTitle={false}
                    segments={classificationSegments}
                    valueFormatter={(v) => formatInvoiceValue(v)}
                    legendTitle="Invoice Class (YTD)"
                    onSegmentClick={handleClassificationSegmentClick}
                    selectedId={selectedInvoiceClass}
                  />
                )}
              </ChartPanel>
            </div>
          </div>
        </main>

        <RefreshFooter
          lastUpdate={formatTimestamp(refreshStatus.data?.lastUpdate ?? null)}
          lastRefreshTime={formatTimestamp(refreshStatus.data?.lastRefreshTime ?? null)}
        />

        <BottomNavBar active="Invoices Engine" />
      </div>
    </PermissionGuard>
  );
}

// ---------------------------------------------------------------------------
// Zone A -- one KPI panel: title + 2x2 grid of period tiles (LYTD, YTD / LMTD, MTD).
// ---------------------------------------------------------------------------

function MetricPanel({
  title,
  kpis,
  pick,
  formatter,
  fullFormatter,
  loading,
  error,
  onRetry,
}: {
  title: string;
  kpis?: InvoicesEngineKpis;
  pick: (stats: InvoiceStats) => number | null;
  formatter: (value: number | null) => string;
  fullFormatter?: (value: number | null) => string | undefined;
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

  const tiles: { label: string; value: number | null }[] = [
    { label: 'LYTD', value: kpis ? pick(kpis.lytd) : null },
    { label: 'YTD', value: kpis ? pick(kpis.ytd) : null },
    { label: 'LMTD', value: kpis ? pick(kpis.lmtd) : null },
    { label: 'MTD', value: kpis ? pick(kpis.mtd) : null },
  ];

  return (
    <Card style={{ width: '100%', height: '100%' }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ps-color-text)', marginBottom: 'var(--ps-space-2, 8px)' }}>{title}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {tiles.map((t) => (
          <div
            key={t.label}
            title={fullFormatter?.(t.value)}
            style={{
              background: 'var(--ps-color-muted-bg)',
              borderRadius: 'var(--ps-card-radius-sm, 10px)',
              padding: '10px 8px',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--ps-color-text)', fontVariantNumeric: 'tabular-nums' }}>
              {formatter(t.value)}
            </div>
            <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginTop: 2 }}>{t.label}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Zone B -- one Total Invoices KPI card.
// ---------------------------------------------------------------------------

function TotalInvoicesCard({
  label,
  value,
  loading,
  error,
  onRetry,
}: {
  label: string;
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
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{label}</div>
        <ErrorState message={error} onRetry={onRetry} />
      </Card>
    );
  }
  return (
    <Card
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        gap: 4,
      }}
    >
      <div style={{ fontSize: 34, fontWeight: 700, color: 'var(--ps-color-text)', fontVariantNumeric: 'tabular-nums' }}>
        {value != null ? value.toLocaleString() : '—'}
      </div>
      <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)' }}>{label}</div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Sales Trend chart's drill-down mode toggle -- the one page-specific interaction control, styled
// like every other small header control in this app (ChartPanel's own expand button, TrendChart/
// ComboChart's Export image button: bordered, muted-bg, 6px radius).
// ---------------------------------------------------------------------------

function DrillToggle({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      title={
        active
          ? 'Drill-down mode on — click a year to break it out by Invoice Class'
          : 'Enable drill-down mode (Year → Invoice Class)'
      }
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 11,
        fontWeight: 600,
        padding: '4px 9px',
        borderRadius: 6,
        border: `1px solid ${active ? 'var(--ps-color-accent)' : 'var(--ps-color-border)'}`,
        background: active ? 'var(--ps-color-accent-bg)' : 'var(--ps-color-muted-bg)',
        color: active ? 'var(--ps-color-accent)' : 'var(--ps-color-muted-text)',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      <Layers size={12} />
      Drill-down
    </button>
  );
}
