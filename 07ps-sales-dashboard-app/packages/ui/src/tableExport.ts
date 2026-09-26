/**
 * Plain tabular CSV / Excel downloads for surfaces that build their own table rather than using
 * DataGrid (which has its own toolbar export). Same conventions as DataGrid's exportCsv: UTF-8 BOM
 * so Excel renders Arabic names correctly, CRLF line endings.
 *
 * Cells are passed as raw values (numbers stay numbers) so a spreadsheet can sum/sort them -- the
 * on-screen compact "LYD 1.2M" formatting is deliberately not what gets exported.
 */

export type TableExportCell = string | number | null;

export interface TableExportOptions {
  headers: string[];
  rows: TableExportCell[][];
  /** File name without extension. */
  fileName: string;
  /** Excel sheet name (max 31 chars, Excel's own limit). Defaults to "Data". */
  sheetName?: string;
}

function csvEscape(value: TableExportCell): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportRowsAsCsv({ headers, rows, fileName }: TableExportOptions): void {
  const lines = [headers, ...rows].map((row) => row.map(csvEscape).join(','));
  downloadBlob(new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8;' }), `${fileName}.csv`);
}

export async function exportRowsAsXlsx({ headers, rows, fileName, sheetName = 'Data' }: TableExportOptions): Promise<void> {
  // Loaded on demand: xlsx is large and only needed at the moment someone clicks Export.
  const XLSX = await import('xlsx');
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  sheet['!cols'] = headers.map((h) => ({ wch: Math.max(12, h.length + 2) }));
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, sheetName.slice(0, 31));
  XLSX.writeFile(book, `${fileName}.xlsx`);
}
