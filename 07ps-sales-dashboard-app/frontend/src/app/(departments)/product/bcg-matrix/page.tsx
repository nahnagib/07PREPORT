'use client';
import { VisualInfoIcons } from '@07ps/ui';
import { vh } from '../../../../lib/visualHelp';
import React, { useMemo, useState } from 'react';
import styles from './page.module.css';
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
  BCG_CLASSES,
  BCG_COLOR,
  BCG_RECOMMENDATION,
  MOVEMENTS,
  MOVEMENT_COLOR,
  MOVEMENT_LABEL,
  bcgThresholds,
  bcgClassDefinition,
  movementRule,
  bcgClassRule,
  type BcgClass,
  type BcgThresholds,
  type ProductFact,
} from '../../../../lib/materialsAnalogy/shared';
import { bcgClassName } from '../../../../components/product/InventoryVisual';
import { Last12MonthsNote } from '../../../../components/product/Last12MonthsNote';
import type { BcgMovement, ProductStatusSummary } from '../../../../lib/api';
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
const fmtGp = (v: number | null) => (v === null ? '–' : `${v.toFixed(1)}%`);
const fmtCount = (v: number) => v.toLocaleString('en-US');
const NOT_CLASSIFIED = 'Not classified';
const classLabel = (r: ProductFact) => bcgClassName(r.bcg_class);
/** Active = sold in the last 12 months (ETL ProductStatus); before migration 0073 a product with a class counts as Active. */
const isActiveFact = (r: ProductFact) => (r.productStatus === null ? r.bcg_class !== null : r.productStatus === 'Active');
const STATUS_LABEL: Record<'Active' | 'NonActive' | 'Dormant' | 'Unclassified', string> = {
  Active: 'Active',
  NonActive: 'Non Active',
  Dormant: 'Dormant',
  Unclassified: 'Unclassified',
};
const statusLabel = (r: ProductFact) => (r.productStatus ? STATUS_LABEL[r.productStatus] : '—');
/** Profit of the class's data; "–" when the database has none (never zero-filled). */
const fmtProfit = (v: number | null) => (v === null ? '–' : fmtLYD(v));
/** The class volume: the units of the data the class is computed on. */
const classVolume = (r: BcgFact) => r.bcgVolume ?? 0;

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
const CLASS_META: Record<BcgClass, { icon: string; status: SemanticStatus }> = {
  Stars: { icon: '⭐', status: 'success' },
  'Cash Cows': { icon: '🐄', status: 'watch' },
  Strategic: { icon: '🔵', status: 'neutral' },
  Dogs: { icon: '🐕', status: 'alert' },
};

const CLASS_FILTER_OPTIONS = [...BCG_CLASSES, NOT_CLASSIFIED].map((label) => ({ value: label, label }));
const classOrder = (row: BcgFact) => {
  const index = BCG_CLASSES.indexOf(row.bcg_class as BcgClass);
  return index < 0 || row.bcgProfit === null ? BCG_CLASSES.length : index;
};

interface TableRow extends BcgFact, Record<string, unknown> {
  id: string;
  displayName: string;
}

/** Volume growth, last 12 months vs the 12 months before; none before = "New" for a new product, "—" otherwise. */
const growthText = (r: BcgFact) => (r.quantity_growth_pct !== null ? fmtPct(r.quantity_growth_pct) : r.bcg_movement === 'New' ? 'New' : '—');
/** One export shape for every product list on this page (each class panel, the movement drill-down and the whole
 * matrix): the CSV gets raw numbers, the PDF the formatted text. Company is its own column (one company per product).
 * Volume first: the page is based on volume; revenue is secondary. */
