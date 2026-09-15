'use client';
import React, { useState } from 'react';
import { FileDown, Layers, ArrowUp, ArrowDown, Minus } from 'lucide-react';
import { AppHeader } from '../../../../components/AppHeader';
import { FilterBar } from '../../../../components/FilterBar';
import { BottomNavBar } from '../../../../components/BottomNavBar';
import { ValidationStatusBar } from '../../../../components/ValidationStatusBar';
import { RefreshFooter } from '../../../../components/RefreshFooter';
import { useFilterState } from '../../../../components/FilterProvider';
import { Card, ChartPanel, ComboChart, DonutChart, DataGrid, LoadingSkeleton, ErrorState, exportRowsAsPdf, type Column, type DataGridColumn } from '@07ps/ui';
import { useAuth } from '../../../../lib/AuthProvider';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useFilterOptions, useInvoicesEngineOverview, useRefreshStatus, useExportOverviewReport } from '../../../../lib/hooks';
import type { InvoiceStats, InvoicesEngineKpis, InvoicesEngineScope, InvoiceYearClassBreakdown } from '../../../../lib/api';
import { formatCurrency, formatTimestamp, formatVolume } from '../../../../lib/format';

// Value-tier labels (renamed from the bare A/B/C/D codes the ETL/warehouse still store -- see
// backend/src/measures/invoicesEngine.ts's normalizeInvoiceClass). Thresholds are unchanged from
// the live classification (data/etl/src/sales_pipeline/legacy_transform.py's _classify_invoice);
// only the display wording changed, so a tier here always matches the exact same invoices the old
// "Class A/B/C/D" labels did.
const INVOICE_CLASS_LABELS: Record<string, string> = {
  A: 'High Value',
  B: 'Upper-Mid Value',
  C: 'Medium Value',
  D: 'Low Value',
  Unclassified: 'Unclassified',
};

const INVOICE_CLASS_RANGE: Record<string, string> = {
  A: '> 50K LYD',
  B: '25K – 50K LYD',
  C: '5K – 25K LYD',
  D: '< 5K LYD',
  Unclassified: 'no invoiced value',
};

/** Full "High Value (> 50K LYD)"-style label -- used in the donut/table where the range adds
 * useful context; the bare tier name (INVOICE_CLASS_LABELS) is used where space is tight (e.g.
 * legend rows, filter chips). */
function invoiceClassFullLabel(cls: string): string {
  const label = INVOICE_CLASS_LABELS[cls] ?? cls;
  const range = INVOICE_CLASS_RANGE[cls];
  return range ? `${label} (${range})` : label;
}

