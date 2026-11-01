import { describe, expect, it } from 'vitest';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { parseMarcomWorkbook, parseDate, TemplateStructureError, type Issue } from '../parser';
import { SHEET_P1, SHEET_P1B, SHEET_P2, SHEET_P3, SHEET_P4, TEMPLATE_VERSION } from '../templateConfig';

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

function setRow(ws: ExcelJS.Worksheet, row: number, v: (string | number | null)[]) {
  v.forEach((val, i) => { ws.getRow(row).getCell(i + 1).value = val; });
}

/** Template 2.0 positions: first real row below each green example row. */
const P1_ROW = 15; // header 13, example 14
const P1B_ROW = 7; // header 5, example 6
const P3A_ROW = 7; // header 5, example 6
const P3B_ROW = 261; // header 259, example 260

// Year | Month | Brand | Brand Rev | Brand Rev LY | Attributed | Company Total | Budget | Booked | New Cust | Avg Invoice | Post Cost | Clicks
const P1_VALS: (string | number | null)[] = [2026, 'March', 'Brand B', 500000, 400000, 40000, 1500000, 12000, 10000, 20, 700, 1000, 500];
const p1 = (o: Record<number, string | number | null> = {}) => P1_VALS.map((v, i) => (i in o ? o[i] : v));

describe('template as shipped', () => {
  it('imports 0 rows and reports 8 example rows skipped', async () => {
    const r = await parse(await template());
    expect(r.templateVersion).toBe(TEMPLATE_VERSION);
    for (const t of Object.values(r.tables)) expect(t.rows).toHaveLength(0);
    expect(r.exampleRowsSkipped).toBe(8);
    expect(errors(r)).toEqual([]);
  });

  it('includeExamples exposes the acceptance-test values', async () => {
    const r = await parse(await template(), { includeExamples: true });
    expect(errors(r)).toEqual([]);
    expect(r.tables.spend.rows[0].data).toMatchObject({
      year: 2026, month: 9, brand: 'Xtreme', brandRevenueCurrent: 3000000, brandRevenueLy: 2600000, revenueAttributed: 450000,
      companyRevenueTotal: 8000000, budget: 120000, financeBookedTotal: null, newCustomers: 150, avgInvoice: 7500, socialPostCost: 500, clicks: 60000,
    });
    expect(r.tables.other.rows[0].data).toMatchObject({ year: 2026, month: 9, brand: 'Xtreme', category: 'Uniforms', amount: 25000, vendor: 'Al-Nour Textiles' });
    expect(r.tables.campaigns.rows[0].data).toMatchObject({
      name: 'Ramadan Lighting Campaign', startDate: '2026-02-01', endDate: '2026-03-15', status: 'Completed', spend: 120000, revenueAttributed: 650000,
    });
    expect(r.tables.media.rows[0].data).toMatchObject({ mediaType: '1-Street Lights', city: 'Tripoli', units: 45, cost: 30000 });
    expect(r.tables.social.rows[0].data).toMatchObject({ brand: 'Xtreme', platform: 'Instagram', accountName: 'Xtreme Libya IG', followers: 52000, impressions: 180000, clicks: 9500, engagementPaid: 4200, engagementOrganic: 3100 });
    expect(r.tables.web.rows[0].data).toMatchObject({ brand: 'Xtreme', bounceVisitors: 3400, totalVisitors: 12000, sessions: 15500, totalMinutes: 54250 });
    expect(r.tables.trade.rows[0].data).toMatchObject({ compliancePct: 0.94, giveawaysStockPct: 0.88, printedStockPct: 0.91, attendeesActual: 460, attendeesExpected: 500 });
    expect(r.tables.events.rows[0].data).toMatchObject({ name: 'Product Launch Night - Brand A', eventType: '6-Launch & Opening', plannedDate: '2026-08-10', status: 'Completed' });
  });
});

describe('example-row handling', () => {
  it('imports a green row whose values were overwritten, with a warning', async () => {
    const wb = await template();
    setRow(wb.getWorksheet(SHEET_P1)!, 14, P1_VALS); // row 14 keeps its green fill
    const r = await parse(wb);
    expect(r.tables.spend.rows).toHaveLength(1);
    expect(r.tables.spend.rows[0].data.brand).toBe('Brand B');
    expect(r.exampleRowsSkipped).toBe(7);
    expect(warnings(r).some((w) => /example colour/.test(w.message))).toBe(true);
  });
});

