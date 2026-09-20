/**
 * Shared "one already-built DOM container per PDF page" assembly step for every html2canvas/jsPDF
 * table export in this package. Callers (performanceTablePdfExport.ts, pdfExport.ts,
 * DataGrid.tsx) build one fully-styled, off-screen container per page -- each holding at most
 * PDF_TABLE_ROWS_PER_PAGE rows (see pdfPagination.ts's chunkRows) -- and this function rasterizes
 * each one independently and places it on its own jsPDF page.
 *
 * This is the piece that replaces the old single-tall-image-sliced-by-pageHeight technique (used by
 * every one of this package's PDF exports before this pass). That technique's page breaks were
 * either derived from measuring each row's rendered height beforehand (performanceTablePdfExport's
 * old approach) or not row-aware at all (pdfExport.ts/DataGrid.tsx's old raw pixel slice) -- both
 * confirmed against real exported PDFs to still cut a row across the boundary or duplicate it,
 * because they rely on the html2canvas rasterization lining up pixel-exactly with either a DOM
 * measurement taken beforehand or a naive `pageHeight` arithmetic slice. Rasterizing each page's
 * container *separately* removes that dependency: there is no slicing at all, so there is nothing
 * for a measurement/rounding error to misplace a row across.
 *
 * Each page image is scaled to fill the page width and, only if that would make it taller than the
 * page, scaled down further to fit the page height instead (shrink-to-fit, never crop) -- since a
 * page's container holds a hard-capped row count, this fit-down case should be rare, but it's a
 * correctness guarantee, not a best effort: a page's content is never allowed to be taller than the
 * page it's on.
 */

export interface PdfPageAssemblyOptions {
  /** One fully-built, off-screen-styled container per PDF page, in order. Each is temporarily
   * appended to `document.body`, rasterized, then removed -- callers should NOT append these to the
   * DOM themselves. */
  pages: HTMLDivElement[];
  orientation?: 'landscape' | 'portrait';
  /** File name without the .pdf extension. */
  fileName: string;
}

export async function assemblePaginatedPdf({ pages, orientation = 'landscape', fileName }: PdfPageAssemblyOptions): Promise<void> {
  if (pages.length === 0) return;

  const html2canvas = (await import('html2canvas')).default;
  const jsPDF = (await import('jspdf')).jsPDF;

  // Memory: every page's image stays in the jsPDF document until save(), so a big export is bounded
  // by (pages x image bytes). Lossless PNG of a full-page 2x rasterization is several MB each;
  // JPEG (q=0.85) is ~10x smaller and indistinguishable for text tables. Long exports also drop to
  // 1.5x scale, and each canvas is released immediately after it's embedded.
  const scale = pages.length > 20 ? 1.5 : 2;
  const pdf = new jsPDF({ orientation, unit: 'mm', format: 'a4', compress: true });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const marginX = 10; // mm, left/right only -- matches this package's other PDF exports.

  for (let i = 0; i < pages.length; i += 1) {
    const container = pages[i];
    document.body.appendChild(container);
    try {
      const canvas = await html2canvas(container, {
        scale,
        useCORS: true,
        logging: false,
        backgroundColor: '#ffffff',
      });
      const imgData = canvas.toDataURL('image/jpeg', 0.85);

      let imgWidth = pageWidth - marginX * 2;
      let imgHeight = (canvas.height * imgWidth) / canvas.width;
      // Fit-to-page-height fallback: this page's container holds at most one hard-capped row chunk,
      // so it should always fit within pageHeight once scaled to imgWidth -- but if it doesn't
      // (an unusually tall single row, a very wide/zoomed table, etc.), shrink further rather than
      // let addImage() silently draw content past the page's bottom edge (which addImage never
      // crops -- it would just be invisible, not an error, so this guards against it silently).
      if (imgHeight > pageHeight) {
        const shrink = pageHeight / imgHeight;
        imgHeight = pageHeight;
        imgWidth *= shrink;
      }
      const marginLeft = marginX + (pageWidth - marginX * 2 - imgWidth) / 2;

      if (i > 0) pdf.addPage();
      pdf.addImage(imgData, 'JPEG', marginLeft, 0, imgWidth, imgHeight, undefined, 'FAST');
      // Release the bitmap now rather than waiting for GC.
      canvas.width = 0;
      canvas.height = 0;
    } finally {
      document.body.removeChild(container);
    }
    // Yield so the tab stays responsive (and the GC can run) between pages of a long export.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  pdf.save(`${fileName}.pdf`);
}
