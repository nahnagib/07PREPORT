'use client';
import React, { useMemo, useState } from 'react';
import { AppHeader } from '../../../../components/AppHeader';
import { BottomNavBar } from '../../../../components/BottomNavBar';
import { FilterBar } from '../../../../components/FilterBar';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useFilterState } from '../../../../components/FilterProvider';
import { ProductDataStatusBar, ProductRefreshFooter } from '../../../../components/ProductDataStatus';
import { useAuth } from '../../../../lib/AuthProvider';
import { useProductDashboard, useRefreshStatus } from '../../../../lib/hooks';
import {
  ChartPanel,
  KpiTile,
  Select,
  Button,
  GroupedBarChart,
  LoadingSkeleton,
  ErrorState,
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
  toProductFacts,
  isOverstocked,
  fmtLYD,
  fmtNum,
  fmtVolume,
  median,
  sum,
  distinctSorted,
  BCG_COLOR,
  COMPANIES,
  STOCK_BAND_LABEL,
  type CompanyFilter,
  type ProductFact,
} from '../../../../lib/materialsAnalogy/shared';

/** Class buckets for the Overstock / Stock-out charts: the 4 BCG classes, products sold YTD without a
 * standard cost, and products with no sales this year (e.g. overstock that never sold). */
const CLASS_BUCKETS = ['Stars', 'Cash Cows', 'Strategic', 'Dogs', 'Unclassified (no cost)', 'No sales YTD'] as const;
type ClassBucket = (typeof CLASS_BUCKETS)[number];
const bucketOf = (r: ProductFact): ClassBucket => (r.bcg_class_YTD ?? 'No sales YTD') as ClassBucket;
const bucketColor = (b: ClassBucket) => BCG_COLOR[b] ?? 'var(--ps-color-neutral-text)';

type BandFilter = 'All' | 'Overstock' | 'Normal' | 'StockOutRisk';

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

function toExecutiveSummaryRows(
  avgDOH: number | null,
  overCount: number,
  overValue: number,
  riskCount: number,
  riskValue: number,
  fastCount: number,
  skusInStock: number,
  inventoryValue: number,
  inTransitValue: number,
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
    row('avgDOH', 'Avg Days of Inventory', avgDOH === null ? '—' : `${Math.round(avgDOH)} days`, 'neutral', avgDOH === null ? 'No product has both stock and sales in the look-back window.' : `Sales-value-weighted average of ${Math.round(avgDOH)} days on hand.`),
    row('overstocked', 'Overstocked SKUs', String(overCount), 'watch', `${overCount} SKUs are overstocked or not moving, tying up ${fmtLYD(overValue)} at stock valuation.`),
    row('stockOutRisk', 'Stock-Out Risk SKUs', String(riskCount), 'alert', `${riskCount} SKUs are at stock-out risk; they sold ${fmtLYD(riskValue)} in the period.`),
    row('fastMovers', 'Fast Movers (top velocity tercile)', String(fastCount), 'success', `${fastCount} SKUs are in the fastest-moving third of products sold in the period.`),
    row('inStock', 'SKUs in Stock', String(skusInStock), 'neutral', `${skusInStock} SKUs have finished-goods stock on hand.`),
    row('inventoryValue', 'Inventory Value', fmtLYD(inventoryValue), 'neutral', `On-hand stock is valued at ${fmtLYD(inventoryValue)}; a further ${fmtLYD(inTransitValue)} is in transit.`),
  ];
}

/**
 * Stock Velocity -- live data (useProductDashboard). Velocity = invoiced quantity in the selected period
 * / days in the period; stock, days of inventory and the stock band are as of the last ETL run
 * (finished-goods internal locations, 90-day look-back, company thresholds from the ETL config).
 * Quantities are never added across units of measure: aggregate bars use LYD or SKU counts, and every
 * per-product quantity carries its own unit.
 */
