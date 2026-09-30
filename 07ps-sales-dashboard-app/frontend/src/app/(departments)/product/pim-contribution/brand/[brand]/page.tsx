'use client';
import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { AppHeader } from '../../../../../../components/AppHeader';
import { BottomNavBar } from '../../../../../../components/BottomNavBar';
import { PermissionGuard } from '../../../../../../components/AuthGuard';
import { useFilterState } from '../../../../../../components/FilterProvider';
import { ProductDataStatusBar, ProductRefreshFooter } from '../../../../../../components/ProductDataStatus';
import { useAuth } from '../../../../../../lib/AuthProvider';
import { useProductDashboard, useRefreshStatus } from '../../../../../../lib/hooks';
import {
  Button,
  DataTable,
  LoadingSkeleton,
  ErrorState,
  exportRowsAsPdf,
  PerformanceReportTable,
  type Column,
  type PdfExportColumn,
  type PerformanceReportRow,
  useCanExport,
} from '@07ps/ui';
import {
  toProductFacts,
  fmtLYD,
  fmtNum,
  fmtPct,
  fmtUomQty,
  fmtVolume,
  filterByPageFilters,
  computeBrandStats,
  findPartnerBrandBySlug,
  BCG_COLOR,
  MOVEMENT_COLOR,
  MOVEMENT_LABEL,
  type CompanyFilter,
  type FoundBrandStats,
  type ProductFact,
} from '../../../../../../lib/materialsAnalogy/shared';

type BrandPerformanceFact = ProductFact;

// ---------------------------------------------------------------------------
// Executive Summary -- `selected` (a FoundBrandStats) already carries everything needed; this is
// the same brand-level aggregate the summary page's Brand Performance cards use, just not
// previously rendered as a table here. Revenue and SKU Count have a real YTD-vs-LYTD comparison
// (deltaPct, skuCountLYTD) and get a simple up/down status; Volume/ASP/GP% have no prior-period
// figure in this data model, so they stay 'neutral'.
// ---------------------------------------------------------------------------

function toExecutiveSummaryRows(selected: FoundBrandStats, productCount: number): PerformanceReportRow[] {
  return [
    {
      id: 'revenue',
      metric: 'Revenue (period)',
      actualLabel: fmtLYD(selected.revenue),
      targetLabel: '—',
      variancePct: null,
      varianceLyPct: selected.deltaPct === null ? null : selected.deltaPct / 100,
      status: selected.deltaPct === null ? 'neutral' : selected.deltaPct >= 0 ? 'success' : 'alert',
      takeaway: `${selected.requested} revenue is ${fmtLYD(selected.revenue)} in the period${selected.deltaPct === null ? '' : ` (${fmtPct(selected.deltaPct)} vs same period last year)`}.`,
    },
    {
      id: 'volume',
      metric: 'Volume (period)',
      actualLabel: fmtUomQty(selected.volumeByUom),
      targetLabel: '—',
      variancePct: null,
      varianceLyPct: null,
      status: 'neutral',
      takeaway: `${fmtUomQty(selected.volumeByUom)} sold in the period (per unit of measure).`,
    },
    {
      id: 'grossProfit',
      metric: 'Gross Profit %',
      actualLabel: selected.gp === null ? '—' : `${selected.gp.toFixed(1)}%`,
      targetLabel: '—',
      variancePct: null,
      varianceLyPct: null,
      status: 'neutral',
      takeaway: selected.gp === null ? 'No product of this brand has a standard cost in Odoo.' : `Revenue-weighted gross margin of costed products is ${selected.gp.toFixed(1)}%.`,
    },
    {
      id: 'skuCount',
      metric: 'SKU Count',
      actualLabel: fmtNum(selected.skuCount),
      targetLabel: '—',
      variancePct: null,
      varianceLyPct: null,
      status: 'neutral',
      takeaway: `${fmtNum(selected.skuCount)} SKUs in PRODUCTS.xlsx, ${selected.skuSold} sold in the period, ${productCount} shown in the current view.`,
    },
  ];
}

