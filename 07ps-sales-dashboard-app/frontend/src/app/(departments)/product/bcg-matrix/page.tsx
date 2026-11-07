'use client';
import { VisualInfoIcons } from '@07ps/ui';
import { vh } from '../../../../lib/visualHelp';
import React, { useMemo, useState } from 'react';
import { AppHeader } from '../../../../components/AppHeader';
import { BottomNavBar } from '../../../../components/BottomNavBar';
import { FilterBar } from '../../../../components/FilterBar';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useAuth } from '../../../../lib/AuthProvider';
import { useProductFilters } from '../../../../components/product/useProductFilters';
import { ValidationStatusBar } from '../../../../components/ValidationStatusBar';
import { RefreshFooter } from '../../../../components/RefreshFooter';
import { formatTimestamp } from '../../../../lib/format';
import {
  Card,
  KpiTile,
  DataGrid,
  DataTable,
  DonutChart,
  LoadingSkeleton,
  ErrorState,
  type DataGridColumn,
  type Column,
  type SemanticStatus,
  type DonutSegment,
} from '@07ps/ui';
import {
  toProductFacts,
  isBcgClassified,
  fmtLYD,
  fmtNum,
  fmtPct,
  fmtUnits,
  sum,
  BCG_COLOR,
  MOVEMENTS,
  MOVEMENT_COLOR,
  MOVEMENT_LABEL,
  UNCLASSIFIED_NO_COST,
  bcgThresholds,
  bcgClassDefinition,
  movementRule,
  bcgClassRule,
  type ProductFact,
} from '../../../../lib/materialsAnalogy/shared';
import type { BcgMovement } from '../../../../lib/api';
import { useProductDashboard, useRefreshStatus } from '../../../../lib/hooks';
import {
  CompanyBadge,
  ExportButtons,
  LTR,
  Pill,
  ProductName,
  ProductTooltip,
  TooltipRow,
  exportProductCsv,
  exportProductPdf,
  useHoverTooltip,
  type ExportColumn,
} from '../../../../components/product/ProductUi';

type BcgFact = ProductFact;
const getDisplayName = (r: ProductFact) => r.ProductName;
const fmtGp = (v: number | null) => (v === null ? 'no cost' : `${v.toFixed(1)}%`);

const BCG_CLASSES = ['Stars', 'Cash Cows', 'Strategic', 'Dogs'] as const;
/** How many top-by-volume products each matrix cell (Section 1) lists -- see ClassifiedBcgFact
 * below for why this stays a fixed, small number instead of the full class. */
const MATRIX_CELL_TOP_N = 10;
/** Same top-N-preview/full-list-export split as MATRIX_CELL_TOP_N, for the Product Movement
 * drill-down (Section 3) -- a bit larger since the drilled-in view is one standalone wide panel,
 * not one of 4 small 2x2 grid cells. */
const MOVEMENT_DRILL_TOP_N = 20;

// Locked icon set for BCG class, same emoji used for this classification everywhere else it's
// rendered in the Materials Analogy module (table badges, filter pills) -- not a lucide icon
// family, so these 4 cards read as "the same 4 classes" rather than 4 unrelated glyphs.
//
// Array order is Stars -> Cash Cows -> Strategic -> Dogs, which also happens to be exactly the
// order Section 1's 2x2 CSS grid (2 columns, row-major) needs to land each class in its
// established corner (Stars top-left, Cash Cows top-right, Strategic bottom-left, Dogs
// bottom-right) -- don't reorder this array without also checking that grid still lines up.
const CLASS_META: { key: (typeof BCG_CLASSES)[number]; icon: string; status: SemanticStatus }[] = [
  { key: 'Stars', icon: '⭐', status: 'success' },
  { key: 'Cash Cows', icon: '🐄', status: 'watch' },
  { key: 'Strategic', icon: '🔵', status: 'neutral' },
  { key: 'Dogs', icon: '🐕', status: 'alert' },
];

/** `facts`/`filtered` only ever contain rows with a real YTD class (see
 * backend/src/measures/productDashboard.ts's WHERE clause) -- `bcg_class_YTD` is typed nullable
 * on the shared `BcgFact` only to accommodate `discontinuedFacts` rows. Narrowing to this type
 * right after the fetch (see `facts` below) means every quadrant/matrix computation downstream can
 * keep indexing BCG_COLOR/CLASS_META etc. by `bcg_class_YTD` without a null check on every access. */
interface ClassifiedBcgFact extends BcgFact {
  bcg_class_YTD: (typeof BCG_CLASSES)[number];
}

interface TableRow extends BcgFact, Record<string, unknown> {
  id: string;
  displayName: string;
}

/** Volume growth YTD vs LYTD; no LYTD volume = "New" for a new product, "—" otherwise. */
const growthText = (r: BcgFact) => (r.quantity_growth_pct !== null ? fmtPct(r.quantity_growth_pct) : r.bcg_movement === 'New' ? 'New' : '—');
/** One export shape for every product list on this page (each class panel, the movement drill-down and the whole
 * matrix): the CSV gets raw numbers, the PDF the formatted text. Company is its own column (one company per product).
 * Volume first: the page is based on volume; revenue is secondary. */
