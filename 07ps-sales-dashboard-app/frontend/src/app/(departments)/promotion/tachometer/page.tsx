'use client';
import React from 'react';
import { useRouter } from 'next/navigation';
import { Wallet, Package, TrendingUp } from 'lucide-react';
import { AppHeader } from '../../../../components/AppHeader';
import { FilterBar } from '../../../../components/FilterBar';
import { BottomNavBar } from '../../../../components/BottomNavBar';
import { ValidationStatusBar } from '../../../../components/ValidationStatusBar';
import { RefreshFooter } from '../../../../components/RefreshFooter';
import { useFilterState } from '../../../../components/FilterProvider';
import {
  KpiCard,
  PerformanceReportTable,
  EmptyState,
  Card,
  SemanticBadge,
  LoadingSkeleton,
  Sparkline,
  type ReferenceMetric,
  type PerformanceReportRow,
} from '@07ps/ui';
import { useAuth } from '../../../../lib/AuthProvider';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useFilterOptions, useTachometerOverview, useTachometerTrend, useRefreshStatus, useExportOverviewReport } from '../../../../lib/hooks';
import type { TachometerFilters, TachometerCard, AspCard, TachometerMetricKey } from '../../../../lib/api';
import {
  toSemanticStatus,
  formatCompactCurrency,
  formatCompactVolume,
  formatCurrency,
  formatVolume,
  formatAsp,
  formatVariance,
  formatTimestamp,
} from '../../../../lib/format';

/* Cards now fill their grid cells without constraint. Grid proportions (1.5fr 260px 1.5fr)
   ensure consistent sizing across viewport widths. */
const CARD_BOX: React.CSSProperties = {
  display: 'flex',
  width: '100%',
};

/**
 * Shared bottom-row tiles for all 4 gauge cards (YTD Value, YTD Volume, MTD Value, MTD Volume) --
 * LYTD/LFY/FYT/Variance for YTD cards, LMTD/LFM/FMT/Variance for MTD cards. One function, not one
 * per card: TachometerCard's shape (and every field these tiles read) is identical regardless of
 * period or metric -- computeYtdCard/computeMtdCard both populate lastYearSamePeriod (LYTD for YTD
 * cards, LMTD for MTD cards, via lytdWindow/lmtdWindow respectively), fullLastPeriodActual (Full
 * Last Year for YTD cards via flyWindow, Full Last Month for MTD cards via flmWindow), and
 * fullPeriodTarget (current year's full annual target for YTD cards, current month's full target
 * for MTD cards) -- see backend/src/measures/tachometer.ts's computeCard/computeYtdCard/
 * computeMtdCard. No backend change needed for any of the 4 cards; only the labels differ by
 * period, which is exactly what the `period` param selects here.
 */
function gaugeCardReferenceMetrics(card: TachometerCard, unit: 'value' | 'volume', period: 'ytd' | 'mtd'): ReferenceMetric[] {
  const fmt = unit === 'value' ? formatCompactCurrency : formatCompactVolume;
  const fmtFull = unit === 'value' ? formatCurrency : formatVolume;
  const labels = period === 'ytd' ? { ly: 'LYTD', full: 'LFY', target: 'FYT' } : { ly: 'LMTD', full: 'LFM', target: 'FMT' };
  return [
    { label: labels.ly, value: fmt(card.lastYearSamePeriod), fullValue: fmtFull(card.lastYearSamePeriod) },
    { label: labels.full, value: fmt(card.fullLastPeriodActual), fullValue: fmtFull(card.fullLastPeriodActual) },
    { label: labels.target, value: fmt(card.fullPeriodTarget), fullValue: fmtFull(card.fullPeriodTarget) },
    // Variance vs same-period-last-year (not vs Target -- the achievement progress bar above
    // already covers actual-vs-target).
    { label: 'Variance', value: formatVariance(lyVariancePct(card.actual, card.lastYearSamePeriod)) ?? '—' },
  ];
}

/** ASP cards are back to their own bespoke non-gauge layout (see the JSX below) -- no natural
 * min/max range for an average-selling-price figure, so they never should have gotten
 * RadialGauge's Target x0.5/x1.5 scale. Kept as a 2-tile (Target, Variance) row, distinct from the
 * 4-tile gaugeCardReferenceMetrics above. */
