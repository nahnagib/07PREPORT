'use client';
import { vh } from '../../../../../../lib/visualHelp';
import React, { useMemo } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { AppHeader } from '../../../../../../components/AppHeader';
import { BottomNavBar } from '../../../../../../components/BottomNavBar';
import { FilterBar } from '../../../../../../components/FilterBar';
import { PermissionGuard } from '../../../../../../components/AuthGuard';
import { useProductFilters } from '../../../../../../components/product/useProductFilters';
import { ValidationStatusBar } from '../../../../../../components/ValidationStatusBar';
import { RefreshFooter } from '../../../../../../components/RefreshFooter';
import { formatTimestamp } from '../../../../../../lib/format';
import { useAuth } from '../../../../../../lib/AuthProvider';
import { useProductDashboard, useRefreshStatus } from '../../../../../../lib/hooks';
import { Card, DataGrid, KpiTile, LoadingSkeleton, ErrorState, VisualInfoIcons, type DataGridColumn } from '@07ps/ui';
import {
  toProductFacts,
  fmtDate,
  fmtLYD,
  fmtNum,
  fmtPct,
  fmtUnits,
  filterByPageFilters,
  computeBrandStats,
  findPartnerBrandBySlug,
  isBrandOf,
  BCG_COLOR,
  MOVEMENT_COLOR,
  MOVEMENT_LABEL,
  type ProductFact,
} from '../../../../../../lib/materialsAnalogy/shared';
import { ProductName } from '../../../../../../components/product/ProductUi';

const gpText = (v: number | null) => (v === null ? 'no cost' : `${v.toFixed(1)}%`);

type BrandRow = ProductFact & Record<string, unknown>;

/** The brand's products in the app's standard grid (sort, search, column filters, pinning, paging, CSV / Excel / PDF,
 * copy), volume first; the name opens the product in Odoo. */
const PRODUCT_COLUMNS: DataGridColumn<BrandRow>[] = [
  { key: 'ProductName', header: 'Product', width: 260, render: (r) => <ProductName name={r.ProductName} href={r.odooUrl} />, rawValue: (r) => r.ProductName },
  { key: 'volume', header: 'Volume (Unit)', align: 'right', render: (r) => <span style={{ fontWeight: 600 }}>{fmtNum(r.volume)}</span>, rawValue: (r) => r.volume },
  { key: 'uom', header: 'UoM', rawValue: (r) => r.uom ?? '' },
  // Odoo On Hand of the product in its company (every internal location; same figure on every Product page)
  { key: 'onHandQty', header: 'Quantity On Hand', align: 'right', render: (r) => fmtNum(r.onHandQty), rawValue: (r) => r.onHandQty },
  // a card can group several Odoo vendors (Saquer Gulf & Lotus Tile): each product's own main vendor
  { key: 'Brand', header: 'Brand', rawValue: (r) => r.Brand ?? '' },
  { key: 'Company', header: 'Company', rawValue: (r) => r.Company },
  { key: 'Category', header: 'Category', render: (r) => <ProductName name={r.Category ?? '—'} />, rawValue: (r) => r.Category ?? '' },
  { key: 'bcg_class_YTD', header: 'BCG Class', render: (r) => (r.bcg_class_YTD ? <span style={{ color: BCG_COLOR[r.bcg_class_YTD] ?? 'var(--ps-color-muted-text)', fontWeight: 700 }}>{r.bcg_class_YTD}</span> : '—'), rawValue: (r) => r.bcg_class_YTD ?? '' },
  { key: 'bcg_movement', header: 'Movement', render: (r) => (r.bcg_movement ? <span style={{ color: MOVEMENT_COLOR[r.bcg_movement], fontWeight: 700 }}>{MOVEMENT_LABEL[r.bcg_movement]}</span> : '—'), rawValue: (r) => (r.bcg_movement ? MOVEMENT_LABEL[r.bcg_movement] : '') },
  { key: 'value', header: 'Revenue', align: 'right', render: (r) => fmtLYD(r.value), rawValue: (r) => r.value },
  { key: 'grossProfitPct', header: 'GP%', align: 'right', render: (r) => gpText(r.grossProfitPct), rawValue: (r) => (r.grossProfitPct === null ? '' : Math.round(r.grossProfitPct * 10) / 10), sortValue: (r) => r.grossProfitPct ?? Number.NEGATIVE_INFINITY },
  { key: 'avgUnitPrice', header: 'ASP', align: 'right', render: (r) => (r.avgUnitPrice === null ? '—' : fmtLYD(r.avgUnitPrice)), rawValue: (r) => r.avgUnitPrice ?? '', sortValue: (r) => r.avgUnitPrice ?? Number.NEGATIVE_INFINITY },
  { key: 'SKU', header: 'SKU', rawValue: (r) => r.SKU ?? '' },
  { key: 'lastSaleDate', header: 'Last sale', render: (r) => fmtDate(r.lastSaleDate), rawValue: (r) => r.lastSaleDate ?? '' },
];

