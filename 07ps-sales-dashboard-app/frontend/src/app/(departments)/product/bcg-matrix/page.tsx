'use client';
import { VisualInfoIcons, tooltipBoxStyle } from '@07ps/ui';
import { vh } from '../../../../lib/visualHelp';
import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from './page.module.css';
import { AppHeader } from '../../../../components/AppHeader';
import { BottomNavBar } from '../../../../components/BottomNavBar';
import { FilterBar } from '../../../../components/FilterBar';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useAuth } from '../../../../lib/AuthProvider';
import { useProductFilters } from '../../../../components/product/useProductFilters';
import { ValidationStatusBar } from '../../../../components/ValidationStatusBar';
import { DataQualityRow } from '../../../../components/DataQualityRow';
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
  type DonutSegment,
  type TableExportCell,
} from '@07ps/ui';
import {
  toProductFacts,
  isBcgClassified,
  fmtLYD,
  fmtNum,
  fmtPct,
  fmtUnits,
  BCG_CLASSES,
  BCG_COLOR,
  BCG_DEFINITION,
  BCG_RECOMMENDATION,
  MOVEMENTS,
  MOVEMENT_COLOR,
  MOVEMENT_LABEL,
  movementConfig,
  movementRule,
  type BcgClass,
  type ProductFact,
} from '../../../../lib/materialsAnalogy/shared';
import { bcgClassName } from '../../../../components/product/InventoryVisual';
import { PeriodNote, periodDates, periodLabel } from '../../../../components/product/PeriodNote';
import type { BcgMovement, ProductDashboardOverview, ProductDashboardScope, ProductStatusSummary } from '../../../../lib/api';
import { statusTableHref, type StatusKey, type StockFilter } from '../../../../lib/product/statusTable';
import { useProductDashboard, useRefreshStatus } from '../../../../lib/hooks';
import {
  ExportButtons,
  LTR,
  Pill,
  ProductName,
  ProductTooltip,
  TooltipRow,
  TooltipSection,
  exportProductCsv,
  exportProductPdf,
  exportProductWorkbook,
  rowsFor,
  useHoverTooltip,
  useProfitAccess,
  type ExportColumn,
} from '../../../../components/product/ProductUi';

/**
 * BCG Matrix (Product department), 2026-11-14 round 2:
 *   - Filters: Company and Date only (useProductFilters); every number follows the selected period (default the Last 12
 *     Months), compared with the prior period of the same length. Labels use the API's `period` (periodLabel).
 *   - Rows: Total SKUs · Product Status (Active / Non Active / Dormant / Unclassified) · BCG Matrix of the Active products,
 *     all shared KpiTile cards in the app's standard grid. Stars + Cash Cows + Strategic + Dogs = Active (the API checks).
 *   - Exactly 4 classes; an Active product without cost data counts as low margin (Cash Cows / Dogs). No thresholds on
 *     screen or in the API (server-side only).
 *   - Profit data (profit, GP%, missing-cost flag) only with profit_data access (the API strips it otherwise).
 */

type BcgFact = ProductFact;
type Period = ProductDashboardOverview['period'];
const fmtGp = (v: number | null) => (v === null ? '–' : `${v.toFixed(1)}%`);
const fmtCount = (v: number) => v.toLocaleString('en-US');
const vendorOf = (r: BcgFact) => (r.Brand && r.Brand !== 'Unassigned' ? r.Brand : '—');
const classLabel = (r: BcgFact) => bcgClassName(r.bcg_class);
const STATUS_LABEL: Record<BcgFact['productStatus'], string> = {
  Active: 'Active',
  NonActive: 'Non Active',
  Dormant: 'Dormant',
  Unclassified: 'Unclassified',
};
const statusLabel = (r: BcgFact) => STATUS_LABEL[r.productStatus] ?? '—';
const growthText = (r: BcgFact) => (r.quantity_growth_pct !== null ? fmtPct(r.quantity_growth_pct) : r.bcg_movement === 'New' ? 'New' : '—');

const MATRIX_CELL_TOP_N = 10;
const MOVEMENT_DRILL_TOP_N = 20;

// One icon per class, same order as the 2x2 grid (Stars top-left, Cash Cows top-right, Strategic, Dogs). The class
// colour is BCG_COLOR (lib/materialsAnalogy/shared.ts) everywhere: cards, matrix panels, bars, hover chips, tables.
const CLASS_META: Record<BcgClass, { icon: string }> = {
  Stars: { icon: '⭐' },
  'Cash Cows': { icon: '🐄' },
  Strategic: { icon: '🔵' },
  Dogs: { icon: '🐕' },
};
const classOrder = (r: BcgFact) => {
  const i = BCG_CLASSES.indexOf(r.bcg_class as BcgClass);
  return i < 0 ? BCG_CLASSES.length : i;
};
/** Highest volume first, value breaks ties. */
const byVolume = <T extends BcgFact>(rows: T[]) => [...rows].sort((a, b) => b.volume - a.volume || b.value - a.value);

