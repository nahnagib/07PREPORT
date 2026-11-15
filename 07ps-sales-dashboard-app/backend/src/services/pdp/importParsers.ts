import ExcelJS from 'exceljs';
import { readZipEntry } from './zip';
import type { ProductStatus } from './rules';

/**
 * Parsers for the CEO's three source files (the one-time import, importService.ts). Cell VALUES only: ExcelJS reads the
 * .xlsm as a ZIP of XML parts and never runs its VBA (vbaProject.bin is ignored); the .docx is read as XML.
 */

export interface Correction {
  sheet: string;
  cell: string;
  field: string;
  from: string;
  to: string;
}

export interface TreeRow {
  row: number;
  brand: string;
  family: string;
  subfamily: string;
  name: string;
  description: string | null;
  status: ProductStatus;
  launchDate: string | null;
  flexible: boolean;
  comment: string | null;
}

export interface Unplaced {
  sheet: string;
  row: number;
  reason: string;
}

// ---------------------------------------------------------------------------- spelling clean-up

/** Word fixes (the Product_Tree spellings that differ from Sheet1 / correct English). */
const WORD_FIXES: [RegExp, string][] = [
  [/\bWaterprooing\b/gi, 'Waterproofing'],
  [/\bMasonary\b/gi, 'Masonry'],
  [/\bSpecail\b/gi, 'Special'],
  [/\bChemcails\b/gi, 'Chemicals'],
  [/\bTerrazo\b/gi, 'Terrazzo'],
  [/\bHardner\b/gi, 'Hardener'],
  [/\bCementious\b/gi, 'Cementitious'],
];

/** Whole names written with the capitalisation agreed on 2026-11-14. */
const NAME_FIXES: Record<string, string> = {
  'putties & skimming': 'Putties & Skimming',
  'self leveling': 'Self Leveling',
  'gypsum putty': 'Gypsum Putty',
  'anchoring system': 'Anchoring System',
  'cementitious waterproofing': 'Cementitious Waterproofing',
};

function keepCase(match: string, fix: string): string {
  return match[0] === match[0].toLowerCase() ? fix.toLowerCase() : fix;
}

/** The cleaned name: spaces trimmed, "x& y" -> "x & y", the word fixes, then the agreed capitalisation. */
export function cleanName(raw: string): string {
  let s = raw.replace(/\s+/g, ' ').trim();
  s = s.replace(/\s*&\s*/g, ' & ');
  for (const [re, fix] of WORD_FIXES) s = s.replace(re, (m) => keepCase(m, fix));
  return NAME_FIXES[s.toLowerCase()] ?? s;
}

const STATUS_MAP: Record<string, ProductStatus> = {
  'in market': 'in_market',
  planned: 'planned',
  'under development': 'under_development',
  discontinued: 'discontinued',
};

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString();
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return String(v.text);
    if ('result' in v) return v.result === undefined || v.result === null ? '' : String(v.result);
  }
  return String(v);
}

function cellDate(v: ExcelJS.CellValue): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + v * 86400_000).toISOString().slice(0, 10);
  const s = cellText(v).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/**
 * Product_Tree.xlsm: the clean sheet `ورقة1` (header row 3, products from row 4; columns Brand, Family, Subfamily,
 * Product Name, Description, Status, Launching Date, comment) and the family descriptions in `Sheet1` F16:G24.
 * TreeNodes (a Power Query output) is not read: the app draws the tree from the data.
 */
