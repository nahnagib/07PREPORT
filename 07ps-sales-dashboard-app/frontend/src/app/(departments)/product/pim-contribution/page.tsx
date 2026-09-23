'use client';
import React, { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppHeader } from '../../../../components/AppHeader';
import { BottomNavBar } from '../../../../components/BottomNavBar';
import { FilterBar } from '../../../../components/FilterBar';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useAuth } from '../../../../lib/AuthProvider';
import { useBrandPerformanceOverview } from '../../../../lib/hooks';
import {
  ChartPanel,
  Card,
  KpiTile,
  Select,
  Button,
  DonutChart,
  GroupedBarChart,
  LoadingSkeleton,
  ErrorState,
  PerformanceReportTable,
  exportPerformanceTablePdf,
  SEMANTIC_STATUS_LABEL,
  type SelectOption,
  type DonutSegment,
  type PerformanceReportRow,
  type PerformanceTablePdfColumn,
} from '@07ps/ui';
import {
  FACTS,
  fmtLYD,
  fmtNum,
  fmtPct,
  distinctSorted,
  normCompany,
  filterFacts,
  filterByPageFilters,
  computeBrandStats,
  slugifyBrand,
  CATEGORY_PALETTE,
  COMPANIES,
  type CompanyFilter,
  type MaterialsAnalogyFact,
  type FoundBrandStats,
  type PartnerBrand,
} from '../../../../lib/materialsAnalogy/shared';

type Metric = 'value' | 'volume';
const BCG_CLASSES = ['Stars', 'Cash Cows', 'Strategic', 'Dogs'] as const;

function groupSum(rows: MaterialsAnalogyFact[], keyFn: (r: MaterialsAnalogyFact) => string, valFn: (r: MaterialsAnalogyFact) => number) {
  const m = new Map<string, number>();
  rows.forEach((r) => {
    const k = keyFn(r);
    m.set(k, (m.get(k) ?? 0) + valFn(r));
  });
  return m;
}

/** Rolls anything past the top 8 entries into a rollup bucket, same readability rule used for
 * every other categorical breakdown chart in this module. Labeled "Other (+N)" rather than a bare
 * "Other" -- the real Category/Family data already contains a genuine "Other" value (an actual
 * PRODUCTS.xlsx bucket), which collided with a bare synthetic "Other" here and produced a
 * duplicate React key (two segments both keyed "Other") the first time this rendered. */