const PRODUCT_EXPORT_COLUMNS: ExportColumn<BcgFact>[] = [
  { header: 'Product Name', value: (r) => getDisplayName(r) },
  { header: 'Company', value: (r) => r.Company },
  { header: 'Odoo ID', value: (r) => r.ProductKey },
  { header: 'Category', value: (r) => r.Category },
  { header: 'BCG Class', value: (r) => r.bcg_class_YTD, text: (r) => r.bcg_class_YTD ?? '—' },
  { header: 'Movement', value: (r) => (r.bcg_movement ? MOVEMENT_LABEL[r.bcg_movement] : null), text: (r) => (r.bcg_movement ? MOVEMENT_LABEL[r.bcg_movement] : '—') },
  { header: 'Volume YTD (Unit)', align: 'right', value: (r) => r.total_quantity_YTD, text: (r) => fmtNum(r.total_quantity_YTD) },
  { header: 'Volume LYTD (Unit)', align: 'right', value: (r) => r.total_quantity_LYTD, text: (r) => fmtNum(r.total_quantity_LYTD) },
  { header: 'Vol Growth %', align: 'right', value: (r) => r.quantity_growth_pct, text: growthText },
  { header: 'GP%', align: 'right', value: (r) => r.perc_gross_profit_YTD, text: (r) => fmtGp(r.perc_gross_profit_YTD) },
  { header: 'Revenue YTD (LYD)', align: 'right', value: (r) => r.total_value_YTD, text: (r) => fmtLYD(r.total_value_YTD) },
  { header: 'Revenue LYTD (LYD)', align: 'right', value: (r) => r.total_value_LYTD, text: (r) => fmtLYD(r.total_value_LYTD) },
  { header: 'ASP (LYD)', align: 'right', value: (r) => r.avg_unit_price_YTD, text: (r) => fmtLYD(r.avg_unit_price_YTD) },
];

function exportProducts(kind: 'csv' | 'pdf', title: string, subtitle: string, fileName: string, rows: BcgFact[]) {
  return kind === 'csv'
    ? exportProductCsv(fileName, PRODUCT_EXPORT_COLUMNS, rows)
    : exportProductPdf({ title, subtitle, fileName, columns: PRODUCT_EXPORT_COLUMNS, rows });
}

/**
 * BCG Matrix -- true 2x2 matrix build (revision 4, live data). Section 1 is now 4 bounded cells
 * (one per class, each its own small scatter of that class's top 10 products by Revenue YTD)
 * instead of one shared-plane scatter of all 1,063 products -- the full scatter was too dense to
 * read as an actual matrix. X = ASP, Y = Volume Growth % (YTD vs LYTD), bubble size = Revenue YTD
 * normalized within that cell's own 10 points, bubble color = the class's own BCG_COLOR.
 * `bcg_class_YTD` arrives precomputed from `useBcgMatrixOverview` (backend/src/measures/
 * productDashboard.ts's live product tables, refreshed by the same 3-hour/nightly ETL as every
 * other live page), not from this module's local synthetic `data.json` -- Stock Velocity/PIM
 * Contribution/Product Lifecycle are still on synthetic data, so this page is the one exception.
 */
