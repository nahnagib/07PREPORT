import ExcelJS from 'exceljs';
import type { Pool } from 'mysql2/promise';
import type { Filters } from '../measures/filters';
import { fetchCasesForExport, type FollowupQuery, type FollowupStatus } from './npsFollowupService';

export const STATUS_LABEL: Record<FollowupStatus, string> = {
  HISTORICAL: 'Historical',
  NEW: 'New',
  CONTACTED: 'Contacted',
  IN_PROGRESS: 'In progress',
  SOLVED: 'Solved',
  CANCELLED: 'Cancelled',
};

const COLUMNS: { header: string; width: number }[] = [
  { header: 'Case', width: 8 }, { header: 'Rated at', width: 18 }, { header: 'Status', width: 12 }, { header: 'Company', width: 12 },
  { header: 'Customer', width: 30 }, { header: 'Order', width: 14 }, { header: 'Delivery', width: 18 }, { header: 'Branch', width: 18 },
  { header: 'Salesperson', width: 22 }, { header: 'Reason', width: 22 }, { header: 'Reason (AR)', width: 22 }, { header: 'Owner', width: 20 },
  { header: 'Contacted at', width: 18 }, { header: 'Solved at', width: 18 }, { header: 'Hours open', width: 11 },
  { header: 'Root cause', width: 35 }, { header: 'Action taken', width: 35 }, { header: 'Notes', width: 35 },
  { header: 'Source changed', width: 30 },
];

/** The filtered cases (List view: every status) as .xlsx; the comment column only when the caller may export comments. */
export async function buildFollowupExport(pool: Pool, q: FollowupQuery, f: Filters, withComments: boolean): Promise<Buffer> {
  const rows = await fetchCasesForExport(pool, q, f, withComments);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Detractor Follow-up', { views: [{ state: 'frozen', ySplit: 1 }] });
  const columns = withComments ? [...COLUMNS, { header: 'Comment', width: 45 }] : COLUMNS;
  sheet.columns = columns;
  sheet.getRow(1).font = { bold: true };
  for (const c of rows) {
    sheet.addRow([
      c.caseId, c.ratedAt, STATUS_LABEL[c.status], c.company, c.customer, c.orderRef, c.deliveryCode, c.teamBranch ?? c.salesTeam,
      c.salesperson, c.reasonEn, c.reasonAr, c.ownerName, c.contactedAt, c.solvedAt, c.hoursOpen, c.rootCause, c.actionTaken, c.notes,
      c.sourceChanged ? `${c.sourceChangeReason ?? 'yes'} (${c.sourceChangedAt ?? ''} UTC)` : '',
      ...(withComments ? [c.comment] : []),
    ]);
  }
  for (const col of [16, 17, 18, ...(withComments ? [20] : [])]) sheet.getColumn(col).alignment = { wrapText: true, vertical: 'top' };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