function topNWithOther(entries: [string, number][], n = 8): [string, number][] {
  if (entries.length <= n + 1) return entries;
  const top = entries.slice(0, n);
  const rest = entries.slice(n);
  const otherVal = rest.reduce((a, e) => a + e[1], 0);
  return [...top, [`Other (+${rest.length})`, otherVal]];
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
// Executive Summary -- the top 4 KPI tiles have no prior-period comparison in this page's data
// model (point-in-time hierarchy counts), so they stay 'neutral'/informational. The brand rows
// reuse each brand's own real YTD-vs-LYTD `deltaPct` (already computed by computeBrandStats) for a
// simple green/red read -- up, or down, vs last year -- consistent with how BCG Matrix's own class
// deltas are read on that page.
// ---------------------------------------------------------------------------

function toExecutiveSummaryRows(
  categoryCount: number,
  familyCount: number,
  skuCount: number,
  topVal: [string, number] | undefined,
  topVol: [string, number] | undefined,
  brands: FoundBrandStats[],
): PerformanceReportRow[] {
  const rows: PerformanceReportRow[] = [
    {
      id: 'activeCategories',
      metric: 'Active Categories',
      actualLabel: String(categoryCount),
      targetLabel: '—',
      variancePct: null,
      varianceLyPct: null,
      status: 'neutral',
      takeaway: `${categoryCount} active categories across ${familyCount} families/ranges.`,
    },
    {
      id: 'topCategoryValue',
      metric: 'Top Category (by Value)',
      actualLabel: topVal ? topVal[0] : '—',
      actualFullValue: topVal ? fmtLYD(topVal[1]) : undefined,
      targetLabel: '—',
      variancePct: null,
      varianceLyPct: null,
      status: 'neutral',
      takeaway: topVal ? `${topVal[0]} is the top category by value at ${fmtLYD(topVal[1])} YTD.` : 'No category data available.',
    },
    {
      id: 'topCategoryVolume',
      metric: 'Top Category (by Volume)',
      actualLabel: topVol ? topVol[0] : '—',
      actualFullValue: topVol ? `${fmtNum(topVol[1])} units` : undefined,
      targetLabel: '—',
      variancePct: null,
      varianceLyPct: null,
      status: 'neutral',
      takeaway: topVol ? `${topVol[0]} is the top category by volume at ${fmtNum(topVol[1])} units YTD.` : 'No category data available.',
    },
    {
      id: 'skusInView',
      metric: 'SKUs in View',
      actualLabel: fmtNum(skuCount),
      targetLabel: '—',
      variancePct: null,
      varianceLyPct: null,
      status: 'neutral',
      takeaway: `${fmtNum(skuCount)} SKUs match the current filters.`,
    },
  ];

  const topBrands = [...brands].sort((a, b) => b.revenueYTD - a.revenueYTD).slice(0, 4);
  for (const b of topBrands) {
    rows.push({
      id: `brand-${b.matched}`,
      metric: b.requested,
      actualLabel: fmtLYD(b.revenueYTD),
      targetLabel: '—',
      variancePct: null,
      varianceLyPct: b.deltaPct / 100,
      status: b.deltaPct >= 0 ? 'success' : 'alert',
      takeaway: `${b.requested} revenue is ${fmtLYD(b.revenueYTD)} YTD (${fmtPct(b.deltaPct)} vs last year).`,
    });
  }

  return rows;
}

/** Blank, whitespace-only, or the literal string "Null" (a real value in the master data -- Size
 * is frequently stored this way, not as a true null) all collapse to one clearly-labeled bucket
 * instead of an empty slice or a literal "Null" text label that reads like real data. */
function normalizeHierarchyValue(v: string | null | undefined): string {
  if (v === null || v === undefined) return 'Unspecified';
  const trimmed = v.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'null') return 'Unspecified';
  return trimmed;
}

type HierarchyLevelKey = 'Company' | 'Category' | 'Brand' | 'SubBrand' | 'Family' | 'Size' | 'Product';

interface HierarchyLevel {
  key: HierarchyLevelKey;
  label: string;
  getValue: (r: MaterialsAnalogyFact) => string;
}

/** Full drill hierarchy (Section 1 extension) -- Company -> Category -> Brand -> SubBrand ->
 * Family -> Size, plus a trailing synthetic "Product" level so the same donut+ASP-bar machinery
 * that renders every real level also renders the eventual per-product breakdown once all 6 real
 * levels are exhausted ("leaf-level product data" per the redesign request), rather than a
 * separate table component. `SubBrand` is genuinely absent from the current synthetic dataset --
 * every row normalizes to "Unspecified" for it, which is exactly the case resolveDrillLevel below
 * auto-skips (a level with only one distinct value adds no real segmentation), so this level just
 * never shows a donut step today without needing to be special-cased out of the array. */
const HIERARCHY_LEVELS: HierarchyLevel[] = [
  { key: 'Company', label: 'Company', getValue: (r) => normCompany(r.Company) },
  { key: 'Category', label: 'Category', getValue: (r) => normalizeHierarchyValue(r.Category) },
  { key: 'Brand', label: 'Brand', getValue: (r) => normalizeHierarchyValue(r.Brand) },
  { key: 'SubBrand', label: 'Sub-Brand', getValue: (r) => normalizeHierarchyValue(r.SubBrand) },
  { key: 'Family', label: 'Family', getValue: (r) => normalizeHierarchyValue(r.Family) },
  { key: 'Size', label: 'Size', getValue: (r) => normalizeHierarchyValue(r.Size) },
  { key: 'Product', label: 'Product', getValue: (r) => r.ProductName },
];

