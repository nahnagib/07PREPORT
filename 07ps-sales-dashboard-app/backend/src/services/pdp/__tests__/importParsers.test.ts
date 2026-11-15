import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { cleanName, meaningsFromFormula, parsePolicyDocx, parseProductTree, parseScoringMatrix } from '../importParsers';
import { readZipEntry } from '../zip';
import { SEED_CRITERIA } from '../seedConfig';

/** The import parsers on generated fixtures; plus the CEO's real files when PDP_SOURCE_DIR points at them (local only). */

/** A minimal ZIP (stored entries) -- enough for a .docx fixture. */
function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const n = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const para = (style: string | null, text: string) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

describe('spelling clean-up', () => {
  it('fixes the agreed words and spacing, keeps correct names as they are', () => {
    expect(cleanName('Masonry& Repair Mortar')).toBe('Masonry & Repair Mortar');
    expect(cleanName('Masonary& Repair Mortar')).toBe('Masonry & Repair Mortar');
    expect(cleanName('putties& skimming')).toBe('Putties & Skimming');
    expect(cleanName('Cementious Renders')).toBe('Cementitious Renders');
    expect(cleanName('Floor Hardner')).toBe('Floor Hardener');
    expect(cleanName('Terrazo')).toBe('Terrazzo');
    expect(cleanName('Waterprooing')).toBe('Waterproofing');
    expect(cleanName('Specail Paints & Primer')).toBe('Special Paints & Primer');
    expect(cleanName('Specialty Construction Chemcails')).toBe('Specialty Construction Chemicals');
    expect(cleanName('self Leveling')).toBe('Self Leveling');
    expect(cleanName('Gypsum putty')).toBe('Gypsum Putty');
    expect(cleanName('Anchoring system')).toBe('Anchoring System');
    expect(cleanName('Cementitious waterproofing')).toBe('Cementitious Waterproofing');
    for (const ok of ['Tile Fixing', 'Special Paints & Primer', 'SuperCol S1', 'Silicone–Siloxane Primer', 'Gypsum Render']) expect(cleanName(ok)).toBe(ok);
  });
});

