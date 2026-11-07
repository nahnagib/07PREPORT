'use client';
import { vh, type VisualHints } from '../../../../lib/visualHelp';
import React, { useMemo, useState } from 'react';
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
  Card,
  ChartPanel,
  DataGrid,
  Gauge,
  KpiTile,
  Select,
  Button,
  GroupedBarChart,
  LoadingSkeleton,
  ErrorState,
  VisualInfoIcons,
  type DataGridColumn,
  type SelectOption,
  type GroupedBarChartPoint,
  tooltipBoxStyle,
} from '@07ps/ui';
import {
  toProductFacts,
  isOverstocked,
  fmtLYD,
  fmtNum,
  fmtUnits,
  fmtVolume,
  median,
  sum,
  distinctSorted,
  BCG_COLOR,
  STOCK_BAND_LABEL,
  agingBuckets,
  agingColor,
  averageSaleGap,
  dohRule,
  fmtDate,
  frequencyBucket,
  frequencyBuckets,
  frequencyColor,
  frequencyLabel,
  isrBands,
  isrPct,
  isrStatus,
  lookbackDays,
  moverGroupOf,
  moverRule,
  moverRuleText,
  velocityVsCategoryMedian,
  type MoverGroup,
  type ProductFact,
} from '../../../../lib/materialsAnalogy/shared';
import { ProductBarChart, type ProductBar } from '../../../../components/product/ProductBarChart';
import { StackedShareBar, type ShareSegment } from '../../../../components/product/StackedShareBar';
import {
  ExportButtons,
  ltrLabel,
  Pill,
  ProductName,
  ProductTooltip,
  TooltipRow,
  exportProductCsv,
  exportProductPdf,
  type ExportColumn,
} from '../../../../components/product/ProductUi';

/** Class buckets for the Overstock / Stock-out charts: the 4 BCG classes, products sold YTD without a
 * standard cost, and products with no sales this year (e.g. overstock that never sold). */
const CLASS_BUCKETS = ['Stars', 'Cash Cows', 'Strategic', 'Dogs', 'Unclassified (no cost)', 'No sales YTD'] as const;
type ClassBucket = (typeof CLASS_BUCKETS)[number];
const bucketOf = (r: ProductFact): ClassBucket => (r.bcg_class_YTD ?? 'No sales YTD') as ClassBucket;
const bucketColor = (b: ClassBucket) => BCG_COLOR[b] ?? 'var(--ps-color-neutral-text)';

type BandFilter = 'All' | 'Overstock' | 'Normal' | 'StockOutRisk';
const MOVER_COLOR: Record<MoverGroup, string> = { Fast: 'var(--ps-color-success)', Normal: 'var(--ps-color-neutral-text)', Slow: 'var(--ps-color-alert)' };
const NO_AGE = 'No arrival date';
/** An exact count with thousands separators ("1,078"), for SKU counts in sentences. */
const fmtCount = (n: number) => n.toLocaleString('en-US');

const dohLabel = (r: ProductFact) => (r.daysOfInventory === null ? (r.stockQty > 0 ? 'no sales' : '—') : `${r.daysOfInventory.toFixed(0)}d`);
const BASE_EXPORT: ExportColumn<ProductFact>[] = [
  { header: 'Product Name', value: (r) => ltrLabel(r.ProductName) },
  { header: 'Company', value: (r) => r.Company },
  { header: 'Odoo ID', value: (r) => r.ProductKey },
  { header: 'Category', value: (r) => r.Category },
  { header: 'Class', value: (r) => bucketOf(r) },
];
const STOCK_EXPORT: ExportColumn<ProductFact>[] = [
  ...BASE_EXPORT,
  { header: 'Band', value: (r) => STOCK_BAND_LABEL[r.stockBand] },
  { header: 'DOH (days)', align: 'right', value: (r) => r.daysOfInventory, text: dohLabel },
  { header: 'Stock age (days)', align: 'right', value: (r) => r.stockAgeDays, text: (r) => (r.stockAgeDays === null ? '—' : r.stockAgeDays.toFixed(0)) },
  { header: 'Stock (Unit)', align: 'right', value: (r) => r.stockQty, text: (r) => fmtNum(r.stockQty) },
  { header: 'UoM', value: (r) => r.uom },
  { header: 'Stock (LYD at cost)', align: 'right', value: (r) => r.stockValue, text: (r) => fmtLYD(r.stockValue) },
];
const SALES_EXPORT: ExportColumn<ProductFact>[] = [
  ...BASE_EXPORT,
  { header: 'DOH (days)', align: 'right', value: (r) => r.daysOfInventory, text: dohLabel },
  { header: 'Volume (period, Unit)', align: 'right', value: (r) => r.volume, text: (r) => fmtNum(r.volume) },
  { header: 'UoM', value: (r) => r.uom },
  { header: 'Value (period, LYD)', align: 'right', value: (r) => r.value, text: (r) => fmtLYD(r.value) },
];

