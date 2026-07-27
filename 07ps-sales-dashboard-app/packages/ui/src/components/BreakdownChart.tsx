import React, { useRef, useState } from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  Brush,
} from 'recharts';
import type { SemanticStatus } from './KpiTile';
import { exportSvgAsImage } from '../chartExport';

export interface BreakdownChartRow {
  id: string;
  label: string;
  actual: number;
  targetToDate: number | null;
  status: SemanticStatus;
  /** Pre-formatted value text (e.g. "LYD 40.4M") - packages/ui has no currency/volume-aware
   * formatter, same convention as Gauge's valueLabel/targetLabel. */
  valueLabel: string;
  targetLabel?: string;
}

export interface BreakdownChartProps {
  rows: BreakdownChartRow[];
  actualSeriesName?: string;
  targetSeriesName?: string;
  valueFormatter?: (value: number) => string;
  height?: number;
  title?: string;
}

const statusColorVar: Record<SemanticStatus, string> = {
  success: 'var(--ps-color-success)',
  watch: 'var(--ps-color-watch)',
  alert: 'var(--ps-color-alert)',
  neutral: 'var(--ps-color-neutral-text)',
};

function defaultFormatter(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/**
 * Complete UI Redesign pass: the breakdown/drill-down page's "large interactive chart", replacing
 * the hand-rolled BreakdownBarChart.tsx with a Recharts-backed horizontal grouped bar chart --
 * actual (colored by the same classifyVsTarget status as everywhere else) alongside target (a
 * thinner neutral bar), per row/dimension value. Same status source-of-truth rule as every other
 * chart in this package: `status` always arrives pre-classified and only drives bar color here.
 *
 * Interactive per the redesign brief: hover tooltips, a toggleable legend (click "Actual"/"Target"
 * to hide either series), a Brush for zooming into a long list of dimension values, and an
 * "Export image" button (same native-browser SVG->PNG approach as TrendChart, no extra library).
 *
 * BreakdownBarChart.tsx is left in place, unused, per this session's convention of not deleting
 * superseded components.
 */
export function BreakdownChart({
  rows,
  actualSeriesName = 'Actual',
  targetSeriesName = 'Target',
  valueFormatter = defaultFormatter,
  height,
  title,
}: BreakdownChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<Record<string, boolean>>({});

  // See TrendChart.tsx for why this takes `unknown` rather than Recharts' own Payload type.
  const handleLegendClick = (o: unknown) => {
    const key = (o as { dataKey?: unknown })?.dataKey;
    if (typeof key !== 'string') return;
    setHidden((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleExportImage = () => {
    exportSvgAsImage(containerRef.current, (title ?? 'breakdown-chart').replace(/\s+/g, '-').toLowerCase());
  };

  const chartHeight = height ?? Math.max(260, rows.length * 46);

  if (rows.length === 0) {
    return <p style={{ fontSize: 13, color: 'var(--ps-color-muted-text)' }}>No rows to chart.</p>;
  }

  return (
    <div style={{ width: '100%' }}>
      {title && (
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
      )}
      <div ref={containerRef} style={{ width: '100%' }}>
        <ResponsiveContainer width="100%" height={chartHeight}>
          <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 24, left: 160, bottom: 0 }} barGap={6}>
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
              width={150}
              tick={{ fontSize: 12, fill: 'var(--ps-color-text)' }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              formatter={(value: number, name: string) => [valueFormatter(value), name]}
              contentStyle={{ borderRadius: 10, border: '1px solid var(--ps-color-border)', fontSize: 12 }}
            />
            <Legend onClick={handleLegendClick} wrapperStyle={{ fontSize: 12, cursor: 'pointer' }} />
            <Bar
              dataKey="actual"
              name={actualSeriesName}
              radius={[0, 4, 4, 0]}
              barSize={16}
              hide={!!hidden.actual}
              isAnimationActive={false}
            >
              {rows.map((r) => (
                <Cell key={r.id} fill={statusColorVar[r.status]} />
              ))}
            </Bar>
            <Bar
              dataKey="targetToDate"
              name={targetSeriesName}
              fill="var(--ps-neutral-granite)"
              fillOpacity={0.45}
              radius={[0, 4, 4, 0]}
              barSize={8}
              hide={!!hidden.targetToDate}
              isAnimationActive={false}
            />
            {rows.length > 8 && <Brush dataKey="label" height={18} stroke="var(--ps-color-accent)" travellerWidth={8} />}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
