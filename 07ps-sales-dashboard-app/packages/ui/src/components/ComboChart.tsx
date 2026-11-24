import React, { useRef, useState, type ReactNode } from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Cell,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  LabelList,
} from 'recharts';
import { exportSvgAsImage } from '../chartExport';
import { chartTooltipProps } from '../chartTooltip';
import { useCanExport } from '../exportPermission';
import { DISPLAY_LOCALE } from '../locale';
import { doneKey, inProgressIndex, inProgressKey, inProgressTitle, withInProgressSegment } from './inProgressSegment';

export interface ComboBarSeries {
  key: string;
  name: string;
  color: string;
  /** Bars sharing a stackId are stacked on top of each other (e.g. the parts of a total); unset = side by side. */
  stackId?: string;
  /** When set, each bar's value is printed above it with this formatter (e.g. a total). */
  labelFormatter?: (value: number) => string;
}

/** What a custom point label receives (Recharts LabelList content): the point's pixel position, value and index. */
export interface ComboLabelProps {
  x?: number | string;
  y?: number | string;
  value?: unknown;
  index?: number;
}

export interface ComboLineSeries {
  key: string;
  name: string;
  color: string;
  /** Which Y axis this line reads against. Defaults to 'right' -- bars are always the primary
   * (left) series, lines are the usual secondary-axis complement. */
  yAxisId?: 'left' | 'right';
  /** When set, each point's value is printed above it with this formatter (e.g. the total of stacked bars). */
  labelFormatter?: (value: number) => string;
  /** A custom point label (placement, hiding), instead of labelFormatter's label above the point. */
  labelContent?: (props: ComboLabelProps) => ReactNode;
}

export interface ComboChartPoint {
  label: string;
  [key: string]: string | number | null | undefined;
}