export async function parseProductTree(buf: Buffer): Promise<{ rows: TreeRow[]; familyDescriptions: Map<string, string>; corrections: Correction[]; unplaced: Unplaced[]; sheet: string }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const isHeader = (ws: ExcelJS.Worksheet) => cellText(ws.getCell('A3').value).trim() === 'Product Brand' && cellText(ws.getCell('D3').value).trim() === 'Product Name';
  const ws = wb.getWorksheet('ورقة1') ?? wb.worksheets.find((w) => w.name !== 'TreeNodes' && isHeader(w));
  if (!ws || !isHeader(ws)) throw new Error('Product_Tree: the product sheet (ورقة1, header on row 3) was not found.');

  const corrections: Correction[] = [];
  const unplaced: Unplaced[] = [];
  const fix = (sheet: string, cell: string, field: string, raw: string) => {
    const clean = cleanName(raw);
    if (clean !== raw) corrections.push({ sheet, cell, field, from: raw, to: clean });
    return clean;
  };

  const out: TreeRow[] = [];
  for (let r = 4; r <= ws.rowCount; r += 1) {
    const row = ws.getRow(r);
    const raw = [1, 2, 3, 4, 5, 6, 7, 8].map((c) => row.getCell(c).value);
    const name = cellText(raw[3]);
    if (!name.trim() && !cellText(raw[1]).trim()) continue;
    const missing = ['Product Brand', 'Product Family', 'Product Subfamily', 'Product Name'].filter((_, i) => !cellText(raw[i]).trim());
    if (missing.length) {
      unplaced.push({ sheet: ws.name, row: r, reason: `missing ${missing.join(', ')}` });
      continue;
    }
    const statusRaw = cellText(raw[5]).trim();
    const status = STATUS_MAP[statusRaw.toLowerCase().replace(/\s+/g, ' ')];
    if (!status) {
      unplaced.push({ sheet: ws.name, row: r, reason: `unknown status "${statusRaw}"` });
      continue;
    }
    const comment = cellText(raw[7]).trim() || null;
    out.push({
      row: r,
      brand: fix(ws.name, `A${r}`, 'brand', cellText(raw[0])),
      family: fix(ws.name, `B${r}`, 'family', cellText(raw[1])),
      subfamily: fix(ws.name, `C${r}`, 'subfamily', cellText(raw[2])),
      name: fix(ws.name, `D${r}`, 'product', name),
      description: cellText(raw[4]).trim() || null,
      status,
      launchDate: cellDate(raw[6]),
      flexible: !!comment && /as market needs/i.test(comment),
      comment,
    });
  }

  const familyDescriptions = new Map<string, string>();
  const s1 = wb.getWorksheet('Sheet1');
  if (s1) {
    for (let r = 17; r <= 24; r += 1) {
      const fam = cellText(s1.getCell(`F${r}`).value);
      const desc = cellText(s1.getCell(`G${r}`).value).trim();
      if (fam.trim() && desc) familyDescriptions.set(fix('Sheet1', `F${r}`, 'family', fam).toLowerCase(), desc);
    }
  }
  return { rows: out, familyDescriptions, corrections, unplaced, sheet: ws.name };
}

// ---------------------------------------------------------------------------- scoring matrix

export interface MatrixCriterion {
  row: number;
  name: string;
  weight: number;
  meanings: string[];
}

/** Meaning texts out of the nested IF formula: IF(C2="","",IF(C2=0,"t0",IF(C2=1,"t1",...,"t5")))). */
export function meaningsFromFormula(formula: string): string[] {
  return [...formula.matchAll(/"([^"]*)"/g)].map((m) => m[1]).filter((s) => s !== '');
}

export async function parseScoringMatrix(buf: Buffer): Promise<{ criteria: MatrixCriterion[]; corrections: Correction[]; problems: string[] }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  const corrections: Correction[] = [];
  const problems: string[] = [];
  const criteria: MatrixCriterion[] = [];
  for (let r = 2; r <= ws.rowCount; r += 1) {
    const rawName = cellText(ws.getCell(`A${r}`).value);
    const weightCell = ws.getCell(`B${r}`).value;
    // Criterion rows have a numeric weight; the total row (A9:C9 merged, so B9 reads as its label) does not.
    if (!rawName.trim() || typeof weightCell !== 'number') continue;
    const name = rawName.replace(/\s+/g, ' ').trim();
    if (name !== rawName) corrections.push({ sheet: ws.name, cell: `A${r}`, field: 'criterion', from: rawName, to: name });
    const e = ws.getCell(`E${r}`).value;
    const formula = e && typeof e === 'object' && 'formula' in e ? String(e.formula) : '';
    const meanings = meaningsFromFormula(formula);
    if (meanings.length !== 6) problems.push(`${ws.name}!E${r}: expected 6 meaning texts in the IF formula, found ${meanings.length}`);
    criteria.push({ row: r, name, weight: weightCell, meanings });
  }
  const total = criteria.reduce((s, c) => s + c.weight, 0);
  if (total !== 100) problems.push(`weights add up to ${total}, not 100`);
  return { criteria, corrections, problems };
}

// ---------------------------------------------------------------------------- policy docx

export interface PolicySection {
  section_no: number;
  title: string;
  body: string;
}

function decodeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
}

/** R_D_Policy.docx: Heading 1 = the title; one section per Heading 2 ("1. Introduction"), its paragraphs = the body. */
export function parsePolicyDocx(buf: Buffer): { title: string; sections: PolicySection[] } {
  const xml = readZipEntry(buf, 'word/document.xml');
  if (!xml) throw new Error('R_D_Policy: word/document.xml is missing (not a .docx?).');
  const doc = xml.toString('utf8');
  let title = 'TIKA R&D Policy';
  const sections: PolicySection[] = [];
  for (const m of doc.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const p = m[0];
    const style = /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1] ?? '';
    const txt = decodeXml([...p.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((t) => t[1]).join('')).replace(/\u00a0/g, ' ').trim();
    if (!txt) continue;
    if (/^Heading1$|^Title$/i.test(style)) {
      title = txt;
    } else if (/^Heading2$/i.test(style)) {
      const h = /^(\d+)\.\s*(.+)$/.exec(txt);
      sections.push({ section_no: h ? Number(h[1]) : sections.length + 1, title: (h ? h[2] : txt).trim(), body: '' });
    } else if (sections.length) {
      const s = sections[sections.length - 1];
      s.body = s.body ? `${s.body}\n${txt}` : txt;
    }
  }
  return { title, sections };
}
