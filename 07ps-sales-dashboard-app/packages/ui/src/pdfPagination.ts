/**
 * Canonical table-PDF row-chunking rule, shared by every html2canvas/jsPDF table export in this
 * package (performanceTablePdfExport.ts, pdfExport.ts, DataGrid.tsx's exportPdf) so none of them
 * can drift from the others or reimplement this math themselves.
 *
 * Replaces the previous approach of measuring each row's rendered height and picking page-break
 * points from that (or, in DataGrid/pdfExport's case, no row-awareness at all -- a raw pixel slice
 * of one tall canvas). Both were confirmed against real exported PDFs to still cut rows across a
 * page boundary or duplicate them, because they depend on html2canvas's rasterization being
 * pixel-exact with the DOM measurements taken beforehand, which it isn't always. A hard, pre-render
 * row count per page removes that dependency entirely: pagination is decided before anything is
 * drawn, not inferred from pixel measurements after the fact.
 *
 * backend/src/services/reportPdf.ts (the whole-page Puppeteer "Export Report" flow) needs the same
 * rule but can't import this file directly -- it's a separate tsc build with `rootDir: "src"`,
 * which can't compile a sibling workspace package's raw TS source without restructuring its output
 * layout. It keeps its own copy of chunkRows, explicitly cross-referenced to this file; if
 * PDF_TABLE_ROWS_PER_PAGE ever changes, that copy must change too.
 */

/** Hard cap on data rows per PDF page. Every page is full at this count except the last, which
 * holds the remainder -- Math.ceil(totalRows / PDF_TABLE_ROWS_PER_PAGE) pages, deterministically,
 * regardless of row height, cell content length, or the rendering engine's own page-break
 * behavior. */
export const PDF_TABLE_ROWS_PER_PAGE = 18;

/** Row ceiling for a single interactive-grid PDF export (DataGrid). Every page is rasterized in the
 * browser, so cost and memory grow linearly with page count; past this (500 rows = 28 pages) the
 * export is refused with a prompt to filter down or use CSV, which has no such limit. */
export const PDF_MAX_ROWS = 500;

/** Splits `rows` into fixed-size pages of at most `pageSize` rows each (default
 * PDF_TABLE_ROWS_PER_PAGE). The last chunk holds the remainder and is never padded -- chunkRows of
 * 37 rows at size 18 returns [18, 18, 1], never [18, 18, 18] with fabricated rows. An empty `rows`
 * returns an empty array (zero pages), not a single empty page. */
export function chunkRows<T>(rows: T[], pageSize: number = PDF_TABLE_ROWS_PER_PAGE): T[][] {
  if (rows.length === 0) return [];
  const pages: T[][] = [];
  for (let i = 0; i < rows.length; i += pageSize) {
    pages.push(rows.slice(i, i + pageSize));
  }
  return pages;
}
