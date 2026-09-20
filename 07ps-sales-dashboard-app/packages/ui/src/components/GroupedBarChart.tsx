import React, { useRef } from 'react';
import { ResponsiveContainer, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { exportSvgAsImage } from '../chartExport';

export interface GroupedBarSeries {
  key: string;
  name: string;
  color: string;
}

export interface GroupedBarChartPoint {
  label: string;
  [key: string]: string | number | null | undefined;
}

export interface GroupedBarChartProps {
  title?: string;
  /** Suppress the internal title text (still renders the Export image button) -- same convention
   * as ComboChart/DonutChart's showTitle, for callers whose surrounding chrome (e.g. ChartPanel)
   * already shows the title. Defaults to true. */
  showTitle?: boolean;
  points: GroupedBarChartPoint[];
  bars: GroupedBarSeries[];
  valueFormatter?: (value: number) => string;
  /** Per-series full-precision tooltip formatter, keyed by series `key`. Falls back to
   * valueFormatter. */
  tooltipFormatters?: Record<string, (value: number) => string>;
  height?: number;
  /** The whole plot area becomes clickable (pointer cursor) and invokes this with the clicked
   * category's `label` -- same convention as ComboChart's onCategoryClick. Used for both the
   * Customers Category Performance drill-down (category -> its individual customers) and, when
   * drill-down is off, the click-to-filter page-filter interaction. */
  onCategoryClick?: (label: string) => void;
  /** Renders every bar in the matching category row with a highlighted outline and full opacity,
   * while every other row dims -- the "this is the active page filter" affordance, same convention
   * as ComboChart's highlightedCategory/DonutChart's selectedId. */
  highlightedCategory?: string | null;
  /** Custom tooltip body for a hovered bar -- replaces the default series-value list entirely.
   * Receives the full point object (including any extra fields the caller stuffed onto it beyond
   * `label`/the series keys, e.g. a product's Value YTD/Volume YTD/Class for a drilled-in product
   * bar) plus which series key was actually hovered, since a point can carry more than one bar. */
  tooltipContent?: (point: GroupedBarChartPoint, seriesKey: string) => React.ReactNode;
  /** Per-point color override for a single-series chart where each bar still needs its own color
   * (e.g. one bar per BCG class) -- an alternative to the "one null-interleaved series per color"
   * technique (still supported, still what multi-series charts on this page use) when there's
   * really only one series and coloring it is the only thing that varies per row. Falls back to
   * the series' own `color` wherever this returns undefined. */
  colorForPoint?: (point: GroupedBarChartPoint) => string | undefined;
  /** Width (px) reserved for the category axis's tick labels, and opt-in to ellipsis-truncating
   * labels that don't fit it (see CategoryTick below). Left unset, the axis keeps its historical
   * behavior -- a fixed 64px width with Recharts' own untruncated text, fine for the short labels
   * (BCG classes, "Fast Movers") every existing caller uses. Callers with real product names that
   * actually need truncating (e.g. Stock Velocity's drilled-in product bars) should pass something
   * wider alongside a taller `height`; the untruncated name remains available via the hover
   * tooltip either way. */
  yAxisWidth?: number;
}

/** Renders a category-axis tick with the label truncated (character-count approximation, not a
 * real text-measurement pass -- good enough for this axis's fixed font, and avoids a canvas
 * round-trip on every render) to fit `width`, appending an ellipsis when it's cut. Long,
 * unbounded product names were overflowing past their row and overlapping the next tick before
 * this existed -- the hover tooltip (see tooltipContent) is what shows the untruncated name. */
function CategoryTick({ x, y, payload, width }: { x: number; y: number; payload: { value: string }; width: number }) {
  const text = String(payload.value);
  const maxChars = Math.max(4, Math.floor(width / 6.2));
  const display = text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
  return (
    <text x={x} y={y} dy={4} textAnchor="end" fontSize={12} fill="var(--ps-color-muted-text)">
      {display}
    </text>
  );
}

function defaultFormatter(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/**
 * Horizontal clustered/grouped bar chart -- same building blocks/conventions as ComboChart.tsx
 * (Recharts, CSS-variable theming, native-browser SVG->PNG "Export image" button, full-precision
 * tooltip separate from the axis display formatter, click-to-drill category callback), just laid
 * out with the category axis on Y and bars growing horizontally instead of vertically. Built for
 * the Customer Growth page's "Customers Category Performance" chart (Sales LYTM vs Sales YTM by
 * Customer Category) -- nothing else in this package does horizontal grouped bars yet
 * (BreakdownBarChart is single-series with a target tick, ComboChart is vertical bars + lines).
 */
export function GroupedBarChart({
  title,
  showTitle = true,
  points,
  bars,
  valueFormatter = defaultFormatter,
  tooltipFormatters,
  height = 280,
  onCategoryClick,
  highlightedCategory = null,
  tooltipContent,
  colorForPoint,
  yAxisWidth,
}: GroupedBarChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const handleChartClick = (state: any) => {
    if (!onCategoryClick) return;
    const label = state?.activeLabel;
    if (typeof label === 'string') onCategoryClick(label);
  };

  const tooltipFormatterFor = (dataKey: string) => tooltipFormatters?.[dataKey] ?? valueFormatter;

  const handleExportImage = () => {
    exportSvgAsImage(containerRef.current, (title ?? 'chart').replace(/\s+/g, '-').toLowerCase());
  };

  if (points.length === 0) {
    return <p style={{ fontSize: 13, color: 'var(--ps-color-muted-text)' }}>No data to chart.</p>;
  }

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
          <BarChart
            data={points}
            layout="vertical"
            margin={{ top: 4, right: 24, left: 0, bottom: 0 }}
            onClick={handleChartClick}
          >
            <CartesianGrid stroke="var(--ps-color-border)" strokeDasharray="3 3" horizontal={false} />
            <XAxis
              type="number"
              tick={{ fontSize: 11, fill: 'var(--ps-color-muted-text)' }}
              axisLine={{ stroke: 'var(--ps-color-border)' }}
              tickLine={false}
              tickFormatter={valueFormatter}
            />
            <YAxis
              type="category"
              dataKey="label"
              tick={
                yAxisWidth
                  ? (props: any) => <CategoryTick {...props} width={yAxisWidth} />
                  : { fontSize: 12, fill: 'var(--ps-color-muted-text)' }
              }
              axisLine={false}
              tickLine={false}
              width={yAxisWidth ?? 64}
              interval={0}
            />
            <Tooltip
              formatter={(value: number, name: string, item: any) => {
                const dataKey = item?.dataKey as string;
                return [tooltipFormatterFor(dataKey)(value), name];
              }}
              contentStyle={{
                borderRadius: 10,
                border: '1px solid var(--ps-color-border)',
                fontSize: 12,
                background: 'var(--ps-color-surface)',
                color: 'var(--ps-color-text)',
              }}
              content={
                tooltipContent
                  ? ({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const item = payload[0] as any;
                      const point = item?.payload as GroupedBarChartPoint;
                      const seriesKey = item?.dataKey as string;
                      if (!point) return null;
                      return <>{tooltipContent(point, seriesKey)}</>;
                    }
                  : undefined
              }
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {bars.map((b) => (
              <Bar
                key={b.key}
                dataKey={b.key}
                name={b.name}
                fill={b.color}
                radius={[0, 4, 4, 0]}
                barSize={points.length > 6 ? 12 : 18}
                isAnimationActive={false}
              >
                {points.map((p) => {
                  const isSelected = highlightedCategory === p.label;
                  const dimmed = highlightedCategory != null && !isSelected;
                  return (
                    <Cell
                      key={p.label}
                      fill={colorForPoint?.(p) ?? b.color}
                      fillOpacity={dimmed ? 0.35 : 1}
                      stroke={isSelected ? 'var(--ps-color-gold)' : 'none'}
                      strokeWidth={isSelected ? 2 : 0}
                    />
                  );
                })}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