export interface ComboChartProps {
  title?: string;
  /** Suppress the internal title text (still renders the Export image button) -- for callers that
   * already show the title in their own surrounding chart-card chrome (e.g. @07ps/ui's
   * ChartPanel), so the title isn't rendered twice. Defaults to true. */
  showTitle?: boolean;
  points: ComboChartPoint[];
  bars: ComboBarSeries[];
  /** Every category label on the X axis, angled (e.g. branch names, 2026-11-15). Default: Recharts thins them out. */
  showAllCategories?: boolean;
  lines?: ComboLineSeries[];
  leftAxisFormatter?: (value: number) => string;
  rightAxisFormatter?: (value: number) => string;
  /** Per-series full-precision tooltip formatter, keyed by series `key`. Receives the point for
   * context such as a percentage of its total. Falls back to the axis formatter for that series. */
  tooltipFormatters?: Record<string, (value: number, point?: ComboChartPoint) => string>;
  height?: number;
  /** Grow with the card: the chart takes every pixel the card body has left (at least `height`), so a card stretched to
   * its row's height has no empty band under the chart. Needs a parent with a definite height (ChartPanel in a grid row). */
  fill?: boolean;
  /** The whole plot area becomes clickable (pointer cursor) and invokes this with the clicked
   * point's `label` -- fires whether the click lands on a bar, a line point, or elsewhere in that
   * category's column, since Recharts resolves the nearest category from the click's X position
   * regardless of which series (or empty space between series) was actually under the cursor. Used
   * for both the drill-down (year -> class) and the page-filter/cross-filter click behavior.
   * `opts.additive` is true for a Ctrl / Cmd click (add to / remove from a multi-selection); callers may ignore it. */
  onCategoryClick?: (label: string, opts?: { additive: boolean }) => void;
  /** Fires when a click lands truly outside any category's column (the chart's own margins) --
   * only meaningful alongside onCategoryClick. Callers typically clear their selection here, as the
   * "click empty space to clear" half of a click-to-select/click-to-clear toggle. */
  onAreaClick?: () => void;
  /** Renders the matching bar with a highlighted outline and full opacity, while every other bar
   * dims -- the "this is the active page filter" affordance for the chart currently *driving* a
   * selection (as opposed to a chart merely scoped by someone else's selection, which needs no
   * special styling since all of its bars already reflect the filtered data). */
  highlightedCategory?: string | null;
  /** The multi-select form of highlightedCategory: every listed category is highlighted, the others dim (35%). Empty or
   * absent = nothing dims. Opt-in. */
  highlightedCategories?: readonly string[] | null;
  /** The x-axis labels call onCategoryClick too (pointer cursor on them). Opt-in. */
  clickableAxisLabels?: boolean;
  /** Join a line across points whose value is null (default true). False shows the gap -- for a time axis with
   * missing days, where a joined line would draw a trend that has no data behind it. */
  connectNulls?: boolean;
  /** Space above the plot, px. Default 4, or 24 when a line prints its values (so the top label is not clipped). */
  topPadding?: number;
  /** Tooltip title for a point's label (default: the label itself), e.g. a full period name plus a count. */
  tooltipLabelFormatter?: (label: string) => string;
  /** The label of the current, partial period (the last point): its bars are lighter with a dashed outline, its line
   * segments dashed, and its tooltip says "Period in progress". Unset = no period in progress. */
  inProgressLabel?: string | null;
  /** The in-progress bar: 'outlined' (default) lighter with a dashed outline, 'faded' lighter only. */
  inProgressBarStyle?: 'outlined' | 'faded';
  /** The left axis' domain, e.g. [0, max * 1.15] for headroom above bar labels. Default: Recharts' own. */
  leftDomain?: [number | string, number | string];
  /** Bar width as a share of the slot: the gap on each side of a category (e.g. '22%') and a cap in px. Unset = the fixed
   * 18 / 32 px bars. */
  barCategoryGap?: string | number;
  maxBarSize?: number;
  /** Recharts' legend under the plot (default true); off when the page draws its own. */
  showLegend?: boolean;
  /** The built-in Export image button (default true); off when the page puts its own in a header. */
  showExportButton?: boolean;
  /** A custom tooltip body (receives Recharts' active / payload / label), instead of the formatter list. */
  tooltipContent?: (props: { active?: boolean; payload?: ReadonlyArray<{ payload?: ComboChartPoint }>; label?: unknown }) => ReactNode;
  /** A click on one bar or one line point: its category label and series key (e.g. a drill-down per series). Fires
   * instead of onCategoryClick for that click. */
  onSeriesClick?: (label: string, seriesKey: string) => void;
}

function defaultFormatter(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toLocaleString(DISPLAY_LOCALE, { maximumFractionDigits: 0 });
}

/**
 * Dual-axis bar+line chart -- same building blocks/conventions as TrendChart.tsx and
 * BreakdownChart.tsx (Recharts, CSS-variable theming, toggleable legend, native-browser SVG->PNG
 * "Export image" button, full-precision tooltip separate from the axis display formatter), just
 * generalized to an arbitrary set of bar/line series on independent axes instead of a fixed
 * actual/target shape. Built for the Invoices Engine page's Sales Trend / Invoices Trend charts,
 * but page-agnostic -- any bars+lines-by-category chart can reuse it.
 */