const PRODUCT_EXPORT_COLUMNS: ExportColumn<BcgFact>[] = [
  { header: 'Product Name', value: (r) => getDisplayName(r) },
  { header: 'Company', value: (r) => r.Company },
  { header: 'Odoo ID', value: (r) => r.ProductKey },
  { header: 'Category', value: (r) => r.Category },
  { header: 'Status', value: statusLabel },
  { header: 'BCG Class', value: classLabel },
  { header: 'Volume (profit data, Unit)', align: 'right', value: (r) => r.bcgVolume, text: (r) => (r.bcgVolume === null ? '–' : fmtNum(r.bcgVolume)) },
  { header: 'Profit (LYD)', align: 'right', value: (r) => r.bcgProfit ?? '–', text: (r) => fmtProfit(r.bcgProfit) },
  { header: 'GP% (profit data)', align: 'right', value: (r) => r.bcgGrossProfitPct, text: (r) => fmtGp(r.bcgGrossProfitPct) },
  { header: 'Profit data period', value: (r) => r.bcgDataPeriod, text: (r) => r.bcgDataPeriod ?? '–' },
  { header: 'Profit data as of', value: (r) => r.bcgDataAsOf, text: (r) => r.bcgDataAsOf ?? '–' },
  { header: 'Movement', value: (r) => (r.bcg_movement ? MOVEMENT_LABEL[r.bcg_movement] : null), text: (r) => (r.bcg_movement ? MOVEMENT_LABEL[r.bcg_movement] : '—') },
  { header: 'Volume Last 12 Months (Unit)', align: 'right', value: (r) => r.total_quantity_L12M, text: (r) => fmtNum(r.total_quantity_L12M) },
  { header: 'Volume Prior 12 Months (Unit)', align: 'right', value: (r) => r.total_quantity_P12M, text: (r) => fmtNum(r.total_quantity_P12M) },
  { header: 'Vol Growth %', align: 'right', value: (r) => r.quantity_growth_pct, text: growthText },
  { header: 'Quantity On Hand (Units)', align: 'right', value: (r) => r.onHandQty, text: (r) => fmtNum(r.onHandQty) },
  { header: 'GP%', align: 'right', value: (r) => r.perc_gross_profit_L12M, text: (r) => fmtGp(r.perc_gross_profit_L12M) },
  { header: 'Revenue Last 12 Months (LYD)', align: 'right', value: (r) => r.total_value_L12M, text: (r) => fmtLYD(r.total_value_L12M) },
  { header: 'Revenue Prior 12 Months (LYD)', align: 'right', value: (r) => r.total_value_P12M, text: (r) => fmtLYD(r.total_value_P12M) },
  { header: 'ASP (LYD)', align: 'right', value: (r) => r.avg_unit_price_L12M, text: (r) => fmtLYD(r.avg_unit_price_L12M) },
];

function exportProducts(kind: 'csv' | 'pdf', title: string, subtitle: string, fileName: string, rows: BcgFact[], thresholds: BcgThresholds) {
  const columns = [...PRODUCT_EXPORT_COLUMNS, {
    header: 'BCG Class Rule',
    value: (row: BcgFact) => bcgClassDefinition(row.bcg_class ?? '', thresholds),
  }];
  return kind === 'csv'
    ? exportProductCsv(fileName, columns, rows)
    : exportProductPdf({ title, subtitle, fileName, columns, rows });
}

