'use client';
import React, { useMemo, useState } from 'react';
import { AppHeader } from '../../../../components/AppHeader';
import { BottomNavBar } from '../../../../components/BottomNavBar';
import { FilterBar } from '../../../../components/FilterBar';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useAuth } from '../../../../lib/AuthProvider';
import { useFilterState, useScopedFilterOptions } from '../../../../components/FilterProvider';
import {
  Card,
  KpiTile,
  DataGrid,
  DataTable,
  DonutChart,
  LoadingSkeleton,
  ErrorState,
  exportRowsAsPdf,
  PerformanceReportTable,
  exportPerformanceTablePdf,
  SEMANTIC_STATUS_LABEL,
  type DataGridColumn,
  type Column,
  type SemanticStatus,
  type DonutSegment,
  type PdfExportColumn,
  type PerformanceReportRow,
  type PerformanceTablePdfColumn,
} from '@07ps/ui';
import {
  fmtLYD,
  fmtNum,
  fmtPct,
  sum,
  getDisplayName,
  BCG_COLOR,
  MOVEMENT_COLOR,
  MOVEMENT_LABEL,
} from '../../../../lib/materialsAnalogy/shared';
import { useBcgMatrixOverview } from '../../../../lib/hooks';
import type { BcgFact } from '../../../../lib/api';
import displayNamesRaw from '../../../../lib/materialsAnalogy/cleanProductNames.json';

const displayNames = displayNamesRaw as Record<string, string>;

const BCG_CLASSES = ['Stars', 'Cash Cows', 'Strategic', 'Dogs'] as const;
const MOVEMENTS = ['New', 'Stable', 'Improved', 'Declined', 'Lost'] as const;
/** How many top-by-revenue bubbles each matrix cell (Section 1) plots -- see ClassifiedBcgFact
 * below for why this stays a fixed, small number instead of the full class. */
const MATRIX_CELL_TOP_N = 10;
/** Same top-N-preview/full-list-export split as MATRIX_CELL_TOP_N, for the Portfolio Movement
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
 * backend/src/measures/materialsAnalogyBcg.ts's WHERE clause) -- `bcg_class_YTD` is typed nullable
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

/** Shared PDF export shape -- same columns as the Product Detail table's own export (Product
 * Name, BCG Class, Movement, Revenue YTD, Revenue LYTD, Volume YTD, ASP, GP%, Vol Growth), reused
 * by the Section 1 matrix panels' full-class-list export and Section 3's movement drill-down
 * export so all 3 PDF exports on this page read as the same report format, just pre-filtered
 * differently. */
const PRODUCT_PDF_COLUMNS: PdfExportColumn[] = [
  { header: 'Product Name' },
  { header: 'BCG Class' },
  { header: 'Movement' },
  { header: 'Revenue YTD', align: 'right' },
  { header: 'Revenue LYTD', align: 'right' },
  { header: 'Volume YTD', align: 'right' },
  { header: 'ASP', align: 'right' },
  { header: 'GP%', align: 'right' },
  { header: 'Vol Growth', align: 'right' },
];

function factToPdfRow(r: BcgFact, displayName: string): string[] {
  return [
    displayName,
    r.bcg_class_YTD ?? '—',
    r.bcg_movement ? MOVEMENT_LABEL[r.bcg_movement] : '—',
    fmtLYD(r.total_value_YTD),
    fmtLYD(r.total_value_LYTD),
    fmtNum(r.total_quantity_YTD),
    fmtLYD(r.avg_unit_price_YTD),
    `${r.perc_gross_profit_YTD.toFixed(1)}%`,
    r.bcg_movement === 'Lost' ? '—' : r.quantity_growth_pct === null ? 'New' : fmtPct(r.quantity_growth_pct),
  ];
}

// ---------------------------------------------------------------------------
// Executive Summary -- no target/benchmark exists for any BCG metric (classification thresholds
// are precomputed upstream by the ETL, not exposed as a per-row target); the 4 class rows reuse
// CLASS_META's own already-established status per class (Stars=success, Cash Cows=watch,
// Strategic=neutral, Dogs=alert) rather than a variance-derived one, so this table never disagrees
// with the KPI tiles/matrix cells above for the same class. Portfolio Movement Health bands on a
// documented, tunable share of "improving" SKUs (New/Stable/Improved) vs "declining" ones
// (Declined/Lost): >= 70% healthy, >= 50% watch, below that alert.
// ---------------------------------------------------------------------------

