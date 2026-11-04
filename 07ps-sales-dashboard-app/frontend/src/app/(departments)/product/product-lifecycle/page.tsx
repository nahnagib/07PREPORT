'use client';
import { vh } from '../../../../lib/visualHelp';
import React, { useMemo, useState } from 'react';
import { AppHeader } from '../../../../components/AppHeader';
import { BottomNavBar } from '../../../../components/BottomNavBar';
import { FilterBar } from '../../../../components/FilterBar';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useFilterState } from '../../../../components/FilterProvider';
import { ValidationStatusBar } from '../../../../components/ValidationStatusBar';
import { RefreshFooter } from '../../../../components/RefreshFooter';
import { formatTimestamp } from '../../../../lib/format';
import { useAuth } from '../../../../lib/AuthProvider';
import { useProductDashboard, useRefreshStatus } from '../../../../lib/hooks';
import {
  Card,
  ChartPanel,
  KpiTile,
  Select,
  Button,
  TextInput,
  ComboChart,
  DataTable,
  LoadingSkeleton,
  ErrorState,
  type SelectOption,
  type Column,
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
import { ExportButtons, ProductName, exportProductCsv, exportProductPdf, type ExportColumn } from '../../../../components/product/ProductUi';

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

/** Product Detail export: the table's columns, CSV raw numbers, PDF formatted text. */
const EXPORT_COLUMNS: ExportColumn<TableRow>[] = [
  { header: 'Product Name', value: (r) => r.ProductName },
  { header: 'Company', value: (r) => r.Company },
  { header: 'Odoo ID', value: (r) => r.ProductKey },
  { header: 'Category', value: (r) => r.Category },
  { header: 'Lifecycle', value: (r) => r.lifecycle },
  { header: 'First Sale', value: (r) => r.firstSaleDate, text: (r) => fmtDate(r.firstSaleDate) },
  { header: 'Days Since Last Sale', align: 'right', value: (r) => r.daysSinceLastSale, text: (r) => (r.daysSinceLastSale === null ? 'never sold' : String(r.daysSinceLastSale)) },
  { header: 'Value (period, LYD)', align: 'right', value: (r) => r.value, text: (r) => fmtLYD(r.value) },
  { header: 'Volume (period)', align: 'right', value: (r) => r.volume, text: (r) => fmtVolume(r) },
  { header: 'Unit', value: (r) => r.uom },
  { header: 'vs same period LY %', align: 'right', value: (r) => r.growth, text: (r) => fmtPct(r.growth) },
];

export default function ProductLifecyclePage() {
  const { user, token, error: authError, retryAuth, logout } = useAuth();
  const roleLabel = user?.role.label ?? user?.fullName;
  const { anchorDate, onAnchorDateChange, dateFromDate, dateToDate, onDateRangeChange } = useFilterState();
  const refresh = useRefreshStatus(token, authError, retryAuth);

  const [company, setCompany] = useState<CompanyFilter>('All');
  // Company view (one company) or all companies side by side; a product is always one Odoo product in one company.
  const overview = useProductDashboard(token, authError, retryAuth, 'product-lifecycle', { fromDate: dateFromDate, toDate: dateToDate, company });
  const facts = useMemo(() => toProductFacts(overview.data), [overview.data]);
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
    { key: 'ProductName', header: 'Product Name', render: (row) => <ProductName name={row.ProductName} style={{ maxWidth: 360 }} /> },
    { key: 'Company', header: 'Company' },
    { key: 'Category', header: 'Category', render: (row) => row.Category ?? '—' },
    {
      key: 'lifecycle',
      header: 'Lifecycle',
      render: (row) => <span style={{ color: SEGMENT_COLOR[row.lifecycle], fontWeight: 700 }}>{row.lifecycle}</span>,
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

  const exportTitle = 'Product Lifecycle — Product Detail';
  const exportSubtitle = `${company === 'All' ? 'Majaal + Tika' : company} · sorted by ${SORT_OPTIONS.find((o) => o.value === sortKey)?.label}`;

  return (
    <PermissionGuard pageKey="product_lifecycle">
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', paddingBottom: 64 }}>
        <AppHeader
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

        <ValidationStatusBar
          isStale={refresh.data?.isStale}
          isInverted={refresh.data?.isInverted}
          refreshCheck={refresh.data?.refreshCheck}
          lastRefreshTime={refresh.data ? formatTimestamp(refresh.data.lastRefreshTime) : undefined}
        />

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

          <ChartPanel {...vh("product.productLifecycle.pareto")}
            title="Segment Value — Pareto"
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
                <ExportButtons
                  label="the product list"
                  onCsv={() => exportProductCsv('product-lifecycle-detail', EXPORT_COLUMNS, sorted)}
                  onPdf={() => exportProductPdf({ title: exportTitle, subtitle: exportSubtitle, fileName: 'product-lifecycle-detail', columns: EXPORT_COLUMNS, rows: sorted })}
                />
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

          </>
          )}
        </main>

        <RefreshFooter
          lastUpdate={formatTimestamp(refresh.data?.lastUpdate ?? null)}
          lastOrderCreated={formatTimestamp(refresh.data?.lastOrderCreated ?? null)}
          lastRefreshTime={formatTimestamp(refresh.data?.lastRefreshTime ?? null)}
        />
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
