import { chunkRows } from './pdfPagination';
import { assemblePaginatedPdf } from './pdfPageAssembly';
import { appendPdfMetaBlock } from './pdfExportContext';

export interface PdfExportColumn {
  header: string;
  align?: 'left' | 'right';
}

export interface PdfExportOptions {
  /** Widget name, e.g. "Opportunity by Stage". Rendered as the PDF's H1. */
  title: string;
  /** Active filter context, e.g. "Qualified" or "Expected to close in May 2026". Rendered under
   * the title -- omit when there's no active drill-down filter (exporting everything). */
  subtitle?: string;
  columns: PdfExportColumn[];
  /** Already-formatted cell strings, one array per row, same order as `columns`. */
  rows: string[][];
  /** Base file name (no extension). */
  fileName: string;
  /** Page-local filters (beyond the app-wide ones the shared export context supplies). */
  extraFilterParts?: string[];
}

function buildTable(columns: PdfExportColumn[], rows: string[][]): HTMLTableElement {
  const table = document.createElement('table');
  table.style.width = '100%';
  table.style.borderCollapse = 'collapse';
  table.style.marginBottom = '20px';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  columns.forEach((col) => {
    const th = document.createElement('th');
    th.textContent = col.header;
    th.style.padding = '10px 12px';
    th.style.textAlign = col.align ?? 'left';
    th.style.fontWeight = 'bold';
    th.style.backgroundColor = '#2d3748';
    th.style.color = '#ffffff';
    th.style.borderBottom = '2px solid #1a202c';
    th.style.fontSize = '11px';
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  rows.forEach((row, idx) => {
    const tr = document.createElement('tr');
    tr.style.backgroundColor = idx % 2 === 0 ? '#ffffff' : '#f7fafc';
    row.forEach((cell, colIdx) => {
      const td = document.createElement('td');
      td.textContent = cell;
      td.style.padding = '8px 12px';
      td.style.textAlign = columns[colIdx]?.align ?? 'left';
      td.style.borderBottom = '1px solid #e2e8f0';
      td.style.fontSize = '10px';
      td.style.color = '#1a202c';
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
  container.style.width = '1200px';
  container.style.background = '#ffffff';
  container.style.padding = '30px';
  container.style.fontFamily = 'Arial, sans-serif';
  container.style.fontSize = '12px';
  container.style.color = '#111827';
  return container;
}

/**
 * Shared "export this table to a PDF" utility, factored out of DataGrid's own exportPdf method
 * (same technique: build an off-screen styled DOM table, rasterize it with html2canvas, embed the
 * image into a jsPDF document) so every drill-down table on a page can reuse one PDF export
 * instead of each reimplementing DataGrid's full sort/filter/pagination machinery just to get a
 * PDF button. Both dependencies are already used by @07ps/ui (see DataGrid.tsx), so this adds no
 * new dependency.
 *
 * Pagination: see performanceTablePdfExport.ts's docstring / pdfPageAssembly.ts's header comment --
 * same hard-capped, pre-chunked, one-container-per-page technique, not a measured/sliced single
 * image.
 */
export async function exportRowsAsPdf({ title, subtitle, columns, rows, fileName, extraFilterParts }: PdfExportOptions): Promise<void> {
  // chunkRows returns [] (zero pages) for zero rows -- this exporter always produces at least one
  // page (a header-only table), matching its pre-pagination behavior for an empty `rows`.
  const rowChunks = rows.length === 0 ? [[]] : chunkRows(rows);
  const pageCount = rowChunks.length;
  const baseTitle = subtitle ? `${title} — ${subtitle}` : title;

  const pages = rowChunks.map((chunkOfRows, pageIndex) => {
    const container = buildContainer();

    const titleEl = document.createElement('h1');
    titleEl.textContent = pageCount > 1 ? `${baseTitle} (page ${pageIndex + 1} of ${pageCount})` : baseTitle;
    titleEl.style.fontSize = '18px';
    titleEl.style.fontWeight = 'bold';
    titleEl.style.marginBottom = '16px';
    titleEl.style.color = '#111827';
    container.appendChild(titleEl);

    if (pageIndex === 0) {
      appendPdfMetaBlock(container, { extraFilterParts });
    }

    container.appendChild(buildTable(columns, chunkOfRows));

    if (pageIndex === pageCount - 1) {
      const footer = document.createElement('div');
      footer.style.marginTop = '12px';
      footer.style.fontSize = '10px';
      footer.style.color = '#718096';
      footer.style.borderTop = '1px solid #e2e8f0';
      footer.style.paddingTop = '10px';
      footer.textContent = `Exported on ${new Date().toLocaleDateString()} at ${new Date().toLocaleTimeString()} | Total rows: ${rows.length}`;
      container.appendChild(footer);
    }

    return container;
  });

  await assemblePaginatedPdf({ pages, fileName });
}