interface ResolvedDrill {
  /** The full chosen-value path, INCLUDING any levels auto-skipped for lack of real segmentation
   * (see the loop below) -- this is what the breadcrumb renders, so an auto-skipped "Unspecified"
   * SubBrand still shows up as a real crumb, not silently disappears. */
  path: string[];
  scope: MaterialsAnalogyFact[];
  /** Index into HIERARCHY_LEVELS of the level to actually display as a donut. `null` once every
   * level (including the synthetic Product one) has been exhausted -- true single-item leaf,
   * nothing left to segment by. */
  levelIndex: number | null;
}

/** Walks the hierarchy from `basePath.length` forward, auto-advancing (not just hiding) through
 * any level where every row remaining in scope shares the exact same value -- a level like that
 * contributes nothing to segment by (a donut with one 100% slice), so instead of showing it, its
 * single value is folded into the path and the walk continues to the next level. Stops at the
 * first level with real (>1) distinct values, or returns levelIndex=null once every level
 * (including the trailing "Product" one) has collapsed to a single value -- an actual leaf. */
function resolveDrillLevel(universe: MaterialsAnalogyFact[], basePath: string[]): ResolvedDrill {
  let path = basePath;
  for (;;) {
    const scope = universe.filter((r) => path.every((val, i) => HIERARCHY_LEVELS[i].getValue(r) === val));
    const levelIndex = path.length;
    if (levelIndex >= HIERARCHY_LEVELS.length) {
      return { path, scope, levelIndex: null };
    }
    if (scope.length === 0) {
      return { path, scope, levelIndex };
    }
    const level = HIERARCHY_LEVELS[levelIndex];
    const distinctValues = new Set(scope.map(level.getValue));
    if (distinctValues.size <= 1) {
      path = [...path, level.getValue(scope[0])];
      continue;
    }
    return { path, scope, levelIndex };
  }
}

/** Builds the URL for a brand's drill-down page, carrying this page's current Company/Category/
 * BCG Class filters along as query params (same "filters via URL query params" convention as
 * Tachometer's own summary -> detail-route navigation, see tachometer/page.tsx's
 * buildBreakdownHref) so the brand drill-down route can independently recompute the identical
 * filtered scope rather than needing React state/context shared across a real route boundary. */
function buildBrandHref(requestedName: string, filters: { company: CompanyFilter; category: string[]; bcgClass: string }): string {
  const params = new URLSearchParams();
  if (filters.company !== 'All') params.set('company', filters.company);
  filters.category.forEach((c) => params.append('category', c));
  if (filters.bcgClass !== 'All') params.set('bcgClass', filters.bcgClass);
  const qs = params.toString();
  return `/product/pim-contribution/brand/${slugifyBrand(requestedName)}${qs ? `?${qs}` : ''}`;
}