export default function BcgMatrixPage() {
  const { user, token, error: authError, retryAuth, logout } = useAuth();
  const roleLabel = user?.role.label ?? user?.fullName;
  // The Product pages' FilterBar (useProductFilters): company, Customer Group (B2B + B2C default), channel, branch,
  // salesperson from the app-wide FilterProvider (no date range: always the last 12 months, 2026-11-14). They narrow
  // which products come back and their Volume / Revenue figures; they never reclassify a product's quadrant, movement
  // or status (company-wide). The 3 card rows are the company view's whole catalog (statusSummary), never filtered.
  const refresh = useRefreshStatus(token, authError, retryAuth);
  const { anchorDate, onAnchorDateChange, scope: bcgScope, companyLabel, filterBarProps } = useProductFilters(refresh.data);
  const overview = useProductDashboard(token, authError, retryAuth, 'bcg-matrix', bcgScope);
  const allFacts = useMemo(() => toProductFacts(overview.data), [overview.data]);
  const eligible = useMemo(() => allFacts.filter((r) => !r.bcgExcludedCategory), [allFacts]);
  // BCG runs on Active products only (sold in the last 12 months).
  const activeFacts = useMemo(() => eligible.filter(isActiveFact), [eligible]);
  const classified = useMemo(() => activeFacts.filter((r) => isBcgClassified(r) && r.bcgProfit !== null), [activeFacts]);
  const summary = overview.data?.statusSummary ?? null;
  // the Not classified card's count (it also counts Active products kept off the pages by ProductExclusions.xlsx Products)
  const unclassifiedCount = summary?.bcg.notClassified ?? activeFacts.length - classified.length;
  const movementRows = useMemo(() => eligible.filter((r) => r.bcg_movement !== null), [eligible]);
  const thresholds = useMemo(() => bcgThresholds(overview.data?.thresholds), [overview.data?.thresholds]);

  // Company is now the FilterBar's own built-in dropdown (showCompanyDimension, below) instead of
  // this page's local pill toggle -- same numeric companyKeys/businessUnits dimension every other
  // full-filter-bar page already uses, which also happens to put it in exactly the requested
  // position (immediately after To Date, before Customer Group -- that's just where FilterBar's
  // own JSX already renders showCompanyDimension, no custom placement needed). fact_bcgmatrix's
  // `Company` column is a name string ('Majaal'/'Tika'), not the numeric key, so the selected
  // keys are translated via businessUnits (useProductFilters) and sent as the API's company
  // view; the rows that come back are already that company's (or every company's, side by side).
  const profitData = useMemo(() => {
    const used = activeFacts.filter((r) => r.bcgDataAsOf);
    const partial = used.filter((r) => r.bcgDataPeriod?.endsWith('(costed sales)')).length;
    const latest = used.map((r) => r.bcgDataAsOf as string).sort().at(-1) ?? null;
    return { latest, partial };
  }, [activeFacts]);
  // ---- Section 1 matrix cells: one entry per BCG class, count + volume + the cell's own top-10-by-volume list. The
  // Row 3 KPI cards read the API's statusSummary (the same classes, checked against the Active count). ----
  const classStats = useMemo(
    () =>
      BCG_CLASSES.map((key) => {
        const rows = classified.filter((r) => r.bcg_class === key);
        const volume = sum(rows, classVolume);
        const profit = sum(rows, (r) => r.bcgProfit ?? 0);

        // Top N by volume (last-12-months quantity, added up as Unit) -- a direct ranked list (revision 5), not a scatter: at 10
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

        return { key, ...CLASS_META[key], count: rows.length, volume, profit, listRows, allSorted, moreCount: rows.length - top.length };
      }),
    [classified],
  );

  // ---- Product Movement donut: New / Stable / Improved / Drop / Discontinued by SKU count, from the ETL's volume
  // rule (last 12 months vs the 12 months before, company-wide; Discontinued = archived in Odoo). Every product with a
  // movement counts, with or without a class. ----
  const movementSegments: DonutSegment[] = MOVEMENTS.map((mv) => ({
    id: mv,
    label: MOVEMENT_LABEL[mv],
    value: movementRows.filter((r) => r.bcg_movement === mv).length,
    color: MOVEMENT_COLOR[mv],
  })).filter((s) => s.value > 0);

  // ---- Product Movement drill-down: clicking a slice lists that movement's products, top N by last-12-months volume
  // on screen (the prior 12 months for Drop / Discontinued, where the last 12 can be 0), the full list in CSV / PDF. ----
  const [movementDrill, setMovementDrill] = useState<BcgMovement | null>(null);
  const movementDrillData = useMemo(() => {
    if (!movementDrill) return null;
    const source = movementRows.filter((r) => r.bcg_movement === movementDrill);
    const lastYear = movementDrill === 'Drop' || movementDrill === 'Discontinued';
    const allSorted = lastYear ? [...source].sort((a, b) => b.total_quantity_P12M - a.total_quantity_P12M) : byVolumeL12M(source);
    const top = allSorted.slice(0, MOVEMENT_DRILL_TOP_N);
    return { listRows: toListRows(top, lastYear ? 'P12M' : 'L12M'), allSorted, moreCount: Math.max(0, allSorted.length - top.length), lastYear };
  }, [movementDrill, movementRows]);

  const exportMovement = (kind: 'csv' | 'pdf') => {
    if (!movementDrill || !movementDrillData) return;
    const n = movementDrillData.allSorted.length;
    const rows = [...movementDrillData.allSorted].sort((a, b) => classOrder(a) - classOrder(b));
    return exportProducts(kind, 'Product Movement', `${MOVEMENT_LABEL[movementDrill]} — ${n} product${n === 1 ? '' : 's'}`, `bcg-matrix-product-movement-${movementDrill.toLowerCase()}`, rows, thresholds);
  };

  const tableRows: TableRow[] = byVolume(eligible).sort((a, b) => classOrder(a) - classOrder(b)).map((r, i) => ({
    ...r,
    id: `${r.id}-${i}`,
    displayName: getDisplayName(r),
  }));

  const columns: DataGridColumn<TableRow>[] = [
    // volume first (the page is based on volume), then the product's attributes, then GP% and revenue
    { key: 'displayName', header: 'Product Name', width: 240, render: (row) => <ProductName name={row.displayName} href={row.odooUrl} />, rawValue: (row) => row.displayName },
    { key: 'productStatus', header: 'Status', render: (row) => statusLabel(row), rawValue: (row) => statusLabel(row) },
    { key: 'total_quantity_L12M', header: 'Volume Last 12 Months', align: 'right', render: (row) => <strong>{fmtNum(row.total_quantity_L12M)}</strong>, rawValue: (row) => row.total_quantity_L12M },
    { key: 'total_quantity_P12M', header: 'Volume Prior 12 Months', align: 'right', render: (row) => fmtNum(row.total_quantity_P12M), rawValue: (row) => row.total_quantity_P12M },
    {
      key: 'quantity_growth_pct',
      header: 'Vol Growth',
      align: 'right',
      // Null means no prior-12-months baseline to compare against (a new product), not 0% -- see
      // backend/src/measures/productDashboard.ts's header note. Sorts/exports as -Infinity so
      // "no baseline" rows fall to one end instead of masquerading as the lowest real growth.
      // A discontinued row is ALSO null here (no recent volume to divide by either) -- that's a
      // completely different situation from "New" (nothing to compare vs. nothing left to sell),
      // so it's checked first and labeled distinctly rather than folding into the "New" branch.
      rawValue: (row) => row.quantity_growth_pct ?? Number.NEGATIVE_INFINITY,
      render: (row) =>
        row.quantity_growth_pct === null ? (
          <span title={`Volume last 12 months: ${fmtNum(row.total_quantity_L12M)} · No volume in the prior 12 months to compare against`} style={{ color: 'var(--ps-color-muted-text)', fontWeight: 700 }}>
            {growthText(row)}
          </span>
        ) : (
          <span title={`Volume last 12 months: ${fmtNum(row.total_quantity_L12M)} · prior 12 months: ${fmtNum(row.total_quantity_P12M)}`} style={{ color: row.quantity_growth_pct >= 0 ? 'var(--ps-color-success)' : 'var(--ps-color-alert)', fontWeight: 700 }}>
            {fmtPct(row.quantity_growth_pct)}
          </span>
        ),
    },
    { key: 'onHandQty', header: 'Quantity On Hand', align: 'right', render: (row) => fmtNum(row.onHandQty), rawValue: (row) => row.onHandQty },
    { key: 'Company', header: 'Company', render: (row) => row.Company, rawValue: (row) => row.Company },
    // Category no longer has a global filter pill on this page (Section 2 simplification) -- kept
    // reachable via this column's own per-column filter instead (DataGrid supports this on every
    // column already, same as BCG Class/Movement below), so slicing by Category isn't silently
    // lost, just relocated to where the other per-product breakdowns already live.
    { key: 'Category', header: 'Category', render: (row) => <ProductName name={row.Category ?? '—'} />, rawValue: (row) => row.Category ?? '' },
    {
      key: 'bcg_class',
      header: 'BCG Class',
      rawValue: classLabel,
      sortValue: classOrder,
      filterOptions: CLASS_FILTER_OPTIONS,
      filterMatch: (row, value) => value === NOT_CLASSIFIED ? classOrder(row) === BCG_CLASSES.length : classLabel(row) === value,
      render: (row) => (
        <span style={{ color: (row.bcg_class && BCG_COLOR[row.bcg_class]) || 'var(--ps-color-muted-text)', fontWeight: 700 }}>{classLabel(row)}</span>
      ),
    },
    { key: 'bcgProfit', header: 'Profit (LYD)', align: 'right', render: (row) => fmtProfit(row.bcgProfit), rawValue: (row) => row.bcgProfit ?? '–', sortValue: (row) => row.bcgProfit ?? Number.NEGATIVE_INFINITY },
    { key: 'bcgDataPeriod', header: 'Profit data', render: (row) => (row.bcgDataPeriod ? `${row.bcgDataPeriod} · ${row.bcgDataAsOf}` : '–'), rawValue: (row) => row.bcgDataAsOf ?? '–' },
    {
      key: 'bcg_movement',
      header: 'Movement',
      render: (row) => (
        <span style={{ color: row.bcg_movement ? MOVEMENT_COLOR[row.bcg_movement] : 'var(--ps-color-muted-text)', fontWeight: 700 }}>
          {row.bcg_movement ? MOVEMENT_LABEL[row.bcg_movement] : '—'}
        </span>
      ),
    },
    { key: 'perc_gross_profit_L12M', header: 'GP%', align: 'right', render: (row) => fmtGp(row.perc_gross_profit_L12M), rawValue: (row) => row.perc_gross_profit_L12M ?? Number.NEGATIVE_INFINITY },
    { key: 'total_value_L12M', header: 'Revenue Last 12 Months', align: 'right', render: (row) => fmtLYD(row.total_value_L12M), rawValue: (row) => row.total_value_L12M },
    { key: 'total_value_P12M', header: 'Revenue Prior 12 Months', align: 'right', render: (row) => fmtLYD(row.total_value_P12M), rawValue: (row) => row.total_value_P12M },
    { key: 'avg_unit_price_L12M', header: 'ASP', align: 'right', render: (row) => fmtLYD(row.avg_unit_price_L12M), rawValue: (row) => row.avg_unit_price_L12M ?? Number.NEGATIVE_INFINITY },
  ];

  // ---- Row tooltip: full detail (Class, Revenue, Volume of the last 12 months, ASP, GP%, Vol Growth,
  // Movement), same Class/Movement colored-pill treatment as the KPI cards and the same
  // colored-text convention the Product Detail table already uses for GP%/Vol Growth -- so the
  // tooltip reads as part of the same design system, not a separate plain-text summary. Shared by
  // all 4 matrix cells' list rows AND Section 3's movement drill-down (a Discontinued row has no
  // bcg_class at all, hence the null-guard on the Class pill below -- every other field is
  // still populated for those rows). */
  const rowTooltipContent = (r: BcgFact, label: string) => (
    <ProductTooltip
      name={label}
      company={r.Company}
      badges={
        <>
          <Pill color={(r.bcg_class && BCG_COLOR[r.bcg_class]) || 'var(--ps-color-muted-text)'} label={classLabel(r)} />
          {r.bcg_movement && <Pill color={MOVEMENT_COLOR[r.bcg_movement]} label={MOVEMENT_LABEL[r.bcg_movement]} />}
        </>
      }
    >
      <TooltipRow label="BCG Class rule" value={bcgClassDefinition(r.bcg_class ?? '', thresholds)} />
      <TooltipRow label="Volume (profit data)" value={r.bcgVolume === null ? '–' : fmtUnits(r.bcgVolume)} />
      <TooltipRow label="Profit" value={fmtProfit(r.bcgProfit)} />
      <TooltipRow label="GP% (profit data)" value={r.bcgGrossProfitPct === null ? '–' : fmtGp(r.bcgGrossProfitPct)} />
      <TooltipRow label="Profit data" value={r.bcgDataPeriod ? `${r.bcgDataPeriod} · as of ${r.bcgDataAsOf}` : '– no profit data'} />
      <TooltipRow label="Status" value={statusLabel(r)} />
      <TooltipRow label="Volume Last 12 Months" value={fmtUnits(r.total_quantity_L12M)} />
      <TooltipRow label="Volume Prior 12 Months" value={fmtUnits(r.total_quantity_P12M)} />
      <TooltipRow
        label="Vol Growth"
        value={growthText(r)}
        valueColor={r.quantity_growth_pct === null ? 'var(--ps-color-muted-text)' : r.quantity_growth_pct >= 0 ? 'var(--ps-color-success)' : 'var(--ps-color-alert)'}
      />
      <TooltipRow label="GP%" value={fmtGp(r.perc_gross_profit_L12M)} />
      <TooltipRow label="Revenue Last 12 Months" value={fmtLYD(r.total_value_L12M)} />
      <TooltipRow label="ASP" value={fmtLYD(r.avg_unit_price_L12M)} />
      <TooltipRow label="Quantity On Hand" value={fmtUnits(r.onHandQty)} />
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
          <Last12MonthsNote period={overview.data?.period} />
          <StatusRows loading={overview.loading} error={overview.error} onRetry={overview.retry} summary={summary} summaryError={overview.data?.statusSummaryError ?? null} />

          <section aria-labelledby="bcg-heading">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 2 }}>
              <h1 id="bcg-heading" style={{ fontSize: 14, fontWeight: 700, color: 'var(--ps-color-text)', margin: 0 }}>
                BCG Matrix <VisualInfoIcons title="BCG Matrix" {...withFormula(vh('product.bcgMatrix.matrix'), bcgClassRule(thresholds))} />
              </h1>
            </div>
            {!overview.loading && !overview.error && (
              <>
                <div data-testid="bcg-profit-data" style={{ fontSize: 12, color: 'var(--ps-color-text)', fontWeight: 600, marginBottom: 2 }}>
                  {profitData.latest ? `Active products · profit data of the last 12 months, as of ${profitData.latest}` : 'No profit data for the Active products'}
                  {profitData.partial > 0 ? ` · ${fmtCount(profitData.partial)} on their fully costed sales only` : ''}
                </div>
                <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginBottom: 12 }}>
                  {fmtCount(classified.length)} products classified · Top {MATRIX_CELL_TOP_N} per class by volume
                  {unclassifiedCount > 0 ? ` · ${fmtCount(unclassifiedCount)} not classified (see Product Detail)` : ''}
                </div>
              </>
            )}
            {overview.loading ? (
              <div className={styles.classGrid}>
                {BCG_CLASSES.map((key) => <LoadingSkeleton key={key} variant="table" />)}
              </div>
            ) : overview.error ? (
              <ErrorState message={overview.error} onRetry={overview.retry} />
            ) : (
              <div data-testid="bcg-class-grid" className={styles.classGrid}>
                {classStats.map((s) => (
                  <MatrixCell key={s.key} classKey={s.key} icon={s.icon} thresholds={thresholds} rows={s.listRows} allSorted={s.allSorted} moreCount={s.moreCount} tooltipContent={rowTooltipContent} />
                ))}
              </div>
            )}
          </section>

          {/* Product Movement, full width (the donut and its legend use the whole row). */}
          <>
            <Card>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ps-color-text)' }}>Product Movement <VisualInfoIcons title="Product Movement" {...withFormula(vh('product.bcgMatrix.movement'), movementRule(thresholds))} /></div>
                </div>
                {movementDrill && <ExportButtons label={`${MOVEMENT_LABEL[movementDrill]} products`} onCsv={() => exportMovement('csv')} onPdf={() => exportMovement('pdf')} />}
              </div>
              <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginBottom: 12 }}>
                {movementDrill
                  ? `${MOVEMENT_LABEL[movementDrill]} SKUs, top ${MOVEMENT_DRILL_TOP_N} by volume of the ${movementDrillData?.lastYear ? 'prior 12 months' : 'last 12 months'} · hover a row for full detail`
                  : 'Volume of the last 12 months vs the 12 months before, by SKU count · click a slice to see its products'}
              </div>
              {overview.loading ? (
                <LoadingSkeleton variant="chart" />
              ) : overview.error ? (
                <ErrorState message={overview.error} onRetry={overview.retry} />
              ) : movementDrill && movementDrillData ? (
                <>
                  <DrillBreadcrumb active={MOVEMENT_LABEL[movementDrill]} rootLabel="All Movements" onReset={() => setMovementDrill(null)} />
                  <RankedProductList rows={movementDrillData.listRows} barColor={MOVEMENT_COLOR[movementDrill]} tooltipContent={rowTooltipContent} volumeHeader={movementDrillData.lastYear ? 'Units Prior 12 Months' : 'Units Last 12 Months'} />
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

            {/* Product Detail: the page footer, full width, directly under Product Movement. */}
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
                  extraFilterParts={[bcgClassRule(thresholds)]}
                />
              )}
            </Card>
          </>
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
 * by volume within one class) and Section 3's movement drill-down (top N within one movement
 * category, which spans every class -- including Discontinued, whose products have no class
 * at all). `fact` stays the general nullable-class `BcgFact`, not `ClassifiedBcgFact`, so this one
 * row type and its tooltip work for both. `barPct` is 0-100, anchored at that list's OWN
 * top-of-list revenue (not a global/cross-list scale -- each list is fully self-contained). */
