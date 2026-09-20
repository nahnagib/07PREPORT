import { resetMarcom, snapshot, DATA_TABLES } from './helpers/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { pool } from '../../db/pool';
import {
  MarcomError, commitUpload, getFreshness, listBatches, rollbackBatch, testHooks, validateUpload, getBatch,
} from '../service';
import { stagingDir } from '../staging';
import { P1, monthFile, setRow, templateWb, toBuf } from './helpers/workbooks';

// DB-backed suite is opt-in (needs the throwaway MySQL from backend/scripts/marcomTestDb.py):
//   npm run test:marcom-db --workspace backend
const RUN_DB = process.env.MARCOM_TEST_DB === '1';

const ADMIN = { id: 0 };
const OTHER = { id: 0 };

async function mkUser(email: string, role: string): Promise<number> {
  const [ex] = (await pool.query('SELECT user_id FROM app_user WHERE email = ?', [email])) as [{ user_id: number }[], unknown];
  if (ex[0]) return ex[0].user_id;
  const [r] = await pool.query(
    `INSERT INTO app_user (email, display_name, role_id, status, must_change_password, password_hash)
     VALUES (?, ?, (SELECT role_id FROM roles WHERE role_name = ?), 'ACTIVE', 0, 'x')`,
    [email, email.split('@')[0], role],
  );
  return (r as { insertId: number }).insertId;
}

/** validate + commit in one go (confirming any new brands). */
async function importFile(buf: Buffer, name = 'f.xlsx', actor = ADMIN) {
  const p = await validateUpload({ buffer: buf, filename: name, actor });
  const r = await commitUpload({ stagedUploadId: p.stagedUploadId, actor, confirmNewBrands: true });
  return { preview: p, result: r };
}

const count = async (t: string, where = 'is_current = 1') =>
  ((await pool.query(`SELECT COUNT(*) AS n FROM ${t} WHERE ${where}`)) as [{ n: number }[], unknown])[0][0].n;

