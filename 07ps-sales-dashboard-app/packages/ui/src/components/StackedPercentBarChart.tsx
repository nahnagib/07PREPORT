import React, { useRef } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, LabelList } from 'recharts';

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
}

/**
 * 100%-stacked vertical bar chart -- nothing else in this package does a normalized stack
 * (ComboChart/GroupedBarChart are clustered, not stacked). Same Recharts/CSS-variable/export-image
 * conventions as every other chart here; each Bar shares one `stackId` so segments stack to a full
 * column per category.
 */
export function StackedPercentBarChart({
  title,
  showTitle = true,
  points,
  segments,
  height = 280,
}: StackedPercentBarChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);

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
        const width = svg.clientWidth || 500;
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
          link.download = `${(title ?? 'stacked-chart').replace(/\s+/g, '-').toLowerCase()}.png`;
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
      <div ref={containerRef} style={{ width: '100%' }}>
        <ResponsiveContainer width="100%" height={height}>
          <BarChart data={points} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--ps-color-border)" strokeDasharray="3 3" vertical={false} />
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