/**
 * Brand Performance drill-down -- a real, separate ROUTE
 * (/product/pim-contribution/brand/[brand]) rather than an inline block on the PIM Contribution
 * summary page, matching the same "summary page + a real drill-down/detail route" split Tachometer
 * already established for this app (see tachometer/[metric]/page.tsx's own header comment). This
 * page occupies the full viewport on its own -- no KPI cards/donut/ASP content from the summary
 * page renders behind or below it, since it's a genuinely different route, not a toggled section on
 * the same continuously-scrolling page.
 *
 * Company/Category/BCG Class filters carry over from the summary page via URL query params (same
 * convention as Tachometer's own summary -> detail navigation), so this page independently
 * recomputes the identical filtered scope and always agrees with the summary cards' own numbers for
 * that scope -- `filterByPageFilters`/`computeBrandStats` (shared.ts) are the same functions the
 * summary page uses, not a second parallel computation.
 *
 * Migrated onto the live `useBrandPerformanceOverview` alongside the summary page's Brand
 * Performance card (both were reading `computeBrandStats(FACTS)` -- the ~32% synthetic sample
 * confirmed as the root cause of undercounted SKU Count/revenue/volume for every partner brand;
 * see materialsAnalogyBrandPerformance.ts's header). Unlike the BCG Matrix page this pattern is
 * borrowed from, live rows here include products with NO sales activity at all (this measure
 * anchors on the full `dim_product` catalog, not `fact_bcgmatrix` -- see that file's header for
 * why), so `bcg_class_YTD`/`bcg_movement`/`avg_unit_price_YTD`/`perc_gross_profit_YTD`/
 * `quantity_growth_pct` can genuinely be null here in a way BCG Matrix's own already-classified-only
 * `facts` never has to handle for the last two -- see the '—' fallbacks below in
 * brandFactToPdfRow/BrandRowTooltip, not present in BCG Matrix's equivalents because it doesn't
 * need them.
 *
 * Content is otherwise unchanged from the prior inline version: breadcrumb-style back link, a
 * Company sub-filter (when the brand straddles both companies), the ranked product table (bar
 * indicator + hover tooltip with full detail), and a full PDF export -- see BrandProductList/
 * BrandRowTooltip below, ported over as-is.
 */