const MOVEMENT_HEALTH_SUCCESS_PCT = 0.7;
const MOVEMENT_HEALTH_WATCH_PCT = 0.5;

interface BcgClassStat {
  key: string;
  status: SemanticStatus;
  count: number;
  valueYTD: number;
  deltaPct: number;
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

function toExecutiveSummaryRows(classStats: BcgClassStat[], movementSegments: DonutSegment[]): PerformanceReportRow[] {
  const rows: PerformanceReportRow[] = classStats.map((s) => ({
    id: `class-${s.key}`,
    metric: s.key,
    actualLabel: fmtLYD(s.valueYTD),
    targetLabel: '—',
    variancePct: null,
    varianceLyPct: s.deltaPct / 100,
    status: s.status,
    takeaway: `${s.key}: ${fmtNum(s.count)} SKUs, ${fmtLYD(s.valueYTD)} revenue YTD (${fmtPct(s.deltaPct)} vs last year).`,
  }));

  const healthyCount = movementSegments.filter((m) => m.id === 'New' || m.id === 'Stable' || m.id === 'Improved').reduce((sum, m) => sum + m.value, 0);
  const decliningCount = movementSegments.filter((m) => m.id === 'Declined' || m.id === 'Lost').reduce((sum, m) => sum + m.value, 0);
  const totalMovement = healthyCount + decliningCount;
  const healthyPct = totalMovement > 0 ? healthyCount / totalMovement : null;
  const movementStatus: SemanticStatus =
    healthyPct == null ? 'neutral' : healthyPct >= MOVEMENT_HEALTH_SUCCESS_PCT ? 'success' : healthyPct >= MOVEMENT_HEALTH_WATCH_PCT ? 'watch' : 'alert';

  rows.push({
    id: 'movementHealth',
    metric: 'Portfolio Movement Health',
    actualLabel: healthyPct != null ? fmtPct(healthyPct * 100) : '—',
    targetLabel: `> ${Math.round(MOVEMENT_HEALTH_SUCCESS_PCT * 100)}%`,
    variancePct: null,
    varianceLyPct: null,
    status: movementStatus,
    takeaway:
      healthyPct == null
        ? 'No movement data available.'
        : `${fmtPct(healthyPct * 100)} of tracked SKUs are New, Stable, or Improved rather than Declined or Lost.`,
  });

  return rows;
}

/**
 * BCG Matrix -- true 2x2 matrix build (revision 4, live data). Section 1 is now 4 bounded cells
 * (one per class, each its own small scatter of that class's top 10 products by Revenue YTD)
 * instead of one shared-plane scatter of all 1,063 products -- the full scatter was too dense to
 * read as an actual matrix. X = ASP, Y = Volume Growth % (YTD vs LYTD), bubble size = Revenue YTD
 * normalized within that cell's own 10 points, bubble color = the class's own BCG_COLOR.
 * `bcg_class_YTD` arrives precomputed from `useBcgMatrixOverview` (backend/src/measures/
 * materialsAnalogyBcg.ts's fact_bcgmatrix query, refreshed by the same 3-hour/nightly ETL as every
 * other live page), not from this module's local synthetic `data.json` -- Stock Velocity/PIM
 * Contribution/Product Lifecycle are still on synthetic data, so this page is the one exception.
 */
export default function BcgMatrixPage() {
  const { user, isSalesperson, token, error: authError, retryAuth, logout } = useAuth();
  const roleLabel = user?.role.label ?? user?.fullName;
  // Section 4: Customer Group/Distribution Channel/Branch/Salesperson + date range now come from
  // the same app-wide FilterProvider every other "full filter bar" report page already reads
  // (Tachometer, Customer Growth, Pipeline Health, ...), not page-local state -- this is what
  // "same component, same fields, same layout" actually means: the filter *state* is shared
  // app-wide too, so a Salesperson selected on another page carries over here, same as it already
  // does between any two of those other pages today. Company/Category/BCG Class stay this page's
  // own local pills below (unaffected, unchanged) -- `effectiveFilters.companyKeys` is never read.
  const { effectiveFilters, anchorDate, dateFromDate, dateToDate, onFiltersChange, onAnchorDateChange, onDateRangeChange } =
    useFilterState();
  const filterOptions = useScopedFilterOptions();

  // Confirmed with the project owner (see BcgProductScope's header in
  // backend/src/measures/materialsAnalogyBcg.ts): these 4 dimensions + the date range narrow WHICH
  // already-classified products come back (Fact_SalesLines product-set membership), they never
  // reclassify a product's quadrant against the filtered subset's own volume, and the date range
  // never redefines what "YTD"/"LYTD" means -- every number stays real calendar YTD vs LYTD.
  const bcgScope = useMemo(
    () => ({
      segmentKeys: effectiveFilters.segmentKeys,
      channelKeys: effectiveFilters.channelKeys,
      salesTeamKeys: effectiveFilters.salesTeamKeys,
      salespersonKeys: effectiveFilters.salespersonKeys,
      fromDate: dateFromDate,
      toDate: dateToDate,
    }),
    [effectiveFilters, dateFromDate, dateToDate],
  );
  const overview = useBcgMatrixOverview(token, authError, retryAuth, bcgScope);
  // Narrowed to rows with a real YTD class right at the source -- see ClassifiedBcgFact's comment.
  // `discontinuedFacts` (real LYTD sales, zero YTD activity) stays a separate array: it has no
  // meaningful YTD class to plot into a quadrant, but it's still a first-class part of Portfolio
  // Movement and the Product Detail table (see `discontinued`/`filteredDiscontinued` below).
  const facts = useMemo<ClassifiedBcgFact[]>(
    () => (overview.data?.facts ?? []).filter((r): r is ClassifiedBcgFact => r.bcg_class_YTD !== null),
    [overview.data],
  );
  const discontinued = useMemo(() => overview.data?.discontinuedFacts ?? [], [overview.data]);

  // Company is now the FilterBar's own built-in dropdown (showCompanyDimension, below) instead of
  // this page's local pill toggle -- same numeric companyKeys/businessUnits dimension every other
  // full-filter-bar page already uses, which also happens to put it in exactly the requested
  // position (immediately after To Date, before Customer Group -- that's just where FilterBar's
  // own JSX already renders showCompanyDimension, no custom placement needed). fact_bcgmatrix's
  // `Company` column is a name string ('Majaal'/'Tika'), not the numeric key, so the selected
  // keys are translated via businessUnits before filtering `facts`/`discontinued` client-side --
  // this stays a page-local display filter, same as before, not sent through to the backend scope
  // query (BcgProductScope) alongside the other 4 transaction dimensions.
  const selectedCompanyNames = useMemo(() => {
    const businessUnits = filterOptions.businessUnits.data ?? [];
    const keys = new Set((effectiveFilters.companyKeys ?? []).map(String));
    return new Set(
      businessUnits.filter((u) => keys.has(String(u.company_key))).map((u) => String(u.company_name)),
    );
  }, [filterOptions.businessUnits.data, effectiveFilters.companyKeys]);

  const filtered = useMemo(
    () => facts.filter((r) => selectedCompanyNames.size === 0 || selectedCompanyNames.has(r.Company)),
    [facts, selectedCompanyNames],
  );
  const filteredDiscontinued = useMemo(
    () => discontinued.filter((r) => selectedCompanyNames.size === 0 || selectedCompanyNames.has(r.Company)),
    [discontinued, selectedCompanyNames],
  );

  // ---- KPI row + Section 1 matrix cells: one entry per BCG class, count + Revenue YTD + delta vs
  // LYTD + the cell's own top-10-by-revenue bubble points. A single computation feeds both the KPI
  // card and its matching matrix cell so the two can never disagree about a class's total count. ----
  const classStats = useMemo(
    () =>
      CLASS_META.map((m) => {
        const rows = filtered.filter((r) => r.bcg_class_YTD === m.key);
        const valueYTD = sum(rows, (r) => r.total_value_YTD);
        const valueLYTD = sum(rows, (r) => r.total_value_LYTD);
        const deltaPct = valueLYTD > 0 ? ((valueYTD - valueLYTD) / valueLYTD) * 100 : 0;

        // Top N by revenue -- a direct ranked list now (revision 5), not a scatter: at 10 points
        // max, most cells (all but Strategic/Dogs) were mostly-empty axis space with a few tiny
        // unlabeled dots, requiring a hover just to learn what anything was. `barPct` anchors each
        // row's size indicator at 0 (bar width = revenue / this cell's own top-of-list revenue),
        // not a min-max stretch -- min-max would make even the smallest of the top 10 read as a
        // sizeable bar, misrepresenting how much smaller it actually is than #1 in the same cell.
        // `allSorted` is the FULL class list in the same order, kept around (not just the top-10
        // slice) so this panel's PDF export can ship every product in the class, not the 10-item
        // on-screen preview (see MatrixCell's onExportPdf).
        const allSorted = [...rows].sort((a, b) => b.total_value_YTD - a.total_value_YTD);
        const top = allSorted.slice(0, MATRIX_CELL_TOP_N);
        const maxRev = Math.max(1, ...top.map((r) => r.total_value_YTD));
        const listRows: MatrixListRow[] = top.map((r, i) => ({
          id: `${r.ProductKey}-${i}`,
          label: getDisplayName(displayNames, r),
          revenueYTD: r.total_value_YTD,
          volumeYTD: r.total_quantity_YTD,
          barPct: (r.total_value_YTD / maxRev) * 100,
          fact: r,
        }));

        return { ...m, count: rows.length, valueYTD, deltaPct, listRows, allSorted, moreCount: Math.max(0, rows.length - top.length) };
      }),
    [filtered],
  );

  // ---- Portfolio Movement donut -- 5 categories now (New/Stable/Improved/Drop/Discontinued, see
  // MOVEMENT_LABEL for the Drop/Discontinued rename). Every `filtered` row's own bcg_movement
  // covers the first 4; the 5th (Discontinued) comes from filteredDiscontinued's *count*, not from
  // filtering `filtered` for movement 'Lost' -- discontinued rows were never in `filtered` to begin
  // with (they have no YTD class), so that filter would always read 0 otherwise. ----
  const movementSegments: DonutSegment[] = MOVEMENTS.map((mv) => ({
    id: mv,
    label: MOVEMENT_LABEL[mv],
    value: mv === 'Lost' ? filteredDiscontinued.length : filtered.filter((r) => r.bcg_movement === mv).length,
    color: MOVEMENT_COLOR[mv],
  })).filter((s) => s.value > 0);

  // ---- Portfolio Movement drill-down (Section 3): clicking a slice shows that movement
  // category's own ranked product list -- same top-N-on-screen/full-list-in-PDF-export pattern as
  // the Section 1 matrix panels, same RankedProductList component. 'Lost' (Discontinued) draws
  // from `filteredDiscontinued` directly, not from filtering `filtered` for movement==='Lost' --
  // discontinued rows were never in `filtered` to begin with (see movementSegments' own comment
  // above), so that filter would always return 0 rows for this drill-down too. This is exactly the
  // data-scope question flagged earlier: confirmed live below (filteredDiscontinued has real rows
  // whenever the dataset has discontinued products, which it does -- see the earlier investigation
  // that found 385 of them via bcg_movement='Lost'). ----
  const [movementDrill, setMovementDrill] = useState<(typeof MOVEMENTS)[number] | null>(null);
  const movementDrillData = useMemo(() => {
    if (!movementDrill) return null;
    const source = movementDrill === 'Lost' ? filteredDiscontinued : filtered.filter((r) => r.bcg_movement === movementDrill);
    const allSorted = [...source].sort((a, b) => b.total_value_YTD - a.total_value_YTD);
    const top = allSorted.slice(0, MOVEMENT_DRILL_TOP_N);
    const maxRev = Math.max(1, ...top.map((r) => r.total_value_YTD));
    const listRows: MatrixListRow[] = top.map((r, i) => ({
      id: `${r.ProductKey}-${i}`,
      label: getDisplayName(displayNames, r),
      revenueYTD: r.total_value_YTD,
      volumeYTD: r.total_quantity_YTD,
      barPct: (r.total_value_YTD / maxRev) * 100,
      fact: r,
    }));
    return { listRows, allSorted, moreCount: Math.max(0, allSorted.length - top.length) };
  }, [movementDrill, filtered, filteredDiscontinued]);

  const handleExportMovementPdf = () => {
    if (!movementDrill || !movementDrillData) return;
    exportRowsAsPdf({
      title: 'Portfolio Movement',
      subtitle: `${MOVEMENT_LABEL[movementDrill]} — ${movementDrillData.allSorted.length} product${movementDrillData.allSorted.length === 1 ? '' : 's'}`,
      columns: PRODUCT_PDF_COLUMNS,
      rows: movementDrillData.allSorted.map((r) => factToPdfRow(r, getDisplayName(displayNames, r))),
      fileName: `bcg-matrix-movement-${movementDrill.toLowerCase()}`,
    });
  };

  // ---- Product Detail table -- includes discontinued products now (their BCG Class column reads
  // "—", not a stale prior-year class; their Movement column reads "Discontinued" via
  // MOVEMENT_LABEL like everywhere else). DataGrid owns search, per-column sort/filter, and PDF
  // export internally -- no separate search/sort/limit state or custom exportRowsAsPdf call needed
  // here, so there's exactly one way to change what's displayed, not two that could drift out of
  // sync. ----
  const tableRows: TableRow[] = [...filtered, ...filteredDiscontinued].map((r, i) => ({
    ...r,
    id: `${r.ProductKey}-${i}`,
    displayName: getDisplayName(displayNames, r),
  }));

  const columns: DataGridColumn<TableRow>[] = [
    { key: 'displayName', header: 'Product Name', width: 220, render: (row) => <span title={row.ProductName}>{row.displayName}</span> },
    // Category no longer has a global filter pill on this page (Section 2 simplification) -- kept
    // reachable via this column's own per-column filter instead (DataGrid supports this on every
    // column already, same as BCG Class/Movement below), so slicing by Category isn't silently
    // lost, just relocated to where the other per-product breakdowns already live.
    { key: 'Category', header: 'Category', render: (row) => row.Category ?? '—' },
    {
      key: 'bcg_class_YTD',
      header: 'BCG Class',
      render: (row) =>
        row.bcg_class_YTD ? (
          <span style={{ color: BCG_COLOR[row.bcg_class_YTD], fontWeight: 700 }}>{row.bcg_class_YTD}</span>
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
    { key: 'total_value_YTD', header: 'Revenue YTD', align: 'right', render: (row) => fmtLYD(row.total_value_YTD), rawValue: (row) => row.total_value_YTD },
    { key: 'total_value_LYTD', header: 'Revenue LYTD', align: 'right', render: (row) => fmtLYD(row.total_value_LYTD), rawValue: (row) => row.total_value_LYTD },
    { key: 'total_quantity_YTD', header: 'Volume YTD', align: 'right', render: (row) => fmtNum(row.total_quantity_YTD), rawValue: (row) => row.total_quantity_YTD },
    { key: 'avg_unit_price_YTD', header: 'ASP', align: 'right', render: (row) => fmtLYD(row.avg_unit_price_YTD), rawValue: (row) => row.avg_unit_price_YTD },
    { key: 'perc_gross_profit_YTD', header: 'GP%', align: 'right', render: (row) => `${row.perc_gross_profit_YTD.toFixed(1)}%`, rawValue: (row) => row.perc_gross_profit_YTD },
    {
      key: 'quantity_growth_pct',
      header: 'Vol Growth',
      align: 'right',
      // Null means no LYTD baseline to compare against (a new product), not 0% -- see
      // backend/src/measures/materialsAnalogyBcg.ts's header note. Sorts/exports as -Infinity so
      // "no baseline" rows fall to one end instead of masquerading as the lowest real growth.
      // A discontinued row is ALSO null here (no YTD volume to divide by either) -- that's a
      // completely different situation from "New" (nothing to compare vs. nothing left to sell),
      // so it's checked first and labeled distinctly rather than folding into the "New" branch.
      rawValue: (row) => row.quantity_growth_pct ?? Number.NEGATIVE_INFINITY,
      render: (row) =>
        row.bcg_movement === 'Lost' ? (
          <span title="Discontinued -- no YTD volume to compare against" style={{ color: 'var(--ps-color-muted-text)' }}>—</span>
        ) : row.quantity_growth_pct === null ? (
          <span title={`Volume YTD: ${fmtNum(row.total_quantity_YTD)} · No LYTD volume to compare against`} style={{ color: 'var(--ps-color-muted-text)', fontWeight: 700 }}>
            New
          </span>
        ) : (
          <span title={`Volume YTD: ${fmtNum(row.total_quantity_YTD)} · Volume LYTD: ${fmtNum(row.total_quantity_LYTD)}`} style={{ color: row.quantity_growth_pct >= 0 ? 'var(--ps-color-success)' : 'var(--ps-color-alert)', fontWeight: 700 }}>
            {fmtPct(row.quantity_growth_pct)}
          </span>
        ),
    },
  ];

  // ---- Row tooltip: full 7-field detail (Class, Revenue YTD, Volume YTD, ASP, GP%, Vol Growth,
  // Movement), same Class/Movement colored-pill treatment as the KPI cards and the same
  // colored-text convention the Product Detail table already uses for GP%/Vol Growth -- so the
  // tooltip reads as part of the same design system, not a separate plain-text summary. Shared by
  // all 4 matrix cells' list rows AND Section 3's movement drill-down (a Discontinued row has no
  // bcg_class_YTD at all, hence the null-guard on the Class pill below -- every other field is
  // still populated for those rows). */
  const rowTooltipContent = (r: BcgFact, label: string) => (
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
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        {r.bcg_class_YTD && <Pill color={BCG_COLOR[r.bcg_class_YTD]} label={r.bcg_class_YTD} />}
        {r.bcg_movement && <Pill color={MOVEMENT_COLOR[r.bcg_movement]} label={MOVEMENT_LABEL[r.bcg_movement]} />}
      </div>
      <TooltipRow label="Revenue YTD" value={fmtLYD(r.total_value_YTD)} />
      <TooltipRow label="Volume YTD" value={fmtNum(r.total_quantity_YTD)} />
      <TooltipRow label="ASP" value={fmtLYD(r.avg_unit_price_YTD)} />
      <TooltipRow label="GP%" value={`${r.perc_gross_profit_YTD.toFixed(1)}%`} />
      <TooltipRow
        label="Vol Growth"
        value={r.quantity_growth_pct === null ? 'New' : fmtPct(r.quantity_growth_pct)}
        valueColor={r.quantity_growth_pct === null ? 'var(--ps-color-muted-text)' : r.quantity_growth_pct >= 0 ? 'var(--ps-color-success)' : 'var(--ps-color-alert)'}
      />
    </div>
  );

  const performanceRows = toExecutiveSummaryRows(classStats, movementSegments);
  async function handleExportPerformanceTablePdf() {
    try {
      await exportPerformanceTablePdf({
        title: 'Performance Details',
        rows: performanceRows,
        columns: PERFORMANCE_PDF_COLUMNS,
        fileName: 'bcg-matrix-performance-details',
      });
    } catch (err) {
      console.error('PDF export failed:', err);
    }
  }

  return (
    <PermissionGuard pageKey="bcg_matrix">
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
          filters={effectiveFilters}
          onChange={onFiltersChange}
          dateFromDate={dateFromDate}
          dateToDate={dateToDate}
          onDateRangeChange={onDateRangeChange}
          businessUnits={filterOptions.businessUnits.data ?? []}
          customerGroups={filterOptions.customerGroups.data ?? []}
          distributionChannels={filterOptions.distributionChannels.data ?? []}
          branches={filterOptions.branches.data ?? []}
          salespersons={filterOptions.salespersons.data ?? []}
          isSalesperson={isSalesperson}
          showDateRange
          showCompanyDimension
          showTransactionDimensions
          showLastOrderInfo={false}
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
                  variance={`${fmtLYD(s.valueYTD)} · ${fmtPct(s.deltaPct)} vs LYTD`}
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
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ps-color-text)', marginBottom: 2 }}>BCG Matrix</div>
            <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginBottom: 12 }}>
              Top {MATRIX_CELL_TOP_N} products per class by Revenue YTD · bar length = revenue relative to that class's own top product · hover a row for Volume/ASP/GP%/Vol Growth/Movement · {filtered.length} products classified
            </div>
            {overview.loading ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--ps-space-3, 16px)' }}>
                {CLASS_META.map((m) => <LoadingSkeleton key={m.key} variant="chart" />)}
              </div>
            ) : overview.error ? (
              <ErrorState message={overview.error} onRetry={overview.retry} />
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--ps-space-3, 16px)' }}>
                {classStats.map((s) => (
                  <MatrixCell key={s.key} classKey={s.key} icon={s.icon} rows={s.listRows} allSorted={s.allSorted} moreCount={s.moreCount} tooltipContent={rowTooltipContent} />
                ))}
              </div>
            )}
          </div>

          {/* Row 2: donut (narrow) + Product Detail table (wide), same asymmetric two-panel-row
              pattern as Stock Velocity's chart+DOH-boxes row. */}
          <div style={{ display: 'grid', gridTemplateColumns: '4fr 8fr', gap: 'var(--ps-space-3, 16px)' }}>
            <Card>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ps-color-text)' }}>Portfolio Movement</div>
                </div>
                {movementDrill && <PdfButton label="Export as PDF" onClick={handleExportMovementPdf} />}
              </div>
              <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginBottom: 12 }}>
                {movementDrill
                  ? `${MOVEMENT_LABEL[movementDrill]} SKUs, top ${MOVEMENT_DRILL_TOP_N} by Revenue YTD · hover a row for full detail`
                  : 'YTD vs LYTD classification change, by SKU count · click a slice to see its products'}
              </div>
              {overview.loading ? (
                <LoadingSkeleton variant="chart" />
              ) : overview.error ? (
                <ErrorState message={overview.error} onRetry={overview.retry} />
              ) : movementDrill && movementDrillData ? (
                <>
                  <DrillBreadcrumb active={MOVEMENT_LABEL[movementDrill]} rootLabel="All Movements" onReset={() => setMovementDrill(null)} />
                  <RankedProductList rows={movementDrillData.listRows} barColor={MOVEMENT_COLOR[movementDrill]} tooltipContent={rowTooltipContent} />
                  {movementDrillData.moreCount > 0 && (
                    <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginTop: 8 }}>
                      +{fmtNum(movementDrillData.moreCount)} more SKUs not shown -- use Export as PDF for the full list
                    </div>
                  )}
                </>
              ) : (
                <DonutChart
                  showTitle={false}
                  segments={movementSegments}
                  valueFormatter={(v) => `${v} SKU${v === 1 ? '' : 's'}`}
                  legendTitle="Number of SKUs"
                  onSegmentClick={(id) => setMovementDrill(id as (typeof MOVEMENTS)[number])}
                />
              )}
            </Card>

            <Card>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ps-color-text)', marginBottom: 2 }}>Product Detail</div>
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
                  filtersSummary={selectedCompanyNames.size ? [...selectedCompanyNames].join(', ') : 'All companies'}
                />
              )}
            </Card>
          </div>

          {/* Outside the donut/Product Detail grid above so it spans the full page width rather
              than wrapping into that grid's narrow 4fr column. */}
          {!overview.loading && !overview.error && (
            <PerformanceReportTable title="Performance Details" rows={performanceRows} showStatus showTakeaway onExportPdf={handleExportPerformanceTablePdf} />
          )}
        </main>

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
  volumeYTD: number;
  barPct: number;
  fact: BcgFact;
}

