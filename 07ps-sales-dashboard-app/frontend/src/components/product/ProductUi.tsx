'use client';
/**
 * Shared building blocks of the Product pages (BCG Matrix, Stock Velocity, PIM Contribution + Brand page, Product
 * Lifecycle), 2026-11-04:
 *   - ltrLabel / ProductName: isolate product names within left-aligned labels and exports.
 *   - CompanyBadge: the product's company next to the class badges in every product tooltip.
 *   - ExportButtons + exportProductCsv / exportProductPdf: CSV (shared exportRowsAsCsv: UTF-8 with BOM, raw numbers)
 *     and PDF (shared exportRowsAsPdf) of exactly the rows and columns a table shows, in its sort order.
 *   - SortableProductTable: sortable on every column, search box, sticky header, CSV + PDF export.
 *   - useHoverTooltip: a viewport-anchored hover tooltip (never clipped by a scrolling table).
 */
import React, { useMemo, useState } from 'react';
import { OdooLink } from '../OdooLink';
import {
  TextInput,
  exportRowsAsCsv,
  exportRowsAsPdf,
  tooltipBoxStyle,
  useCanExport,
  type TableExportCell,
} from '@07ps/ui';

/** A left-to-right, left-aligned line (cell wrappers, tooltip titles, legends). */
export const LTR: React.CSSProperties = { direction: 'ltr', textAlign: 'left' };

/** Preserve the stored text and its reading direction inside an LTR chart or table. */
export function ltrLabel(name: string | null | undefined): string {
  const text = name ?? '';
  // Some stored names begin with Arabic, which reads with the Latin suffix on the left.
  const firstLetter = text.match(/\p{Letter}/u)?.[0] ?? '';
  const isolate = /\p{Script=Arabic}/u.test(firstLetter) ? '\u2068' : '\u2066';
  return `${isolate}${text}\u2069`;
}

/** A product name; with `href` (ProductFact.odooUrl) it opens the product in Odoo in a new tab (OdooLink, same as the
 * Promotion / Debt pages). */
export function ProductName({ name, truncate = true, style, href }: { name: string; truncate?: boolean; style?: React.CSSProperties; href?: string | null }) {
  return (
    <span
      dir="ltr"
      title={name}
      data-testid="product-name"
      style={{
        display: 'block',
        textAlign: 'left',
        minWidth: 0,
        ...(truncate ? { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } : {}),
        ...style,
      }}
    >
      {href ? <OdooLink href={href}>{ltrLabel(name)}</OdooLink> : ltrLabel(name)}
    </span>
  );
}

/** Colored pill (BCG class, movement, company). */
export function Pill({ color, label }: { color: string; label: string }) {
  return (
    <span
      style={{
        fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', whiteSpace: 'nowrap',
        color, background: `color-mix(in srgb, ${color} 16%, transparent)`,
        padding: '3px 8px', borderRadius: 999,
      }}
    >
      {label}
    </span>
  );
}

const COMPANY_COLOR: Record<string, string> = {
  Majaal: 'var(--ps-color-accent)',
  Tika: 'var(--ps-color-gold)',
};

/** The product's company (Majaal / Tika) as a badge. */
export function CompanyBadge({ company }: { company: string }) {
  return <Pill color={COMPANY_COLOR[company] ?? 'var(--ps-color-neutral-text)'} label={company || '—'} />;
}

/** Label / value row of a product tooltip. */
export function TooltipRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, lineHeight: 1.7 }}>
      <span style={{ color: 'var(--ps-color-muted-text)' }}>{label}</span>
      <span style={{ fontWeight: 600, color: valueColor ?? 'var(--ps-color-text)', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

/** Product tooltip shell: LTR name title, then the badges (company first), then the rows. */
export function ProductTooltip({ name, company, badges, children }: { name: string; company: string; badges?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ ...tooltipBoxStyle, ...LTR, padding: '10px 12px', minWidth: 190 }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>
        <ProductName name={name} truncate={false} />
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }} data-testid="product-tooltip-badges">
        <CompanyBadge company={company} />
        {badges}
      </div>
      {children}
    </div>
  );
}

