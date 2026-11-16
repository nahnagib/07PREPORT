import React from 'react';

/** One part of the whole: a segment of the bar and a legend entry. */
export interface ShareBarItem {
  key: string;
  /** Bold legend name (a currency, a branch); shown in its own direction (Arabic names stay right-to-left). */
  label: string;
  /** Muted text after the name, e.g. "55.2%" or "9 (19.6%)". */
  detail: string;
  /** 0–1 share of the whole: the segment's width. */
  share: number;
  color: string;
  /** Hover text of the segment. */
  title: string;
}

/**
 * A thin bar split into its parts, with a wrapping legend under it (2026-11-15: lifted out of the Receivables "Total
 * debt" currency mix so the NPS "Detractors by Branch" card uses the very same bar). Segments in the given order; a
 * segment is at least 4 px wide so a tiny share is still visible and hoverable.
 */
export function ShareBar({ items, ariaLabel, testId }: { items: ShareBarItem[]; ariaLabel: string; testId?: string }) {
  if (items.length === 0) return null;
  return (
    <div style={{ minWidth: 0 }} data-testid={testId}>
      <div role="img" aria-label={ariaLabel} style={{ display: 'flex', gap: 2, height: 10, borderRadius: 5, overflow: 'hidden' }}>
        {items.map((m) => (
          <span key={m.key} data-testid="share-bar-segment" data-share={m.share} title={m.title} style={{ flex: `${m.share} 0 4px`, background: m.color }} />
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 18px', marginTop: 8, fontSize: 12.5, color: 'var(--ps-color-muted-text)' }}>
        {items.map((m) => (
          <span key={m.key} data-testid="share-bar-legend" title={m.title} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: m.color, flexShrink: 0 }} />
            {/* <bdi>: an Arabic name keeps its own right-to-left order and never pulls the number into it */}
            <strong style={{ color: 'var(--ps-color-text)' }}><bdi>{m.label}</bdi></strong> <span dir="ltr">{m.detail}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
