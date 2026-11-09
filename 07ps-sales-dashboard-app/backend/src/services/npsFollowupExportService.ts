import ExcelJS from 'exceljs';
import type { Pool } from 'mysql2/promise';
import type { Filters } from '../measures/filters';
import { fetchCasesForExport, type FollowupQuery, type FollowupStage, type FollowupStatus } from './npsFollowupService';

/** The workflow step. */
export const STAGE_LABEL: Record<FollowupStage, string> = {
  HISTORICAL: 'Historical',
  NEW: 'New',
  CONTACTED: 'Contacted',
  IN_PROGRESS: 'In progress',
  RESOLVED: 'Resolved',
  UNRESOLVED: 'Unresolved',
  REJECTED: 'Rejected',
};

/** The outcome group (worked out from the stage). */
export const STATUS_LABEL: Record<FollowupStatus, string> = {
  OPEN: 'Open',
  CLOSE: 'Closed',
  DISPUTED: 'Disputed',
};

const COLUMNS: { header: string; width: number }[] = [
  { header: 'Case', width: 8 }, { header: 'Rated at', width: 18 }, { header: 'Stage', width: 12 }, { header: 'Status', width: 10 },
  { header: 'Company', width: 12 }, { header: 'Customer', width: 30 }, { header: 'Order', width: 14 }, { header: 'Delivery', width: 18 },
  { header: 'Branch', width: 18 }, { header: 'Salesperson', width: 22 },
  { header: 'Reason category', width: 22 }, { header: 'Sub-reason', width: 24 }, { header: 'Reason category (AR)', width: 22 },
  { header: 'Sub-reason (AR)', width: 24 }, { header: 'Reason note', width: 30 }, { header: 'Owner', width: 20 },
  { header: 'Contacted at', width: 18 }, { header: 'Resolved at', width: 18 }, { header: 'Rejected at', width: 18 }, { header: 'Hours open', width: 11 },
  { header: 'Root cause', width: 35 }, { header: 'Action taken', width: 35 }, { header: 'Notes', width: 35 },
  { header: 'Source changed', width: 30 },
];
/** Root cause, Action taken, Notes (1-based). */
const WRAP = [21, 22, 23];

/** The filtered cases (List view: every stage) as .xlsx; the comment column only when the caller may export comments. */
export async function buildFollowupExport(pool: Pool, q: FollowupQuery, f: Filters, withComments: boolean): Promise<Buffer> {
  const rows = await fetchCasesForExport(pool, q, f, withComments);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Detractor Follow-up', { views: [{ state: 'frozen', ySplit: 1 }] });
  const columns = withComments ? [...COLUMNS, { header: 'Comment', width: 45 }] : COLUMNS;
  sheet.columns = columns;
  sheet.getRow(1).font = { bold: true };
  for (const c of rows) {
    sheet.addRow([
      c.caseId, c.ratedAt, STAGE_LABEL[c.stage], c.status ? STATUS_LABEL[c.status] : '', c.company, c.customer, c.orderRef, c.deliveryCode,
      c.teamBranch ?? c.salesTeam, c.salesperson,
      c.categoryEn, c.categoryEn ? (c.subReasonEn ?? 'Not specified') : null, c.categoryAr, c.categoryAr ? (c.subReasonAr ?? 'غير محدد') : null, c.reasonNote,
      c.ownerName, c.contactedAt, c.resolvedAt, c.rejectedAt, c.hoursOpen, c.rootCause, c.actionTaken, c.notes,
      c.sourceChanged ? `${c.sourceChangeReason ?? 'yes'} (${c.sourceChangedAt ?? ''})` : '',
      ...(withComments ? [c.comment] : []),
    ]);
  }
  for (const col of [...WRAP, ...(withComments ? [COLUMNS.length + 1] : [])]) sheet.getColumn(col).alignment = { wrapText: true, vertical: 'top' };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
