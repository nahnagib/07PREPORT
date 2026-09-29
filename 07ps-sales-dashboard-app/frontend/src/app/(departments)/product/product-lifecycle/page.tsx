'use client';
import React, { useMemo, useState } from 'react';
import { AppHeader } from '../../../../components/AppHeader';
import { BottomNavBar } from '../../../../components/BottomNavBar';
import { FilterBar } from '../../../../components/FilterBar';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useFilterState } from '../../../../components/FilterProvider';
import { ProductDataStatusBar, ProductRefreshFooter } from '../../../../components/ProductDataStatus';
import { useAuth } from '../../../../lib/AuthProvider';
import { useProductDashboard, useRefreshStatus } from '../../../../lib/hooks';
import {
  Card,
  ChartPanel,
  KpiTile,
  SemanticBadge,
  Select,
  Button,
  TextInput,
  ComboChart,
  DataTable,
  LoadingSkeleton,
  ErrorState,
  exportRowsAsPdf,
  PerformanceReportTable,
  exportPerformanceTablePdf,
  SEMANTIC_STATUS_LABEL,
  type SelectOption,
  type Column,
  type PerformanceReportRow,
  type PerformanceTablePdfColumn,
} from '@07ps/ui';
import {
  toProductFacts,
  fmtLYD,
  fmtPct,
  fmtDate,
  fmtVolume,
  sum,
  distinctSorted,
  SEGMENT_COLOR,
  LIFECYCLE_SEGMENTS,
  COMPANIES,
  type CompanyFilter,
  type ProductFact,
} from '../../../../lib/materialsAnalogy/shared';

const SEGMENTS = LIFECYCLE_SEGMENTS;
type SortKey = 'value' | 'firstSaleSort' | 'daysSinceLastSaleSort' | 'growthSort';
const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'value', label: 'Value (period)' },
  { value: 'firstSaleSort', label: 'First Sale Date' },
  { value: 'daysSinceLastSaleSort', label: 'Days Since Last Sale' },
  { value: 'growthSort', label: 'vs same period LY' },
];

interface TableRow extends ProductFact, Record<string, unknown> {
  growth: number | null;
  firstSaleSort: number;
  daysSinceLastSaleSort: number;
  growthSort: number;
}

// Mirrors the on-screen PerformanceReportTable's default layout (Trend sparkline omitted -- it has
// no text form), same shared exportPerformanceTablePdf used by the Promotion pages.
function pctLabel(v: number | null): string {
  return v !== null ? `${(v * 100).toFixed(2)}%` : '—';
}
const PERFORMANCE_PDF_COLUMNS: PerformanceTablePdfColumn[] = [
  { header: 'Metric Name', getValue: (row) => row.metric },
  { header: 'Actual', getValue: (row) => row.actualLabel },
  { header: 'Target', getValue: (row) => row.targetLabel },
  { header: 'Variance%', getValue: (row) => pctLabel(row.variancePct) },
  { header: 'Variance LY', getValue: (row) => pctLabel(row.varianceLyPct) },
  { header: 'Status', getValue: (row) => (row.status ? SEMANTIC_STATUS_LABEL[row.status] : '—') },
  { header: 'Takeaway', getValue: (row) => row.takeaway ?? '—' },
];

// ---------------------------------------------------------------------------
// Executive Summary -- Mature/Discontinued/Freshness KPI tiles have no prior-period comparison in
// this page's data model (point-in-time portfolio counts), so they stay 'neutral', except
// Discontinued which reuses the same 'alert' status its own KpiTile above already uses. The top
// lifecycle-segment rows reuse each segment's own real Value YTD vs Value LYTD for a simple
// green/red read.
// ---------------------------------------------------------------------------