export default function PimContributionPage() {
  const { user, logout, token, error: authError, retryAuth } = useAuth();
  const roleLabel = user?.role.label ?? user?.fullName;
  const router = useRouter();
  const [anchorDate, setAnchorDate] = useState('');

  const [company, setCompany] = useState<CompanyFilter>('All');
  const [category, setCategory] = useState<string[]>([]);
  const [bcgClass, setBcgClass] = useState<'All' | (typeof BCG_CLASSES)[number]>('All');
  const [metric, setMetric] = useState<Metric>('value');
  // Full chosen-value path through HIERARCHY_LEVELS (Company -> Category -> Brand -> SubBrand ->
  // Family -> Size -> Product) -- replaces the old single `drillCategory` string now that the
  // donut drills 6+1 levels deep instead of 2. `metric` is deliberately a separate, untouched
  // piece of state (see below) so the Value/Volume toggle persists through every level of the
  // drill by construction, not by any special-casing here.
  const [drillPath, setDrillPath] = useState<string[]>([]);

  const categoryOptions: SelectOption[] = useMemo(() => {
    const pool = FACTS.filter((r) => company === 'All' || r.Company === company);
    return distinctSorted(pool.map((r) => r.Category)).map((c) => ({ value: c, label: c }));
  }, [company]);

  const filtered = useMemo(() => filterFacts(FACTS, { company, category, bcgClass }), [company, category, bcgClass]);

  const metricVal = (r: MaterialsAnalogyFact) => (metric === 'value' ? r.total_value_YTD : r.total_quantity_YTD);
  const metricFmt = (v: number) => (metric === 'value' ? fmtLYD(v) : `${fmtNum(v)} units`);

  // ---- KPIs ----
  const activeRows = filtered.filter((r) => r.IsActive === 1);
  const categoryCount = new Set(activeRows.map((r) => r.Category)).size;
  const familyCount = new Set(activeRows.map((r) => r.Family)).size;
  const byCatVal = groupSum(filtered, (r) => r.Category, (r) => r.total_value_YTD);
  const byCatVol = groupSum(filtered, (r) => r.Category, (r) => r.total_quantity_YTD);
  const topVal = [...byCatVal.entries()].sort((a, b) => b[1] - a[1])[0];
  const topVol = [...byCatVol.entries()].sort((a, b) => b[1] - a[1])[0];

  // ---- Donut (drill-down), full 6+1-level hierarchy ----
  // `resolved.path` is what actually gets rendered as the breadcrumb -- it can be longer than
  // `drillPath` (the user's real click history) whenever one or more levels ahead auto-skipped for
  // lack of real segmentation (e.g. SubBrand, uniformly "Unspecified" in the current dataset). Every
  // click appends to `resolved.path`, not `drillPath`, so the next render's resolve starts from
  // the already-fully-resolved position rather than re-walking through the same auto-skips.
  const resolved = useMemo(() => resolveDrillLevel(filtered, drillPath), [filtered, drillPath]);
  const { scope, levelIndex } = resolved;
  const isLeaf = levelIndex === null;
  const currentLevel = levelIndex !== null ? HIERARCHY_LEVELS[levelIndex] : null;
  const groupKey = currentLevel ? currentLevel.getValue : (r: MaterialsAnalogyFact) => r.ProductName;

  const grouped = groupSum(scope, groupKey, metricVal);
  const entries = topNWithOther([...grouped.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]));
  const segments: DonutSegment[] = entries.map(([label, value], i) => ({
    id: label,
    label,
    value,
    color: label.startsWith('Other (') ? 'var(--ps-color-neutral-text)' : CATEGORY_PALETTE[i % CATEGORY_PALETTE.length],
  }));

  // ---- ASP chart, synced to the same resolved drill scope/level ----
  const aspMap = new Map<string, { value: number; qty: number; valueLY: number; qtyLY: number; n: number }>();
  scope.forEach((r) => {
    const k = groupKey(r);
    const o = aspMap.get(k) ?? { value: 0, qty: 0, valueLY: 0, qtyLY: 0, n: 0 };
    o.value += r.total_value_YTD;
    o.qty += r.total_quantity_YTD;
    o.valueLY += r.total_value_LYTD;
    o.qtyLY += r.total_quantity_LYTD;
    o.n += 1;
    aspMap.set(k, o);
  });
  const aspPoints = [...aspMap.entries()]
    .map(([label, o]) => ({ label, asp: o.qty > 0 ? o.value / o.qty : 0 }))
    .sort((a, b) => b.asp - a.asp)
    .slice(0, 15);

  // ---- True leaf: every level (including the synthetic Product one) collapsed to a single
  // value -- nothing left to segment by, so this is one specific product's own figures rather
  // than another donut with a single 100% slice. ----
  const leafRow: MaterialsAnalogyFact | undefined = isLeaf ? scope[0] : undefined;

  // ---- Brand Performance (Section 2) -- respects the page's own Company/Category/BCG Class
  // filters, same as every other section on this page, so "Brand Performance for Majaal only"
  // works the same way filtering already works everywhere else here. computeBrandStats lives in
  // shared.ts (not page-local) so this summary page's cards and the brand drill-down route (a real
  // separate route -- see pim-contribution/brand/[brand]/page.tsx) always agree on the numbers for
  // a given filter scope.
  //
  // Unlike every other section on this page, this one no longer reads `filtered`/`FACTS` --
  // migrated onto the live `useBrandPerformanceOverview` (backend/src/measures/
  // materialsAnalogyBrandPerformance.ts) since data.json was confirmed the root cause of
  // undercounted SKU Count/revenue/volume for every partner brand (~32% sample of the real
  // catalog). `perc_gross_profit_YTD` is coerced null -> 0 here (not inside computeBrandStats,
  // which stays untouched) -- a no-sales live row has no GP baseline to report, and its
  // total_value_YTD is already 0, so the coercion doesn't change the weighted-GP total. ----
  const brandPerf = useBrandPerformanceOverview(token, authError, retryAuth);
  const { found: foundBrandStats, notFound: notFoundBrands } = useMemo(
    () =>
      computeBrandStats(
        filterByPageFilters(
          (brandPerf.data?.facts ?? []).map((f) => ({ ...f, perc_gross_profit_YTD: f.perc_gross_profit_YTD ?? 0 })),
          { company, category, bcgClass },
        ),
      ),
    [brandPerf.data, company, category, bcgClass],
  );

  const performanceRows = toExecutiveSummaryRows(categoryCount, familyCount, filtered.length, topVal, topVol, foundBrandStats);
  async function handleExportPerformanceTablePdf() {
    try {
      await exportPerformanceTablePdf({
        title: 'Performance Details',
        rows: performanceRows,
        columns: PERFORMANCE_PDF_COLUMNS,
        fileName: 'pim-contribution-performance-details',
      });
    } catch (err) {
      console.error('PDF export failed:', err);
    }
  }

  return (
    <PermissionGuard pageKey="pim_contribution">
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', paddingBottom: 64 }}>
        <AppHeader
          pageTitle="Product Dashboard"
          anchorDate={anchorDate}
          onAnchorDateChange={setAnchorDate}
          roleLabel={roleLabel}
          onLogout={logout}
          showDateInput={false}
        />

        <FilterBar
          onReset={() => {
            setCompany('All');
            setCategory([]);
            setBcgClass('All');
          }}
          isPristine={company === 'All' && category.length === 0 && bcgClass === 'All'}
          showDateRange={false}
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
              <PillField label="BCG Class">
                {(['All', ...BCG_CLASSES] as const).map((cls) => (
                  <Button key={cls} variant={bcgClass === cls ? 'primary' : 'secondary'} style={{ padding: '6px 12px', fontSize: 12.5 }} onClick={() => setBcgClass(cls)}>
                    {cls}
                  </Button>
                ))}
              </PillField>
            </>
          }
        />

        <main style={{ flex: 1, padding: 'var(--ps-space-4, 24px)', display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)' }}>
          {brandPerf.loading ? (
            <LoadingSkeleton variant="chart" />
          ) : brandPerf.error ? (
            <ErrorState message={brandPerf.error} onRetry={brandPerf.retry} />
          ) : (
            <BrandPerformanceSection
              found={foundBrandStats}
              notFound={notFoundBrands}
              onSelectBrand={(b) => router.push(buildBrandHref(b.requested, { company, category, bcgClass }))}
            />
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--ps-space-3, 16px)' }}>
            <KpiTile label="Active Categories" value={String(categoryCount)} variance={`${familyCount} active Families/Ranges`} status="neutral" />
            <KpiTile label="Active Ranges / Families" value={String(familyCount)} variance={`${filtered.length} SKUs in view`} status="neutral" />
            <KpiTile label="Top Category by Value" value={topVal ? topVal[0] : '—'} variance={topVal ? fmtLYD(topVal[1]) : undefined} status="success" />
            <KpiTile label="Top Category by Volume" value={topVol ? topVol[0] : '—'} variance={topVol ? `${fmtNum(topVol[1])} units` : undefined} status="success" />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '11fr 9fr', gap: 'var(--ps-space-3, 16px)' }}>
            <ChartPanel
              title="Product Hierarchy Contribution"
              infoText={
                isLeaf
                  ? 'Single product reached -- nothing further to break down'
                  : `Click a slice or legend row to drill into its ${HIERARCHY_LEVELS[levelIndex! + 1]?.label ?? 'Product'} breakdown`
              }
              headerActions={
                <div style={{ display: 'flex', gap: 6 }}>
                  <Button variant={metric === 'value' ? 'primary' : 'secondary'} style={{ padding: '4px 10px', fontSize: 11 }} onClick={() => setMetric('value')}>
                    By Value
                  </Button>
                  <Button variant={metric === 'volume' ? 'primary' : 'secondary'} style={{ padding: '4px 10px', fontSize: 11 }} onClick={() => setMetric('volume')}>
                    By Volume
                  </Button>
                </div>
              }
            >
              <HierarchyBreadcrumb path={resolved.path} isLeaf={isLeaf} leafLabel={leafRow?.ProductName} onJump={(depth) => setDrillPath(resolved.path.slice(0, depth))} />
              {isLeaf ? (
                leafRow ? (
                  <div style={{ padding: '8px 4px' }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ps-color-text)', marginBottom: 4 }}>{leafRow.ProductName}</div>
                    <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)' }}>SKU {leafRow.SKU} · {leafRow.Company}</div>
                  </div>
                ) : (
                  <p style={{ fontSize: 13, color: 'var(--ps-color-muted-text)' }}>No products in scope.</p>
                )
              ) : (
                <DonutChart
                  showTitle={false}
                  segments={segments}
                  valueFormatter={metricFmt}
                  legendTitle={`By ${currentLevel?.label}`}
                  onSegmentClick={(id) => !id.startsWith('Other (') && setDrillPath([...resolved.path, id])}
                />
              )}
            </ChartPanel>

            <ChartPanel
              title="Average Selling Price (ASP)"
              infoText={isLeaf ? 'This product\'s own figures' : `By ${currentLevel?.label} — synced to the drill level above`}
            >
              {isLeaf ? (
                leafRow ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
                    <LeafStat label="Revenue YTD" value={fmtLYD(leafRow.total_value_YTD)} />
                    <LeafStat label="Volume YTD" value={`${fmtNum(leafRow.total_quantity_YTD)} units`} />
                    <LeafStat label="ASP" value={fmtLYD(leafRow.avg_unit_price_YTD)} />
                    <LeafStat label="GP%" value={`${leafRow.perc_gross_profit_YTD.toFixed(1)}%`} />
                  </div>
                ) : null
              ) : (
                <GroupedBarChart
                  showTitle={false}
                  points={aspPoints}
                  bars={[{ key: 'asp', name: 'ASP', color: 'var(--ps-color-accent)' }]}
                  valueFormatter={fmtLYD}
                />
              )}
            </ChartPanel>
          </div>

          {!brandPerf.loading && !brandPerf.error && (
            <PerformanceReportTable
              title="Performance Details"
              rows={performanceRows}
              showStatus
              showTakeaway
              onExportPdf={handleExportPerformanceTablePdf}
            />
          )}
        </main>

        <BottomNavBar active="PIM Contribution" />
      </div>
    </PermissionGuard>
  );
}