describe.skipIf(!RUN_DB)('marcom service (DB-backed)', () => {
  beforeAll(async () => {
    ADMIN.id = await mkUser('marcom.admin@test.local', 'ADMIN');
    OTHER.id = await mkUser('marcom.other@test.local', 'ADMIN');
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
    testHooks.afterWrites = undefined;
  });

  describe('classification', () => {
    it('reports inserts on first upload, unchanged on identical data, updates with old->new on a changed value', async () => {
      const feb = await monthFile({ month: 'February' });
      const p1 = await validateUpload({ buffer: feb, filename: 'feb.xlsx', actor: ADMIN });
      expect(p1.errorCount).toBe(0);
      const spend = p1.tables.find((t) => t.id === 'spend')!;
      expect(spend).toMatchObject({ rowsFound: 2, insert: 2, update: 0, unchanged: 0 });
      expect(p1.totals.examplesSkipped).toBe(7);
      expect(p1.newBrands.sort()).toEqual(['Brand A', 'Brand B']);
      expect(p1.requiresNewBrandConfirmation).toBe(true);
      expect(p1.period?.label).toMatch(/February/);
      await commitUpload({ stagedUploadId: p1.stagedUploadId, actor: ADMIN, confirmNewBrands: true });

      const p2 = await validateUpload({ buffer: feb, filename: 'feb.xlsx', actor: ADMIN });
      expect(p2.tables.find((t) => t.id === 'spend')).toMatchObject({ insert: 0, update: 0, unchanged: 2 });
      expect(p2.nothingToImport).toBe(true);
      expect(p2.canCommit).toBe(false);
      expect(p2.issues.some((i) => i.code === 'DUPLICATE_FILE')).toBe(true);

      const changed = await monthFile({ month: 'February', spend: 12345.5 });
      const p3 = await validateUpload({ buffer: changed, filename: 'feb2.xlsx', actor: ADMIN });
      const s3 = p3.tables.find((t) => t.id === 'spend')!;
      expect(s3).toMatchObject({ insert: 0, update: 2, unchanged: 0 });
      expect(s3.updates[0].changes).toEqual([{ field: 'spend', old: '10000.00', new: '12345.50' }]);
      expect(p3.issues.some((i) => i.code === 'ROW_UPDATES_EXISTING')).toBe(true);
      expect(p3.newBrands).toEqual([]);
    });

    it('compares numbers as decimals (50000 == 50000.00)', async () => {
      await importFile(await monthFile({ month: 'February', spend: 50000 }));
      const p = await validateUpload({ buffer: await monthFile({ month: 'February', spend: 50000.0 }), filename: 'x.xlsx', actor: ADMIN });
      expect(p.tables.find((t) => t.id === 'spend')!.unchanged).toBe(2);
    });

    it('the blank template imports nothing and reports 7 example rows skipped', async () => {
      const p = await validateUpload({ buffer: await toBuf(await templateWb()), filename: 't.xlsx', actor: ADMIN });
      expect(p.totals).toEqual({ insert: 0, update: 0, unchanged: 0, examplesSkipped: 7 });
      expect(p.nothingToImport).toBe(true);
      expect(p.canCommit).toBe(false);
    });
  });

  describe('merge semantics', () => {
    it('Feb then Mar: both months present, nothing lost', async () => {
      await importFile(await monthFile({ month: 'February' }));
      await importFile(await monthFile({ month: 'March' }));
      const [rows] = (await pool.query(
        'SELECT month, COUNT(*) AS n FROM marcom_spend_monthly WHERE is_current = 1 GROUP BY month ORDER BY month')) as [{ month: number; n: number }[], unknown];
      expect(rows).toEqual([{ month: 2, n: 2 }, { month: 3, n: 2 }]);
      expect(await count('marcom_campaign')).toBe(2);
      expect(await count('marcom_campaign_media')).toBe(4);
      expect(await count('marcom_event')).toBe(2);
      const fresh = await getFreshness();
      expect(fresh).toMatchObject({ hasData: true, latestPeriod: { year: 2026, month: 3, label: 'March 2026' } });
    });

    it('re-uploading the same file is idempotent: 0 inserted, N unchanged, no duplicates', async () => {
      const buf = await monthFile({ month: 'February' });
      const first = await importFile(buf);
      expect(first.result.totals.inserted).toBeGreaterThan(0);
      const before = await snapshot(pool as never);
      const again = await importFile(buf);
      expect(again.result.totals).toMatchObject({ inserted: 0, updated: 0 });
      expect(again.result.totals.unchanged).toBe(first.result.totals.inserted);
      expect(again.preview.duplicateOf).not.toBeNull();
      expect(await snapshot(pool as never)).toEqual(before);
    });

    it('an update supersedes the old row (append-only history) and only one row stays current', async () => {
      await importFile(await monthFile({ month: 'February', spend: 1000 }));
      await importFile(await monthFile({ month: 'February', spend: 2000 }));
      expect(await count('marcom_spend_monthly')).toBe(2);
      expect(await count('marcom_spend_monthly', '1 = 1')).toBe(4);
      const [cur] = (await pool.query("SELECT spend FROM marcom_spend_monthly WHERE is_current = 1 ORDER BY brand_id")) as [{ spend: string }[], unknown];
      expect(cur.map((r) => r.spend)).toEqual(['2000.00', '3000.00']);
    });
  });

  describe('rollback', () => {
    it('restores the exact prior state (inserts removed, updates reverted, new brands removed)', async () => {
      await importFile(await monthFile({ month: 'February', spend: 1000 }));
      const before = await snapshot(pool as never);

      const upd = await importFile(await monthFile({ month: 'February', spend: 9999 })); // updates Feb
      const mar = await importFile(await monthFile({ month: 'March', brands: ['Brand A', 'Brand C'] })); // inserts + new brand
      expect(await count('marcom_brand', '1 = 1')).toBe(3);

      await rollbackBatch({ batchId: mar.result.batchId, actor: ADMIN, reason: 'wrong file' });
      await rollbackBatch({ batchId: upd.result.batchId, actor: ADMIN, reason: 'revert update' });
      expect(await snapshot(pool as never)).toEqual(before);

      const batches = (await listBatches(1, 10)).rows;
      expect(batches.map((b) => b.status)).toEqual(['ROLLED_BACK', 'ROLLED_BACK', 'SUCCESS']);
      expect(await getBatch(mar.result.batchId)).toMatchObject({ status: 'ROLLED_BACK', rollbackReason: 'wrong file' });
    });

    it('keeps a brand that another batch still uses', async () => {
      await importFile(await monthFile({ month: 'February', brands: ['Brand A'] }));
      const { result } = await importFile(await monthFile({ month: 'March', brands: ['Brand A', 'Brand C'] }));
      await rollbackBatch({ batchId: result.batchId, actor: ADMIN, reason: 'oops' });
      const [b] = (await pool.query('SELECT name FROM marcom_brand ORDER BY name')) as [{ name: string }[], unknown];
      expect(b.map((x) => x.name)).toEqual(['Brand A']);
    });

    it('refuses a non-latest batch, a rolled-back batch, and a missing reason', async () => {
      const a = await importFile(await monthFile({ month: 'February' }));
      const b = await importFile(await monthFile({ month: 'March' }));
      await expect(rollbackBatch({ batchId: a.result.batchId, actor: ADMIN, reason: 'x y z' }))
        .rejects.toMatchObject({ code: 'NOT_LATEST', status: 409 });
      await expect(rollbackBatch({ batchId: b.result.batchId, actor: ADMIN, reason: '  ' }))
        .rejects.toMatchObject({ code: 'REASON_REQUIRED' });
      await rollbackBatch({ batchId: b.result.batchId, actor: ADMIN, reason: 'fine' });
      await expect(rollbackBatch({ batchId: b.result.batchId, actor: ADMIN, reason: 'again' }))
        .rejects.toMatchObject({ code: 'NOT_ROLLBACKABLE' });
      // ...but now the Feb batch is the latest successful one and can go.
      await rollbackBatch({ batchId: a.result.batchId, actor: ADMIN, reason: 'clean slate' });
      for (const t of DATA_TABLES) expect(await count(t, '1 = 1')).toBe(0);
    });
  });

  describe('atomicity and concurrency', () => {
    it('a failure mid-commit writes nothing (all or nothing) and records a FAILED batch', async () => {
      await importFile(await monthFile({ month: 'February' }));
      const before = await snapshot(pool as never);
      const p = await validateUpload({ buffer: await monthFile({ month: 'March', brands: ['Brand A', 'Brand Z'] }), filename: 'm.xlsx', actor: ADMIN });
      testHooks.afterWrites = () => { throw new Error('boom'); };
      await expect(commitUpload({ stagedUploadId: p.stagedUploadId, actor: ADMIN, confirmNewBrands: true })).rejects.toThrow('boom');
      expect(await snapshot(pool as never)).toEqual(before);
      const [b] = (await pool.query('SELECT status FROM marcom_upload_batch ORDER BY batch_id')) as [{ status: string }[], unknown];
      expect(b.map((x) => x.status)).toEqual(['SUCCESS', 'FAILED']);
      // The staged upload was not consumed, so once the fault is gone the same upload can be retried.
      testHooks.afterWrites = undefined;
      await expect(commitUpload({ stagedUploadId: p.stagedUploadId, actor: ADMIN, confirmNewBrands: true })).resolves.toBeTruthy();
    });

    it('two concurrent commits of the same content never duplicate rows', async () => {
      const buf = await monthFile({ month: 'February' });
      const [a, b] = await Promise.all([
        validateUpload({ buffer: buf, filename: 'a.xlsx', actor: ADMIN }),
        validateUpload({ buffer: buf, filename: 'b.xlsx', actor: OTHER }),
      ]);
      const results = await Promise.all([
        commitUpload({ stagedUploadId: a.stagedUploadId, actor: ADMIN, confirmNewBrands: true }),
        commitUpload({ stagedUploadId: b.stagedUploadId, actor: OTHER, confirmNewBrands: true }),
      ]);
      const inserted = results.map((r) => r.totals.inserted).sort((x, y) => x - y);
      expect(inserted[0]).toBe(0);
      expect(inserted[1]).toBeGreaterThan(0);
      expect(await count('marcom_spend_monthly')).toBe(2);
      expect(await count('marcom_spend_monthly', '1 = 1')).toBe(2);
      expect(await count('marcom_brand', '1 = 1')).toBe(2);
    });
  });

  describe('staged upload guards', () => {
    it('refuses an expired, foreign, unknown, consumed or tampered staged upload', async () => {
      const buf = await monthFile({ month: 'February' });
      const p = await validateUpload({ buffer: buf, filename: 'a.xlsx', actor: ADMIN });

      await expect(commitUpload({ stagedUploadId: p.stagedUploadId, actor: OTHER, confirmNewBrands: true }))
        .rejects.toMatchObject({ code: 'STAGED_FORBIDDEN', status: 403 });
      await expect(commitUpload({ stagedUploadId: '00000000-0000-4000-8000-000000000000', actor: ADMIN }))
        .rejects.toMatchObject({ code: 'STAGED_NOT_FOUND', status: 404 });

      // tampered file
      const file = `${stagingDir()}/${p.stagedUploadId}.xlsx`;
      const orig = fs.readFileSync(file);
      fs.writeFileSync(file, Buffer.concat([orig, Buffer.from('x')]));
      await expect(commitUpload({ stagedUploadId: p.stagedUploadId, actor: ADMIN, confirmNewBrands: true }))
        .rejects.toMatchObject({ code: 'FILE_CHANGED', status: 409 });
      fs.writeFileSync(file, orig);

      // expired
      await pool.query('UPDATE marcom_staged_upload SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE staged_id = ?', [p.stagedUploadId]);
      await expect(commitUpload({ stagedUploadId: p.stagedUploadId, actor: ADMIN, confirmNewBrands: true }))
        .rejects.toMatchObject({ code: 'STAGED_EXPIRED', status: 410 });
      await pool.query('UPDATE marcom_staged_upload SET expires_at = DATE_ADD(NOW(), INTERVAL 1 HOUR) WHERE staged_id = ?', [p.stagedUploadId]);

      // consumed
      await commitUpload({ stagedUploadId: p.stagedUploadId, actor: ADMIN, confirmNewBrands: true });
      await expect(commitUpload({ stagedUploadId: p.stagedUploadId, actor: ADMIN, confirmNewBrands: true }))
        .rejects.toMatchObject({ code: 'STAGED_CONSUMED', status: 409 });
    });

    it('refuses a file with blocking errors and writes nothing', async () => {
      const wb = await templateWb();
      setRow(wb.getWorksheet(P1)!, 7, [2026, 'Agust', 'Brand A', -5, 1, 1, 1, 1, 1, 1, 1, 1]);
      const p = await validateUpload({ buffer: await toBuf(wb), filename: 'bad.xlsx', actor: ADMIN });
      expect(p.errorCount).toBeGreaterThan(0);
      expect(p.canCommit).toBe(false);
      expect(p.issues[0]).toMatchObject({ severity: 'error', sheet: P1 });
      expect(p.issues[0].code).toMatch(/^[A-Z_]+$/);
      const err = await commitUpload({ stagedUploadId: p.stagedUploadId, actor: ADMIN, confirmNewBrands: true }).catch((e) => e);
      expect(err).toBeInstanceOf(MarcomError);
      expect(err).toMatchObject({ code: 'BLOCKING_ERRORS', status: 422 });
      for (const t of DATA_TABLES) expect(await count(t, '1 = 1')).toBe(0);
    });

    it('new-brand guard: commit needs confirmNewBrands, and nothing is written without it', async () => {
      const p = await validateUpload({ buffer: await monthFile({ month: 'February' }), filename: 'a.xlsx', actor: ADMIN });
      const err = await commitUpload({ stagedUploadId: p.stagedUploadId, actor: ADMIN }).catch((e) => e);
      expect(err).toMatchObject({ code: 'NEW_BRANDS_UNCONFIRMED', status: 409 });
      expect(err.extra.newBrands.sort()).toEqual(['Brand A', 'Brand B']);
      for (const t of DATA_TABLES) expect(await count(t, '1 = 1')).toBe(0);
      expect(await count('marcom_brand', '1 = 1')).toBe(0);
      await commitUpload({ stagedUploadId: p.stagedUploadId, actor: ADMIN, confirmNewBrands: true });
      expect(await count('marcom_brand', '1 = 1')).toBe(2);
      // A later file with only known brands needs no confirmation.
      const p2 = await validateUpload({ buffer: await monthFile({ month: 'March' }), filename: 'b.xlsx', actor: ADMIN });
      expect(p2.requiresNewBrandConfirmation).toBe(false);
      await expect(commitUpload({ stagedUploadId: p2.stagedUploadId, actor: ADMIN })).resolves.toBeTruthy();
    });
  });

  describe('file handling', () => {
    it('never uses the client filename in a path: hostile names are reduced to a base name', async () => {
      const buf = await monthFile({ month: 'February' });
      const p = await validateUpload({ buffer: buf, filename: '../../evil/../x.xlsx', actor: ADMIN });
      expect(p.filename).toBe('x.xlsx');
      const files = fs.readdirSync(stagingDir());
      expect(files).toEqual([`${p.stagedUploadId}.xlsx`]);
    });

    it('rejects wrong type, bad signature and oversize before any parsing', async () => {
      await expect(validateUpload({ buffer: await monthFile({ month: 'February' }), filename: 'a.xlsm', actor: ADMIN })).rejects.toThrow(/\.xlsx/);
      await expect(validateUpload({ buffer: Buffer.from('MZ not a zip'), filename: 'a.xlsx', actor: ADMIN })).rejects.toThrow(/ZIP signature/);
      await expect(validateUpload({ buffer: Buffer.alloc(11 * 1024 * 1024), filename: 'a.xlsx', actor: ADMIN })).rejects.toThrow(/limit/);
      expect(fs.existsSync(stagingDir()) ? fs.readdirSync(stagingDir()) : []).toEqual([]);
    });

    it('a structure error leaves no staged file or row behind', async () => {
      const wb = await templateWb();
      wb.getWorksheet(P1)!.getCell('D5').value = 'Spend';
      await expect(validateUpload({ buffer: await toBuf(wb), filename: 'a.xlsx', actor: ADMIN })).rejects.toThrow(/does not match the MARCOM template/);
      expect(fs.readdirSync(stagingDir())).toEqual([]);
      expect(await count('marcom_staged_upload', '1 = 1')).toBe(0);
    });
  });
});