describe('validation', () => {
  it('blocks a month typo, negative revenue and End < Start with cell refs', async () => {
    const wb = await template();
    setRow(wb.getWorksheet(SHEET_P1)!, P1_ROW, p1({ 1: 'Agust', 2: 'Brand A', 3: -5 }));
    setRow(wb.getWorksheet(SHEET_P2)!, 7, ['Camp X', 'Brand A', '2026-05-10', '2026-05-01', 'Ongoing', 100, 200]);
    const r = await parse(wb);
    const errs = errors(r);
    expect(errs.find((e) => e.sheet === SHEET_P1 && e.cell === `B${P1_ROW}`)?.message).toMatch(/Agust/);
    expect(errs.find((e) => e.sheet === SHEET_P1 && e.cell === `D${P1_ROW}`)?.message).toMatch(/negative/);
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
    setRow(wb.getWorksheet(SHEET_P1)!, P1_ROW, P1_VALS);
    setRow(wb.getWorksheet(SHEET_P1)!, P1_ROW + 1, p1({ 3: '١٢٬٥٠٠', 5: 100 }));
    setRow(wb.getWorksheet(SHEET_P2)!, 31, ['Ghost Campaign', '2-Mega Billboards', 'Tripoli', 3, 10]);
    const r = await parse(wb);
    const errs = errors(r);
    expect(errs.find((e) => e.cell === `A${P1_ROW + 1}`)?.message).toMatch(/Duplicate/);
    expect(errs.find((e) => e.sheet === SHEET_P2 && e.cell === 'A31')?.message).toMatch(/Ghost Campaign/);
    expect(r.tables.spend.rows[1].data.brandRevenueCurrent).toBe(12500);
  });

  it('accepts a P2-B row that references a stored campaign', async () => {
    const wb = await template();
    setRow(wb.getWorksheet(SHEET_P2)!, 31, ['Stored Campaign', '2-Mega Billboards', 'Misrata', 3, 10]);
    const r = await parse(wb, { knownCampaigns: ['stored campaign'] });
    expect(errors(r)).toEqual([]);
    expect(r.tables.media.rows).toHaveLength(1);
  });

  it('warns on impossible ratios and new brands, without blocking', async () => {
    const wb = await template();
    setRow(wb.getWorksheet(SHEET_P3)!, P3A_ROW, [2026, 'March', 'Brand A', 'TikTok', null, 10, 100, 500, 400, 200]);
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
    setRow(wb.getWorksheet(SHEET_P1)!, P1_ROW, P1_VALS);
    wb.getWorksheet(SHEET_P1)!.getCell(`H${P1_ROW}`).value = { formula: '50000*1.1' } as never;
    const r = await parse(wb);
    expect(warnings(r).some((w) => /no calculated value/.test(w.message))).toBe(true);
  });

  it('reads numbers typed as text with line breaks (the 1.x "clipped impressions")', async () => {
    const wb = await template();
    setRow(wb.getWorksheet(SHEET_P3)!, P3A_ROW, [2026, 'February', 'Brand A', 'Facebook', null, 164, '2100000\n', '11500', 0, 0]);
    const r = await parse(wb);
    expect(errors(r)).toEqual([]);
    expect(r.tables.social.rows[0].data).toMatchObject({ impressions: 2100000, clicks: 11500, accountName: '' });
  });
});

