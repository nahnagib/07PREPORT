'use client';
import { vh } from '../../../../lib/visualHelp';
import React, { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
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
  ChartPanel,
  Card,
  Select,
  Button,
  DonutChart,
  GroupedBarChart,
  LoadingSkeleton,
  ErrorState,
  VisualInfoIcons,
  type SelectOption,
  type DonutSegment,
} from '@07ps/ui';
import {
  toProductFacts,
  fmtLYD,
  fmtPct,
  fmtUnits,
  distinctSorted,
  filterByPageFilters,
  computeBrandStats,
  slugifyBrand,
  CATEGORY_PALETTE,
  UNCLASSIFIED_NO_COST,
  type ProductFact,
  type FoundBrandStats,
  type PartnerBrand,
} from '../../../../lib/materialsAnalogy/shared';
import { ProductName, ltrLabel } from '../../../../components/product/ProductUi';

type MaterialsAnalogyFact = ProductFact;

/** Volume first: every PIM visual is based on invoiced quantity, added up as "Unit" whatever the Odoo UoM
 * (2026-11-07); "By Value" (LYD) is the secondary view. */
type Metric = 'volume' | 'value';
const BCG_CLASSES = ['Stars', 'Cash Cows', 'Strategic', 'Dogs', UNCLASSIFIED_NO_COST] as const;

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
 * "Other" -- the real Category/Family data can contain a genuine "Other" value (an actual
 * product bucket), which collided with a bare synthetic "Other" here and produced a
 * duplicate React key (two segments both keyed "Other") the first time this rendered. */
