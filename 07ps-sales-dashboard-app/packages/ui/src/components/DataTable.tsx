import React from 'react';

export interface Column<T> {
  key: keyof T;
  header: string;
  align?: 'left' | 'right';
  /** Optional custom cell renderer (e.g. a status pill instead of a plain string) -- falls back to
   * String(row[key]) when omitted, so every existing column definition keeps working unchanged. */
  render?: (row: T) => React.ReactNode;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  /** Section 3.8: a totals row, where meaningful, is pinned to the bottom, bold + shaded. */
  totalsRow?: Partial<T>;
  getRowId: (row: T) => string;
}

/**
 * Standards Section 3.8 - Tables Layout.
 * Sticky column headers, first column frozen on wide tables, pinned+shaded totals row.
 * Multi-column sort is explicitly out of scope for Phase 1 (future capability).
 */
export function DataTable<T extends Record<string, unknown>>({
  columns,
  rows,
  totalsRow,
  getRowId,
}: DataTableProps<T>) {
  return (
    <div style={{ overflow: 'auto', maxHeight: 480 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead>
          <tr>
            {columns.map((col, i) => (
              <th
                key={String(col.key)}
                style={{
                  position: 'sticky',
                  top: 0,
                  left: i === 0 ? 0 : undefined,
                  zIndex: i === 0 ? 2 : 1,
                  background: 'var(--ps-color-surface)',
                  textAlign: col.align ?? 'left',
                  padding: '8px 12px',
                  borderBottom: '2px solid var(--ps-color-border)',
                }}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={getRowId(row)} className="ps-datatable-row">
              {columns.map((col, i) => (
                <td
                  key={String(col.key)}
                  style={{
                    position: i === 0 ? 'sticky' : undefined,
                    left: i === 0 ? 0 : undefined,
                    background: i === 0 ? 'var(--ps-color-surface)' : undefined,
                    textAlign: col.align ?? 'left',
                    padding: '8px 12px',
                    borderBottom: '1px solid var(--ps-color-border)',
                  }}
                >
                  {col.render ? col.render(row) : String(row[col.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {totalsRow && (
          <tfoot>
            <tr style={{ fontWeight: 700, background: 'var(--ps-color-muted-bg)' }}>
              {columns.map((col) => (
                <td key={String(col.key)} style={{ padding: '8px 12px', textAlign: col.align ?? 'left' }}>
                  {totalsRow[col.key] !== undefined ? String(totalsRow[col.key]) : ''}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
