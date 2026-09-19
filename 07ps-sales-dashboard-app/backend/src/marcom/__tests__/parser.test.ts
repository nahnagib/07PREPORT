import { describe, expect, it } from 'vitest';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { parseMarcomWorkbook, parseDate, TemplateStructureError, type Issue } from '../parser';
import { SHEET_P1, SHEET_P2, SHEET_P3, SHEET_P4, TEMPLATE_VERSION } from '../templateConfig';

const TEMPLATE = path.join(__dirname, '..', '..', '..', 'assets', 'marcom', 'MARCOM_Contribution_Data_Template.xlsx');

async function template(): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE);
  return wb;
}
async function buf(wb: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const parse = (wb: ExcelJS.Workbook, opts = {}) => buf(wb).then((b) => parseMarcomWorkbook(b, 'x.xlsx', opts));
const errors = (r: { issues: Issue[] }) => r.issues.filter((i) => i.severity === 'error');
const warnings = (r: { issues: Issue[] }) => r.issues.filter((i) => i.severity === 'warning');

/** Put a real (non-green, yellow-styled) P1 row at `row`. */
function p1Row(ws: ExcelJS.Worksheet, row: number, v: (string | number)[]) {
  v.forEach((val, i) => { ws.getRow(row).getCell(i + 1).value = val; });
}
function setRow(ws: ExcelJS.Worksheet, row: number, v: (string | number | null)[]) {
  v.forEach((val, i) => { ws.getRow(row).getCell(i + 1).value = val; });
}
const P1_VALS = [2026, 'March', 'Brand B', 10000, 40000, 500000, 400000, 12000, 20, 700, 1000, 500];

describe('template as shipped', () => {
  it('imports 0 rows and reports 7 example rows skipped', async () => {
    const r = await parse(await template());
    expect(r.templateVersion).toBe(TEMPLATE_VERSION);
    for (const t of Object.values(r.tables)) expect(t.rows).toHaveLength(0);
    expect(r.exampleRowsSkipped).toBe(7);
    expect(errors(r)).toEqual([]);
  });

  it('includeExamples exposes the acceptance-test values', async () => {
    const r = await parse(await template(), { includeExamples: true });
    expect(errors(r)).toEqual([]);
    expect(r.tables.spend.rows[0].data).toMatchObject({
      year: 2026, month: 8, brand: 'Brand A', spend: 50000, revenueAttributed: 280000,
      companyRevenueCurrent: 1200000, companyRevenueLy: 1050000, budget: 55000, newCustomers: 120,
      avgInvoice: 900, socialPostCost: 8000, clicks: 3500,
    });
    expect(r.tables.campaigns.rows[0].data).toMatchObject({
      name: 'Ramadan Lighting Campaign', startDate: '2026-02-01', endDate: '2026-03-15', status: 'Completed', spend: 120000, revenueAttributed: 650000,
    });
    expect(r.tables.media.rows[0].data).toMatchObject({ mediaType: '1-Street Lights', units: 45, cost: 30000 });
    expect(r.tables.social.rows[0].data).toMatchObject({ platform: 'Instagram', followers: 52000, impressions: 180000, clicks: 9500, engagementPaid: 4200, engagementOrganic: 3100 });
    expect(r.tables.web.rows[0].data).toMatchObject({ bounceVisitors: 3400, totalVisitors: 12000, sessions: 15500, totalMinutes: 54250 });
    expect(r.tables.trade.rows[0].data).toMatchObject({ compliancePct: 0.94, giveawaysStockPct: 0.88, printedStockPct: 0.91, attendeesActual: 460, attendeesExpected: 500 });
    expect(r.tables.events.rows[0].data).toMatchObject({ name: 'Product Launch Night - Brand A', eventType: '6-Launch & Opening', plannedDate: '2026-08-10', status: 'Completed' });
  });
});

describe('example-row handling', () => {
  it('imports a green row whose values were overwritten, with a warning', async () => {
    const wb = await template();
    p1Row(wb.getWorksheet(SHEET_P1)!, 6, P1_VALS); // row 6 keeps its green fill
    const r = await parse(wb);
    expect(r.tables.spend.rows).toHaveLength(1);
    expect(r.tables.spend.rows[0].data.brand).toBe('Brand B');
    expect(r.exampleRowsSkipped).toBe(6);
    expect(warnings(r).some((w) => /example colour/.test(w.message))).toBe(true);
  });
});

describe('validation', () => {
  it('blocks a month typo, negative spend and End < Start with cell refs', async () => {
    const wb = await template();
    const p1 = wb.getWorksheet(SHEET_P1)!;
    p1Row(p1, 7, [2026, 'Agust', 'Brand A', -5, 1, 1, 1, 1, 1, 1, 1, 1]);
    const p2 = wb.getWorksheet(SHEET_P2)!;
    setRow(p2, 7, ['Camp X', 'Brand A', '2026-05-10', '2026-05-01', 'Ongoing', 100, 200]);
    const r = await parse(wb);
    const errs = errors(r);
    expect(errs.find((e) => e.sheet === SHEET_P1 && e.cell === 'B7')?.message).toMatch(/Agust/);
    expect(errs.find((e) => e.sheet === SHEET_P1 && e.cell === 'D7')?.message).toMatch(/negative/);
    expect(errs.find((e) => e.sheet === SHEET_P2 && e.cell === 'D7')?.message).toMatch(/before Start/);
  });

  it('accepts 94 as 94% with a warning and rejects > 100', async () => {
    const wb = await template();
    const ws = wb.getWorksheet(SHEET_P4)!;
    ws.getRow(7).getCell(1).value = 2026; ws.getRow(7).getCell(2).value = 'March';
    ws.getRow(7).getCell(3).value = 94; ws.getRow(7).getCell(5).value = 0.5; ws.getRow(7).getCell(7).value = 150;
    ws.getRow(7).getCell(9).value = 10; ws.getRow(7).getCell(10).value = 20;
    const r = await parse(wb);
    expect(r.tables.trade.rows[0].data.compliancePct).toBe(0.94);
    expect(warnings(r).some((w) => w.cell === 'C7')).toBe(true);
    expect(errors(r).some((e) => e.cell === 'G7')).toBe(true);
  });

  it('parses text DD/MM, ISO text and real dates to the same value', async () => {
    expect(parseDate('15/03/2026')).toBe('2026-03-15');
    expect(parseDate('2026-03-15')).toBe('2026-03-15');
    expect(parseDate(new Date(Date.UTC(2026, 2, 15)))).toBe('2026-03-15');
    expect(parseDate(46096)).toBe('2026-03-15'); // Excel serial
    expect(parseDate('03/04/2026')).toBe('2026-04-03'); // DD/MM, never MM/DD
    expect(parseDate('31/02/2026')).toBeNull();
  });

  it('flags duplicate keys, unknown campaigns in P2-B and accepts Arabic-Indic numerals', async () => {
    const wb = await template();
    const p1 = wb.getWorksheet(SHEET_P1)!;
    p1Row(p1, 7, P1_VALS);
    p1Row(p1, 8, [...P1_VALS.slice(0, 3), '١٢٬٥٠٠', ...P1_VALS.slice(4)]);
    setRow(wb.getWorksheet(SHEET_P2)!, 31, ['Ghost Campaign', '2-Mega Billboards', 3, 10]);
    const r = await parse(wb);
    const errs = errors(r);
    expect(errs.find((e) => e.cell === 'A8')?.message).toMatch(/Duplicate/);
    expect(errs.find((e) => e.sheet === SHEET_P2 && e.cell === 'A31')?.message).toMatch(/Ghost Campaign/);
    expect(r.tables.spend.rows[0].data.spend).toBe(10000);
  });

  it('accepts a P2-B row that references a stored campaign', async () => {
    const wb = await template();
    setRow(wb.getWorksheet(SHEET_P2)!, 31, ['Stored Campaign', '2-Mega Billboards', 3, 10]);
    const r = await parse(wb, { knownCampaigns: ['stored campaign'] });
    expect(errors(r)).toEqual([]);
    expect(r.tables.media.rows).toHaveLength(1);
  });

  it('warns on impossible ratios and new brands, without blocking', async () => {
    const wb = await template();
    setRow(wb.getWorksheet(SHEET_P3)!, 7, [2026, 'March', 'TikTok', 10, 100, 500, 400, 200]);
    setRow(wb.getWorksheet(SHEET_P4)!, 35, ['Some Event', '4-CSR', 'Brand Z', '2026-03-01', null, 'Planned']);
    const r = await parse(wb, { knownBrands: ['Brand A'] });
    expect(errors(r)).toEqual([]);
    const msgs = warnings(r).map((w) => w.message).join('|');
    expect(msgs).toMatch(/Clicks exceed impressions/);
    expect(msgs).toMatch(/engagement exceeds impressions/);
    expect(msgs).toMatch(/New brand "Brand Z"/);
  });

  it('warns when a typed formula has no cached value', async () => {
    const wb = await template();
    wb.getWorksheet(SHEET_P1)!.getCell('D7').value = { formula: '50000*1.1' } as never;
    p1Row(wb.getWorksheet(SHEET_P1)!, 7, P1_VALS.slice(0, 3));
    wb.getWorksheet(SHEET_P1)!.getCell('D7').value = { formula: '50000*1.1' } as never;
    const r = await parse(wb);
    expect(warnings(r).some((w) => /no calculated value/.test(w.message))).toBe(true);
  });
});

describe('structure', () => {
  it('rejects a renamed header with sheet + expected label', async () => {
    const wb = await template();
    wb.getWorksheet(SHEET_P1)!.getCell('D5').value = 'Spend';
    await expect(parse(wb)).rejects.toThrow(TemplateStructureError);
    await expect(parse(wb)).rejects.toThrow(/P1 - MARCOM Spending.*Total Marketing Spend/);
  });

  it('rejects a missing sheet', async () => {
    const wb = await template();
    wb.removeWorksheet(wb.getWorksheet(SHEET_P4)!.id);
    await expect(parse(wb)).rejects.toThrow(/P4 - Trade Marketing/);
  });

  it('still finds tables when the Director inserts a row above the header', async () => {
    const wb = await template();
    wb.getWorksheet(SHEET_P3)!.spliceRows(3, 0, ['inserted']);
    const r = await parse(wb, { includeExamples: true });
    expect(errors(r)).toEqual([]);
    expect(r.tables.social.rows).toHaveLength(1);
    expect(r.tables.web.rows).toHaveLength(1);
  });

  it('rejects non-xlsx names, bad signatures and empty files', async () => {
    const good = await buf(await template());
    await expect(parseMarcomWorkbook(good, 'a.xlsm')).rejects.toThrow(/\.xlsx/);
    await expect(parseMarcomWorkbook(Buffer.from('not a zip at all, sorry'), 'a.xlsx')).rejects.toThrow(/ZIP signature/);
    await expect(parseMarcomWorkbook(Buffer.alloc(0), 'a.xlsx')).rejects.toThrow(/empty/);
    await expect(parseMarcomWorkbook(Buffer.alloc(11 * 1024 * 1024), 'a.xlsx')).rejects.toThrow(/limit/);
  });
});
