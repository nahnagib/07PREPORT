'use client';
import { vh } from '../../../../../../lib/visualHelp';
import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { AppHeader } from '../../../../../../components/AppHeader';
import { BottomNavBar } from '../../../../../../components/BottomNavBar';
import { PermissionGuard } from '../../../../../../components/AuthGuard';
import { useFilterState } from '../../../../../../components/FilterProvider';
import { ValidationStatusBar } from '../../../../../../components/ValidationStatusBar';
import { RefreshFooter } from '../../../../../../components/RefreshFooter';
import { formatTimestamp } from '../../../../../../lib/format';
import { useAuth } from '../../../../../../lib/AuthProvider';
import { useProductDashboard, useRefreshStatus } from '../../../../../../lib/hooks';
import { Button, Card, KpiTile, LoadingSkeleton, ErrorState, VisualInfoIcons } from '@07ps/ui';
import {
  toProductFacts,
  fmtDate,
  fmtLYD,
  fmtNum,
  fmtPct,
  fmtUomQty,
  fmtVolume,
  filterByPageFilters,
  computeBrandStats,
  findPartnerBrandBySlug,
  isBrandOf,
  BCG_COLOR,
  MOVEMENT_COLOR,
  MOVEMENT_LABEL,
  type CompanyFilter,
  type ProductFact,
} from '../../../../../../lib/materialsAnalogy/shared';
import { Pill, ProductName, ProductTooltip, SortableProductTable, TooltipRow, type SortableColumn } from '../../../../../../components/product/ProductUi';

const gpText = (v: number | null) => (v === null ? 'no cost' : `${v.toFixed(1)}%`);

/** The brand's product table: sortable on every column, CSV raw numbers / PDF formatted text. */
const PRODUCT_COLUMNS: SortableColumn<ProductFact>[] = [
  { key: 'product', header: 'Product', value: (r) => r.ProductName, sortValue: (r) => r.ProductName, render: (r) => <ProductName name={r.ProductName} /> },
  { key: 'company', header: 'Company', value: (r) => r.Company, sortValue: (r) => r.Company, render: (r) => r.Company },
  { key: 'category', header: 'Category', value: (r) => r.Category, sortValue: (r) => r.Category, render: (r) => <ProductName name={r.Category ?? '—'} /> },
  { key: 'volume', header: 'Volume', align: 'right', value: (r) => r.volume, text: (r) => fmtVolume(r), sortValue: (r) => r.volume, render: (r) => fmtVolume(r) },
  { key: 'unit', header: 'Unit', value: (r) => r.uom, sortValue: (r) => r.uom, render: (r) => r.uom ?? '—' },
  { key: 'revenue', header: 'Revenue', align: 'right', value: (r) => r.value, text: (r) => fmtLYD(r.value), sortValue: (r) => r.value, render: (r) => <span style={{ fontWeight: 600 }}>{fmtLYD(r.value)}</span> },
  { key: 'gp', header: 'GP%', align: 'right', value: (r) => (r.grossProfitPct === null ? null : Math.round(r.grossProfitPct * 10) / 10), text: (r) => gpText(r.grossProfitPct), sortValue: (r) => r.grossProfitPct, render: (r) => gpText(r.grossProfitPct) },
  { key: 'asp', header: 'ASP', align: 'right', value: (r) => r.avgUnitPrice, text: (r) => (r.avgUnitPrice === null ? '—' : fmtLYD(r.avgUnitPrice)), sortValue: (r) => r.avgUnitPrice, render: (r) => (r.avgUnitPrice === null ? '—' : fmtLYD(r.avgUnitPrice)) },
  { key: 'lastSale', header: 'Last sale', value: (r) => r.lastSaleDate, text: (r) => fmtDate(r.lastSaleDate), sortValue: (r) => r.lastSaleDate, render: (r) => fmtDate(r.lastSaleDate) },
];

function productTooltip(r: ProductFact) {
  return (
    <ProductTooltip
      name={r.ProductName}
      company={r.Company}
      badges={
        <>
          {r.bcg_class_YTD && <Pill color={BCG_COLOR[r.bcg_class_YTD] ?? 'var(--ps-color-muted-text)'} label={r.bcg_class_YTD} />}
          {r.bcg_movement && <Pill color={MOVEMENT_COLOR[r.bcg_movement]} label={MOVEMENT_LABEL[r.bcg_movement]} />}
        </>
      }
    >
      <TooltipRow label="Revenue (period)" value={fmtLYD(r.value)} />
      <TooltipRow label="Volume (period)" value={fmtVolume(r)} />
      <TooltipRow label="ASP" value={r.avgUnitPrice === null ? '—' : fmtLYD(r.avgUnitPrice)} />
      <TooltipRow label="GP%" value={gpText(r.grossProfitPct)} />
      <TooltipRow label="SKU" value={r.SKU ?? '—'} />
    </ProductTooltip>
  );
}

/**
 * Brand page (/product/pim-contribution/brand/[brand]) -- one partner brand: a header with its KPI tiles (Revenue,
 * vs same period LY, Volume in Unit, GP%, SKUs in catalogue, SKUs sold), then every product of the brand in a
 * sortable, searchable table (sticky header, CSV + PDF export). The Brand is the product's main vendor in Odoo,
 * matched case-insensitively on the brand's Odoo names (PARTNER_BRANDS). Company / Category / BCG Class come from the
 * PIM Contribution page through the URL; a brand sold by both companies gets its own Majaal / Tika switch. One row is
 * one Odoo product in one company.
 */
