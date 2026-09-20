import path from 'node:path';
import ExcelJS from 'exceljs';
import { MONTHS, SHEET_P1, SHEET_P2, SHEET_P3, SHEET_P4 } from '../templateConfig';
import type { DemoDataset } from './demoData';

const TEMPLATE = path.join(__dirname, '..', '..', '..', 'assets', 'marcom', 'MARCOM_Contribution_Data_Template.xlsx');

export const DEMO_LABEL = 'DEMO SEED';

export interface DemoChunk {
  label: string;
  /** Upload filename -- always starts with DEMO_LABEL so the batches are recognisable and removable. */
  filename: string;
  buffer: Buffer;
  rows: number;
}

type Cell = string | number | null;

function put(ws: ExcelJS.Worksheet, row: number, values: Cell[]): void {
  values.forEach((v, i) => { ws.getRow(row).getCell(i + 1).value = v; });
}

/**
 * The template's P1/P3-A/P4-A tables have room for ~29 data rows (row 6 is the shipped example),
 * so the demo data is uploaded as several files, exactly like the Director would -- each one goes
 * through the normal validate -> commit path. Data rows start below the green example row.
 */
const CHUNKS: { label: string; year: number; months: [number, number]; withStatic: boolean }[] = [
  { label: '2025 Jan-Jul (backfill)', year: 2025, months: [1, 7], withStatic: false },
  { label: '2025 Aug-Dec (backfill)', year: 2025, months: [8, 12], withStatic: false },
  { label: '2026 Jan-Apr', year: 2026, months: [1, 4], withStatic: true },
  { label: '2026 May-Aug', year: 2026, months: [5, 8], withStatic: false },
];

export async function buildDemoWorkbooks(data: DemoDataset): Promise<DemoChunk[]> {
  const out: DemoChunk[] = [];
  for (const [i, c] of CHUNKS.entries()) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(TEMPLATE);
    const inMonths = <T extends { year: number; month: number }>(rows: T[]) => rows.filter((r) => r.year === c.year && r.month >= c.months[0] && r.month <= c.months[1]);
    let count = 0;

    const p1 = wb.getWorksheet(SHEET_P1)!;
    inMonths(data.spend).forEach((r, k) => {
      put(p1, 7 + k, [r.year, MONTHS[r.month - 1], r.brand, r.spend, r.revenue, r.companyCurrent, r.companyLy, r.budget, r.newCustomers, r.avgInvoice, r.socialPostCost, r.clicks]);
      count++;
    });

    const p3 = wb.getWorksheet(SHEET_P3)!;
    inMonths(data.social).forEach((r, k) => {
      put(p3, 7 + k, [r.year, MONTHS[r.month - 1], r.platform, r.followers, r.impressions, r.clicks, r.paid, r.organic]);
      count++;
    });
    inMonths(data.web).forEach((r, k) => {
      put(p3, 41 + k, [r.year, MONTHS[r.month - 1], r.bounce, r.totalVisitors, r.sessions, r.minutes]);
      count++;
    });

    const p4 = wb.getWorksheet(SHEET_P4)!;
    inMonths(data.trade).forEach((r, k) => {
      // C compliance, D/F/H are status formula columns (left alone), E giveaways, G printed, I/J attendees.
      const row = 7 + k;
      put(p4, row, [r.year, MONTHS[r.month - 1], Number(r.compliance)]);
      p4.getRow(row).getCell(5).value = Number(r.giveaways);
      p4.getRow(row).getCell(7).value = Number(r.printed);
      p4.getRow(row).getCell(9).value = Number(r.actual);
      p4.getRow(row).getCell(10).value = Number(r.expected);
      count++;
    });

    if (c.withStatic) {
      const p2 = wb.getWorksheet(SHEET_P2)!;
      data.campaigns.forEach((k, n) => { put(p2, 7 + n, [k.name, k.brand, k.start, k.end, k.status, k.spend, k.revenue]); count++; });
      data.media.forEach((k, n) => { put(p2, 31 + n, [k.campaignName, k.mediaType, k.units, k.cost]); count++; });
      data.events.forEach((e, n) => { put(p4, 35 + n, [e.name, e.type, e.brand, e.planned, e.completion, e.status]); count++; });
    }

    out.push({ label: c.label, filename: `${DEMO_LABEL} ${i + 1}-${CHUNKS.length} (${c.label}).xlsx`, buffer: Buffer.from(await wb.xlsx.writeBuffer()), rows: count });
  }
  return out;
}