describe('P1 brand-level revenue (template 2.0)', () => {
  it('requires the three brand revenue inputs for a brand', async () => {
    const wb = await template();
    setRow(wb.getWorksheet(SHEET_P1)!, P1_ROW, p1({ 3: null, 4: null, 5: null }));
    const r = await parse(wb);
    const missing = errors(r).filter((e) => e.code === 'REQUIRED_MISSING');
    expect(missing.map((e) => e.cell)).toEqual([`D${P1_ROW}`, `E${P1_ROW}`, `F${P1_ROW}`]);
    expect(missing[0].message).toMatch(/never YTD/);
  });

  it('lets a group entry (BMH = group events) leave revenue empty', async () => {
    const wb = await template();
    setRow(wb.getWorksheet(SHEET_P1)!, P1_ROW, p1({ 2: 'BMH', 3: null, 4: null, 5: null, 6: null }));
    const r = await parse(wb, { groupBrands: ['BMH'] });
    expect(errors(r)).toEqual([]);
    expect(r.tables.spend.rows[0].data).toMatchObject({ brand: 'BMH', brandRevenueCurrent: null, revenueAttributed: null });
  });

  it('blocks attributed > brand revenue and brand revenue > company total; optional columns may stay empty', async () => {
    const wb = await template();
    setRow(wb.getWorksheet(SHEET_P1)!, P1_ROW, p1({ 5: 600000 }));
    setRow(wb.getWorksheet(SHEET_P1)!, P1_ROW + 1, p1({ 1: 'April', 3: 2000000 }));
    setRow(wb.getWorksheet(SHEET_P1)!, P1_ROW + 2, p1({ 1: 'May', 6: null, 8: null }));
    const r = await parse(wb);
    expect(errors(r).find((e) => e.cell === `F${P1_ROW}`)?.code).toBe('ATTRIBUTED_GT_BRAND_REVENUE');
    expect(errors(r).find((e) => e.cell === `D${P1_ROW + 1}`)?.code).toBe('BRAND_REVENUE_GT_COMPANY');
    expect(errors(r).filter((e) => e.cell.endsWith(String(P1_ROW + 2)))).toEqual([]);
    expect(r.tables.spend.rows[2].data).toMatchObject({ companyRevenueTotal: null, financeBookedTotal: null });
  });

  it('warns when brand revenue equals the company total (company total typed as brand revenue)', async () => {
    const wb = await template();
    setRow(wb.getWorksheet(SHEET_P1)!, P1_ROW, p1({ 3: 1500000 }));
    const r = await parse(wb);
    expect(warnings(r).find((w) => w.cell === `D${P1_ROW}`)?.code).toBe('BRAND_REVENUE_EQUALS_COMPANY');
  });

  it('flags the issues seen in the 1.x file: a 10x typo, values copied across brands, one budget in every row', async () => {
    const wb = await template();
    const ws = wb.getWorksheet(SHEET_P1)!;
    const months = ['January', 'February', 'March', 'April', 'May', 'June'];
    const company = [10300000, 10800000, 79000000, 19800000, 16300000, 12500000];
    const ly = [8700000, 7700000, 3100000, 2700000, 8600000, 8400000];
    months.forEach((m, i) => {
      setRow(ws, P1_ROW + i, [2026, m, 'Xtreme', 3000000 + i, ly[i], 100000, 9000000 + i * 100, 162.25, null, 10, 700, 100, 50]);
      setRow(ws, P1_ROW + 6 + i, [2026, m, 'Majaal', 2000000 + i, ly[i], 100000, company[i], 162.25, null, 10, 700, 100, 50]);
    });
    const r = await parse(wb);
    expect(errors(r)).toEqual([]);
    const w = warnings(r);
    const typo = w.find((x) => x.code === 'OUTLIER_VS_MEDIAN');
    expect(typo).toMatchObject({ cell: `G${P1_ROW + 8}` });
    expect(typo!.message).toMatch(/79,000,000/);
    const copied = w.find((x) => x.code === 'COPIED_ACROSS_BRANDS');
    expect(copied).toMatchObject({ cell: `E${P1_ROW + 6}` });
    expect(copied!.message).toMatch(/Majaal.*identical to Xtreme/);
    expect(w.filter((x) => x.code === 'SAME_VALUE_EVERY_ROW').map((x) => x.message).join('|')).toMatch(/Budget Allocated is 162\.25 in every row \(12 rows\)/);
  });
});

