'use client';
import React, { useMemo, useState, useRef, isValidElement } from 'react';
import {
  type ColumnDef,
  type ColumnFiltersState,
  type ColumnOrderState,
  type ColumnPinningState,
  type ColumnSizingState,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import * as XLSX from 'xlsx';
import { ArrowUp, ArrowDown, ArrowUpDown, Pin, PinOff, Search, FileJson, Download } from 'lucide-react';
import { SEMANTIC_STATUS_LABEL, SEMANTIC_STATUS_PDF_COLOR } from './SemanticBadge';
import type { SemanticStatus } from './KpiTile';
import { chunkRows, PDF_MAX_ROWS } from '../pdfPagination';
import { assemblePaginatedPdf } from '../pdfPageAssembly';
import { appendPdfMetaBlock } from '../pdfExportContext';

export interface DataGridColumn<T> {
  key: keyof T;
  header: string;
  align?: 'left' | 'right';
  /** Custom cell renderer - falls back to String(row[key]). */
  render?: (row: T) => React.ReactNode;
  /** Raw value used for export/sort/filter when it differs from the rendered cell (e.g. cell shows
   * a compact "40.4M" but export/sort should use the exact underlying number). Falls back to
   * row[key]. */
  rawValue?: (row: T) => string | number;
  /** Marks this column as a semantic-status column (e.g. `render` shows a <SemanticBadge>) so the
   * PDF export -- which rasterizes a plain, detached DOM tree rather than mounting the real React
   * component -- can reproduce the exact same colored-dot-plus-label look instead of falling back
   * to whatever raw/rendered text it can scrape out (previously the raw status code, e.g. "red",
   * with no color at all). Takes priority over `render`/`rawValue` for that one cell in the PDF. */
  badge?: (row: T) => SemanticStatus | null | undefined;
  /** Initial column width in px - user can resize afterward. */
  width?: number;
}

export interface DataGridProps<T extends Record<string, unknown>> {
  columns: DataGridColumn<T>[];
  rows: T[];
  getRowId: (row: T) => string;
  /** Base file name (no extension) for CSV/Excel export - e.g. "ytd-value-breakdown". */
  fileName?: string;
  pageSize?: number;
  /** Max height of the scrollable table body, in px, before the header sticks (Complete UI
   * Redesign pass). Set to undefined to disable the internal scroll container entirely (header
   * then just scrolls away with the page, same as before this pass). Defaults to 520. */
  maxBodyHeight?: number | null;
  /** Optional filter summary to include at top of PDF export - e.g. "Company: Majaal | Date Range: 2026-01-01 to 2026-12-31" */
  filtersSummary?: string;
  /** Page-local filters (e.g. a page-only Customer slicer) listed in the PDF after the app-wide
   * filters supplied by the shared export context. */
  extraFilterParts?: string[];
}

/**
 * Interactive analytical data grid (UI-improvements pass: "the table should feel similar to Power
 * BI, Excel, or AG Grid"). Built on @tanstack/react-table (headless table logic) - this file
 * supplies all the UI chrome: global search, per-column filter inputs, click-to-sort headers,
 * drag-to-reorder column headers (native HTML5 drag-and-drop), drag-to-resize column edges,
 * per-column pin/freeze (left), pagination, and Export to CSV / Export to Excel (via the `xlsx`
 * library) / Copy to clipboard (tab-separated, pastes cleanly into Excel/Sheets).
 *
 * Exports and copy always operate on the current filtered+sorted result set (not just the visible
 * page), since "export what I'm looking at" is the expected behavior for an analytical table.
 *
 * Replaces the plain DataTable.tsx for the Tachometer breakdown table; DataTable itself is left
 * untouched/unused rather than deleted, in case a simpler table is wanted again elsewhere.
 *
 * Complete UI Redesign pass additions: a sticky header (stays visible while scrolling a tall
 * result set within the internal `maxBodyHeight`-bounded scroll container -- works together with
 * the existing column-pin sticky-left behavior, since a cell can be sticky on both axes at once)
 * and multi-column sort (shift-click a second/third header, TanStack's native `enableMultiSort`
 * behavior -- a small numbered badge shows each column's position in the active sort order once
 * more than one column is sorted).
 */
export function DataGrid<T extends Record<string, unknown>>({
  columns,
  rows,
  getRowId,
  fileName = 'export',
  pageSize = 10,
  maxBodyHeight = 520,
  filtersSummary,
  extraFilterParts,
}: DataGridProps<T>) {
  const tableRef = useRef<HTMLTableElement>(null);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState('');
  const [columnOrder, setColumnOrder] = useState<ColumnOrderState>(columns.map((c) => String(c.key)));
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
  const [columnPinning, setColumnPinning] = useState<ColumnPinningState>({ left: [], right: [] });
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize });
  const [exporting, setExporting] = useState(false);
  const [pdfNotice, setPdfNotice] = useState<string | null>(null);

  const columnDefs = useMemo<ColumnDef<T>[]>(
    () =>
      columns.map((col) => ({
        id: String(col.key),
        accessorFn: (row: T) => (col.rawValue ? col.rawValue(row) : row[col.key]),
        header: col.header,
        size: col.width ?? 130,
        cell: (info) => (col.render ? col.render(info.row.original) : String(info.getValue() ?? '')),
      })),
    [columns],
  );

  const table = useReactTable({
    data: rows,
    columns: columnDefs,
    getRowId,
    state: { sorting, columnFilters, globalFilter, columnOrder, columnSizing, columnPinning, pagination },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onColumnOrderChange: setColumnOrder,
    onColumnSizingChange: setColumnSizing,
    onColumnPinningChange: setColumnPinning,
    onPaginationChange: setPagination,
    columnResizeMode: 'onChange',
    enableColumnResizing: true,
    enableMultiSort: true,
    isMultiSortEvent: (e) => (e as React.MouseEvent).shiftKey,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  const exportRows = table.getSortedRowModel().rows.map((r) => r.original);
  const alignOf = (id: string) => columns.find((c) => String(c.key) === id)?.align ?? 'left';

  // Format number with thousand separators and 2 decimal places
  function formatNumberForPdf(value: unknown): string {
    if (value === null || value === undefined || value === '') return '';
    const num = Number(value);
    if (Number.isNaN(num)) return String(value);
    return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /** Builds one <tr> for `row`, same badge / rawValue / render / number-formatting precedence as
   * the live table -- shared by every page's table in exportPdf below. */
  function buildExportRow(row: T, idx: number): HTMLTableRowElement {
    const tr = document.createElement('tr');
    tr.style.backgroundColor = idx % 2 === 0 ? '#ffffff' : '#f7fafc';
    columns.forEach((col) => {
      const td = document.createElement('td');
      td.style.padding = '10px';
      td.style.textAlign = col.align ?? 'left';
      td.style.borderBottom = '1px solid #e2e8f0';
      td.style.fontSize = '11px';
      td.style.color = '#1a202c';

      // Semantic-status columns (e.g. a <SemanticBadge> on screen) render as their own colored
      // dot + label here, matching the dashboard exactly, instead of falling through to the
      // generic text-extraction below -- which for one of these columns previously produced
      // either "[object Object]" or the raw, uncolored status code (e.g. "red").
      const badgeStatus = col.badge?.(row);
      if (badgeStatus) {
        const wrap = document.createElement('span');
        wrap.style.display = 'inline-flex';
        wrap.style.alignItems = 'center';
        wrap.style.gap = '6px';
        const dot = document.createElement('span');
        dot.style.display = 'inline-block';
        dot.style.width = '8px';
        dot.style.height = '8px';
        dot.style.borderRadius = '50%';
        dot.style.flexShrink = '0';
        dot.style.backgroundColor = SEMANTIC_STATUS_PDF_COLOR[badgeStatus];
        const text = document.createElement('span');
        text.textContent = SEMANTIC_STATUS_LABEL[badgeStatus];
        text.style.color = SEMANTIC_STATUS_PDF_COLOR[badgeStatus];
        text.style.fontWeight = '600';
        wrap.appendChild(dot);
        wrap.appendChild(text);
        td.appendChild(wrap);
        tr.appendChild(td);
        return;
      }

      // Extract text content properly - avoid [object object] issues
      let value = '';
      let rawVal: unknown = null;

      if (col.rawValue) {
        rawVal = col.rawValue(row);
        value = String(rawVal);
      } else if (col.render) {
        // For rendered content, try to extract text from React output
        const rendered = col.render(row);
        if (typeof rendered === 'string') {
          value = rendered;
        } else if (rendered && typeof rendered === 'object') {
          // Handle React elements by extracting text content
          if (isValidElement(rendered) && rendered.props && (rendered.props as any).children) {
            value = String((rendered.props as any).children);
          } else {
            value = String(row[col.key] ?? '');
          }
        } else {
          value = String(rendered ?? '');
        }
      } else {
        rawVal = row[col.key];
        value = String(rawVal ?? '');
      }

      // Format numbers with thousand separators and 2 decimal places
      const formattedValue = formatNumberForPdf(rawVal || value);

      td.textContent = formattedValue || value;
      tr.appendChild(td);
    });
    return tr;
  }

  /** Builds a page's table: a freshly-built header row (repeated on every page, not just visually
   * carried over) plus this page's row chunk. */
  function buildExportTable(rowsForPage: T[]): HTMLTableElement {
    const table = document.createElement('table');
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';
    table.style.marginBottom = '20px';

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    columns.forEach((col) => {
      const th = document.createElement('th');
      th.textContent = col.header;
      th.style.padding = '12px';
      th.style.textAlign = col.align ?? 'left';
      th.style.fontWeight = 'bold';
      th.style.backgroundColor = '#2d3748';
      th.style.color = '#ffffff';
      th.style.borderBottom = '2px solid #1a202c';
      th.style.fontSize = '12px';
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    rowsForPage.forEach((row, idx) => tbody.appendChild(buildExportRow(row, idx)));
    table.appendChild(tbody);
    return table;
  }

  /**
   * Rows are split into fixed PDF_TABLE_ROWS_PER_PAGE-row chunks up front (see pdfPagination.ts)
   * and each chunk is rasterized as its own independent PDF page (see pdfPageAssembly.ts) --
   * replacing the previous raw pixel slice of one tall canvas, which had no concept of a row
   * boundary at all and could (and, per real exported PDFs, did) cut a row in half at every page
   * break.
   */
  async function exportPdf() {
    if (!tableRef.current || exportRows.length === 0) return;
    if (exportRows.length > PDF_MAX_ROWS) {
      setPdfNotice(
        `PDF export is limited to ${PDF_MAX_ROWS.toLocaleString()} rows, and ${exportRows.length.toLocaleString()} currently match. ` +
          'Narrow the results with the search box, column filters or the page filters, or use Export CSV for the full list.',
      );
      return;
    }
    setPdfNotice(null);
    setExporting(true);
    try {
      const rowChunks = chunkRows(exportRows);
      const pageCount = rowChunks.length;
      const titleText = fileName.replace(/-/g, ' ').toUpperCase();

      const pages = rowChunks.map((rowsForPage, pageIndex) => {
        const container = document.createElement('div');
        container.style.position = 'absolute';
        container.style.left = '-9999px';
        container.style.width = '1200px';
        container.style.background = '#ffffff';
        container.style.padding = '30px';
        container.style.fontFamily = 'Arial, sans-serif';
        container.style.fontSize = '12px';
        container.style.color = '#111827';

        const title = document.createElement('h1');
        title.textContent = pageCount > 1 ? `${titleText} (PAGE ${pageIndex + 1} OF ${pageCount})` : titleText;
        title.style.fontSize = '18px';
        title.style.fontWeight = 'bold';
        title.style.marginBottom = '10px';
        title.style.color = '#111827';
        container.appendChild(title);

        if (pageIndex === 0) {
          // A page-supplied `filtersSummary` ("A | B", or "No filters applied") replaces the
          // app-wide filter list (for pages whose filters aren't the global ones, e.g. BCG's own
          // company slicer); otherwise the shared context supplies it.
          const summaryParts = filtersSummary
            ? filtersSummary.split(' | ').filter((p) => p && !/^no filters applied/i.test(p))
            : undefined;
          appendPdfMetaBlock(container, { filterParts: summaryParts, extraFilterParts });
        }

        container.appendChild(buildExportTable(rowsForPage));

        if (pageIndex === pageCount - 1) {
          const footer = document.createElement('div');
          footer.style.marginTop = '20px';
          footer.style.fontSize = '10px';
          footer.style.color = '#718096';
          footer.style.borderTop = '1px solid #e2e8f0';
          footer.style.paddingTop = '10px';
          footer.textContent = `Exported on ${new Date().toLocaleDateString()} at ${new Date().toLocaleTimeString()} | Total rows: ${exportRows.length}`;
          container.appendChild(footer);
        }

        return container;
      });

      await assemblePaginatedPdf({ pages, fileName });
    } catch (err) {
      console.error('PDF export failed:', err);
    } finally {
      setExporting(false);
    }
  }

  /** Plain-text value for one cell, for CSV export -- same rawValue-first, then-render,
   * then-raw-column fallback order as exportPdf's cell extraction, minus the PDF-specific number
   * formatting and badge rasterization (a CSV cell is just text; a spreadsheet does its own number
   * formatting on open). */
  function cellTextValue(col: DataGridColumn<T>, row: T): string {
    if (col.rawValue) return String(col.rawValue(row));
    if (col.render) {
      const rendered = col.render(row);
      if (typeof rendered === 'string') return rendered;
      if (rendered && typeof rendered === 'object' && isValidElement(rendered) && (rendered.props as any)?.children) {
        return String((rendered.props as any).children);
      }
      return String(row[col.key] ?? '');
    }
    return String(row[col.key] ?? '');
  }

  function csvEscape(value: string): string {
    return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  }

  function exportCsv() {
    if (exportRows.length === 0) return;
    const header = columns.map((c) => csvEscape(c.header)).join(',');
    const lines = exportRows.map((row) => columns.map((c) => csvEscape(cellTextValue(c, row))).join(','));
    // UTF-8 BOM so Excel (and other CSV readers that default to a legacy codepage) detect UTF-8 and
    // render Arabic / non-Latin customer and salesperson names instead of mojibake. CRLF line
    // endings are the CSV convention Excel expects.
    downloadBlob(`﻿${[header, ...lines].join('\r\n')}`, `${fileName}.csv`, 'text/csv;charset=utf-8;');
  }

  function handleHeaderDrop(draggedId: string, targetId: string) {
    if (draggedId === targetId) return;
    setColumnOrder((prev) => {
      const next = [...prev];
      const from = next.indexOf(draggedId);
      const to = next.indexOf(targetId);
      if (from === -1 || to === -1) return prev;
      next.splice(from, 1);
      next.splice(to, 0, draggedId);
      return next;
    });
  }

  const pageCount = table.getPageCount();

  return (
    <div>
      {/* Toolbar: global search (left) + export/copy actions (right). */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 10,
        }}
      >
        <div style={{ position: 'relative', flex: '1 1 220px', maxWidth: 320 }}>
          <Search
            size={14}
            style={{
              position: 'absolute',
              left: 10,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--ps-color-muted-text)',
            }}
          />
          <input
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            placeholder="Search all columns..."
            style={{
              width: '100%',
              padding: '7px 10px 7px 30px',
              borderRadius: 8,
              border: '1px solid var(--ps-color-border)',
              background: 'var(--ps-color-surface)',
              color: 'var(--ps-color-text)',
              fontSize: 13,
            }}
          />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <ToolbarButton icon={Download} label="Export CSV" onClick={exportCsv} disabled={exportRows.length === 0} />
          <ToolbarButton
            icon={FileJson}
            label={exporting ? 'Exporting...' : 'Export as PDF'}
            onClick={exportPdf}
            disabled={exporting}
          />
        </div>
      </div>

      {pdfNotice && (
        <div
          role="alert"
          style={{
            marginBottom: 10,
            padding: '8px 12px',
            borderRadius: 8,
            border: '1px solid var(--ps-color-watch)',
            background: 'var(--ps-color-muted-bg)',
            color: 'var(--ps-color-text)',
            fontSize: 12,
          }}
        >
          {pdfNotice}
        </div>
      )}

      {/* Table - horizontally (and, up to maxBodyHeight, vertically) scrollable so resized/many
          columns and long result sets never break the page layout. The header stays sticky within
          this scroll container on both axes -- pinned columns stick left, every header cell sticks
          to the top of the container. */}
      <div
        style={{
          overflowX: 'auto',
          overflowY: maxBodyHeight ? 'auto' : undefined,
          maxHeight: maxBodyHeight ?? undefined,
          border: '1px solid var(--ps-color-border)',
          borderRadius: 'var(--ps-card-radius-sm, 10px)',
        }}
      >
        <table ref={tableRef} style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const isPinned = header.column.getIsPinned();
                  const sortDir = header.column.getIsSorted();
                  const sortIndex = header.column.getSortIndex();
                  const showSortIndex = sorting.length > 1 && sortIndex > -1;
                  return (
                    <th
                      key={header.id}
                      colSpan={header.colSpan}
                      draggable
                      onDragStart={(e) => e.dataTransfer.setData('text/plain', header.column.id)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        handleHeaderDrop(e.dataTransfer.getData('text/plain'), header.column.id);
                      }}
                      style={{
                        position: 'sticky',
                        top: 0,
                        left: isPinned === 'left' ? header.column.getStart('left') : undefined,
                        zIndex: isPinned ? 3 : 2,
                        width: header.getSize(),
                        minWidth: header.getSize(),
                        background: 'var(--ps-color-muted-bg)',
                        borderBottom: '2px solid var(--ps-color-border)',
                        padding: 'var(--ps-space-2, 8px) 10px',
                        textAlign: alignOf(header.column.id),
                        userSelect: 'none',
                        cursor: 'grab',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: alignOf(header.column.id) === 'right' ? 'flex-end' : 'flex-start' }}>
                        <button
                          onClick={header.column.getToggleSortingHandler()}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            border: 'none',
                            background: 'transparent',
                            color: 'var(--ps-color-text)',
                            fontWeight: 700,
                            fontSize: 12,
                            cursor: 'pointer',
                            padding: 0,
                          }}
                          title="Click to sort - shift-click to sort by multiple columns"
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {sortDir === 'asc' ? (
                            <ArrowUp size={12} />
                          ) : sortDir === 'desc' ? (
                            <ArrowDown size={12} />
                          ) : (
                            <ArrowUpDown size={11} style={{ opacity: 0.4 }} />
                          )}
                          {showSortIndex && (
                            <span
                              aria-hidden
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                minWidth: 13,
                                height: 13,
                                borderRadius: 999,
                                background: 'var(--ps-color-accent)',
                                color: 'var(--ps-color-on-accent)',
                                fontSize: 9,
                                fontWeight: 700,
                              }}
                            >
                              {sortIndex + 1}
                            </span>
                          )}
                        </button>
                        <button
                          onClick={() => header.column.pin(isPinned ? false : 'left')}
                          title={isPinned ? 'Unpin column' : 'Pin column (freeze)'}
                          style={{
                            border: 'none',
                            background: 'transparent',
                            color: isPinned ? 'var(--ps-color-accent)' : 'var(--ps-color-muted-text)',
                            cursor: 'pointer',
                            display: 'flex',
                            padding: 0,
                            opacity: 0.7,
                          }}
                        >
                          {isPinned ? <Pin size={11} /> : <PinOff size={11} />}
                        </button>
                      </div>

                      {/* Per-column filter input. */}
                      <input
                        value={(header.column.getFilterValue() as string) ?? ''}
                        onChange={(e) => header.column.setFilterValue(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        placeholder="Filter..."
                        style={{
                          width: '100%',
                          marginTop: 6,
                          padding: '3px 6px',
                          fontSize: 11,
                          borderRadius: 4,
                          border: '1px solid var(--ps-color-border)',
                          background: 'var(--ps-color-surface)',
                          color: 'var(--ps-color-text)',
                        }}
                      />

                      {/* Resize handle. */}
                      <div
                        onMouseDown={header.getResizeHandler()}
                        onTouchStart={header.getResizeHandler()}
                        style={{
                          position: 'absolute',
                          right: 0,
                          top: 0,
                          height: '100%',
                          width: 5,
                          cursor: 'col-resize',
                          background: header.column.getIsResizing() ? 'var(--ps-color-accent)' : 'transparent',
                        }}
                      />
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id} className="ps-datatable-row">
                {row.getVisibleCells().map((cell) => {
                  const isPinned = cell.column.getIsPinned();
                  return (
                    <td
                      key={cell.id}
                      style={{
                        position: isPinned ? 'sticky' : undefined,
                        left: isPinned === 'left' ? cell.column.getStart('left') : undefined,
                        zIndex: isPinned ? 1 : undefined,
                        background: isPinned ? 'var(--ps-color-surface)' : undefined,
                        width: cell.column.getSize(),
                        minWidth: cell.column.getSize(),
                        padding: '8px 10px',
                        textAlign: alignOf(cell.column.id),
                        borderBottom: '1px solid var(--ps-color-border)',
                      }}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  );
                })}
              </tr>
            ))}
            {table.getRowModel().rows.length === 0 && (
              <tr>
                <td
                  colSpan={columns.length}
                  style={{ padding: 16, textAlign: 'center', color: 'var(--ps-color-muted-text)', fontSize: 13 }}
                >
                  No rows match the current search/filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination footer. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
          marginTop: 10,
          fontSize: 12,
          color: 'var(--ps-color-muted-text)',
        }}
      >
        <span>
          {table.getFilteredRowModel().rows.length} row{table.getFilteredRowModel().rows.length === 1 ? '' : 's'}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <select
            value={pagination.pageSize}
            onChange={(e) => table.setPageSize(Number(e.target.value))}
            style={{
              padding: '4px 6px',
              borderRadius: 6,
              border: '1px solid var(--ps-color-border)',
              background: 'var(--ps-color-surface)',
              color: 'var(--ps-color-text)',
              fontSize: 12,
            }}
          >
            {[10, 25, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n} / page
              </option>
            ))}
          </select>
          <button onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()} style={pagerBtnStyle}>
            Prev
          </button>
          <span>
            Page {pageCount === 0 ? 0 : pagination.pageIndex + 1} of {pageCount}
          </span>
          <button onClick={() => table.nextPage()} disabled={!table.getCanNextPage()} style={pagerBtnStyle}>
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

const pagerBtnStyle: React.CSSProperties = {
  padding: '4px 10px',
  borderRadius: 6,
  border: '1px solid var(--ps-color-border)',
  background: 'var(--ps-color-surface)',
  color: 'var(--ps-color-text)',
  fontSize: 12,
  cursor: 'pointer',
};

function ToolbarButton({
  icon: Icon,
  overrideIcon: OverrideIcon,
  label,
  onClick,
  disabled = false,
}: {
  icon: React.ComponentType<{ size?: number | string }>;
  overrideIcon?: React.ComponentType<{ size?: number | string }>;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  const ActiveIcon = OverrideIcon ?? Icon;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 12px',
        borderRadius: 8,
        border: '1px solid var(--ps-color-border)',
        background: disabled ? 'var(--ps-color-muted-bg)' : 'var(--ps-color-surface)',
        color: disabled ? 'var(--ps-color-muted-text)' : 'var(--ps-color-text)',
        fontSize: 12,
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <ActiveIcon size={13} />
      {label}
    </button>
  );
}

function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