describe('Product_Tree parser', () => {
  async function workbook(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const tn = wb.addWorksheet('TreeNodes');
    tn.addRow(['Product Brand', 'Product Family', 'Product Subfamily', 'NodeText', 'Level']);
    tn.addRow(['Xtreme', 'Waterprooing', '', 'Waterprooing', 2]); // ignored: never read
    const ws = wb.addWorksheet('ورقة1');
    ws.getCell('A3').value = 'Product Brand';
    ws.getRow(3).values = ['Product Brand', 'Product Family', 'Product Subfamily', 'Product Name', 'Product Description', 'Product Status', 'Launching Date', 'comment'];
    ws.getRow(4).values = ['Xtreme', 'Masonry& Repair Mortar', 'Anchoring system', 'Epoxy Anchoring Adhesive', 'High-load anchoring', 'Planned', new Date(Date.UTC(2028, 0, 1)), null];
    ws.getRow(5).values = ['Xtreme', 'Flooring', 'Cementitious Flooring', 'Floor Hardner', 'Non metallic hardener', 'Planned', new Date(Date.UTC(2027, 0, 1)), 'As market needs'];
    ws.getRow(6).values = ['Xtreme', 'Tile Fixing', 'Tile Adhesive', 'XtraCol One', 'C1TE', 'In Market', new Date(Date.UTC(2023, 4, 1)), null];
    ws.getRow(7).values = ['Xtreme', 'Tile Fixing', 'Tile Adhesive', 'Ghost', 'x', 'Someday', new Date(Date.UTC(2027, 0, 1)), null];
    ws.getRow(8).values = ['Xtreme', 'Tile Fixing', '', 'No Subfamily', 'x', 'Planned', null, null];
    ws.getRow(9).values = ['Xtreme', 'Flooring', 'Cementitious Flooring', 'منتج تجريبي', 'وصف عربي', 'under Development', new Date(Date.UTC(2026, 3, 1)), null];
    const s1 = wb.addWorksheet('Sheet1');
    s1.getCell('F16').value = 'Product Family';
    s1.getCell('G16').value = 'Descrpition';
    s1.getCell('F17').value = 'Masonry & Repair Mortar';
    s1.getCell('G17').value = 'Products for masonry works.';
    s1.getCell('F18').value = 'Flooring';
    s1.getCell('G18').value = 'Solutions for floors.';
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it('reads ورقة1 (not TreeNodes), maps statuses, flags "As market needs", reports corrections and unplaced rows', async () => {
    const r = await parseProductTree(await workbook());
    expect(r.sheet).toBe('ورقة1');
    expect(r.rows.map((x) => [x.family, x.subfamily, x.name, x.status, x.launchDate, x.flexible])).toEqual([
      ['Masonry & Repair Mortar', 'Anchoring System', 'Epoxy Anchoring Adhesive', 'planned', '2028-01-01', false],
      ['Flooring', 'Cementitious Flooring', 'Floor Hardener', 'planned', '2027-01-01', true],
      ['Tile Fixing', 'Tile Adhesive', 'XtraCol One', 'in_market', '2023-05-01', false],
      ['Flooring', 'Cementitious Flooring', 'منتج تجريبي', 'under_development', '2026-04-01', false],
    ]);
    expect(r.rows[1].comment).toBe('As market needs');
    expect(r.corrections).toEqual([
      { sheet: 'ورقة1', cell: 'B4', field: 'family', from: 'Masonry& Repair Mortar', to: 'Masonry & Repair Mortar' },
      { sheet: 'ورقة1', cell: 'C4', field: 'subfamily', from: 'Anchoring system', to: 'Anchoring System' },
      { sheet: 'ورقة1', cell: 'D5', field: 'product', from: 'Floor Hardner', to: 'Floor Hardener' },
    ]);
    expect(r.unplaced).toEqual([
      { sheet: 'ورقة1', row: 7, reason: 'unknown status "Someday"' },
      { sheet: 'ورقة1', row: 8, reason: 'missing Product Subfamily' },
    ]);
    expect(r.familyDescriptions.get('masonry & repair mortar')).toBe('Products for masonry works.');
  });
});

describe('scoring matrix parser', () => {
  it('reads the meaning texts out of the nested IF formula', () => {
    expect(meaningsFromFormula('IF(C6="","",IF(C6=0,"Not urgent",IF(C6=1,"Low urgency",IF(C6=2,"Moderate urgency",IF(C6=3,"Needed this quarter",IF(C6=4,"High urgency","Immediate need for active project"))))))'))
      .toEqual(['Not urgent', 'Low urgency', 'Moderate urgency', 'Needed this quarter', 'High urgency', 'Immediate need for active project']);
  });
  it('a sheet like RD_Scoring_Matrix.xlsx: trims names, reports the trim, checks the weights', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('R&D Scoring Matrix');
    ws.addRow(['Criterion', 'Weight (%)', 'Score (0–5)', 'Weighted Score', 'Meaning', 'Evidence / Justification']);
    SEED_CRITERIA.forEach((c, i) => {
      const r = i + 2;
      const m = c.meanings;
      ws.getCell(`A${r}`).value = i === 3 ? `${c.name} ` : c.name;
      ws.getCell(`B${r}`).value = c.weight;
      ws.getCell(`D${r}`).value = { formula: `IF(C${r}="","",(C${r}*B${r})/5)`, result: '' } as ExcelJS.CellFormulaValue;
      ws.getCell(`E${r}`).value = { formula: `IF(C${r}="","",IF(C${r}=0,"${m[0]}",IF(C${r}=1,"${m[1]}",IF(C${r}=2,"${m[2]}",IF(C${r}=3,"${m[3]}",IF(C${r}=4,"${m[4]}","${m[5]}"))))))`, result: '' } as ExcelJS.CellFormulaValue;
    });
    ws.getCell('A9').value = 'Total Product Score (0–100)';
    const r = await parseScoringMatrix(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(r.problems).toEqual([]);
    expect(r.criteria.map((c) => [c.name, c.weight, c.meanings])).toEqual(SEED_CRITERIA.map((c) => [c.name, c.weight, c.meanings]));
    expect(r.corrections).toEqual([{ sheet: 'R&D Scoring Matrix', cell: 'A5', field: 'criterion', from: 'Development Difficulty ', to: 'Development Difficulty' }]);
  });
});

describe('policy docx parser', () => {
  it('one section per Heading 2, its paragraphs as the body; Heading 1 = title; XML entities decoded', () => {
    const body = para('Heading1', 'TIKA R&amp;D Policy ') + para('Heading2', '1. Introduction') + para(null, 'R&amp;D Policy defines how TIKA develops.')
      + para('Heading2', '19. R&amp;D Capacity Management') + para(null, '• Max 6 concurrent projects') + para(null, '• Monthly portfolio review') + para(null, '');
    const docx = zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': `<w:document><w:body>${body}</w:body></w:document>` });
    expect(readZipEntry(docx, 'word/document.xml')?.toString('utf8')).toContain('Introduction');
    expect(parsePolicyDocx(docx)).toEqual({
      title: 'TIKA R&D Policy',
      sections: [
        { section_no: 1, title: 'Introduction', body: 'R&D Policy defines how TIKA develops.' },
        { section_no: 19, title: 'R&D Capacity Management', body: '• Max 6 concurrent projects\n• Monthly portfolio review' },
      ],
    });
  });
  it('a file that is not a .docx is refused', () => {
    expect(() => parsePolicyDocx(Buffer.from('not a zip at all, just text padding padding'))).toThrow();
  });
});

// The real files (local only: PDP_SOURCE_DIR=...\Input\product_development).
const SRC = process.env.PDP_SOURCE_DIR;
describe.skipIf(!SRC || !existsSync(path.join(SRC ?? '', 'Product_Tree.xlsm')))('the CEO files', () => {
  it('Product_Tree.xlsm: 8 families, 20 subfamilies, 55 products (13 / 23 / 19), 16 "as market needs", 8 corrections', async () => {
    const r = await parseProductTree(readFileSync(path.join(SRC as string, 'Product_Tree.xlsm')));
    expect(new Set(r.rows.map((x) => x.family)).size).toBe(8);
    expect(new Set(r.rows.map((x) => `${x.family}|${x.subfamily}`)).size).toBe(20);
    expect(r.rows.length).toBe(55);
    const by = (s: string) => r.rows.filter((x) => x.status === s).length;
    expect([by('in_market'), by('planned'), by('under_development')]).toEqual([13, 23, 19]);
    expect(r.rows.filter((x) => x.flexible).length).toBe(16);
    expect(r.unplaced).toEqual([]);
    expect([...new Set(r.corrections.map((c) => `${c.from} -> ${c.to}`))].sort()).toEqual([
      'Anchoring system -> Anchoring System', 'Cementious Renders -> Cementitious Renders', 'Cementitious waterproofing -> Cementitious Waterproofing',
      'Floor Hardner -> Floor Hardener', 'Gypsum putty -> Gypsum Putty', 'Masonry& Repair Mortar -> Masonry & Repair Mortar',
      'putties& skimming -> Putties & Skimming', 'self Leveling -> Self Leveling',
    ]);
    expect(r.familyDescriptions.size).toBe(8);
  });
  it('RD_Scoring_Matrix.xlsx matches the brief (section 2.2)', async () => {
    const r = await parseScoringMatrix(readFileSync(path.join(SRC as string, 'RD_Scoring_Matrix.xlsx')));
    expect(r.problems).toEqual([]);
    expect(r.criteria.map((c) => [c.name, c.weight, c.meanings])).toEqual(SEED_CRITERIA.map((c) => [c.name, c.weight, c.meanings]));
  });
  it('R_D_Policy.docx: 21 sections, numbered 1..21', () => {
    const r = parsePolicyDocx(readFileSync(path.join(SRC as string, 'R_D_Policy.docx')));
    expect(r.sections.map((s) => s.section_no)).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
    expect(r.sections[19].title).toBe('KPIs');
  });
});