/**
 * Brand page (/product/pim-contribution/brand/[brand]) -- one partner brand: a header with its KPI tiles (Volume in
 * Unit, volume vs same period LY, Revenue, GP%, SKUs in catalogue, SKUs sold), then every product of the brand in a
 * sortable, searchable table (sticky header, CSV + PDF export), highest volume first. The Brand is the product's main
 * vendor in Odoo, matched case-insensitively on the brand's Odoo names (PARTNER_BRANDS). The FilterBar is the Product
 * pages' one (company, Customer Group, channel, branch, salesperson, date range -- shared with PIM Contribution);
 * Category / BCG Class come from the PIM Contribution page through the URL. One row is one Odoo product in one company.
 */
export default function BrandPage() {
  const params = useParams<{ brand: string }>();
  const searchParams = useSearchParams();
  const { user, logout, token, error: authError, retryAuth } = useAuth();
  const roleLabel = user?.role.label ?? user?.fullName;
  const refresh = useRefreshStatus(token, authError, retryAuth);
  const { anchorDate, onAnchorDateChange, dateFromDate, dateToDate, scope, companyLabel, filterBarProps } = useProductFilters(refresh.data);

  const brandSlug = Array.isArray(params?.brand) ? params.brand[0] : params?.brand ?? '';
  const partnerBrand = findPartnerBrandBySlug(brandSlug);

  const urlFilters = useMemo(
    () => ({
      company: 'All' as const, // the company is the FilterBar's (applied by the API)
      category: searchParams.getAll('category'),
      bcgClass: searchParams.get('bcgClass') ?? 'All',
    }),
    [searchParams],
  );

  const overview = useProductDashboard(token, authError, retryAuth, 'pim-contribution', scope);
  const filtered = useMemo(() => filterByPageFilters(toProductFacts(overview.data), urlFilters), [overview.data, urlFilters]);
  const brandRows = useMemo(() => (partnerBrand ? filtered.filter((r) => isBrandOf(partnerBrand, r)) : []), [filtered, partnerBrand]);
  const rows = brandRows;
  const stats = useMemo(() => computeBrandStats(rows).found.find((b) => b.requested === partnerBrand?.requested) ?? null, [rows, partnerBrand]);

  const scopeLabel = [companyLabel, ...urlFilters.category, urlFilters.bcgClass !== 'All' ? urlFilters.bcgClass : null].filter(Boolean).join(' · ');

  return (
    <PermissionGuard pageKey="pim_contribution">
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', paddingBottom: 64 }}>
        <AppHeader
          subTitle={partnerBrand ? `Brand: ${partnerBrand.requested}` : undefined}
          anchorDate={anchorDate}
          onAnchorDateChange={onAnchorDateChange}
          roleLabel={roleLabel}
          onLogout={logout}
          showDateInput={false}
        />

        <FilterBar {...filterBarProps} />

        <ValidationStatusBar
          isStale={refresh.data?.isStale}
          isInverted={refresh.data?.isInverted}
          refreshCheck={refresh.data?.refreshCheck}
          lastRefreshTime={refresh.data ? formatTimestamp(refresh.data.lastRefreshTime) : undefined}
        />

        <main style={{ flex: 1, padding: 'var(--ps-space-4, 24px)', display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)', minWidth: 0 }}>
          <BackLink />
          {overview.loading && !overview.data ? (
            <LoadingSkeleton variant="chart" />
          ) : overview.error ? (
            <ErrorState message={overview.error} onRetry={overview.retry} />
          ) : !partnerBrand ? (
            <p style={{ fontSize: 13, color: 'var(--ps-color-muted-text)' }}>Unknown brand.</p>
          ) : brandRows.length === 0 ? (
            <Card data-testid="brand-unassigned">
              <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--ps-color-text)' }}>{partnerBrand.requested}</div>
              <p style={{ fontSize: 13, color: 'var(--ps-color-muted-text)', marginTop: 8 }}>
                Not currently assigned in Odoo: no product in this view has {partnerBrand.odooNames.join(' / ')} as its main vendor.
              </p>
            </Card>
          ) : (
            <>
              {/* Brand header: name, scope, company switch, then the KPI tiles */}
              <div data-testid="brand-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
                  <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--ps-color-text)', margin: 0 }}>{partnerBrand.requested}</h1>
                </div>
                <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', marginBottom: 16 }}>
                  {scopeLabel} · {dateFromDate} to {dateToDate} · brand = main vendor in Odoo ({partnerBrand.odooNames.join(' + ')})
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--ps-space-3, 16px)' }}>
                  <KpiTile label="Volume (period)" value={fmtUnits(stats?.volume ?? 0)} status="neutral" />
                  <KpiTile
                    label="Volume vs same period LY"
                    value={stats?.volumeDeltaPct === null || stats?.volumeDeltaPct === undefined ? '—' : fmtPct(stats.volumeDeltaPct)}
                    variance={stats ? `LY ${fmtUnits(stats.volumePrior)}` : undefined}
                    status={stats?.volumeDeltaPct === null || stats?.volumeDeltaPct === undefined ? 'neutral' : stats.volumeDeltaPct >= 0 ? 'success' : 'alert'}
                  />
                  <KpiTile
                    label="Revenue (period)"
                    value={fmtLYD(stats?.revenue ?? 0)}
                    variance={stats?.deltaPct === null || stats?.deltaPct === undefined ? undefined : `${fmtPct(stats.deltaPct)} vs same period LY`}
                    status="neutral"
                  />
                  <KpiTile label="GP%" value={stats?.gp === null || stats?.gp === undefined ? '—' : `${stats.gp.toFixed(1)}%`} variance="revenue-weighted, costed products" status="neutral" />
                  <KpiTile label="SKUs in catalogue" value={String(stats?.skuCount ?? 0)} status="neutral" />
                  <KpiTile label="SKUs sold (period)" value={String(stats?.skuSold ?? 0)} status="neutral" />
                </div>
              </div>

              <Card style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ps-color-text)', marginBottom: 8 }}>
                  Products <VisualInfoIcons title="Products" {...vh('product.pimContribution.brandProducts')} />
                </div>
                <div data-testid="brand-product-table">
                  <DataGrid
                    columns={PRODUCT_COLUMNS}
                    rows={[...rows].sort((a, b) => b.volume - a.volume) as BrandRow[]}
                    getRowId={(r) => r.id}
                    fileName={`brand-${brandSlug}-products`}
                    filtersSummary={`Brand: ${partnerBrand.requested} · ${scopeLabel} · ${dateFromDate} to ${dateToDate}`}
                  />
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
        <BottomNavBar active="PIM Contribution" />
      </div>
    </PermissionGuard>
  );
}

/** Back to the PIM Contribution page's Brand Performance section. */
function BackLink() {
  return (
    <Link href="/product/pim-contribution#brand-performance" style={{ color: 'var(--ps-color-accent)', fontWeight: 600, fontSize: 12, textDecoration: 'none' }}>
      ← Back to Brand Performance
    </Link>
  );
}