export default function BcgMatrixPage() {
  const { user, token, error: authError, retryAuth, logout } = useAuth();
  const roleLabel = user?.role.label ?? user?.fullName;
  // The Product pages' FilterBar (useProductFilters): company, Customer Group (B2B + B2C default), channel, branch,
  // salesperson and date range from the app-wide FilterProvider. They narrow which products come back and the
  // Volume / Revenue YTD and LYTD figures; they never reclassify a product's quadrant or movement (company-wide), and
  // the date range never redefines what "YTD"/"LYTD" means -- every BCG number stays calendar YTD vs LYTD.
  const refresh = useRefreshStatus(token, authError, retryAuth);
  const { anchorDate, onAnchorDateChange, scope: bcgScope, companyLabel, filterBarProps } = useProductFilters(refresh.data);
  const overview = useProductDashboard(token, authError, retryAuth, 'bcg-matrix', bcgScope);
  const allFacts = useMemo(() => toProductFacts(overview.data), [overview.data]);
  // Narrowed to rows with a real YTD class right at the source -- see ClassifiedBcgFact's comment.
  // `discontinuedFacts` (real LYTD sales, zero YTD activity) stays a separate array: it has no
  // meaningful YTD class to plot into a quadrant, but it's still a first-class part of Product
  // Movement and the Product Detail table (see `discontinued`/`filteredDiscontinued` below).
  // Quadrant rows: one of the 4 classes and not a packaging/raw-material category. Products sold this
  // year without a standard cost are "Unclassified (no cost)" -- counted, never put in a quadrant.
  const facts = useMemo<ClassifiedBcgFact[]>(() => allFacts.filter((r) => isBcgClassified(r)) as ClassifiedBcgFact[], [allFacts]);
  // Every product with a movement (sold YTD or LYTD), class or not: a Discontinued (archived) product may still have a
  // YTD class, a Drop product that sold nothing this year has none.
  const movementRows = useMemo(() => allFacts.filter((r) => !r.bcgExcludedCategory && r.bcg_movement !== null), [allFacts]);
  const noCostRows = useMemo(() => allFacts.filter((r) => !r.bcgExcludedCategory && r.bcg_class_YTD === UNCLASSIFIED_NO_COST), [allFacts]);
  const thresholds = useMemo(() => bcgThresholds(overview.data?.thresholds), [overview.data?.thresholds]);

  // Company is now the FilterBar's own built-in dropdown (showCompanyDimension, below) instead of
  // this page's local pill toggle -- same numeric companyKeys/businessUnits dimension every other
  // full-filter-bar page already uses, which also happens to put it in exactly the requested
  // position (immediately after To Date, before Customer Group -- that's just where FilterBar's
  // own JSX already renders showCompanyDimension, no custom placement needed). fact_bcgmatrix's
  // `Company` column is a name string ('Majaal'/'Tika'), not the numeric key, so the selected
  // keys are translated via businessUnits (useProductFilters) and sent as the API's company
  // view; the rows that come back are already that company's (or every company's, side by side).
  const filtered = facts;

  // ---- KPI row + Section 1 matrix cells: one entry per BCG class, count + Volume YTD + delta vs
  // LYTD + the cell's own top-10-by-volume list. A single computation feeds both the KPI
  // card and its matching matrix cell so the two can never disagree about a class's total count. ----
  const classStats = useMemo(
    () =>
      CLASS_META.map((m) => {
        const rows = filtered.filter((r) => r.bcg_class_YTD === m.key);
        const volumeYTD = sum(rows, (r) => r.total_quantity_YTD);
        const volumeLYTD = sum(rows, (r) => r.total_quantity_LYTD);
        const valueYTD = sum(rows, (r) => r.total_value_YTD);
        const deltaPct = volumeLYTD > 0 ? ((volumeYTD - volumeLYTD) / volumeLYTD) * 100 : null;

        // Top N by volume (YTD quantity, added up as Unit) -- a direct ranked list (revision 5), not a scatter: at 10
        // points max, most cells were mostly-empty axis space with a few tiny unlabeled dots, requiring a hover just
        // to learn what anything was. `barPct` anchors each row's size indicator at 0 (bar width = volume / this
        // cell's own top-of-list volume),
        // not a min-max stretch -- min-max would make even the smallest of the top 10 read as a
        // sizeable bar, misrepresenting how much smaller it actually is than #1 in the same cell.
        // `allSorted` is the FULL class list in the same order, kept around (not just the top-10
        // slice) so this panel's PDF export can ship every product in the class, not the 10-item
        // on-screen preview (see MatrixCell's onExportPdf).
        const allSorted = byVolume(rows);
        const top = allSorted.slice(0, MATRIX_CELL_TOP_N);
        const listRows = toListRows(top);

        return { ...m, count: rows.length, volumeYTD, valueYTD, deltaPct, listRows, allSorted, moreCount: Math.max(0, rows.length - top.length) };
      }),
    [filtered],
  );

  // ---- Product Movement donut: New / Stable / Improved / Drop / Discontinued by SKU count, from the ETL's volume
  // rule (QtyYTD vs QtyLYTD, company-wide; Discontinued = archived in Odoo). Every product with a movement counts,
  // with or without a YTD class. ----
  const movementSegments: DonutSegment[] = MOVEMENTS.map((mv) => ({
    id: mv,
    label: MOVEMENT_LABEL[mv],
    value: movementRows.filter((r) => r.bcg_movement === mv).length,
    color: MOVEMENT_COLOR[mv],
  })).filter((s) => s.value > 0);

  // ---- Product Movement drill-down: clicking a slice lists that movement's products, top N by Volume YTD on screen
  // (Volume LYTD for Drop / Discontinued, where this year's volume can be 0), the full list in the CSV / PDF. ----
  const [movementDrill, setMovementDrill] = useState<BcgMovement | null>(null);
  const movementDrillData = useMemo(() => {
    if (!movementDrill) return null;
    const source = movementRows.filter((r) => r.bcg_movement === movementDrill);
    const lastYear = movementDrill === 'Drop' || movementDrill === 'Discontinued';
    const allSorted = lastYear ? [...source].sort((a, b) => b.total_quantity_LYTD - a.total_quantity_LYTD) : byVolume(source);
    const top = allSorted.slice(0, MOVEMENT_DRILL_TOP_N);
    return { listRows: toListRows(top, lastYear), allSorted, moreCount: Math.max(0, allSorted.length - top.length), lastYear };
  }, [movementDrill, movementRows]);

  const exportMovement = (kind: 'csv' | 'pdf') => {
    if (!movementDrill || !movementDrillData) return;
    const n = movementDrillData.allSorted.length;
    return exportProducts(kind, 'Product Movement', `${MOVEMENT_LABEL[movementDrill]} — ${n} product${n === 1 ? '' : 's'}`, `bcg-matrix-product-movement-${movementDrill.toLowerCase()}`, movementDrillData.allSorted);
  };

  // Whole matrix: every classified product, class by class (Stars, Cash Cows, Strategic, Dogs), highest volume first.
  const matrixRows = classStats.flatMap((s) => s.allSorted);
  const exportMatrix = (kind: 'csv' | 'pdf') =>
    exportProducts(kind, 'BCG Matrix', `All classes — ${matrixRows.length} products · ${companyLabel}`, 'bcg-matrix-all-classes', matrixRows);

  // ---- Product Detail table -- includes discontinued products now (their BCG Class column reads
  // "—", not a stale prior-year class; their Movement column reads "Discontinued" via
  // MOVEMENT_LABEL like everywhere else). DataGrid owns search, per-column sort/filter, and PDF
  // export internally -- no separate search/sort/limit state or custom exportRowsAsPdf call needed
  // here, so there's exactly one way to change what's displayed, not two that could drift out of
  // sync. ----
  const filteredNoCost = noCostRows;
  // Each product once: classified, no cost, or only a movement (sold last year, nothing this year).
  const tableFacts = [...new Map([...filtered, ...filteredNoCost, ...movementRows].map((r) => [r.id, r])).values()];
  const tableRows: TableRow[] = byVolume(tableFacts).map((r, i) => ({
    ...r,
    id: `${r.id}-${i}`,
    displayName: getDisplayName(r),
  }));

  const columns: DataGridColumn<TableRow>[] = [
    // volume first (the page is based on volume), then the product's attributes, then GP% and revenue
    { key: 'displayName', header: 'Product Name', width: 240, render: (row) => <ProductName name={row.displayName} href={row.odooUrl} />, rawValue: (row) => row.displayName },
    { key: 'total_quantity_YTD', header: 'Volume YTD', align: 'right', render: (row) => <strong>{fmtNum(row.total_quantity_YTD)}</strong>, rawValue: (row) => row.total_quantity_YTD },
    { key: 'total_quantity_LYTD', header: 'Volume LYTD', align: 'right', render: (row) => fmtNum(row.total_quantity_LYTD), rawValue: (row) => row.total_quantity_LYTD },
    {
      key: 'quantity_growth_pct',
      header: 'Vol Growth',
      align: 'right',
      // Null means no LYTD baseline to compare against (a new product), not 0% -- see
      // backend/src/measures/productDashboard.ts's header note. Sorts/exports as -Infinity so
      // "no baseline" rows fall to one end instead of masquerading as the lowest real growth.
      // A discontinued row is ALSO null here (no YTD volume to divide by either) -- that's a
      // completely different situation from "New" (nothing to compare vs. nothing left to sell),
      // so it's checked first and labeled distinctly rather than folding into the "New" branch.
      rawValue: (row) => row.quantity_growth_pct ?? Number.NEGATIVE_INFINITY,
      render: (row) =>
        row.quantity_growth_pct === null ? (
          <span title={`Volume YTD: ${fmtNum(row.total_quantity_YTD)} · No LYTD volume to compare against`} style={{ color: 'var(--ps-color-muted-text)', fontWeight: 700 }}>
            {growthText(row)}
          </span>
        ) : (
          <span title={`Volume YTD: ${fmtNum(row.total_quantity_YTD)} · Volume LYTD: ${fmtNum(row.total_quantity_LYTD)}`} style={{ color: row.quantity_growth_pct >= 0 ? 'var(--ps-color-success)' : 'var(--ps-color-alert)', fontWeight: 700 }}>
            {fmtPct(row.quantity_growth_pct)}
          </span>
        ),
    },
    { key: 'Company', header: 'Company', render: (row) => row.Company, rawValue: (row) => row.Company },
    // Category no longer has a global filter pill on this page (Section 2 simplification) -- kept
    // reachable via this column's own per-column filter instead (DataGrid supports this on every
    // column already, same as BCG Class/Movement below), so slicing by Category isn't silently
    // lost, just relocated to where the other per-product breakdowns already live.
    { key: 'Category', header: 'Category', render: (row) => <ProductName name={row.Category ?? '—'} />, rawValue: (row) => row.Category ?? '' },
    {
      key: 'bcg_class_YTD',
      header: 'BCG Class',
      render: (row) =>
        row.bcg_class_YTD ? (
          <span style={{ color: BCG_COLOR[row.bcg_class_YTD] ?? 'var(--ps-color-muted-text)', fontWeight: 700 }}>{row.bcg_class_YTD}</span>
        ) : (
          <span style={{ color: 'var(--ps-color-muted-text)' }}>—</span>
        ),
    },
    {
      key: 'bcg_movement',
      header: 'Movement',
      render: (row) => (
        <span style={{ color: row.bcg_movement ? MOVEMENT_COLOR[row.bcg_movement] : 'var(--ps-color-muted-text)', fontWeight: 700 }}>
          {row.bcg_movement ? MOVEMENT_LABEL[row.bcg_movement] : '—'}
        </span>
      ),
    },
    { key: 'perc_gross_profit_YTD', header: 'GP%', align: 'right', render: (row) => fmtGp(row.perc_gross_profit_YTD), rawValue: (row) => row.perc_gross_profit_YTD ?? Number.NEGATIVE_INFINITY },
    { key: 'total_value_YTD', header: 'Revenue YTD', align: 'right', render: (row) => fmtLYD(row.total_value_YTD), rawValue: (row) => row.total_value_YTD },
    { key: 'total_value_LYTD', header: 'Revenue LYTD', align: 'right', render: (row) => fmtLYD(row.total_value_LYTD), rawValue: (row) => row.total_value_LYTD },
    { key: 'avg_unit_price_YTD', header: 'ASP', align: 'right', render: (row) => fmtLYD(row.avg_unit_price_YTD), rawValue: (row) => row.avg_unit_price_YTD ?? Number.NEGATIVE_INFINITY },
  ];

  // ---- Row tooltip: full 7-field detail (Class, Revenue YTD, Volume YTD, ASP, GP%, Vol Growth,
  // Movement), same Class/Movement colored-pill treatment as the KPI cards and the same
  // colored-text convention the Product Detail table already uses for GP%/Vol Growth -- so the
  // tooltip reads as part of the same design system, not a separate plain-text summary. Shared by
  // all 4 matrix cells' list rows AND Section 3's movement drill-down (a Discontinued row has no
  // bcg_class_YTD at all, hence the null-guard on the Class pill below -- every other field is
  // still populated for those rows). */
  const rowTooltipContent = (r: BcgFact, label: string) => (
    <ProductTooltip
      name={label}
      company={r.Company}
      badges={
        <>
          {r.bcg_class_YTD && <Pill color={BCG_COLOR[r.bcg_class_YTD] ?? 'var(--ps-color-muted-text)'} label={r.bcg_class_YTD} />}
          {r.bcg_movement && <Pill color={MOVEMENT_COLOR[r.bcg_movement]} label={MOVEMENT_LABEL[r.bcg_movement]} />}
        </>
      }
    >
      <TooltipRow label="Volume YTD" value={fmtUnits(r.total_quantity_YTD)} />
      <TooltipRow label="Volume LYTD" value={fmtUnits(r.total_quantity_LYTD)} />
      <TooltipRow
        label="Vol Growth"
        value={growthText(r)}
        valueColor={r.quantity_growth_pct === null ? 'var(--ps-color-muted-text)' : r.quantity_growth_pct >= 0 ? 'var(--ps-color-success)' : 'var(--ps-color-alert)'}
      />
      <TooltipRow label="GP%" value={fmtGp(r.perc_gross_profit_YTD)} />
      <TooltipRow label="Revenue YTD" value={fmtLYD(r.total_value_YTD)} />
      <TooltipRow label="ASP" value={fmtLYD(r.avg_unit_price_YTD)} />
    </ProductTooltip>
  );

  return (
    <PermissionGuard pageKey="bcg_matrix">
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', paddingBottom: 64 }}>
        <AppHeader
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

        <main style={{ flex: 1, padding: 'var(--ps-space-4, 24px)', display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--ps-space-3, 16px)' }}>
            {overview.loading ? (
              CLASS_META.map((m) => <LoadingSkeleton key={m.key} variant="kpi" />)
            ) : overview.error ? (
              <ErrorState message={overview.error} onRetry={overview.retry} />
            ) : (
              // Single shared KpiTile/Card per card now (icon/accentColor/badgeLabel props) --
              // no more separate outer accent+header wrapper stacking a SECOND, independently
              // rounded Card underneath it. That double-rounding (wrapper clipping one radius,
              // KpiTile's own Card independently rounding its own top corners a few pixels below)
              // is what produced the corner-radius seam reported earlier; KpiTile itself now
              // handles the wrapper/complementary-radius trick internally (see KpiTile.tsx), so
              // this page just passes the extra props and gets one correctly-clipped card, same
              // as Stock Velocity's plain 6-card row gets when it doesn't pass them at all.
              classStats.map((s) => (
                <KpiTile
                  key={s.key}
                  label="Products"
                  value={String(s.count)}
                  variance={`${fmtUnits(s.volumeYTD)} · ${s.deltaPct === null ? 'no LYTD volume' : `${fmtPct(s.deltaPct)} vs LYTD`} · ${fmtLYD(s.valueYTD)}`}
                  status={s.status}
                  icon={s.icon}
                  accentColor={BCG_COLOR[s.key]}
                  badgeLabel={s.key}
                />
              ))
            )}
          </div>

          {/* Section 1: true 2x2 bounded matrix -- 4 independent cells (Stars top-left, Cash Cows
              top-right, Strategic bottom-left, Dogs bottom-right, per CLASS_META's own order/
              comment), each a ranked list of just that class's top 10 products by Revenue YTD
              (revision 5) -- was a per-cell scatter before this; at only up to 10 points, the
              smaller classes (Cash Cows: 3 total, Stars: 16) read as mostly-empty axis space with
              a few tiny unlabeled dots, requiring a hover just to learn what anything was. Product
              identity (name + revenue) is now directly visible on every row without hovering; the
              richer detail (Volume/ASP/GP%/Vol Growth/Movement) is still hover-only, same content
              as the old bubble tooltip (see rowTooltipContent above). */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 2 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ps-color-text)', flex: 1 }}>
                BCG Matrix <VisualInfoIcons title="BCG Matrix" {...withFormula(vh('product.bcgMatrix.matrix'), bcgClassRule(thresholds))} />
              </div>
              {!overview.loading && !overview.error && <ExportButtons label="the whole BCG matrix" onCsv={() => exportMatrix('csv')} onPdf={() => exportMatrix('pdf')} />}
            </div>
            <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginBottom: 12 }}>
              Top {MATRIX_CELL_TOP_N} products per class by Volume YTD (Unit) · bar length = volume relative to that class&apos;s own top product · hover a row for Vol Growth/GP%/Revenue/Movement · {filtered.length} products classified
              {filteredNoCost.length > 0 ? ` · ${filteredNoCost.length} sold this year are "${UNCLASSIFIED_NO_COST}": ${bcgClassDefinition(UNCLASSIFIED_NO_COST, thresholds)} (listed in Product Detail and the data-quality log)` : ''}
            </div>
            {overview.loading ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--ps-space-3, 16px)' }}>
                {CLASS_META.map((m) => <LoadingSkeleton key={m.key} variant="chart" />)}
              </div>
            ) : overview.error ? (
              <ErrorState message={overview.error} onRetry={overview.retry} />
            ) : (
              <div data-layout="2x2 on a wide screen, one column on a phone" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(max(min(100%, 420px), calc((100% - 16px) / 2)), 1fr))', gap: 'var(--ps-space-3, 16px)' }}>
                {classStats.map((s) => (
                  <MatrixCell key={s.key} classKey={s.key} icon={s.icon} definition={bcgClassDefinition(s.key, thresholds)} rows={s.listRows} allSorted={s.allSorted} moreCount={s.moreCount} tooltipContent={rowTooltipContent} />
                ))}
              </div>
            )}
          </div>

          {/* Row 2: donut (narrow) + Product Detail table (wide), same asymmetric two-panel-row
              pattern as Stock Velocity's chart+DOH-boxes row. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))', gap: 'var(--ps-space-3, 16px)' }}>
            <Card>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ps-color-text)' }}>Product Movement <VisualInfoIcons title="Product Movement" {...withFormula(vh('product.bcgMatrix.movement'), movementRule(thresholds))} /></div>
                </div>
                {movementDrill && <ExportButtons label={`${MOVEMENT_LABEL[movementDrill]} products`} onCsv={() => exportMovement('csv')} onPdf={() => exportMovement('pdf')} />}
              </div>
              <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginBottom: 12 }}>
                {movementDrill
                  ? `${MOVEMENT_LABEL[movementDrill]} SKUs, top ${MOVEMENT_DRILL_TOP_N} by Volume ${movementDrillData?.lastYear ? 'LYTD' : 'YTD'} · hover a row for full detail`
                  : 'Volume YTD vs LYTD, by SKU count · click a slice to see its products'}
              </div>
              {overview.loading ? (
                <LoadingSkeleton variant="chart" />
              ) : overview.error ? (
                <ErrorState message={overview.error} onRetry={overview.retry} />
              ) : movementDrill && movementDrillData ? (
                <>
                  <DrillBreadcrumb active={MOVEMENT_LABEL[movementDrill]} rootLabel="All Movements" onReset={() => setMovementDrill(null)} />
                  <RankedProductList rows={movementDrillData.listRows} barColor={MOVEMENT_COLOR[movementDrill]} tooltipContent={rowTooltipContent} volumeHeader={movementDrillData.lastYear ? 'Units LYTD' : 'Units YTD'} />
                  {movementDrillData.moreCount > 0 && (
                    <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginTop: 8 }}>
                      +{fmtNum(movementDrillData.moreCount)} more SKUs not shown -- export to CSV or PDF for the full list
                    </div>
                  )}
                </>
              ) : (
                <DonutChart
                  showTitle={false}
                  segments={movementSegments}
                  valueFormatter={(v) => `${v} SKU${v === 1 ? '' : 's'}`}
                  legendTitle="Number of SKUs"
                  onSegmentClick={(id) => setMovementDrill(id as BcgMovement)}
                />
              )}
            </Card>

            <Card>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ps-color-text)', marginBottom: 2 }}>Product Detail <VisualInfoIcons title="Product Detail" {...vh('product.bcgMatrix.productDetail')} /></div>
              <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginBottom: 12 }}>
                Click a column header to sort · search and per-column filter below each header
              </div>
              {overview.loading ? (
                <LoadingSkeleton variant="table" />
              ) : overview.error ? (
                <ErrorState message={overview.error} onRetry={overview.retry} />
              ) : (
                <DataGrid
                  columns={columns}
                  rows={tableRows}
                  getRowId={(row) => row.id}
                  fileName="bcg-matrix-product-detail"
                  filtersSummary={companyLabel}
                />
              )}
            </Card>
          </div>

        </main>

        <RefreshFooter
          lastUpdate={formatTimestamp(refresh.data?.lastUpdate ?? null)}
          lastOrderCreated={formatTimestamp(refresh.data?.lastOrderCreated ?? null)}
          lastRefreshTime={formatTimestamp(refresh.data?.lastRefreshTime ?? null)}
        />
        <BottomNavBar active="BCG Matrix" />
      </div>
    </PermissionGuard>
  );
}

/** One row of a ranked product list -- shared shape for both the Section 1 matrix panels (top N
 * by Revenue YTD within one class) and Section 3's movement drill-down (top N within one movement
 * category, which spans every class -- including Discontinued, whose products have no YTD class
 * at all). `fact` stays the general nullable-class `BcgFact`, not `ClassifiedBcgFact`, so this one
 * row type and its tooltip work for both. `barPct` is 0-100, anchored at that list's OWN
 * top-of-list revenue (not a global/cross-list scale -- each list is fully self-contained). */
interface MatrixListRow extends Record<string, unknown> {
  id: string;
  label: string;
  revenueYTD: number;
  /** The ranking volume: YTD, or LYTD in the Drop / Discontinued drill-down. */
  volume: number;
  barPct: number;
  fact: BcgFact;
}

/** Highest Volume YTD first (revenue breaks ties). */
function byVolume<T extends BcgFact>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.total_quantity_YTD - a.total_quantity_YTD || b.total_value_YTD - a.total_value_YTD);
}