function aspCardToReferenceMetrics(actual: number | null, target: number | null, lastYearAsp: number | null): ReferenceMetric[] {
  if (actual === null || target === null || target <= 0) return [];
  return [
    {
      label: 'Target',
      value: formatAsp(target),
      fullValue: formatAsp(target),
    },
    // Variance vs LY ASP (LYTD ASP for the YTD card, LMTD ASP for the MTD card), not vs Target --
    // same convention as the gauge cards.
    { label: 'Variance', value: formatVariance(lyVariancePct(actual, lastYearAsp ?? 0)) ?? '—' },
  ];
}

function aspVariancePct(actual: number, target: number | null): number | null {
  if (target === null || target <= 0) return null;
  return (actual - target) / target;
}

function fullPeriodVariancePct(actual: number, target: number): number | null {
  if (target <= 0) return null;
  return (actual - target) / target;
}

function lyVariancePct(actual: number, ly: number): number | null {
  if (!ly || ly <= 0) return null;
  return (actual - ly) / ly;
}

/**
 * Builds the /promotion/tachometer/[metric] drill-down URL, carrying forward the current
 * filters/anchorDate.
 */
function buildBreakdownHref(metric: TachometerMetricKey, anchorDate: string, filters: TachometerFilters): string {
  const params = new URLSearchParams({ anchorDate });
  (filters.companyKeys ?? []).forEach((v) => params.append('companyKeys', String(v)));
  (filters.segmentKeys ?? []).forEach((v) => params.append('segmentKeys', String(v)));
  (filters.channelKeys ?? []).forEach((v) => params.append('channelKeys', String(v)));
  (filters.salesTeamKeys ?? []).forEach((v) => params.append('salesTeamKeys', v));
  (filters.salespersonKeys ?? []).forEach((v) => params.append('salespersonKeys', String(v)));
  return `/promotion/tachometer/${metric}?${params.toString()}`;
}

/**
 * Tachometer page (Standards Sections 3.1-3.9, 4, 5.2; Tachometer manual).
 *
 * IMPORTANT - this page is wired to the throwaway/validation MySQL warehouse (see
 * data/ingestion/tachometer_kpi_validation.md). There is no live Odoo connection anywhere in this
 * stack. The ValidationStatusBar below says this plainly.
 *
 * Sign-in is simulated via DevAuthProvider -- a dev-only token mint, not a real identity system.
 *
 * Dashboard Hub / department routing pass: moved from `app/page.tsx` to
 * `app/(departments)/promotion/tachometer/page.tsx` -- the root `/` route is now the 7Ps Dashboard
 * Hub, and this page lives one level under the new Promotion department route (`/promotion`),
 * consistent with every other department's `/[department]/[report]` shape. The page's own content
 * is unchanged from the previous dark-theme rebuild; it now also sits inside the new persistent
 * DepartmentSidebar (rendered by the `(departments)` route group's layout) in addition to keeping
 * its own BottomNavBar (Tachometer/Critical Number/Revenue Trend/Invoices Engine/Customer Growth +
 * Admin) -- both navs are kept per explicit user request, since Admin had no other entry point once
 * BottomNavBar was briefly dropped. AppSidebar/IconNavRail/TopTabBar and the previous 12-column grid
 * layout are all left in place in the codebase, unused, per this session's "never delete superseded
 * work" convention.
 */
