import React, { useRef } from 'react';
import { ResponsiveContainer, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';

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
}: GroupedBarChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const handleChartClick = (state: any) => {
    if (!onCategoryClick) return;
    const label = state?.activeLabel;
    if (typeof label === 'string') onCategoryClick(label);
  };

  const tooltipFormatterFor = (dataKey: string) => tooltipFormatters?.[dataKey] ?? valueFormatter;

  const handleExportImage = () => {
    const container = containerRef.current;
    if (!container) return;
    const svg = container.querySelector('svg');
    if (!svg) return;
    try {
      const clone = svg.cloneNode(true) as SVGSVGElement;
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      const bg = window.getComputedStyle(document.body).getPropertyValue('background-color') || '#ffffff';
      const serialized = new XMLSerializer().serializeToString(clone);
      const svgBlob = new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(svgBlob);
      const img = new Image();
      img.onload = () => {
        const width = svg.clientWidth || 800;
        const heightPx = svg.clientHeight || 280;
        const canvas = document.createElement('canvas');
        canvas.width = width * 2;
        canvas.height = heightPx * 2;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.scale(2, 2);
        ctx.fillStyle = bg || '#ffffff';
        ctx.fillRect(0, 0, width, heightPx);
        ctx.drawImage(img, 0, 0, width, heightPx);
        URL.revokeObjectURL(url);
        canvas.toBlob((blob) => {
          if (!blob) return;
          const link = document.createElement('a');
          link.href = URL.createObjectURL(blob);
          link.download = `${(title ?? 'chart').replace(/\s+/g, '-').toLowerCase()}.png`;
          link.click();
          setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        });
      };
      img.src = url;
    } catch {
      // Export is a convenience action -- fail silently rather than surfacing a console-only error.
    }
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
              tick={{ fontSize: 12, fill: 'var(--ps-color-muted-text)' }}
              axisLine={false}
              tickLine={false}
              width={64}
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
                      fill={b.color}
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
