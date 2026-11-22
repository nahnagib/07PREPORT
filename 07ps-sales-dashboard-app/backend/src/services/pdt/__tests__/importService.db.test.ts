import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The Excel import against a REAL test database (opt-in, writes, cleans up after itself):
 *
 *   PDT_TEST_DB=1 DB_HOST=127.0.0.1 DB_PORT=33309 DB_NAME=powerBI_Data DB_USER=... DB_PASSWORD=... \
 *     npx vitest run -c vitest.pdt-db.config.ts
 *
 * Needs migrations 0080 + 0081 on the local TEST stack. Refuses any port but 33309. Uses its own codes (PDTT-###, BLT-###)
 * and file names (pdt-test-*.xlsx), all hard-deleted at the end. Covers preview (nothing written), confirm (same file
 * only), upsert by code, stage history "Excel import", Blocker -> Blocked, append-only updates, missing products, errors.
 */
const RUN = process.env.PDT_TEST_DB === '1' && process.env.DB_HOST === '127.0.0.1' && process.env.DB_PORT === '33309';
const TODAY = '2026-11-18';

const PRODUCT_HEADERS = ['Code', 'Product name', 'Family', 'Subfamily', 'Description', 'Pipeline stage', 'Health', 'Priority', 'Owner', 'Readiness %', 'Target launch date', 'Actual launch date', 'Project type', 'Next step', 'Next step due', 'Comment', 'Last updated', 'Updated by'];
const UPDATE_HEADERS = ['Update date', 'Product code', 'Product name (auto)', 'Health', 'Readiness %', 'Progress summary', 'Next step', 'Next step due', 'Updated by'];
const BLOCKER_HEADERS = ['ID', 'Product code', 'Product name (auto)', 'Type', 'Title', 'Required action / decision', 'Owner', 'Raised on', 'Due date', 'Status', 'Resolution note', 'Resolved date', 'Overdue? (auto)'];
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

async function book(products: unknown[][], updates: unknown[][] = [], blockers: unknown[][] = []): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const add = (name: string, headers: string[], data: unknown[][]) => {
    const ws = wb.addWorksheet(name);
    ws.addRow(headers);
    for (const r of data) ws.addRow(r);
  };
  add('Products', PRODUCT_HEADERS, products);
  add('Status updates', UPDATE_HEADERS, updates);
  add('Blockers & decisions', BLOCKER_HEADERS, blockers);
  const lists = wb.addWorksheet('Lists');
  lists.addRow(['Stage', 'Health', 'Priority', 'Project type', 'Blocker type', 'Blocker status', 'Owners (type names)', 'Product family', 'Family description']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const P1 = (stage = 'Testing', health: string | null = 'At risk', readiness = 0.7) =>
  ['PDTT-001', 'PDT-TEST MonoSeal', 'Waterproofing', 'Cementitious waterproofing', 'test', stage, health, 'High', 'Test Owner', readiness, d('2027-03-01'), null, 'Planned', null, null, null, null, null];
const P2 = (health: string | null = null) => ['PDTT-002', 'PDT-TEST Epoxy', 'Flooring', 'Epoxy Flooring', 'test', 'Idea', health, null, null, null, d('2027-06-01'), null, 'Innovation', null, null, null, null, null];

describe.skipIf(!RUN)('Excel import on the test database', () => {
  let imp: typeof import('../importService');
  let svc: typeof import('../trackerService');
  let pool: typeof import('../../../db/pool').pool;
  let uid = 0;
  const q = async <T>(sql: string, params: unknown[] = []) => ((await pool.query(sql, params)) as unknown as [T[]])[0];

  beforeAll(async () => {
    imp = await import('../importService');
    svc = await import('../trackerService');
    ({ pool } = await import('../../../db/pool'));
    uid = (await q<{ id: number }>('SELECT MIN(user_id) AS id FROM app_user'))[0].id;
  });

  afterAll(async () => {
    if (!pool) return;
    const ids = (await q<{ product_id: number; code: string }>("SELECT product_id, code FROM pdt_product WHERE code LIKE 'PDTT-%'"));
    for (const p of ids) {
      await pool.query('DELETE FROM pdt_blocker WHERE product_id = ?', [p.product_id]);
      await pool.query('DELETE FROM pdt_status_update WHERE product_id = ?', [p.product_id]);
      await pool.query('DELETE FROM pdt_stage_history WHERE product_id = ?', [p.product_id]);
      await pool.query('DELETE FROM pdt_product WHERE product_id = ?', [p.product_id]);
      await pool.query("DELETE FROM audit_log WHERE entity_type = 'pdt_product' AND entity_id = ?", [p.code]);
    }
    const logs = await q<{ import_id: number }>("SELECT import_id FROM pdt_import_log WHERE file_name LIKE 'pdt-test-%'");
    for (const l of logs) await pool.query("DELETE FROM audit_log WHERE entity_type = 'pdt_import' AND entity_id = ?", [String(l.import_id)]);
    await pool.query("DELETE FROM pdt_import_log WHERE file_name LIKE 'pdt-test-%'");
    await pool.end();
  });

  it('previews two new products without writing anything', async () => {
    const before = (await q<{ n: number }>("SELECT COUNT(*) AS n FROM pdt_product WHERE code LIKE 'PDTT-%'"))[0].n;
    const pv = await imp.previewImport(await book([P1(), P2()]), 'pdt-test-1.xlsx', TODAY);
    expect(pv.errors).toEqual([]);
    expect(pv.canConfirm).toBe(true);
    expect(pv.counts.products).toMatchObject({ rows: 2, new: 2, changed: 0, unchanged: 0, errors: 0 });
    expect((await q<{ n: number }>("SELECT COUNT(*) AS n FROM pdt_product WHERE code LIKE 'PDTT-%'"))[0].n).toBe(before);
  });

  it('confirms only the previewed file, then creates the products with an "Excel import" history row', async () => {
    const file = await book([P1(), P2()]);
    await expect(imp.confirmImport(file, 'pdt-test-1.xlsx', 'not-the-hash', uid, TODAY)).rejects.toMatchObject({ code: 'import.fileChanged' });
    const pv = await imp.previewImport(file, 'pdt-test-1.xlsx', TODAY);
    const done = await imp.confirmImport(file, 'pdt-test-1.xlsx', pv.sha256, uid, TODAY);
    expect(done.importId).toBeGreaterThan(0);
    const p1 = await svc.getProduct('PDTT-001', TODAY);
    expect(p1.product).toMatchObject({ name: 'PDT-TEST MonoSeal', family: 'Waterproofing', subfamily: 'Cementitious waterproofing', stage: 'TESTING', health: 'AT_RISK', priority: 'HIGH', readinessPct: 70, projectType: 'PLANNED', ownerName: 'Test Owner' });
    expect(p1.history.map((h) => [h.fromStage, h.toStage, h.comment])).toEqual([[null, 'TESTING', 'Excel import']]);
    const p2 = await svc.getProduct('PDTT-002', TODAY);
    expect(p2.product).toMatchObject({ stage: 'IDEA', health: null, priority: null, ownerName: null, readinessPct: null, flag: 'HEALTH_NOT_SET' });
    expect((await imp.importHistory()).find((h) => h.importId === done.importId)).toMatchObject({ fileName: 'pdt-test-1.xlsx', counts: expect.objectContaining({ products: expect.objectContaining({ new: 2 }) }) });
  });

  it('upserts by code: a stage change is recorded, an open Blocker forces Blocked, updates are append-only', async () => {
    const file = await book(
      [P1('Launch ready', 'On track', 0.9), P2()],
      [[d('2026-11-17'), 'PDTT-001', null, 'On track', 0.9, 'Pilot batch approved', 'Book launch', d('2026-12-01'), 'Test Owner']],
      [['BLT-001', 'PDTT-002', null, 'Blocker', 'Resin supplier missing', 'Find a second supplier', 'Test Owner', d('2026-11-18'), d('2026-11-30'), 'Open', null, null, null]],
    );
    const pv = await imp.previewImport(file, 'pdt-test-2.xlsx', TODAY);
    expect(pv.errors).toEqual([]);
    expect(pv.counts.products).toMatchObject({ new: 0, changed: 1, unchanged: 1, stageChanges: 1 });
    expect(pv.products.find((p) => p.code === 'PDTT-001')).toMatchObject({ action: 'changed', stageFrom: 'TESTING', stageTo: 'LAUNCH_READY', fields: expect.arrayContaining(['Pipeline stage', 'Health', 'Readiness %']) });
    expect(pv.counts.updates).toMatchObject({ new: 1, duplicates: 0 });
    expect(pv.counts.blockers).toMatchObject({ new: 1 });
    expect(pv.healthForced).toEqual(['PDTT-002']);
    await imp.confirmImport(file, 'pdt-test-2.xlsx', pv.sha256, uid, TODAY);

    const p1 = await svc.getProduct('PDTT-001', TODAY);
    expect(p1.history.map((h) => [h.fromStage, h.toStage, h.comment])).toEqual([[null, 'TESTING', 'Excel import'], ['TESTING', 'LAUNCH_READY', 'Excel import']]);
    expect(p1.product).toMatchObject({ stage: 'LAUNCH_READY', health: 'ON_TRACK', readinessPct: 90, lastUpdateAt: '2026-11-17' });
    expect(p1.updates).toHaveLength(1);
    const p2 = await svc.getProduct('PDTT-002', TODAY);
    expect(p2.product.health).toBe('BLOCKED');
    expect(p2.blockers.map((b) => [b.externalId, b.status])).toEqual([['BLT-001', 'OPEN']]);

    // The same file again: nothing new, the update is a duplicate, nothing changes.
    const again = await imp.previewImport(file, 'pdt-test-3.xlsx', TODAY);
    expect(again.counts.updates).toMatchObject({ new: 0, duplicates: 1 });
    expect(again.counts.blockers).toMatchObject({ new: 0, unchanged: 1 });
  });

  it('keeps a product missing from the file and reports it', async () => {
    const pv = await imp.previewImport(await book([P1('Launch ready', 'On track', 0.9)]), 'pdt-test-4.xlsx', TODAY);
    expect(pv.missingFromFile.map((m) => m.code)).toContain('PDTT-002');
    expect(pv.counts.products).toMatchObject({ rows: 1, unchanged: 1 });
  });

  it('refuses to confirm a file with errors, listing them by sheet, row and field', async () => {
    const file = await book([P1('Pilot'), [...P2('Blocked').slice(0, 0), 'PDTT-001', 'PDT-TEST Dup', 'Nowhere', null, null, 'Idea', 'Blocked', null, null, null, null, null, null, null, null, null, null, null]]);
    const pv = await imp.previewImport(file, 'pdt-test-5.xlsx', TODAY);
    expect(pv.canConfirm).toBe(false);
    expect(pv.errors.map((e) => `${e.row}:${e.field}:${e.code}`)).toEqual(expect.arrayContaining([
      '2:Pipeline stage:product.stageInvalid',
      '3:Code:product.codeDuplicate',
      '3:Family:product.familyUnknown',
    ]));
    await expect(imp.confirmImport(file, 'pdt-test-5.xlsx', pv.sha256, uid, TODAY)).rejects.toMatchObject({ code: 'import.hasErrors' });
  });

  it('exports a workbook the import reads back unchanged', async () => {
    const out = await imp.exportWorkbook(TODAY);
    const pv = await imp.previewImport(out, 'pdt-test-export.xlsx', TODAY);
    expect(pv.errors).toEqual([]);
    expect(pv.counts.products.new).toBe(0);
    expect(pv.counts.products.changed).toBe(0);
    expect(pv.counts.updates.new).toBe(0);
    expect(pv.counts.blockers).toMatchObject({ new: 0, changed: 0 });
    expect(pv.missingFromFile).toEqual([]);
  });
});
