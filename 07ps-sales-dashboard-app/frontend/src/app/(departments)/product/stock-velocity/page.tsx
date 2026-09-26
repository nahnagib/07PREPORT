'use client';
import React, { useMemo, useState } from 'react';
import { AppHeader } from '../../../../components/AppHeader';
import { BottomNavBar } from '../../../../components/BottomNavBar';
import { FilterBar } from '../../../../components/FilterBar';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useAuth } from '../../../../lib/AuthProvider';
import {
  ChartPanel,
  KpiTile,
  Select,
  Button,
  GroupedBarChart,
  exportRowsAsPdf,
  PerformanceReportTable,
  exportPerformanceTablePdf,
  SEMANTIC_STATUS_LABEL,
  type SelectOption,
  type GroupedBarChartPoint,
  type PerformanceReportRow,
  type PerformanceTablePdfColumn,
  type SemanticStatus,
  useCanExport,
} from '@07ps/ui';
import {
  FACTS,
  stockBand,
  fmtLYD,
  fmtNum,
  median,
  sum,
  distinctSorted,
  BCG_COLOR,
  COMPANIES,
  type CompanyFilter,
} from '../../../../lib/materialsAnalogy/shared';

const BCG_CLASSES = ['Stars', 'Cash Cows', 'Strategic', 'Dogs'] as const;
type BcgClass = (typeof BCG_CLASSES)[number];

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
// Executive Summary -- this page has no prior-period comparison anywhere in its data model (every
// figure is point-in-time), so each row reuses the exact same status its own KpiTile above already
// shows (Overstocked=watch, Stock-Out Risk=alert, Fast Movers=success, the rest neutral) rather
// than inventing a different read for the same number.
// ---------------------------------------------------------------------------

function toExecutiveSummaryRows(
  avgDOH: number,
  overCount: number,
  overValue: number,
  riskCount: number,
  riskValue: number,
  fastCount: number,
  currentStockQty: number,
  inventoryValue: number,
): PerformanceReportRow[] {
  const row = (id: string, metric: string, actualLabel: string, status: SemanticStatus, takeaway: string): PerformanceReportRow => ({
    id,
    metric,
    actualLabel,
    targetLabel: '—',
    variancePct: null,
    varianceLyPct: null,
    status,
    takeaway,
  });

  return [
    row('avgDOH', 'Avg Days of Inventory', `${Math.round(avgDOH)} days`, 'neutral', `Portfolio-wide average is ${Math.round(avgDOH)} days of inventory on hand.`),
    row(
      'overstocked',
      'Overstocked SKUs',
      String(overCount),
      'watch',
      `${overCount} SKUs are overstocked, tying up ${fmtLYD(overValue)}.`,
    ),
    row(
      'stockOutRisk',
      'Stock-Out Risk SKUs',
      String(riskCount),
      'alert',
      `${riskCount} SKUs are at stock-out risk, representing ${fmtLYD(riskValue)} of at-risk sales.`,
    ),
    row('fastMovers', 'Fast Movers (top velocity tercile)', String(fastCount), 'success', `${fastCount} SKUs are in the fastest-moving third of the portfolio.`),
    row('currentStock', 'Current Stock', `${fmtNum(currentStockQty)} units`, 'neutral', `${fmtNum(currentStockQty)} units currently in stock.`),
    row('inventoryValue', 'Inventory Value', fmtLYD(inventoryValue), 'neutral', `Current inventory is valued at ${fmtLYD(inventoryValue)}.`),
  ];
}

/**
 * Materials Analogy module -- see lib/materialsAnalogy/shared.ts's header comment for why this
 * page renders against local synthetic data instead of a use*Overview hook. Shell/chrome
 * (AppHeader, Filters collapsible, ChartPanel, KpiTile, BottomNavBar, real @07ps/ui chart
 * components + design tokens) is identical to every other built report -- see Pipeline
 * Health's page.tsx for the pattern this mirrors.
 *
 * Redesign pass: every bar chart on this page used to plot one bar per product directly, which
 * doesn't scale past a couple dozen SKUs -- Y-axis labels overlapped into an unreadable smear.
 * All 3 charts now default to a small number of aggregate bars (2 for Fast/Slow Movers, up to 4
 * BCG-class bars for Overstock/Stock-Out Risk) and drill into the real product-level bar list on
 * click, same summary-then-drill convention PIM Contribution's donut already uses (see that
 * page's drillCategory state + breadcrumb pattern).
 */