interface MatrixListRow extends Record<string, unknown> {
  id: string;
  label: string;
  revenue: number;
  /** The ranking volume: last 12 months, or the prior 12 months in the Drop / Discontinued drill-down. */
  volume: number;
  barPct: number;
  fact: BcgFact;
}

/** Highest class volume first (the volume of the data the class is computed on; profit breaks ties). */
function byVolume<T extends BcgFact>(rows: T[]): T[] {
  return [...rows].sort((a, b) => classVolume(b) - classVolume(a) || (b.bcgProfit ?? 0) - (a.bcgProfit ?? 0));
}

/** Highest last-12-months volume first (the movement drill-down). */
function byVolumeL12M<T extends BcgFact>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.total_quantity_L12M - a.total_quantity_L12M || b.total_value_L12M - a.total_value_L12M);
}

/** `window`: 'class' = the class data (panels), 'L12M' / 'P12M' = the movement drill-down. */
function toListRows(rows: BcgFact[], window: 'class' | 'L12M' | 'P12M' = 'class'): MatrixListRow[] {
  const vol = (r: BcgFact) => (window === 'P12M' ? r.total_quantity_P12M : window === 'L12M' ? r.total_quantity_L12M : classVolume(r));
  const max = Math.max(1, ...rows.map(vol));
  return rows.map((r, i) => ({
    id: `${r.id}-${i}`,
    label: getDisplayName(r),
    revenue: r.total_value_L12M,
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
 * the last 12 months) and Section 3's movement drill-down (one movement category's top N, spanning every class).
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
  volumeHeader = 'Units',
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
      key: 'profit',
      header: 'Profit',
      align: 'right',
      render: (row) => (
        <span title={row.fact.bcgDataPeriod ? `Profit data: ${row.fact.bcgDataPeriod}, as of ${row.fact.bcgDataAsOf}` : 'No profit data'} style={{ color: 'var(--ps-color-muted-text)' }}>
          {fmtProfit(row.fact.bcgProfit)}
        </span>
      ),
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
  thresholds,
  rows,
  allSorted,
  moreCount,
  tooltipContent,
}: {
  classKey: BcgClass;
  icon: string;
  thresholds: BcgThresholds;
  rows: MatrixListRow[];
  /** Every product in this class, same volume-descending order as `rows` (the top-10 preview
   * slice) -- the export button ships this full list, not the on-screen preview. */
  allSorted: BcgFact[];
  moreCount: number;
  tooltipContent: (fact: BcgFact, label: string) => React.ReactNode;
}) {
  const color = BCG_COLOR[classKey];
  const definition = bcgClassDefinition(classKey, thresholds);

  const exportClass = (kind: 'csv' | 'pdf') =>
    exportProducts(kind, 'BCG Matrix', `${classKey} · ${allSorted.length} product${allSorted.length === 1 ? '' : 's'} · ${definition}`, `bcg-matrix-${classKey.toLowerCase().replace(/\s+/g, '-')}`, allSorted, thresholds);

  return (
    <Card data-testid={`bcg-class-card-${classKey}`} style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 16, lineHeight: 1 }}>{icon}</span>
        <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color }}>{classKey}</span>
        <span style={{ flex: 1 }} />
        {moreCount > 0 && (
          <span style={{ fontSize: 11, color: 'var(--ps-color-muted-text)' }}>+{fmtCount(moreCount)} more SKUs in this class</span>
        )}
        <ExportButtons label={`${classKey} products`} onCsv={() => exportClass('csv')} onPdf={() => exportClass('pdf')} />
      </div>
      <div data-testid={`bcg-class-definition-${classKey}`} style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', margin: '-4px 0 2px' }}>
        {definition}
      </div>
      <div data-testid={`bcg-class-action-${classKey}`} style={{ fontSize: 11, color: 'var(--ps-color-text)', marginBottom: 8 }}>
        {BCG_RECOMMENDATION[classKey]}
      </div>
      {rows.length ? (
        <RankedProductList rows={rows} barColor={color} tooltipContent={tooltipContent} volumeHeader="Units" />
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: 'var(--ps-color-muted-text)' }}>No product in this class</div>
      )}
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

