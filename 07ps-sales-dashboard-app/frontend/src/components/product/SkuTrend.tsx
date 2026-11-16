'use client';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChartPanel, ComboChart, EmptyState, ErrorState, LoadingSkeleton, exportRowsAsPdf, exportSvgAsImage, tooltipBoxStyle, useCanExport, type Column, type ComboChartPoint, type ComboLabelProps } from '@07ps/ui';
import { useAuth } from '../../lib/AuthProvider';
import { useSkuTrend } from '../../lib/hooks';
import { fetchSkuTrendSkus, type PeriodGranularity, type ProductDashboardScope, type SkuTrendCounts, type SkuTrendPoint, type SkuTrendSelection, type SkuTrendSku, type SkuTrendSkuList, type SkuTrendStatus } from '../../lib/api';
import { CHANGE_LABEL, DEFAULT_GRANULARITY, periodDayLabel, usePeriodWindow, type PeriodWindowView } from '../../lib/periods';
import { STATUS_COLOR } from '../../lib/product/statusTable';
import type { VisualHints } from '../../lib/visualHelp';
import { PeriodTrendSelector } from '../PeriodTrendSelector';
import { ExportButtons, ProductName, SortableProductTable, type SortableColumn } from './ProductUi';
import { fmtLYD, fmtNum } from '../../lib/materialsAnalogy/shared';

/**
 * SKU Trend (Product Portfolio page, 2026-11-16, round 5; backend measures/skuTrend.ts): per Weekly / Monthly / Yearly period,
 * a bar = every SKU (Active + Non Active + Dormant) and a line per status, on the same axis, with the Product Status cards'
 * rules -- sales in the period, stock on hand at its end (period-end stock history, product_stock_period_end; today's On Hand
 * for the period in progress, so the last point equals the cards). The shared ComboChart draws it. Click the bar for every
 * SKU of that period, a line point for that status's SKUs. Without stock history it says so instead of a wrong chart.
 */
export const SKU_TREND_GRANULARITIES: readonly PeriodGranularity[] = ['week', 'month', 'year'];

/** The lines: the colours of the status chips above (STATUS_COLOR). */
export const SKU_TREND_SERIES: { key: SkuTrendStatus; name: string; color: string; definition: string }[] = [
  { key: 'active', name: 'Active', color: STATUS_COLOR.active, definition: 'sales in the period and stock at its end' },
  { key: 'nonActive', name: 'Non Active', color: STATUS_COLOR.non_active, definition: 'sales or stock, not both' },
  { key: 'dormant', name: 'Dormant', color: STATUS_COLOR.dormant, definition: 'archived, or no stock and no sales' },
];
/** The bars: every SKU of the period, one neutral slate (never a status colour). */
export const TOTAL_SERIES = { key: 'total', name: 'Total SKUs', color: '#5b6b8c', definition: 'Active + Non Active + Dormant' } as const;

