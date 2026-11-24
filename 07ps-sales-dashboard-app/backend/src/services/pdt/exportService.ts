import ExcelJS from 'exceljs';
import { getDashboard, getFollowup, listDropdowns } from './trackerService';
import { STAGES, type Filters, type FollowupKind } from './rules';

/** Product Development Plan tracker exports (.xlsx): the dashboard (tracker, where we stand, roadmap, open items) and the
 * follow-up board. The round-trip file in the input format is importService.exportWorkbook. */

const asDate = (d: string | null | undefined) => (d ? new Date(`${d}T00:00:00Z`) : null);

function sheetOf(workbook: ExcelJS.Workbook, name: string, columns: [string, number][], dateCols: number[]): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = columns.map(([header, width]) => ({ header, width }));
  sheet.getRow(1).font = { bold: true };
  for (const c of dateCols) sheet.getColumn(c).numFmt = 'dd mmm yyyy';
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return sheet;
}

async function labels() {
  const d = await listDropdowns();
  return (list: string, code: string | null) => (code ? (d.find((x) => x.list_key === list && x.code === code)?.label ?? code) : '');
}

export async function exportDashboard(filters: Filters): Promise<Buffer> {
  const [dash, label] = await Promise.all([getDashboard(filters), labels()]);
  const workbook = new ExcelJS.Workbook();

  const tracker = sheetOf(workbook, 'Product tracker', [['Code', 9], ['Product', 30], ['Brand', 16], ['Family', 24], ['Subfamily', 22], ['Stage', 14], ['Owner', 20], ['Priority', 10], ['Health', 13], ['Readiness %', 12], ['Target launch', 14], ['Actual launch', 14], ['Flag', 24]], [11, 12]);
  for (const p of dash.tracker) {
    tracker.addRow([
      p.code, p.name, p.brand, p.family ?? '', p.subfamily ?? '', label('stage', p.stage), p.ownerName ?? 'Not set', label('priority', p.priority) || 'Not set',
      label('health', p.health) || 'Not set', p.readinessPct, asDate(p.targetLaunch), asDate(p.actualLaunch), p.flagLabel ?? '',
    ]);
  }

  const stand = sheetOf(workbook, 'Where we stand', [['Product family', 32], ...STAGES.map((s) => [label('stage', s), 13] as [string, number]), ['Total', 10]], []);
  for (const r of dash.matrix.rows) stand.addRow([r.family, ...STAGES.map((s) => r.counts[s]), r.total]);
  const totals = stand.addRow(['Total', ...STAGES.map((s) => dash.matrix.totals[s]), dash.matrix.total]);
  totals.font = { bold: true };

  const roadmap = sheetOf(workbook, 'Launch roadmap', [['Month', 12], ['Code', 9], ['Product', 30], ['Family', 24], ['Target launch', 14], ['Health', 13]], [5]);
  for (const m of dash.roadmap.months) for (const p of m.products) roadmap.addRow([m.month, p.code, p.name, p.family ?? '', asDate(p.targetLaunch), label('health', p.health) || 'Not set']);
  roadmap.addRow([]);
  roadmap.addRow([`Target launch from ${dash.today} to ${dash.roadmap.windowEnd} (next ${dash.settings.upcomingWindowDays} days). ${dash.roadmap.outsideWindow} other not-launched product(s) have a target date outside this window. Readiness is manually estimated.`]);

  const years = sheetOf(workbook, 'Launches by year', [['Year', 8], ['Launched', 11], ['Planned', 11]], []);
  for (const y of dash.byYear) years.addRow([y.year, y.launched, y.planned]);

  const items = sheetOf(workbook, 'Blockers & decisions', [['ID', 9], ['Type', 16], ['Title', 34], ['Product', 28], ['Owner', 20], ['Due', 13], ['Status', 12], ['Overdue', 9], ['Required action', 50]], [6]);
  for (const b of dash.blockers) {
    items.addRow([b.externalId ?? '', b.kind === 'BLOCKER' ? 'Blocker' : 'Decision needed', b.title, `${b.productCode} ${b.productName}`, b.ownerName ?? '', asDate(b.dueDate), b.status === 'OPEN' ? 'Open' : 'In progress', b.overdue ? 'Yes' : '', b.requiredAction]);
  }
  items.getColumn(9).alignment = { wrapText: true, vertical: 'top' };

  const k = dash.kpis;
  const summary = sheetOf(workbook, 'KPIs', [['KPI', 32], ['Value', 10]], []);
  for (const [n, v] of [
    ['Total products', k.total], ['In market', k.inMarket], ['Active (target within 12 months)', k.active],
    ['Planned', k.planned], ['  Planned: no target date', k.plannedNoDate], ['  Planned: target more than 12 months away', k.plannedBeyond], ['  Planned: target date passed', k.plannedPassed],
    ['On track (not launched)', k.onTrack], ['Need attention (at risk + blocked)', k.needAttention],
    [`Launches in next ${dash.settings.upcomingWindowDays} days`, k.upcomingLaunches], ['Health not set (not launched)', k.healthNotSet], ['As of', dash.today],
  ] as [string, number | string][]) summary.addRow([n, v]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export const FOLLOWUP_LABEL: Record<FollowupKind, string> = {
  BLOCKER_OVERDUE: 'Blocker / decision overdue',
  BLOCKER_DUE_SOON: 'Blocker / decision due soon',
  NEXT_STEP_OVERDUE: 'Next step overdue',
  STALE: 'No update',
  LAUNCH_AT_RISK: 'Launch soon, low readiness',
};

export async function exportFollowup(filters: Filters): Promise<Buffer> {
  const f = await getFollowup(filters);
  const workbook = new ExcelJS.Workbook();
  const sheet = sheetOf(workbook, 'Follow-up', [['What', 26], ['Code', 9], ['Product', 30], ['Owner', 20], ['Item', 50], ['Date', 13], ['Days late (+) / left (-)', 14]], [6]);
  for (const i of f.items) sheet.addRow([FOLLOWUP_LABEL[i.kind], i.productCode, i.productName, i.ownerName ?? 'Not set', i.title, asDate(i.date), i.days]);
  sheet.getColumn(5).alignment = { wrapText: true, vertical: 'top' };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