function toExecutiveSummaryRows(
  matureCount: number,
  filteredCount: number,
  discCount: number,
  discValueAtRiskLytd: number,
  freshPct: number,
  newCount: number,
  segEntries: [string, { value: number; valueLY: number; n: number }][],
): PerformanceReportRow[] {
  const rows: PerformanceReportRow[] = [
    {
      id: 'matureSkus',
      metric: 'Mature SKUs',
      actualLabel: String(matureCount),
      targetLabel: '—',
      variancePct: null,
      varianceLyPct: null,
      status: 'neutral',
      takeaway: `${matureCount} SKUs (${filteredCount ? ((matureCount / filteredCount) * 100).toFixed(1) : '0'}% of the filtered portfolio) are Mature.`,
    },
    {
      id: 'discontinued',
      metric: 'Discontinued',
      actualLabel: String(discCount),
      actualFullValue: fmtLYD(discValueAtRiskLytd),
      targetLabel: '—',
      variancePct: null,
      varianceLyPct: null,
      status: 'alert',
      takeaway: `${discCount} SKUs are discontinued (inactive in PRODUCTS.xlsx or no sale in 365 days); they sold ${fmtLYD(discValueAtRiskLytd)} in the same period last year.`,
    },
    {
      id: 'freshness',
      metric: 'Portfolio Freshness',
      actualLabel: `${freshPct.toFixed(1)}%`,
      targetLabel: '—',
      variancePct: null,
      varianceLyPct: null,
      status: 'neutral',
      takeaway: `${freshPct.toFixed(1)}% of the portfolio (${newCount} SKUs) had its first sale in the last 180 days.`,
    },
  ];

  const topSegments = segEntries.slice(0, 3);
  for (const [label, o] of topSegments) {
    const varianceLy = o.valueLY > 0 ? (o.value - o.valueLY) / o.valueLY : null;
    rows.push({
      id: `segment-${label}`,
      metric: `${label} Segment Value (period)`,
      actualLabel: fmtLYD(o.value),
      targetLabel: '—',
      variancePct: null,
      varianceLyPct: varianceLy,
      status: varianceLy == null ? 'neutral' : varianceLy < 0 ? 'alert' : 'success',
      takeaway: `${label} segment is ${fmtLYD(o.value)} in the period across ${o.n} SKUs${varianceLy != null ? ` (${fmtPct(varianceLy * 100)} vs same period last year)` : ''}.`,
    });
  }

  return rows;
}