// Categorical (non-status) reuse of existing brand hues -- Invoice Class is a size segment, not a
// good/bad signal, so this deliberately avoids --ps-color-alert (reserved for "bad" everywhere
// else on the platform). Same "borrow a couple of brand hues for a category dimension that has no
// dedicated token" convention as Critical Number page's COMPANY_DOT_COLOR. High Value gets the
// deepest/most premium hue, Low Value the plainest; Unclassified falls through to
// invoiceClassColor's own neutral default.
const INVOICE_CLASS_COLOR: Record<string, string> = {
  A: 'var(--ps-color-trend-target)',
  B: 'var(--ps-color-accent)',
  C: 'var(--ps-color-gold)',
  D: 'var(--ps-color-muted-text)',
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

// ---------------------------------------------------------------------------
// PDF summary-table export -- same exportRowsAsPdf mechanism as Revenue Trend, applied to every
// visual on this page (reused via @07ps/ui, not reimplemented).
// ---------------------------------------------------------------------------

interface PeriodTableRow extends Record<string, unknown> {
  id: string;
  period: string;
  value: string;
}
const periodTableColumns: Column<PeriodTableRow>[] = [
  { key: 'period', header: 'Period' },
  { key: 'value', header: 'Value', align: 'right' },
];
function toMetricPanelTableRows(
  kpis: InvoicesEngineKpis | undefined,
  pick: (stats: InvoiceStats) => number | null,
  formatter: (value: number | null) => string,
): PeriodTableRow[] {
  if (!kpis) return [];
  return [
    { id: 'lytd', period: 'LYTD', value: formatter(pick(kpis.lytd)) },
    { id: 'ytd', period: 'YTD', value: formatter(pick(kpis.ytd)) },
    { id: 'lmtd', period: 'LMTD', value: formatter(pick(kpis.lmtd)) },
    { id: 'mtd', period: 'MTD', value: formatter(pick(kpis.mtd)) },
  ];
}

interface TotalInvoicesTableRow extends Record<string, unknown> {
  id: string;
  period: string;
  count: string;
}
const totalInvoicesTableColumns: Column<TotalInvoicesTableRow>[] = [
  { key: 'period', header: 'Period' },
  { key: 'count', header: '# of Invoices', align: 'right' },
];

interface SalesTrendTableRow extends Record<string, unknown> {
  id: string;
  label: string;
  invoiceSalesValue: string;
  invoiceCount: number;
}
const salesTrendTableColumns: Column<SalesTrendTableRow>[] = [
  { key: 'label', header: 'Year / Class' },
  { key: 'invoiceSalesValue', header: 'Invoice Sales Value', align: 'right' },
  { key: 'invoiceCount', header: '# of Invoices', align: 'right' },
];

interface InvoicesTrendTableRow extends Record<string, unknown> {
  id: string;
  label: string;
  avgSalesPerInvoice: string;
  avgLinesPerInvoice: string;
  avgVolumePerInvoice: string;
}
const invoicesTrendTableColumns: Column<InvoicesTrendTableRow>[] = [
  { key: 'label', header: 'Year' },
  { key: 'avgSalesPerInvoice', header: 'Avg Sales per Invoice', align: 'right' },
  { key: 'avgLinesPerInvoice', header: 'Avg Lines per Invoice', align: 'right' },
  { key: 'avgVolumePerInvoice', header: 'Avg Volume per Invoice', align: 'right' },
];

interface ClassificationTableRow extends Record<string, unknown> {
  id: string;
  label: string;
  value: string;
}
const classificationTableColumns: Column<ClassificationTableRow>[] = [
  { key: 'label', header: 'Invoice Class' },
  { key: 'value', header: 'Value', align: 'right' },
];

// ---------------------------------------------------------------------------
// Detail analysis tables (Issue #3) -- one persistent, sortable/exportable DataGrid per chart,
// shown below Zones B/C rather than only behind ChartPanel's expand-to-table modal. Same
// TrendArrow/status-pill visual language as Revenue Trend's own Performance Summary tables
// (packages/ui doesn't have a shared version of these -- small enough, and page-specific enough in
// exact wording, to duplicate per that page's own established convention).
// ---------------------------------------------------------------------------

type TrendDirection = 'up' | 'down' | 'flat';

function trendFromValues(prev: number | undefined, current: number): TrendDirection {
  if (prev === undefined) return 'flat';
  if (current > prev) return 'up';
  if (current < prev) return 'down';
  return 'flat';
}

function TrendIcon({ trend }: { trend: TrendDirection }) {
  const color = trend === 'up' ? 'var(--ps-color-success)' : trend === 'down' ? 'var(--ps-color-alert)' : 'var(--ps-color-muted-text)';
  const Icon = trend === 'up' ? ArrowUp : trend === 'down' ? ArrowDown : Minus;
  return (
    <span style={{ display: 'inline-flex', color }}>
      <Icon size={14} />
    </span>
  );
}

function StatusPill({ label, color }: { label: string; color: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        color,
        border: `1px solid ${color}`,
        whiteSpace: 'nowrap',
      }}
    >
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />
      {label}
    </span>
  );
}