/** Full-path breadcrumb for the 6+1-level hierarchy drill (Section 1) -- same "clickable links for
 * every prior level, plain bold text for the current one" convention the old 2-level version used,
 * just chained across as many levels as `path` actually has instead of one fixed segment. Every
 * entry in `path` is real (auto-skipped levels like a uniformly-"Unspecified" SubBrand are folded
 * into it too, see resolveDrillLevel), so this always shows the true full path, not just the
 * user's own clicks. `onJump(depth)` truncates back to having exactly `depth` levels chosen. */
function HierarchyBreadcrumb({
  path,
  isLeaf,
  leafLabel,
  onJump,
}: {
  path: string[];
  isLeaf: boolean;
  leafLabel?: string;
  onJump: (depth: number) => void;
}) {
  return (
    <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {path.length === 0 ? (
        <span>All Companies</span>
      ) : (
        <button type="button" onClick={() => onJump(0)} style={crumbLinkStyle}>
          All Companies
        </button>
      )}
      {path.map((val, i) => {
        const isCurrent = i === path.length - 1 && !isLeaf;
        return (
          <React.Fragment key={i}>
            <span>›</span>
            {isCurrent ? (
              <span style={{ color: 'var(--ps-color-text)', fontWeight: 600 }}>{val}</span>
            ) : (
              <button type="button" onClick={() => onJump(i + 1)} style={crumbLinkStyle}>
                {val}
              </button>
            )}
          </React.Fragment>
        );
      })}
      {isLeaf && leafLabel && (
        <>
          <span>›</span>
          <span style={{ color: 'var(--ps-color-text)', fontWeight: 600 }}>{leafLabel}</span>
        </>
      )}
    </div>
  );
}