export default function ProductLifecyclePage() {
  const { user, token, error: authError, retryAuth, logout } = useAuth();
  const roleLabel = user?.role.label ?? user?.fullName;
  const { anchorDate, onAnchorDateChange, dateFromDate, dateToDate, onDateRangeChange } = useFilterState();
  const overview = useProductDashboard(token, authError, retryAuth, 'product-lifecycle', { fromDate: dateFromDate, toDate: dateToDate });
  const refresh = useRefreshStatus(token, authError, retryAuth);
  const facts = useMemo(() => toProductFacts(overview.data), [overview.data]);

  const [company, setCompany] = useState<CompanyFilter>('All');
  const [category, setCategory] = useState<string[]>([]);
  const [segment, setSegment] = useState<'All' | (typeof SEGMENTS)[number]>('All');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('value');
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [limit, setLimit] = useState(20);

  const categoryOptions: SelectOption[] = useMemo(() => {
    const pool = facts.filter((r) => company === 'All' || r.Company === company);
    return distinctSorted(pool.map((r) => r.Category)).map((c) => ({ value: c, label: c }));
  }, [facts, company]);

  const filtered = useMemo(
    () =>
      facts.filter(
        (r) =>
          (company === 'All' || r.Company === company) &&
          (category.length === 0 || (r.Category !== null && category.includes(r.Category))) &&
          (segment === 'All' || r.lifecycle === segment),
      ),
    [facts, company, category, segment],
  );
  // ---- KPIs (segments come precomputed from the ETL: config/product_dashboard.json "lifecycle") ----
  const matureRows = filtered.filter((r) => r.lifecycle === 'Mature');
  const discRows = filtered.filter((r) => r.lifecycle === 'Discontinued');
  const newRows = filtered.filter((r) => r.lifecycle === 'New');
  const freshPct = filtered.length ? (newRows.length / filtered.length) * 100 : 0;

  // ---- Pareto ----
  const bySeg = new Map<string, { value: number; valueLY: number; n: number }>();
  SEGMENTS.forEach((s) => bySeg.set(s, { value: 0, valueLY: 0, n: 0 }));
  filtered.forEach((r) => {
    const o = bySeg.get(r.lifecycle);
    if (!o) return;
    o.value += r.value;
    o.valueLY += r.valuePrior;
    o.n += 1;
  });
  const segEntries = [...bySeg.entries()].filter(([, o]) => o.n > 0).sort((a, b) => b[1].value - a[1].value);
  const totalValue = segEntries.reduce((a, [, o]) => a + o.value, 0) || 1;
  let cum = 0;
  const paretoPoints = segEntries.map(([label, o]) => {
    cum += o.value;
    return { label, value: o.value, valueLY: o.valueLY, cumPct: (cum / totalValue) * 100 };
  });

  // ---- Table ----
  const searched = search ? filtered.filter((r) => r.ProductName.toLowerCase().includes(search.toLowerCase())) : filtered;
  const sorted: TableRow[] = searched
    .map((r) => {
      const growth = r.valuePrior > 0 ? ((r.value - r.valuePrior) / r.valuePrior) * 100 : null;
      return {
        ...r,
        growth,
        firstSaleSort: r.firstSaleDate ? Date.parse(r.firstSaleDate) : Number.NEGATIVE_INFINITY,
        daysSinceLastSaleSort: r.daysSinceLastSale ?? Number.POSITIVE_INFINITY,
        growthSort: growth ?? Number.NEGATIVE_INFINITY,
      };
    })
    .sort((a, b) => {
      const x = a[sortKey] as number;
      const y = b[sortKey] as number;
      return sortDir * (x > y ? 1 : x < y ? -1 : 0);
    });
  const visibleRows = sorted.slice(0, limit);

  const columns: Column<TableRow>[] = [
    { key: 'ProductName', header: 'Product Name' },
    { key: 'Company', header: 'Company' },
    { key: 'Category', header: 'Category' },
    {
      key: 'lifecycle',
      header: 'Lifecycle',
      render: (row) =>
        row.lifecycle === 'Discontinued' ? (
          <SemanticBadge status="alert" />
        ) : (
          <span style={{ color: SEGMENT_COLOR[row.lifecycle], fontWeight: 700 }}>{row.lifecycle}</span>
        ),
    },
    { key: 'firstSaleDate', header: 'First Sale', align: 'right', render: (row) => fmtDate(row.firstSaleDate) },
    { key: 'daysSinceLastSale', header: 'Days Since Last Sale', align: 'right', render: (row) => (row.daysSinceLastSale === null ? 'never sold' : String(row.daysSinceLastSale)) },
    { key: 'value', header: 'Value (period)', align: 'right', render: (row) => fmtLYD(row.value) },
    { key: 'volume', header: 'Volume (period)', align: 'right', render: (row) => fmtVolume(row) },
    {
      key: 'growth',
      header: 'vs same period LY',
      align: 'right',
      render: (row) =>
        row.growth === null ? (
          <span style={{ color: 'var(--ps-color-muted-text)' }}>—</span>
        ) : (
          <span style={{ color: row.growth >= 0 ? 'var(--ps-color-success)' : 'var(--ps-color-alert)', fontWeight: 700 }}>{fmtPct(row.growth)}</span>
        ),
    },
  ];

  const handleExportPdf = () =>
    exportRowsAsPdf({
      title: 'Product Lifecycle — Product Detail',
      subtitle: `${company} · sorted by ${SORT_OPTIONS.find((o) => o.value === sortKey)?.label}`,
      columns: [
        { header: 'Product' },
        { header: 'Company' },
        { header: 'Lifecycle' },
        { header: 'First Sale' },
        { header: 'Days Since Last Sale', align: 'right' },
        { header: 'Value (period)', align: 'right' },
        { header: 'vs same period LY', align: 'right' },
      ],
      rows: sorted.map((r) => [
        r.ProductName,
        r.Company,
        r.lifecycle,
        fmtDate(r.firstSaleDate),
        r.daysSinceLastSale === null ? 'never sold' : String(r.daysSinceLastSale),
        fmtLYD(r.value),
        fmtPct(r.growth),
      ]),
      fileName: 'product-lifecycle-detail',
    });

  const performanceRows = toExecutiveSummaryRows(matureRows.length, filtered.length, discRows.length, sum(discRows, (r) => r.valuePrior), freshPct, newRows.length, segEntries);
  async function handleExportPerformanceTablePdf() {
    try {
      await exportPerformanceTablePdf({
        title: 'Performance Details',
        rows: performanceRows,
        columns: PERFORMANCE_PDF_COLUMNS,
        fileName: 'product-lifecycle-performance-details',
      });
    } catch (err) {
      console.error('PDF export failed:', err);
    }
  }

  return (
    <PermissionGuard pageKey="product_lifecycle">
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', paddingBottom: 64 }}>
        <AppHeader
          pageTitle="Product Dashboard"
          anchorDate={anchorDate}
          onAnchorDateChange={onAnchorDateChange}
          roleLabel={roleLabel}
          onLogout={logout}
          showDateInput={false}
        />

        <FilterBar
          onReset={() => {
            setCompany('All');
            setCategory([]);
            setSegment('All');
          }}
          isPristine={company === 'All' && category.length === 0 && segment === 'All'}
          showDateRange
          dateFromDate={dateFromDate}
          dateToDate={dateToDate}
          onDateRangeChange={onDateRangeChange}
          showCompanyDimension={false}
          showTransactionDimensions={false}
          showLastOrderInfo={false}
          extraFields={
            <>
              <PillField label="Company">
                {COMPANIES.map((c) => (
                  <Button key={c} variant={company === c ? 'primary' : 'secondary'} style={{ padding: '6px 12px', fontSize: 12.5 }} onClick={() => setCompany(c)}>
                    {c}
                  </Button>
                ))}
              </PillField>
              <div style={{ width: 200 }}>
                <Select label="Category" options={categoryOptions} value={category} onChange={setCategory} multiSelect searchable placeholder="All Categories" />
              </div>
              <PillField label="Lifecycle Segment">
                {(['All', ...SEGMENTS] as const).map((s) => (
                  <Button key={s} variant={segment === s ? 'primary' : 'secondary'} style={{ padding: '6px 12px', fontSize: 12.5 }} onClick={() => setSegment(s)}>
                    {s}
                  </Button>
                ))}
              </PillField>
            </>
          }
        />

        <ProductDataStatusBar refresh={refresh.data} data={overview.data} />

        <main style={{ flex: 1, padding: 'var(--ps-space-4, 24px)', display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)' }}>
          {overview.loading && !overview.data ? (
            <LoadingSkeleton variant="chart" />
          ) : overview.error ? (
            <ErrorState message={overview.error} onRetry={overview.retry} />
          ) : (
          <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--ps-space-3, 16px)' }}>
            <KpiTile
              label="Mature SKUs"
              value={String(matureRows.length)}
              variance={filtered.length ? `${((matureRows.length / filtered.length) * 100).toFixed(1)}% of filtered portfolio` : undefined}
              status="neutral"
            />
            <KpiTile
              label="Discontinued"
              value={String(discRows.length)}
              variance={fmtLYD(sum(discRows, (r) => r.valuePrior)) + ' sold same period last year'}
              status="alert"
            />
            <KpiTile label="Portfolio Freshness" value={`${freshPct.toFixed(1)}%`} variance={`${newRows.length} SKUs first sold in the last 180 days`} status="neutral" />
          </div>

          <ChartPanel
            title="Segment Value — Pareto"
            infoText="Bars = value in the selected period by lifecycle segment (sorted desc) · line = same period last year · gold line = cumulative %. New = first sale in 180 days; Growing/Declining = last 90 days vs previous 90 days beyond ±20%; Discontinued = inactive in PRODUCTS.xlsx or no sale in 365 days"
            style={{ minHeight: 420 }}
          >
            <ComboChart
              showTitle={false}
              points={paretoPoints}
              bars={[{ key: 'value', name: 'Value (period)', color: 'var(--ps-color-accent)' }]}
              lines={[
                { key: 'valueLY', name: 'Same period LY', color: 'var(--ps-color-last-year)', yAxisId: 'left' },
                { key: 'cumPct', name: 'Cumulative %', color: 'var(--ps-color-gold)', yAxisId: 'right' },
              ]}
              rightAxisFormatter={(v) => `${v.toFixed(0)}%`}
              height={360}
            />
          </ChartPanel>

          <Card>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
              <div>
                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ps-color-text)' }}>Product Detail</span>
                <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginTop: 2 }}>Sorted by {SORT_OPTIONS.find((o) => o.value === sortKey)?.label} ({sortDir === -1 ? 'desc' : 'asc'})</div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ width: 220 }}>
                  <TextInput placeholder="Search product name…" value={search} onChange={(e) => { setSearch(e.target.value); setLimit(20); }} style={{ marginBottom: 0 }} />
                </div>
                <div style={{ width: 200 }}>
                  <Select
                    label=""
                    options={SORT_OPTIONS}
                    value={[sortKey]}
                    onChange={(v) => setSortKey((v[0] as SortKey) ?? 'value')}
                    placeholder="Sort by"
                  />
                </div>
                <Button variant="secondary" style={{ padding: '8px 12px', fontSize: 12.5 }} onClick={() => setSortDir((d) => (d === -1 ? 1 : -1))}>
                  {sortDir === -1 ? 'Desc' : 'Asc'}
                </Button>
                <button
                  type="button"
                  onClick={handleExportPdf}
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
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  Export as PDF
                </button>
              </div>
            </div>

            <DataTable columns={columns} rows={visibleRows} getRowId={(row) => row.id} />

            <div style={{ textAlign: 'center', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
              {sorted.length > limit && (
                <Button variant="secondary" style={{ padding: '8px 20px', fontSize: 12 }} onClick={() => setLimit((l) => l + 20)}>
                  Show more
                </Button>
              )}
              <span style={{ fontSize: 11, color: 'var(--ps-color-muted-text)' }}>
                Showing {visibleRows.length} of {sorted.length}
              </span>
            </div>
          </Card>

          <PerformanceReportTable
            title="Performance Details"
            rows={performanceRows}
            showStatus
            showTakeaway
            onExportPdf={handleExportPerformanceTablePdf}
          />
          </>
          )}
        </main>

        <ProductRefreshFooter refresh={refresh.data} />
        <BottomNavBar active="Product Lifecycle" />
      </div>
    </PermissionGuard>
  );
}

/** Same FilterBar.extraFields pill-field wrapper duplicated across every Materials Analogy page
 * (see bcg-matrix/page.tsx) -- matches FilterBar's own field-label/height conventions so a
 * page-specific pill group sits flush with the built-in Select fields in the same row. */
function PillField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <span style={{ display: 'block', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--ps-color-muted-text)', marginBottom: 4 }}>{label}</span>
      <div style={{ display: 'flex', gap: 6, height: 38, alignItems: 'center' }}>{children}</div>
    </div>
  );
}
