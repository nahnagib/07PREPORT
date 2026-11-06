'use client';
import { vh } from '../../../../lib/visualHelp';
import React, { useMemo, useState } from 'react';
import { AppHeader } from '../../../../components/AppHeader';
import { BottomNavBar } from '../../../../components/BottomNavBar';
import { FilterBar } from '../../../../components/FilterBar';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useFilterState } from '../../../../components/FilterProvider';
import { ValidationStatusBar } from '../../../../components/ValidationStatusBar';
import { RefreshFooter } from '../../../../components/RefreshFooter';
import { formatTimestamp } from '../../../../lib/format';
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
  type SelectOption,
  type GroupedBarChartPoint,
  tooltipBoxStyle,
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
  FREQUENCY_BUCKETS,
  FREQUENCY_BUCKET_LABEL,
  FREQUENCY_COLOR,
  averageSaleGap,
  fmtDate,
  frequencyBucket,
  type CompanyFilter,
  type FrequencyBucket,
  type ProductFact,
} from '../../../../lib/materialsAnalogy/shared';
import { ProductBarChart, type ProductBar } from '../../../../components/product/ProductBarChart';
import {
  ExportButtons,
  ltrLabel,
  Pill,
  ProductName,
  ProductTooltip,
  SortableProductTable,
  TooltipRow,
  exportProductCsv,
  exportProductPdf,
  type ExportColumn,
  type SortableColumn,
} from '../../../../components/product/ProductUi';

/** Class buckets for the Overstock / Stock-out charts: the 4 BCG classes, products sold YTD without a
 * standard cost, and products with no sales this year (e.g. overstock that never sold). */
const CLASS_BUCKETS = ['Stars', 'Cash Cows', 'Strategic', 'Dogs', 'Unclassified (no cost)', 'No sales YTD'] as const;
type ClassBucket = (typeof CLASS_BUCKETS)[number];
const bucketOf = (r: ProductFact): ClassBucket => (r.bcg_class_YTD ?? 'No sales YTD') as ClassBucket;
const bucketColor = (b: ClassBucket) => BCG_COLOR[b] ?? 'var(--ps-color-neutral-text)';

type BandFilter = 'All' | 'Overstock' | 'Normal' | 'StockOutRisk';