/** Rows 1-3 of the page (2026-11-14): Total SKUs; Product Status (Active / Non Active / Dormant / Unclassified, each SKU
 * in exactly one); BCG Matrix of the Active products. All from the API's statusSummary, whose two checks (Total = the 4
 * statuses, the 5 BCG cards = Active) the backend enforces (summarizeProductStatus). */
function StatusRows({
  loading,
  error,
  onRetry,
  summary,
  summaryError,
}: {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  summary: ProductStatusSummary | null;
  summaryError: string | null;
}) {
  const rowTitle = (id: string, text: string) => (
    <h2 id={id} className={styles.rowTitle}>
      {text}
    </h2>
  );
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (!loading && !summary) return <ErrorState message={summaryError ?? 'Product status is not available.'} onRetry={onRetry} />;
  const s = summary;
  const bcgMeta = (key: BcgClass) => CLASS_META[key];
  return (
    <div data-testid="bcg-kpis" className={styles.statusRows}>
      <section aria-labelledby="row-total-skus">
        {rowTitle('row-total-skus', 'Total SKUs')}
        <div className={styles.rowTotal}>
          {loading || !s ? (
            <LoadingSkeleton variant="kpi" />
          ) : (
            <KpiTile
              label="SKUs in Odoo (active + archived, every category)"
              value={fmtCount(s.total)}
              variance={`Active ${fmtCount(s.active.count)} · Non Active ${fmtCount(s.nonActive.count)} · Dormant ${fmtCount(s.dormant.count)} · Unclassified ${fmtCount(s.unclassified.count)}`}
              status="neutral"
              icon="📦"
              accentColor="var(--ps-color-accent)"
              badgeLabel="Total SKUs"
            />
          )}
        </div>
      </section>

      <section aria-labelledby="row-product-status">
        {rowTitle('row-product-status', 'Product Status')}
        <div className={styles.rowStatus}>
          {loading || !s ? (
            [0, 1, 2, 3].map((i) => <LoadingSkeleton key={i} variant="kpi" />)
          ) : (
            <>
              <KpiTile
                label="SKUs sold in the last 12 months"
                value={fmtCount(s.active.count)}
                variance={`${fmtUnits(s.active.units)} · ${fmtLYD(s.active.value)}`}
                status="success"
                icon="✅"
                accentColor="var(--ps-color-success)"
                badgeLabel="Active"
              />
              <KpiTile
                label="SKUs not sold in the last 12 months"
                value={fmtCount(s.nonActive.count)}
                variance={`${fmtCount(s.nonActive.withStock)} with stock · ${fmtCount(s.nonActive.zeroStock)} zero stock · stock ${fmtLYD(s.nonActive.stockValue)}`}
                status="watch"
                icon="⏸️"
                accentColor="var(--ps-color-watch)"
                badgeLabel="Non Active"
              />
              <KpiTile
                label="SKUs archived in Odoo"
                value={fmtCount(s.dormant.count)}
                variance="Archived (not active) in Odoo"
                status="alert"
                icon="💤"
                accentColor="var(--ps-color-alert)"
                badgeLabel="Dormant"
              />
              <KpiTile
                label="SKUs in excluded categories"
                value={fmtCount(s.unclassified.count)}
                variance="ProductExclusions.xlsx categories · raw materials"
                status="neutral"
                icon="🏷️"
                accentColor="var(--ps-color-neutral-text)"
                badgeLabel="Unclassified"
              />
            </>
          )}
        </div>
      </section>

      <section aria-labelledby="row-bcg">
        {rowTitle('row-bcg', 'BCG Matrix (Active products · Last 12 Months)')}
        <div className={styles.rowBcg}>
          {loading || !s ? (
            [...BCG_CLASSES, NOT_CLASSIFIED].map((key) => <LoadingSkeleton key={key} variant="kpi" />)
          ) : (
            <>
              {s.bcg.classes.map((c) => (
                <KpiTile
                  key={c.key}
                  label="Products"
                  value={fmtCount(c.count)}
                  variance={c.count ? `${fmtUnits(c.units)} · profit ${fmtLYD(c.profit)}` : undefined}
                  status={bcgMeta(c.key).status}
                  icon={bcgMeta(c.key).icon}
                  accentColor={BCG_COLOR[c.key]}
                  badgeLabel={c.key}
                />
              ))}
              <KpiTile
                label="Products"
                value={fmtCount(s.bcg.notClassified)}
                variance="No profit data or gross margin unavailable"
                status="neutral"
                icon="–"
                accentColor="var(--ps-color-neutral-text)"
                badgeLabel="Not classified"
              />
            </>
          )}
        </div>
      </section>
    </div>
  );
}