export default function BrandDrillDownPage() {
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

  // Brand stats + company split: the page's own view (BMH unless a company came in the URL). The product
  // list under the brand's own company sub-filter is that company's view -- its part of a shared product.
  const brandPerf = useProductDashboard(token, authError, retryAuth, 'pim-contribution', { fromDate: dateFromDate, toDate: dateToDate, company: urlFilters.company });
  const subCompany = urlFilters.company === 'All' && companyFilter !== 'All' ? companyFilter : null;
  const subPerf = useProductDashboard(token, authError, retryAuth, 'pim-contribution', { fromDate: dateFromDate, toDate: dateToDate, company: subCompany ?? undefined }, subCompany !== null);
  const refresh = useRefreshStatus(token, authError, retryAuth);
  const filtered = useMemo(() => filterByPageFilters(toProductFacts(brandPerf.data), urlFilters), [brandPerf.data, urlFilters]);
  const subFiltered = useMemo(() => filterByPageFilters(toProductFacts(subPerf.data), urlFilters), [subPerf.data, urlFilters]);
  const { found } = useMemo(() => computeBrandStats(filtered), [filtered]);
  const selected = partnerBrand?.matched ? found.find((b) => b.matched === partnerBrand.matched) ?? null : null;

  const productRows = useMemo(() => {
    if (!selected) return [];
    const source = subCompany ? subFiltered : filtered;
    return source
      .filter((r) => (r.Brand ?? '').toUpperCase() === selected.matched.toUpperCase() && (companyFilter === 'All' || r.Companies.includes(companyFilter)))
      .sort((a, b) => b.value - a.value);
  }, [filtered, subFiltered, subCompany, selected, companyFilter]);

  const listRows: BrandProductRow[] = useMemo(() => {
    const maxRev = Math.max(1, ...productRows.map((r) => r.value));
    return productRows.map((r, i) => ({
      id: `${r.id}-${i}`,
      label: r.ProductName,
      revenueYTD: r.value,
      volumeYTD: r.volume ?? 0,
      barPct: (Math.max(0, r.value) / maxRev) * 100,
      fact: r,
    }));
  }, [productRows]);

  const handleExportPdf = () => {
    if (!selected) return;
    exportRowsAsPdf({
      title: 'Brand Performance',
      subtitle: `${selected.requested}${companyFilter !== 'All' ? ` · ${companyFilter}` : ''} — ${productRows.length} product${productRows.length === 1 ? '' : 's'}`,
      columns: BRAND_PRODUCT_PDF_COLUMNS,
      rows: productRows.map((r) => brandFactToPdfRow(r, r.ProductName)),
      fileName: `brand-performance-${selected.matched.toLowerCase()}`,
    });
  };

  return (
    <PermissionGuard pageKey="pim_contribution">
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', paddingBottom: 64 }}>
        <AppHeader
          pageTitle={selected ? `Brand Performance — ${selected.requested}` : 'Brand Performance'}
          anchorDate={anchorDate}
          onAnchorDateChange={onAnchorDateChange}
          roleLabel={roleLabel}
          onLogout={logout}
          showDateInput={false}
        />

        <ProductDataStatusBar refresh={refresh.data} data={brandPerf.data} />

        <main style={{ flex: 1, padding: 'var(--ps-space-4, 24px)', display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)' }}>
          {brandPerf.loading && !brandPerf.data ? (
            <LoadingSkeleton variant="chart" />
          ) : brandPerf.error ? (
            <ErrorState message={brandPerf.error} onRetry={brandPerf.retry} />
          ) : !selected ? (
            <div>
              <BackLink />
              <p style={{ fontSize: 13, color: 'var(--ps-color-muted-text)', marginTop: 12 }}>
                {partnerBrand ? `${partnerBrand.requested} has no matching products in the current data.` : 'Unknown brand.'}
              </p>
            </div>
          ) : (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ps-color-text)' }}>Brand Performance</div>
                <PdfButton label="Export as PDF" onClick={handleExportPdf} />
              </div>
              <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginBottom: 16 }}>
                {selected.requested} product list for the selected period, sorted by revenue · hover a row for full detail
              </div>

              <DrillBreadcrumb active={selected.requested} />
              {selected.companySplit.length > 1 && (
                <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
                  {['All', ...selected.companySplit.map((cs) => cs.company)].map((c) => (
                    <Button key={c} variant={companyFilter === c ? 'primary' : 'secondary'} style={{ padding: '6px 12px', fontSize: 12.5 }} onClick={() => setCompanyFilter(c)}>
                      {c}
                    </Button>
                  ))}
                </div>
              )}
              <BrandProductList rows={listRows} />

              <div style={{ marginTop: 'var(--ps-space-4, 24px)' }}>
                <PerformanceReportTable title="Performance Details" rows={toExecutiveSummaryRows(selected, productRows.length)} showStatus showTakeaway />
              </div>
            </div>
          )}
        </main>

        <ProductRefreshFooter refresh={refresh.data} />
        <BottomNavBar active="PIM Contribution" />
      </div>
    </PermissionGuard>
  );
}

/** Same "plain text at root, clickable link + chevron + current label when drilled" breadcrumb
 * convention used throughout this module (BCG Matrix's own DrillBreadcrumb, this brand section's
 * prior inline version) -- the "root" is now a real navigable link back to the PIM Contribution
 * summary page's Brand Performance section (`#brand-performance`, which is already the first
 * section on that page) rather than a same-page state reset, since this is a separate route. */
function DrillBreadcrumb({ active }: { active: string }) {
  return (
    <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
      <BackLink />
      <span>›</span>
      <span style={{ color: 'var(--ps-color-text)', fontWeight: 600 }}>{active}</span>
    </div>
  );
}

/** Returns cleanly to the PIM Contribution summary page, anchored at (or at least including) the
 * Brand Performance section -- which is already the first section on that page, so this lands the
 * user right back where they started without needing any scroll-restoration logic of its own. */
function BackLink() {
  return (
    <Link
      href="/product/pim-contribution#brand-performance"
      style={{ background: 'none', border: 'none', padding: 0, color: 'var(--ps-color-accent)', fontWeight: 600, cursor: 'pointer', fontSize: 12, textDecoration: 'none' }}
    >
      ← Back to Brand Performance
    </Link>
  );
}

/** Shared PDF export shape for this brand's product list -- same column set as BCG Matrix's own
 * product-list export (Product Name, Class, Movement, Revenue YTD, Volume YTD, ASP, GP%, Vol
 * Growth), plus Company since a brand can straddle both companies (see companySplit). Ships every
 * row currently in view (post company-filter), not a fixed top-N slice -- brand SKU counts here
 * top out at ~48 (Ape/APE), well within what the on-screen table already renders in full, so
 * there's no separate "preview vs. full export" split to keep in sync. */
