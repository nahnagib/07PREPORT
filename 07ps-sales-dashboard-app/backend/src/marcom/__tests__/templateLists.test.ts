import { describe, expect, it } from 'vitest';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { CAMPAIGN_STATUSES, EVENT_STATUSES, EVENT_TYPES, MEDIA_TYPES, MONTHS, PLATFORMS } from '../templateConfig';

const TEMPLATE = path.join(__dirname, '..', '..', '..', 'assets', 'marcom', 'MARCOM_Contribution_Data_Template.xlsx');

/** Drift guard: the template's hidden `Lists` sheet (the source of every dropdown) must match the
 * enums in templateConfig.ts -- and therefore the DB ENUM columns in migration 0022. */
describe('template Lists sheet vs templateConfig enums', async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE);
  const ws = wb.getWorksheet('Lists')!;

  const column = (header: string): string[] => {
    const headerRow = ws.getRow(1);
    let col = 0;
    headerRow.eachCell((cell, n) => { if (String(cell.value).trim() === header) col = n; });
    expect(col, `column "${header}" present in Lists`).toBeGreaterThan(0);
    const out: string[] = [];
    ws.eachRow((row, r) => {
      if (r === 1) return;
      const v = row.getCell(col).value;
      if (v !== null && v !== undefined && String(v).trim() !== '') out.push(String(v).trim());
    });
    return out;
  };

  it('is hidden', () => expect(ws.state).toBe('hidden'));
  it('Month', () => expect(column('Month')).toEqual([...MONTHS]));
  it('Platform', () => expect(column('Platform')).toEqual([...PLATFORMS]));
  it('OOH_Type', () => expect(column('OOH_Type')).toEqual([...MEDIA_TYPES]));
  it('Campaign_Status', () => expect(column('Campaign_Status')).toEqual([...CAMPAIGN_STATUSES]));
  it('Event_Type', () => expect(column('Event_Type')).toEqual([...EVENT_TYPES]));
  it('Event_Status', () => expect(column('Event_Status')).toEqual([...EVENT_STATUSES]));
  it('Brand list is the 4 placeholders (brands are data-driven, not enum-checked)', () => {
    expect(column('Brand')).toEqual(['Brand A', 'Brand B', 'Brand C', 'Brand D']);
  });
});

describe('migration 0022 ENUM columns vs templateConfig enums', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sql: string = require('node:fs').readFileSync(
    path.join(__dirname, '..', '..', '..', '..', 'data', 'warehouse', 'migrations', '0022_marcom_contribution.sql'), 'utf8');
  const enumOf = (column: string): string[] => {
    const m = new RegExp(String.raw`\b${column}\s+ENUM\(([^)]*)\)`).exec(sql);
    expect(m, `ENUM for ${column}`).not.toBeNull();
    return [...m![1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
  };
  it('media_type', () => expect(enumOf('media_type')).toEqual([...MEDIA_TYPES]));
  it('platform', () => expect(enumOf('platform')).toEqual([...PLATFORMS]));
  it('event_type', () => expect(enumOf('event_type')).toEqual([...EVENT_TYPES]));
  it('campaign + event status', () => {
    const all = [...sql.matchAll(/\bstatus\s+ENUM\(([^)]*)\)/g)].map((m) => [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]));
    expect(all).toContainEqual([...CAMPAIGN_STATUSES]);
    expect(all).toContainEqual([...EVENT_STATUSES]);
  });
});
