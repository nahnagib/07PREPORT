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
} from 'recharts';
import { exportSvgAsImage } from '../chartExport';

export interface ComboBarSeries {
  key: string;
  name: string;
  color: string;
}

export interface ComboLineSeries {
  key: string;
  name: string;
  color: string;
  /** Which Y axis this line reads against. Defaults to 'right' -- bars are always the primary
   * (left) series, lines are the usual secondary-axis complement. */
  yAxisId?: 'left' | 'right';
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
  /** Per-series full-precision tooltip formatter, keyed by series `key`. Falls back to the axis
   * formatter for that series' axis, then to a plain toLocaleString. */
  tooltipFormatters?: Record<string, (value: number) => string>;
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
}

function defaultFormatter(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
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
}: ComboChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const hasRightAxis = lines.some((l) => (l.yAxisId ?? 'right') === 'right');

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
      </div>
      <div ref={containerRef} style={{ width: '100%', cursor: onCategoryClick ? 'pointer' : 'default' }}>
        <ResponsiveContainer width="100%" height={height}>
          <ComposedChart
            data={points}
            margin={{ top: 4, right: hasRightAxis ? 8 : 24, left: 0, bottom: 0 }}
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
            <Tooltip
              formatter={(value: number, name: string, item: any) => {
                const dataKey = item?.dataKey as string;
                const isRightAxis = item?.payload && lines.some((l) => l.key === dataKey && (l.yAxisId ?? 'right') === 'right');
                return [tooltipFormatterFor(dataKey, !!isRightAxis)(value), name];
              }}
              contentStyle={{
                borderRadius: 10,
                border: '1px solid var(--ps-color-border)',
                fontSize: 12,
                background: 'var(--ps-color-surface)',
                color: 'var(--ps-color-text)',
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
                radius={[4, 4, 0, 0]}
                barSize={points.length > 8 ? 18 : 32}
                hide={!!hidden[b.key]}
                isAnimationActive={false}
              >
                {points.map((p) => {
                  const isSelected = highlightedCategory === p.label;
                  const dimmed = highlightedCategory != null && !isSelected;
                  return (
                    <Cell
                      key={p.label}
                      fill={b.color}
                      fillOpacity={dimmed ? 0.35 : 1}
                      stroke={isSelected ? 'var(--ps-color-gold)' : 'none'}
                      strokeWidth={isSelected ? 2 : 0}
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
                strokeWidth={2}
                dot={{ r: 3 }}
                hide={!!hidden[l.key]}
                isAnimationActive={false}
                connectNulls
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