function toListRows(rows: BcgFact[], lastYear = false): MatrixListRow[] {
  const vol = (r: BcgFact) => (lastYear ? r.total_quantity_LYTD : r.total_quantity_YTD);
  const max = Math.max(1, ...rows.map(vol));
  return rows.map((r, i) => ({
    id: `${r.id}-${i}`,
    label: getDisplayName(r),
    revenueYTD: r.total_value_YTD,
    volume: vol(r),
    barPct: (Math.max(0, vol(r)) / max) * 100,
    fact: r,
  }));
}

/** A "?" whose one formula line comes from the config thresholds (not hard-coded in the registry). */
function withFormula(entry: ReturnType<typeof vh>, formula: string): ReturnType<typeof vh> {
  return entry.help ? { ...entry, help: { ...entry.help, formula } } : entry;
}

/** Ranked product list -- shared by the Section 1 matrix panels (one class's top N by Revenue
 * YTD) and Section 3's movement drill-down (one movement category's top N, spanning every class).
 * Reuses DataTable -- the same row/hover styling (`.ps-datatable-row`) the Product Detail table
 * below already uses -- rather than inventing a fourth list pattern in this module.
 *
 * The hover detail (Volume/ASP/GP%/Vol Growth/Movement) is `position: fixed` (viewport-anchored,
 * driven by React state set on mouseenter/mouseleave), NOT a CSS `:hover`-triggered sibling inside
 * the row -- a prior pass tried the CSS-only approach and it rendered clipped/squashed by
 * DataTable's own `overflow: auto` scroll wrapper (position:absolute is clipped by the nearest
 * ancestor with non-visible overflow; position:fixed is anchored to the viewport and escapes that
 * entirely, same as ConfirmDialog's existing overlay in this package). Rendered as a sibling of
 * the table, never inside a cell, so it can never be clipped by (or shift the layout of) anything
 * in the caller's card. */
