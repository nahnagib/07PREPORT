import React, { useRef } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, LabelList } from 'recharts';
import { exportSvgAsImage } from '../chartExport';

export interface StackedPercentSegment {
  key: string;
  name: string;
  color: string;
}

export interface StackedPercentBarChartPoint {
  label: string;
  [key: string]: string | number;
}

export interface StackedPercentBarChartProps {
  title?: string;
  /** Suppress the internal title text (still renders the Export image button) -- same convention
   * as every other chart in this package. Defaults to true. */
  showTitle?: boolean;
  /** Each point's segment values are expected to already sum to ~100 -- this component renders
   * whatever it's given, it does not normalize. Built for Pipeline Trend's "Open Opportunities &
   * Quotations by Aging" (2 categories, each a full column of 4 aging-bucket segments). */
  points: StackedPercentBarChartPoint[];
  segments: StackedPercentSegment[];
  height?: number;
  /** 'vertical' (default) keeps categories on the X-axis with % stacked upward, matching every
   * existing caller. 'horizontal' swaps the axes -- categories on the Y-axis, % stacked left to
   * right -- via Recharts' own `layout="vertical"` BarChart prop (Recharts names the prop after the
   * bars' direction, not the axis layout, which is the opposite of this prop's naming; kept as
   * 'horizontal'/'vertical' here since that's what callers actually see on screen). */
  orientation?: 'vertical' | 'horizontal';
}

/**
 * 100%-stacked bar chart -- nothing else in this package does a normalized stack (ComboChart/
 * GroupedBarChart are clustered, not stacked). Same Recharts/CSS-variable/export-image conventions
 * as every other chart here; each Bar shares one `stackId` so segments stack to a full bar per
 * category, in either orientation.
 */
export function StackedPercentBarChart({
  title,
  showTitle = true,
  points,
  segments,
  height = 280,
  orientation = 'vertical',
}: StackedPercentBarChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const handleExportImage = () => {
    exportSvgAsImage(containerRef.current, (title ?? 'stacked-chart').replace(/\s+/g, '-').toLowerCase());
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
      <div ref={containerRef} style={{ width: '100%' }}>
        <ResponsiveContainer width="100%" height={height}>
          <BarChart
            data={points}
            layout={orientation === 'horizontal' ? 'vertical' : 'horizontal'}
            margin={{ top: 4, right: 12, left: 0, bottom: 0 }}
          >
            <CartesianGrid
              stroke="var(--ps-color-border)"
              strokeDasharray="3 3"
              vertical={orientation === 'horizontal'}
              horizontal={orientation !== 'horizontal'}
            />
            {orientation === 'horizontal' ? (
              <>
                <XAxis
                  type="number"
                  domain={[0, 100]}
                  tick={{ fontSize: 11, fill: 'var(--ps-color-muted-text)' }}
                  axisLine={{ stroke: 'var(--ps-color-border)' }}
                  tickLine={false}
                  tickFormatter={(v: number) => `${v}%`}
                />
                <YAxis
                  type="category"
                  dataKey="label"
                  tick={{ fontSize: 12, fill: 'var(--ps-color-muted-text)' }}
                  axisLine={false}
                  tickLine={false}
                  width={90}
                />
              </>
            ) : (
              <>
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 12, fill: 'var(--ps-color-muted-text)' }}
                  axisLine={{ stroke: 'var(--ps-color-border)' }}
                  tickLine={false}
                />
                <YAxis
                  domain={[0, 100]}
                  tick={{ fontSize: 11, fill: 'var(--ps-color-muted-text)' }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: number) => `${v}%`}
                  width={40}
                />
              </>
            )}
            <Tooltip
              formatter={(value: number, name: string) => [`${value.toFixed(1)}%`, name]}
              contentStyle={{
                borderRadius: 10,
                border: '1px solid var(--ps-color-border)',
                fontSize: 12,
                background: 'var(--ps-color-surface)',
                color: 'var(--ps-color-text)',
              }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {segments.map((s) => (
              <Bar key={s.key} dataKey={s.key} name={s.name} stackId="a" fill={s.color} isAnimationActive={false} barSize={64}>
                <LabelList
                  dataKey={s.key}
                  position="center"
                  fill="var(--ps-color-on-accent)"
                  fontSize={10}
                  formatter={(v: number) => (v >= 8 ? `${v.toFixed(0)}%` : '')}
                />
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