const crumbLinkStyle: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, color: 'var(--ps-color-accent)', fontWeight: 600, cursor: 'pointer', fontSize: 12,
};

/** Small label/value stat block for the leaf (single-product) case, same visual weight as a
 * KpiTile but without the Card chrome -- these 4 sit inside the ASP panel's own Card already, so
 * nesting another card per stat would double up the border/shadow. */
function LeafStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--ps-color-text)' }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', marginTop: 2 }}>{label}</div>
    </div>
  );
}

/** Section 2: named partner-brand tracking (Ape Grupo, VitrA, Onyx, Mayor, QUA, RAK CERAMICS,
 * Porcelanosa, FILA), as one consolidated Card per found brand (canonical requested name +
 * company-split badges in the header -- no "stored as" annotation, that's a data-matching detail
 * with no business surfacing a second, non-canonical name string in this UI -- Revenue YTD as the
 * large primary stat, the other 4 metrics as a compact secondary grid) instead of a header
 * followed by 5 separate KpiTiles -- sorted by Revenue YTD descending so all 8 brands' primary
 * metric is scannable at a glance.
 *
 * Clicking a card navigates to that brand's own drill-down ROUTE (`onSelectBrand`, wired to
 * `router.push` in the parent page) rather than expanding inline -- the drilled-in product list is
 * a genuinely separate view (its own full page, no KPI cards/donut/ASP content behind it), same
 * "summary page + a real drill-down/detail route" split Tachometer already established (see
 * tachometer/[metric]/page.tsx and this brand's own pim-contribution/brand/[brand]/page.tsx), not
 * an inline expand/collapse block sharing the same continuously-scrolling page as the rest of PIM
 * Contribution. Brands with no real match in the product data (see PARTNER_BRANDS' header comment
 * in shared.ts) still get a visible line instead of silently vanishing, since whoever compiled
 * this list has a real reason to expect all 8 to be tracked. */
