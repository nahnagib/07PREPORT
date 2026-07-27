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
import { exportSvgAsImage } from '../chartExport';

export interface TrendPoint {
  label: string;
  actual: number;
  /** Optional prior-year ("Y-1") reference series -- omit entirely (leave every point's `lastYear`
   * undefined/null) to render the original two-line Actual/Target chart unchanged. */
  lastYear?: number | null;
  target: number | null;
}

export interface TrendChartProps {
  title: string;
  points: TrendPoint[];
  /** Legend/tooltip name for the actual series, e.g. "Revenue". Defaults to "Actual". */
  actualLabel?: string;
  /** Legend/tooltip name for the prior-year series. Defaults to "Y-1". */
  lastYearLabel?: string;
  /** Legend/tooltip name for the target series, e.g. "Target". Defaults to "Target". */
  targetLabel?: string;
  /** Formats numbers on the Y axis (e.g. compact "63.7M" style). Defaults to a plain toLocaleString. */
  valueFormatter?: (value: number) => string;
  /** Formats the exact value shown in the hover tooltip. Defaults to `valueFormatter` -- pass a
   * full-precision formatter when the axis display is rounded/compact but the tooltip should show
   * the exact figure. */
  tooltipValueFormatter?: (value: number) => string;
  height?: number;
  /** Color for the actual-value line. Defaults to the dashboard's accent token. */
  color?: string;
  /** Color for the prior-year line. Defaults to the dashboard's "last year" semantic token. */
  lastYearColor?: string;
  /** Color for the target line. Defaults to the dashboard's neutral-granite token (unchanged
   * default so existing callers keep their current look) -- pass a distinct hue when Y-1 and
   * Target need to read apart from each other, not just from Actual. */
  targetColor?: string;
  /** Set false to suppress the internal title text (still renders the Export image button) --
   * for callers that already show the title in their own surrounding chart-card chrome (e.g.
   * @07ps/ui's ChartPanel), so the title isn't rendered twice. Defaults to true. */
  showTitle?: boolean;
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
  lastYearLabel = 'Y-1',
  targetLabel = 'Target',
  valueFormatter = defaultFormatter,
  tooltipValueFormatter,
  height = 280,
  color = 'var(--ps-color-accent)',
  lastYearColor = 'var(--ps-color-last-year)',
  targetColor = 'var(--ps-neutral-granite)',
  showTitle = true,
}: TrendChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const tooltipFormatter = tooltipValueFormatter ?? valueFormatter;
  const showLastYear = points.some((p) => p.lastYear !== undefined && p.lastYear !== null);

  // Recharts' Legend onClick payload type varies across its own overloads (Payload['dataKey'] is
  // typed as `DataKey<any>`, which can technically be a function) -- narrowed here to the string
  // case we actually pass in via each Line's own `dataKey` prop below.
  const handleLegendClick = (o: unknown) => {
    const key = (o as { dataKey?: unknown })?.dataKey;
    if (typeof key !== 'string') return;
    setHidden((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleExportImage = () => {
    exportSvgAsImage(containerRef.current, title.replace(/\s+/g, '-').toLowerCase());
  };

  return (
    <div>
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
              formatter={(value: number, name: string) => [tooltipFormatter(value), name]}
              labelFormatter={(label: string) => `Month: ${label}`}
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
            {showLastYear && (
              <Line
                type="monotone"
                dataKey="lastYear"
                name={lastYearLabel}
                stroke={lastYearColor}
                strokeWidth={2}
                strokeDasharray="2 3"
                dot={{ r: 2.5 }}
                hide={!!hidden.lastYear}
                isAnimationActive={false}
                connectNulls
              />
            )}
            <Line
              type="monotone"
              dataKey="target"
              name={targetLabel}
              stroke={targetColor}
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
