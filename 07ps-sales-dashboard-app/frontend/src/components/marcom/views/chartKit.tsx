import React from 'react';
import type { Kpi, Unit } from '../../../lib/marcom/types';

/** Shared bits for the recharts-based visuals (axis text, grid colour, tooltip card, layout grid). */
export const AXIS_TICK = { fill: 'var(--ps-color-muted-text)', fontSize: 11 } as const;
export const GRID_STROKE = 'var(--ps-color-border)';
export const CHART_MARGIN = { top: 12, right: 16, bottom: 8, left: 8 } as const;

export function TooltipCard({ title, lines }: { title?: React.ReactNode; lines: { label: string; value: string; color?: string }[] }) {
  return (
    <div style={{ background: 'var(--ps-color-surface)', color: 'var(--ps-color-text)', border: '1px solid var(--ps-color-border)', borderRadius: 8, boxShadow: 'var(--ps-card-shadow)', padding: '8px 10px', fontSize: 12, maxWidth: 320 }}>
      {title && <div style={{ fontWeight: 700, marginBottom: 4, overflowWrap: 'anywhere' }}>{title}</div>}
      {lines.map((l, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {l.color && <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: 2, background: l.color, display: 'inline-block', flex: 'none' }} />}
          <span style={{ color: 'var(--ps-color-muted-text)' }}>{l.label}:</span>
          <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{l.value}</span>
        </div>
      ))}
    </div>
  );
}

/** A responsive grid whose cards stack on narrow screens (and never overflow below 100% width). */
export function Grid({ min = 420, children, gap = 16 }: { min?: number; children: React.ReactNode; gap?: number }) {
  return <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${min}px), 1fr))`, gap }}>{children}</div>;
}

/** Wraps an API total (no status of its own) so it can sit in a KPI card without a status chip. */
export const plainKpi = (unit: Unit, value: number | null): Kpi => ({ value, status: 'neutral', unit });

/** Truncates long names for axis ticks (the full text stays available in tooltips and tables). */
export const truncate = (s: string, n = 16): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 style={{ margin: '4px 0 -4px', fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--ps-color-muted-text)' }}>{children}</h2>;
}

export function Note({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'info' }) {
  return (
    <div role="note" style={{ fontSize: 12.5, padding: tone === 'info' ? '8px 10px' : 0, borderRadius: 6, background: tone === 'info' ? 'var(--ps-color-muted-bg)' : undefined, color: 'var(--ps-color-muted-text)', border: tone === 'info' ? '1px dashed var(--ps-color-border)' : undefined }}>
      {children}
    </div>
  );
}

/** Legend entries in the theme's text colour (the swatch carries the series colour) -- series colours as text fail contrast on dark. */
export const legendText = (value: string): React.ReactNode => <span style={{ color: 'var(--ps-color-text)' }}>{value}</span>;

/** In-ring donut label: the API's share, only where the slice is big enough to hold it. */
export function ringLabel(p: { cx: number; cy: number; midAngle: number; innerRadius: number; outerRadius: number; payload: { share: number | null } }, format: (v: number | null) => string): React.ReactNode {
  const share = p.payload.share;
  if (share === null || share < 6) return null;
  const r = (p.innerRadius + p.outerRadius) / 2;
  const rad = (-p.midAngle * Math.PI) / 180;
  return (
    <text x={p.cx + r * Math.cos(rad)} y={p.cy + r * Math.sin(rad)} textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={700} fill="#fff" stroke="#000" strokeWidth={2.5} paintOrder="stroke">
      {format(share)}
    </text>
  );
}