export default function TachometerPage() {
  const router = useRouter();
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
    resetFilters,
  } = useFilterState();

  // Eternal-skeleton fix: every one of these now also gets devAuth's own error/retry, so if the
  // dev-session token mint itself failed (e.g. backend unreachable), these resolve to that same
  // error + a working Retry instead of freezing at loading:true forever. See hooks.ts's docstring.
  const filterOptions = useFilterOptions(token, authError, retryAuth);
  const overview = useTachometerOverview(token, anchorDate, effectiveFilters, authError, retryAuth);
  const trend = useTachometerTrend(token, anchorDate, effectiveFilters, authError, retryAuth);
  const refreshStatus = useRefreshStatus(token, authError, retryAuth);
  const exportReport = useExportOverviewReport(token, anchorDate, effectiveFilters);

  function handleReset() {
    resetFilters();
  }

  function handleRefresh() {
    overview.retry();
    trend.retry();
    refreshStatus.retry();
  }

  function buildFilterSummary(): string {
    const parts: string[] = [];

    // Date range
    if (dateFromDate && dateToDate) {
      if (dateFromDate === dateToDate) {
        parts.push(`Date: ${dateFromDate}`);
      } else {
        parts.push(`Date Range: ${dateFromDate} to ${dateToDate}`);
      }
    }

    // Company
    if (filters.companyKeys?.length) {
      const labels = filterOptions.businessUnits.data
        ?.filter((b) => filters.companyKeys!.includes(b.company_key as number))
        .map((b) => b.company_name);
      if (labels?.length) parts.push(`Company: ${labels.join(', ')}`);
    }

    // Segment
    if (filters.segmentKeys?.length) {
      const labels = filterOptions.customerGroups.data
        ?.filter((s) => filters.segmentKeys!.includes(s.segment_key as number))
        .map((s) => s.segment_name);
      if (labels?.length) parts.push(`Customer Group: ${labels.join(', ')}`);
    }

    // Distribution Channel
    if (filters.channelKeys?.length) {
      const labels = filterOptions.distributionChannels.data
        ?.filter((c) => filters.channelKeys!.includes(c.channel_key as number))
        .map((c) => c.channel_name);
      if (labels?.length) parts.push(`Distribution Channel: ${labels.join(', ')}`);
    }

    // Branch
    if (filters.salesTeamKeys?.length) {
      const labels = filterOptions.branches.data
        ?.filter((b) => filters.salesTeamKeys!.includes(b.sales_team_key as string))
        .map((b) => b.sales_team_name);
      if (labels?.length) parts.push(`Branch: ${labels.join(', ')}`);
    }

    // Salesperson
    if (filters.salespersonKeys?.length) {
      const labels = filterOptions.salespersons.data
        ?.filter((s) => filters.salespersonKeys!.includes(s.salesperson_key as number))
        .map((s) => s.salesperson_name);
      if (labels?.length) parts.push(`Salesperson: ${labels.join(', ')}`);
    }

    return parts.length > 0 ? parts.join(' | ') : 'No filters applied';
  }

  async function handleExportTablePdf(title: string, rows: PerformanceReportRow[]) {
    try {
      // Import jspdf and html2canvas dynamically to avoid SSR issues
      const html2canvas = (await import('html2canvas')).default;
      const jsPDF = (await import('jspdf')).jsPDF;

      // Create a temporary container for PDF rendering
      const tempContainer = document.createElement('div');
      tempContainer.style.position = 'absolute';
      tempContainer.style.left = '-9999px';
      tempContainer.style.width = '1000px';
      tempContainer.style.background = '#ffffff';
      tempContainer.style.padding = '30px';
      tempContainer.style.fontFamily = 'Arial, sans-serif';
      tempContainer.style.fontSize = '12px';
      tempContainer.style.color = '#111827';

      // Add title
      const titleEl = document.createElement('h2');
      titleEl.textContent = title;
      titleEl.style.fontSize = '18px';
      titleEl.style.fontWeight = 'bold';
      titleEl.style.marginBottom = '10px';
      titleEl.style.color = '#111827';
      tempContainer.appendChild(titleEl);

      // Add filter summary
      const filterSummary = buildFilterSummary();
      const filterEl = document.createElement('p');
      filterEl.textContent = `Filters: ${filterSummary}`;
      filterEl.style.fontSize = '11px';
      filterEl.style.color = '#6b7280';
      filterEl.style.marginBottom = '20px';
      filterEl.style.borderBottom = '1px solid #e5e7eb';
      filterEl.style.paddingBottom = '10px';
      tempContainer.appendChild(filterEl);

      // Create table
      const table = document.createElement('table');
      table.style.width = '100%';
      table.style.borderCollapse = 'collapse';
      table.style.marginBottom = '20px';

      // Header
      const thead = document.createElement('thead');
      const headerRow = document.createElement('tr');
      const headers = ['Metric Name', 'Actual', 'Target', 'Variance%', 'Variance LY', 'Trend', 'Status'];
      headers.forEach((h) => {
        const th = document.createElement('th');
        th.textContent = h;
        th.style.padding = '10px';
        th.style.textAlign = 'left';
        th.style.fontWeight = 'bold';
        th.style.backgroundColor = '#f3f4f6';
        th.style.borderBottom = '2px solid #d1d5db';
        th.style.fontSize = '11px';
        headerRow.appendChild(th);
      });
      thead.appendChild(headerRow);
      table.appendChild(thead);

      // Body
      const tbody = document.createElement('tbody');
      rows.forEach((row, idx) => {
        const tr = document.createElement('tr');
        tr.style.backgroundColor = idx % 2 === 0 ? '#ffffff' : '#f9fafb';

        const cells = [
          row.metric,
          row.actualLabel,
          row.targetLabel,
          row.variancePct !== null ? `${(row.variancePct * 100).toFixed(2)}%` : '—',
          row.varianceLyPct !== null ? `${(row.varianceLyPct * 100).toFixed(2)}%` : '—',
          '—', // Trend sparkline not rendered in PDF
          row.status || '—', // Status will show as text
        ];

        cells.forEach((cell) => {
          const td = document.createElement('td');
          td.textContent = String(cell);
          td.style.padding = '8px';
          td.style.textAlign = 'left';
          td.style.borderBottom = '1px solid #e5e7eb';
          td.style.fontSize = '11px';
          tr.appendChild(td);
        });

        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      tempContainer.appendChild(table);

      // Add timestamp
      const timestamp = document.createElement('p');
      timestamp.textContent = `Generated: ${new Date().toLocaleString()}`;
      timestamp.style.fontSize = '10px';
      timestamp.style.color = '#9ca3af';
      timestamp.style.marginTop = '20px';
      tempContainer.appendChild(timestamp);

      // Append to DOM temporarily
      document.body.appendChild(tempContainer);

      // Convert to canvas
      const canvas = await html2canvas(tempContainer, {
        scale: 2,
        useCORS: true,
        logging: false,
        backgroundColor: '#ffffff',
      });

      // Remove temporary container
      document.body.removeChild(tempContainer);

      // Create PDF
      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF({
        orientation: 'landscape',
        unit: 'mm',
        format: 'a4',
      });

      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const imgWidth = pageWidth - 20;
      const imgHeight = (canvas.height * imgWidth) / canvas.width;
      let heightLeft = imgHeight;
      let position = 10;

      pdf.addImage(imgData, 'PNG', 10, position, imgWidth, imgHeight);
      heightLeft -= pageHeight - 20;

      while (heightLeft > 0) {
        position = heightLeft - imgHeight;
        pdf.addPage();
        pdf.addImage(imgData, 'PNG', 10, position, imgWidth, imgHeight);
        heightLeft -= pageHeight - 20;
      }

      // Download
      pdf.save(`${title.replace(/\s+/g, '-').toLowerCase()}.pdf`);
    } catch (err) {
      console.error('PDF export failed:', err);
    }
  }

  const noOverviewData =
    !overview.loading && !overview.error && overview.data && overview.data.ytdValue.actual === 0 && overview.data.mtdValue.actual === 0;

  const roleLabel = user?.role.label ?? user?.fullName;
  const lastRefreshLabel = refreshStatus.data ? formatTimestamp(refreshStatus.data.lastRefreshTime) : undefined;

  const trendPoints = trend.data?.points ?? [];
  const revenueTrendValues = trendPoints.map((p) => p.value);
  const volumeTrendValues = trendPoints.map((p) => p.volume);
  const aspTrendValues = trendPoints.map((p) => p.asp ?? 0);

  const data = overview.data;

  const valueRows: PerformanceReportRow[] = data
    ? [
        {
          id: 'ytd-value',
          metric: 'YTD Value',
          actualLabel: formatCompactCurrency(data.ytdValue.actual),
          actualFullValue: formatCurrency(data.ytdValue.actual),
          targetLabel: data.ytdValue.targetToDate != null ? formatCompactCurrency(data.ytdValue.targetToDate) : '—',
          variancePct: data.ytdValue.variancePct,
          varianceLyPct: lyVariancePct(data.ytdValue.actual, data.ytdValue.lastYearSamePeriod),
          trendValues: revenueTrendValues,
          status: toSemanticStatus(data.ytdValue.status),
        },
        {
          id: 'mtd-value',
          metric: 'MTD Value',
          actualLabel: formatCompactCurrency(data.mtdValue.actual),
          actualFullValue: formatCurrency(data.mtdValue.actual),
          targetLabel: data.mtdValue.targetToDate != null ? formatCompactCurrency(data.mtdValue.targetToDate) : '—',
          variancePct: data.mtdValue.variancePct,
          varianceLyPct: lyVariancePct(data.mtdValue.actual, data.mtdValue.lastYearSamePeriod),
          trendValues: revenueTrendValues,
          status: toSemanticStatus(data.mtdValue.status),
        },
        {
          id: 'full-last-year-value',
          metric: 'Full Last Year Value',
          actualLabel: formatCompactCurrency(data.ytdValue.fullLastPeriodActual),
          actualFullValue: formatCurrency(data.ytdValue.fullLastPeriodActual),
          targetLabel: formatCompactCurrency(data.ytdValue.fullPeriodTarget),
          variancePct: fullPeriodVariancePct(data.ytdValue.fullLastPeriodActual, data.ytdValue.fullPeriodTarget),
          varianceLyPct: null,
        },
        {
          id: 'full-last-month-value',
          metric: 'Full Last Month Value',
          actualLabel: formatCompactCurrency(data.mtdValue.fullLastPeriodActual),
          actualFullValue: formatCurrency(data.mtdValue.fullLastPeriodActual),
          targetLabel: formatCompactCurrency(data.mtdValue.fullPeriodTarget),
          variancePct: fullPeriodVariancePct(data.mtdValue.fullLastPeriodActual, data.mtdValue.fullPeriodTarget),
          varianceLyPct: null,
        },
      ]
    : [];

  const volumeAspRows: PerformanceReportRow[] = data
    ? [
        {
          id: 'ytd-volume',
          metric: 'YTD Volume',
          actualLabel: formatCompactVolume(data.ytdVolume.actual),
          actualFullValue: formatVolume(data.ytdVolume.actual),
          targetLabel: data.ytdVolume.targetToDate != null ? formatCompactVolume(data.ytdVolume.targetToDate) : '—',
          variancePct: data.ytdVolume.variancePct,
          varianceLyPct: lyVariancePct(data.ytdVolume.actual, data.ytdVolume.lastYearSamePeriod),
          trendValues: volumeTrendValues,
          status: toSemanticStatus(data.ytdVolume.status),
        },
        {
          id: 'mtd-volume',
          metric: 'MTD Volume',
          actualLabel: formatCompactVolume(data.mtdVolume.actual),
          actualFullValue: formatVolume(data.mtdVolume.actual),
          targetLabel: data.mtdVolume.targetToDate != null ? formatCompactVolume(data.mtdVolume.targetToDate) : '—',
          variancePct: data.mtdVolume.variancePct,
          varianceLyPct: lyVariancePct(data.mtdVolume.actual, data.mtdVolume.lastYearSamePeriod),
          trendValues: volumeTrendValues,
          status: toSemanticStatus(data.mtdVolume.status),
        },
        {
          id: 'full-last-year-volume',
          metric: 'Full Last Year Volume',
          actualLabel: formatCompactVolume(data.ytdVolume.fullLastPeriodActual),
          actualFullValue: formatVolume(data.ytdVolume.fullLastPeriodActual),
          targetLabel: formatCompactVolume(data.ytdVolume.fullPeriodTarget),
          variancePct: fullPeriodVariancePct(data.ytdVolume.fullLastPeriodActual, data.ytdVolume.fullPeriodTarget),
          varianceLyPct: null,
        },
        {
          id: 'full-last-month-volume',
          metric: 'Full Last Month Volume',
          actualLabel: formatCompactVolume(data.mtdVolume.fullLastPeriodActual),
          actualFullValue: formatVolume(data.mtdVolume.fullLastPeriodActual),
          targetLabel: formatCompactVolume(data.mtdVolume.fullPeriodTarget),
          variancePct: fullPeriodVariancePct(data.mtdVolume.fullLastPeriodActual, data.mtdVolume.fullPeriodTarget),
          varianceLyPct: null,
        },
        {
          id: 'ytd-asp',
          metric: 'YTD ASP',
          actualLabel: formatAsp(data.aspYtd.actualAsp),
          targetLabel: data.aspYtd.targetAsp != null ? formatAsp(data.aspYtd.targetAsp) : '—',
          variancePct: aspVariancePct(data.aspYtd.actualAsp ?? 0, data.aspYtd.targetAsp),
          varianceLyPct: null,
          trendValues: aspTrendValues,
          status: toSemanticStatus(data.aspYtd.status),
        },
        {
          id: 'mtd-asp',
          metric: 'MTD ASP',
          actualLabel: formatAsp(data.aspMtd.actualAsp),
          targetLabel: data.aspMtd.targetAsp != null ? formatAsp(data.aspMtd.targetAsp) : '—',
          variancePct: aspVariancePct(data.aspMtd.actualAsp ?? 0, data.aspMtd.targetAsp),
          varianceLyPct: null,
          trendValues: aspTrendValues,
          status: toSemanticStatus(data.aspMtd.status),
        },
      ]
    : [];

  return (
    <PermissionGuard pageKey="tachometer">
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

      {/* Status-check requirement: this must never read as "connected to production". */}
      <ValidationStatusBar
        isStale={refreshStatus.data?.isStale}
        isInverted={refreshStatus.data?.isInverted}
        lastRefreshTime={lastRefreshLabel}
      />

      <main style={{ flex: 1, padding: 'var(--ps-space-4, 24px)' }}>
        {noOverviewData ? (
          <EmptyState onResetFilters={handleReset} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)' }}>
            {/* Metrics grid - Layout Matrix: Value (left) | ASP column (center) | Volume (right),
                YTD on top row, MTD on bottom row. The 4 Value/Volume cards use KpiCard's gauge
                variant; the 2 ASP cards are their own bespoke non-gauge layout (see below -- ASP
                has no natural min/max range the way a currency/volume total does, so it never
                should have been forced onto RadialGauge's Target x0.5/x1.5 scale; reverted after
                trying that). Grid widened: Value/Volume columns increased from 1fr to 1.5fr so
                they're visibly larger (primary KPIs per the manual), while the middle ASP column
                stays at 260px, sized for its own non-gauge content. All cards use align-items:
                stretch for uniform height within each row. */}
            <div
              className="ps-metrics-grid"
              style={{
                display: 'grid',
                gridTemplateColumns: '1.5fr 260px 1.5fr',
                gridTemplateRows: 'repeat(2, 1fr)',
                alignItems: 'stretch',
                gap: 'var(--ps-space-3, 16px)',
              }}
            >
              <div style={{ gridColumn: '1', gridRow: '1', ...CARD_BOX }}>
                <KpiCard
                  title="YTD Value"
                  icon={Wallet}
                  variant="gauge"
                  actual={data?.ytdValue.actual ?? 0}
                  targetToDate={data?.ytdValue.targetToDate ?? null}
                  status={toSemanticStatus(data?.ytdValue.status ?? 'no_target')}
                  actualLabel={formatCompactCurrency(data?.ytdValue.actual ?? 0)}
                  actualFullValue={formatCurrency(data?.ytdValue.actual ?? 0)}
                  targetLabel={data?.ytdValue.targetToDate != null ? formatCompactCurrency(data.ytdValue.targetToDate) : undefined}
                  referenceMetrics={data ? gaugeCardReferenceMetrics(data.ytdValue, 'value', 'ytd') : []}
                  sparklineValues={revenueTrendValues}
                  loading={overview.loading}
                  error={overview.error ?? undefined}
                  onRetry={overview.retry}
                  onClick={() => router.push(buildBreakdownHref('ytdValue', anchorDate, effectiveFilters))}
                />
              </div>

              {/* ASP cards: non-gauge, compact, sized to content. Icon + title + status badge
                  (shared template shell), then: headline value + Target/Variance stat row + trend
                  sparkline. No gauge, no progress bar, no padding to match taller cards -- reverted
                  from a brief attempt to standardize these onto RadialGauge, since ASP has no
                  natural min/max range the way a currency/volume total does. */}
              <div style={{ gridColumn: '2', gridRow: '1', ...CARD_BOX }}>
                {overview.loading ? (
                  <Card style={{ width: '100%' }}>
                    <LoadingSkeleton variant="kpi" />
                  </Card>
                ) : (
                  <Card style={{ width: '100%', display: 'flex', flexDirection: 'column', padding: 'var(--ps-space-3, 16px)' }}>
                    {/* Top row: title + status badge */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 'var(--ps-space-2, 8px)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ color: 'var(--ps-color-muted-text)', display: 'flex', flexShrink: 0 }}>
                          <TrendingUp size={16} />
                        </span>
                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ps-color-muted-text)' }}>
                          YTD Actual ASP
                        </span>
                      </div>
                      <SemanticBadge status={toSemanticStatus(data?.aspYtd.status ?? 'no_target')} />
                    </div>

                    {/* Headline value */}
                    <div style={{ fontSize: 32, fontWeight: 700, color: 'var(--ps-color-text)', marginBottom: 'var(--ps-space-3, 16px)' }}>
                      {formatAsp(data?.aspYtd.actualAsp ?? null)}
                    </div>

                    {/* Stats row: Target + Variance */}
                    {data && aspCardToReferenceMetrics(data.aspYtd.actualAsp, data.aspYtd.targetAsp, data.aspYtd.lastYearAsp).length > 0 && (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--ps-space-2, 8px)', marginBottom: 'var(--ps-space-3, 16px)', borderTop: '1px solid var(--ps-color-border)', paddingTop: 'var(--ps-space-2, 8px)' }}>
                        {aspCardToReferenceMetrics(data.aspYtd.actualAsp, data.aspYtd.targetAsp, data.aspYtd.lastYearAsp).map((m) => (
                          <div key={m.label} style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ps-color-text)' }}>{m.value}</div>
                            <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginTop: 2 }}>{m.label}</div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Sparkline - pinned to bottom, enlarged to fill width */}
                    {aspTrendValues && aspTrendValues.length > 1 && (
                      <div style={{ marginTop: 'auto', paddingTop: 'var(--ps-space-2, 8px)' }}>
                        <Sparkline values={aspTrendValues} status={toSemanticStatus(data?.aspYtd.status ?? 'no_target')} label="YTD Actual ASP trend" width={200} height={40} />
                      </div>
                    )}
                  </Card>
                )}
              </div>

              <div style={{ gridColumn: '2', gridRow: '2', ...CARD_BOX }}>
                {overview.loading ? (
                  <Card style={{ width: '100%' }}>
                    <LoadingSkeleton variant="kpi" />
                  </Card>
                ) : (
                  <Card style={{ width: '100%', display: 'flex', flexDirection: 'column', padding: 'var(--ps-space-3, 16px)' }}>
                    {/* Top row: title + status badge */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 'var(--ps-space-2, 8px)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ color: 'var(--ps-color-muted-text)', display: 'flex', flexShrink: 0 }}>
                          <TrendingUp size={16} />
                        </span>
                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ps-color-muted-text)' }}>
                          MTD Actual ASP
                        </span>
                      </div>
                      <SemanticBadge status={toSemanticStatus(data?.aspMtd.status ?? 'no_target')} />
                    </div>

                    {/* Headline value */}
                    <div style={{ fontSize: 32, fontWeight: 700, color: 'var(--ps-color-text)', marginBottom: 'var(--ps-space-3, 16px)' }}>
                      {formatAsp(data?.aspMtd.actualAsp ?? null)}
                    </div>

                    {/* Stats row: Target + Variance */}
                    {data && aspCardToReferenceMetrics(data.aspMtd.actualAsp, data.aspMtd.targetAsp, data.aspMtd.lastYearAsp).length > 0 && (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--ps-space-2, 8px)', marginBottom: 'var(--ps-space-3, 16px)', borderTop: '1px solid var(--ps-color-border)', paddingTop: 'var(--ps-space-2, 8px)' }}>
                        {aspCardToReferenceMetrics(data.aspMtd.actualAsp, data.aspMtd.targetAsp, data.aspMtd.lastYearAsp).map((m) => (
                          <div key={m.label} style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ps-color-text)' }}>{m.value}</div>
                            <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginTop: 2 }}>{m.label}</div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Sparkline - pinned to bottom, enlarged to fill width */}
                    {aspTrendValues && aspTrendValues.length > 1 && (
                      <div style={{ marginTop: 'auto', paddingTop: 'var(--ps-space-2, 8px)' }}>
                        <Sparkline values={aspTrendValues} status={toSemanticStatus(data?.aspMtd.status ?? 'no_target')} label="MTD Actual ASP trend" width={200} height={40} />
                      </div>
                    )}
                  </Card>
                )}
              </div>

              <div style={{ gridColumn: '3', gridRow: '1', ...CARD_BOX }}>
                <KpiCard
                  title="YTD Volume"
                  icon={Package}
                  variant="gauge"
                  actual={data?.ytdVolume.actual ?? 0}
                  targetToDate={data?.ytdVolume.targetToDate ?? null}
                  status={toSemanticStatus(data?.ytdVolume.status ?? 'no_target')}
                  actualLabel={formatCompactVolume(data?.ytdVolume.actual ?? 0)}
                  actualFullValue={formatVolume(data?.ytdVolume.actual ?? 0)}
                  targetLabel={data?.ytdVolume.targetToDate != null ? formatCompactVolume(data.ytdVolume.targetToDate) : undefined}
                  referenceMetrics={data ? gaugeCardReferenceMetrics(data.ytdVolume, 'volume', 'ytd') : []}
                  sparklineValues={volumeTrendValues}
                  loading={overview.loading}
                  error={overview.error ?? undefined}
                  onRetry={overview.retry}
                  onClick={() => router.push(buildBreakdownHref('ytdVolume', anchorDate, effectiveFilters))}
                />
              </div>

              <div style={{ gridColumn: '1', gridRow: '2', ...CARD_BOX }}>
                <KpiCard
                  title="MTD Value"
                  icon={Wallet}
                  variant="gauge"
                  actual={data?.mtdValue.actual ?? 0}
                  targetToDate={data?.mtdValue.targetToDate ?? null}
                  status={toSemanticStatus(data?.mtdValue.status ?? 'no_target')}
                  actualLabel={formatCompactCurrency(data?.mtdValue.actual ?? 0)}
                  actualFullValue={formatCurrency(data?.mtdValue.actual ?? 0)}
                  targetLabel={data?.mtdValue.targetToDate != null ? formatCompactCurrency(data.mtdValue.targetToDate) : undefined}
                  referenceMetrics={data ? gaugeCardReferenceMetrics(data.mtdValue, 'value', 'mtd') : []}
                  sparklineValues={revenueTrendValues}
                  loading={overview.loading}
                  error={overview.error ?? undefined}
                  onRetry={overview.retry}
                  onClick={() => router.push(buildBreakdownHref('mtdValue', anchorDate, effectiveFilters))}
                />
              </div>

              <div style={{ gridColumn: '3', gridRow: '2', ...CARD_BOX }}>
                <KpiCard
                  title="MTD Volume"
                  icon={Package}
                  variant="gauge"
                  actual={data?.mtdVolume.actual ?? 0}
                  targetToDate={data?.mtdVolume.targetToDate ?? null}
                  status={toSemanticStatus(data?.mtdVolume.status ?? 'no_target')}
                  actualLabel={formatCompactVolume(data?.mtdVolume.actual ?? 0)}
                  actualFullValue={formatVolume(data?.mtdVolume.actual ?? 0)}
                  targetLabel={data?.mtdVolume.targetToDate != null ? formatCompactVolume(data.mtdVolume.targetToDate) : undefined}
                  referenceMetrics={data ? gaugeCardReferenceMetrics(data.mtdVolume, 'volume', 'mtd') : []}
                  sparklineValues={volumeTrendValues}
                  loading={overview.loading}
                  error={overview.error ?? undefined}
                  onRetry={overview.retry}
                  onClick={() => router.push(buildBreakdownHref('mtdVolume', anchorDate, effectiveFilters))}
                />
              </div>
            </div>

            {/* Detail Performance Tables - side by side, per the mockup's "Layout Matrix" §3. */}
            <div
              className="ps-report-tables-grid"
              style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 'var(--ps-space-3, 16px)' }}
            >
              <PerformanceReportTable
                title="Value Performance Details"
                rows={valueRows}
                showStatus
                lastUpdatedLabel={lastRefreshLabel}
                filtersSummary={buildFilterSummary()}
                onExportPdf={() => handleExportTablePdf('Value Performance Details', valueRows)}
              />
              <PerformanceReportTable
                title="Volume / ASP Performance Details"
                rows={volumeAspRows}
                showStatus
                lastUpdatedLabel={lastRefreshLabel}
                filtersSummary={buildFilterSummary()}
                onExportPdf={() => handleExportTablePdf('Volume / ASP Performance Details', volumeAspRows)}
              />
            </div>
          </div>
        )}
      </main>

      <RefreshFooter
        lastUpdate={formatTimestamp(refreshStatus.data?.lastUpdate ?? null)}
        lastOrderCreated={formatTimestamp(refreshStatus.data?.lastOrderCreated ?? null)}
        lastRefreshTime={formatTimestamp(refreshStatus.data?.lastRefreshTime ?? null)}
      />

      <BottomNavBar active="Tachometer" />
    </div>
    </PermissionGuard>
  );
}