/** SKU counts in full ("1,014") */
const fmtCount = (n: number) => n.toLocaleString('en-US');
const pct = (n: number, d: number) => (d > 0 ? `${((100 * n) / d).toFixed(1)}%` : '–');
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${fmtCount(Math.abs(n))}`;
const dates = (from: string, to: string) => `${periodDayLabel(from)} – ${periodDayLabel(to)}`;
/** "01 Nov 2026 – 16 Nov 2026": the period in progress ends at the To Date. */
export const periodRange = (p: Pick<SkuTrendPoint, 'start' | 'end' | 'inProgress'>, to: string) => dates(p.start, p.inProgress && to < p.end ? to : p.end);
/** The x-axis label; the period in progress is "Nov 2026 (to date)". */
export const axisLabel = (p: Pick<SkuTrendPoint, 'start' | 'inProgress'>, win: PeriodWindowView) => `${win.label(p.start)}${p.inProgress ? ' (to date)' : ''}`;

/** "Active 880 · 47.6% · +12 MoM": the count, its share of the period's SKUs and the change vs the period before. */
export function statusLine(key: SkuTrendStatus, counts: SkuTrendCounts, previous: SkuTrendCounts | null, g: PeriodGranularity): string {
  const s = SKU_TREND_SERIES.find((x) => x.key === key)!;
  const change = previous ? `${signed(counts[key] - previous[key])} ${CHANGE_LABEL[g]}` : `no ${CHANGE_LABEL[g]}`;
  return `${s.name} ${fmtCount(counts[key])} · ${pct(counts[key], counts.total)} · ${change}`;
}

/** The y-axis top: the highest total + ~15% headroom (the total labels), on a round number whose quarters are round too. */
export function axisMax(totals: number[]): number {
  const raw = Math.max(1, ...totals) * 1.15;
  const quarter = raw / 4;
  const p = 10 ** Math.floor(Math.log10(quarter));
  const step = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * p).find((x) => x >= quarter) ?? 10 * p;
  return 4 * step;
}

// The ComboChart's plot area (its own layout): 24 px above the plot for labels, a 30 px x-axis, a 52 px y-axis, 24 px right.
const PLOT = { top: 24, xAxis: 30, yAxis: 52, right: 24 };
const LABEL_H = 13;
const labelWidth = (text: string) => text.length * 6.6 + 6;
export type LabelPlacement = Partial<Record<SkuTrendStatus, 'above' | 'below'>>;

/**
 * Where each line label goes (above / below its point) so no two labels overlap -- the total label above the bar
 * included. The highest status tries above first, the lowest below first, the middle one whichever is free. If any label
 * of any period cannot be placed, or a label is wider than its period's slot, there are NO line labels (tooltip only).
 */
export function placeLineLabels(points: Array<{ counts: SkuTrendCounts | null }>, max: number, chart: { width: number; height: number }): LabelPlacement[] | null {
  const plotW = chart.width - PLOT.yAxis - PLOT.right;
  const plotH = chart.height - PLOT.top - PLOT.xAxis;
  if (plotW <= 0 || plotH <= 0 || points.length === 0) return null;
  const slot = plotW / points.length;
  const widest = Math.max(0, ...points.flatMap((p) => (p.counts ? [p.counts.active, p.counts.nonActive, p.counts.dormant] : []).map((v) => labelWidth(fmtCount(v)))));
  if (widest > slot - 4) return null;
  const y = (v: number) => PLOT.top + plotH * (1 - v / max);
  const out: LabelPlacement[] = [];
  for (const p of points) {
    const placement: LabelPlacement = {};
    out.push(placement);
    if (!p.counts) continue;
    const taken = [y(p.counts.total) - 12]; // the total label's centre above the bar
    const order = [...SKU_TREND_SERIES].sort((a, b) => p.counts![b.key] - p.counts![a.key]);
    for (const [rank, s] of order.entries()) {
      const py = y(p.counts[s.key]);
      const tries: Array<'above' | 'below'> = rank === order.length - 1 ? ['below', 'above'] : ['above', 'below'];
      const fit = tries.find((side) => {
        const cy = side === 'above' ? py - 11 : py + 12;
        return cy - LABEL_H / 2 >= 0 && cy + LABEL_H / 2 <= PLOT.top + plotH && taken.every((t) => Math.abs(t - cy) >= LABEL_H);
      });
      if (!fit) return null;
      placement[s.key] = fit;
      taken.push(fit === 'above' ? py - 11 : py + 12);
    }
  }
  return out;
}

interface TableRow extends Record<string, unknown> {
  id: string;
  period: string;
  dates: string;
  total: string;
  active: string;
  nonActive: string;
  dormant: string;
}
const TABLE_COLUMNS: Column<TableRow>[] = [
  { key: 'period', header: 'Period' },
  { key: 'dates', header: 'Dates' },
  { key: 'total', header: 'Total SKUs', align: 'right' },
  { key: 'active', header: 'Active', align: 'right' },
  { key: 'nonActive', header: 'Non Active', align: 'right' },
  { key: 'dormant', header: 'Dormant', align: 'right' },
];
const CHART_HEIGHT = 340;

/** The width of an element, kept current (the chart's label layout depends on it). */
function useWidth(el: HTMLDivElement | null): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) return undefined;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return width;
}

export function SkuTrend({ scope, companyLabel, hints }: { scope: ProductDashboardScope; companyLabel: string; hints?: VisualHints }) {
  const { token, error: authError, retryAuth } = useAuth();
  const [granularity, setGranularity] = useState<PeriodGranularity>(DEFAULT_GRANULARITY);
  const win = usePeriodWindow(granularity);
  const trend = useSkuTrend(token, authError, retryAuth, scope, granularity);
  const [drill, setDrill] = useState<{ start: string; status: SkuTrendSelection } | null>(null);
  const chartRef = useRef<HTMLDivElement | null>(null);
  const [chartEl, setChartEl] = useState<HTMLDivElement | null>(null);
  const chartWidth = useWidth(chartEl);
  // a stable callback ref: the export reads chartRef, the label layout follows the element's width
  const setChart = useCallback((el: HTMLDivElement | null) => {
    chartRef.current = el;
    setChartEl(el);
  }, []);
  const canExport = useCanExport();
  // a new period / company / To Date closes the list
  useEffect(() => setDrill(null), [granularity, scope.company, scope.toDate]);

  const data = trend.data?.granularity === granularity ? trend.data : null;
  const points = useMemo(() => data?.points ?? [], [data]);
  const to = data?.to ?? '';
  const loading = trend.loading || (trend.data !== null && trend.data.granularity !== granularity);
  const ready = Boolean(data && data.stockLoaded);
  const subtitle = `${win.name} · ${win.windowLabel} to ${to ? periodDayLabel(to) : '…'} · ${companyLabel}`;

  const max = axisMax(points.map((p) => p.counts?.total ?? 0));
  const placements = useMemo(() => (chartWidth ? placeLineLabels(points, max, { width: chartWidth, height: CHART_HEIGHT }) : null), [points, max, chartWidth]);
  const chartPoints: ComboChartPoint[] = points.map((p) => ({
    label: axisLabel(p, win),
    start: p.start,
    total: p.counts?.total ?? null,
    active: p.counts?.active ?? null,
    nonActive: p.counts?.nonActive ?? null,
    dormant: p.counts?.dormant ?? null,
  }));
  const byLabel = new Map(points.map((p) => [axisLabel(p, win), p]));
  const lineLabel = (key: SkuTrendStatus, color: string) => function LineLabel(props: ComboLabelProps) {
    const side = placements?.[props.index ?? -1]?.[key];
    const value = Number(props.value);
    if (!side || !Number.isFinite(value)) return null;
    const x = Number(props.x);
    const yy = Number(props.y);
    return (
      <text x={x} y={side === 'above' ? yy - 7 : yy + 16} textAnchor="middle" fontSize={11} fontWeight={700} fill={color}
        stroke="var(--ps-color-surface, #111827)" strokeWidth={3} paintOrder="stroke" style={{ pointerEvents: 'none' }} data-testid={`sku-trend-label-${key}`}>
        {fmtCount(value)}
      </text>
    );
  };

  const tableRows: TableRow[] = points.map((p) => {
    const cell = (k: SkuTrendStatus) => (p.counts ? `${fmtCount(p.counts[k])} (${pct(p.counts[k], p.counts.total)})` : 'not loaded');
    return {
      id: p.start,
      period: `${win.title(p.start)}${p.inProgress ? ' (to date)' : ''}`,
      dates: periodRange(p, to),
      total: p.counts ? fmtCount(p.counts.total) : 'not loaded',
      active: cell('active'),
      nonActive: cell('nonActive'),
      dormant: cell('dormant'),
    };
  });
  const missing = data?.missingStockDates ?? [];

  const exportPdf = () => exportRowsAsPdf({
    title: 'SKU Trend',
    subtitle: `${subtitle} · Total SKUs and Active / Non Active / Dormant SKUs (Unclassified excluded)`,
    filterParts: [`Company: ${companyLabel}`, `To Date: ${to ? periodDayLabel(to) : 'today'}`, `Period: ${win.name} (${win.windowLabel})`],
    columns: TABLE_COLUMNS.map((c) => ({ header: c.header, align: c.align })),
    rows: tableRows.map((r) => TABLE_COLUMNS.map((c) => String(r[c.key as keyof TableRow] ?? ''))),
    fileName: `sku-trend-${win.name.toLowerCase()}`,
  });
  const exportImage = () => exportSvgAsImage(chartRef.current, `sku-trend-${win.name.toLowerCase()}`, {
    legend: [
      { label: `SKU Trend · ${subtitle}`, value: '', bold: true },
      { color: TOTAL_SERIES.color, label: `${TOTAL_SERIES.name} (bars)`, value: TOTAL_SERIES.definition },
      ...SKU_TREND_SERIES.map((s) => ({ color: s.color, label: `${s.name} (line)`, value: s.definition })),
      ...(points.some((p) => p.inProgress) ? [{ label: '(to date): lighter bar, dashed line', value: 'period in progress: today’s stock' }] : []),
    ],
  });

  return (
    <section aria-label="SKU Trend" data-testid="sku-trend">
      <ChartPanel<TableRow>
        title="SKU Trend"
        {...hints}
        wrapHeader
        tableColumns={ready && !drill ? TABLE_COLUMNS : undefined}
        tableRows={ready && !drill ? tableRows : undefined}
        getRowId={(r) => r.id}
        headerActions={(
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <PeriodTrendSelector value={granularity} onChange={setGranularity} label="SKU Trend period" granularities={SKU_TREND_GRANULARITIES} />
            {ready && !drill && canExport && (
              <button type="button" onClick={exportImage} style={EXPORT_BUTTON} aria-label="Export the SKU Trend chart as an image">Export image</button>
            )}
            {ready && !drill && <ExportButtons label="SKU Trend" onPdf={exportPdf} />}
          </div>
        )}
      >
        <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', marginBottom: 6 }} data-testid="sku-trend-subtitle">{subtitle}</div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12, fontSize: 12 }} data-testid="sku-trend-legend">
          <span title={TOTAL_SERIES.definition} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--ps-color-text)' }}>
            <span aria-hidden style={{ width: 10, height: 12, borderRadius: 2, background: TOTAL_SERIES.color }} />
            {TOTAL_SERIES.name}
          </span>
          {SKU_TREND_SERIES.map((s) => (
            <span key={s.key} title={s.definition} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--ps-color-text)' }}>
              <svg aria-hidden width={18} height={10}><line x1={1} y1={5} x2={17} y2={5} stroke={s.color} strokeWidth={2} /><circle cx={9} cy={5} r={2.5} fill={s.color} /></svg>
              {s.name}
            </span>
          ))}
        </div>
        {trend.error ? (
          <ErrorState message={trend.error} onRetry={trend.retry} />
        ) : loading || !data ? (
          <LoadingSkeleton variant="chart" />
        ) : !data.stockLoaded ? (
          <div data-testid="sku-trend-not-loaded">
            <EmptyState message="Stock history not loaded yet – run the backfill script" />
          </div>
        ) : drill ? (
          <SkuTrendDrill scope={scope} granularity={granularity} win={win} drill={drill} point={points.find((p) => p.start === drill.start) ?? null}
            to={to} companyLabel={companyLabel} onStatus={(status) => setDrill({ ...drill, status })} onBack={() => setDrill(null)} />
        ) : null}
        {/* the chart stays mounted under a drill-down (hidden), so its width is known when coming back */}
        {!trend.error && !loading && data?.stockLoaded && (
          <div ref={setChart} data-testid="sku-trend-chart" style={{ width: '100%', display: drill ? 'none' : 'block' }}>
            <ComboChart
              title={`SKU Trend ${win.name}`}
              showTitle={false}
              showExportButton={false}
              showLegend={false}
              points={chartPoints}
              bars={[{ key: TOTAL_SERIES.key, name: TOTAL_SERIES.name, color: TOTAL_SERIES.color, labelFormatter: fmtCount }]}
              lines={SKU_TREND_SERIES.map((s) => ({ key: s.key, name: s.name, color: s.color, yAxisId: 'left' as const, labelContent: lineLabel(s.key, s.color) }))}
              leftDomain={[0, max]}
              leftAxisFormatter={fmtCount}
              barCategoryGap="22%"
              maxBarSize={72}
              connectNulls={false}
              inProgressLabel={points.find((p) => p.inProgress) ? axisLabel(points.find((p) => p.inProgress)!, win) : null}
              inProgressBarStyle="faded"
              height={CHART_HEIGHT}
              tooltipContent={(t) => <PeriodTooltip point={t.active ? byLabel.get(String(t.label)) : undefined} win={win} granularity={granularity} to={to} />}
              onSeriesClick={(label, key) => {
                const p = byLabel.get(label);
                if (p) setDrill({ start: p.start, status: key === TOTAL_SERIES.key ? 'all' : (key as SkuTrendStatus) });
              }}
            />
            {missing.length > 0 && (
              <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginTop: 4 }}>
                No stock history for {missing.map(periodDayLabel).join(', ')}: those periods are left empty.
              </div>
            )}
          </div>
        )}
      </ChartPanel>
    </section>
  );
}

const EXPORT_BUTTON: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: 'var(--ps-color-muted-text)', background: 'var(--ps-color-muted-bg)',
  border: '1px solid var(--ps-color-border)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer',
};

/** The period's dates, its total, then each status (count · % of the total · change vs the period before). */
export function PeriodTooltip({ point, win, granularity, to }: { point?: SkuTrendPoint; win: PeriodWindowView; granularity: PeriodGranularity; to: string }) {
  if (!point) return null;
  const c = point.counts;
  return (
    <div style={{ ...tooltipBoxStyle, minWidth: 240 }} data-testid="sku-trend-tooltip">
      <div style={{ fontWeight: 700, marginBottom: 2 }}>{win.title(point.start)}{point.inProgress ? ' (to date)' : ''}</div>
      <div style={{ fontSize: 11, opacity: 0.75, marginBottom: 6 }}>
        {periodRange(point, to)}{point.inProgress ? ' · today’s stock' : ` · stock on ${periodDayLabel(point.stockDate)}`}
      </div>
      {c ? (
        <>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>
            Total {fmtCount(c.total)}{point.previous ? ` · ${signed(c.total - point.previous.total)} ${CHANGE_LABEL[granularity]}` : ''}
          </div>
          {SKU_TREND_SERIES.map((s) => (
            <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, lineHeight: '18px' }}>
              <span aria-hidden style={{ width: 8, height: 8, borderRadius: 4, background: s.color, flexShrink: 0 }} />
              {statusLine(s.key, c, point.previous, granularity)}
            </div>
          ))}
        </>
      ) : (
        <div style={{ fontSize: 12 }}>Stock history not loaded for this period end.</div>
      )}
    </div>
  );
}

const SELECTIONS: { key: SkuTrendSelection; name: string; color: string; definition: string }[] = [
  { key: 'all', name: 'All SKUs', color: TOTAL_SERIES.color, definition: TOTAL_SERIES.definition },
  ...SKU_TREND_SERIES,
];
const STATUS_NAME = Object.fromEntries(SKU_TREND_SERIES.map((s) => [s.key, s.name])) as Record<SkuTrendStatus, string>;

/** The SKUs of the period (the bar) or of one status (a line point): the Product pages' sortable list (search, Export CSV /
 * PDF), chips to switch. */
function SkuTrendDrill({ scope, granularity, win, drill, point, to, companyLabel, onStatus, onBack }: {
  scope: ProductDashboardScope;
  granularity: PeriodGranularity;
  win: PeriodWindowView;
  drill: { start: string; status: SkuTrendSelection };
  point: SkuTrendPoint | null;
  to: string;
  companyLabel: string;
  onStatus: (status: SkuTrendSelection) => void;
  onBack: () => void;
}) {
  const { token } = useAuth();
  const [state, setState] = useState<{ data: SkuTrendSkuList | null; error: string | null }>({ data: null, error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!token) return;
    let live = true;
    setState({ data: null, error: null });
    fetchSkuTrendSkus(token, scope, granularity, drill.start, drill.status)
      .then((data) => live && setState({ data, error: null }))
      .catch((err) => live && setState({ data: null, error: err.message ?? 'Failed to load.' }));
    return () => {
      live = false;
    };
  }, [token, scope, granularity, drill.start, drill.status, attempt]);

  const selection = SELECTIONS.find((s) => s.key === drill.status)!;
  const periodName = `${win.title(drill.start)}${point?.inProgress ? ' (to date)' : ''}`;
  const stockOn = point ? periodDayLabel(point.stockDate) : '';
  const columns: SortableColumn<SkuTrendSku>[] = [
    { key: 'sku', header: 'Code', value: (r) => r.sku ?? '', sortValue: (r) => r.sku, render: (r) => r.sku ?? '—', width: 110 },
    // capped: a long name is cut with an ellipsis (full name on hover) so every number column stays in view
    { key: 'productName', header: 'Product', value: (r) => r.productName, sortValue: (r) => r.productName, width: 320,
      render: (r) => <ProductName name={`${r.productName}${r.archived ? ' (archived)' : ''}`} href={r.odooUrl} style={{ maxWidth: 'min(320px, 32vw)' }} /> },
    { key: 'company', header: 'Company', value: (r) => r.companies.join(', '), sortValue: (r) => r.companies.join(', '), render: (r) => r.companies.join(', ') },
    ...(drill.status === 'all'
      ? [{ key: 'status', header: 'Status', value: (r: SkuTrendSku) => STATUS_NAME[r.status], sortValue: (r: SkuTrendSku) => STATUS_NAME[r.status],
        render: (r: SkuTrendSku) => <span style={{ color: STATUS_COLOR[r.status === 'nonActive' ? 'non_active' : r.status], fontWeight: 700 }}>{STATUS_NAME[r.status]}</span> }]
      : []),
    { key: 'units', header: 'Units sold', align: 'right', value: (r) => r.units, text: (r) => fmtNum(r.units), sortValue: (r) => r.units, render: (r) => fmtNum(r.units) },
    { key: 'value', header: 'LYD', align: 'right', value: (r) => r.value, text: (r) => fmtLYD(r.value), sortValue: (r) => r.value, render: (r) => fmtLYD(r.value) },
    { key: 'onHandQty', header: `On hand (${stockOn})`, align: 'right', value: (r) => r.onHandQty, text: (r) => fmtNum(r.onHandQty), sortValue: (r) => r.onHandQty, render: (r) => fmtNum(r.onHandQty) },
  ];
  const title = `${selection.name}${drill.status === 'all' ? '' : ' SKUs'} · ${periodName}`;
  return (
    <div data-testid="sku-trend-drill">
      <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" onClick={onBack}
          style={{ background: 'none', border: 'none', padding: 0, color: 'var(--ps-color-accent)', fontWeight: 600, cursor: 'pointer', fontSize: 12 }}>
          ← Back to the trend
        </button>
        <span>›</span>
        <span style={{ color: 'var(--ps-color-text)', fontWeight: 600 }}>{title}</span>
        {point && <span>· {periodRange(point, to)} · stock on {stockOn}</span>}
      </div>
      <div role="group" aria-label="Status" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {SELECTIONS.map((s) => (
          <button key={s.key} type="button" onClick={() => onStatus(s.key)} aria-pressed={s.key === drill.status}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '3px 10px', borderRadius: 999, cursor: 'pointer',
              border: `1px solid ${s.key === drill.status ? s.color : 'var(--ps-color-border)'}`, background: s.key === drill.status ? 'var(--ps-color-muted-bg)' : 'transparent',
              color: 'var(--ps-color-text)', fontWeight: s.key === drill.status ? 700 : 400 }}>
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: s.color }} />
            {s.name} {point?.counts ? fmtCount(s.key === 'all' ? point.counts.total : point.counts[s.key]) : ''}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginBottom: 8 }}>{selection.name}: {selection.definition}</div>
      {state.error ? (
        <ErrorState message={state.error} onRetry={() => setAttempt((n) => n + 1)} />
      ) : !state.data ? (
        <LoadingSkeleton variant="table" />
      ) : (
        <SortableProductTable
          testId="sku-trend-drill-table"
          columns={columns}
          rows={state.data.skus}
          getRowId={(r) => r.odooProductId}
          searchText={(r) => `${r.sku ?? ''} ${r.productName} ${r.companies.join(' ')}`}
          defaultSort={{ key: 'value', dir: 'desc' }}
          fileName={`sku-trend-${drill.status}-${drill.start}`}
          pdfTitle={title}
          pdfSubtitle={`${companyLabel} · ${point ? periodRange(point, to) : ''} · stock on ${stockOn} · ${selection.definition}`}
          pdfFilterParts={[`Company: ${companyLabel}`, `To Date: ${to ? periodDayLabel(to) : 'today'}`, `Period: ${periodName}`]}
          maxHeight={420}
        />
      )}
    </div>
  );
}
