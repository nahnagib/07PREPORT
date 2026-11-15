import ExcelJS from 'exceljs';
import { getTree } from './treeService';
import { listProjects, type ProjectFilters } from './projectService';
import { listFeedback } from './monitorService';

/** Excel downloads of the tree, the project pipeline and the feedback list (TIKA rows only, like every read). */

const STATUS_LABEL: Record<string, string> = { in_market: 'In Market', planned: 'Planned', under_development: 'Under Development', discontinued: 'Discontinued' };
const STATE_LABEL: Record<string, string> = { draft: 'Draft', submitted: 'Submitted', active: 'Active', on_hold: 'On hold', rejected: 'Rejected', launched: 'Launched', closed: 'Closed' };

function sheet(wb: ExcelJS.Workbook, name: string, headers: [string, number][]) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = headers.map(([header, width]) => ({ header, width }));
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  return ws;
}

const asDate = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`) : null);

export async function exportTree(ck: number): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = sheet(wb, 'Product Tree', [['Brand', 12], ['Family', 30], ['Subfamily', 28], ['Product', 30], ['Description', 60], ['Status', 18], ['Planned launch', 14], ['Actual launch', 14], ['As market needs', 10], ['Comment', 24], ['Odoo product', 36]]);
  for (const b of await getTree(ck)) {
    for (const f of b.families) for (const s of f.subfamilies) for (const p of s.products) {
      ws.addRow([b.name, f.name, s.name, p.name, p.description ?? '', STATUS_LABEL[p.status], asDate(p.planned_launch_date), asDate(p.actual_launch_date), p.launch_date_flexible ? 'Yes' : '', p.comment ?? '', p.odoo_name ?? '']);
    }
  }
  for (const c of [7, 8]) ws.getColumn(c).numFmt = 'yyyy-mm-dd';
  ws.getColumn(5).alignment = { wrapText: true, vertical: 'top' };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function exportProjects(ck: number, filters: ProjectFilters): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = sheet(wb, 'R&D Projects', [['Code', 14], ['Title', 36], ['Product', 28], ['Family', 26], ['Classification', 14], ['Type', 30], ['Source', 16], ['Fast-track', 10], ['Owner', 22], ['Gate', 7], ['State', 12], ['Score', 8], ['Submitted', 14], ['Target launch', 14], ['Late', 6]]);
  for (const p of await listProjects(ck, filters)) {
    ws.addRow([p.code, p.title, p.product_name ?? `${p.proposed_product_name} (proposed)`, p.family_name ?? '', p.classification, p.project_type, p.request_source, p.fast_track ? 'Yes' : '',
      p.owner_name ?? '', p.current_gate, STATE_LABEL[p.state], p.latest_score, p.submitted_at ? asDate(p.submitted_at.slice(0, 10)) : null, asDate(p.target_launch_date), p.late ? 'Yes' : '']);
  }
  for (const c of [13, 14]) ws.getColumn(c).numFmt = 'yyyy-mm-dd';
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function exportFeedback(ck: number, filters: { productId?: number; status?: string }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = sheet(wb, 'Customer Feedback', [['Date', 12], ['Product', 28], ['Customer', 30], ['Channel', 14], ['Rating', 7], ['Category', 14], ['Comment', 50], ['Follow-up owner', 22], ['Status', 12], ['Due', 12], ['Resolution', 40]]);
  const { feedback } = await listFeedback(ck, filters);
  for (const f of feedback as Record<string, unknown>[]) {
    ws.addRow([asDate(f.feedback_date as string), f.product_name, f.odoo_customer ?? f.customer_name, f.channel, f.rating, f.category, f.comment ?? '', f.owner_name ?? '', f.followup_status, asDate(f.due_date as string | null), f.resolution ?? '']);
  }
  for (const c of [1, 10]) ws.getColumn(c).numFmt = 'yyyy-mm-dd';
  for (const c of [7, 11]) ws.getColumn(c).alignment = { wrapText: true, vertical: 'top' };
  return Buffer.from(await wb.xlsx.writeBuffer());
}