/** The export columns of every BCG list (Export BCG, the per-class and movement CSV / PDF). Profit and GP% (and the
 * missing-cost flag) only with Export on profit_data. No thresholds. */
function bcgExportColumns(withProfit: boolean): ExportColumn<BcgFact>[] {
  const cols: ExportColumn<BcgFact>[] = [
    { header: 'Product', value: (r) => r.ProductName },
    { header: 'Vendor', value: vendorOf },
    { header: 'Class', value: classLabel },
    { header: 'Value (LYD)', align: 'right', value: (r) => r.value, text: (r) => fmtLYD(r.value) },
    { header: 'Volume (Unit)', align: 'right', value: (r) => r.volume, text: (r) => fmtNum(r.volume) },
    { header: 'Volume prior period (Unit)', align: 'right', value: (r) => r.volumePrior, text: (r) => fmtNum(r.volumePrior) },
    { header: 'Growth %', align: 'right', value: (r) => (r.quantity_growth_pct === null ? null : Math.round(r.quantity_growth_pct * 10) / 10), text: growthText },
    { header: 'Qty on hand (Unit)', align: 'right', value: (r) => r.onHandQty, text: (r) => fmtNum(r.onHandQty) },
  ];
  if (withProfit) {
    cols.push(
      { header: 'Profit (LYD)', align: 'right', value: (r) => r.bcgProfit, text: (r) => (r.bcgProfit === null ? '–' : fmtLYD(r.bcgProfit)) },
      { header: 'GP%', align: 'right', value: (r) => (r.bcgGrossProfitPct === null ? null : Math.round(r.bcgGrossProfitPct * 10) / 10), text: (r) => fmtGp(r.bcgGrossProfitPct) },
      { header: 'Missing cost data', value: (r) => (r.missingCost ? 'Yes' : ''), text: (r) => (r.missingCost ? 'Yes' : '') },
    );
  }
  return cols;
}

