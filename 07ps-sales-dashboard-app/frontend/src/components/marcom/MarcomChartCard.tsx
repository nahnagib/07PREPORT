'use client';
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { EmptyState, ErrorState, LoadingSkeleton } from '@07ps/ui';
import { t } from '../../lib/marcom/text';
import { SR_ONLY } from './MarcomKpiCard';

/** Tests (no layout engine) provide a fixed width; in the browser the box measures itself. */
export const ChartSizeContext = createContext<{ width?: number }>({});

/**
 * A measured chart area. Renders its children only once it has a width, so charts always fit their
 * card; the surrounding MarcomChartCard scrolls horizontally when `minWidth` exceeds the viewport
 * instead of squashing the chart.
 */
export function ChartBox({ height = 300, children }: { height?: number; children: (size: { width: number; height: number }) => React.ReactNode }) {
  const fixed = useContext(ChartSizeContext).width;
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fixed ?? 0);

  useEffect(() => {
    if (fixed !== undefined) return undefined;
    const el = ref.current;
    if (!el) return undefined;
    setWidth(Math.floor(el.getBoundingClientRect().width));
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => setWidth(Math.floor(entries[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [fixed]);

  return (
    <div ref={ref} style={{ width: '100%', height }}>
      {width > 0 ? children({ width, height }) : null}
    </div>
  );
}

export interface ChartTable {
  caption: string;
  columns: string[];
  /** Already formatted for display. */
  rows: (string | number | null)[][];
}

export interface MarcomChartCardProps {
  /** Stable id of the visual, e.g. "spending.roiTrend" (used by tests and for anchors). */
  visual: string;
  title: string;
  subtitle?: React.ReactNode;
  /** Short accessible description with the key numbers. */
  summary: string;
  table?: ChartTable;
  loading?: boolean;
  refreshing?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Replaces the chart with an empty-state message. */
  empty?: string | boolean;
  /** Toggles etc. shown in the header. */
  actions?: React.ReactNode;
  /** Charts that need room (many categories) scroll sideways below this width instead of squashing. */
  minWidth?: number;
  /** Elements inside the chart are focusable (e.g. Gantt bars): use role=group rather than img. */
  interactive?: boolean;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

function DataTableView({ table, hidden }: { table: ChartTable; hidden?: boolean }) {
  const th: React.CSSProperties = { textAlign: 'start', padding: '6px 10px', fontSize: 12, color: 'var(--ps-color-muted-text)', borderBottom: '1px solid var(--ps-color-border)', whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '6px 10px', fontSize: 13, borderBottom: '1px solid var(--ps-color-border)', fontVariantNumeric: 'tabular-nums' };
  return (
    <div style={hidden ? SR_ONLY : { overflow: 'auto', maxHeight: 360 }} data-testid={hidden ? 'chart-table-sr' : 'chart-table'}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <caption style={hidden ? undefined : { textAlign: 'start', fontSize: 12, color: 'var(--ps-color-muted-text)', padding: '0 0 6px' }}>{table.caption}</caption>
        <thead><tr>{table.columns.map((c) => <th key={c} scope="col" style={th}>{c}</th>)}</tr></thead>
        <tbody>
          {table.rows.map((r, i) => (
            <tr key={i}>{r.map((v, j) => (j === 0 ? <th key={j} scope="row" style={{ ...td, textAlign: 'start', fontWeight: 600 }}>{v ?? t('generic.na')}</th> : <td key={j} style={td}>{v ?? t('generic.na')}</td>))}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Wrapper for every chart: title, loading / empty / error states, a "view as table" toggle, and an
 * always-present screen-reader data table so the numbers are never only in pixels.
 */
export function MarcomChartCard(p: MarcomChartCardProps) {
  const [asTable, setAsTable] = useState(false);
  const busy = p.loading || p.refreshing;

  let body: React.ReactNode;
  if (p.loading) body = <div style={{ padding: 8 }}><LoadingSkeleton /></div>;
  else if (p.error) body = <ErrorState message={p.error} onRetry={p.onRetry} />;
  else if (p.empty) body = <EmptyState message={typeof p.empty === 'string' ? p.empty : t('state.empty')} />;
  else if (asTable && p.table) body = <DataTableView table={p.table} />;
  else {
    body = (
      <>
        <div role={p.interactive ? 'group' : 'img'} aria-label={p.summary} style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: p.minWidth }}>{p.children}</div>
        </div>
        {p.table && <DataTableView table={p.table} hidden />}
      </>
    );
  }

  return (
    <section
      data-visual={p.visual}
      aria-busy={busy || undefined}
      aria-label={p.title}
      style={{
        background: 'var(--ps-color-surface)', border: '1px solid var(--ps-color-border)', borderRadius: 12, padding: 16,
        display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, opacity: p.refreshing ? 0.65 : 1, transition: 'opacity 0.15s',
      }}
    >
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 700 }}>{p.title}</h3>
          {p.subtitle && <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', marginTop: 2 }}>{p.subtitle}</div>}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {p.actions}
          {p.table && !p.loading && !p.error && !p.empty && (
            <button type="button" onClick={() => setAsTable((v) => !v)} aria-pressed={asTable} style={GHOST_BTN}>
              {asTable ? t('chart.viewChart') : t('chart.viewTable')}
            </button>
          )}
        </div>
      </header>
      {body}
      {p.footer && <footer style={{ fontSize: 12, color: 'var(--ps-color-muted-text)' }}>{p.footer}</footer>}
    </section>
  );
}

export const GHOST_BTN: React.CSSProperties = {
  fontSize: 12, fontWeight: 600, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
  background: 'var(--ps-color-muted-bg)', color: 'var(--ps-color-text)', border: '1px solid var(--ps-color-border)',
};

/** Two-option segmented toggle (stacked/grouped, bars/bubbles, ...). */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} style={{ display: 'inline-flex', border: '1px solid var(--ps-color-border)', borderRadius: 6, overflow: 'hidden' }}>
      {options.map((o) => (
        <button
          key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}
          style={{
            fontSize: 12, fontWeight: 600, padding: '4px 10px', cursor: 'pointer', border: 0,
            background: value === o.value ? 'var(--ps-color-accent)' : 'var(--ps-color-muted-bg)',
            color: value === o.value ? 'var(--ps-color-on-accent)' : 'var(--ps-color-text)',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
