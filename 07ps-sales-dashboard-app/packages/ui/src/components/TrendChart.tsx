import React, { useRef, useState } from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  Brush,
} from 'recharts';

export interface TrendPoint {
  label: string;
  actual: number;
  target: number | null;
}

export interface TrendChartProps {
  title: string;
  points: TrendPoint[];
  /** Legend/tooltip name for the actual series, e.g. "Revenue". Defaults to "Actual". */
  actualLabel?: string;
  /** Legend/tooltip name for the target series, e.g. "Target". Defaults to "Target". */
  targetLabel?: string;
  /** Formats numbers on the Y axis and in the tooltip (e.g. compact "63.7M" style). Defaults to a
   * plain toLocaleString. */
  valueFormatter?: (value: number) => string;
  height?: number;
  /** Color for the actual-value line. Defaults to the dashboard's accent token. */
  color?: string;
}

function defaultFormatter(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/**
 * Complete UI Redesign pass: a generic, reusable interactive trend chart built on Recharts, used
 * for the new Trend Section (Revenue Trend / Volume Trend / ASP Trend / Monthly Achievement) and
 * for the breakdown page's enhanced chart. Deliberately generic (label/actual/target, no knowledge
 * of "revenue" vs "ASP" vs "achievement %") -- the page composing this decides what each series
 * means and passes already-computed points, keeping this component reusable across all four trend
 * views rather than forking near-identical chart code four times.
 *
 * Satisfies the redesign brief's "interactive charts" requirement:
 *   - Tooltip on hover (via Recharts' Tooltip, using the same valueFormatter as the axis)
 *   - Legend with click-to-toggle series visibility (standard Recharts hide-on-click pattern)
 *   - Brush control under the chart for zoom/pan across a long date range
 *   - "Export image" toolbar button, which serializes the rendered <svg> to a PNG download using
 *     only native browser APIs (no extra charting-export library needed)
 */
export function TrendChart({
  title,
  points,
  actualLabel = 'Actual',
  targetLabel = 'Target',
  valueFormatter = defaultFormatter,
  height = 280,
  color = 'var(--ps-color-accent)',
}: TrendChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<Record<string, boolean>>({});

  // Recharts' Legend onClick payload type varies across its own overloads (Payload['dataKey'] is
  // typed as `DataKey<any>`, which can technically be a function) -- narrowed here to the string
  // case we actually pass in via each Line's own `dataKey` prop below.
  const handleLegendClick = (o: unknown) => {
    const key = (o as { dataKey?: unknown })?.dataKey;
    if (typeof key !== 'string') return;
    setHidden((prev) => ({ ...prev, [key]: !prev[key] }));
  };

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
        const heightPx = svg.clientHeight || 400;
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
          link.download = `${title.replace(/\s+/g, '-').toLowerCase()}.png`;
          link.click();
          setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        });
      };
      img.src = url;
    } catch {
      // Export is a convenience action, not core functionality -- fail silently rather than
      // surfacing a console-only error to the whole dashboard.
    }
  };

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 'var(--ps-space-2, 8px)',
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ps-color-text)' }}>{title}</span>
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
      <div ref={containerRef}>
        <ResponsiveContainer width="100%" height={height}>
          <ComposedChart data={points} margin={{ top: 4, right: 12, left: -8, bottom: 0 }}>
            <CartesianGrid stroke="var(--ps-color-border)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--ps-color-muted-text)' }} axisLine={{ stroke: 'var(--ps-color-border)' }} tickLine={false} />
            <YAxis
              tick={{ fontSize: 11, fill: 'var(--ps-color-muted-text)' }}
              axisLine={false}
              tickLine={false}
              tickFormatter={valueFormatter}
              width={48}
            />
            <Tooltip
              formatter={(value: number, name: string) => [valueFormatter(value), name]}
              contentStyle={{
                borderRadius: 10,
                border: '1px solid var(--ps-color-border)',
                fontSize: 12,
              }}
            />
            <Legend onClick={handleLegendClick} wrapperStyle={{ fontSize: 12, cursor: 'pointer' }} />
            <Line
              type="monotone"
              dataKey="actual"
              name={actualLabel}
              stroke={color}
              strokeWidth={2.5}
              dot={{ r: 3 }}
              activeDot={{ r: 5 }}
              hide={!!hidden.actual}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="target"
              name={targetLabel}
              stroke="var(--ps-neutral-granite)"
              strokeWidth={2}
              strokeDasharray="5 4"
              dot={false}
              hide={!!hidden.target}
              isAnimationActive={false}
            />
            <Brush dataKey="label" height={20} stroke="var(--ps-color-accent)" travellerWidth={8} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
