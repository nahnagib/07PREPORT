'use client';
import React from 'react';
import { tooltipBoxStyle } from '@07ps/ui';
import { TooltipRow, useHoverTooltip } from './ProductUi';
import { ShareLegend, fmtMoney, fmtQty } from './InventoryVisual';

export interface ShareSegment {
  key: string;
  label: string;
  color: string;
  /** Segment width = SKU count. */
  skus: number;
  units: number;
  value: number;
  /** Tooltip labels of `units` and `value` (Odoo names: Quantity On Hand / Quantity Sold, Total Value / Sales Value). */
  unitsLabel?: string;
  valueLabel?: string;
}

/**
 * One 100% stacked horizontal bar (Stock Velocity: Fast / Normal / Slow movers, Stock Aging). Each segment's width is
 * its share of the SKUs; a legend under the bar (ShareLegend: "■ Name  N SKUs · x.x%") repeats label + SKU count + share (so a thin segment stays readable and
 * clickable on a phone). Hover a segment or legend item: SKUs, % of SKUs, units, LYD. Click: onSelect(segment key).
 */
export function StackedShareBar({ segments, onSelect, testId }: { segments: ShareSegment[]; onSelect: (key: string) => void; testId?: string }) {
  const tip = useHoverTooltip(220, 140);
  const total = segments.reduce((t, s) => t + s.skus, 0);
  const pct = (s: ShareSegment) => (total > 0 ? (s.skus / total) * 100 : 0);
  const byKey = new Map(segments.map((s) => [s.key, s]));
  if (total === 0) return <p style={{ fontSize: 13, color: 'var(--ps-color-muted-text)' }}>No products in scope.</p>;
  return (
    <div data-testid={testId}>
      <div style={{ display: 'flex', width: '100%', height: 36, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--ps-color-border)' }}>
        {segments
          .filter((s) => s.skus > 0)
          .map((s) => (
            <button
              key={s.key}
              type="button"
              aria-label={`${s.label}: ${s.skus} SKUs (${pct(s).toFixed(1)}%)`}
              onClick={() => onSelect(s.key)}
              {...tip.bind(s.key)}
              style={{ width: `${pct(s)}%`, minWidth: 4, background: s.color, border: 'none', padding: 0, cursor: 'pointer', color: '#fff', fontSize: 11, fontWeight: 700, overflow: 'hidden', whiteSpace: 'nowrap' }}
            >
              {pct(s) >= 9 ? `${pct(s).toFixed(0)}%` : ''}
            </button>
          ))}
      </div>
      <ShareLegend items={segments} onSelect={onSelect} bind={tip.bind} />
      {tip.render((key) => {
        const s = byKey.get(key);
        return s ? (
          <div style={{ ...tooltipBoxStyle, padding: '8px 10px' }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>{s.label}</div>
            <TooltipRow label="SKUs" value={`${s.skus.toLocaleString('en-US')} (${pct(s).toFixed(1)}% of SKUs)`} />
            <TooltipRow label={s.unitsLabel ?? 'Quantity'} value={fmtQty(s.units)} />
            <TooltipRow label={s.valueLabel ?? 'Value'} value={fmtMoney(s.value)} />
          </div>
        ) : null;
      })}
    </div>
  );
}