/** Hover state for a matrix cell's floating tooltip -- viewport coordinates (from
 * getBoundingClientRect on mouseenter), not anything relative to the row's own DOM position. See
 * MatrixCell's header comment for why this replaced a CSS-only :hover reveal. */
interface HoveredRow {
  row: MatrixListRow;
  left: number;
  /** Exactly one of top/bottom is set -- bottom (anchored to the row's top edge, tooltip growing
   * upward) when there isn't enough room below the row in the viewport, top otherwise. Mirrors the
   * flip-to-avoid-viewport-edge behavior a real tooltip library would give for free. */
  top?: number;
  bottom?: number;
}

const TOOLTIP_ESTIMATED_HEIGHT = 190;
const TOOLTIP_WIDTH = 200;

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
}: {
  rows: MatrixListRow[];
  barColor: string;
  tooltipContent: (fact: BcgFact, label: string) => React.ReactNode;
}) {
  const [hovered, setHovered] = useState<HoveredRow | null>(null);

  const handleEnter = (row: MatrixListRow) => (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const left = Math.min(rect.left, window.innerWidth - TOOLTIP_WIDTH - 8);
    const fitsBelow = rect.bottom + TOOLTIP_ESTIMATED_HEIGHT <= window.innerHeight;
    setHovered({
      row,
      left,
      ...(fitsBelow ? { top: rect.bottom + 6 } : { bottom: window.innerHeight - rect.top + 6 }),
    });
  };
  const handleLeave = () => setHovered(null);

  const columns: Column<MatrixListRow>[] = [
    {
      key: 'label',
      header: 'Product',
      render: (row) => (
        <div onMouseEnter={handleEnter(row)} onMouseLeave={handleLeave} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
          <div style={{ width: 32, height: 6, borderRadius: 3, background: 'var(--ps-color-muted-bg)', flexShrink: 0, overflow: 'hidden' }}>
            <div style={{ width: `${row.barPct}%`, height: '100%', background: barColor, borderRadius: 3 }} />
          </div>
          {/* `flex: 1` + `minWidth: 0` (not a fixed maxWidth) -- the <td> itself already stretches
              to fill whatever width the Volume YTD/Revenue YTD columns don't need (standard auto
              table layout), so a hardcoded maxWidth here was leaving that stretched space empty
              instead of letting the name use it, truncating well before the row's actual right
              edge. Every panel gets its own natural width this way (varies with how wide that
              panel's numbers are), rather than one fixed width forced across all of them.
              `minWidth: 0` is required on a flex child for text-overflow:ellipsis to engage at all
              -- without it a flex item won't shrink below its content's intrinsic width. */}
          <span
            title={row.fact.ProductName}
            style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {row.label}
          </span>
        </div>
      ),
    },
    {
      key: 'volumeYTD',
      header: 'Volume YTD',
      align: 'right',
      render: (row) => <span>{fmtNum(row.volumeYTD)}</span>,
    },
    {
      // Revenue YTD stays the sort key for the whole list (see classStats/movementDrillData's own
      // `.sort((a, b) => b.total_value_YTD - a.total_value_YTD)`) regardless of where it sits in
      // the column order -- rightmost here since it's the number the bar indicator itself reflects.
      key: 'revenueYTD',
      header: 'Revenue YTD',
      align: 'right',
      render: (row) => <span style={{ fontWeight: 600 }}>{fmtLYD(row.revenueYTD)}</span>,
    },
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
            width: TOOLTIP_WIDTH,
            zIndex: 1000,
            pointerEvents: 'none',
          }}
        >
          {tooltipContent(hovered.row.fact, hovered.row.label)}
        </div>
      )}
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
  rows,
  allSorted,
  moreCount,
  tooltipContent,
}: {
  classKey: (typeof BCG_CLASSES)[number];
  icon: string;
  rows: MatrixListRow[];
  /** Every product in this class, same Revenue-YTD-descending order as `rows` (the top-10 preview
   * slice) -- the export button ships this full list, not the on-screen preview. */
  allSorted: ClassifiedBcgFact[];
  moreCount: number;
  tooltipContent: (fact: BcgFact, label: string) => React.ReactNode;
}) {
  const color = BCG_COLOR[classKey];

  const handleExportPdf = () => {
    exportRowsAsPdf({
      title: 'BCG Matrix',
      subtitle: `${classKey} — ${allSorted.length} product${allSorted.length === 1 ? '' : 's'}`,
      columns: PRODUCT_PDF_COLUMNS,
      rows: allSorted.map((r) => factToPdfRow(r, getDisplayName(displayNames, r))),
      fileName: `bcg-matrix-${classKey.toLowerCase().replace(/\s+/g, '-')}`,
    });
  };

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 16, lineHeight: 1 }}>{icon}</span>
        <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color }}>{classKey}</span>
        <span style={{ flex: 1 }} />
        {moreCount > 0 && (
          <span style={{ fontSize: 11, color: 'var(--ps-color-muted-text)' }}>+{fmtNum(moreCount)} more SKUs in this class</span>
        )}
        <PdfButton label="Export as PDF" onClick={handleExportPdf} />
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

/** Same bordered-pill "Export as PDF" convention every other report page's ChartPanel
 * headerActions uses (see stock-velocity/page.tsx's own PdfButton) -- duplicated locally per that
 * same established per-page convention, not centralized in @07ps/ui. */
function PdfButton({ label, onClick }: { label: string; onClick: () => void }) {
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

/** Colored pill -- same treatment for BCG Class/Movement wherever they appear (matrix cell header
 * above, bubble chart tooltip) so they read as the same design system, not a plain text list. */
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

/** Label/value row for the bubble chart tooltip -- same right-aligned value convention the
 * Product Detail table already uses for these fields. */
function TooltipRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, lineHeight: 1.7 }}>
      <span style={{ color: 'var(--ps-color-muted-text)' }}>{label}</span>
      <span style={{ fontWeight: 600, color: valueColor ?? 'var(--ps-color-text)' }}>{value}</span>
    </div>
  );
}