function BrandPerformanceSection({
  found,
  notFound,
  onSelectBrand,
}: {
  found: FoundBrandStats[];
  notFound: PartnerBrand[];
  onSelectBrand: (b: FoundBrandStats) => void;
}) {
  return (
    <div id="brand-performance">
      <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ps-color-text)', marginBottom: 2 }}>Brand Performance</div>
      <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginBottom: 16 }}>
        Named partner brands · sorted by Revenue YTD · synced to the Company/Category/BCG Class filters above
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--ps-space-3, 16px)' }}>
        {found.map((b) => (
          <BrandCard key={b.matched} b={b} onClick={() => onSelectBrand(b)} />
        ))}
      </div>

      {notFound.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', marginTop: 20, paddingTop: 12, borderTop: '1px solid var(--ps-color-border)' }}>
          Not currently stocked (no matching Brand found in the product data, checked case-insensitively with fuzzy spelling matching):{' '}
          <strong style={{ color: 'var(--ps-color-text)' }}>{notFound.map((b) => b.requested).join(', ')}</strong>
        </div>
      )}
    </div>
  );
}

/** One consolidated brand card (redesign) -- canonical name + company-split badges in the header,
 * Revenue YTD + delta as the large primary stat (Section 3.6-style KPI typography, 30px bold),
 * the other 4 metrics as a compact secondary row (16px bold) so the hierarchy reads Revenue YTD
 * first, everything else supporting -- all inside one bounded Card rather than a header floating
 * above 5 separate same-sized boxes. Whole card is clickable (same `.ps-card-clickable`/keyboard
 * pattern as GaugeCard's own drill-down cards) to navigate to that brand's product list. */
