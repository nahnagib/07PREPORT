import React, { useRef, useState } from 'react';
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
  lines?: ComboLineSeries[];
  leftAxisFormatter?: (value: number) => string;
  rightAxisFormatter?: (value: number) => string;
  /** Per-series full-precision tooltip formatter, keyed by series `key`. Receives the point for
   * context such as a percentage of its total. Falls back to the axis formatter for that series. */
  tooltipFormatters?: Record<string, (value: number, point?: ComboChartPoint) => string>;
  height?: number;
  /** The whole plot area becomes clickable (pointer cursor) and invokes this with the clicked
   * point's `label` -- fires whether the click lands on a bar, a line point, or elsewhere in that
   * category's column, since Recharts resolves the nearest category from the click's X position
   * regardless of which series (or empty space between series) was actually under the cursor. Used
   * for both the drill-down (year -> class) and the page-filter/cross-filter click behavior. */
  onCategoryClick?: (label: string) => void;
  /** Fires when a click lands truly outside any category's column (the chart's own margins) --
   * only meaningful alongside onCategoryClick. Callers typically clear their selection here, as the
   * "click empty space to clear" half of a click-to-select/click-to-clear toggle. */
  onAreaClick?: () => void;
  /** Renders the matching bar with a highlighted outline and full opacity, while every other bar
   * dims -- the "this is the active page filter" affordance for the chart currently *driving* a
   * selection (as opposed to a chart merely scoped by someone else's selection, which needs no
   * special styling since all of its bars already reflect the filtered data). */
  highlightedCategory?: string | null;
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
  onCategoryClick,
  onAreaClick,
  highlightedCategory = null,
  connectNulls = true,
  topPadding,
  tooltipLabelFormatter,
  inProgressLabel = null,
}: ComboChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const hasRightAxis = lines.some((l) => (l.yAxisId ?? 'right') === 'right');
  const ipIndex = inProgressIndex(points, inProgressLabel);
  const data = withInProgressSegment(points, lines.map((l) => l.key), ipIndex);

  const handleChartClick = (state: any) => {
    if (!onCategoryClick) return;
    const label = state?.activeLabel;
    if (typeof label === 'string') onCategoryClick(label);
    else onAreaClick?.();
  };

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
    <div style={{ width: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: showTitle ? 'space-between' : 'flex-end',
          marginBottom: 'var(--ps-space-2, 8px)',
        }}
      >
        {showTitle && <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ps-color-text)' }}>{title}</span>}
        {canExport && (
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
      <div ref={containerRef} style={{ width: '100%', cursor: onCategoryClick ? 'pointer' : 'default' }}>
        <ResponsiveContainer width="100%" height={height}>
          <ComposedChart
            data={data}
            margin={{ top: topPadding ?? (lines.some((l) => l.labelFormatter) ? 24 : 4), right: hasRightAxis ? 8 : 24, left: 0, bottom: 0 }}
            onClick={handleChartClick}
          >
            <CartesianGrid stroke="var(--ps-color-border)" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: 'var(--ps-color-muted-text)' }}
              axisLine={{ stroke: 'var(--ps-color-border)' }}
              tickLine={false}
            />
            <YAxis
              yAxisId="left"
              tick={{ fontSize: 11, fill: 'var(--ps-color-muted-text)' }}
              axisLine={false}
              tickLine={false}
              tickFormatter={leftAxisFormatter}
              width={52}
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
              labelFormatter={tooltipLabelFormatter || ipIndex >= 0 ? (label: unknown) => inProgressTitle(String(label), inProgressLabel, tooltipLabelFormatter) : undefined}
              formatter={(value: number, name: string, item: any) => {
                const dataKey = item?.dataKey as string;
                const isRightAxis = item?.payload && lines.some((l) => l.key === dataKey && (l.yAxisId ?? 'right') === 'right');
                return [tooltipFormatterFor(dataKey, !!isRightAxis)(value, item?.payload), name];
              }}
            />
            <Legend onClick={handleLegendClick} wrapperStyle={{ fontSize: 12, cursor: 'pointer' }} />
            {bars.map((b) => (
              <Bar
                key={b.key}
                yAxisId="left"
                dataKey={b.key}
                name={b.name}
                fill={b.color}
                stackId={b.stackId}
                radius={b.stackId ? [0, 0, 0, 0] : [4, 4, 0, 0]}
                barSize={points.length > 8 ? 18 : 32}
                hide={!!hidden[b.key]}
                isAnimationActive={false}
              >
                {points.map((p, i) => {
                  const isSelected = highlightedCategory === p.label;
                  const dimmed = highlightedCategory != null && !isSelected;
                  const inProgress = i === ipIndex;
                  return (
                    <Cell
                      key={p.label}
                      fill={b.color}
                      fillOpacity={dimmed ? 0.35 : inProgress ? 0.45 : 1}
                      stroke={isSelected ? 'var(--ps-color-gold)' : inProgress ? b.color : 'none'}
                      strokeWidth={isSelected || inProgress ? (isSelected ? 2 : 1.5) : 0}
                      strokeDasharray={inProgress && !isSelected ? '4 3' : undefined}
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
                dot={ipIndex < 0 ? { r: 3 } : false}
                hide={!!hidden[l.key]}
                isAnimationActive={false}
                connectNulls={connectNulls}
              >
                {l.labelFormatter ? (
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
                dot={{ r: 3 }} activeDot={false} legendType="none" tooltipType="none" hide={!!hidden[l.key]} isAnimationActive={false}
                connectNulls={connectNulls} />,
              <Line key={inProgressKey(l.key)} yAxisId={l.yAxisId ?? 'right'} type="monotone" dataKey={inProgressKey(l.key)} stroke={l.color}
                strokeWidth={2} strokeDasharray="6 4" activeDot={false} legendType="none" tooltipType="none" hide={!!hidden[l.key]}
                isAnimationActive={false} connectNulls={false}
                dot={(props: { cx?: number; cy?: number; index?: number }) => props.index === ipIndex && props.cx != null && props.cy != null
                  ? <circle key="ip" cx={props.cx} cy={props.cy} r={3.5} fill="var(--ps-color-surface, #fff)" stroke={l.color} strokeWidth={2} />
                  : <g key={`n${props.index}`} />} />,
            ])}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