export default function StockVelocityPage() {
  const { user, token, error: authError, retryAuth, logout } = useAuth();
  const roleLabel = user?.role.label ?? user?.fullName;
  const { anchorDate, onAnchorDateChange, dateFromDate, dateToDate, onDateRangeChange } = useFilterState();
  const refresh = useRefreshStatus(token, authError, retryAuth);

  const [company, setCompany] = useState<CompanyFilter>('All');
  // Company view vs BMH view comes from the API: with no company, a product both companies sell is one
  // combined row (value/volume = Majaal + Tika, ratios recomputed); with a company, only its part.
  const overview = useProductDashboard(token, authError, retryAuth, 'stock-velocity', { fromDate: dateFromDate, toDate: dateToDate, company });
  const facts = useMemo(() => toProductFacts(overview.data), [overview.data]);
  const [category, setCategory] = useState<string[]>([]);
  const [band, setBand] = useState<BandFilter>('All');

  const [moversDrill, setMoversDrill] = useState<'Fast' | 'Slow' | null>(null);
  const [overstockDrill, setOverstockDrill] = useState<ClassBucket | null>(null);
  const [riskDrill, setRiskDrill] = useState<ClassBucket | null>(null);

  const DRILL_PAGE_SIZE = 20;
  const [moversLimit, setMoversLimit] = useState(DRILL_PAGE_SIZE);
  const [overstockLimit, setOverstockLimit] = useState(DRILL_PAGE_SIZE);
  const [riskLimit, setRiskLimit] = useState(DRILL_PAGE_SIZE);
  const drillChartHeight = (rowCount: number) => Math.max(280, rowCount * 34 + 40);

  const categoryOptions: SelectOption[] = useMemo(() => {
    const pool = facts.filter((r) => company === 'All' || r.Company === company);
    return distinctSorted(pool.map((r) => r.Category)).map((c) => ({ value: c, label: c }));
  }, [facts, company]);

  const bandMatches = (r: ProductFact) =>
    band === 'All' || (band === 'Overstock' ? isOverstocked(r) : band === 'Normal' ? r.stockBand === 'Normal' : r.stockBand === 'StockOutRisk');

  const filtered = useMemo(
    () =>
      facts.filter(
        (r) => (company === 'All' || r.Company === company) && (category.length === 0 || (r.Category !== null && category.includes(r.Category))) && bandMatches(r),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [facts, company, category, band],
  );

  // ---- KPIs ----
  // Existing rule: DOH averaged over products weighted by their sales value in the period, so the KPI
  // reflects the portfolio that actually sells (stock with no sales has no DOH and no weight).
  const withDoh = filtered.filter((r) => r.daysOfInventory !== null && r.value > 0);
  const dohWeight = sum(withDoh, (r) => r.value);
  const avgDOH = dohWeight > 0 ? sum(withDoh, (r) => (r.daysOfInventory as number) * r.value) / dohWeight : null;
  const overRows = filtered.filter(isOverstocked);
  const riskRows = filtered.filter((r) => r.stockBand === 'StockOutRisk');
  const overValue = sum(overRows, (r) => r.stockValue);
  const riskValue = sum(riskRows, (r) => r.value);
  // Movers = products that sold in the period (positive value and quantity, single unit). Discount
  // pseudo-products (negative value) are not product movement.
  const moving = filtered.filter((r) => r.velocity !== null && r.velocity > 0 && r.value > 0);
  const velocities = moving.map((r) => r.velocity as number).sort((a, b) => a - b);
  const terc = velocities.length ? velocities[Math.floor((velocities.length * 2) / 3)] : 0;
  const fastCount = moving.filter((r) => (r.velocity as number) >= terc).length;
  const skusInStock = filtered.filter((r) => r.stockQty > 0).length;
  const inventoryValue = sum(filtered, (r) => r.stockValue);
  const inTransitValue = sum(filtered, (r) => r.inTransitValue);

  // ---- Fast vs Slow Movers: median split of velocity over products that sold in the period (the
  // existing rule). Summary bars show the value each group sold (LYD), not an average of unit
  // velocities, because units differ between products. ----
  const velocityMedian = median(moving.map((r) => r.velocity as number));
  const fastRows = moving.filter((r) => (r.velocity as number) >= velocityMedian);
  const slowRows = moving.filter((r) => (r.velocity as number) < velocityMedian);
  const moverSummaryPoints: GroupedBarChartPoint[] = [
    { label: 'Fast Movers', fast: sum(fastRows, (r) => r.value), slow: null, _count: fastRows.length },
    { label: 'Slow Movers', fast: null, slow: sum(slowRows, (r) => r.value), _count: slowRows.length },
  ];
  const moversDrillRowsAll =
    moversDrill === 'Fast'
      ? [...fastRows].sort((a, b) => (b.velocity as number) - (a.velocity as number))
      : moversDrill === 'Slow'
        ? [...slowRows].sort((a, b) => (a.velocity as number) - (b.velocity as number))
        : [];
  const moversDrillRows = moversDrillRowsAll.slice(0, moversLimit);
  const moversDrillPoints: GroupedBarChartPoint[] = moversDrillRows.map((r) => ({
    label: r.ProductName,
    velocity: r.velocity as number,
    _unit: r.uom ?? '',
    _value: r.value,
    _volume: fmtVolume(r),
    _class: bucketOf(r),
  }));

  // ---- Overstock by class: LYD tied up at stock valuation ----
  const overstockByClass = CLASS_BUCKETS.map((cls) => {
    const rows = overRows.filter((r) => bucketOf(r) === cls);
    return { cls, rows, tiedUp: sum(rows, (r) => r.stockValue), count: rows.length };
  });
  const overstockSummaryPoints: GroupedBarChartPoint[] = overstockByClass
    .filter((c) => c.count > 0)
    .map((c) => ({ label: c.cls, tiedUp: c.tiedUp, _count: c.count }));
  const overstockDrillRowsAll = overstockDrill
    ? [...(overstockByClass.find((c) => c.cls === overstockDrill)?.rows ?? [])].sort((a, b) => b.stockValue - a.stockValue)
    : [];
  const overstockDrillRows = overstockDrillRowsAll.slice(0, overstockLimit);
  const overstockDrillPoints: GroupedBarChartPoint[] = overstockDrillRows.map((r) => ({
    label: r.ProductName,
    tiedUp: r.stockValue,
    _value: r.value,
    _volume: fmtVolume(r),
    _doh: r.daysOfInventory,
    _class: bucketOf(r),
  }));

  // ---- Stock-out risk: above-median period value, below-threshold days of inventory; urgency =
  // value / (DOH + 1) ----
  const medianValue = median(filtered.map((r) => r.value));
  const riskCandidatesAll = riskRows.filter((r) => r.value > medianValue);
  const riskByClass = CLASS_BUCKETS.map((cls) => {
    const rows = riskCandidatesAll.filter((r) => bucketOf(r) === cls);
    return { cls, rows, valueAtRisk: sum(rows, (r) => r.value), count: rows.length };
  });
  const riskSummaryPoints: GroupedBarChartPoint[] = riskByClass
    .filter((c) => c.count > 0)
    .map((c) => ({ label: c.cls, valueAtRisk: c.valueAtRisk, _count: c.count }));
  const urgency = (r: ProductFact) => r.value / ((r.daysOfInventory ?? 0) + 1);
  const riskDrillRowsAll = riskDrill
    ? [...(riskByClass.find((c) => c.cls === riskDrill)?.rows ?? [])].sort((a, b) => urgency(b) - urgency(a))
    : [];
  const riskDrillRows = riskDrillRowsAll.slice(0, riskLimit);
  const riskDrillPoints: GroupedBarChartPoint[] = riskDrillRows.map((r) => ({
    label: r.ProductName,
    valueAtRisk: r.value,
    _value: r.value,
    _volume: fmtVolume(r),
    _doh: r.daysOfInventory,
    _class: bucketOf(r),
  }));

  const dohLabel = (r: ProductFact) => (r.daysOfInventory === null ? (r.stockQty > 0 ? 'no sales' : '—') : `${r.daysOfInventory.toFixed(0)}d`);

  const handleExportOverstockPdf = () => {
    const rows = overstockDrill ? overstockDrillRowsAll : [...overRows].sort((a, b) => b.stockValue - a.stockValue);
    exportRowsAsPdf({
      title: 'Overstock Products',
      subtitle: `${company} · ${overstockDrill ?? 'All Classes'}`,
      columns: [{ header: 'Product' }, { header: 'Company' }, { header: 'Class' }, { header: 'Band' }, { header: 'DOH', align: 'right' }, { header: 'Stock', align: 'right' }, { header: 'LYD tied up', align: 'right' }],
      rows: rows.map((r) => [r.ProductName, r.Company, bucketOf(r), STOCK_BAND_LABEL[r.stockBand], dohLabel(r), `${fmtNum(r.stockQty)}${r.uom ? ` ${r.uom}` : ''}`, fmtLYD(r.stockValue)]),
      fileName: 'stock-velocity-overstock',
    });
  };

  const handleExportRiskPdf = () => {
    const rows = riskDrill ? riskDrillRowsAll : [...riskCandidatesAll].sort((a, b) => urgency(b) - urgency(a));
    exportRowsAsPdf({
      title: 'Stock-Out Risk',
      subtitle: `${company} · ${riskDrill ?? 'All Classes'}`,
      columns: [{ header: 'Product' }, { header: 'Company' }, { header: 'Class' }, { header: 'DOH', align: 'right' }, { header: 'Volume', align: 'right' }, { header: 'Value', align: 'right' }],
      rows: rows.map((r) => [r.ProductName, r.Company, bucketOf(r), dohLabel(r), fmtVolume(r), fmtLYD(r.value)]),
      fileName: 'stock-velocity-risk',
    });
  };

  const productDrillTooltip = (metricKey: string, metricLabel: string, metricFormatter: (point: GroupedBarChartPoint) => string) =>
    function ProductDrillTooltip(point: GroupedBarChartPoint) {
      const cls = point._class as ClassBucket;
      return (
        <div
          style={{
            borderRadius: 10, border: '1px solid var(--ps-color-border)', fontSize: 12,
            background: 'var(--ps-color-surface)', color: 'var(--ps-color-text)', padding: '10px 12px', minWidth: 190,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 6 }}>{point.label}</div>
          <div style={{ marginBottom: 6 }}>
            <Pill color={bucketColor(cls)} label={cls} />
          </div>
          <TooltipRow label={metricLabel} value={metricFormatter(point)} />
          <TooltipRow label="Value (period)" value={fmtLYD(point._value as number)} />
          <TooltipRow label="Volume (period)" value={String(point._volume)} />
          {metricKey !== 'velocity' ? <TooltipRow label="Days of inventory" value={point._doh === null || point._doh === undefined ? '—' : `${Number(point._doh).toFixed(0)}d`} /> : null}
        </div>
      );
    };

  const performanceRows = toExecutiveSummaryRows(avgDOH, overRows.length, overValue, riskRows.length, riskValue, fastCount, skusInStock, inventoryValue, inTransitValue);
  async function handleExportPerformanceTablePdf() {
    try {
      await exportPerformanceTablePdf({ title: 'Performance Details', rows: performanceRows, columns: PERFORMANCE_PDF_COLUMNS, fileName: 'stock-velocity-performance-details' });
    } catch (err) {
      console.error('PDF export failed:', err);
    }
  }

  const thresholds = overview.data?.thresholds.days_of_inventory;
  const lookback = overview.data?.lookbackDays ?? 90;

  return (
    <PermissionGuard pageKey="stock_velocity">
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', paddingBottom: 64 }}>
        <AppHeader pageTitle="Product Dashboard" anchorDate={anchorDate} onAnchorDateChange={onAnchorDateChange} roleLabel={roleLabel} onLogout={logout} showDateInput={false} />

        <FilterBar
          onReset={() => {
            setCompany('All');
            setCategory([]);
            setBand('All');
          }}
          isPristine={company === 'All' && category.length === 0 && band === 'All'}
          showDateRange
          dateFromDate={dateFromDate}
          dateToDate={dateToDate}
          onDateRangeChange={onDateRangeChange}
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

        <ProductDataStatusBar refresh={refresh.data} data={overview.data} />

        <main style={{ flex: 1, padding: 'var(--ps-space-4, 24px)', display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)' }}>
          {overview.loading && !overview.data ? (
            <LoadingSkeleton variant="chart" />
          ) : overview.error ? (
            <ErrorState message={overview.error} onRetry={overview.retry} />
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--ps-space-3, 16px)' }}>
                <KpiTile label="Avg Days of Inventory" value={avgDOH === null ? '—' : `${Math.round(avgDOH)} days`} variance={`${lookback}-day sales look-back`} status="neutral" />
                <KpiTile label="Overstocked SKUs" value={String(overRows.length)} variance={fmtLYD(overValue) + ' tied up'} status="watch" />
                <KpiTile label="Stock-Out Risk SKUs" value={String(riskRows.length)} variance={fmtLYD(riskValue) + ' sold in period'} status="alert" />
                <KpiTile label="Fast Movers (top velocity tercile)" value={String(fastCount)} variance={`of ${moving.length} SKUs sold in period`} status="success" />
                <KpiTile label="SKUs in Stock" value={String(skusInStock)} variance="finished-goods locations" status="neutral" />
                <KpiTile label="Inventory Value" value={fmtLYD(inventoryValue)} variance={`+ ${fmtLYD(inTransitValue)} in transit`} status="neutral" />
              </div>

              <ChartPanel
                title="Fast vs Slow Movers"
                infoText={
                  moversDrill
                    ? `${moversDrill} movers — velocity = volume in the period ÷ ${overview.data?.period.days ?? '—'} days, in each product's own unit`
                    : 'Products that sold in the period, split at the median daily velocity. Bars = value sold (LYD); click a bar to see the products'
                }
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
                      tooltipContent={productDrillTooltip('velocity', 'Velocity', (p) => `${(p.velocity as number).toFixed(2)} ${p._unit || 'units'}/day`)}
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
                    valueFormatter={(v) => fmtLYD(v)}
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
                  infoText={overstockDrill ? `${overstockDrill} — LYD tied up at stock valuation, highest first` : 'By BCG class — LYD tied up in overstocked or non-moving stock, click a class to drill in'}
                  headerActions={<PdfButton label="Export as PDF" onClick={handleExportOverstockPdf} />}
                >
                  <DrillBreadcrumb active={overstockDrill} rootLabel="All Classes" onReset={() => setOverstockDrill(null)} />
                  {overstockDrill ? (
                    <>
                      <GroupedBarChart
                        showTitle={false}
                        points={overstockDrillPoints}
                        bars={[{ key: 'tiedUp', name: 'LYD tied up', color: bucketColor(overstockDrill) }]}
                        valueFormatter={(v) => fmtLYD(v)}
                        tooltipContent={productDrillTooltip('tiedUp', 'LYD tied up', (p) => fmtLYD(p.tiedUp as number))}
                        height={drillChartHeight(overstockDrillPoints.length)}
                        yAxisWidth={150}
                      />
                      <ShowMoreFooter shown={overstockDrillPoints.length} total={overstockDrillRowsAll.length} onShowMore={() => setOverstockLimit((l) => l + DRILL_PAGE_SIZE)} />
                    </>
                  ) : (
                    <GroupedBarChart
                      showTitle={false}
                      points={overstockSummaryPoints}
                      bars={[{ key: 'tiedUp', name: 'LYD tied up', color: 'var(--ps-color-accent)' }]}
                      colorForPoint={(p) => bucketColor(p.label as ClassBucket)}
                      valueFormatter={(v) => fmtLYD(v)}
                      onCategoryClick={(label) => {
                        setOverstockDrill(label as ClassBucket);
                        setOverstockLimit(DRILL_PAGE_SIZE);
                      }}
                    />
                  )}
                </ChartPanel>

                <ChartPanel
                  title="Stock-Out Risk"
                  infoText={riskDrill ? `${riskDrill} — sorted by urgency, highest first` : 'By BCG class — above-median sellers below the stock-out threshold, click a class to drill in'}
                  headerActions={<PdfButton label="Export as PDF" onClick={handleExportRiskPdf} />}
                >
                  <DrillBreadcrumb active={riskDrill} rootLabel="All Classes" onReset={() => setRiskDrill(null)} />
                  {riskDrill ? (
                    <>
                      <GroupedBarChart
                        showTitle={false}
                        points={riskDrillPoints}
                        bars={[{ key: 'valueAtRisk', name: 'Value sold (period)', color: 'var(--ps-color-alert)' }]}
                        valueFormatter={(v) => fmtLYD(v)}
                        tooltipContent={productDrillTooltip('valueAtRisk', 'Value at risk', (p) => fmtLYD(p.valueAtRisk as number))}
                        height={drillChartHeight(riskDrillPoints.length)}
                        yAxisWidth={150}
                      />
                      <ShowMoreFooter shown={riskDrillPoints.length} total={riskDrillRowsAll.length} onShowMore={() => setRiskLimit((l) => l + DRILL_PAGE_SIZE)} />
                    </>
                  ) : (
                    <GroupedBarChart
                      showTitle={false}
                      points={riskSummaryPoints}
                      bars={[{ key: 'valueAtRisk', name: 'Value sold (period)', color: 'var(--ps-color-alert)' }]}
                      colorForPoint={(p) => bucketColor(p.label as ClassBucket)}
                      valueFormatter={(v) => fmtLYD(v)}
                      onCategoryClick={(label) => {
                        setRiskDrill(label as ClassBucket);
                        setRiskLimit(DRILL_PAGE_SIZE);
                      }}
                    />
                  )}
                </ChartPanel>
              </div>

              <p style={{ textAlign: 'center', fontSize: 11, color: 'var(--ps-color-muted-text)', margin: 0 }}>
                Days of inventory = finished-goods stock ÷ average daily sales over the last {lookback} days. Tika: Overstock &gt; {thresholds?.overstock_days?.Tika ?? 60} days · Stock-Out Risk &lt;{' '}
                {thresholds?.stockout_risk_days?.Tika ?? 30} days | Majaal: Overstock &gt; {thresholds?.overstock_days?.Majaal ?? 180} days · Stock-Out Risk &lt; {thresholds?.stockout_risk_days?.Majaal ?? 60} days. Stock with no
                sales in {lookback} days counts as Overstocked (no movement). In-transit and raw-materials stock are not on hand.
                With no company selected, a product both companies sell is one row: combined stock ÷ combined daily sales, with the
                thresholds of the company that sold more of it this year.
              </p>

              <PerformanceReportTable title="Performance Details" rows={performanceRows} showStatus showTakeaway onExportPdf={handleExportPerformanceTablePdf} />
            </>
          )}
        </main>

        <ProductRefreshFooter refresh={refresh.data} />
        <BottomNavBar active="Stock Velocity" />
      </div>
    </PermissionGuard>
  );
}

/** "Show more"/"Showing X of Y" footer for a drilled-in product chart. */
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

/** Breadcrumb back to the aggregate summary. */
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

function TooltipRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, lineHeight: 1.7 }}>
      <span style={{ color: 'var(--ps-color-muted-text)' }}>{label}</span>
      <span style={{ fontWeight: 600, color: 'var(--ps-color-text)' }}>{value}</span>
    </div>
  );
}

function PdfButton({ label, onClick }: { label: string; onClick: () => void }) {
  const canExport = useCanExport();
  if (!canExport) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600,
        color: 'var(--ps-color-muted-text)', background: 'var(--ps-color-muted-bg)',
        border: '1px solid var(--ps-color-border)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}

function PillField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <span style={{ display: 'block', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--ps-color-muted-text)', marginBottom: 4 }}>{label}</span>
      <div style={{ display: 'flex', gap: 6, height: 38, alignItems: 'center' }}>{children}</div>
    </div>
  );
}
