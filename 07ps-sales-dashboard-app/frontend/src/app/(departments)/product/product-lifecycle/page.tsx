'use client';
import { vh } from '../../../../lib/visualHelp';
import React, { useMemo, useState } from 'react';
import { AppHeader } from '../../../../components/AppHeader';
import { BottomNavBar } from '../../../../components/BottomNavBar';
import { FilterBar } from '../../../../components/FilterBar';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useProductFilters } from '../../../../components/product/useProductFilters';
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
  ComboChart,
  DataGrid,
  LoadingSkeleton,
  ErrorState,
  VisualInfoIcons,
  type SelectOption,
  type DataGridColumn,
} from '@07ps/ui';
import {
  toProductFacts,
  fmtLYD,
  fmtNum,
  fmtPct,
  fmtDate,
  fmtUnits,
  fmtVolume,
  sum,
  distinctSorted,
  SEGMENT_COLOR,
  LIFECYCLE_SEGMENTS,
  type ProductFact,
} from '../../../../lib/materialsAnalogy/shared';
import { ProductName } from '../../../../components/product/ProductUi';

const SEGMENTS = LIFECYCLE_SEGMENTS;
interface TableRow extends ProductFact, Record<string, unknown> {
  /** Volume of the period vs the same period last year, %; null = nothing sold last year. */
  growth: number | null;
}