function formatSignedPct(v: number | null): string {
  if (v === null) return '—';
  const pct = v * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

// --- Table 1: Sales Performance by Year (below Sales Trend) ----------------

interface SalesPerformanceRow extends Record<string, unknown> {
  id: string;
  year: string;
  invoiceSalesValue: number;
  invoiceCount: number;
  avgValuePerInvoice: number | null;
  variancePct: number | null;
  trend: TrendDirection;
}

function buildSalesPerformanceRows(byYear: { year: number; label: string; invoiceSalesValue: number; invoiceCount: number }[]): SalesPerformanceRow[] {
  const sorted = [...byYear].sort((a, b) => a.year - b.year);
  return sorted.map((y, i) => {
    const prev = sorted[i - 1];
    const variancePct = prev && prev.invoiceSalesValue > 0 ? (y.invoiceSalesValue - prev.invoiceSalesValue) / prev.invoiceSalesValue : null;
    return {
      id: y.label,
      year: y.label,
      invoiceSalesValue: y.invoiceSalesValue,
      invoiceCount: y.invoiceCount,
      avgValuePerInvoice: y.invoiceCount > 0 ? y.invoiceSalesValue / y.invoiceCount : null,
      variancePct,
      trend: trendFromValues(prev?.invoiceSalesValue, y.invoiceSalesValue),
    };
  });
}

const salesPerformanceColumns: DataGridColumn<SalesPerformanceRow>[] = [
  { key: 'year', header: 'Year', width: 80 },
  { key: 'invoiceSalesValue', header: 'Invoice Sales Value', align: 'right', render: (r) => formatCurrency(r.invoiceSalesValue) },
  { key: 'invoiceCount', header: '# of Invoices', align: 'right', render: (r) => r.invoiceCount.toLocaleString() },
  { key: 'avgValuePerInvoice', header: 'Avg Value per Invoice', align: 'right', render: (r) => (r.avgValuePerInvoice === null ? '—' : formatCurrency(r.avgValuePerInvoice)) },
  { key: 'variancePct', header: 'Variance vs. Prior Year', align: 'right', render: (r) => formatSignedPct(r.variancePct), rawValue: (r) => (r.variancePct ?? 0) * 100 },
  { key: 'trend', header: 'Trend', align: 'left', render: (r) => <TrendIcon trend={r.trend} />, rawValue: (r) => r.trend, width: 70 },
];

// --- Table 2: Invoices Trend Detail (below Invoices Trend) ------------------

interface InvoicesTrendDetailRow extends Record<string, unknown> {
  id: string;
  year: string;
  invoiceCount: number;
  avgSalesPerInvoice: number | null;
  avgLinesPerInvoice: number | null;
  trend: TrendDirection;
}

function buildInvoicesTrendDetailRows(
  byYear: { year: number; label: string; invoiceCount: number; avgSalesPerInvoice: number | null; avgLinesPerInvoice: number | null }[],
): InvoicesTrendDetailRow[] {
  const sorted = [...byYear].sort((a, b) => a.year - b.year);
  return sorted.map((y, i) => ({
    id: y.label,
    year: y.label,
    invoiceCount: y.invoiceCount,
    avgSalesPerInvoice: y.avgSalesPerInvoice,
    avgLinesPerInvoice: y.avgLinesPerInvoice,
    trend: trendFromValues(sorted[i - 1]?.avgSalesPerInvoice ?? undefined, y.avgSalesPerInvoice ?? 0),
  }));
}

const invoicesTrendDetailColumns: DataGridColumn<InvoicesTrendDetailRow>[] = [
  { key: 'year', header: 'Year', width: 80 },
  { key: 'invoiceCount', header: '# of Invoices', align: 'right', render: (r) => r.invoiceCount.toLocaleString() },
  { key: 'avgSalesPerInvoice', header: 'Avg Sales per Invoice', align: 'right', render: (r) => (r.avgSalesPerInvoice === null ? '—' : formatCurrency(r.avgSalesPerInvoice)) },
  { key: 'avgLinesPerInvoice', header: 'Avg Lines per Invoice', align: 'right', render: (r) => formatLines(r.avgLinesPerInvoice) },
  { key: 'trend', header: 'Trend', align: 'left', render: (r) => <TrendIcon trend={r.trend} />, rawValue: (r) => r.trend, width: 70 },
];

// --- Table 3: Invoices Classification Detail (below the donut) -------------

interface ClassificationDetailRow extends Record<string, unknown> {
  id: string;
  classification: string;
  count: number;
  pctOfTotal: number;
  totalValue: number;
  avgValuePerInvoice: number | null;
  trend: TrendDirection;
  status: 'Active' | 'Inactive';
}

function buildClassificationDetailRows(
  classification: { invoiceClass: string; value: number; invoiceCount: number }[],
  byYearClass: InvoiceYearClassBreakdown[],
): ClassificationDetailRow[] {
  const totalValue = classification.reduce((sum, c) => sum + c.value, 0);
  const yearsAsc = [...byYearClass].sort((a, b) => a.year - b.year);
  return classification.map((c) => {
    const perYearValue = yearsAsc.map((y) => y.classes.find((cls) => cls.invoiceClass === c.invoiceClass)?.invoiceSalesValue ?? 0);
    const trend = trendFromValues(perYearValue[perYearValue.length - 2], perYearValue[perYearValue.length - 1] ?? 0);
    return {
      id: c.invoiceClass,
      classification: invoiceClassFullLabel(c.invoiceClass),
      count: c.invoiceCount,
      pctOfTotal: totalValue > 0 ? c.value / totalValue : 0,
      totalValue: c.value,
      avgValuePerInvoice: c.invoiceCount > 0 ? c.value / c.invoiceCount : null,
      trend: perYearValue.length >= 2 ? trend : 'flat',
      status: c.invoiceCount > 0 ? 'Active' : 'Inactive',
    };
  });
}

const classificationDetailColumns: DataGridColumn<ClassificationDetailRow>[] = [
  { key: 'classification', header: 'Classification', width: 160 },
  { key: 'count', header: 'Count', align: 'right', render: (r) => r.count.toLocaleString() },
  { key: 'pctOfTotal', header: '% of Total', align: 'right', render: (r) => `${(r.pctOfTotal * 100).toFixed(2)}%`, rawValue: (r) => r.pctOfTotal * 100 },
  { key: 'totalValue', header: 'Total Value', align: 'right', render: (r) => formatCurrency(r.totalValue) },
  { key: 'avgValuePerInvoice', header: 'Avg Value per Invoice', align: 'right', render: (r) => (r.avgValuePerInvoice === null ? '—' : formatCurrency(r.avgValuePerInvoice)) },
  { key: 'trend', header: 'Trend', align: 'left', render: (r) => <TrendIcon trend={r.trend} />, rawValue: (r) => r.trend, width: 70 },
  {
    key: 'status',
    header: 'Status',
    align: 'left',
    render: (r) => <StatusPill label={r.status} color={r.status === 'Active' ? 'var(--ps-color-success)' : 'var(--ps-color-muted-text)'} />,
    rawValue: (r) => r.status,
    width: 100,
  },
];

/** Classification Tiers help block -- Issue #1's "Add Classification Definitions" requirement,
 * plus a plain-language note on what "Unclassified" means (per the investigation in
 * backend/src/measures/invoicesEngine.ts's normalizeInvoiceClass comment: lines whose order was
 * never actually invoiced -- e.g. a quotation, or a cancelled/pending order -- rather than a data
 * error, so there is deliberately no "fix" here beyond labeling it clearly). */
function ClassificationTiersHelp() {
  const tiers = ['A', 'B', 'C', 'D', 'Unclassified'];
  return (
    <div
      style={{
        marginTop: 12,
        paddingTop: 10,
        borderTop: '1px solid var(--ps-color-border)',
        fontSize: 11,
        color: 'var(--ps-color-muted-text)',
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 4, color: 'var(--ps-color-text)' }}>Classification Tiers</div>
      <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {tiers.map((t) => (
          <li key={t}>
            <strong style={{ color: 'var(--ps-color-text)' }}>{INVOICE_CLASS_LABELS[t]}</strong>
            {t !== 'Unclassified' ? `: invoices ${INVOICE_CLASS_RANGE[t]}.` : ': lines whose order was never actually invoiced (e.g. a quotation, or a cancelled/pending order) -- not a data error.'}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Same visual shell as Revenue Trend's ExportPdfButton -- copied per-page rather than shared, same
 * convention that component already established. */
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
        whiteSpace: 'nowrap',
      }}
    >
      <FileDown size={13} />
      {downloading ? 'Exporting...' : 'Export as PDF'}
    </button>
  );
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

  const filterOptions = useFilterOptions(token, authError, retryAuth, effectiveFilters);
  const overview = useInvoicesEngineOverview(token, anchorDate, effectiveFilters, scope, authError, retryAuth);
  const refreshStatus = useRefreshStatus(token, authError, retryAuth);
  const exportReport = useExportOverviewReport(token, anchorDate, effectiveFilters);
  const [downloadingPdf, setDownloadingPdf] = useState<string | null>(null);

  async function handleDownloadTablePdf<T extends Record<string, unknown>>(key: string, title: string, columns: Column<T>[], rows: T[]) {
    setDownloadingPdf(key);
    try {
      await exportRowsAsPdf({
        title,
        columns: columns.map((c) => ({ header: c.header, align: c.align })),
        rows: rows.map((row) => columns.map((c) => String(row[c.key] ?? ''))),
        fileName: title.toLowerCase().replace(/\s+/g, '-'),
      });
    } finally {
      setDownloadingPdf(null);
    }
  }

  function handleReset() {
    resetFilters();
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
        label: INVOICE_CLASS_LABELS[c.invoiceClass] ?? c.invoiceClass,
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
    label: invoiceClassFullLabel(c.invoiceClass),
    value: c.value,
    count: c.invoiceCount,
    color: invoiceClassColor(c.invoiceClass),
  }));

  const linesTableRows = toMetricPanelTableRows(kpis, (s) => s.avgLinesPerInvoice, formatLines);
  const salesPerInvoiceTableRows = toMetricPanelTableRows(kpis, (s) => s.avgSalesPerInvoice, (v) => (v === null ? '—' : formatCurrency(v)));
  const volumeTableRows = toMetricPanelTableRows(kpis, (s) => s.avgVolumePerInvoice, formatVolumeOrDash);

  const totalInvoicesTableRows: TotalInvoicesTableRow[] = [
    { id: 'ytd', period: 'YTD', count: kpis?.ytd.invoiceCount != null ? kpis.ytd.invoiceCount.toLocaleString() : '—' },
    { id: 'lytd', period: 'LYTD', count: kpis?.lytd.invoiceCount != null ? kpis.lytd.invoiceCount.toLocaleString() : '—' },
    { id: 'mtd', period: 'MTD', count: kpis?.mtd.invoiceCount != null ? kpis.mtd.invoiceCount.toLocaleString() : '—' },
    { id: 'lmtd', period: 'LMTD', count: kpis?.lmtd.invoiceCount != null ? kpis.lmtd.invoiceCount.toLocaleString() : '—' },
  ];

  const salesTrendTableRows: SalesTrendTableRow[] = salesTrendPoints.map((p) => ({
    id: p.label,
    label: p.label,
    invoiceSalesValue: formatCurrency(p.invoiceSalesValue),
    invoiceCount: p.invoiceCount,
  }));

  const invoicesTrendTableRows: InvoicesTrendTableRow[] = invoicesTrendPoints.map((p) => ({
    id: p.label,
    label: p.label,
    avgSalesPerInvoice: formatCurrency(p.avgSalesPerInvoice),
    avgLinesPerInvoice: formatLines(p.avgLinesPerInvoice),
    avgVolumePerInvoice: formatVolume(p.avgVolumePerInvoice),
  }));

  const classificationTableRows: ClassificationTableRow[] = classificationSegments.map((s) => ({
    id: s.id,
    label: s.label,
    value: formatInvoiceValue(s.value),
  }));

  const salesPerformanceRows = buildSalesPerformanceRows(data?.salesTrend.byYear ?? []);
  const invoicesTrendDetailRows = buildInvoicesTrendDetailRows(data?.invoicesTrend ?? []);
  const classificationDetailRows = buildClassificationDetailRows(data?.classification ?? [], data?.salesTrend.byYearClass ?? []);

  return (
    <PermissionGuard pageKey="invoices_engine">
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
          customerGroupsLoading={filterOptions.customerGroups.loading}
          distributionChannelsLoading={filterOptions.distributionChannels.loading}
          branchesLoading={filterOptions.branches.loading}
          salespersonsLoading={filterOptions.salespersons.loading}
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
                tableRows={linesTableRows}
                downloading={downloadingPdf === 'lines'}
                onDownloadPdf={() => handleDownloadTablePdf('lines', '# of Lines per Invoice', periodTableColumns, linesTableRows)}
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
                tableRows={salesPerInvoiceTableRows}
                downloading={downloadingPdf === 'salesPerInvoice'}
                onDownloadPdf={() => handleDownloadTablePdf('salesPerInvoice', 'Sales per Invoice', periodTableColumns, salesPerInvoiceTableRows)}
              />
              <MetricPanel
                title="Volume per Invoice"
                kpis={kpis}
                pick={(s) => s.avgVolumePerInvoice}
                formatter={formatVolumeOrDash}
                loading={overview.loading}
                error={overview.error ?? undefined}
                onRetry={overview.retry}
                tableRows={volumeTableRows}
                downloading={downloadingPdf === 'volume'}
                onDownloadPdf={() => handleDownloadTablePdf('volume', 'Volume per Invoice', periodTableColumns, volumeTableRows)}
              />
            </div>

            {/* Zone B -- Sales Trend (left) + Total Invoices KPI cards (right) */}
            <div className="ps-invoices-zone">
              <ChartPanel<SalesTrendTableRow>
                title="Sales Trend"
                infoText="Invoice Sales Value and # of Invoices by year. Enable drill-down, then click a year to break it out by Invoice Class."
                style={{ minHeight: 380 }}
                tableColumns={overview.error ? undefined : salesTrendTableColumns}
                tableRows={overview.error ? undefined : salesTrendTableRows}
                getRowId={(row) => row.id}
                headerActions={
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <DrillToggle active={drillMode} onToggle={toggleDrillMode} />
                    {!overview.error && (
                      <ExportPdfButton
                        downloading={downloadingPdf === 'salesTrend'}
                        disabled={salesTrendTableRows.length === 0}
                        onClick={() => handleDownloadTablePdf('salesTrend', 'Sales Trend', salesTrendTableColumns, salesTrendTableRows)}
                      />
                    )}
                  </div>
                }
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

              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-2, 8px)' }}>
                {!overview.error && (
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <ExportPdfButton
                      downloading={downloadingPdf === 'totalInvoices'}
                      disabled={totalInvoicesTableRows.length === 0}
                      onClick={() => handleDownloadTablePdf('totalInvoices', 'Total Invoices', totalInvoicesTableColumns, totalInvoicesTableRows)}
                    />
                  </div>
                )}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(2, 1fr)',
                    gridTemplateRows: 'repeat(2, 1fr)',
                    gap: 'var(--ps-space-3, 16px)',
                    flex: 1,
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
            </div>

            {/* Zone C -- Invoices Trend (left) + Invoices Classification donut (right) */}
            <div className="ps-invoices-zone">
              <ChartPanel<InvoicesTrendTableRow>
                title="Invoices Trend"
                style={{ minHeight: 380 }}
                tableColumns={overview.error ? undefined : invoicesTrendTableColumns}
                tableRows={overview.error ? undefined : invoicesTrendTableRows}
                getRowId={(row) => row.id}
                headerActions={
                  !overview.error && (
                    <ExportPdfButton
                      downloading={downloadingPdf === 'invoicesTrend'}
                      disabled={invoicesTrendTableRows.length === 0}
                      onClick={() => handleDownloadTablePdf('invoicesTrend', 'Invoices Trend', invoicesTrendTableColumns, invoicesTrendTableRows)}
                    />
                  )
                }
              >
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

              <ChartPanel<ClassificationTableRow>
                title="Invoices Classification"
                infoText="Invoice value by Invoice Class, year-to-date."
                style={{ minHeight: 380 }}
                tableColumns={overview.error ? undefined : classificationTableColumns}
                tableRows={overview.error ? undefined : classificationTableRows}
                getRowId={(row) => row.id}
                headerActions={
                  !overview.error && (
                    <ExportPdfButton
                      downloading={downloadingPdf === 'classification'}
                      disabled={classificationTableRows.length === 0}
                      onClick={() => handleDownloadTablePdf('classification', 'Invoices Classification', classificationTableColumns, classificationTableRows)}
                    />
                  )
                }
              >
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
                    showPercentLabels
                  />
                )}
                <ClassificationTiersHelp />
              </ChartPanel>
            </div>

            {/* Zone D -- Detail analysis tables, one per chart above (Issue #3). */}
            {!overview.loading && !overview.error && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 'var(--ps-space-3, 16px)' }}>
                <DetailTablePanel title="Sales Performance by Year" subtitle="Detail behind Sales Trend" columns={salesPerformanceColumns} rows={salesPerformanceRows} fileName="sales-performance-by-year" />
                <DetailTablePanel title="Invoices Trend Detail" subtitle="Detail behind Invoices Trend" columns={invoicesTrendDetailColumns} rows={invoicesTrendDetailRows} fileName="invoices-trend-detail" />
                <DetailTablePanel title="Invoices Classification Detail" subtitle="Detail behind Invoices Classification" columns={classificationDetailColumns} rows={classificationDetailRows} fileName="invoices-classification-detail" />
              </div>
            )}
          </div>
        </main>

        <RefreshFooter
          lastUpdate={formatTimestamp(refreshStatus.data?.lastUpdate ?? null)}
          lastOrderCreated={formatTimestamp(refreshStatus.data?.lastOrderCreated ?? null)}
          lastRefreshTime={formatTimestamp(refreshStatus.data?.lastRefreshTime ?? null)}
        />

        <BottomNavBar active="Invoices Engine" />
      </div>
    </PermissionGuard>
  );
}

