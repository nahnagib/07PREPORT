import { resetMarcom, snapshot, DATA_TABLES } from './helpers/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { pool } from '../../db/pool';
import {
  commitUpload, getBatch, getBatchFile, getFreshness, listBatches, previewRemoveBatch, removeBatch, rollbackBatch, validateUpload,
} from '../service';
import { stagingDir } from '../staging';
import { monthFile, spendFile } from './helpers/workbooks';

// "Remove batch" (any successful batch, not only the latest): removal.ts rules a-d, service.ts removeBatch rules e-g.
// DB-backed, opt-in like service.test.ts: npm run test:marcom-db --workspace backend
const RUN_DB = process.env.MARCOM_TEST_DB === '1';
const ADMIN = { id: 0 };

type R = Record<string, any>;
const q = async (sql: string, params: unknown[] = []): Promise<R[]> => (await pool.query(sql, params))[0] as R[];

async function mkUser(email: string): Promise<number> {
  const ex = await q('SELECT user_id FROM app_user WHERE email = ?', [email]);
  if (ex[0]) return ex[0].user_id;
  const [r] = await pool.query(
    `INSERT INTO app_user (email, display_name, role_id, status, must_change_password, password_hash)
     VALUES (?, ?, (SELECT role_id FROM roles WHERE role_name = 'ADMIN'), 'ACTIVE', 0, 'x')`,
    [email, 'Remover'],
  );
  return (r as { insertId: number }).insertId;
}