// ------------------------------------------------------------------ export
export interface ExportColumn<T> {
  header: string;
  align?: 'left' | 'right';
  /** The CSV cell: raw value (numbers stay numbers). */
  value: (row: T) => TableExportCell;
  /** The PDF cell text (formatted); defaults to the raw value. */
  text?: (row: T) => string;
}

export function exportProductCsv<T>(fileName: string, columns: ExportColumn<T>[], rows: T[]): Promise<void> {
  return exportRowsAsCsv({ headers: columns.map((c) => c.header), rows: rows.map((r) => columns.map((c) => c.value(r))), fileName });
}

export function exportProductPdf<T>(opts: { title: string; subtitle?: string; fileName: string; columns: ExportColumn<T>[]; rows: T[] }): Promise<void> {
  const { title, subtitle, fileName, columns, rows } = opts;
  return exportRowsAsPdf({
    title,
    subtitle,
    fileName,
    columns: columns.map((c) => ({ header: c.header, align: c.align })),
    rows: rows.map((r) => columns.map((c) => (c.text ? c.text(r) : String(c.value(r) ?? '—')))),
  });
}

const exportButtonStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600,
  color: 'var(--ps-color-muted-text)', background: 'var(--ps-color-muted-bg)',
  border: '1px solid var(--ps-color-border)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', whiteSpace: 'nowrap',
};

/** "Export CSV" + "Export as PDF" (hidden without the Export permission; the backend refuses the export anyway). */
export function ExportButtons({ onCsv, onPdf, label }: { onCsv?: () => void; onPdf?: () => void; label?: string }) {
  const canExport = useCanExport();
  if (!canExport) return null;
  const run = (fn?: () => void | Promise<void>) => () => {
    try {
      void Promise.resolve(fn?.()).catch((err) => console.error('Export failed:', err));
    } catch (err) {
      console.error('Export failed:', err);
    }
  };
  return (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
      {onCsv && (
        <button type="button" onClick={run(onCsv)} style={exportButtonStyle} aria-label={label ? `Export ${label} as CSV` : 'Export CSV'}>
          Export CSV
        </button>
      )}
      {onPdf && (
        <button type="button" onClick={run(onPdf)} style={exportButtonStyle} aria-label={label ? `Export ${label} as PDF` : 'Export as PDF'}>
          Export as PDF
        </button>
      )}
    </span>
  );
}

// ------------------------------------------------------------------ hover tooltip
interface HoverPos {
  key: string;
  left: number;
  top?: number;
  bottom?: number;
}

/** Viewport-anchored hover tooltip (position: fixed), flipped above the row when there is no room below. */
export function useHoverTooltip(width = 220, estimatedHeight = 220) {
  const [pos, setPos] = useState<HoverPos | null>(null);
  const bind = (key: string) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const fitsBelow = rect.bottom + estimatedHeight <= window.innerHeight;
      setPos({ key, left, ...(fitsBelow ? { top: rect.bottom + 6 } : { bottom: window.innerHeight - rect.top + 6 }) });
    },
    onMouseLeave: () => setPos(null),
  });
  const render = (content: (key: string) => React.ReactNode) =>
    pos ? (
      <div style={{ position: 'fixed', left: pos.left, top: pos.top, bottom: pos.bottom, width, zIndex: 1000, pointerEvents: 'none' }}>
        {content(pos.key)}
      </div>
    ) : null;
  return { bind, render, hoveredKey: pos?.key ?? null };
}

// ------------------------------------------------------------------ sortable table
export interface SortableColumn<T> extends ExportColumn<T> {
  key: string;
  /** Sort key; null sorts last in both directions. */
  sortValue: (row: T) => number | string | null;
  render: (row: T) => React.ReactNode;
  width?: number | string;
}

/**
 * Product table: click any header to sort (again to reverse), search box over `searchText`, sticky header, CSV + PDF
 * of the rows as shown (search applied, in the shown order). Scrolls inside its own box, never the page.
 */