function topNWithOther(entries: [string, number][], n = 8): [string, number][] {
  if (entries.length <= n + 1) return entries;
  const top = entries.slice(0, n);
  const rest = entries.slice(n);
  const otherVal = rest.reduce((a, e) => a + e[1], 0);
  return [...top, [`Other (+${rest.length})`, otherVal]];
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
  { key: 'Company', label: 'Company', getValue: (r) => r.Company },
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

/** Builds the URL for a brand's drill-down page, carrying this page's own Category / BCG Class filters along as query
 * params; the company, Customer Group, channel, branch, salesperson and date range are the app-wide FilterProvider
 * state, which the brand page reads too (useProductFilters), so both pages always show the same scope. */
function buildBrandHref(requestedName: string, filters: { category: string[]; bcgClass: string }): string {
  const params = new URLSearchParams();
  filters.category.forEach((c) => params.append('category', c));
  if (filters.bcgClass !== 'All') params.set('bcgClass', filters.bcgClass);
  const qs = params.toString();
  return `/product/pim-contribution/brand/${slugifyBrand(requestedName)}${qs ? `?${qs}` : ''}`;
}

export default function PimContributionPage() {
  const { user, logout, token, error: authError, retryAuth } = useAuth();
  const roleLabel = user?.role.label ?? user?.fullName;
  const router = useRouter();
  const refresh = useRefreshStatus(token, authError, retryAuth);
  const { anchorDate, onAnchorDateChange, scope: productScope, filterBarProps, withLocalReset } = useProductFilters(refresh.data);

  // Company view (one company) or all companies side by side; a product is always one Odoo product in one company.
  const overview = useProductDashboard(token, authError, retryAuth, 'pim-contribution', productScope);
  const facts = useMemo(() => toProductFacts(overview.data), [overview.data]);
  const [category, setCategory] = useState<string[]>([]);
  const [bcgClass, setBcgClass] = useState<'All' | (typeof BCG_CLASSES)[number]>('All');
  const [metric, setMetric] = useState<Metric>('volume');
  const [categoryMetric, setCategoryMetric] = useState<Metric>('volume');
  // Full chosen-value path through HIERARCHY_LEVELS (Company -> Category -> Brand -> SubBrand ->
  // Family -> Size -> Product) -- replaces the old single `drillCategory` string now that the
  // donut drills 6+1 levels deep instead of 2. `metric` is deliberately a separate, untouched
  // piece of state (see below) so the Value/Volume toggle persists through every level of the
  // drill by construction, not by any special-casing here.
  const [drillPath, setDrillPath] = useState<string[]>([]);

  const categoryOptions: SelectOption[] = useMemo(
    () => distinctSorted(facts.map((r) => r.Category)).map((c) => ({ value: c, label: c })),
    [facts],
  );

  // The company is applied by the API (FilterBar company); Category / BCG Class here.
  const filtered = useMemo(() => filterByPageFilters(facts, { company: 'All', category, bcgClass }), [facts, category, bcgClass]);

  const metricVal = (r: MaterialsAnalogyFact) => (metric === 'value' ? r.value : r.volume);
  const metricFmt = (v: number) => (metric === 'value' ? fmtLYD(v) : fmtUnits(v));

  // ---- Categories donut: the 8 largest categories + Other, by volume (default) or value ----
  const categoryVal = (r: MaterialsAnalogyFact) => (categoryMetric === 'value' ? r.value : r.volume);
  const categoryEntries = topNWithOther([...groupSum(filtered, (r) => normalizeHierarchyValue(r.Category), categoryVal).entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]));
  const categorySegments: DonutSegment[] = categoryEntries.map(([label, value], i) => ({
    id: label,
    label: ltrLabel(label),
    value,
    color: label.startsWith('Other (') ? 'var(--ps-color-neutral-text)' : CATEGORY_PALETTE[i % CATEGORY_PALETTE.length],
  }));
  const categoryFmt = (v: number) => (categoryMetric === 'value' ? fmtLYD(v) : fmtUnits(v));

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
    label: ltrLabel(label),
    value,
    color: label.startsWith('Other (') ? 'var(--ps-color-neutral-text)' : CATEGORY_PALETTE[i % CATEGORY_PALETTE.length],
  }));

  // ---- ASP chart, synced to the same resolved drill scope/level: Σ value ÷ Σ units (added up as Unit) ----
  const aspMap = new Map<string, { value: number; qty: number; n: number }>();
  scope.forEach((r) => {
    const k = groupKey(r);
    const o = aspMap.get(k) ?? { value: 0, qty: 0, n: 0 };
    o.value += r.value;
    o.qty += r.volume;
    o.n += 1;
    aspMap.set(k, o);
  });
  const aspPoints = [...aspMap.entries()]
    .filter(([, o]) => o.qty > 0)
    .map(([label, o]) => ({ label: ltrLabel(label), asp: o.value / o.qty }))
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
  const { found: foundBrandStats, notFound: notFoundBrands } = useMemo(() => computeBrandStats(filtered), [filtered]);

  return (
    <PermissionGuard pageKey="pim_contribution">
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
            setBcgClass('All');
          }, category.length === 0 && bcgClass === 'All')}
          secondRow={
            <>
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
            <BrandPerformanceSection
              found={foundBrandStats}
              notFound={notFoundBrands}
              onSelectBrand={(b) => router.push(buildBrandHref(b.requested, { category, bcgClass }))}
            />

          <ChartPanel {...vh('product.pimContribution.categories')}
            title="Categories"
            wrapHeader
            headerActions={
              <div style={{ display: 'flex', gap: 6 }}>
                <Button variant={categoryMetric === 'volume' ? 'primary' : 'secondary'} style={{ padding: '4px 10px', fontSize: 11 }} onClick={() => setCategoryMetric('volume')}>
                  By Volume (Unit)
                </Button>
                <Button variant={categoryMetric === 'value' ? 'primary' : 'secondary'} style={{ padding: '4px 10px', fontSize: 11 }} onClick={() => setCategoryMetric('value')}>
                  By Value
                </Button>
              </div>
            }
          >
            <div data-testid="pim-categories-donut">
              {categorySegments.length ? (
                <DonutChart
                  title="Categories"
                  showTitle={false}
                  segments={categorySegments}
                  valueFormatter={categoryFmt}
                  legendTitle={`Top ${Math.min(8, categorySegments.length)} categories · ${categoryMetric === 'value' ? 'value (LYD)' : 'volume (Unit)'}`}
                  labelDirection="ltr"
                />
              ) : (
                <p style={{ fontSize: 13, color: 'var(--ps-color-muted-text)' }}>No sales in the period.</p>
              )}
            </div>
          </ChartPanel>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))', gap: 'var(--ps-space-3, 16px)' }}>
            <ChartPanel {...vh("product.pimContribution.hierarchy")}
              style={{ minWidth: 0 }}
              title="Product Hierarchy Contribution"
              wrapHeader
              headerActions={
                <div style={{ display: 'flex', gap: 6 }}>
                  <Button variant={metric === 'volume' ? 'primary' : 'secondary'} style={{ padding: '4px 10px', fontSize: 11 }} onClick={() => setMetric('volume')}>
                    By Volume (Unit)
                  </Button>
                  <Button variant={metric === 'value' ? 'primary' : 'secondary'} style={{ padding: '4px 10px', fontSize: 11 }} onClick={() => setMetric('value')}>
                    By Value
                  </Button>
                </div>
              }
            >
              <HierarchyBreadcrumb path={resolved.path} isLeaf={isLeaf} leafLabel={leafRow?.ProductName} onJump={(depth) => setDrillPath(resolved.path.slice(0, depth))} />
              {isLeaf ? (
                leafRow ? (
                  <div style={{ padding: '8px 4px' }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ps-color-text)', marginBottom: 4 }}><ProductName name={leafRow.ProductName} href={leafRow.odooUrl} truncate={false} /></div>
                    <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)' }}>SKU {leafRow.SKU ?? '—'} · {leafRow.Company}</div>
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
                  labelDirection="ltr"
                  onSegmentClick={(id) => !id.startsWith('Other (') && setDrillPath([...resolved.path, id])}
                />
              )}
            </ChartPanel>

            <ChartPanel {...vh("product.pimContribution.asp")}
              style={{ minWidth: 0 }}
              title="Average Selling Price (ASP)"
            >
              {isLeaf ? (
                leafRow ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
                    <LeafStat label="Volume (period)" value={fmtUnits(leafRow.volume)} />
                    <LeafStat label="Revenue (period)" value={fmtLYD(leafRow.value)} />
                    <LeafStat label="ASP" value={leafRow.avgUnitPrice === null ? '—' : fmtLYD(leafRow.avgUnitPrice)} />
                    <LeafStat label="GP%" value={leafRow.grossProfitPct === null ? 'no cost' : `${leafRow.grossProfitPct.toFixed(1)}%`} />
                  </div>
                ) : null
              ) : (
                <GroupedBarChart
                  showTitle={false}
                  points={aspPoints}
                  bars={[{ key: 'asp', name: 'ASP (LYD per Unit)', color: 'var(--ps-color-accent)' }]}
                  valueFormatter={fmtLYD}
                  yAxisWidth={150}
                  height={Math.max(280, aspPoints.length * 30 + 60)}
                  fill
                />
              )}
            </ChartPanel>
          </div>

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
    <div dir="ltr" style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
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
              <span dir="ltr" style={{ color: 'var(--ps-color-text)', fontWeight: 600 }}>{ltrLabel(val)}</span>
            ) : (
              <button type="button" onClick={() => onJump(i + 1)} style={crumbLinkStyle}>
                <span dir="ltr">{ltrLabel(val)}</span>
              </button>
            )}
          </React.Fragment>
        );
      })}
      {isLeaf && leafLabel && (
        <>
          <span>›</span>
          <span dir="ltr" style={{ color: 'var(--ps-color-text)', fontWeight: 600 }}>{ltrLabel(leafLabel)}</span>
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

/** Section 2: the partner brands (PARTNER_BRANDS in lib/materialsAnalogy/shared.ts: Ape Grupo, VitrA, Onyx, Mayor,
 * QUA, FILA, TAU). The Brand is the product's main vendor in Odoo, matched case-insensitively on the brand's Odoo
 * names. One card per brand, sorted by revenue; a brand with no product in Odoo yet gets a "not currently assigned in
 * Odoo" card, so it appears with figures as soon as it is filled in Odoo. Clicking a card opens the brand's own page
 * (pim-contribution/brand/[brand]). */
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
      <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ps-color-text)', marginBottom: 2 }}>
        Brand Performance <VisualInfoIcons title="Brand Performance" {...vh('product.pimContribution.brands')} />
      </div>
      <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginBottom: 16 }}>
        Named partner brands · selected period · sorted by volume · synced to the filters above
      </div>

      <div className="ps-brand-grid" data-testid="brand-grid">
        {found.map((b) => (
          <BrandCard key={b.requested} b={b} onClick={() => onSelectBrand(b)} />
        ))}
        {notFound.map((b) => (
          <UnassignedBrandCard key={b.requested} b={b} />
        ))}
      </div>
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
      {/* One line: the name truncates with "…" (full name on hover) so "View products" never wraps. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, minWidth: 0 }}>
        <span data-testid="brand-card-title" title={b.requested}
          style={{ fontSize: 15, fontWeight: 700, color: 'var(--ps-color-text)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {b.requested}
        </span>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--ps-color-accent)', whiteSpace: 'nowrap', flexShrink: 0 }}>View products →</span>
      </div>
      {b.companySplit.length > 1 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: -6, marginBottom: 10 }}>
          {b.companySplit.map((cs) => (
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
        </div>
      )}

      <div style={{ borderTop: '1px solid var(--ps-color-border)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <div style={{ fontSize: 30, fontWeight: 700, color: 'var(--ps-color-text)', lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
            {fmtUnits(b.volume)}
          </div>
          <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', marginTop: 4 }}>Volume (period)</div>
          <div style={{ fontSize: 12, fontWeight: 600, marginTop: 2, color: b.volumeDeltaPct === null ? 'var(--ps-color-muted-text)' : b.volumeDeltaPct >= 0 ? 'var(--ps-color-success)' : 'var(--ps-color-alert)' }}>
            {b.volumeDeltaPct === null ? 'no sales same period LY' : `${fmtPct(b.volumeDeltaPct)} vs same period LY`}
          </div>
        </div>
        {/* Secondary metrics as a 2x2 grid (not an inline row) -- at 4-per-row card widths (~230px)
            there isn't room to lay Revenue + all 4 secondary stats out side by side without either
            shrinking text past a readable size or truncating values, so the secondary group stacks
            below Revenue instead, keeping every stat's own text at full size. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
          <SecondaryStat label="Revenue (period)" value={fmtLYD(b.revenue)} />
          <SecondaryStat label="GP%" value={b.gp === null ? '—' : `${b.gp.toFixed(1)}%`} />
          <SecondaryStat label="SKUs in catalog" value={String(b.skuCount)} />
          <SecondaryStat label="SKUs sold in period" value={String(b.skuSold)} />
        </div>
      </div>
    </Card>
  );
}

/** A partner brand no product carries in Odoo yet (no product whose main vendor is one of its Odoo names). */
function UnassignedBrandCard({ b }: { b: PartnerBrand }) {
  return (
    <Card data-testid="brand-unassigned" style={{ opacity: 0.8 }}>
      <div data-testid="brand-card-title" title={b.requested}
        style={{ fontSize: 15, fontWeight: 700, color: 'var(--ps-color-text)', marginBottom: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {b.requested}
      </div>
      <div style={{ borderTop: '1px solid var(--ps-color-border)', paddingTop: 12, fontSize: 13, color: 'var(--ps-color-muted-text)' }}>
        Not currently assigned in Odoo
        <div style={{ fontSize: 11, marginTop: 6 }}>Shows here as soon as a product has {b.odooNames[0]} as its main vendor in Odoo.</div>
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