async function importFile(buf: Buffer, name = 'f.xlsx'): Promise<number> {
  const p = await validateUpload({ buffer: buf, filename: name, actor: ADMIN });
  return (await commitUpload({ stagedUploadId: p.stagedUploadId, actor: ADMIN, confirmNewBrands: true })).batchId;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** one P1 row: [year, month name, brand, spend, ...fixed values] */
const sp = (year: number, month: number, brand: string, spend: number): (string | number)[] =>
  [year, MONTHS[month - 1], brand, spend, 40000, 500000, 400000, 12000, 20, 700, 1000, 500];

/** live spend rows as "yyyy-mm brand = spend (batch)" */
async function liveSpend(): Promise<string[]> {
  return (await q(`SELECT s.year, s.month, b.name, s.spend, s.batch_id FROM marcom_spend_monthly s JOIN marcom_brand b ON b.brand_id = s.brand_id
                   WHERE s.is_current = 1 ORDER BY s.year, s.month, b.name`))
    .map((r) => `${r.year}-${String(r.month).padStart(2, '0')} ${r.name} = ${r.spend} (${r.batch_id})`);
}
const brands = async () => (await q('SELECT name FROM marcom_brand ORDER BY name')).map((r) => r.name);

describe.skipIf(!RUN_DB)('remove batch (DB-backed)', () => {
  beforeAll(async () => {
    ADMIN.id = await mkUser('marcom.remover@test.local');
  });
  afterAll(async () => {
    await resetMarcom(pool);
    fs.rmSync(stagingDir(), { recursive: true, force: true });
    await pool.end();
  });
  beforeEach(async () => {
    await resetMarcom(pool);
    fs.rmSync(stagingDir(), { recursive: true, force: true });
    fs.mkdirSync(stagingDir(), { recursive: true });
  });

  // batch 1 = test data (test brands + 3 Majaal rows), batch 2 = real data that updates those 3 Majaal rows and adds more
  const testFile = () => {
    const r: (string | number)[][] = [];
    for (const b of ['Brand A', 'Brand B', 'Core Brand']) for (let m = 1; m <= 8; m += 1) r.push(sp(2025, m, b, 1000 + m)); // the sheet holds rows 7-35
    for (let m = 1; m <= 3; m += 1) r.push(sp(2026, m, 'Majaal', 5));
    return spendFile(r);
  };
  const realFile = () => {
    const r: (string | number)[][] = [];
    for (let m = 1; m <= 9; m += 1) {
      r.push(sp(2026, m, 'Majaal', 70000 + m)); // Jan-Mar update batch 1's rows, Apr-Sep are new
      r.push(sp(2026, m, 'BMH', 50000 + m));
      r.push(sp(2026, m, 'Xtreme', 30000 + m));
    }
    return spendFile(r);
  };

  it('the reported scenario: removing the test batch leaves exactly the real batch (its updates stay current and untouched)', async () => {
    const test = await importFile(await testFile(), 'MARCOM_Contribution_Data_Template.xlsx');
    const real = await importFile(await realFile(), 'MARCOM_Contribution_Data.xlsx');
    expect((await getBatch(real)).totals).toMatchObject({ inserted: 24, updated: 3, unchanged: 0 });
    const realRowsBefore = await q('SELECT * FROM marcom_spend_monthly WHERE batch_id = ? ORDER BY id', [real]);

    const before = await snapshot(pool as never);
    const pv = await previewRemoveBatch(test);
    expect(await snapshot(pool as never)).toEqual(before); // the preview writes nothing
    const spend = pv.tables.find((t) => t.id === 'spend')!;
    expect(spend).toMatchObject({ deleted: 27, deletedCurrent: 24 });
    expect(spend.deletedSuperseded.map((d) => [d.label, d.supersededBy])).toEqual([
      ['2026-01 · Majaal', real], ['2026-02 · Majaal', real], ['2026-03 · Majaal', real],
    ]);
    expect(pv.totals).toEqual({ deleted: 27, otherBatchRowsAffected: 0 });
    expect(pv.brands.deleted.sort()).toEqual(['Brand A', 'Brand B', 'Core Brand']);
    expect(pv.brands.kept).toEqual([{ name: 'Majaal', usedBy: [real] }]);

    const res = await removeBatch({ batchId: test, actor: ADMIN, reason: 'test data uploaded by mistake' });
    expect(res.totals.deleted).toBe(27);
    expect(res.brandsDeleted.sort()).toEqual(['Brand A', 'Brand B', 'Core Brand']);

    // batch 2's 27 rows are current and byte-for-byte unchanged; nothing of batch 1 is left
    expect(await q('SELECT * FROM marcom_spend_monthly WHERE batch_id = ? ORDER BY id', [real])).toEqual(realRowsBefore);
    expect((await q('SELECT COUNT(*) AS n FROM marcom_spend_monthly WHERE is_current = 1'))[0].n).toBe(27);
    for (const t of DATA_TABLES) expect((await q(`SELECT COUNT(*) AS n FROM ${t} WHERE batch_id = ? OR superseded_by_batch = ?`, [test, test]))[0].n).toBe(0);
    expect(await brands()).toEqual(['BMH', 'Majaal', 'Xtreme']);
    expect((await q("SELECT created_batch_id FROM marcom_brand WHERE name = 'Majaal'"))[0].created_batch_id).toBe(real);

    // the report data equals batch 2 alone
    const live = await liveSpend();
    await resetMarcom(pool);
    const alone = await importFile(await realFile(), 'MARCOM_Contribution_Data.xlsx');
    expect((await liveSpend()).map((x) => x.replace(/\(\d+\)$/, ''))).toEqual(live.map((x) => x.replace(/\(\d+\)$/, '')));
    expect(alone).toBeGreaterThan(0);
  });

  it('rule c1: removing a middle batch re-arms the earlier row it superseded when its own row is still current', async () => {
    const b1 = await importFile(await spendFile([sp(2026, 1, 'BMH', 100)]));
    const b2 = await importFile(await spendFile([sp(2026, 1, 'BMH', 200)]));
    const b3 = await importFile(await spendFile([sp(2026, 2, 'BMH', 300)]));
    const pv = await previewRemoveBatch(b2);
    expect(pv.tables.find((t) => t.id === 'spend')!.rearmed).toEqual([{ label: '2026-01 · BMH', batch: b1 }]);
    await removeBatch({ batchId: b2, actor: ADMIN, reason: 'wrong values' });
    expect(await liveSpend()).toEqual([`2026-01 BMH = 100.00 (${b1})`, `2026-02 BMH = 300.00 (${b3})`]);
    expect((await q('SELECT COUNT(*) AS n FROM marcom_spend_monthly WHERE is_current IS NULL'))[0].n).toBe(0);
  });

  it('rule b/c3: a later batch superseded the removed row -> the later row stays, the earlier row is re-linked to it (rollback still works)', async () => {
    const b1 = await importFile(await spendFile([sp(2026, 1, 'BMH', 100)]));
    const b2 = await importFile(await spendFile([sp(2026, 1, 'BMH', 200)]));
    const b3 = await importFile(await spendFile([sp(2026, 1, 'BMH', 300)]));
    const b3Row = await q('SELECT * FROM marcom_spend_monthly WHERE batch_id = ?', [b3]);
    const pv = await previewRemoveBatch(b2);
    const t = pv.tables.find((x) => x.id === 'spend')!;
    expect(t.deletedSuperseded).toMatchObject([{ label: '2026-01 · BMH', supersededBy: b3 }]);
    expect(t.relinked).toEqual([{ label: '2026-01 · BMH', batch: b1, toBatch: b3 }]);
    expect(t.rearmed).toEqual([]);
    await removeBatch({ batchId: b2, actor: ADMIN, reason: 'middle batch was wrong' });
    expect(await q('SELECT * FROM marcom_spend_monthly WHERE batch_id = ?', [b3])).toEqual(b3Row);
    expect(await liveSpend()).toEqual([`2026-01 BMH = 300.00 (${b3})`]);
    expect((await q('SELECT superseded_by_batch FROM marcom_spend_monthly WHERE batch_id = ?', [b1]))[0].superseded_by_batch).toBe(b3);
    // the chain still holds: rolling back batch 3 brings batch 1's value back
    await rollbackBatch({ batchId: b3, actor: ADMIN, reason: 'undo the latest' });
    expect(await liveSpend()).toEqual([`2026-01 BMH = 100.00 (${b1})`]);
  });

  it('rule c2: a row a later batch re-stated UNCHANGED is handed over to that batch, not deleted', async () => {
    const b1 = await importFile(await spendFile([sp(2026, 1, 'BMH', 100), sp(2026, 2, 'BMH', 150)]));
    const b2 = await importFile(await spendFile([sp(2026, 1, 'BMH', 100), sp(2026, 3, 'BMH', 175)])); // Jan unchanged, Mar new
    expect((await getBatch(b2)).totals).toMatchObject({ inserted: 1, updated: 0, unchanged: 1 });
    const pv = await previewRemoveBatch(b1);
    const t = pv.tables.find((x) => x.id === 'spend')!;
    expect(t.handedOver).toEqual([{ label: '2026-01 · BMH', toBatch: b2 }]);
    expect(t.deleted).toBe(1); // Feb only
    expect(pv.brands.kept).toEqual([{ name: 'BMH', usedBy: [b2] }]);
    await removeBatch({ batchId: b1, actor: ADMIN, reason: 'old file' });
    expect(await liveSpend()).toEqual([`2026-01 BMH = 100.00 (${b2})`, `2026-03 BMH = 175.00 (${b2})`]);
    // batch 2 now owns what it uploaded: rolling it back clears everything
    await rollbackBatch({ batchId: b2, actor: ADMIN, reason: 'clean' });
    for (const x of DATA_TABLES) expect((await q(`SELECT COUNT(*) AS n FROM ${x}`))[0].n).toBe(0);
    expect(await brands()).toEqual([]);
  });

  it('removing the latest batch gives exactly what a rollback gives', async () => {
    await importFile(await monthFile({ month: 'February', spend: 1000 }));
    const before = await snapshot(pool as never);
    const upd = await importFile(await monthFile({ month: 'February', spend: 9999, brands: ['Brand A', 'Brand C'] }));
    await removeBatch({ batchId: upd, actor: ADMIN, reason: 'same as rollback' });
    expect(await snapshot(pool as never)).toEqual(before);
  });

  it('rules e-g: status REMOVED with who/when/why, file and summary kept, audit entry, no second removal, reason required', async () => {
    const b1 = await importFile(await monthFile({ month: 'February' }), 'feb.xlsx');
    const b2 = await importFile(await monthFile({ month: 'March' }), 'mar.xlsx');
    await expect(removeBatch({ batchId: b1, actor: ADMIN, reason: ' ' })).rejects.toMatchObject({ status: 400, code: 'REASON_REQUIRED' });
    await expect(removeBatch({ batchId: 999999, actor: ADMIN, reason: 'nope nope' })).rejects.toMatchObject({ status: 404 });
    await removeBatch({ batchId: b1, actor: ADMIN, reason: 'February was a test' });
    const b = await getBatch(b1);
    expect(b).toMatchObject({ status: 'REMOVED', removedBy: 'Remover', removeReason: 'February was a test', canRemove: false, canRollback: false });
    expect(b.removedAt).not.toBeNull();
    expect(b.totals).not.toBeNull(); // summary kept
    expect((await getBatchFile(b1)).buffer.length).toBeGreaterThan(0); // original file kept
    const audit = await q("SELECT after_value FROM audit_log WHERE entity_type = 'marcom_upload_batch' AND entity_id = ? AND JSON_EXTRACT(after_value, '$.event') = 'remove_batch' ORDER BY audit_id DESC LIMIT 1", [String(b1)]);
    const after = typeof audit[0].after_value === 'string' ? JSON.parse(audit[0].after_value) : audit[0].after_value;
    expect(after).toMatchObject({ event: 'remove_batch', batchId: b1, reason: 'February was a test' });
    expect(after.counts.spend.deleted).toBe(2);
    await expect(removeBatch({ batchId: b1, actor: ADMIN, reason: 'again please' })).rejects.toMatchObject({ status: 409, code: 'NOT_REMOVABLE' });
    expect((await previewRemoveBatch(b1))).toMatchObject({ canRemove: false });
    await rollbackBatch({ batchId: b2, actor: ADMIN, reason: 'undo March' });
    await expect(removeBatch({ batchId: b2, actor: ADMIN, reason: 'rolled back already' })).rejects.toMatchObject({ status: 409, code: 'NOT_REMOVABLE' });
    expect((await listBatches(1, 10)).rows.map((r) => [r.status, r.canRemove])).toEqual([['ROLLED_BACK', false], ['REMOVED', false]]);
  });

  it('freshness and the history follow a removal', async () => {
    const feb = await importFile(await monthFile({ month: 'February' }));
    const mar = await importFile(await monthFile({ month: 'March' }));
    expect(await getFreshness()).toMatchObject({ latestPeriod: { month: 3 }, batchId: mar });
    await removeBatch({ batchId: mar, actor: ADMIN, reason: 'March not final' });
    expect(await getFreshness()).toMatchObject({ latestPeriod: { month: 2 }, batchId: feb });
    const rows = (await listBatches(1, 10)).rows;
    expect(rows.map((r) => [r.batchId, r.status, r.canRemove, r.canRollback])).toEqual([[mar, 'REMOVED', false, false], [feb, 'SUCCESS', true, true]]);
  });
});