export function SortableProductTable<T>({
  columns,
  rows,
  getRowId,
  searchText,
  defaultSort,
  fileName,
  pdfTitle,
  pdfSubtitle,
  maxHeight = 560,
  rowTooltip,
  searchPlaceholder = 'Search product…',
  testId,
}: {
  columns: SortableColumn<T>[];
  rows: T[];
  getRowId: (row: T) => string;
  searchText: (row: T) => string;
  defaultSort: { key: string; dir: 'asc' | 'desc' };
  fileName: string;
  pdfTitle: string;
  pdfSubtitle?: string;
  maxHeight?: number;
  /** Hover detail for a row (shown next to the first cell). */
  rowTooltip?: (row: T) => React.ReactNode;
  searchPlaceholder?: string;
  testId?: string;
}) {
  const [sort, setSort] = useState(defaultSort);
  const [query, setQuery] = useState('');
  const tip = useHoverTooltip();

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const searched = q ? rows.filter((r) => searchText(r).toLowerCase().includes(q)) : rows;
    const col = columns.find((c) => c.key === sort.key) ?? columns[0];
    const sign = sort.dir === 'asc' ? 1 : -1;
    return [...searched].sort((a, b) => {
      const x = col.sortValue(a);
      const y = col.sortValue(b);
      if (x === null || x === undefined) return y === null || y === undefined ? 0 : 1;
      if (y === null || y === undefined) return -1;
      if (typeof x === 'number' && typeof y === 'number') return sign * (x - y);
      return sign * String(x).localeCompare(String(y));
    });
  }, [rows, query, sort, columns, searchText]);

  const byId = useMemo(() => new Map(shown.map((r) => [getRowId(r), r])), [shown, getRowId]);
  const toggle = (key: string) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));

  return (
    <div data-testid={testId}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <div style={{ width: 240, maxWidth: '100%' }}>
          <TextInput placeholder={searchPlaceholder} value={query} onChange={(e) => setQuery(e.target.value)} style={{ marginBottom: 0 }} aria-label="Search products" />
        </div>
        <span style={{ fontSize: 11, color: 'var(--ps-color-muted-text)' }}>
          {shown.length === rows.length ? `${shown.length} products` : `${shown.length} of ${rows.length} products`}
        </span>
        <span style={{ flex: 1 }} />
        <ExportButtons
          label={pdfTitle}
          onCsv={() => exportProductCsv(fileName, columns, shown)}
          onPdf={() => exportProductPdf({ title: pdfTitle, subtitle: pdfSubtitle, fileName, columns, rows: shown })}
        />
      </div>
      <div style={{ overflow: 'auto', maxHeight, border: '1px solid var(--ps-color-border)', borderRadius: 8 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, ...LTR }}>
          <thead>
            <tr>
              {columns.map((c) => {
                const active = sort.key === c.key;
                return (
                  <th
                    key={c.key}
                    aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    style={{
                      position: 'sticky', top: 0, zIndex: 1, background: 'var(--ps-color-surface)', textAlign: c.align ?? 'left',
                      padding: '8px 10px', borderBottom: '2px solid var(--ps-color-border)', whiteSpace: 'nowrap', width: c.width,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => toggle(c.key)}
                      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', fontWeight: 700, color: active ? 'var(--ps-color-accent)' : 'var(--ps-color-text)' }}
                    >
                      {c.header}
                      <span aria-hidden style={{ marginLeft: 4, opacity: active ? 1 : 0.3 }}>{active && sort.dir === 'asc' ? '▲' : '▼'}</span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const id = getRowId(r);
              return (
                <tr key={id} className="ps-datatable-row">
                  {columns.map((c, i) => (
                    <td
                      key={c.key}
                      dir="ltr"
                      {...(i === 0 && rowTooltip ? tip.bind(id) : {})}
                      style={{ textAlign: c.align ?? 'left', padding: '7px 10px', borderBottom: '1px solid var(--ps-color-border)', maxWidth: i === 0 ? 360 : undefined, fontVariantNumeric: c.align === 'right' ? 'tabular-nums' : undefined }}
                    >
                      {c.render(r)}
                    </td>
                  ))}
                </tr>
              );
            })}
            {shown.length === 0 && (
              <tr>
                <td colSpan={columns.length} style={{ padding: 16, textAlign: 'center', color: 'var(--ps-color-muted-text)' }}>No products match.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {rowTooltip && tip.render((key) => {
        const row = byId.get(key);
        return row ? rowTooltip(row) : null;
      })}
    </div>
  );
}