/** A help entry whose one formula line is built from the ETL config (thresholds are never hard-coded on the page). */
function withFormula(hints: VisualHints, formula: string): VisualHints {
  return hints.help ? { ...hints, help: { ...hints.help, formula } } : hints;
}

/** SKU-count bar chart per category (BCG class / frequency bucket): hover = SKUs, units, LYD; click = drill. */
interface CountPoint extends GroupedBarChartPoint {
  label: string;
  skus: number;
  _units: number;
  _value: number;
  _color: string;
}
function countTooltip(unitsLabel: string, valueLabel: string) {
  return function CountTooltip(p: GroupedBarChartPoint) {
    return (
      <div style={{ ...tooltipBoxStyle, padding: '8px 10px', minWidth: 180 }}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>{p.label}</div>
        <TooltipRow label="SKUs" value={String(p.skus)} />
        <TooltipRow label={unitsLabel} value={fmtUnits(p._units as number)} />
        <TooltipRow label={valueLabel} value={fmtLYD(p._value as number)} />
      </div>
    );
  };
}

/**
 * Stock Velocity -- live data (useProductDashboard). Velocity = invoiced quantity in the selected period / days in the
 * period; stock, days on hand (DOH), stock band and stock age are as of the last ETL run (finished-goods internal
 * locations, look-back and company thresholds from config/product_dashboard.json, read through overview.thresholds).
 * Volume is added up as "Unit" whatever the Odoo UoM; LYD is secondary. Filters: the Promotion FilterBar
 * (useProductFilters) plus Category and Stock Band. Stock itself has no customer: Customer Group / Channel / Branch /
 * Salesperson change the sales figures and which products are listed (sold in scope), never a product's stock.
 */
