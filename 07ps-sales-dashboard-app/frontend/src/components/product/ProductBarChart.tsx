'use client';
import React, { useEffect, useRef, useState } from 'react';
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { chartTooltipProps, exportSvgAsImage, useCanExport } from '@07ps/ui';
import { ltrLabel } from './ProductUi';
import { safeOdooUrl } from '../../lib/debt/view';

export interface ProductBar {
  id: string;
  name: string;
  company: string;
  value: number;
  /** Text printed at the end of the bar. */
  valueLabel: string;
  /** The product in Odoo (ProductFact.odooUrl): the name opens it in a new tab. */
  href?: string | null;
}

const BAR_ROW = 28;
const AXIS_HEIGHT = 30;
const LEGEND_HEIGHT = 24;
const LABEL_MIN = 120;
const LABEL_MAX = 280;
const TOP_COUNT = 25;
const MAX_SCROLL_PLOT = TOP_COUNT * BAR_ROW + 8;
const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';

let measureCtx: CanvasRenderingContext2D | null | undefined;
/** Rendered width of `text` at the axis font; a per-character estimate where no canvas exists (tests). */
export function textWidth(text: string, font = `12px ${FONT_FAMILY}`): number {
  if (measureCtx === undefined) {
    try {
      if (typeof document !== 'undefined') measureCtx = document.createElement('canvas').getContext('2d');
    } catch {
      measureCtx = null;
    }
  }
  if (!measureCtx) return Array.from(text).length * 7;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

/** `text` cut at the END with an ellipsis so it fits `maxWidth` (never cut at the start). */
export function fitEnd(text: string, maxWidth: number): string {
  if (textWidth(text) <= maxWidth) return text;
  let lo = 0;
  const chars = Array.from(text);
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textWidth(`${chars.slice(0, mid).join('').trimEnd()}…`) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${chars.slice(0, lo).join('').trimEnd()}…`;
}

const tag = (company: string) => (company ? ` · ${company}` : '');

/** Label column width for these bars: the longest "name · company", between 120 and 280px. */
export function labelColumnWidth(rows: Pick<ProductBar, 'name' | 'company'>[]): number {
  const longest = rows.reduce((width, r) => Math.max(width, textWidth(`${r.name}${tag(r.company)}`)), 0);
  return Math.round(Math.min(LABEL_MAX, Math.max(LABEL_MIN, longest + 12)));
}

type CategoryTick = { x: number; y: number; payload: { value: string } };

export function NameTick({ x, y, row, width }: { x: number; y: number; row: ProductBar; width: number }) {
  const room = width - 12 - textWidth(tag(row.company));
  const url = row.href ? safeOdooUrl(row.href) : null;
  const label = (
    <text x={x} y={y} dy={4} textAnchor="end" fontSize={12} fontFamily={FONT_FAMILY} fill={url ? 'var(--ps-color-accent)' : 'var(--ps-color-text)'}
      textDecoration={url ? 'underline' : undefined} direction="ltr" data-testid="product-bar-label">
      <title>{url ? `${ltrLabel(row.name)}${tag(row.company)} — open in Odoo (new tab)` : `${ltrLabel(row.name)}${tag(row.company)}`}</title>
      {ltrLabel(fitEnd(row.name, room))}
      {row.company && <tspan fill="var(--ps-color-muted-text)" fontSize={11}>{tag(row.company)}</tspan>}
    </text>
  );
  return url ? (
    <a href={url} target="_blank" rel="noopener noreferrer" data-testid="product-bar-odoo-link" style={{ cursor: 'pointer' }}>
      {label}
    </a>
  ) : (
    label
  );
}

export function ProductBarChart({
  rows,
  seriesName,
  color,
  axisFormatter,
  tooltip,
  fileName,
}: {
  /** Already in display order (e.g. fastest first). */
  rows: ProductBar[];
  seriesName: string;
  color: string;
  axisFormatter: (v: number) => string;
  tooltip: (row: ProductBar) => React.ReactNode;
  fileName: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const plotRef = useRef<HTMLDivElement>(null);
  const canExport = useCanExport();
  const shown = showAll ? rows : rows.slice(0, TOP_COUNT);
  const [width, setWidth] = useState(0);
  const hasRows = rows.length > 0;
  const scrollerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const plot = scrollerRef.current;
    if (!plot) return;
    const observer = new ResizeObserver(() => setWidth(plot.clientWidth));
    observer.observe(plot);
    return () => observer.disconnect();
  }, [hasRows, showAll]);

  const valueRoom = shown.reduce((room, row) => Math.max(room, Math.ceil(textWidth(row.valueLabel, `600 11px ${FONT_FAMILY}`)) + 10), 0);
  const labelWidth = Math.min(labelColumnWidth(shown), Math.max(LABEL_MIN, width - valueRoom - 48));
  const byKey = new Map(shown.map((row) => [row.id, row]));
  const max = shown.reduce((value, row) => Math.max(value, row.value), 0);
  const domain: [number, number] = [0, max || 1];
  const plotHeight = shown.length * BAR_ROW + 8;
  const scrolls = showAll && plotHeight > MAX_SCROLL_PLOT;
  const margin = { top: 4, right: valueRoom, left: 0, bottom: 0 };

  if (rows.length === 0) return <p style={{ fontSize: 13, color: 'var(--ps-color-muted-text)' }}>No products.</p>;

  const renderTick = ({ x, y, payload }: CategoryTick) => {
    const row = byKey.get(payload.value);
    return row ? <NameTick x={x} y={y} row={row} width={labelWidth} /> : <g />;
  };
  const xAxis = (
    <XAxis type="number" domain={domain} height={AXIS_HEIGHT} tickCount={6} ticks={width < 420 ? domain : undefined} interval={width < 420 ? 0 : undefined} allowDataOverflow tick={{ fontSize: 11, fill: 'var(--ps-color-muted-text)' }} axisLine={{ stroke: 'var(--ps-color-border)' }} tickLine={false} tickFormatter={axisFormatter} />
  );

  return (
    <div dir="ltr" data-testid="product-bar-chart" style={{ width: '100%', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: 'var(--ps-color-muted-text)' }}>
          {shown.length === rows.length ? `${rows.length} products` : `Top ${shown.length} of ${rows.length} products`}
        </span>
        <span style={{ flex: 1 }} />
        {rows.length > TOP_COUNT && (
          <button type="button" aria-expanded={showAll} onClick={() => {
            if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
            setShowAll((v) => !v);
          }} style={linkButton} data-testid="product-bar-show-all">
            {showAll ? `Show top ${TOP_COUNT}` : `Show all (${rows.length})`}
          </button>
        )}
        {canExport && (
          <button type="button" onClick={() => void exportSvgAsImage(plotRef.current, fileName)} style={pillButton}>
            Export image
          </button>
        )}
      </div>
      {/* Plot: grows with the bars; when expanded past MAX_SCROLL_PLOT it scrolls inside the card. */}
      <div ref={scrollerRef} style={{ width: '100%', maxHeight: scrolls ? MAX_SCROLL_PLOT : undefined, overflowY: scrolls ? 'auto' : undefined }} data-testid="product-bar-plot">
        {/* Keep the plot's axis in the exported SVG. On screen, the separate axis below takes its place while scrolling. */}
        <div ref={plotRef} style={scrolls ? { height: plotHeight, overflow: 'clip' } : undefined}>
          <ResponsiveContainer width="100%" height={plotHeight + AXIS_HEIGHT}>
            <BarChart data={shown} layout="vertical" margin={margin}>
              <CartesianGrid stroke="var(--ps-color-border)" strokeDasharray="3 3" horizontal={false} />
              {xAxis}
              <YAxis type="category" dataKey="id" width={labelWidth} interval={0} axisLine={false} tickLine={false} tick={renderTick} />
              <Tooltip
                {...chartTooltipProps}
                cursor={{ fill: 'var(--ps-color-muted-bg)' }}
                content={({ active, payload }) => {
                  const row = active ? payload?.[0]?.payload as ProductBar | undefined : undefined;
                  return row ? <>{tooltip(row)}</> : null;
                }}
              />
              <Bar dataKey="value" name={seriesName} fill={color} barSize={16} radius={[0, 4, 4, 0]} isAnimationActive={false}>
                <LabelList dataKey="value" position="right" content={(p: any) => {
                  const row = shown[p.index];
                  if (!row) return null;
                  return (
                    <text x={Number(p.x) + Number(p.width) + 6} y={Number(p.y) + Number(p.height) / 2} dy={4} fontSize={11} fontFamily={FONT_FAMILY} fontWeight={600} fill="var(--ps-color-text)" direction="ltr" data-testid="product-bar-value">
                      {ltrLabel(row.valueLabel)}
                    </text>
                  );
                }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      {scrolls && (
        // Pinned value axis under the scrolling bars: same domain, same label column and margins.
        <ResponsiveContainer width={width || '100%'} height={AXIS_HEIGHT}>
          <BarChart data={shown.slice(0, 1)} layout="vertical" margin={{ ...margin, top: 0 }}>
            {xAxis}
            <YAxis type="category" width={labelWidth} axisLine={false} tickLine={false} tick={false} />
          </BarChart>
        </ResponsiveContainer>
      )}
      <div style={{ height: LEGEND_HEIGHT, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 12, color }}>
        <span style={{ width: 10, height: 10, borderRadius: 2, background: color, display: 'inline-block' }} />
        {seriesName}
      </div>
    </div>
  );
}

const linkButton: React.CSSProperties = { background: 'none', border: 'none', padding: 0, color: 'var(--ps-color-accent)', fontWeight: 600, cursor: 'pointer', fontSize: 12 };
const pillButton: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: 'var(--ps-color-muted-text)', background: 'var(--ps-color-muted-bg)',
  border: '1px solid var(--ps-color-border)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer',
};