const dohLabel = (r: ProductFact) => (r.daysOfInventory === null ? (r.stockQty > 0 ? 'no sales' : '—') : `${r.daysOfInventory.toFixed(0)}d`);
const BASE_EXPORT: ExportColumn<ProductFact>[] = [
  { header: 'Product Name', value: (r) => ltrLabel(r.ProductName) },
  { header: 'Company', value: (r) => r.Company },
  { header: 'Odoo ID', value: (r) => r.ProductKey },
  { header: 'Category', value: (r) => r.Category },
  { header: 'Class', value: (r) => bucketOf(r) },
];
const OVERSTOCK_EXPORT: ExportColumn<ProductFact>[] = [
  ...BASE_EXPORT,
  { header: 'Band', value: (r) => STOCK_BAND_LABEL[r.stockBand] },
  { header: 'Days of inventory', align: 'right', value: (r) => r.daysOfInventory, text: dohLabel },
  { header: 'Stock', align: 'right', value: (r) => r.stockQty, text: (r) => fmtNum(r.stockQty) },
  { header: 'Unit', value: (r) => r.uom },
  { header: 'LYD tied up', align: 'right', value: (r) => r.stockValue, text: (r) => fmtLYD(r.stockValue) },
];
const RISK_EXPORT: ExportColumn<ProductFact>[] = [
  ...BASE_EXPORT,
  { header: 'Days of inventory', align: 'right', value: (r) => r.daysOfInventory, text: dohLabel },
  { header: 'Volume (period)', align: 'right', value: (r) => r.volume, text: (r) => fmtVolume(r) },
  { header: 'Unit', value: (r) => r.uom },
  { header: 'Value (period, LYD)', align: 'right', value: (r) => r.value, text: (r) => fmtLYD(r.value) },
];

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
  // Company view (one company) or all companies side by side; a product is always one Odoo product in one company.
  const overview = useProductDashboard(token, authError, retryAuth, 'stock-velocity', { fromDate: dateFromDate, toDate: dateToDate, company });
  const facts = useMemo(() => toProductFacts(overview.data), [overview.data]);
  const [category, setCategory] = useState<string[]>([]);
  const [band, setBand] = useState<BandFilter>('All');

  const [moversDrill, setMoversDrill] = useState<'Fast' | 'Slow' | null>(null);
  const [overstockDrill, setOverstockDrill] = useState<ClassBucket | null>(null);
  const [riskDrill, setRiskDrill] = useState<ClassBucket | null>(null);
  const [frequencyDrill, setFrequencyDrill] = useState<FrequencyBucket | null>(null);

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
  const unitPerDay = (r: ProductFact, precision?: number) => {
    const velocity = r.velocity ?? 0;
    return `${velocity.toFixed(precision ?? (velocity >= 10 ? 0 : 2))} ${r.uom || 'units'}/day`;
  };
  const toBars = (rows: ProductFact[], value: (r: ProductFact) => number, label: (r: ProductFact) => string): ProductBar[] =>
    rows.map((r) => ({ id: r.id, name: r.ProductName, company: r.Company, value: value(r), valueLabel: label(r) }));
  const moversDrillBars = toBars(moversDrillRowsAll, (r) => r.velocity as number, unitPerDay);

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
  const overstockDrillBars = toBars(overstockDrillRowsAll, (r) => r.stockValue, (r) => fmtLYD(r.stockValue));

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
  const riskDrillBars = toBars(riskDrillRowsAll, (r) => r.value, (r) => fmtLYD(r.value));
  const factById = new Map(filtered.map((r) => [r.id, r]));

  // ---- Sales Frequency: distinct selling days in the period -> average gap -> Daily / Weekly / Monthly / Rarer ----
  const periodDays = overview.data?.period.days ?? 0;
  const sold = filtered.filter((r) => r.orderDays > 0 && r.value > 0);
  const frequencyGroups = FREQUENCY_BUCKETS.map((b) => {
    const rows = sold.filter((r) => frequencyBucket(r.orderDays, periodDays) === b);
    return { bucket: b, rows, revenue: sum(rows, (r) => r.value), count: rows.length };
  });
  const frequencyPoints: GroupedBarChartPoint[] = frequencyGroups.map((g) => ({ label: FREQUENCY_BUCKET_LABEL[g.bucket], revenue: g.revenue, _count: g.count, _bucket: g.bucket }));
  const frequencyRows = frequencyDrill ? frequencyGroups.find((g) => g.bucket === frequencyDrill)?.rows ?? [] : [];
  const FREQUENCY_COLUMNS: SortableColumn<ProductFact>[] = [
    { key: 'name', header: 'Product', value: (r) => r.ProductName, sortValue: (r) => r.ProductName, render: (r) => <ProductName name={r.ProductName} /> },
    { key: 'company', header: 'Company', value: (r) => r.Company, sortValue: (r) => r.Company, render: (r) => r.Company },
    { key: 'category', header: 'Category', value: (r) => r.Category, sortValue: (r) => r.Category, render: (r) => <ProductName name={r.Category ?? '—'} /> },
    { key: 'days', header: 'Selling days', align: 'right', value: (r) => r.orderDays, sortValue: (r) => r.orderDays, render: (r) => String(r.orderDays) },
    {
      key: 'gap', header: 'Avg gap (days)', align: 'right',
      value: (r) => { const g = averageSaleGap(r.orderDays, periodDays); return g === null ? null : Math.round(g * 10) / 10; },
      sortValue: (r) => averageSaleGap(r.orderDays, periodDays),
      render: (r) => { const g = averageSaleGap(r.orderDays, periodDays); return g === null ? '—' : g.toFixed(1); },
    },
    { key: 'revenue', header: 'Revenue (period)', align: 'right', value: (r) => r.value, text: (r) => fmtLYD(r.value), sortValue: (r) => r.value, render: (r) => fmtLYD(r.value) },
    { key: 'volume', header: 'Volume (period)', align: 'right', value: (r) => r.volume, text: (r) => fmtVolume(r), sortValue: (r) => r.volume, render: (r) => fmtVolume(r) },
    { key: 'unit', header: 'Unit', value: (r) => r.uom, sortValue: (r) => r.uom, render: (r) => r.uom ?? '—' },
    { key: 'last', header: 'Last sale', value: (r) => r.lastSaleDate, text: (r) => fmtDate(r.lastSaleDate), sortValue: (r) => r.lastSaleDate, render: (r) => fmtDate(r.lastSaleDate) },
  ];

  const overstockExportRows = () => (overstockDrill ? overstockDrillRowsAll : [...overRows].sort((a, b) => b.stockValue - a.stockValue));
  const riskExportRows = () => (riskDrill ? riskDrillRowsAll : [...riskCandidatesAll].sort((a, b) => urgency(b) - urgency(a)));
  const companyLabel = company === 'All' ? 'Majaal + Tika' : company;

  const MOVERS_EXPORT: ExportColumn<ProductFact>[] = [
    ...BASE_EXPORT,
    { header: 'Velocity (per day)', align: 'right', value: (r) => r.velocity, text: (r) => unitPerDay(r, 2) },
    { header: 'Unit', value: (r) => r.uom },
    { header: 'Volume (period)', align: 'right', value: (r) => r.volume, text: (r) => fmtVolume(r) },
    { header: 'Value (period, LYD)', align: 'right', value: (r) => r.value, text: (r) => fmtLYD(r.value) },
  ];

  /** Hover detail of a drilled product bar: company + class badges, the bar's metric, value, volume, days of inventory. */
  const drillTooltip = (metricLabel: string, metric: (r: ProductFact) => string, showDoh: boolean) =>
    function DrillTooltip(bar: ProductBar) {
      const r = factById.get(bar.id);
      if (!r) return null;
      const cls = bucketOf(r);
      return (
        <ProductTooltip name={r.ProductName} company={r.Company} badges={<Pill color={bucketColor(cls)} label={cls} />}>
          <TooltipRow label={metricLabel} value={metric(r)} />
          <TooltipRow label="Value (period)" value={fmtLYD(r.value)} />
          <TooltipRow label="Volume (period)" value={fmtVolume(r)} />
          {showDoh ? <TooltipRow label="Days of inventory" value={dohLabel(r)} /> : null}
        </ProductTooltip>
      );
    };

  const thresholds = overview.data?.thresholds.days_of_inventory;
  const lookback = overview.data?.lookbackDays ?? 90;

  return (
    <PermissionGuard pageKey="stock_velocity">
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', paddingBottom: 64 }}>
        <AppHeader anchorDate={anchorDate} onAnchorDateChange={onAnchorDateChange} roleLabel={roleLabel} onLogout={logout} showDateInput={false} />

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

        <ValidationStatusBar
          isStale={refresh.data?.isStale}
          isInverted={refresh.data?.isInverted}
          refreshCheck={refresh.data?.refreshCheck}
          lastRefreshTime={refresh.data ? formatTimestamp(refresh.data.lastRefreshTime) : undefined}
        />

        <main style={{ flex: 1, padding: 'clamp(8px, calc(5vw - 12px), var(--ps-space-4, 24px))', display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)' }}>
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

              <ChartPanel {...vh("product.stockVelocity.movers")}
                title="Fast vs Slow Movers"
                style={{ height: 'auto', padding: 'clamp(8px, calc(5vw - 12px), var(--ps-card-padding, 16px))' }}
                wrapHeader
                headerActions={
                  moversDrill ? (
                    <ExportButtons
                      label={`${moversDrill.toLowerCase()} movers`}
                      onCsv={() => exportProductCsv(`stock-velocity-${moversDrill.toLowerCase()}-movers`, MOVERS_EXPORT, moversDrillRowsAll)}
                      onPdf={() => exportProductPdf({ title: `${moversDrill} Movers`, subtitle: `${companyLabel} · ${moversDrillRowsAll.length} products`, fileName: `stock-velocity-${moversDrill.toLowerCase()}-movers`, columns: MOVERS_EXPORT, rows: moversDrillRowsAll })}
                    />
                  ) : null
                }
              >
                <DrillBreadcrumb active={moversDrill} rootLabel="Fast vs Slow" onReset={() => setMoversDrill(null)} />
                {moversDrill ? (
                  <ProductBarChart
                    key={moversDrill}
                    rows={moversDrillBars}
                    seriesName={`${moversDrill} movers (velocity per day)`}
                    color={moversDrill === 'Fast' ? 'var(--ps-color-success)' : 'var(--ps-color-alert)'}
                    axisFormatter={(v) => `${Number(v.toFixed(v >= 10 ? 0 : 2))}/day`}
                    tooltip={drillTooltip('Velocity', (r) => unitPerDay(r, 2), false)}
                    fileName={`stock-velocity-${moversDrill.toLowerCase()}-movers`}
                  />
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
                    }}
                    height={400}
                    yAxisWidth={104}
                  />
                )}
              </ChartPanel>

              <ChartPanel {...vh('product.stockVelocity.frequency')}
                title="Sales Frequency"
                wrapHeader
                headerActions={
                  frequencyDrill ? null : (
                    <ExportButtons
                      label="sales frequency"
                      onCsv={() => exportProductCsv('stock-velocity-sales-frequency', [{ header: 'Bucket', value: (g: (typeof frequencyGroups)[number]) => FREQUENCY_BUCKET_LABEL[g.bucket] }, { header: 'Products', align: 'right', value: (g) => g.count }, { header: 'Revenue (period, LYD)', align: 'right', value: (g) => g.revenue }], frequencyGroups)}
                      onPdf={() => exportProductPdf({ title: 'Sales Frequency', subtitle: `${companyLabel} · ${periodDays} days`, fileName: 'stock-velocity-sales-frequency', columns: [{ header: 'Bucket', value: (g: (typeof frequencyGroups)[number]) => FREQUENCY_BUCKET_LABEL[g.bucket] }, { header: 'Products', align: 'right', value: (g) => g.count }, { header: 'Revenue (period)', align: 'right', value: (g) => g.revenue, text: (g) => fmtLYD(g.revenue) }], rows: frequencyGroups })}
                    />
                  )
                }
              >
                <DrillBreadcrumb active={frequencyDrill ? FREQUENCY_BUCKET_LABEL[frequencyDrill] : null} rootLabel={`${sold.length} products sold in the period · selling days ÷ ${periodDays} days`} onReset={() => setFrequencyDrill(null)} />
                {frequencyDrill ? (
                  <SortableProductTable
                    testId="sales-frequency-table"
                    columns={FREQUENCY_COLUMNS}
                    rows={frequencyRows}
                    getRowId={(r) => r.id}
                    searchText={(r) => `${r.ProductName} ${r.SKU ?? ''}`}
                    defaultSort={{ key: 'revenue', dir: 'desc' }}
                    fileName={`stock-velocity-frequency-${frequencyDrill.toLowerCase()}`}
                    pdfTitle={`Sales Frequency — ${FREQUENCY_BUCKET_LABEL[frequencyDrill]}`}
                    pdfSubtitle={`${companyLabel} · ${periodDays} days`}
                  />
                ) : (
                  <>
                    <GroupedBarChart
                      showTitle={false}
                      points={frequencyPoints}
                      bars={[{ key: 'revenue', name: 'Revenue (period)', color: 'var(--ps-color-accent)' }]}
                      colorForPoint={(p) => FREQUENCY_COLOR[p._bucket as FrequencyBucket]}
                      valueFormatter={(v) => fmtLYD(v)}
                      tooltipContent={(p) => (
                        <div style={{ ...tooltipBoxStyle, padding: '8px 10px', minWidth: 180 }}>
                          <div style={{ fontWeight: 700, marginBottom: 4 }}>{p.label}</div>
                          <TooltipRow label="Products" value={String(p._count)} />
                          <TooltipRow label="Revenue (period)" value={fmtLYD(p.revenue as number)} />
                        </div>
                      )}
                      onCategoryClick={(label) => {
                        const g = frequencyGroups.find((x) => FREQUENCY_BUCKET_LABEL[x.bucket] === label);
                        if (g) setFrequencyDrill(g.bucket);
                      }}
                      height={260}
                      yAxisWidth={170}
                    />
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginTop: 8 }} data-testid="sales-frequency-buckets">
                      {frequencyGroups.map((g) => (
                        <button
                          key={g.bucket}
                          type="button"
                          onClick={() => setFrequencyDrill(g.bucket)}
                          style={{ textAlign: 'left', background: 'var(--ps-color-muted-bg)', border: '1px solid var(--ps-color-border)', borderLeft: `4px solid ${FREQUENCY_COLOR[g.bucket]}`, borderRadius: 8, padding: '8px 10px', cursor: 'pointer', color: 'var(--ps-color-text)' }}
                        >
                          <div style={{ fontSize: 12, fontWeight: 700 }}>{g.bucket}</div>
                          <div style={{ fontSize: 16, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{g.count} products</div>
                          <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)' }}>{fmtLYD(g.revenue)}</div>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </ChartPanel>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))', gap: 'var(--ps-space-3, 16px)', alignItems: 'start' }}>
                <ChartPanel {...vh("product.stockVelocity.overstock")}
                  title="Overstock Products"
                  style={{ height: 'auto', padding: 'clamp(8px, calc(5vw - 12px), var(--ps-card-padding, 16px))' }}
                  wrapHeader
                  headerActions={
                    <ExportButtons
                      label="overstock products"
                      onCsv={() => exportProductCsv('stock-velocity-overstock', OVERSTOCK_EXPORT, overstockExportRows())}
                      onPdf={() => exportProductPdf({ title: 'Overstock Products', subtitle: `${companyLabel} · ${overstockDrill ?? 'All Classes'}`, fileName: 'stock-velocity-overstock', columns: OVERSTOCK_EXPORT, rows: overstockExportRows() })}
                    />
                  }
                >
                  <DrillBreadcrumb active={overstockDrill} rootLabel="All Classes" onReset={() => setOverstockDrill(null)} />
                  {overstockDrill ? (
                    <ProductBarChart
                      key={overstockDrill}
                      rows={overstockDrillBars}
                      seriesName="LYD tied up"
                      color={bucketColor(overstockDrill)}
                      axisFormatter={fmtLYD}
                      tooltip={drillTooltip('LYD tied up', (r) => fmtLYD(r.stockValue), true)}
                      fileName="stock-velocity-overstock"
                    />
                  ) : (
                    <GroupedBarChart
                      showTitle={false}
                      points={overstockSummaryPoints}
                      bars={[{ key: 'tiedUp', name: 'LYD tied up', color: 'var(--ps-color-accent)' }]}
                      colorForPoint={(p) => bucketColor(p.label as ClassBucket)}
                      valueFormatter={(v) => fmtLYD(v)}
                      yAxisWidth={150}
                      onCategoryClick={(label) => {
                        setOverstockDrill(label as ClassBucket);
                      }}
                    />
                  )}
                </ChartPanel>

                <ChartPanel {...vh("product.stockVelocity.stockOutRisk")}
                  title="Stock-Out Risk"
                  style={{ height: 'auto', padding: 'clamp(8px, calc(5vw - 12px), var(--ps-card-padding, 16px))' }}
                  wrapHeader
                  headerActions={
                    <ExportButtons
                      label="stock-out risk products"
                      onCsv={() => exportProductCsv('stock-velocity-risk', RISK_EXPORT, riskExportRows())}
                      onPdf={() => exportProductPdf({ title: 'Stock-Out Risk', subtitle: `${companyLabel} · ${riskDrill ?? 'All Classes'}`, fileName: 'stock-velocity-risk', columns: RISK_EXPORT, rows: riskExportRows() })}
                    />
                  }
                >
                  <DrillBreadcrumb active={riskDrill} rootLabel="All Classes" onReset={() => setRiskDrill(null)} />
                  {riskDrill ? (
                    <ProductBarChart
                      key={riskDrill}
                      rows={riskDrillBars}
                      seriesName="Value sold (period)"
                      color="var(--ps-color-alert)"
                      axisFormatter={fmtLYD}
                      tooltip={drillTooltip('Value at risk', (r) => fmtLYD(r.value), true)}
                      fileName="stock-velocity-risk"
                    />
                  ) : (
                    <GroupedBarChart
                      showTitle={false}
                      points={riskSummaryPoints}
                      bars={[{ key: 'valueAtRisk', name: 'Value sold (period)', color: 'var(--ps-color-alert)' }]}
                      colorForPoint={(p) => bucketColor(p.label as ClassBucket)}
                      valueFormatter={(v) => fmtLYD(v)}
                      yAxisWidth={150}
                      onCategoryClick={(label) => {
                        setRiskDrill(label as ClassBucket);
                      }}
                    />
                  )}
                </ChartPanel>
              </div>

              <p style={{ textAlign: 'center', fontSize: 11, color: 'var(--ps-color-muted-text)', margin: 0 }}>
                Days of inventory = finished-goods stock ÷ average daily sales over the last {lookback} days. Tika: Overstock &gt; {thresholds?.overstock_days?.Tika ?? 60} days · Stock-Out Risk &lt;{' '}
                {thresholds?.stockout_risk_days?.Tika ?? 30} days | Majaal: Overstock &gt; {thresholds?.overstock_days?.Majaal ?? 180} days · Stock-Out Risk &lt; {thresholds?.stockout_risk_days?.Majaal ?? 60} days. Stock with no
                sales in {lookback} days counts as Overstocked (no movement). In-transit and raw-materials stock are not on hand.
                Every product is one Odoo product in one company, with that company&apos;s thresholds.
              </p>

            </>
          )}
        </main>

        <RefreshFooter
          lastUpdate={formatTimestamp(refresh.data?.lastUpdate ?? null)}
          lastOrderCreated={formatTimestamp(refresh.data?.lastOrderCreated ?? null)}
          lastRefreshTime={formatTimestamp(refresh.data?.lastRefreshTime ?? null)}
        />
        <BottomNavBar active="Stock Velocity" />
      </div>
    </PermissionGuard>
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

function PillField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <span style={{ display: 'block', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--ps-color-muted-text)', marginBottom: 4 }}>{label}</span>
      <div style={{ display: 'flex', gap: 6, height: 38, alignItems: 'center' }}>{children}</div>
    </div>
  );
}
