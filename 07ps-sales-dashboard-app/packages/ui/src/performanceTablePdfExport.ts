import type { PerformanceReportRow } from './components/PerformanceReportTable';
import { chunkRows } from './pdfPagination';
import { assemblePaginatedPdf } from './pdfPageAssembly';
import { appendPdfMetaBlock } from './pdfExportContext';

export interface PerformanceTablePdfColumn {
  header: string;
  getValue: (row: PerformanceReportRow) => string;
}

export interface ExportPerformanceTablePdfOptions {
  /** Rendered as the PDF's H2, and (slugified) as the default file name. */
  title: string;
  rows: PerformanceReportRow[];
  /** Column set to render, in order -- callers supply this because PerformanceReportTable's own
   * layout varies (showLytdColumn vs compactColumns vs default), and the PDF should mirror
   * whichever columns are actually on screen. */
  columns: PerformanceTablePdfColumn[];
  /** Optional override. When omitted (the norm), the app-wide registered export context supplies
   * the resolved filter list -- see pdfExportContext.ts. */
  filterParts?: string[];
  /** Optional override; defaults to the signed-in user from the registered export context. */
  exportedByEmail?: string | null;
  /** Page-local filters listed after the app-wide ones. */
  extraFilterParts?: string[];
  /** Base file name (no extension). Defaults to a slug of `title`. */
  fileName?: string;
}

function buildTable(columns: PerformanceTablePdfColumn[], rows: PerformanceReportRow[]): HTMLTableElement {
  const table = document.createElement('table');
  table.style.width = '100%';
  table.style.borderCollapse = 'collapse';
  table.style.marginBottom = '20px';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  columns.forEach((col) => {
    const th = document.createElement('th');
    th.textContent = col.header;
    th.style.padding = '10px';
    th.style.textAlign = 'left';
    th.style.fontWeight = 'bold';
    th.style.backgroundColor = '#f3f4f6';
    th.style.borderBottom = '2px solid #d1d5db';
    th.style.fontSize = '11px';
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  rows.forEach((row, idx) => {
    const tr = document.createElement('tr');
    tr.style.backgroundColor = idx % 2 === 0 ? '#ffffff' : '#f9fafb';
    columns.forEach((col) => {
      const td = document.createElement('td');
      td.textContent = col.getValue(row);
      td.style.padding = '8px';
      td.style.textAlign = 'left';
      td.style.borderBottom = '1px solid #e5e7eb';
      td.style.fontSize = '11px';
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  return table;
}

function buildContainer(): HTMLDivElement {
  const container = document.createElement('div');
  container.style.position = 'absolute';
  container.style.left = '-9999px';
  container.style.width = '1000px';
  container.style.background = '#ffffff';
  container.style.padding = '30px';
  container.style.fontFamily = 'Arial, sans-serif';
  container.style.fontSize = '12px';
  container.style.color = '#111827';
  return container;
}

/**
 * Shared Performance Details table PDF exporter, factored out of the Tachometer page's original
 * page-local `handleExportTablePdf` (same off-screen DOM table + html2canvas rasterize) so every
 * PerformanceReportTable consumer gets the same export instead of each page reimplementing it.
 * Distinct from pdfExport.ts's `exportRowsAsPdf` (a simpler generic table-to-PDF used for
 * drill-down/chart exports elsewhere) -- this one specifically matches PerformanceReportTable's
 * look: filters-applied list, "Exported by" line, and a title/filters block on the first page only.
 *
 * Pagination: rows are split into fixed PDF_TABLE_ROWS_PER_PAGE-row chunks up front (see
 * pdfPagination.ts's chunkRows) and each chunk is rendered as its own, fully independent page
 * container -- see pdfPageAssembly.ts's header comment for why this replaced the previous
 * row-height-measurement approach. The header row is rebuilt (not just visually repeated) at the
 * top of every page's own table, including the first.
 */
export async function exportPerformanceTablePdf({
  title,
  rows,
  columns,
  filterParts,
  exportedByEmail,
  extraFilterParts,
  fileName,
}: ExportPerformanceTablePdfOptions): Promise<void> {
  // chunkRows returns [] (zero pages) for zero rows -- this exporter always produces at least one
  // page (a header-only table), same as before pagination existed, so a caller that didn't guard
  // against an empty `rows` still gets a PDF instead of silently nothing.
  const rowChunks = rows.length === 0 ? [[]] : chunkRows(rows);
  const pageCount = rowChunks.length;

  const pages = rowChunks.map((chunkOfRows, pageIndex) => {
    const container = buildContainer();

    const titleEl = document.createElement('h2');
    titleEl.textContent = pageCount > 1 ? `${title} (page ${pageIndex + 1} of ${pageCount})` : title;
    titleEl.style.fontSize = '18px';
    titleEl.style.fontWeight = 'bold';
    titleEl.style.marginBottom = '10px';
    titleEl.style.color = '#111827';
    container.appendChild(titleEl);

    if (pageIndex === 0) {
      appendPdfMetaBlock(container, { filterParts, exportedByEmail, extraFilterParts });
    }

    container.appendChild(buildTable(columns, chunkOfRows));

    if (pageIndex === pageCount - 1) {
      const timestamp = document.createElement('p');
      timestamp.textContent = `Generated: ${new Date().toLocaleString()} | Total rows: ${rows.length}`;
      timestamp.style.fontSize = '10px';
      timestamp.style.color = '#9ca3af';
      timestamp.style.marginTop = '20px';
      container.appendChild(timestamp);
    }

    return container;
  });

  const slug = (fileName ?? title).replace(/\s+/g, '-').toLowerCase();
  await assemblePaginatedPdf({ pages, fileName: slug });
}