// ---------------------------------------------------------------------------
// Zone D -- one detail-analysis table: title + @07ps/ui's DataGrid (sortable, searchable, PDF/CSV
// export built in).
// ---------------------------------------------------------------------------

function DetailTablePanel<T extends Record<string, unknown>>({
  title,
  subtitle,
  columns,
  rows,
  fileName,
}: {
  title: string;
  subtitle: string;
  columns: DataGridColumn<T>[];
  rows: T[];
  fileName: string;
}) {
  return (
    <Card>
      <div style={{ marginBottom: 'var(--ps-space-2, 8px)' }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>{title}</div>
        <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)' }}>{subtitle}</div>
      </div>
      <DataGrid columns={columns} rows={rows} getRowId={(r) => String((r as Record<string, unknown>).id)} fileName={fileName} pageSize={10} maxBodyHeight={340} />
    </Card>
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
  tableRows,
  downloading,
  onDownloadPdf,
}: {
  title: string;
  kpis?: InvoicesEngineKpis;
  pick: (stats: InvoiceStats) => number | null;
  formatter: (value: number | null) => string;
  fullFormatter?: (value: number | null) => string | undefined;
  loading: boolean;
  error?: string;
  onRetry: () => void;
  tableRows?: PeriodTableRow[];
  downloading?: boolean;
  onDownloadPdf?: () => void;
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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--ps-space-2, 8px)', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ps-color-text)' }}>{title}</span>
        {onDownloadPdf && (
          <ExportPdfButton downloading={!!downloading} disabled={!tableRows || tableRows.length === 0} onClick={onDownloadPdf} />
        )}
      </div>
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