export default function StockVelocityPage() {
  const { user, logout } = useAuth();
  const roleLabel = user?.role.label ?? user?.fullName;
  const [anchorDate, setAnchorDate] = useState('');

  const [company, setCompany] = useState<CompanyFilter>('All');
  const [category, setCategory] = useState<string[]>([]);
  const [band, setBand] = useState<'All' | 'Overstock' | 'Normal' | 'StockOutRisk'>('All');

  // ---- Drill-down state, one per chart -- null means "showing the aggregate summary". ----
  const [moversDrill, setMoversDrill] = useState<'Fast' | 'Slow' | null>(null);
  const [overstockDrill, setOverstockDrill] = useState<BcgClass | null>(null);
  const [riskDrill, setRiskDrill] = useState<BcgClass | null>(null);

  // ---- How many products a drilled-in chart shows before "Show more" -- same 20-then-+20
  // convention as Product Lifecycle's table (see that page's `limit` state). Reset to the initial
  // 20 whenever a *different* group is drilled into, so switching from one class to another
  // doesn't inherit however far "Show more" had been clicked on the previous one. ----
  const DRILL_PAGE_SIZE = 20;
  const [moversLimit, setMoversLimit] = useState(DRILL_PAGE_SIZE);
  const [overstockLimit, setOverstockLimit] = useState(DRILL_PAGE_SIZE);
  const [riskLimit, setRiskLimit] = useState(DRILL_PAGE_SIZE);

  /** Container height for a drilled-in per-product bar chart -- grows with the number of visible
   * rows instead of squeezing an arbitrary number of products into a fixed height, which is what
   * left product-name labels with almost no vertical space between rows and overlapping each
   * other. */
  const drillChartHeight = (rowCount: number) => Math.max(280, rowCount * 34 + 40);

  const withBand = useMemo(() => FACTS.map((r) => ({ ...r, _band: stockBand(r) })), []);

  const categoryOptions: SelectOption[] = useMemo(() => {
    const pool = withBand.filter((r) => company === 'All' || r.Company === company);
    return distinctSorted(pool.map((r) => r.Category)).map((c) => ({ value: c, label: c }));
  }, [withBand, company]);

  const filtered = useMemo(() => {
    return withBand.filter(
      (r) =>
        (company === 'All' || r.Company === company) &&
        (category.length === 0 || category.includes(r.Category)) &&
        (band === 'All' || r._band === band),
    );
  }, [withBand, company, category, band]);

  // ---- KPIs (6 -- Current Stock and Inventory Value added this pass) ----
  const totalVal = sum(filtered, (r) => r.total_value_YTD) || 1;
  const avgDOH = sum(filtered, (r) => r.days_of_inventory * r.total_value_YTD) / totalVal;
  const overRows = filtered.filter((r) => r._band === 'Overstock');
  const riskRows = filtered.filter((r) => r._band === 'StockOutRisk');
  const overValue = sum(overRows, (r) => r.current_stock_qty * r.avg_unit_price_YTD);
  const riskValue = sum(riskRows, (r) => r.total_value_YTD);
  const velocities = filtered.map((r) => r.avg_daily_sales_qty).sort((a, b) => a - b);
  const terc = velocities.length ? velocities[Math.floor((velocities.length * 2) / 3)] : 0;
  const fastCount = filtered.filter((r) => r.avg_daily_sales_qty >= terc).length;
  const currentStockQty = sum(filtered, (r) => r.current_stock_qty);
  const inventoryValue = sum(filtered, (r) => r.current_stock_qty * r.avg_unit_price_YTD);

  // ---- Fast vs Slow Movers ----
  // Median velocity split, not the KPI card's top-tercile definition -- that stat is deliberately
  // "top third by velocity" and stays self-contained; this chart needs every product sorted into
  // exactly 2 non-overlapping groups, which a median split does cleanly (a tercile split leaves a
  // middle third unaccounted for). The two numbers reading differently is expected, not a bug --
  // labeled explicitly below so it doesn't read as one.
  //
  // Summary bars plot each group's AVERAGE avg_daily_sales_qty (units/day), not SKU count -- this
  // is the Stock Velocity page, so the bar should say "how fast do these actually move", not "how
  // many of them are there" (a group with more SKUs isn't necessarily the faster-moving one). The
  // drilled-in view already plotted avg_daily_sales_qty per product; the summary now uses the same
  // field, just averaged per group, so switching between the two views doesn't change units.
  const velocityMedian = median(filtered.map((r) => r.avg_daily_sales_qty));
  const fastRows = filtered.filter((r) => r.avg_daily_sales_qty >= velocityMedian);
  const slowRows = filtered.filter((r) => r.avg_daily_sales_qty < velocityMedian);
  const fastAvgVelocity = fastRows.length ? sum(fastRows, (r) => r.avg_daily_sales_qty) / fastRows.length : 0;
  const slowAvgVelocity = slowRows.length ? sum(slowRows, (r) => r.avg_daily_sales_qty) / slowRows.length : 0;
  const moverSummaryPoints: GroupedBarChartPoint[] = [
    { label: 'Fast Movers', fast: fastAvgVelocity, slow: null },
    { label: 'Slow Movers', fast: null, slow: slowAvgVelocity },
  ];
  const moversDrillRowsAll =
    moversDrill === 'Fast'
      ? [...fastRows].sort((a, b) => b.avg_daily_sales_qty - a.avg_daily_sales_qty)
      : moversDrill === 'Slow'
        ? [...slowRows].sort((a, b) => a.avg_daily_sales_qty - b.avg_daily_sales_qty)
        : [];
  const moversDrillRows = moversDrillRowsAll.slice(0, moversLimit);
  const moversDrillPoints: GroupedBarChartPoint[] = moversDrillRows.map((r) => ({
    label: r.ProductName,
    velocity: r.avg_daily_sales_qty,
    _valueYTD: r.total_value_YTD,
    _volumeYTD: r.total_quantity_YTD,
    _class: r.bcg_class_YTD,
  }));

  // ---- Overstock: aggregate by BCG class (all 4, not just Strategic/Dogs -- a class with real
  // overstock shouldn't be invisible just because it wasn't one of the two originally called out),
  // sized by units currently in stock (current_stock_qty), not value tied up -- overstock is
  // fundamentally a "too many units sitting here" problem, and this is the Stock Velocity page, so
  // the volume dimension is what the chart leads with. `avg_unit_price_YTD` (and therefore the
  // dollar figure) is still available in the tooltip/PDF export, just not the sort/bar metric
  // anymore. Drill into a class shows its actual overstocked products, sorted by units descending
  // so the bar lengths stay visually consistent with the sort order. ----
  const overstockByClass = BCG_CLASSES.map((cls) => {
    const rows = overRows.filter((r) => r.bcg_class_YTD === cls);
    return { cls, rows, unitsInStock: sum(rows, (r) => r.current_stock_qty), count: rows.length };
  });
  const overstockSummaryPoints: GroupedBarChartPoint[] = overstockByClass
    .filter((c) => c.count > 0)
    .map((c) => ({ label: c.cls, unitsInStock: c.unitsInStock, _count: c.count }));
  const overstockDrillRowsAll = overstockDrill
    ? [...(overstockByClass.find((c) => c.cls === overstockDrill)?.rows ?? [])].sort((a, b) => b.current_stock_qty - a.current_stock_qty)
    : [];
  const overstockDrillRows = overstockDrillRowsAll.slice(0, overstockLimit);
  const overstockDrillPoints: GroupedBarChartPoint[] = overstockDrillRows.map((r) => ({
    label: r.ProductName,
    unitsInStock: r.current_stock_qty,
    _valueYTD: r.total_value_YTD,
    _volumeYTD: r.total_quantity_YTD,
    _class: r.bcg_class_YTD,
  }));

  // ---- Stock-out risk: same class-aggregate-then-drill pattern. Volume at risk (total_quantity_YTD)
  // now drives both the candidate filter (above-median VOLUME, not value) and the bar/sort metric,
  // for the same reason as Overstock above -- this page's primary lens is volume. "Urgency" keeps
  // its original shape (something / (DOH + 1), i.e. weighted by how little runway is left) but the
  // numerator switches from dollars to units, so sort order and displayed bar length stay
  // consistent with each other. ----
  const medianVol = median(filtered.map((r) => r.total_quantity_YTD));
  const riskCandidatesAll = riskRows.filter((r) => r.total_quantity_YTD > medianVol);
  const riskByClass = BCG_CLASSES.map((cls) => {
    const rows = riskCandidatesAll.filter((r) => r.bcg_class_YTD === cls);
    return { cls, rows, volumeAtRisk: sum(rows, (r) => r.total_quantity_YTD), count: rows.length };
  });
  const riskSummaryPoints: GroupedBarChartPoint[] = riskByClass
    .filter((c) => c.count > 0)
    .map((c) => ({ label: c.cls, volumeAtRisk: c.volumeAtRisk, _count: c.count }));
  const riskDrillRowsAll = riskDrill
    ? (riskByClass.find((c) => c.cls === riskDrill)?.rows ?? [])
        .map((r) => ({ ...r, _urgency: r.total_quantity_YTD / (r.days_of_inventory + 1) }))
        .sort((a, b) => b._urgency - a._urgency)
    : [];
  const riskDrillRows = riskDrillRowsAll.slice(0, riskLimit);
  const riskDrillPoints: GroupedBarChartPoint[] = riskDrillRows.map((r) => ({
    label: r.ProductName,
    volumeAtRisk: r.total_quantity_YTD,
    _valueYTD: r.total_value_YTD,
    _volumeYTD: r.total_quantity_YTD,
    _class: r.bcg_class_YTD,
  }));

  const handleExportOverstockPdf = () => {
    const rows = overstockDrill
      ? overstockDrillRowsAll
      : [...overRows].sort((a, b) => b.current_stock_qty - a.current_stock_qty);
    exportRowsAsPdf({
      title: 'Overstock Products',
      subtitle: `${company} · ${overstockDrill ?? 'All Classes'}`,
      columns: [
        { header: 'Product' },
        { header: 'BCG Class' },
        { header: 'DOH', align: 'right' },
        { header: 'Units in Stock', align: 'right' },
      ],
      rows: rows.map((r) => [r.ProductName, r.bcg_class_YTD, `${r.days_of_inventory.toFixed(0)}d`, fmtNum(r.current_stock_qty)]),
      fileName: 'stock-velocity-overstock',
    });
  };

  const handleExportRiskPdf = () => {
    const rows = riskDrill
      ? riskDrillRowsAll
      : riskCandidatesAll
          .map((r) => ({ ...r, _urgency: r.total_quantity_YTD / (r.days_of_inventory + 1) }))
          .sort((a, b) => b._urgency - a._urgency);
    exportRowsAsPdf({
      title: 'Stock-Out Risk',
      subtitle: `${company} · ${riskDrill ?? 'All Classes'}`,
      columns: [{ header: 'Product' }, { header: 'BCG Class' }, { header: 'DOH', align: 'right' }, { header: 'Volume YTD', align: 'right' }],
      rows: rows.map((r) => [r.ProductName, r.bcg_class_YTD, `${r.days_of_inventory.toFixed(0)}d`, fmtNum(r.total_quantity_YTD)]),
      fileName: 'stock-velocity-risk',
    });
  };

  // ---- Shared tooltip for every drilled-in product-level bar: the velocity/tied/at-risk metric
  // the bar itself represents, plus Value YTD / Volume YTD / Class every drill-down needs. ----
  const productDrillTooltip = (metricKey: string, metricLabel: string, metricFormatter: (v: number) => string) =>
    (point: GroupedBarChartPoint) => {
      const cls = point._class as BcgClass;
      return (
        <div
          style={{
            borderRadius: 10, border: '1px solid var(--ps-color-border)', fontSize: 12,
            background: 'var(--ps-color-surface)', color: 'var(--ps-color-text)', padding: '10px 12px', minWidth: 170,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 6 }}>{point.label}</div>
          <div style={{ marginBottom: 6 }}>
            <Pill color={BCG_COLOR[cls]} label={cls} />
          </div>
          <TooltipRow label={metricLabel} value={metricFormatter(point[metricKey] as number)} />
          <TooltipRow label="Value YTD" value={fmtLYD(point._valueYTD as number)} />
          <TooltipRow label="Volume YTD" value={fmtNum(point._volumeYTD as number)} />
        </div>
      );
    };

  const performanceRows = toExecutiveSummaryRows(avgDOH, overRows.length, overValue, riskRows.length, riskValue, fastCount, currentStockQty, inventoryValue);
  async function handleExportPerformanceTablePdf() {
    try {
      await exportPerformanceTablePdf({
        title: 'Performance Details',
        rows: performanceRows,
        columns: PERFORMANCE_PDF_COLUMNS,
        fileName: 'stock-velocity-performance-details',
      });
    } catch (err) {
      console.error('PDF export failed:', err);
    }
  }

  return (
    <PermissionGuard pageKey="stock_velocity">
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
            setBand('All');
          }}
          isPristine={company === 'All' && category.length === 0 && band === 'All'}
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
              <PillField label="Stock Band">
                {(['All', 'Overstock', 'Normal', 'StockOutRisk'] as const).map((b) => (
                  <Button key={b} variant={band === b ? 'primary' : 'secondary'} style={{ padding: '6px 12px', fontSize: 12.5 }} onClick={() => setBand(b)}>
                    {b === 'StockOutRisk' ? 'Stock-Out Risk' : b}
                  </Button>
                ))}
              </PillField>
            </>
          }
        />

        <main style={{ flex: 1, padding: 'var(--ps-space-4, 24px)', display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--ps-space-3, 16px)' }}>
            <KpiTile label="Avg Days of Inventory" value={`${Math.round(avgDOH)} days`} status="neutral" />
            <KpiTile label="Overstocked SKUs" value={String(overRows.length)} variance={fmtLYD(overValue) + ' tied up'} status="watch" />
            <KpiTile label="Stock-Out Risk SKUs" value={String(riskRows.length)} variance={fmtLYD(riskValue) + ' at risk'} status="alert" />
            <KpiTile label="Fast Movers (top velocity tercile)" value={String(fastCount)} status="success" />
            <KpiTile label="Current Stock" value={`${fmtNum(currentStockQty)} units`} status="neutral" />
            <KpiTile label="Inventory Value" value={fmtLYD(inventoryValue)} status="neutral" />
          </div>

          {/* Fast vs Slow Movers now stands alone at full width -- this used to share an
              11fr/9fr row with the "Days of Inventory -- by Company & BCG Class" panel, removed
              entirely (not hidden) per the redesign request. Giving this panel the freed width
              rather than leaving a grid column empty is what "close the gap cleanly" means here. */}
          <ChartPanel
            title="Fast vs Slow Movers"
            infoText={moversDrill ? `${moversDrill} movers — individual products, click Back to return to the summary` : 'Split at the median daily sales velocity — click a bar to see the products behind it'}
            style={{ minHeight: 480 }}
          >
            <DrillBreadcrumb active={moversDrill} rootLabel="Fast vs Slow" onReset={() => setMoversDrill(null)} />
            {moversDrill ? (
              <>
                <GroupedBarChart
                  showTitle={false}
                  points={moversDrillPoints}
                  bars={[{ key: 'velocity', name: `${moversDrill} movers`, color: moversDrill === 'Fast' ? 'var(--ps-color-success)' : 'var(--ps-color-alert)' }]}
                  valueFormatter={(v) => `${v.toFixed(1)}/day`}
                  tooltipContent={productDrillTooltip('velocity', 'Velocity', (v) => `${v.toFixed(1)}/day`)}
                  height={drillChartHeight(moversDrillPoints.length)}
                  yAxisWidth={150}
                />
                <ShowMoreFooter shown={moversDrillPoints.length} total={moversDrillRowsAll.length} onShowMore={() => setMoversLimit((l) => l + DRILL_PAGE_SIZE)} />
              </>
            ) : (
              <GroupedBarChart
                showTitle={false}
                points={moverSummaryPoints}
                bars={[
                  { key: 'fast', name: 'Fast movers', color: 'var(--ps-color-success)' },
                  { key: 'slow', name: 'Slow movers', color: 'var(--ps-color-alert)' },
                ]}
                valueFormatter={(v) => `${v.toFixed(1)} units/day`}
                onCategoryClick={(label) => {
                  setMoversDrill(label === 'Fast Movers' ? 'Fast' : 'Slow');
                  setMoversLimit(DRILL_PAGE_SIZE);
                }}
                height={400}
              />
            )}
          </ChartPanel>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--ps-space-3, 16px)' }}>
            <ChartPanel
              title="Overstock Products"
              infoText={overstockDrill ? `${overstockDrill} — units in stock, highest first` : 'By BCG class — units currently in stock for excess-stock products, click a class to drill in'}
              headerActions={<PdfButton label="Export as PDF" onClick={handleExportOverstockPdf} />}
            >
              <DrillBreadcrumb active={overstockDrill} rootLabel="All Classes" onReset={() => setOverstockDrill(null)} />
              {overstockDrill ? (
                <>
                  <GroupedBarChart
                    showTitle={false}
                    points={overstockDrillPoints}
                    bars={[{ key: 'unitsInStock', name: 'Units in stock', color: BCG_COLOR[overstockDrill] }]}
                    valueFormatter={(v) => `${fmtNum(v)} units`}
                    tooltipContent={productDrillTooltip('unitsInStock', 'Units in Stock', (v) => `${fmtNum(v)} units`)}
                    height={drillChartHeight(overstockDrillPoints.length)}
                    yAxisWidth={150}
                  />
                  <ShowMoreFooter shown={overstockDrillPoints.length} total={overstockDrillRowsAll.length} onShowMore={() => setOverstockLimit((l) => l + DRILL_PAGE_SIZE)} />
                </>
              ) : (
                <GroupedBarChart
                  showTitle={false}
                  points={overstockSummaryPoints}
                  bars={[{ key: 'unitsInStock', name: 'Units in stock', color: 'var(--ps-color-accent)' }]}
                  colorForPoint={(p) => BCG_COLOR[p.label as BcgClass]}
                  valueFormatter={(v) => `${fmtNum(v)} units`}
                  onCategoryClick={(label) => {
                    setOverstockDrill(label as BcgClass);
                    setOverstockLimit(DRILL_PAGE_SIZE);
                  }}
                />
              )}
            </ChartPanel>

            <ChartPanel
              title="Stock-Out Risk"
              infoText={riskDrill ? `${riskDrill} — sorted by urgency, highest first` : 'By BCG class — above-median volume, below-threshold stock, click a class to drill in'}
              headerActions={<PdfButton label="Export as PDF" onClick={handleExportRiskPdf} />}
            >
              <DrillBreadcrumb active={riskDrill} rootLabel="All Classes" onReset={() => setRiskDrill(null)} />
              {riskDrill ? (
                <>
                  <GroupedBarChart
                    showTitle={false}
                    points={riskDrillPoints}
                    bars={[{ key: 'volumeAtRisk', name: 'Volume at risk', color: 'var(--ps-color-alert)' }]}
                    valueFormatter={(v) => `${fmtNum(v)} units`}
                    tooltipContent={productDrillTooltip('volumeAtRisk', 'Volume at Risk', (v) => `${fmtNum(v)} units`)}
                    height={drillChartHeight(riskDrillPoints.length)}
                    yAxisWidth={150}
                  />
                  <ShowMoreFooter shown={riskDrillPoints.length} total={riskDrillRowsAll.length} onShowMore={() => setRiskLimit((l) => l + DRILL_PAGE_SIZE)} />
                </>
              ) : (
                <GroupedBarChart
                  showTitle={false}
                  points={riskSummaryPoints}
                  bars={[{ key: 'volumeAtRisk', name: 'Volume at risk', color: 'var(--ps-color-alert)' }]}
                  colorForPoint={(p) => BCG_COLOR[p.label as BcgClass]}
                  valueFormatter={(v) => `${fmtNum(v)} units`}
                  onCategoryClick={(label) => {
                    setRiskDrill(label as BcgClass);
                    setRiskLimit(DRILL_PAGE_SIZE);
                  }}
                />
              )}
            </ChartPanel>
          </div>

          <p style={{ textAlign: 'center', fontSize: 11, color: 'var(--ps-color-muted-text)', margin: 0 }}>
            Tika thresholds: Overstock &gt; 60 days · Stock-Out Risk &lt; 30 days &nbsp;|&nbsp; Majaal thresholds: Overstock &gt; 180 days · Stock-Out Risk &lt; 60 days
          </p>

          <PerformanceReportTable
            title="Performance Details"
            rows={performanceRows}
            showStatus
            showTakeaway
            onExportPdf={handleExportPerformanceTablePdf}
          />
        </main>

        <BottomNavBar active="Stock Velocity" />
      </div>
    </PermissionGuard>
  );
}

