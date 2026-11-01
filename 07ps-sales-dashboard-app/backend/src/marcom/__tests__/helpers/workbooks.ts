import path from 'node:path';
import ExcelJS from 'exceljs';

export const TEMPLATE = path.join(__dirname, '..', '..', '..', '..', 'assets', 'marcom', 'MARCOM_Contribution_Data_Template.xlsx');
export const P1 = 'P1 - MARCOM Spending';
export const P1B = 'P1b - Other MARCOM Spending';
export const P2 = 'P2 - Media Campaigns';
export const P3 = 'P3 - Digital Performance';
export const P4 = 'P4 - Trade Marketing';

/** First real row below each green example row (template 2.0). */
export const ROW = { p1: 15, p1b: 7, p2a: 7, p2b: 31, p3a: 7, p3b: 261, p4a: 7, p4b: 35 } as const;

export async function templateWb(): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE);
  return wb;
}
export const toBuf = async (wb: ExcelJS.Workbook) => Buffer.from(await wb.xlsx.writeBuffer());

export function setRow(ws: ExcelJS.Worksheet, row: number, v: (string | number | null)[]) {
  v.forEach((val, i) => { ws.getRow(row).getCell(i + 1).value = val; });
}

/**
 * A P1 row (template 2.0): Year | Month | Brand | Brand Rev | Brand Rev LY | Attributed | Company Total | Budget |
 * Finance Booked | New Cust | Avg Invoice | Post Cost | Clicks. `booked` is the value tests vary to force an update.
 */
export const p1Row = (year: number, month: string, brand: string, booked: number): (string | number)[] =>
  [year, month, brand, 500000, 400000, 40000, 1500000, 12000, booked, 20, 700, 1000, 500];

export interface MonthOpts { month: string; spend?: number; brands?: string[]; extraCampaign?: boolean }

/** A realistic single-month upload (real rows, not the green example rows). `spend` = the Finance Booked Total. */
export async function monthFile(o: MonthOpts): Promise<Buffer> {
  const wb = await templateWb();
  const brands = o.brands ?? ['Brand A', 'Brand B'];
  const spend = o.spend ?? 10000;
  const p1 = wb.getWorksheet(P1)!;
  brands.forEach((b, i) => setRow(p1, ROW.p1 + i, p1Row(2026, o.month, b, spend + i * 1000)));
  setRow(wb.getWorksheet(P1B)!, ROW.p1b, [2026, o.month, brands[0], 'Printing & Printouts', `${o.month} flyers`, null, 2500, null]);
  const p2 = wb.getWorksheet(P2)!;
  setRow(p2, ROW.p2a, [`${o.month} Campaign`, brands[0], '2026-02-01', '2026-03-15', 'Ongoing', 5000, 20000]);
  setRow(p2, ROW.p2b, [`${o.month} Campaign`, '1-Street Lights', 'Tripoli', 12, 900]);
  setRow(p2, ROW.p2b + 1, [`${o.month} Campaign`, '3-Billboards', 'Benghazi', 4, 1200]);
  const p3 = wb.getWorksheet(P3)!;
  setRow(p3, ROW.p3a, [2026, o.month, brands[0], 'Facebook', null, 1000, 50000, 2000, 300, 200]);
  setRow(p3, ROW.p3a + 1, [2026, o.month, brands[0], 'TikTok', null, 800, 40000, 1500, 100, 400]);
  setRow(p3, ROW.p3b, [2026, o.month, brands[0], 100, 1000, 1200, 4000]);
  const p4 = wb.getWorksheet(P4)!;
  setRow(p4, ROW.p4a, [2026, o.month, 0.92, null, 0.85, null, 0.95, null, 90, 100]);
  setRow(p4, ROW.p4b, [`${o.month} Launch`, '6-Launch & Opening', brands[0], '2026-02-10', '2026-02-10', 'Completed']);
  return toBuf(wb);
}

/**
 * The acceptance-test data set placed in REAL rows. August spend is 50,000 of non-campaign spend (the campaign runs
 * Feb-Mar), so Total MARCOM Spend for August = 50,000 and the golden KPI values (ROI 1 : 5.6 ...) are unchanged.
 */
export async function goldenFile(): Promise<Buffer> {
  const wb = await templateWb();
  setRow(wb.getWorksheet(P1)!, ROW.p1, [2026, 'August', 'Brand A', 1200000, 1050000, 280000, null, 55000, null, 120, 900, 8000, 3500]);
  setRow(wb.getWorksheet(P1B)!, ROW.p1b, [2026, 'August', 'Brand A', 'Events & Sponsorships', 'Golden sponsorship', null, 50000, null]);
  setRow(wb.getWorksheet(P2)!, ROW.p2a, ['Ramadan Lighting Campaign', 'Brand A', '2026-02-01', '2026-03-15', 'Completed', 120000, 650000]);
  setRow(wb.getWorksheet(P2)!, ROW.p2b, ['Ramadan Lighting Campaign', '1-Street Lights', 'Tripoli', 45, 30000]);
  setRow(wb.getWorksheet(P3)!, ROW.p3a, [2026, 'August', 'Brand A', 'Instagram', null, 52000, 180000, 9500, 4200, 3100]);
  setRow(wb.getWorksheet(P3)!, ROW.p3b, [2026, 'August', 'Brand A', 3400, 12000, 15500, 54250]);
  setRow(wb.getWorksheet(P4)!, ROW.p4a, [2026, 'August', 0.94, null, 0.88, null, 0.91, null, 460, 500]);
  setRow(wb.getWorksheet(P4)!, ROW.p4b, ['Product Launch Night - Brand A', '6-Launch & Opening', 'Brand A', '2026-08-10', '2026-08-10', 'Completed']);
  return toBuf(wb);
}

/** P1 rows (13 columns, see p1Row) and optional P1b lines; other sheets untouched. */
export async function spendFile(rows: (string | number | null)[][], other: (string | number | null)[][] = []): Promise<Buffer> {
  const wb = await templateWb();
  rows.forEach((r, i) => setRow(wb.getWorksheet(P1)!, ROW.p1 + i, r));
  other.forEach((r, i) => setRow(wb.getWorksheet(P1B)!, ROW.p1b + i, r));
  return toBuf(wb);
}