export default function BcgMatrixPage() {
  const { user, token, error: authError, retryAuth, logout } = useAuth();
  const roleLabel = user?.role.label ?? user?.fullName;
  const refresh = useRefreshStatus(token, authError, retryAuth);
  const { anchorDate, onAnchorDateChange, scope, companyLabel, filterBarProps } = useProductFilters(refresh.data);
  const overview = useProductDashboard(token, authError, retryAuth, 'bcg-matrix', scope);
  const profit = useProfitAccess(overview.data?.profitAccess);
  const period = overview.data?.period ?? null;
  const pLabel = periodLabel(period);
  const allFacts = useMemo(() => toProductFacts(overview.data), [overview.data]);
  const eligible = useMemo(() => allFacts.filter((r) => !r.bcgExcludedCategory), [allFacts]);
  // BCG runs on the Active products only (sold in the period): every one of them has a class.
  const classified = useMemo(() => eligible.filter((r) => r.productStatus === 'Active' && isBcgClassified(r)), [eligible]);
  const movementRows = useMemo(() => eligible.filter((r) => r.bcg_movement !== null), [eligible]);
  const mvConfig = useMemo(() => movementConfig(overview.data?.thresholds), [overview.data?.thresholds]);
  const summary = overview.data?.statusSummary ?? null;
  const exportColumns = useMemo(() => bcgExportColumns(profit.export), [profit.export]);
  // Data quality (admins only, 2026-11-15): the link opens Product Detail with Cost data = Missing; ?costData=missing too.
  const [costMissingOnly, setCostMissingOnly] = useState(false);
  useEffect(() => {
    try {
      if (new URLSearchParams(window.location.search).get('costData') === 'missing') setCostMissingOnly(true);
    } catch {
      /* no URL: the full list */
    }
  }, []);
  const openMissingCost = () => {
    setCostMissingOnly(true);
    try {
      window.history.replaceState(null, '', `${window.location.pathname}?costData=missing#product-detail`);
    } catch {
      /* the filter still applies */
    }
    requestAnimationFrame(() => document.getElementById('product-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  const missingCost = profit.view ? summary?.bcg.missingCost ?? 0 : 0;
  const exportSubtitle = (what: string) => `${what} · ${companyLabel} · ${pLabel}${period && period.isDefault ? ` (${periodDates(period)})` : ''}`;

  const classStats = useMemo(
    () =>
      BCG_CLASSES.map((key) => {
        const allSorted = byVolume(classified.filter((r) => r.bcg_class === key));
        const top = allSorted.slice(0, MATRIX_CELL_TOP_N);
        return { key, ...CLASS_META[key], listRows: toListRows(top, 'period'), allSorted, moreCount: allSorted.length - top.length };
      }),
    [classified],
  );

  /** Export BCG: one .xlsx with a Summary sheet and one sheet per class, every Active product. */
  const exportWholeBcg = () => {
    const summaryHeaders = ['Class', 'Products', 'Volume (Unit)', 'Value (LYD)', ...(profit.export ? ['Profit (LYD)'] : [])];
    const classRows: TableExportCell[][] = classStats.map((c) => [
      c.key,
      c.allSorted.length,
      c.allSorted.reduce((t, r) => t + r.volume, 0),
      c.allSorted.reduce((t, r) => t + r.value, 0),
      ...(profit.export ? [c.allSorted.reduce((t, r) => t + (r.bcgProfit ?? 0), 0)] : []),
    ]);
    const total: TableExportCell[] = ['Total (Active)', classified.length, classified.reduce((t, r) => t + r.volume, 0), classified.reduce((t, r) => t + r.value, 0),
      ...(profit.export ? [classified.reduce((t, r) => t + (r.bcgProfit ?? 0), 0)] : [])];
    const meta: TableExportCell[][] = [
      [],
      ['Period', period && period.isDefault ? `${pLabel} · ${periodDates(period)}` : pLabel],
      ['Compared with', period ? periodDates({ from: period.priorFrom, to: period.priorTo }) : ''],
      ['Company filter', companyLabel],
    ];
    const headers = exportColumns.map((c) => c.header);
    return exportProductWorkbook('bcg-matrix', [
      { name: 'Summary', headers: summaryHeaders, rows: [...classRows, total, ...meta] },
      ...classStats.map((c) => ({ name: c.key, headers, rows: rowsFor(exportColumns, c.allSorted) })),
    ]);
  };

  // ---- Product Movement donut + drill-down (the period vs the prior period of the same length) ----
  const movementSegments: DonutSegment[] = MOVEMENTS.map((mv) => ({
    id: mv,
    label: MOVEMENT_LABEL[mv],
    value: movementRows.filter((r) => r.bcg_movement === mv).length,
    color: MOVEMENT_COLOR[mv],
  })).filter((s) => s.value > 0);
  const [movementDrill, setMovementDrill] = useState<BcgMovement | null>(null);
  const movementDrillData = useMemo(() => {
    if (!movementDrill) return null;
    const source = movementRows.filter((r) => r.bcg_movement === movementDrill);
    const lastYear = movementDrill === 'Drop' || movementDrill === 'Discontinued';
    const allSorted = lastYear ? [...source].sort((a, b) => b.volumePrior - a.volumePrior) : byVolume(source);
    const top = allSorted.slice(0, MOVEMENT_DRILL_TOP_N);
    return { listRows: toListRows(top, lastYear ? 'prior' : 'period'), allSorted, moreCount: Math.max(0, allSorted.length - top.length), lastYear };
  }, [movementDrill, movementRows]);
  const exportMovement = (kind: 'csv' | 'pdf') => {
    if (!movementDrill || !movementDrillData) return;
    const rows = [...movementDrillData.allSorted].sort((a, b) => classOrder(a) - classOrder(b));
    const fileName = `bcg-matrix-product-movement-${movementDrill.toLowerCase()}`;
    return kind === 'csv'
      ? exportProductCsv(fileName, exportColumns, rows)
      : exportProductPdf({ title: 'Product Movement', subtitle: exportSubtitle(`${MOVEMENT_LABEL[movementDrill]} — ${rows.length} products`), fileName, columns: exportColumns, rows });
  };

  // ---- Product Detail ----
  interface TableRow extends BcgFact, Record<string, unknown> {
    id: string;
  }
  const tableRows: TableRow[] = byVolume(eligible).sort((a, b) => classOrder(a) - classOrder(b)).map((r, i) => ({ ...r, id: `${r.id}-${i}` }));
  const columns: DataGridColumn<TableRow>[] = [
    { key: 'ProductName', header: 'Product Name', width: 240, render: (row) => <ProductName name={row.ProductName} href={row.odooUrl} />, rawValue: (row) => row.ProductName },
    { key: 'productStatus', header: 'Status', render: (row) => statusLabel(row), rawValue: (row) => statusLabel(row) },
    { key: 'volume', header: 'Volume', align: 'right', render: (row) => <strong>{fmtNum(row.volume)}</strong>, rawValue: (row) => row.volume },
    { key: 'volumePrior', header: 'Volume prior period', align: 'right', render: (row) => fmtNum(row.volumePrior), rawValue: (row) => row.volumePrior },
    {
      key: 'quantity_growth_pct',
      header: 'Vol Growth',
      align: 'right',
      rawValue: (row) => row.quantity_growth_pct ?? Number.NEGATIVE_INFINITY,
      render: (row) => (
        <span style={{ color: row.quantity_growth_pct === null ? 'var(--ps-color-muted-text)' : row.quantity_growth_pct >= 0 ? 'var(--ps-color-success)' : 'var(--ps-color-alert)', fontWeight: 700 }}>
          {growthText(row)}
        </span>
      ),
    },
    { key: 'onHandQty', header: 'Quantity On Hand', align: 'right', render: (row) => fmtNum(row.onHandQty), rawValue: (row) => row.onHandQty },
    { key: 'Company', header: 'Company', render: (row) => row.Company, rawValue: (row) => row.Company },
    { key: 'Category', header: 'Category', render: (row) => <ProductName name={row.Category ?? '—'} />, rawValue: (row) => row.Category ?? '' },
    { key: 'Brand', header: 'Vendor', render: (row) => vendorOf(row), rawValue: (row) => vendorOf(row) },
    {
      key: 'bcg_class',
      header: 'BCG Class',
      rawValue: classLabel,
      sortValue: classOrder,
      filterOptions: [...BCG_CLASSES].map((c) => ({ value: c, label: c })),
      filterMatch: (row, value) => row.bcg_class === value,
      render: (row) => <span style={{ color: (row.bcg_class && BCG_COLOR[row.bcg_class]) || 'var(--ps-color-muted-text)', fontWeight: 700 }}>{classLabel(row)}</span>,
    },
    {
      key: 'bcg_movement',
      header: 'Movement',
      render: (row) => (
        <span style={{ color: row.bcg_movement ? MOVEMENT_COLOR[row.bcg_movement] : 'var(--ps-color-muted-text)', fontWeight: 700 }}>
          {row.bcg_movement ? MOVEMENT_LABEL[row.bcg_movement] : '—'}
        </span>
      ),
      rawValue: (row) => (row.bcg_movement ? MOVEMENT_LABEL[row.bcg_movement] : ''),
    },
    { key: 'value', header: 'Value', align: 'right', render: (row) => fmtLYD(row.value), rawValue: (row) => row.value },
    { key: 'valuePrior', header: 'Value prior period', align: 'right', render: (row) => fmtLYD(row.valuePrior), rawValue: (row) => row.valuePrior },
    { key: 'avgUnitPrice', header: 'ASP', align: 'right', render: (row) => fmtLYD(row.avgUnitPrice), rawValue: (row) => row.avgUnitPrice ?? Number.NEGATIVE_INFINITY },
    ...(profit.view
      ? ([
          { key: 'bcgProfit', header: 'Profit', align: 'right', render: (row) => (row.bcgProfit === null ? '–' : fmtLYD(row.bcgProfit)), rawValue: (row) => row.bcgProfit ?? '', sortValue: (row) => row.bcgProfit ?? Number.NEGATIVE_INFINITY },
          { key: 'bcgGrossProfitPct', header: 'GP%', align: 'right', render: (row) => fmtGp(row.bcgGrossProfitPct), rawValue: (row) => row.bcgGrossProfitPct ?? '', sortValue: (row) => row.bcgGrossProfitPct ?? Number.NEGATIVE_INFINITY },
          {
            key: 'missingCost',
            header: 'Cost data',
            render: (row) => (row.missingCost ? <span style={{ color: 'var(--ps-color-watch)', fontWeight: 700 }}>Missing</span> : ''),
            rawValue: (row) => (row.missingCost ? 'Missing' : ''),
            filterOptions: [{ value: 'Missing', label: 'Missing' }],
            filterMatch: (row, value) => value === 'Missing' && Boolean(row.missingCost),
          },
        ] as DataGridColumn<TableRow>[])
      : []),
  ];

  const rowTooltipContent = (r: BcgFact) => <BcgTooltip r={r} period={period} showProfit={profit.view} />;

  return (
    <PermissionGuard pageKey="bcg_matrix">
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', paddingBottom: 64 }}>
        <AppHeader anchorDate={anchorDate} onAnchorDateChange={onAnchorDateChange} roleLabel={roleLabel} onLogout={logout} showDateInput={false} />

        <FilterBar {...filterBarProps} />

        <ValidationStatusBar
          isStale={refresh.data?.isStale}
          isInverted={refresh.data?.isInverted}
          refreshCheck={refresh.data?.refreshCheck}
          lastRefreshTime={refresh.data ? formatTimestamp(refresh.data.lastRefreshTime) : undefined}
        />

        {user?.isAdmin === true && missingCost > 0 && (
          <DataQualityRow
            testId="bcg-data-quality"
            summary={`${fmtCount(missingCost)} Active products have no cost in Odoo (counted as low margin)`}
            onOpen={openMissingCost}
            status="watch"
          />
        )}

        <main style={{ flex: 1, padding: 'var(--ps-space-4, 24px)', display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)' }}>
          <PeriodNote period={period} />
          <StatusRows
            loading={overview.loading}
            error={overview.error}
            onRetry={overview.retry}
            summary={summary}
            summaryError={overview.data?.statusSummaryError ?? null}
            showProfit={profit.view}
            scope={scope}
          />

          <section aria-labelledby="bcg-heading">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 2 }}>
              <h2 id="bcg-heading" className={styles.sectionTitle}>
                BCG Matrix <VisualInfoIcons title="BCG Matrix" {...vh('product.bcgMatrix.matrix')} />
              </h2>
              <span style={{ flex: 1 }} />
              {!overview.loading && !overview.error && classified.length > 0 && (
                <ExportButtons label="the whole BCG" onXlsx={exportWholeBcg} xlsxText="Export BCG" />
              )}
            </div>
            {!overview.loading && !overview.error && (
              <div data-testid="bcg-subtitle" style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginBottom: 12 }}>
                {fmtCount(classified.length)} Active products · {pLabel} · Top {MATRIX_CELL_TOP_N} per class by volume
              </div>
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
                  <MatrixCell
                    key={s.key}
                    classKey={s.key}
                    icon={s.icon}
                    rows={s.listRows}
                    allSorted={s.allSorted}
                    moreCount={s.moreCount}
                    tooltipContent={rowTooltipContent}
                    onExport={(kind) => {
                      const fileName = `bcg-matrix-${s.key.toLowerCase().replace(/\s+/g, '-')}`;
                      return kind === 'csv'
                        ? exportProductCsv(fileName, exportColumns, s.allSorted)
                        : exportProductPdf({ title: 'BCG Matrix', subtitle: exportSubtitle(`${s.key} · ${s.allSorted.length} products`), fileName, columns: exportColumns, rows: s.allSorted });
                    }}
                  />
                ))}
              </div>
            )}
          </section>

          <Card>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
              <div style={{ flex: 1 }}>
                <div className={styles.sectionTitle}>
                  Product Movement <VisualInfoIcons title="Product Movement" {...withFormula(vh('product.bcgMatrix.movement'), movementRule(mvConfig))} />
                </div>
              </div>
              {movementDrill && <ExportButtons label={`${MOVEMENT_LABEL[movementDrill]} products`} onCsv={() => exportMovement('csv')} onPdf={() => exportMovement('pdf')} />}
            </div>
            <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginBottom: 12 }}>
              {movementDrill
                ? `${MOVEMENT_LABEL[movementDrill]} SKUs, top ${MOVEMENT_DRILL_TOP_N} by volume of the ${movementDrillData?.lastYear ? 'prior period' : 'period'} · hover a row for full detail`
                : `Volume ${pLabel} vs the prior period, by SKU count · click a slice to see its products`}
            </div>
            {overview.loading ? (
              <LoadingSkeleton variant="chart" />
            ) : overview.error ? (
              <ErrorState message={overview.error} onRetry={overview.retry} />
            ) : movementDrill && movementDrillData ? (
              <>
                <DrillBreadcrumb active={MOVEMENT_LABEL[movementDrill]} rootLabel="All Movements" onReset={() => setMovementDrill(null)} />
                <RankedProductList rows={movementDrillData.listRows} barColor={MOVEMENT_COLOR[movementDrill]} tooltipContent={rowTooltipContent}
                  volumeHeader={movementDrillData.lastYear ? 'Volume prior period' : 'Volume'} />
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

          <Card id="product-detail">
            <div className={styles.sectionTitle} style={{ marginBottom: 2 }}>
              Product Detail <VisualInfoIcons title="Product Detail" {...vh('product.bcgMatrix.productDetail')} />
            </div>
            <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginBottom: 12 }}>
              {pLabel} · click a column header to sort · search and per-column filter below each header
            </div>
            {overview.loading ? (
              <LoadingSkeleton variant="table" />
            ) : overview.error ? (
              <ErrorState message={overview.error} onRetry={overview.retry} />
            ) : (
              <DataGrid key={costMissingOnly ? 'cost-missing' : 'all'} columns={columns} rows={tableRows} getRowId={(row) => row.id}
                fileName="bcg-matrix-product-detail" filtersSummary={`${companyLabel} · ${pLabel}`}
                initialColumnFilters={costMissingOnly && profit.view ? [{ id: 'missingCost', value: 'Missing' }] : undefined} />
            )}
          </Card>
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