const BRAND_PRODUCT_PDF_COLUMNS: PdfExportColumn[] = [
  { header: 'Product Name' },
  { header: 'Company' },
  { header: 'BCG Class' },
  { header: 'Movement' },
  { header: 'Revenue (period)', align: 'right' },
  { header: 'Volume (period)', align: 'right' },
  { header: 'ASP', align: 'right' },
  { header: 'GP%', align: 'right' },
  { header: 'Vol Growth', align: 'right' },
];

/** Every field here can be null for a live no-sales product (this page's live rows include the
 * full dim_product catalog, not just products with a fact_bcgmatrix row -- see this file's header)
 * -- '—' fallbacks throughout, unlike BCG Matrix's equivalent which only ever sees already-
 * classified (therefore always-has-sales-data) rows. */
function brandFactToPdfRow(r: BrandPerformanceFact, displayName: string): string[] {
  return [
    displayName,
    r.Company,
    r.bcg_class_YTD ?? '—',
    r.bcg_movement ? MOVEMENT_LABEL[r.bcg_movement] : '—',
    fmtLYD(r.value),
    fmtVolume(r),
    r.avgUnitPrice === null ? '—' : fmtLYD(r.avgUnitPrice),
    r.grossProfitPct === null ? '—' : `${r.grossProfitPct.toFixed(1)}%`,
    r.quantity_growth_pct === null ? '—' : fmtPct(r.quantity_growth_pct),
  ];
}

/** One row of this brand's ranked product list -- same shape/bar-indicator convention as BCG
 * Matrix's MatrixListRow, carrying a live BrandPerformanceFact. `barPct` is anchored at 0 and
 * scaled to this brand's own top-of-list revenue, not a cross-brand scale. */
interface BrandProductRow extends Record<string, unknown> {
  id: string;
  label: string;
  revenueYTD: number;
  volumeYTD: number;
  barPct: number;
  fact: BrandPerformanceFact;
}

/** Hover state for the brand product list's floating tooltip -- same viewport-anchored
 * (position: fixed, computed from getBoundingClientRect on mouseenter) technique as BCG Matrix's
 * RankedProductList, for the same reason: DataTable's own `overflow: auto` wrapper would clip a
 * position:absolute tooltip. */
interface HoveredBrandRow {
  row: BrandProductRow;
  left: number;
  top?: number;
  bottom?: number;
}

const BRAND_TOOLTIP_ESTIMATED_HEIGHT = 210;
const BRAND_TOOLTIP_WIDTH = 200;

/** This brand's ranked product list -- Product Name + Volume YTD + Revenue YTD visible per row
 * (with a relative-revenue bar indicator), full detail (Company, BCG Class, Movement, ASP, GP%,
 * Vol Growth) on hover. Same DataTable + fixed-position-tooltip pattern as BCG Matrix's
 * RankedProductList, duplicated locally per that page's own established convention rather than
 * centralized in @07ps/ui (see that component's header comment). Shows every row currently in
 * scope (no top-N truncation) -- brand SKU counts here are small enough (largest is ~48) that a
 * preview/full-export split would just be extra state for no readability gain. */
function BrandProductList({ rows }: { rows: BrandProductRow[] }) {
  const [hovered, setHovered] = useState<HoveredBrandRow | null>(null);

  const handleEnter = (row: BrandProductRow) => (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const left = Math.min(rect.left, window.innerWidth - BRAND_TOOLTIP_WIDTH - 8);
    const fitsBelow = rect.bottom + BRAND_TOOLTIP_ESTIMATED_HEIGHT <= window.innerHeight;
    setHovered({
      row,
      left,
      ...(fitsBelow ? { top: rect.bottom + 6 } : { bottom: window.innerHeight - rect.top + 6 }),
    });
  };
  const handleLeave = () => setHovered(null);

  if (rows.length === 0) {
    return <p style={{ fontSize: 13, color: 'var(--ps-color-muted-text)' }}>No products in scope.</p>;
  }

  const columns: Column<BrandProductRow>[] = [
    {
      key: 'label',
      header: 'Product',
      render: (row) => (
        <div onMouseEnter={handleEnter(row)} onMouseLeave={handleLeave} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
          <div style={{ width: 32, height: 6, borderRadius: 3, background: 'var(--ps-color-muted-bg)', flexShrink: 0, overflow: 'hidden' }}>
            <div style={{ width: `${row.barPct}%`, height: '100%', background: 'var(--ps-color-accent)', borderRadius: 3 }} />
          </div>
          <span title={row.fact.ProductName} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {row.label}
          </span>
        </div>
      ),
    },
    { key: 'volumeYTD', header: 'Volume (period)', align: 'right', render: (row) => <span>{fmtVolume(row.fact)}</span> },
    { key: 'revenueYTD', header: 'Revenue (period)', align: 'right', render: (row) => <span style={{ fontWeight: 600 }}>{fmtLYD(row.revenueYTD)}</span> },
  ];

  return (
    <div style={{ position: 'relative' }}>
      <DataTable columns={columns} rows={rows} getRowId={(row) => row.id} />
      {hovered && (
        <div
          style={{
            position: 'fixed',
            left: hovered.left,
            top: hovered.top,
            bottom: hovered.bottom,
            width: BRAND_TOOLTIP_WIDTH,
            zIndex: 1000,
            pointerEvents: 'none',
          }}
        >
          <BrandRowTooltip fact={hovered.row.fact} label={hovered.row.label} />
        </div>
      )}
    </div>
  );
}

