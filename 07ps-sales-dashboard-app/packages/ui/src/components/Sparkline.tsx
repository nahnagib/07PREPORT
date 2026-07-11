import React, { useId } from 'react';
import type { SemanticStatus } from './KpiTile';

export interface SparklineProps {
  /** Recent values, oldest first (e.g. last 6 months of actuals). Needs at least 2 points to draw
   * a line; renders nothing for 0-1 points. */
  values: number[];
  status?: SemanticStatus;
  width?: number;
  height?: number;
  /** Accessible label, e.g. "Revenue trend, last 6 months". */
  label?: string;
}

const strokeColorVar: Record<SemanticStatus, string> = {
  success: 'var(--ps-color-success)',
  watch: 'var(--ps-color-watch)',
  alert: 'var(--ps-color-alert)',
  neutral: 'var(--ps-color-muted-text)',
};

/**
 * Complete UI Redesign (v2) pass: a tiny, axis-less inline trend line -- the "discrete trend
 * sparkline" called for alongside each KPI card's headline number, and reused as the Trend column
 * in PerformanceReportTable. Deliberately minimal (no grid, no ticks, no tooltip) since its only
 * job is a quick "up/down/flat" read at a glance; the real numbers live in the card/table next to
 * it. A soft area fill under the line uses the same status color at low opacity, echoing the soft
 * status-tint convention from tokens.css (--ps-color-success-bg etc.) rather than a heavy fill.
 */
export function Sparkline({ values, status = 'neutral', width = 64, height = 24, label }: SparklineProps) {
  const rawId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const gradientId = `spark-fill-${rawId}`;

  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const pad = 2;

  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * (width - pad * 2) + pad;
    const y = span > 0 ? height - pad - ((v - min) / span) * (height - pad * 2) : height / 2;
    return { x, y };
  });

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L ${points[points.length - 1].x.toFixed(1)} ${height} L ${points[0].x.toFixed(1)} ${height} Z`;
  const color = strokeColorVar[status];
  const last = points[points.length - 1];

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label ?? 'Trend'}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.22} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradientId})`} stroke="none" />
      <path d={linePath} fill="none" stroke={color} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last.x} cy={last.y} r={2.25} fill={color} />
    </svg>
  );
}
