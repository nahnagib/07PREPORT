import React from 'react';
import { formatNumber } from '../../lib/format';
import { pct } from '../../lib/nps/view';

export interface BarItem {
  key: string;
  label: string;
  /** shown after the label only (e.g. " · Fixable"); not part of the bar's accessible name */
  suffix?: string;
  /** shown on hover of the label (e.g. the Arabic reason) */
  title?: string;
  count: number;
  color: string;
  /** a line under the bar (e.g. how to fix an error) */
  hint?: string;
}

/**
 * The NPS page's horizontal bar list (Errors by reason, Detractors by reason / status): label, count with its share of
 * the list, a bar scaled to the largest item, an optional hint. Colours are theme tokens.
 */
export function BarList({ items, ariaLabel, testId }: { items: BarItem[]; ariaLabel: string; testId?: string }) {
  const total = items.reduce((sum, e) => sum + e.count, 0);
  const max = Math.max(0, ...items.map((e) => e.count));
  const share = (n: number) => (total > 0 ? pct((100 * n) / total) : '—');
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-label={ariaLabel} data-testid={testId}>
      {items.map((e) => (
        <li key={e.key} style={{ marginBottom: 16 }} data-testid={testId ? `${testId}-${e.key}` : undefined}>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <span title={e.title} dir="auto">{e.label}{e.suffix ?? ''}</span>
            <span><strong>{formatNumber(e.count)}</strong> <span style={{ color: 'var(--ps-color-neutral-text)' }}>({share(e.count)})</span></span>
          </div>
          <div role="img" aria-label={`${e.label}: ${e.count} (${share(e.count)})`} style={{ marginTop: 6, height: 8, background: 'var(--ps-color-border)', borderRadius: 4 }}>
            <div style={{ width: `${max ? (e.count / max) * 100 : 0}%`, height: '100%', background: e.color, borderRadius: 4 }} />
          </div>
          {e.hint && <p style={{ fontSize: 12, margin: '6px 0', color: 'var(--ps-color-neutral-text)' }}>{e.hint}</p>}
        </li>
      ))}
    </ul>
  );
}