export default function BrandPage() {
  const params = useParams<{ brand: string }>();
  const searchParams = useSearchParams();
  const { user, logout, token, error: authError, retryAuth } = useAuth();
  const roleLabel = user?.role.label ?? user?.fullName;
  const { anchorDate, onAnchorDateChange, dateFromDate, dateToDate } = useFilterState();
  const [companyFilter, setCompanyFilter] = useState<string>('All');

  const brandSlug = Array.isArray(params?.brand) ? params.brand[0] : params?.brand ?? '';
  const partnerBrand = findPartnerBrandBySlug(brandSlug);

  const urlFilters = useMemo(
    () => ({
      company: (searchParams.get('company') ?? 'All') as CompanyFilter,
      category: searchParams.getAll('category'),
      bcgClass: searchParams.get('bcgClass') ?? 'All',
    }),
    [searchParams],
  );

  const overview = useProductDashboard(token, authError, retryAuth, 'pim-contribution', { fromDate: dateFromDate, toDate: dateToDate, company: urlFilters.company });
  const refresh = useRefreshStatus(token, authError, retryAuth);
  const filtered = useMemo(() => filterByPageFilters(toProductFacts(overview.data), urlFilters), [overview.data, urlFilters]);
  const brandRows = useMemo(() => (partnerBrand ? filtered.filter((r) => isBrandOf(partnerBrand, r)) : []), [filtered, partnerBrand]);
  const companies = useMemo(() => [...new Set(brandRows.map((r) => r.Company))].sort(), [brandRows]);
  const rows = useMemo(() => (companyFilter === 'All' ? brandRows : brandRows.filter((r) => r.Company === companyFilter)), [brandRows, companyFilter]);
  const stats = useMemo(() => computeBrandStats(rows).found.find((b) => b.requested === partnerBrand?.requested) ?? null, [rows, partnerBrand]);

  const unitQty = stats?.volumeByUom.find((u) => u.uom === 'Unit')?.qty ?? 0;
  const otherUnits = (stats?.volumeByUom ?? []).filter((u) => u.uom !== 'Unit');
  const scopeLabel = [companyFilter !== 'All' ? companyFilter : urlFilters.company !== 'All' ? urlFilters.company : 'Majaal + Tika', ...urlFilters.category, urlFilters.bcgClass !== 'All' ? urlFilters.bcgClass : null]
    .filter(Boolean)
    .join(' · ');

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
                  {companies.length > 1 && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {['All', ...companies].map((c) => (
                        <Button key={c} variant={companyFilter === c ? 'primary' : 'secondary'} style={{ padding: '4px 12px', fontSize: 12 }} onClick={() => setCompanyFilter(c)}>
                          {c}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', marginBottom: 16 }}>
                  {scopeLabel} · {dateFromDate} to {dateToDate} · brand = main vendor in Odoo ({partnerBrand.odooNames[0]})
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--ps-space-3, 16px)' }}>
                  <KpiTile label="Revenue (period)" value={fmtLYD(stats?.revenue ?? 0)} status="neutral" />
                  <KpiTile
                    label="vs same period LY"
                    value={stats?.deltaPct === null || stats?.deltaPct === undefined ? '—' : fmtPct(stats.deltaPct)}
                    variance={stats ? `LY ${fmtLYD(stats.revenuePrior)}` : undefined}
                    status={stats?.deltaPct === null || stats?.deltaPct === undefined ? 'neutral' : stats.deltaPct >= 0 ? 'success' : 'alert'}
                  />
                  <KpiTile label="Volume (Unit)" value={fmtNum(unitQty)} variance={otherUnits.length ? `+ ${fmtUomQty(otherUnits)}` : undefined} status="neutral" />
                  <KpiTile label="GP%" value={stats?.gp === null || stats?.gp === undefined ? '—' : `${stats.gp.toFixed(1)}%`} variance="revenue-weighted, costed products" status="neutral" />
                  <KpiTile label="SKUs in catalogue" value={String(stats?.skuCount ?? 0)} status="neutral" />
                  <KpiTile label="SKUs sold (period)" value={String(stats?.skuSold ?? 0)} status="neutral" />
                </div>
              </div>

              <Card style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ps-color-text)', marginBottom: 8 }}>
                  Products <VisualInfoIcons title="Products" {...vh('product.pimContribution.brandProducts')} />
                </div>
                <SortableProductTable
                  testId="brand-product-table"
                  columns={PRODUCT_COLUMNS}
                  rows={rows}
                  getRowId={(r) => r.id}
                  searchText={(r) => `${r.ProductName} ${r.SKU ?? ''}`}
                  defaultSort={{ key: 'revenue', dir: 'desc' }}
                  fileName={`brand-${brandSlug}-products`}
                  pdfTitle={`Brand: ${partnerBrand.requested} — products`}
                  pdfSubtitle={`${scopeLabel} · ${dateFromDate} to ${dateToDate}`}
                  rowTooltip={productTooltip}
                />
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