function RankedProductList({
  rows,
  barColor,
  tooltipContent,
  volumeHeader = 'Units YTD',
}: {
  rows: MatrixListRow[];
  barColor: string;
  tooltipContent: (fact: BcgFact, label: string) => React.ReactNode;
  volumeHeader?: string;
}) {
  const tip = useHoverTooltip(220, 200);
  const byId = new Map(rows.map((r) => [r.id, r]));

  const columns: Column<MatrixListRow>[] = [
    {
      key: 'label',
      header: 'Product',
      render: (row) => (
        // maxWidth: a long Odoo name (e.g. 57 characters) would otherwise set the column width and push Units / Revenue out.
        <div dir="ltr" {...tip.bind(row.id)} style={{ ...LTR, display: 'flex', alignItems: 'center', gap: 8, width: '100%', maxWidth: 'min(280px, 42vw)' }}>
          <div style={{ width: 32, height: 6, borderRadius: 3, background: 'var(--ps-color-muted-bg)', flexShrink: 0, overflow: 'hidden' }}>
            <div style={{ width: `${row.barPct}%`, height: '100%', background: barColor, borderRadius: 3 }} />
          </div>
          {/* flex: 1 + minWidth: 0 so the name uses the cell's width and ellipsis-truncates; LTR, left-aligned. */}
          <ProductName name={row.label} href={row.fact.odooUrl} style={{ flex: 1 }} />
        </div>
      ),
    },
    {
      // Volume is the sort key of the list (byVolume) and the number the bar reflects; revenue is secondary.
      key: 'volume',
      header: volumeHeader,
      align: 'right',
      render: (row) => <span style={{ fontWeight: 600 }}>{fmtNum(row.volume)}</span>,
    },
    {
      key: 'revenueYTD',
      header: 'Revenue YTD',
      align: 'right',
      render: (row) => <span style={{ color: 'var(--ps-color-muted-text)' }}>{fmtLYD(row.revenueYTD)}</span>,
    },
  ];

  return (
    <div style={{ position: 'relative' }}>
      <DataTable columns={columns} rows={rows} getRowId={(row) => row.id} />
      {tip.render((key) => {
        const row = byId.get(key);
        return row ? tooltipContent(row.fact, row.label) : null;
      })}
    </div>
  );
}

