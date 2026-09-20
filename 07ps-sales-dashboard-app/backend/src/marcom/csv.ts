import type { Issue } from './parser';

/** Neutralises spreadsheet formula injection: a cell that starts with = + - @ (or a tab/CR that
 * some apps strip before evaluating) is prefixed with an apostrophe so Excel treats it as text. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function issuesToCsv(issues: Issue[]): string {
  const header = ['severity', 'code', 'sheet', 'table', 'cell', 'message'].map(csvCell).join(',');
  const lines = issues.map((i) => [i.severity, i.code, i.sheet, i.table, i.cell, i.message].map(csvCell).join(','));
  // BOM so Excel opens the UTF-8 file with the right encoding.
  return `\uFEFF${[header, ...lines].join('\r\n')}\r\n`;
}