/** "Show more"/"Showing X of Y" footer for a drilled-in product chart -- same convention Product
 * Lifecycle's table uses for its own long list (see that page's `limit` state + button), reused
 * here instead of always cramming every product from a large BCG-class group into one chart. Renders
 * nothing once every row behind the current drill is already visible. */
function ShowMoreFooter({ shown, total, onShowMore }: { shown: number; total: number; onShowMore: () => void }) {
  if (shown >= total) return null;
  return (
    <div style={{ textAlign: 'center', marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center' }}>
      <Button variant="secondary" style={{ padding: '6px 16px', fontSize: 12 }} onClick={onShowMore}>
        Show more
      </Button>
      <span style={{ fontSize: 11, color: 'var(--ps-color-muted-text)' }}>
        Showing {shown} of {total}
      </span>
    </div>
  );
}

/** Breadcrumb back to the aggregate summary -- same "plain text when at root, clickable link +
 * chevron + current label when drilled" convention PIM Contribution's donut drill-down already
 * uses (see that page's Category → Range breadcrumb). Shared here across all 3 drill-down charts
 * on this page rather than copied 3 times inline. */
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

/** Colored pill -- same treatment used for BCG Class on the BCG Matrix page's KPI cards/bubble
 * tooltip, duplicated locally per this module's established per-page-helper convention (see
 * PdfButton/PillField below, and bcg-matrix/page.tsx's own copy). */
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

/** Label/value row for a drilled-in product bar's tooltip -- same right-aligned value convention
 * used elsewhere in this module's tooltips. */
function TooltipRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, lineHeight: 1.7 }}>
      <span style={{ color: 'var(--ps-color-muted-text)' }}>{label}</span>
      <span style={{ fontWeight: 600, color: 'var(--ps-color-text)' }}>{value}</span>
    </div>
  );
}

/** Same bordered-pill "Export as PDF" convention every other report page's ChartPanel
 * headerActions uses (see pipeline-health/page.tsx's PdfButton) -- duplicated locally per that
 * same established per-page convention, not centralized in @07ps/ui. */
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
