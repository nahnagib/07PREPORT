import ExcelJS from 'exceljs';
import { listCards, listDropdownValues, type KaizenFilters } from './kaizenService';

const HEADERS = [
  'No', 'Card Creator', 'Date', 'Department', 'Card Name', 'Card Type', 'Issue', 'Root Cause', 'Impact',
  'Card Priority', 'Proposed Solution', 'Expected Date', 'Closer Date', 'Responsible Party', 'Status', 'Overdue',
];

const WIDTHS = [7, 22, 12, 22, 30, 16, 45, 35, 35, 16, 40, 14, 14, 24, 12, 10];

/** The filtered cards list as an .xlsx workbook. The column names match what the one-time import
 * accepts, so an export can be re-imported elsewhere. */
export async function buildKaizenExport(filters: KaizenFilters, sort: { by?: string; dir?: string }): Promise<Buffer> {
  const [{ rows }, dropdowns] = await Promise.all([listCards(filters, sort), listDropdownValues()]);
  const label = new Map(dropdowns.map((d) => [d.value_id, d.label]));

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Kaizen Cards', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = HEADERS.map((header, i) => ({ header, width: WIDTHS[i] }));
  sheet.getRow(1).font = { bold: true };
  const asDate = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`) : null);
  for (const c of rows) {
    sheet.addRow([
      c.card_no,
      c.creator_name,
      asDate(c.card_date),
      label.get(c.department_id) ?? '',
      c.card_name,
      label.get(c.card_type_id) ?? '',
      c.issue,
      c.root_cause ?? '',
      c.impact ?? '',
      label.get(c.priority_id) ?? '',
      c.proposed_solution ?? '',
      asDate(c.expected_date),
      asDate(c.closer_date),
      c.responsible_party ?? '(Not assigned)',
      c.status === 'CLOSED' ? 'Closed' : 'Open',
      c.is_overdue ? 'Yes' : '',
    ]);
  }
  for (const col of [3, 12, 13]) sheet.getColumn(col).numFmt = 'yyyy-mm-dd';
  for (const col of [7, 8, 9, 11]) sheet.getColumn(col).alignment = { wrapText: true, vertical: 'top' };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: HEADERS.length } };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
