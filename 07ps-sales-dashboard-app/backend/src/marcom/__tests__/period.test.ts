import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { parseMarcomWorkbook } from '../parser';
import { computePeriod, periodLabel } from '../service';
import { P2, P4, monthFile, setRow, templateWb, toBuf } from './helpers/workbooks';

describe('period covered', () => {
  it('labels ranges the way the upload screen shows them', () => {
    expect(periodLabel('2026-01', '2026-08')).toBe('January to August 2026');
    expect(periodLabel('2026-08', '2026-08')).toBe('August 2026');
    expect(periodLabel('2025-11', '2026-02')).toBe('November 2025 to February 2026');
  });

  it('comes from the month-keyed tables -- a campaign running into March does not stretch a February file', async () => {
    const r = await parseMarcomWorkbook(await monthFile({ month: 'February' }), 'f.xlsx');
    expect(computePeriod(r)?.label).toBe('February 2026');
  });

  it('falls back to campaign / event dates when the file has no month-keyed rows', async () => {
    const wb: ExcelJS.Workbook = await templateWb();
    setRow(wb.getWorksheet(P2)!, 7, ['Solo Campaign', 'Brand A', '2026-04-10', '2026-06-01', 'Planned', 1, 1]);
    setRow(wb.getWorksheet(P4)!, 35, ['Solo Event', '4-CSR', 'Brand A', '2026-05-02', null, 'Planned']);
    const r = await parseMarcomWorkbook(await toBuf(wb), 'f.xlsx');
    expect(computePeriod(r)?.label).toBe('April to June 2026');
  });

  it('is null for a blank template', async () => {
    expect(computePeriod(await parseMarcomWorkbook(await toBuf(await templateWb()), 'f.xlsx'))).toBeNull();
  });
});