function BrandCard({ b, onClick }: { b: FoundBrandStats; onClick: () => void }) {
  return (
    <Card
      aria-label={`${b.requested} brand performance, view products`}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className="ps-card-clickable"
      style={{ cursor: 'pointer' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--ps-color-text)' }}>{b.requested}</span>
        {b.companySplit.length > 1 &&
          b.companySplit.map((cs) => (
            <span
              key={cs.company}
              style={{
                fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase',
                color: 'var(--ps-color-accent)', background: 'color-mix(in srgb, var(--ps-color-accent) 16%, transparent)',
                padding: '3px 8px', borderRadius: 999,
              }}
            >
              {cs.company} {cs.pct.toFixed(0)}%
            </span>
          ))}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--ps-color-accent)', whiteSpace: 'nowrap' }}>View products →</span>
      </div>

      <div style={{ borderTop: '1px solid var(--ps-color-border)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <div style={{ fontSize: 30, fontWeight: 700, color: 'var(--ps-color-text)', lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
            {fmtLYD(b.revenueYTD)}
          </div>
          <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', marginTop: 4 }}>Revenue YTD</div>
          <div style={{ fontSize: 12, fontWeight: 600, marginTop: 2, color: b.deltaPct >= 0 ? 'var(--ps-color-success)' : 'var(--ps-color-alert)' }}>
            {fmtPct(b.deltaPct)} vs LYTD
          </div>
        </div>
        {/* Secondary metrics as a 2x2 grid (not an inline row) -- at 4-per-row card widths (~230px)
            there isn't room to lay Revenue + all 4 secondary stats out side by side without either
            shrinking text past a readable size or truncating values, so the secondary group stacks
            below Revenue instead, keeping every stat's own text at full size. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
          <SecondaryStat label="Volume YTD" value={`${fmtNum(b.volumeYTD)} units`} />
          <SecondaryStat label="ASP" value={fmtLYD(b.asp)} />
          <SecondaryStat label="GP%" value={`${b.gp.toFixed(1)}%`} />
          <SkuCountStat ytd={b.skuCount} lytd={b.skuCountLYTD} />
        </div>
      </div>
    </Card>
  );
}

function SecondaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ps-color-text)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginTop: 2 }}>{label}</div>
    </div>
  );
}

/** SKU Count secondary stat, extended with its LYTD counterpart (portfolio breadth change) --
 * same ▲/▼-colored-delta convention as every other YTD/LYTD comparison in this module (e.g. this
 * card's own Revenue YTD delta above). Combines both numbers into this one stat slot rather than
 * adding a 5th secondary stat, so the 4-per-row card grid doesn't get more cramped than the redesign
 * already accounts for. */
function SkuCountStat({ ytd, lytd }: { ytd: number; lytd: number }) {
  const delta = ytd - lytd;
  const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '–';
  const deltaColor = delta > 0 ? 'var(--ps-color-success)' : delta < 0 ? 'var(--ps-color-alert)' : 'var(--ps-color-muted-text)';
  return (
    <div>
      <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ps-color-text)', fontVariantNumeric: 'tabular-nums' }}>{ytd}</div>
      <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginTop: 2 }}>SKU Count</div>
      <div style={{ fontSize: 11, fontWeight: 600, marginTop: 1, color: deltaColor }}>
        {arrow} {Math.abs(delta)} ({lytd} LYTD)
      </div>
    </div>
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
