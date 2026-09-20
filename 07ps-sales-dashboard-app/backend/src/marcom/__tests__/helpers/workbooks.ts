import path from 'node:path';
import ExcelJS from 'exceljs';

export const TEMPLATE = path.join(__dirname, '..', '..', '..', '..', 'assets', 'marcom', 'MARCOM_Contribution_Data_Template.xlsx');
export const P1 = 'P1 - MARCOM Spending';
export const P2 = 'P2 - Media Campaigns';
export const P3 = 'P3 - Digital Performance';
export const P4 = 'P4 - Trade Marketing';

export async function templateWb(): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE);
  return wb;
}
export const toBuf = async (wb: ExcelJS.Workbook) => Buffer.from(await wb.xlsx.writeBuffer());

export function setRow(ws: ExcelJS.Worksheet, row: number, v: (string | number | null)[]) {
  v.forEach((val, i) => { ws.getRow(row).getCell(i + 1).value = val; });
}

export interface MonthOpts { month: string; spend?: number; brands?: string[]; extraCampaign?: boolean }

/** A realistic single-month upload (rows 7+, i.e. not the green example rows). */
export async function monthFile(o: MonthOpts): Promise<Buffer> {
  const wb = await templateWb();
  const brands = o.brands ?? ['Brand A', 'Brand B'];
  const spend = o.spend ?? 10000;
  const p1 = wb.getWorksheet(P1)!;
  brands.forEach((b, i) => setRow(p1, 7 + i, [2026, o.month, b, spend + i * 1000, 40000, 500000, 400000, 12000, 20, 700, 1000, 500]));
  const p2 = wb.getWorksheet(P2)!;
  setRow(p2, 7, [`${o.month} Campaign`, brands[0], '2026-02-01', '2026-03-15', 'Ongoing', 5000, 20000]);
  setRow(p2, 31, [`${o.month} Campaign`, '1-Street Lights', 12, 900]);
  setRow(p2, 32, [`${o.month} Campaign`, '3-Billboards', 4, 1200]);
  const p3 = wb.getWorksheet(P3)!;
  setRow(p3, 7, [2026, o.month, 'Facebook', 1000, 50000, 2000, 300, 200]);
  setRow(p3, 8, [2026, o.month, 'TikTok', 800, 40000, 1500, 100, 400]);
  setRow(p3, 41, [2026, o.month, 100, 1000, 1200, 4000]);
  const p4 = wb.getWorksheet(P4)!;
  setRow(p4, 7, [2026, o.month, 0.92, null, 0.85, null, 0.95, null, 90, 100]);
  setRow(p4, 35, [`${o.month} Launch`, '6-Launch & Opening', brands[0], '2026-02-10', '2026-02-10', 'Completed']);
  return toBuf(wb);
}