/** One bounded Section-1 matrix cell -- a class's own ranked product list (revision 5, replacing
 * the per-cell scatter: at only up to MATRIX_CELL_TOP_N points, the smaller classes' scatter was
 * mostly-empty axis space with a few tiny unlabeled dots, requiring a hover just to learn what
 * anything was) plus a header row (icon + class name in that class's own color + "+N more in this
 * class" count, using the SAME real class total classStats already computed, so this can never
 * disagree with the KPI card above it, + a full-class-list PDF export). */
function MatrixCell({
  classKey,
  icon,
  definition,
  rows,
  allSorted,
  moreCount,
  tooltipContent,
}: {
  classKey: (typeof BCG_CLASSES)[number];
  icon: string;
  /** The class rule with the config thresholds (bcgClassDefinition). */
  definition: string;
  rows: MatrixListRow[];
  /** Every product in this class, same Volume-YTD-descending order as `rows` (the top-10 preview
   * slice) -- the export button ships this full list, not the on-screen preview. */
  allSorted: ClassifiedBcgFact[];
  moreCount: number;
  tooltipContent: (fact: BcgFact, label: string) => React.ReactNode;
}) {
  const color = BCG_COLOR[classKey];

  const exportClass = (kind: 'csv' | 'pdf') =>
    exportProducts(kind, 'BCG Matrix', `${classKey} — ${allSorted.length} product${allSorted.length === 1 ? '' : 's'}`, `bcg-matrix-${classKey.toLowerCase().replace(/\s+/g, '-')}`, allSorted);

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 16, lineHeight: 1 }}>{icon}</span>
        <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color }}>{classKey}</span>
        <span style={{ flex: 1 }} />
        {moreCount > 0 && (
          <span style={{ fontSize: 11, color: 'var(--ps-color-muted-text)' }}>+{fmtNum(moreCount)} more SKUs in this class</span>
        )}
        <ExportButtons label={`${classKey} products`} onCsv={() => exportClass('csv')} onPdf={() => exportClass('pdf')} />
      </div>
      <div data-testid={`bcg-class-definition-${classKey}`} style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', margin: '-4px 0 8px' }}>
        {definition}
      </div>
      <RankedProductList rows={rows} barColor={color} tooltipContent={tooltipContent} />
    </Card>
  );
}

/** Breadcrumb back to the aggregate summary -- same "plain text when at root, clickable link +
 * chevron + current label when drilled" convention already used elsewhere in this module (see
 * Stock Velocity's own DrillBreadcrumb / PIM Contribution's Category -> Family breadcrumb) --
 * duplicated locally per that established per-page convention, not centralized in @07ps/ui. */
function DrillBreadcrumb({ active, rootLabel, onReset }: { active: string | null; rootLabel: string; onReset: () => void }) {
  return (
    <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
      {active ? (
        <>
          <button
            type="button"
            onClick={onReset}
            style={{ background: 'none', border: 'none', padding: 0, color: 'var(--ps-color-accent)', fontWeight: 600, cursor: 'pointer', fontSize: 12 }}
          >
            ← Back to summary
          </button>
          <span>›</span>
          <span style={{ color: 'var(--ps-color-text)', fontWeight: 600 }}>{active}</span>
        </>
      ) : (
        <span>{rootLabel}</span>
      )}
    </div>
  );
}
