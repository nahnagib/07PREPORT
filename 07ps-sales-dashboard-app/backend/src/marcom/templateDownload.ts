import path from 'node:path';
import ExcelJS from 'exceljs';
import { pool } from '../db/pool';
import { MONTHS, PREFILL_PLATFORMS, SHEET_P3, TABLES } from './templateConfig';

export const TEMPLATE_FILE = path.join(__dirname, '..', '..', 'assets', 'marcom', 'MARCOM_Contribution_Data_Template.xlsx');

/** Rows Lists!A / Lists!I offer to the dropdowns (Lists!$A$2:$A$30, Lists!$I$2:$I$30 in the template). */
const LIST_ROWS = 29;

export interface TemplateLists {
  /** Brands first, then group entries (BMH), each alphabetical. */
  brands: { name: string; kind: 'BRAND' | 'GROUP' }[];
  categories: string[];
}

export async function loadTemplateLists(): Promise<TemplateLists> {
  const [[brands], [cats]] = await Promise.all([
    pool.query("SELECT name, kind FROM marcom_brand ORDER BY kind = 'GROUP', name"),
    pool.query('SELECT name FROM marcom_spend_category WHERE is_active = 1 ORDER BY sort_order, name'),
  ]);
  return {
    brands: (brands as { name: string; kind: string }[]).map((b) => ({ name: b.name, kind: b.kind === 'GROUP' ? 'GROUP' : 'BRAND' })),
    categories: (cats as { name: string }[]).map((c) => c.name),
  };
}

function writeList(ws: ExcelJS.Worksheet, col: number, values: string[]) {
  if (!values.length) return; // keep the template's own list
  for (let i = 0; i < LIST_ROWS; i++) ws.getRow(i + 2).getCell(col).value = values[i] ?? null;
}

/**
 * The template personalised at download time: the Brand / Category dropdowns come from the database (never a
 * hard-coded list), and P3 is pre-filled with every Year + Month + Brand (+ Facebook / Instagram) combination of
 * `year`, so the manager only types numbers. Pre-filled rows nobody typed into are skipped by the parser.
 */
export async function buildTemplate(year: number, lists: TemplateLists): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE_FILE);
  const listWs = wb.getWorksheet('Lists')!;
  writeList(listWs, 1, lists.brands.map((b) => b.name));
  writeList(listWs, 9, lists.categories);

  const brands = lists.brands.filter((b) => b.kind === 'BRAND').map((b) => b.name);
  if (brands.length) {
    const p3 = wb.getWorksheet(SHEET_P3)!;
    const social = TABLES.find((t) => t.id === 'social')!;
    const web = TABLES.find((t) => t.id === 'web')!;
    // Row header+1 is the green example row; pre-filled rows start below it.
    let r = social.headerRow + 2;
    for (const month of MONTHS) {
      for (const b of brands) {
        for (const p of PREFILL_PLATFORMS) {
          if (r > social.lastRow) break;
          p3.getRow(r).getCell(1).value = year;
          p3.getRow(r).getCell(2).value = month;
          p3.getRow(r).getCell(3).value = b;
          p3.getRow(r).getCell(4).value = p;
          r++;
        }
      }
    }
    r = web.headerRow + 2;
    for (const month of MONTHS) {
      for (const b of brands) {
        if (r > web.lastRow) break;
        p3.getRow(r).getCell(1).value = year;
        p3.getRow(r).getCell(2).value = month;
        p3.getRow(r).getCell(3).value = b;
        r++;
      }
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