export default function ProductLifecyclePage() {
  const { user, token, error: authError, retryAuth, logout } = useAuth();
  const roleLabel = user?.role.label ?? user?.fullName;
  const refresh = useRefreshStatus(token, authError, retryAuth);
  const { anchorDate, onAnchorDateChange, scope, companyLabel, filterBarProps, withLocalReset } = useProductFilters(refresh.data);

  // Company view (one company) or all companies side by side; a product is always one Odoo product in one company.
  const overview = useProductDashboard(token, authError, retryAuth, 'product-lifecycle', scope);
  const facts = useMemo(() => toProductFacts(overview.data), [overview.data]);
  const [category, setCategory] = useState<string[]>([]);
  const [segment, setSegment] = useState<'All' | (typeof SEGMENTS)[number]>('All');

  const categoryOptions: SelectOption[] = useMemo(
    () => distinctSorted(facts.map((r) => r.Category)).map((c) => ({ value: c, label: c })),
    [facts],
  );

  const filtered = useMemo(
    () =>
      facts.filter(
        (r) => (category.length === 0 || (r.Category !== null && category.includes(r.Category))) && (segment === 'All' || r.lifecycle === segment),
      ),
    [facts, category, segment],
  );
  // ---- KPIs (segments come precomputed from the ETL: config/product_dashboard.json "lifecycle") ----
  const matureRows = filtered.filter((r) => r.lifecycle === 'Mature');
  const discRows = filtered.filter((r) => r.lifecycle === 'Discontinued');
  const newRows = filtered.filter((r) => r.lifecycle === 'New');
  const freshPct = filtered.length ? (newRows.length / filtered.length) * 100 : 0;

  // ---- Pareto on volume: units sold in the period per lifecycle segment (added up as Unit), the same period last year,
  // and the cumulative share of the units ----
  const bySeg = new Map<string, { units: number; unitsLY: number; n: number }>();
  SEGMENTS.forEach((s) => bySeg.set(s, { units: 0, unitsLY: 0, n: 0 }));
  filtered.forEach((r) => {
    const o = bySeg.get(r.lifecycle);
    if (!o) return;
    o.units += r.volume;
    o.unitsLY += r.volumePrior;
    o.n += 1;
  });
  const segEntries = [...bySeg.entries()].filter(([, o]) => o.n > 0).sort((a, b) => b[1].units - a[1].units);
  const totalUnits = segEntries.reduce((a, [, o]) => a + Math.max(0, o.units), 0) || 1;
  let cum = 0;
  const paretoPoints = segEntries.map(([label, o]) => {
    cum += Math.max(0, o.units);
    return { label, units: o.units, unitsLY: o.unitsLY, cumPct: (cum / totalUnits) * 100 };
  });

  // ---- Product Detail: the app's standard grid (sort, search, column filters, pinning, paging, CSV / Excel / PDF,
  // copy), volume first, highest volume first ----
  const tableRows: TableRow[] = filtered
    .map((r) => ({ ...r, growth: r.volumePrior > 0 ? ((r.volume - r.volumePrior) / r.volumePrior) * 100 : null }))
    .sort((a, b) => b.volume - a.volume);
  const columns: DataGridColumn<TableRow>[] = [
    { key: 'ProductName', header: 'Product Name', width: 260, render: (row) => <ProductName name={row.ProductName} href={row.odooUrl} />, rawValue: (row) => row.ProductName },
    { key: 'volume', header: 'Volume (period)', align: 'right', render: (row) => <strong>{fmtVolume(row)}</strong>, rawValue: (row) => row.volume },
    {
      key: 'growth',
      header: 'Volume vs same period LY',
      align: 'right',
      rawValue: (row) => (row.growth === null ? '' : Math.round(row.growth * 10) / 10),
      sortValue: (row) => row.growth ?? Number.NEGATIVE_INFINITY,
      render: (row) =>
        row.growth === null ? (
          <span style={{ color: 'var(--ps-color-muted-text)' }}>—</span>
        ) : (
          <span style={{ color: row.growth >= 0 ? 'var(--ps-color-success)' : 'var(--ps-color-alert)', fontWeight: 700 }}>{fmtPct(row.growth)}</span>
        ),
    },
    { key: 'Company', header: 'Company', rawValue: (row) => row.Company },
    { key: 'Category', header: 'Category', render: (row) => <ProductName name={row.Category ?? '—'} />, rawValue: (row) => row.Category ?? '' },
    { key: 'lifecycle', header: 'Lifecycle', render: (row) => <span style={{ color: SEGMENT_COLOR[row.lifecycle], fontWeight: 700 }}>{row.lifecycle}</span>, rawValue: (row) => row.lifecycle },
    { key: 'firstSaleDate', header: 'First Sale', align: 'right', render: (row) => fmtDate(row.firstSaleDate), rawValue: (row) => row.firstSaleDate ?? '' },
    {
      key: 'daysSinceLastSale',
      header: 'Days Since Last Sale',
      align: 'right',
      render: (row) => (row.daysSinceLastSale === null ? 'never sold' : String(row.daysSinceLastSale)),
      rawValue: (row) => (row.daysSinceLastSale === null ? 'never sold' : row.daysSinceLastSale),
      sortValue: (row) => row.daysSinceLastSale ?? Number.POSITIVE_INFINITY,
    },
    { key: 'value', header: 'Value (period)', align: 'right', render: (row) => fmtLYD(row.value), rawValue: (row) => row.value },
  ];

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
          {...filterBarProps}
          {...withLocalReset(() => {
            setCategory([]);
            setSegment('All');
          }, category.length === 0 && segment === 'All')}
          secondRow={
            <>
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
              variance={`${fmtUnits(sum(discRows, (r) => r.volumePrior))} sold same period last year`}
              status="alert"
            />
            <KpiTile label="Portfolio Freshness" value={`${freshPct.toFixed(1)}%`} variance={`${newRows.length} SKUs first sold in the last 180 days`} status="neutral" />
          </div>

          <ChartPanel {...vh("product.productLifecycle.pareto")}
            title="Segment Volume — Pareto"
            style={{ minHeight: 420 }}
          >
            <ComboChart
              showTitle={false}
              points={paretoPoints}
              bars={[{ key: 'units', name: 'Units sold (period)', color: 'var(--ps-color-accent)' }]}
              leftAxisFormatter={(v) => fmtNum(v)}
              lines={[
                { key: 'unitsLY', name: 'Same period LY', color: 'var(--ps-color-last-year)', yAxisId: 'left' },
                { key: 'cumPct', name: 'Cumulative %', color: 'var(--ps-color-gold)', yAxisId: 'right' },
              ]}
              rightAxisFormatter={(v) => `${v.toFixed(0)}%`}
              height={360}
            />
          </ChartPanel>

          <Card>
            <div style={{ marginBottom: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ps-color-text)' }}>
                Product Detail <VisualInfoIcons title="Product Detail" {...vh('product.productLifecycle.productDetail')} />
              </span>
              <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginTop: 2 }}>Highest volume first · click a column header to sort · search and per-column filters below each header</div>
            </div>
            <div data-testid="lifecycle-product-grid">
              <DataGrid columns={columns} rows={tableRows} getRowId={(row) => row.id} fileName="product-lifecycle-detail" filtersSummary={companyLabel} />
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
