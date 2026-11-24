import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { describe, expect, it, vi } from 'vitest';

// parseWorkbook needs no database; the pool module is replaced so importing the service never connects.
vi.mock('../../../db/pool', () => ({ pool: {} }));

import { parseWorkbook } from '../importService';
import { familyStageMatrix, STAGES, type Product } from '../rules';

/**
 * The Excel import's parsing and row validation (services/pdt/importService.ts), without a database:
 *   - the file as delivered (Input/product_development, git-ignored: skipped where it is absent) parses with no error and
 *     gives the "Where we stand" counts: Idea 23, Development 19, Launched 13, total 55;
 *   - small workbooks built here check every validation error and the value normalisation.
 */

const DELIVERED = path.resolve(__dirname, '../../../../../../Input/product_development/Product_Development_Input.xlsx');

const PRODUCT_HEADERS = ['Code', 'Product name', 'Family', 'Subfamily', 'Description', 'Pipeline stage', 'Health', 'Priority', 'Owner', 'Readiness %', 'Target launch date', 'Actual launch date', 'Project type', 'Next step', 'Next step due', 'Comment', 'Last updated', 'Updated by', 'Days to launch', 'Flag'];
const UPDATE_HEADERS = ['Update date', 'Product code', 'Product name (auto)', 'Health', 'Readiness %', 'Progress summary', 'Next step', 'Next step due', 'Updated by'];
const BLOCKER_HEADERS = ['ID', 'Product code', 'Product name (auto)', 'Type', 'Title', 'Required action / decision', 'Owner', 'Raised on', 'Due date', 'Status', 'Resolution note', 'Resolved date', 'Overdue? (auto)'];