/** Rows 1-3: Total SKUs; Product Status; BCG Matrix of the Active products. From the API's statusSummary, whose two
 * checks (Total = the 4 statuses, the 4 classes = Active) the backend enforces. Profit lines only with profit access.
 * 2026-11-15: Total SKUs is a full-width hero (the Critical Number card's layout: global .ps-cn-hero, 40px number) with
 * one chip per status; the chips and the 4 Product Status cards open the status table (/product/bcg-matrix/products)
 * with the page's Company + Date filters. */
const STATUS_COLOR: Record<StatusKey, string> = {
  active: 'var(--ps-color-success)',
  non_active: 'var(--ps-color-watch)',
  dormant: 'var(--ps-color-alert)',
  unclassified: 'var(--ps-color-neutral-text)',
};

/** A KpiTile that opens a page: the app's .ps-card-clickable (hover lift, focus ring), Enter / Space like a button. */
function ClickableTile({ label, onOpen, children }: { label: string; onOpen: () => void; children: React.ReactNode }) {
  return (
    <div
      role="link"
      tabIndex={0}
      aria-label={label}
      className={`ps-card-clickable ${styles.clickTile}`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      {children}
    </div>
  );
}

function StatusRows({
  loading,
  error,
  onRetry,
  summary,
  summaryError,
  showProfit,
  scope,
}: {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  summary: ProductStatusSummary | null;
  summaryError: string | null;
  showProfit: boolean;
  scope: ProductDashboardScope;
}) {
  const router = useRouter();
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (!loading && !summary) return <ErrorState message={summaryError ?? 'Product status is not available.'} onRetry={onRetry} />;
  const s = summary;
  const open = (key: StatusKey, stock: StockFilter = 'all') => router.push(statusTableHref(key, scope, stock));
  const skeletons = (n: number) => Array.from({ length: n }, (_, i) => <LoadingSkeleton key={i} variant="kpi" />);
  const chips: { key: StatusKey; label: string; count: number }[] = s
    ? [
        { key: 'active', label: 'Active', count: s.active.count },
        { key: 'non_active', label: 'Non Active', count: s.nonActive.count },
        { key: 'dormant', label: 'Dormant', count: s.dormant.count },
        { key: 'unclassified', label: 'Unclassified', count: s.unclassified.count },
      ]
    : [];
  return (
    <div data-testid="bcg-kpis" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-3, 16px)' }}>
      <section aria-labelledby="row-total-skus">
        {loading || !s ? (
          <Card style={{ width: '100%' }}><h2 id="row-total-skus" className={styles.sectionTitle}>Total SKUs</h2><LoadingSkeleton variant="kpi" /></Card>
        ) : (
          <Card data-testid="total-skus-hero" style={{ width: '100%', borderInlineStart: '4px solid var(--ps-color-accent)' }}>
            <div className="ps-cn-hero">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, color: 'var(--ps-color-muted-text)' }}>
                <h2 id="row-total-skus" style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>Total SKUs</h2>
                <VisualInfoIcons title="Total SKUs" {...vh('product.bcgMatrix.totalSkus')} />
              </div>
              <div className={styles.heroNumber} data-testid="total-skus-value">{fmtCount(s.total)}</div>
              <div className={styles.chips} data-testid="total-skus-chips">
                {chips.map((c) => (
                  <button key={c.key} type="button" className={styles.chip} data-testid={`total-skus-chip-${c.key}`}
                    style={{ '--chip-color': STATUS_COLOR[c.key] } as React.CSSProperties}
                    aria-label={`${c.label} ${fmtCount(c.count)}: list the products`} onClick={() => open(c.key)}>
                    <span className={styles.chipDot} aria-hidden="true" />
                    {c.label} {fmtCount(c.count)}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)' }}>Active + archived, every category</div>
            </div>
          </Card>
        )}
      </section>

      <section aria-labelledby="row-product-status">
        <h2 id="row-product-status" className={styles.sectionTitle}>
          Product Status <VisualInfoIcons title="Product Status" {...vh('product.bcgMatrix.productStatus')} />
        </h2>
        <div className={styles.kpiGrid}>
          {loading || !s ? skeletons(4) : (
            <>
              <ClickableTile label={`Active ${fmtCount(s.active.count)}: list the products`} onOpen={() => open('active')}>
                <KpiTile label="Active · sold in the period" value={fmtCount(s.active.count)} subValue={`${fmtUnits(s.active.units)} · ${fmtLYD(s.active.value)}`} status="success" />
              </ClickableTile>
              <ClickableTile label={`Non Active ${fmtCount(s.nonActive.count)}: list the products`} onOpen={() => open('non_active')}>
                <KpiTile label="Non Active · not sold in the period" value={fmtCount(s.nonActive.count)}
                  subValue={`${fmtCount(s.nonActive.withStock)} with stock · ${fmtCount(s.nonActive.zeroStock)} zero stock`} status="watch" />
              </ClickableTile>
              <ClickableTile label={`Dormant ${fmtCount(s.dormant.count)}: list the products`} onOpen={() => open('dormant')}>
                <KpiTile label="Dormant · archived in Odoo" value={fmtCount(s.dormant.count)} status="alert" />
              </ClickableTile>
              <ClickableTile label={`Unclassified ${fmtCount(s.unclassified.count)}: list the products`} onOpen={() => open('unclassified')}>
                <KpiTile label="Unclassified · active exclusion rules" value={fmtCount(s.unclassified.count)} status="neutral" />
              </ClickableTile>
            </>
          )}
        </div>
        {!loading && s && <div className={styles.clickHint}>Click a card to list its products</div>}
      </section>

      <section aria-labelledby="row-bcg">
        <h2 id="row-bcg" className={styles.sectionTitle}>BCG Matrix (Active products)</h2>
        <div className={styles.kpiGrid}>
          {loading || !s ? skeletons(4) : s.bcg.classes.map((c) => (
            <KpiTile
              key={c.key}
              label={c.key}
              value={fmtCount(c.count)}
              subValue={`${fmtUnits(c.units)} · ${fmtLYD(c.value)}${showProfit && c.profit !== undefined ? ` · profit ${fmtLYD(c.profit)}` : ''}`}
              valueColor={BCG_COLOR[c.key]}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

/** The product hover: header (name; vendor, class, movement badges), Sales of the period, Stock, Profit (profit access
 * only), footer (status · period dates). One line per item, fixed label width, no duplicates. */
function BcgTooltip({ r, period, showProfit }: { r: BcgFact; period: Period | null; showProfit: boolean }) {
  const growthColor = r.quantity_growth_pct === null ? 'var(--ps-color-muted-text)' : r.quantity_growth_pct >= 0 ? 'var(--ps-color-success)' : 'var(--ps-color-alert)';
  return (
    <div data-testid="bcg-tooltip" style={{ width: 280 }}>
    <ProductTooltip
      name={r.ProductName}
      company={r.Company}
      badges={
        <>
          {vendorOf(r) !== '—' && <Pill color="var(--ps-color-neutral-text)" label={vendorOf(r)} />}
          <Pill color={(r.bcg_class && BCG_COLOR[r.bcg_class]) || 'var(--ps-color-muted-text)'} label={classLabel(r)} />
          {r.bcg_movement && <Pill color={MOVEMENT_COLOR[r.bcg_movement]} label={MOVEMENT_LABEL[r.bcg_movement]} />}
        </>
      }
    >
      <TooltipSection title={`Sales · ${periodLabel(period)}`}>
        <TooltipRow label="Volume" value={fmtUnits(r.volume)} />
        <TooltipRow label="Volume prior period" value={fmtUnits(r.volumePrior)} />
        <TooltipRow label="Volume growth" value={growthText(r)} valueColor={growthColor} />
        <TooltipRow label="Sales value" value={fmtLYD(r.value)} />
        <TooltipRow label="ASP" value={fmtLYD(r.avgUnitPrice)} />
      </TooltipSection>
      <TooltipSection title="Stock">
        <TooltipRow label="Quantity on hand" value={fmtUnits(r.onHandQty)} />
      </TooltipSection>
      {showProfit && (
        <TooltipSection title="Profit">
          <TooltipRow label="Profit" value={r.bcgProfit === null ? '–' : fmtLYD(r.bcgProfit)} />
          <TooltipRow label="GP%" value={r.missingCost && r.bcgGrossProfitPct === null ? 'Missing cost data' : fmtGp(r.bcgGrossProfitPct)}
            valueColor={r.missingCost ? 'var(--ps-color-watch)' : undefined} />
        </TooltipSection>
      )}
      <div style={{ borderTop: '1px solid var(--ps-color-border)', marginTop: 6, paddingTop: 6, fontSize: 11, color: 'var(--ps-color-muted-text)', whiteSpace: 'nowrap' }}>
        {statusLabel(r)}{period ? ` · ${periodDates(period)}` : ''}
      </div>
    </ProductTooltip>
    </div>
  );
}

/** One row of a ranked product list (class panels and the movement drill-down). */
interface MatrixListRow extends Record<string, unknown> {
  id: string;
  label: string;
  vendor: string;
  value: number;
  volume: number;
  barPct: number;
  fact: BcgFact;
}

/** `window`: the period (panels, most drill-downs) or the prior period (Drop / Discontinued drill-down). */
function toListRows(rows: BcgFact[], window: 'period' | 'prior'): MatrixListRow[] {
  const vol = (r: BcgFact) => (window === 'prior' ? r.volumePrior : r.volume);
  const max = Math.max(1, ...rows.map(vol));
  return rows.map((r, i) => ({
    id: `${r.id}-${i}`,
    label: r.ProductName,
    vendor: vendorOf(r),
    value: window === 'prior' ? r.valuePrior : r.value,
    volume: vol(r),
    barPct: (Math.max(0, vol(r)) / max) * 100,
    fact: r,
  }));
}

/** A "?" whose formula line comes from the config (the movement band; never the BCG thresholds). */
function withFormula(entry: ReturnType<typeof vh>, formula: string): ReturnType<typeof vh> {
  return entry.help ? { ...entry, help: { ...entry.help, formula } } : entry;
}

/** Ranked product list: Product name · Vendor · Value · Volume (the class tables and the movement drill-down). */
function RankedProductList({
  rows,
  barColor,
  tooltipContent,
  volumeHeader = 'Volume',
}: {
  rows: MatrixListRow[];
  barColor: string;
  tooltipContent: (fact: BcgFact) => React.ReactNode;
  volumeHeader?: string;
}) {
  const tip = useHoverTooltip(280, 300);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const columns: Column<MatrixListRow>[] = [
    {
      key: 'label',
      header: 'Product name',
      render: (row) => (
        <div dir="ltr" {...tip.bind(row.id)} style={{ ...LTR, display: 'flex', alignItems: 'center', gap: 8, width: '100%', maxWidth: 'min(260px, 38vw)' }}>
          <div style={{ width: 32, height: 6, borderRadius: 3, background: 'var(--ps-color-muted-bg)', flexShrink: 0, overflow: 'hidden' }}>
            <div style={{ width: `${row.barPct}%`, height: '100%', background: barColor, borderRadius: 3 }} />
          </div>
          <ProductName name={row.label} href={row.fact.odooUrl} style={{ flex: 1 }} />
        </div>
      ),
    },
    { key: 'vendor', header: 'Vendor', render: (row) => <ProductName name={row.vendor} style={{ maxWidth: 'min(160px, 24vw)' }} /> },
    { key: 'value', header: 'Value', align: 'right', render: (row) => fmtLYD(row.value) },
    { key: 'volume', header: volumeHeader, align: 'right', render: (row) => <span style={{ fontWeight: 600 }}>{fmtNum(row.volume)}</span> },
  ];
  return (
    <div style={{ position: 'relative' }}>
      <DataTable columns={columns} rows={rows} getRowId={(row) => row.id} />
      {tip.render((key) => {
        const row = byId.get(key);
        return row ? tooltipContent(row.fact) : null;
      })}
    </div>
  );
}

/** One class panel: icon + class name + count, the class in words (no numbers) and its action, the top products, and
 * that class's CSV / PDF (every product of the class). */
function MatrixCell({
  classKey,
  icon,
  rows,
  allSorted,
  moreCount,
  tooltipContent,
  onExport,
}: {
  classKey: BcgClass;
  icon: string;
  rows: MatrixListRow[];
  allSorted: BcgFact[];
  moreCount: number;
  tooltipContent: (fact: BcgFact) => React.ReactNode;
  onExport: (kind: 'csv' | 'pdf') => void | Promise<void>;
}) {
  const color = BCG_COLOR[classKey];
  return (
    <Card data-testid={`bcg-class-card-${classKey}`} style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 16, lineHeight: 1 }}>{icon}</span>
        <span style={{ fontSize: 14, fontWeight: 700, color }}>{classKey}</span>
        <span style={{ fontSize: 12, color: 'var(--ps-color-muted-text)' }}>{fmtCount(allSorted.length)} products</span>
        <span style={{ flex: 1 }} />
        <ExportButtons label={`${classKey} products`} onCsv={() => onExport('csv')} onPdf={() => onExport('pdf')} />
      </div>
      <div data-testid={`bcg-class-definition-${classKey}`} style={{ fontSize: 12, color: 'var(--ps-color-text)', marginBottom: 8 }}>
        <strong style={{ fontWeight: 600 }}>{BCG_DEFINITION[classKey]}</strong> <span style={{ color: 'var(--ps-color-muted-text)' }}>{BCG_RECOMMENDATION[classKey]}</span>
      </div>
      {rows.length ? (
        <RankedProductList rows={rows} barColor={color} tooltipContent={tooltipContent} />
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: 'var(--ps-color-muted-text)' }}>No product in this class</div>
      )}
      {moreCount > 0 && (
        <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginTop: 8 }}>+{fmtCount(moreCount)} more in this class · Export for the full list</div>
      )}
    </Card>
  );
}

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