/** Hover tooltip content for a brand product row -- Company (this section's own addition, since a
 * brand can straddle both companies), BCG Class, Movement, Revenue YTD, Volume YTD, ASP, GP%, Vol
 * Growth. Same colored-pill/label-value-row convention as BCG Matrix's rowTooltipContent, extended
 * with the null-guards BCG Matrix's own version doesn't need (see this file's header). */
function BrandRowTooltip({ fact, label }: { fact: BrandPerformanceFact; label: string }) {
  return (
    <div
      style={{
        borderRadius: 10,
        border: '1px solid var(--ps-color-border)',
        fontSize: 12,
        background: 'var(--ps-color-surface)',
        color: 'var(--ps-color-text)',
        padding: '10px 12px',
        minWidth: 180,
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 6 }}>{label}</div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
        {fact.bcg_class_YTD && <Pill color={BCG_COLOR[fact.bcg_class_YTD] ?? 'var(--ps-color-muted-text)'} label={fact.bcg_class_YTD} />}
        {fact.bcg_movement && <Pill color={MOVEMENT_COLOR[fact.bcg_movement]} label={MOVEMENT_LABEL[fact.bcg_movement]} />}
      </div>
      <TooltipRow label="Company" value={fact.Company} />
      <TooltipRow label="Revenue (period)" value={fmtLYD(fact.value)} />
      <TooltipRow label="Volume (period)" value={fmtVolume(fact)} />
      <TooltipRow label="ASP" value={fact.avgUnitPrice === null ? '—' : fmtLYD(fact.avgUnitPrice)} />
      <TooltipRow label="GP%" value={fact.grossProfitPct === null ? 'no cost' : `${fact.grossProfitPct.toFixed(1)}%`} />
      <TooltipRow
        label="Vol Growth"
        value={fact.quantity_growth_pct === null ? '—' : fmtPct(fact.quantity_growth_pct)}
        valueColor={
          fact.quantity_growth_pct === null
            ? undefined
            : fact.quantity_growth_pct >= 0
              ? 'var(--ps-color-success)'
              : 'var(--ps-color-alert)'
        }
      />
    </div>
  );
}

/** Colored pill -- same treatment as BCG Matrix's own Pill (Class/Movement badges). */
function Pill({ color, label }: { color: string; label: string }) {
  return (
    <span
      style={{
        fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase',
        color, background: `color-mix(in srgb, ${color} 16%, transparent)`,
        padding: '3px 8px', borderRadius: 999,
      }}
    >
      {label}
    </span>
  );
}

/** Label/value row for the tooltip -- same right-aligned value convention as BCG Matrix's own
 * TooltipRow. */
function TooltipRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, lineHeight: 1.7 }}>
      <span style={{ color: 'var(--ps-color-muted-text)' }}>{label}</span>
      <span style={{ fontWeight: 600, color: valueColor ?? 'var(--ps-color-text)' }}>{value}</span>
    </div>
  );
}

/** Same bordered-pill "Export as PDF" convention every other report page uses (see BCG Matrix's
 * own PdfButton), duplicated locally per that established per-page convention. */
function PdfButton({ label, onClick }: { label: string; onClick: () => void }) {
  // Hidden without Export permission on this page (the backend refuses the export anyway).
  const canExport = useCanExport();
  if (!canExport) return null;
  return (
    <button
      type="button"
      onClick={onClick}
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
      {label}
    </button>
  );
}