async function book(sheets: { products?: unknown[][]; updates?: unknown[][]; blockers?: unknown[][]; productHeaders?: string[] }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Read me').addRow(['ignored']);
  wb.addWorksheet('Where we stand').addRow(['ignored']);
  const add = (name: string, headers: string[], data: unknown[][] = []) => {
    const ws = wb.addWorksheet(name);
    ws.addRow(headers);
    for (const r of data) ws.addRow(r);
  };
  add('Products', sheets.productHeaders ?? PRODUCT_HEADERS, sheets.products);
  add('Status updates', UPDATE_HEADERS, sheets.updates);
  add('Blockers & decisions', BLOCKER_HEADERS, sheets.blockers);
  const lists = wb.addWorksheet('Lists');
  lists.addRow(['Stage', 'Health', 'Priority', 'Project type', 'Blocker type', 'Blocker status', 'Owners (type names)', 'Product family', 'Family description']);
  lists.addRow(['Idea', 'On track', 'High', 'Planned', 'Blocker', 'Open', 'Omar Ali', 'Tile Fixing', 'Tiles']);
  lists.addRow(['Research', 'At risk', 'Medium', 'Unplanned', 'Decision needed', 'In progress', null, 'Waterproofing', 'Water']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
// Code, name, family, subfamily, description, stage, health, priority, owner, readiness, target, actual, project type, next step, next due, comment, last updated, updated by
const row = (over: Partial<Record<number, unknown>> = {}): unknown[] => {
  const base: unknown[] = ['XT-001', 'MonoSeal', 'Waterproofing', 'Cementitious waterproofing', 'desc', 'Testing', 'At risk', 'High', 'Omar Ali', 0.7, d('2027-03-01'), null, 'Planned', 'Field trial', d('2026-12-10'), null, d('2026-11-18'), 'Omar Ali', 100, 'formula'];
  for (const [k, v] of Object.entries(over)) base[Number(k)] = v;
  return base;
};
const codes = (errs: { field: string; code: string }[]) => errs.map((e) => `${e.field}:${e.code}`);

describe.skipIf(!existsSync(DELIVERED))('the file as delivered', () => {
  it('parses 55 products with no error and gives the "Where we stand" counts (Idea 23, Development 19, Launched 13)', async () => {
    const parsed = await parseWorkbook(readFileSync(DELIVERED));
    expect(parsed.errors).toEqual([]);
    expect(parsed.products).toHaveLength(55);
    expect(parsed.families.map((f) => f.name)).toHaveLength(8);
    expect(parsed.updates).toEqual([]);
    expect(parsed.blockers).toEqual([]);
    const fam = new Map(parsed.families.map((f, i) => [f.name, i + 1]));
    const asProducts = parsed.products.map((p, i) => ({ productId: i + 1, code: p.code, familyId: fam.get(p.family!) ?? null, family: p.family, stage: p.stage }) as unknown as Product);
    const m = familyStageMatrix(asProducts, parsed.families.map((f) => ({ familyId: fam.get(f.name)!, family: f.name })));
    expect(m.totals).toEqual({ IDEA: 23, RESEARCH: 0, DEVELOPMENT: 19, TESTING: 0, LAUNCH_READY: 0, LAUNCHED: 13 });
    expect(m.total).toBe(55);
    expect(m.rows.reduce((n, r) => n + r.total, 0)).toBe(55);
    // Excel % cells (1 = 100%) for launched products; blanks stay "not set".
    const launched = parsed.products.filter((p) => p.stage === 'LAUNCHED');
    expect(launched.every((p) => p.readinessPct === 100 && p.actualLaunch !== null)).toBe(true);
    expect(parsed.products.filter((p) => p.health === null)).toHaveLength(42);
    // Brand (column U, after Flag): blank until the business fills it in.
    expect(parsed.products.every((p) => p.brand === 'Unassigned')).toBe(true);
  });
});

describe('Brand (optional column, read by header name)', () => {
  it('reads Brand wherever the column is, trimmed; blank = Unassigned', async () => {
    const parsed = await parseWorkbook(await book({
      productHeaders: [...PRODUCT_HEADERS, 'Brand'],
      products: [[...row(), '  Xtreme '], [...row({ 0: 'XT-002', 1: 'Second' }), null], [...row({ 0: 'XT-003', 1: 'Third' }), '']],
    }));
    expect(parsed.errors).toEqual([]);
    expect(parsed.products.map((p) => p.brand)).toEqual(['Xtreme', 'Unassigned', 'Unassigned']);
    const moved = await parseWorkbook(await book({ productHeaders: ['Brand', ...PRODUCT_HEADERS], products: [['Tika', ...row()]] }));
    expect(moved.errors).toEqual([]);
    expect(moved.products[0]).toMatchObject({ code: 'XT-001', brand: 'Tika', stage: 'TESTING' });
  });
  it('accepts an older file with no Brand column: every product is Unassigned', async () => {
    const parsed = await parseWorkbook(await book({ products: [row(), row({ 0: 'XT-002', 1: 'Second' })] }));
    expect(parsed.errors).toEqual([]);
    expect(parsed.products.map((p) => p.brand)).toEqual(['Unassigned', 'Unassigned']);
  });
  it('refuses a brand longer than 100 characters', async () => {
    const parsed = await parseWorkbook(await book({ productHeaders: [...PRODUCT_HEADERS, 'Brand'], products: [[...row(), 'B'.repeat(101)]] }));
    expect(codes(parsed.errors)).toEqual(['Brand:text.tooLong']);
  });
});

describe('row validation', () => {
  it('reads a correct row, normalising readiness and dates', async () => {
    const parsed = await parseWorkbook(await book({ products: [row(), row({ 0: 'xt-002', 1: 'Second', 9: '45%', 10: '15/12/2026', 5: 'launch READY' })] }));
    expect(parsed.errors).toEqual([]);
    expect(parsed.products[0]).toMatchObject({ code: 'XT-001', stage: 'TESTING', health: 'AT_RISK', priority: 'HIGH', readinessPct: 70, targetLaunch: '2027-03-01', nextStepDue: '2026-12-10', projectType: 'PLANNED', lastEditedOn: '2026-11-18' });
    expect(parsed.products[1]).toMatchObject({ code: 'XT-002', stage: 'LAUNCH_READY', readinessPct: 45, targetLaunch: '2026-12-15' });
  });

  it('reports each bad value with sheet, row, field and code', async () => {
    const parsed = await parseWorkbook(await book({
      products: [
        row({ 0: null }),
        row({ 0: 'XT-002', 5: 'Pilot' }),
        row({ 0: 'XT-003', 6: 'Fine' }),
        row({ 0: 'XT-004', 9: 'soon' }),
        row({ 0: 'XT-005', 10: '31/02/2027' }),
        row({ 0: 'XT-006', 10: null }),
        row({ 0: 'XT-007', 5: 'Launched', 9: 1, 10: null, 11: null }),
        row({ 0: 'XT-008', 9: 1 }),
        row({ 0: 'XT-009', 14: null }),
      ],
    }));
    expect(parsed.errors.every((e) => e.sheet === 'Products')).toBe(true);
    expect(parsed.errors.map((e) => [e.row, `${e.field}:${e.code}`])).toEqual([
      [2, 'Code:product.codeRequired'],
      [3, 'Pipeline stage:product.stageInvalid'],
      [4, 'Health:product.healthInvalid'],
      [5, 'Readiness %:product.readinessInvalid'],
      [6, 'Target launch date:date.invalid'],
      [7, 'Target launch date:product.targetRequired'],
      [8, 'Actual launch date:product.actualRequired'],
      [9, 'Readiness %:product.readinessFull'],
      [10, 'Next step due:product.nextStepDueRequired'],
    ]);
  });

  it('reports a missing column and a missing sheet', async () => {
    const parsed = await parseWorkbook(await book({ productHeaders: PRODUCT_HEADERS.filter((h) => h !== 'Owner') }));
    expect(codes(parsed.errors)).toEqual(['Owner:import.headerMissing']);
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Products').addRow(PRODUCT_HEADERS);
    const p2 = await parseWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(p2.errors.map((e) => e.sheet).sort()).toEqual(['Blockers & decisions', 'Lists', 'Status updates']);
  });

  it('validates status updates and blockers, ignoring the (auto) columns', async () => {
    const parsed = await parseWorkbook(await book({
      products: [row()],
      updates: [
        [d('2026-11-18'), 'XT-001', '=auto', 'At risk', 0.7, 'Lab OK', 'Repeat trial', d('2026-12-10'), 'Omar Ali'],
        [null, 'XT-001', null, null, null, null, null, null, null],
      ],
      blockers: [
        ['BL-001', 'XT-001', '=auto', 'Blocker', 'Polymer supplier delay', 'Approve alternative supplier', 'Sara Ahmed', d('2026-11-18'), d('2026-11-25'), 'Open', null, null, 'OVERDUE'],
        ['BL-002', 'XT-001', null, 'Risk', 'x', 'y', null, null, d('2026-11-25'), 'Resolved', null, null, null],
      ],
    }));
    expect(parsed.updates[0]).toMatchObject({ updateDate: '2026-11-18', code: 'XT-001', health: 'AT_RISK', readinessPct: 70, summary: 'Lab OK', updatedByName: 'Omar Ali' });
    expect(parsed.blockers[0]).toMatchObject({ externalId: 'BL-001', kind: 'BLOCKER', status: 'OPEN', dueDate: '2026-11-25', raisedOn: '2026-11-18', resolvedAt: null });
    expect(parsed.errors.map((e) => `${e.sheet}:${e.row}:${e.field}:${e.code}`)).toEqual([
      'Status updates:3:Update date:update.dateRequired',
      'Status updates:3:Progress summary:update.summaryRequired',
      'Blockers & decisions:3:Type:blocker.typeInvalid',
      'Blockers & decisions:3:Resolution note:blocker.noteRequired',
      'Blockers & decisions:3:Resolved date:blocker.resolvedDateRequired',
    ]);
  });

  it('refuses a file that is not a workbook', async () => {
    await expect(parseWorkbook(Buffer.from('not excel'))).rejects.toMatchObject({ code: 'import.unreadable' });
  });

  it('knows every stage label', () => {
    expect(STAGES).toHaveLength(6);
  });
});