export function ComboChart({
  title,
  showTitle = true,
  points,
  bars,
  lines = [],
  leftAxisFormatter = defaultFormatter,
  rightAxisFormatter = defaultFormatter,
  tooltipFormatters,
  height = 300,
  showAllCategories = false,
  fill = false,
  onCategoryClick,
  onAreaClick,
  highlightedCategory = null,
  highlightedCategories = null,
  clickableAxisLabels = false,
  connectNulls = true,
  topPadding,
  tooltipLabelFormatter,
  inProgressLabel = null,
  inProgressBarStyle = 'outlined',
  leftDomain,
  barCategoryGap,
  maxBarSize,
  showLegend = true,
  showExportButton = true,
  tooltipContent,
  onSeriesClick,
}: ComboChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const hasRightAxis = lines.some((l) => (l.yAxisId ?? 'right') === 'right');
  const labelPx = (label: unknown) => String(label ?? '').length * 6.2;
  // cos 30° of the first label, minus the Y axis' own ~44 px; sin 30° of the longest label + the tick gap
  const allCategoriesLeft = showAllCategories && points.length ? Math.max(0, Math.ceil(labelPx(points[0].label) * 0.87) - 44) : 0;
  const allCategoriesHeight = showAllCategories ? Math.min(160, Math.ceil(Math.max(0, ...points.map((p) => labelPx(p.label))) * 0.5) + 16) : 30;
  const ipIndex = inProgressIndex(points, inProgressLabel);
  const data = withInProgressSegment(points, lines.map((l) => l.key), ipIndex);

  // A bar / point click (onSeriesClick) also reaches the chart's own click: skip the category click that follows it.
  const seriesClicked = useRef(false);
  const seriesClick = (label: unknown, key: string) => {
    if (!onSeriesClick || typeof label !== 'string') return;
    seriesClicked.current = true;
    onSeriesClick(label, key);
  };
  // With onSeriesClick the visible line dots open their series too (they sit on top of the bars and the hover dot): a dot
  // rendered by hand knows its point. Without it the dots stay Recharts' own { r: 3 } (other charts unchanged).
  const clickableDot = (key: string, color: string) => (props: { cx?: number; cy?: number; index?: number; payload?: { label?: unknown } }) =>
    props.cx != null && props.cy != null
      ? <circle key={`d${props.index}`} cx={props.cx} cy={props.cy} r={3} fill="#fff" stroke={color} strokeWidth={2} style={{ cursor: 'pointer' }}
        data-testid="combo-dot" onClick={() => seriesClick(props.payload?.label, key)} />
      : <g key={`n${props.index}`} />;
  const additive = (e: any) => Boolean(e?.ctrlKey || e?.metaKey);
  const handleChartClick = (state: any, e?: any) => {
    if (seriesClicked.current) {
      seriesClicked.current = false;
      return;
    }
    if (!onCategoryClick) return;
    const label = state?.activeLabel;
    if (typeof label === 'string') onCategoryClick(label, { additive: additive(e) });
    else onAreaClick?.();
  };
  // An axis label click: handled here only (the chart's own click below the plot would read as "empty space").
  const handleTickClick = (entry: any, _i: number, e?: any) => {
    if (!onCategoryClick || entry?.value === undefined) return;
    seriesClicked.current = true;
    e?.stopPropagation?.();
    onCategoryClick(String(entry.value), { additive: additive(e) });
  };
  const selection = highlightedCategories && highlightedCategories.length ? highlightedCategories : highlightedCategory != null ? [highlightedCategory] : null;

  const handleLegendClick = (o: unknown) => {
    const key = (o as { dataKey?: unknown })?.dataKey;
    if (typeof key !== 'string') return;
    setHidden((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const tooltipFormatterFor = (dataKey: string, isRightAxis: boolean) => {
    if (tooltipFormatters?.[dataKey]) return tooltipFormatters[dataKey];
    return isRightAxis ? rightAxisFormatter : leftAxisFormatter;
  };

  const canExport = useCanExport();
  const handleExportImage = () => {
    exportSvgAsImage(containerRef.current, (title ?? 'chart').replace(/\s+/g, '-').toLowerCase());
  };

  return (
    <div style={fill ? { width: '100%', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } : { width: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: showTitle ? 'space-between' : 'flex-end',
          marginBottom: 'var(--ps-space-2, 8px)',
        }}
      >
        {showTitle && <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ps-color-text)' }}>{title}</span>}
        {canExport && showExportButton && (
        <button
          type="button"
          onClick={handleExportImage}
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--ps-color-muted-text)',
            background: 'var(--ps-color-muted-bg)',
            border: '1px solid var(--ps-color-border)',
            borderRadius: 6,
            padding: '4px 10px',
            cursor: 'pointer',
          }}
        >
          Export image
        </button>
        )}
      </div>
      <div ref={containerRef} style={{ width: '100%', cursor: onCategoryClick || onSeriesClick ? 'pointer' : 'default', ...(fill ? { flex: 1, minHeight: height } : {}) }}>
        {/* showAllCategories: the -30° labels hang left of their tick, so the left margin makes room for the first one and the
            axis is as tall as the longest one (≈ 6.2 px per 11 px character): no label is ever clipped, on screen or exported. */}
        <ResponsiveContainer width="100%" height={fill ? '100%' : height}>
          <ComposedChart
            data={data}
            {...(barCategoryGap !== undefined ? { barCategoryGap } : {})}
            margin={{ top: topPadding ?? (lines.some((l) => l.labelFormatter || l.labelContent) || bars.some((b) => b.labelFormatter) ? 24 : 4), right: hasRightAxis ? 8 : 24, left: allCategoriesLeft, bottom: 0 }}
            onClick={handleChartClick}
          >
            <CartesianGrid stroke="var(--ps-color-border)" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: 'var(--ps-color-muted-text)', ...(clickableAxisLabels && onCategoryClick ? { cursor: 'pointer' } : {}) }}
              axisLine={{ stroke: 'var(--ps-color-border)' }}
              tickLine={false}
              {...(clickableAxisLabels && onCategoryClick ? { onClick: handleTickClick } : {})}
              {...(showAllCategories ? { interval: 0, angle: -30, textAnchor: 'end', height: allCategoriesHeight } : {})}
            />
            <YAxis
              yAxisId="left"
              tick={{ fontSize: 11, fill: 'var(--ps-color-muted-text)' }}
              axisLine={false}
              tickLine={false}
              tickFormatter={leftAxisFormatter}
              width={52}
              {...(leftDomain ? { domain: leftDomain, allowDecimals: false } : {})}
            />
            {hasRightAxis && (
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={{ fontSize: 11, fill: 'var(--ps-color-muted-text)' }}
                axisLine={false}
                tickLine={false}
                tickFormatter={rightAxisFormatter}
                width={52}
              />
            )}
            <Tooltip {...chartTooltipProps}
              {...(tooltipContent ? { content: (props: any) => tooltipContent(props) } : {})}
              labelFormatter={tooltipLabelFormatter || ipIndex >= 0 ? (label: unknown) => inProgressTitle(String(label), inProgressLabel, tooltipLabelFormatter) : undefined}
              formatter={(value: number, name: string, item: any) => {
                const dataKey = item?.dataKey as string;
                const isRightAxis = item?.payload && lines.some((l) => l.key === dataKey && (l.yAxisId ?? 'right') === 'right');
                return [tooltipFormatterFor(dataKey, !!isRightAxis)(value, item?.payload), name];
              }}
            />
            {showLegend && <Legend onClick={handleLegendClick} wrapperStyle={{ fontSize: 12, cursor: 'pointer' }} />}
            {bars.map((b) => (
              <Bar
                key={b.key}
                yAxisId="left"
                dataKey={b.key}
                name={b.name}
                fill={b.color}
                stackId={b.stackId}
                radius={b.stackId ? [0, 0, 0, 0] : [4, 4, 0, 0]}
                {...(barCategoryGap !== undefined ? { maxBarSize } : { barSize: points.length > 8 ? 18 : 32 })}
                hide={!!hidden[b.key]}
                isAnimationActive={false}
                onClick={onSeriesClick ? (d: { payload?: { label?: unknown } }) => seriesClick(d?.payload?.label, b.key) : undefined}
              >
                {b.labelFormatter ? (
                  <LabelList
                    dataKey={b.key}
                    position="top"
                    offset={6}
                    formatter={(v: number) => b.labelFormatter!(Number(v))}
                    // stroke none: an in-progress cell's outline would otherwise outline the text too
                    style={{ fontSize: 11, fontWeight: 700, fill: 'var(--ps-color-text)', stroke: 'none' }}
                  />
                ) : null}
                {points.map((p, i) => {
                  const isSelected = selection !== null && selection.includes(p.label);
                  const dimmed = selection !== null && !isSelected;
                  const inProgress = i === ipIndex;
                  const outlined = inProgress && inProgressBarStyle === 'outlined';
                  return (
                    <Cell
                      key={p.label}
                      fill={b.color}
                      fillOpacity={dimmed ? 0.35 : inProgress ? 0.45 : 1}
                      stroke={isSelected ? 'var(--ps-color-gold)' : outlined ? b.color : 'none'}
                      strokeWidth={isSelected || outlined ? (isSelected ? 2 : 1.5) : 0}
                      strokeDasharray={outlined && !isSelected ? '4 3' : undefined}
                    />
                  );
                })}
              </Bar>
            ))}
            {lines.map((l) => (
              <Line
                key={l.key}
                yAxisId={l.yAxisId ?? 'right'}
                type="monotone"
                dataKey={l.key}
                name={l.name}
                stroke={l.color}
                strokeOpacity={ipIndex < 0 ? 1 : 0}
                strokeWidth={2}
                dot={ipIndex < 0 ? (onSeriesClick ? clickableDot(l.key, l.color) : { r: 3 }) : false}
                // Recharts gives an activeDot object's onClick no point data: a rendered dot knows its point
                {...(onSeriesClick ? {
                  activeDot: (props: { cx?: number; cy?: number; payload?: { label?: unknown } }) => (
                    <circle cx={props.cx} cy={props.cy} r={5} fill={l.color} stroke="var(--ps-color-surface, #fff)" strokeWidth={2}
                      style={{ cursor: 'pointer' }} data-testid="combo-active-dot" onClick={() => seriesClick(props.payload?.label, l.key)} />
                  ),
                } : {})}
                hide={!!hidden[l.key]}
                isAnimationActive={false}
                connectNulls={connectNulls}
              >
                {l.labelContent ? (
                  <LabelList dataKey={l.key} content={(props: ComboLabelProps) => l.labelContent!(props) as any} />
                ) : l.labelFormatter ? (
                  <LabelList
                    dataKey={l.key}
                    position="top"
                    offset={8}
                    formatter={(v: number) => l.labelFormatter!(Number(v))}
                    style={{ fontSize: 11, fontWeight: 600, fill: 'var(--ps-color-text)' }}
                  />
                ) : null}
              </Line>
            ))}
            {ipIndex >= 0 && lines.flatMap((l) => [
              <Line key={doneKey(l.key)} yAxisId={l.yAxisId ?? 'right'} type="monotone" dataKey={doneKey(l.key)} stroke={l.color} strokeWidth={2}
                dot={onSeriesClick ? clickableDot(l.key, l.color) : { r: 3 }} activeDot={false} legendType="none" tooltipType="none" hide={!!hidden[l.key]} isAnimationActive={false}
                connectNulls={connectNulls} />,
              <Line key={inProgressKey(l.key)} yAxisId={l.yAxisId ?? 'right'} type="monotone" dataKey={inProgressKey(l.key)} stroke={l.color}
                strokeWidth={2} strokeDasharray="6 4" activeDot={false} legendType="none" tooltipType="none" hide={!!hidden[l.key]}
                isAnimationActive={false} connectNulls={false}
                dot={(props: { cx?: number; cy?: number; index?: number }) => props.index === ipIndex && props.cx != null && props.cy != null
                  ? <circle key="ip" cx={props.cx} cy={props.cy} r={3.5} fill="var(--ps-color-surface, #fff)" stroke={l.color} strokeWidth={2}
                    {...(onSeriesClick ? { style: { cursor: 'pointer' }, onClick: () => seriesClick(points[ipIndex]?.label, l.key) } : {})} />
                  : <g key={`n${props.index}`} />} />,
            ])}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