export default function StockVelocityPage() {
  const { user, token, error: authError, retryAuth, logout } = useAuth();
  const roleLabel = user?.role.label ?? user?.fullName;
  const refresh = useRefreshStatus(token, authError, retryAuth);
  const { anchorDate, onAnchorDateChange, scope, companyLabel, filterBarProps, withLocalReset } = useProductFilters(refresh.data);

  // Company view (one company) or all companies side by side; a product is always one Odoo product in one company.
  const overview = useProductDashboard(token, authError, retryAuth, 'stock-velocity', scope);
  const facts = useMemo(() => toProductFacts(overview.data), [overview.data]);
  const thresholds = overview.data?.thresholds;
  const [category, setCategory] = useState<string[]>([]);
  const [band, setBand] = useState<BandFilter>('All');

  const [moversDrill, setMoversDrill] = useState<MoverGroup | null>(null);
  const [agingDrill, setAgingDrill] = useState<string | null>(null);
  const [overstockDrill, setOverstockDrill] = useState<ClassBucket | null>(null);
  const [riskDrill, setRiskDrill] = useState<ClassBucket | null>(null);
  const [frequencyDrill, setFrequencyDrill] = useState<string | null>(null);

  const categoryOptions: SelectOption[] = useMemo(
    () => distinctSorted(facts.map((r) => r.Category)).map((c) => ({ value: c, label: c })),
    [facts],
  );

  const bandMatches = (r: ProductFact) =>
    band === 'All' || (band === 'Overstock' ? isOverstocked(r) : band === 'Normal' ? r.stockBand === 'Normal' : r.stockBand === 'StockOutRisk');

  const filtered = useMemo(
    () =>
      facts.filter((r) => (category.length === 0 || (r.Category !== null && category.includes(r.Category))) && bandMatches(r)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [facts, category, band],
  );

  // ---- config lines for the "?" (never hard-coded) ----
  const lookback = lookbackDays(thresholds);
  const overRule = `${dohRule(thresholds, 'overstock_days', '>')} DOH; stock with no sales in ${lookback} days counts as overstock`;
  const riskRule = `${dohRule(thresholds, 'stockout_risk_days', '<')} DOH`;
  const bands = isrBands(thresholds);
  const isrRule = `ISR = inventory on hand (LYD at cost) ÷ net sales (LYD) in the period · target ≤ ${bands.targetPct}% · red from ${bands.redPct}%`;
  const freqBuckets = frequencyBuckets(thresholds);
  const freqRule = `Average gap = days in the period ÷ selling days (${freqBuckets.map((b) => frequencyLabel(freqBuckets, b.key)).join(' · ')})`;
  const ageBuckets = agingBuckets(thresholds);

  // ---- KPIs ----
  // DOH averaged over products weighted by their units sold in the period (stock with no sales has no DOH, no weight).
  const withDoh = filtered.filter((r) => r.daysOfInventory !== null && r.volume > 0);
  const dohWeight = sum(withDoh, (r) => r.volume);
  const avgDOH = dohWeight > 0 ? sum(withDoh, (r) => (r.daysOfInventory as number) * r.volume) / dohWeight : null;
  const overRows = filtered.filter(isOverstocked);
  const riskRows = filtered.filter((r) => r.stockBand === 'StockOutRisk');
  const overUnits = sum(overRows, (r) => r.stockQty);
  const overValue = sum(overRows, (r) => r.stockValue);
  const riskUnits = sum(riskRows, (r) => r.volume);
  const inStock = filtered.filter((r) => r.stockQty > 0);
  const inventoryUnits = sum(filtered, (r) => r.stockQty);
  const inventoryValue = sum(filtered, (r) => r.stockValue);
  const inTransitUnits = sum(filtered, (r) => r.inTransitQty);
  const salesValue = sum(filtered, (r) => r.value);
  const isr = isrPct(inventoryValue, salesValue);
  const isrState = isrStatus(isr, bands);

  // ---- Fast / Normal / Slow movers: each SKU's velocity (units sold per day in the period) against the MEDIAN velocity
  // of its own category in the same company (config stock.*_mover_vs_category_median_pct). Only SKUs that sold in the
  // period; discount pseudo-products (negative value) are not product movement. ----
  const rule = moverRule(thresholds);
  const moving = filtered.filter((r) => r.velocity !== null && r.velocity > 0 && r.value > 0);
  const vsMedian = velocityVsCategoryMedian(moving);
  const moverOf = (r: ProductFact): MoverGroup => moverGroupOf(vsMedian.get(r.id) ?? 100, rule);
  const moverRows: Record<MoverGroup, ProductFact[]> = { Fast: [], Normal: [], Slow: [] };
  moving.forEach((r) => moverRows[moverOf(r)].push(r));
  const moverSegments: ShareSegment[] = (['Fast', 'Normal', 'Slow'] as const).map((g) => ({
    key: g, label: `${g} movers`, color: MOVER_COLOR[g], skus: moverRows[g].length, units: sum(moverRows[g], (r) => r.volume), value: sum(moverRows[g], (r) => r.value),
    valueLabel: 'Sold (LYD)',
  }));
  const unitPerDay = (r: ProductFact, precision?: number) => {
    const velocity = r.velocity ?? 0;
    return `${velocity.toFixed(precision ?? (velocity >= 10 ? 0 : 2))} ${r.uom || 'Unit'}/day`;
  };
  const toBars = (rows: ProductFact[], value: (r: ProductFact) => number, label: (r: ProductFact) => string): ProductBar[] =>
    rows.map((r) => ({ id: r.id, name: r.ProductName, company: r.Company, value: value(r), valueLabel: label(r), href: r.odooUrl }));
  const moversDrillRows = moversDrill ? [...moverRows[moversDrill]].sort((a, b) => (b.velocity as number) - (a.velocity as number)) : [];

  // ---- Stock Aging: finished-goods SKUs on hand by the units-weighted age of their stock (ETL StockAgeBucket) ----
  const agingSegments: ShareSegment[] = [
    ...ageBuckets.map((b) => ({ key: b.label, label: b.label, color: agingColor(ageBuckets, b.label) })),
    { key: NO_AGE, label: NO_AGE, color: 'var(--ps-color-muted-text)' },
  ].map((s) => {
    const rows = inStock.filter((r) => (r.stockAgeBucket ?? NO_AGE) === s.key);
    return { ...s, skus: rows.length, units: sum(rows, (r) => r.stockQty), value: sum(rows, (r) => r.stockValue), valueLabel: 'Stock (LYD at cost)' };
  }).filter((s) => s.key !== NO_AGE || s.skus > 0);
  const agingDrillRows = agingDrill ? inStock.filter((r) => (r.stockAgeBucket ?? NO_AGE) === agingDrill).sort((a, b) => b.stockQty - a.stockQty) : [];

  // ---- Overstock and Stock-out risk by class: SKU counts; hover = SKUs, units, LYD ----
  const classPoints = (rows: ProductFact[], units: (r: ProductFact) => number, value: (r: ProductFact) => number, keepEmpty: ClassBucket[] = []): CountPoint[] =>
    CLASS_BUCKETS.map((cls) => {
      const inClass = rows.filter((r) => bucketOf(r) === cls);
      return { label: cls, skus: inClass.length, _units: sum(inClass, units), _value: sum(inClass, value), _color: bucketColor(cls) };
    }).filter((p) => p.skus > 0 || keepEmpty.includes(p.label as ClassBucket));
  const overstockPoints = classPoints(overRows, (r) => r.stockQty, (r) => r.stockValue, ['No sales YTD']);
  const overstockDrillRows = overstockDrill ? overRows.filter((r) => bucketOf(r) === overstockDrill).sort((a, b) => b.stockQty - a.stockQty) : [];
  // Stock-out risk: above-median sellers (units in the period) below the company minimum DOH; urgency = units ÷ (DOH + 1)
  const medianVolume = median(filtered.map((r) => r.volume));
  const riskCandidates = riskRows.filter((r) => r.volume > medianVolume);
  const riskPoints = classPoints(riskCandidates, (r) => r.volume, (r) => r.value);
  const urgency = (r: ProductFact) => r.volume / ((r.daysOfInventory ?? 0) + 1);
  const riskDrillRows = riskDrill ? riskCandidates.filter((r) => bucketOf(r) === riskDrill).sort((a, b) => urgency(b) - urgency(a)) : [];
  const factById = new Map(filtered.map((r) => [r.id, r]));

  // ---- Sales Frequency: distinct selling days in the period -> average gap -> config buckets; bars = SKU counts ----
  const periodDays = overview.data?.period.days ?? 0;
  const sold = filtered.filter((r) => r.orderDays > 0 && r.value > 0);
  const frequencyGroups = freqBuckets.map((b) => {
    const rows = sold.filter((r) => frequencyBucket(r.orderDays, periodDays, freqBuckets) === b.key);
    return { bucket: b.key, rows, units: sum(rows, (r) => r.volume), revenue: sum(rows, (r) => r.value), count: rows.length };
  });
  const frequencyPoints: CountPoint[] = frequencyGroups.map((g) => ({
    label: frequencyLabel(freqBuckets, g.bucket), skus: g.count, _units: g.units, _value: g.revenue, _color: frequencyColor(freqBuckets, g.bucket), _bucket: g.bucket,
  }));
  const frequencyRows = frequencyDrill ? frequencyGroups.find((g) => g.bucket === frequencyDrill)?.rows ?? [] : [];
  type FrequencyGroup = (typeof frequencyGroups)[number];
  const FREQUENCY_EXPORT: ExportColumn<FrequencyGroup>[] = [
    { header: 'Bucket', value: (g) => frequencyLabel(freqBuckets, g.bucket) },
    { header: 'SKUs', align: 'right', value: (g) => g.count },
    { header: 'Units sold (period)', align: 'right', value: (g) => g.units, text: (g) => fmtNum(g.units) },
    { header: 'Revenue (period, LYD)', align: 'right', value: (g) => g.revenue, text: (g) => fmtLYD(g.revenue) },
  ];
  type FrequencyRow = ProductFact & Record<string, unknown> & { gap: number | null };
  const frequencyGridRows: FrequencyRow[] = frequencyRows.map((r) => ({ ...r, gap: averageSaleGap(r.orderDays, periodDays) }));
  const FREQUENCY_COLUMNS: DataGridColumn<FrequencyRow>[] = [
    { key: 'ProductName', header: 'Product', width: 240, render: (r) => <ProductName name={r.ProductName} href={r.odooUrl} />, rawValue: (r) => r.ProductName },
    { key: 'volume', header: 'Units sold (period)', align: 'right', render: (r) => <strong>{fmtNum(r.volume)}</strong>, rawValue: (r) => r.volume },
    { key: 'Company', header: 'Company', rawValue: (r) => r.Company },
    { key: 'Category', header: 'Category', render: (r) => <ProductName name={r.Category ?? '—'} />, rawValue: (r) => r.Category ?? '' },
    { key: 'orderDays', header: 'Selling days', align: 'right', rawValue: (r) => r.orderDays },
    { key: 'gap', header: 'Avg gap (days)', align: 'right', render: (r) => (r.gap === null ? '—' : r.gap.toFixed(1)), rawValue: (r) => (r.gap === null ? '' : Math.round(r.gap * 10) / 10), sortValue: (r) => r.gap ?? Number.POSITIVE_INFINITY },
    { key: 'uom', header: 'UoM', rawValue: (r) => r.uom ?? '' },
    { key: 'value', header: 'Revenue (period)', align: 'right', render: (r) => fmtLYD(r.value), rawValue: (r) => r.value },
    { key: 'lastSaleDate', header: 'Last sale', render: (r) => fmtDate(r.lastSaleDate), rawValue: (r) => r.lastSaleDate ?? '' },
  ];

  const MOVERS_EXPORT: ExportColumn<ProductFact>[] = [
    ...BASE_EXPORT,
    { header: 'Group', value: (r) => moverOf(r) },
    { header: '% of category median', align: 'right', value: (r) => Math.round(vsMedian.get(r.id) ?? 100), text: (r) => `${Math.round(vsMedian.get(r.id) ?? 100)}%` },
    { header: 'Velocity (per day)', align: 'right', value: (r) => r.velocity, text: (r) => unitPerDay(r, 2) },
    { header: 'UoM', value: (r) => r.uom },
    { header: 'Volume (period, Unit)', align: 'right', value: (r) => r.volume, text: (r) => fmtNum(r.volume) },
    { header: 'Value (period, LYD)', align: 'right', value: (r) => r.value, text: (r) => fmtLYD(r.value) },
  ];

  /** Hover detail of a drilled product bar: class badge, the bar's metric, volume, DOH, stock, value. */
  const drillTooltip = (metricLabel: string, metric: (r: ProductFact) => string, showStock: boolean) =>
    function DrillTooltip(bar: ProductBar) {
      const r = factById.get(bar.id);
      if (!r) return null;
      const cls = bucketOf(r);
      return (
        <ProductTooltip name={r.ProductName} company={r.Company} badges={<Pill color={bucketColor(cls)} label={cls} />}>
          <TooltipRow label={metricLabel} value={metric(r)} />
          <TooltipRow label="Volume (period)" value={fmtVolume(r)} />
          {showStock ? <TooltipRow label="DOH" value={dohLabel(r)} /> : null}
          {showStock ? <TooltipRow label="Stock" value={`${fmtUnits(r.stockQty)} · ${fmtLYD(r.stockValue)}`} /> : null}
          {showStock && r.stockAgeDays !== null ? <TooltipRow label="Stock age" value={`${r.stockAgeDays.toFixed(0)} days`} /> : null}
          <TooltipRow label="Value (period)" value={fmtLYD(r.value)} />
        </ProductTooltip>
      );
    };

  const panelStyle = { height: 'auto', padding: 'clamp(8px, calc(5vw - 12px), var(--ps-card-padding, 16px))' } as const;
  const exportList = (name: string, title: string, subtitle: string, columns: ExportColumn<ProductFact>[], rows: ProductFact[]) => (
    <ExportButtons
      label={title.toLowerCase()}
      onCsv={() => exportProductCsv(`stock-velocity-${name}`, columns, rows)}
      onPdf={() => exportProductPdf({ title, subtitle: `${companyLabel} · ${subtitle}`, fileName: `stock-velocity-${name}`, columns, rows })}
    />
  );

  return (
    <PermissionGuard pageKey="stock_velocity">
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', paddingBottom: 64 }}>
        <AppHeader anchorDate={anchorDate} onAnchorDateChange={onAnchorDateChange} roleLabel={roleLabel} onLogout={logout} showDateInput={false} />

        <FilterBar
          {...filterBarProps}
          {...withLocalReset(() => {
            setCategory([]);
            setBand('All');
          }, category.length === 0 && band === 'All')}
          secondRow={
            <>
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
              <div data-testid="stock-velocity-kpis" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--ps-space-3, 16px)' }}>
                <KpiTile label="DOH – Avg Days of Inventory" value={avgDOH === null ? '—' : `${Math.round(avgDOH)} days`} variance={`Based on the last ${lookback} days of sales`} status="neutral"
                  help={withFormula(vh('product.stockVelocity.kpiDoh'), `DOH = finished-goods units on hand ÷ average daily units sold (last ${lookback} days)`).help} />
                <KpiTile label="Overstocked SKUs" value={fmtCount(overRows.length)} variance={`${fmtNum(overUnits)} units on hand · ${fmtLYD(overValue)}`} status="watch"
                  help={withFormula(vh('product.stockVelocity.kpiOverstock'), overRule).help} />
                <KpiTile label="Stock-Out Risk SKUs" value={fmtCount(riskRows.length)} variance={`${fmtNum(riskUnits)} units sold in the period`} status="alert"
                  help={withFormula(vh('product.stockVelocity.kpiStockOut'), riskRule).help} />
                <KpiTile label="Fast Movers" value={fmtCount(moverRows.Fast.length)} variance={`Out of ${fmtCount(moving.length)} SKUs sold in the period`} status="success"
                  help={withFormula(vh('product.stockVelocity.kpiFast'), moverRuleText(rule)).help} />
                <KpiTile label="SKUs in Stock" value={fmtCount(inStock.length)} variance="In finished-goods locations" status="neutral"
                  help={vh('product.stockVelocity.kpiInStock').help} />
                <KpiTile label="Inventory Value" value={fmtLYD(inventoryValue)} variance={`${fmtNum(inventoryUnits)} units on hand · ${fmtNum(inTransitUnits)} units in transit`} status="neutral"
                  help={vh('product.stockVelocity.kpiInventory').help} />
              </div>

              <Card data-testid="isr-gauge">
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ps-color-text)', marginBottom: 4 }}>
                    ISR – Inventory to Sales Ratio <VisualInfoIcons title="ISR – Inventory to Sales Ratio" {...withFormula(vh('product.stockVelocity.isr'), isrRule)} />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <Gauge
                      actual={isr ?? 0}
                      targetToDate={bands.targetPct}
                      status={isrState}
                      label="ISR"
                      valueLabel={isr === null ? '—' : `${isr.toFixed(1)}%`}
                      targetLabel={`${bands.targetPct}%`}
                      bands={{ min: 0, max: Math.max(bands.redPct * 2, Math.ceil(((isr ?? 0) * 1.1) / 10) * 10), yellowFrom: bands.targetPct, greenFrom: bands.redPct }}
                      invertBands
                      size={320}
                    />
                    <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', marginTop: 4, textAlign: 'center' }}>
                      {fmtLYD(inventoryValue)} on hand ÷ {fmtLYD(salesValue)} sold in the period
                    </div>
                  </div>
              </Card>

              <ChartPanel {...withFormula(vh('product.stockVelocity.movers'), moverRuleText(rule))} title="Fast vs Slow Movers" style={panelStyle} wrapHeader
                  headerActions={moversDrill ? exportList(`${moversDrill.toLowerCase()}-movers`, `${moversDrill} Movers`, `${moversDrillRows.length} products`, MOVERS_EXPORT, moversDrillRows) : null}
                >
                  <DrillBreadcrumb active={moversDrill ? `${moversDrill} movers` : null} rootLabel={`${fmtCount(moving.length)} SKUs sold in the period, compared with their category's median sales speed`} onReset={() => setMoversDrill(null)} />
                  {moversDrill ? (
                    <ProductBarChart
                      key={moversDrill}
                      rows={toBars(moversDrillRows, (r) => r.velocity as number, unitPerDay)}
                      seriesName={`${moversDrill} movers (units per day)`}
                      color={MOVER_COLOR[moversDrill]}
                      axisFormatter={(v) => `${Number(v.toFixed(v >= 10 ? 0 : 2))}/day`}
                      tooltip={drillTooltip('Velocity', (r) => unitPerDay(r, 2), false)}
                      fileName={`stock-velocity-${moversDrill.toLowerCase()}-movers`}
                    />
                  ) : (
                    <StackedShareBar testId="movers-share-bar" segments={moverSegments} onSelect={(k) => setMoversDrill(k as MoverGroup)} />
                  )}
                </ChartPanel>

              <ChartPanel {...vh('product.stockVelocity.aging')} title="Stock Aging" style={panelStyle} wrapHeader
                headerActions={agingDrill ? exportList('aging', `Stock Aging — ${agingDrill}`, `${agingDrillRows.length} products`, STOCK_EXPORT, agingDrillRows) : null}
              >
                <DrillBreadcrumb active={agingDrill} rootLabel={`${fmtCount(inStock.length)} finished-goods SKUs on hand, by days since the stock arrived`} onReset={() => setAgingDrill(null)} />
                {agingDrill ? (
                  <ProductBarChart
                    key={agingDrill}
                    rows={toBars(agingDrillRows, (r) => r.stockQty, (r) => fmtUnits(r.stockQty))}
                    seriesName="Units on hand"
                    color={agingColor(ageBuckets, agingDrill)}
                    axisFormatter={fmtNum}
                    tooltip={drillTooltip('Units on hand', (r) => fmtUnits(r.stockQty), true)}
                    fileName="stock-velocity-aging"
                  />
                ) : (
                  <StackedShareBar testId="aging-share-bar" segments={agingSegments} onSelect={setAgingDrill} />
                )}
              </ChartPanel>

              <ChartPanel {...withFormula(vh('product.stockVelocity.frequency'), freqRule)} title="Sales Frequency" style={panelStyle} wrapHeader
                headerActions={frequencyDrill ? null : (
                  <ExportButtons
                    label="sales frequency"
                    onCsv={() => exportProductCsv('stock-velocity-sales-frequency', FREQUENCY_EXPORT, frequencyGroups)}
                    onPdf={() => exportProductPdf({ title: 'Sales Frequency', subtitle: `${companyLabel} · ${periodDays} days`, fileName: 'stock-velocity-sales-frequency', columns: FREQUENCY_EXPORT, rows: frequencyGroups })}
                  />
                )}
              >
                <DrillBreadcrumb active={frequencyDrill ? frequencyLabel(freqBuckets, frequencyDrill) : null} rootLabel={`${fmtCount(sold.length)} SKUs sold in the period · selling days ÷ ${periodDays} days`} onReset={() => setFrequencyDrill(null)} />
                {frequencyDrill ? (
                  <div data-testid="sales-frequency-table">
                    <DataGrid
                      columns={FREQUENCY_COLUMNS}
                      rows={[...frequencyGridRows].sort((a, b) => b.volume - a.volume)}
                      getRowId={(r) => r.id}
                      fileName={`stock-velocity-frequency-${frequencyDrill.toLowerCase()}`}
                      filtersSummary={`${companyLabel} · ${frequencyLabel(freqBuckets, frequencyDrill)} · ${periodDays} days`}
                    />
                  </div>
                ) : (
                  <div data-testid="sales-frequency-chart">
                    <GroupedBarChart
                      showTitle={false}
                      points={frequencyPoints}
                      bars={[{ key: 'skus', name: 'SKUs', color: 'var(--ps-color-accent)' }]}
                      colorForPoint={(p) => p._color as string}
                      valueFormatter={(v) => fmtNum(v)}
                      tooltipContent={countTooltip('Units sold (period)', 'Revenue (period)')}
                      onCategoryClick={(label) => {
                        const p = frequencyPoints.find((x) => x.label === label);
                        if (p) setFrequencyDrill(p._bucket as string);
                      }}
                      height={280}
                      yAxisWidth={170}
                    />
                  </div>
                )}
              </ChartPanel>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))', gap: 'var(--ps-space-3, 16px)', alignItems: 'start' }}>
                <ChartPanel {...withFormula(vh('product.stockVelocity.overstock'), overRule)} title="Overstock Products" style={panelStyle} wrapHeader
                  headerActions={exportList('overstock', 'Overstock Products', overstockDrill ?? 'All Classes', STOCK_EXPORT, overstockDrill ? overstockDrillRows : [...overRows].sort((a, b) => b.stockQty - a.stockQty))}
                >
                  <DrillBreadcrumb active={overstockDrill} rootLabel="SKUs per BCG class" onReset={() => setOverstockDrill(null)} />
                  {overstockDrill ? (
                    <ProductBarChart
                      key={overstockDrill}
                      rows={toBars(overstockDrillRows, (r) => r.stockQty, (r) => fmtUnits(r.stockQty))}
                      seriesName="Units on hand"
                      color={bucketColor(overstockDrill)}
                      axisFormatter={fmtNum}
                      tooltip={drillTooltip('Units on hand', (r) => fmtUnits(r.stockQty), true)}
                      fileName="stock-velocity-overstock"
                    />
                  ) : (
                    <GroupedBarChart
                      showTitle={false}
                      points={overstockPoints}
                      bars={[{ key: 'skus', name: 'SKUs', color: 'var(--ps-color-accent)' }]}
                      colorForPoint={(p) => p._color as string}
                      valueFormatter={(v) => fmtNum(v)}
                      tooltipContent={countTooltip('Units on hand', 'Stock (LYD at cost)')}
                      yAxisWidth={150}
                      onCategoryClick={(label) => setOverstockDrill(label as ClassBucket)}
                    />
                  )}
                </ChartPanel>

                <ChartPanel {...withFormula(vh('product.stockVelocity.stockOutRisk'), riskRule)} title="Stock-Out Risk" style={panelStyle} wrapHeader
                  headerActions={exportList('risk', 'Stock-Out Risk', riskDrill ?? 'All Classes', SALES_EXPORT, riskDrill ? riskDrillRows : [...riskCandidates].sort((a, b) => urgency(b) - urgency(a)))}
                >
                  <DrillBreadcrumb active={riskDrill} rootLabel="SKUs per BCG class" onReset={() => setRiskDrill(null)} />
                  {riskDrill ? (
                    <ProductBarChart
                      key={riskDrill}
                      rows={toBars(riskDrillRows, (r) => r.volume, (r) => fmtUnits(r.volume))}
                      seriesName="Units sold (period)"
                      color="var(--ps-color-alert)"
                      axisFormatter={fmtNum}
                      tooltip={drillTooltip('Units sold (period)', (r) => fmtUnits(r.volume), true)}
                      fileName="stock-velocity-risk"
                    />
                  ) : (
                    <GroupedBarChart
                      showTitle={false}
                      points={riskPoints}
                      bars={[{ key: 'skus', name: 'SKUs', color: 'var(--ps-color-alert)' }]}
                      colorForPoint={(p) => p._color as string}
                      valueFormatter={(v) => fmtNum(v)}
                      tooltipContent={countTooltip('Units sold (period)', 'Sold (LYD)')}
                      yAxisWidth={150}
                      onCategoryClick={(label) => setRiskDrill(label as ClassBucket)}
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