describe('P1b other spend', () => {
  it('imports expense lines; an unknown category is an error', async () => {
    const wb = await template();
    const ws = wb.getWorksheet(SHEET_P1B)!;
    setRow(ws, P1B_ROW, [2026, 'March', 'Brand A', 'printing & printouts', 'Flyers', null, 4000, null]);
    setRow(ws, P1B_ROW + 1, [2026, 'March', 'Brand A', 'Fireworks', 'Show', null, 9000, null]);
    const r = await parse(wb);
    expect(r.tables.other.rows[0].data).toMatchObject({ category: 'Printing & Printouts', description: 'Flyers', amount: 4000, vendor: null });
    expect(errors(r).find((e) => e.cell === `D${P1B_ROW + 1}`)?.code).toBe('INVALID_CATEGORY');
  });

  it('uses the category list from the database when given', async () => {
    const wb = await template();
    setRow(wb.getWorksheet(SHEET_P1B)!, P1B_ROW, [2026, 'March', 'Brand A', 'Fireworks', 'Show', null, 9000, null]);
    const r = await parse(wb, { knownCategories: ['Fireworks'] });
    expect(errors(r).map((e) => e.message)).toEqual([]);
  });

  it('rejects a duplicate line (same month, brand, category and description)', async () => {
    const wb = await template();
    const ws = wb.getWorksheet(SHEET_P1B)!;
    setRow(ws, P1B_ROW, [2026, 'March', 'Brand A', 'Uniforms', 'Shirts', null, 100, null]);
    setRow(ws, P1B_ROW + 1, [2026, 'March', 'Brand A', 'Uniforms', 'shirts', null, 200, null]);
    const r = await parse(wb);
    expect(errors(r).find((e) => e.cell === `A${P1B_ROW + 1}`)?.code).toBe('DUPLICATE_KEY');
  });
});

describe('P3 per brand', () => {
  it('requires a brand on social and web rows', async () => {
    const wb = await template();
    const ws = wb.getWorksheet(SHEET_P3)!;
    setRow(ws, P3A_ROW, [2026, 'March', null, 'Facebook', null, 10, 100, 5, 1, 1]);
    setRow(ws, P3B_ROW, [2026, 'March', null, 10, 100, 120, 300]);
    const r = await parse(wb);
    expect(errors(r).find((e) => e.cell === `C${P3A_ROW}`)?.code).toBe('REQUIRED_MISSING');
    expect(errors(r).find((e) => e.cell === `C${P3B_ROW}`)?.code).toBe('REQUIRED_MISSING');
  });

  it('rejects the same Year + Month + Brand + Platform twice, but allows two named pages', async () => {
    const wb = await template();
    const ws = wb.getWorksheet(SHEET_P3)!;
    setRow(ws, P3A_ROW, [2026, 'March', 'Xtreme', 'Facebook', null, 10, 100, 5, 1, 1]);
    setRow(ws, P3A_ROW + 1, [2026, 'March', 'Xtreme', 'Facebook', null, 11, 100, 5, 1, 1]);
    setRow(ws, P3A_ROW + 2, [2026, 'March', 'Xtreme', 'Instagram', 'Xtreme Libya IG', 10, 100, 5, 1, 1]);
    setRow(ws, P3A_ROW + 3, [2026, 'March', 'Xtreme', 'Instagram', 'Xtreme Benghazi IG', 10, 100, 5, 1, 1]);
    setRow(ws, P3A_ROW + 4, [2026, 'March', 'Majaal', 'Facebook', null, 10, 100, 5, 1, 1]);
    const r = await parse(wb);
    expect(errors(r).map((e) => [e.cell, e.code])).toEqual([[`A${P3A_ROW + 1}`, 'DUPLICATE_KEY']]);
  });

  it('skips pre-filled rows (Year/Month/Brand/Platform only) without errors', async () => {
    const wb = await template();
    const ws = wb.getWorksheet(SHEET_P3)!;
    setRow(ws, P3A_ROW, [2026, 'April', 'Xtreme', 'Facebook']);
    setRow(ws, P3A_ROW + 1, [2026, 'April', 'Xtreme', 'Instagram', null, 10, 100, 5, 1, 1]);
    setRow(ws, P3B_ROW, [2026, 'April', 'Xtreme']);
    const r = await parse(wb);
    expect(errors(r)).toEqual([]);
    expect(r.tables.social.rows).toHaveLength(1);
    expect(r.tables.web.rows).toHaveLength(0);
  });
});

describe('structure', () => {
  it('rejects a renamed header with sheet + expected label', async () => {
    const wb = await template();
    wb.getWorksheet(SHEET_P1)!.getCell('D13').value = 'Spend';
    await expect(parse(wb)).rejects.toThrow(TemplateStructureError);
    await expect(parse(wb)).rejects.toThrow(/P1 - MARCOM Spending.*Brand Revenue - Current Month/);
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
