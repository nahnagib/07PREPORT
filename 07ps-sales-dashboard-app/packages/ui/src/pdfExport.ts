import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';

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
}

/**
 * Shared "export this table to a PDF" utility, factored out of DataGrid's own exportPdf method
 * (same technique: build an off-screen styled DOM table, rasterize it with html2canvas, embed the
 * image into a jsPDF document) so every drill-down table on a page can reuse one PDF export
 * instead of each reimplementing DataGrid's full sort/filter/pagination machinery just to get a
 * PDF button. Both dependencies are already used by @07ps/ui (see DataGrid.tsx), so this adds no
 * new dependency.
 */
export async function exportRowsAsPdf({ title, subtitle, columns, rows, fileName }: PdfExportOptions): Promise<void> {
  const tempContainer = document.createElement('div');
  tempContainer.style.position = 'absolute';
  tempContainer.style.left = '-9999px';
  tempContainer.style.width = '1200px';
  tempContainer.style.background = '#ffffff';
  tempContainer.style.padding = '30px';
  tempContainer.style.fontFamily = 'Arial, sans-serif';
  tempContainer.style.fontSize = '12px';
  tempContainer.style.color = '#111827';

  const titleEl = document.createElement('h1');
  titleEl.textContent = subtitle ? `${title} — ${subtitle}` : title;
  titleEl.style.fontSize = '18px';
  titleEl.style.fontWeight = 'bold';
  titleEl.style.marginBottom = '16px';
  titleEl.style.color = '#111827';
  tempContainer.appendChild(titleEl);

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
  tempContainer.appendChild(table);

  const footer = document.createElement('div');
  footer.style.marginTop = '12px';
  footer.style.fontSize = '10px';
  footer.style.color = '#718096';
  footer.style.borderTop = '1px solid #e2e8f0';
  footer.style.paddingTop = '10px';
  footer.textContent = `Exported on ${new Date().toLocaleDateString()} at ${new Date().toLocaleTimeString()} | Total rows: ${rows.length}`;
  tempContainer.appendChild(footer);

  document.body.appendChild(tempContainer);
  try {
    const canvas = await html2canvas(tempContainer, {
      scale: 2,
      useCORS: true,
      logging: false,
      backgroundColor: '#ffffff',
    });

    const imgData = canvas.toDataURL('image/png');
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const imgWidth = pageWidth - 20;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;
    let heightLeft = imgHeight;
    let position = 10;

    pdf.addImage(imgData, 'PNG', 10, position, imgWidth, imgHeight);
    heightLeft -= pageHeight - 20;
    while (heightLeft > 0) {
      position = heightLeft - imgHeight;
      pdf.addPage();
      pdf.addImage(imgData, 'PNG', 10, position, imgWidth, imgHeight);
      heightLeft -= pageHeight - 20;
    }

    pdf.save(`${fileName}.pdf`);
  } finally {
    document.body.removeChild(tempContainer);
  }
}
