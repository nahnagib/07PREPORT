import { resetMarcom, DATA_TABLES } from './helpers/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { pool } from '../../db/pool';
import { seedDemo, unseedDemo } from '../demo/demoSeed';
import { commitUpload, validateUpload } from '../service';
import { stagingDir } from '../staging';
import { spendingPage, campaignsPage, digitalPage, tradePage } from '../../marcomKpi/pages';
import { spendFile } from './helpers/workbooks';

const RUN_DB = process.env.MARCOM_TEST_DB === '1';
let admin = 0;

const count = async (t: string, where = '1 = 1') =>
  ((await pool.query(`SELECT COUNT(*) AS n FROM ${t} WHERE ${where}`)) as [{ n: number }[], unknown])[0][0].n;

describe.skipIf(!RUN_DB)('demo seed (DB-backed, same path as a real upload)', () => {
  beforeAll(async () => {
    const email = 'marcom.demo.admin@test.local';
    const [ex] = (await pool.query('SELECT user_id FROM app_user WHERE email = ?', [email])) as [{ user_id: number }[], unknown];
    if (ex[0]) admin = ex[0].user_id;
    else {
      const [r] = await pool.query(
        `INSERT INTO app_user (email, display_name, role_id, status, must_change_password, password_hash)
         VALUES (?, 'demo admin', (SELECT role_id FROM roles WHERE role_name = 'ADMIN'), 'ACTIVE', 0, 'x')`, [email]);
      admin = (r as { insertId: number }).insertId;
    }
  });
  afterAll(async () => {
    await resetMarcom(pool);
    fs.rmSync(stagingDir(), { recursive: true, force: true });
    await pool.end();
  });
  beforeEach(async () => { await resetMarcom(pool); });

  it('loads 4 labelled batches; the four pages then have data, 4 brands, LYTD, 8 campaigns, 20 events, fresh to August 2026', async () => {
    const res = await seedDemo({ userId: admin });
    expect(res).toHaveLength(4);
    const [batches] = (await pool.query('SELECT filename, status FROM marcom_upload_batch ORDER BY batch_id')) as [{ filename: string; status: string }[], unknown];
    expect(batches.every((b) => b.filename.startsWith('DEMO SEED') && b.status === 'SUCCESS')).toBe(true);

    const s = await spendingPage({});
    expect(s).toMatchObject({ hasData: true, filters: { year: 2026, fromMonth: 1, toMonth: 8 } });
    expect(s.filters.brands).toHaveLength(4);
    expect(s.roi.lytd).not.toBeNull();
    expect(s.meta.missing).toEqual([]);
    expect(s.budgetUtilization.brands.filter((b) => b.overBudget)).toHaveLength(1);
    expect(s.freshness).toMatchObject({ hasData: true, latestPeriod: { year: 2026, month: 8 } });

    const c = await campaignsPage({ toMonth: '12' });
    expect(c.timeline).toHaveLength(8);
    expect(c.coverageByType.types.every((t) => t.units > 0)).toBe(true);

    const d = await digitalPage({});
    expect(d.followers.platforms).toHaveLength(5);
    expect(new Set(d.ctr.byPlatform.map((p) => p.kpi.status))).toEqual(new Set(['green', 'yellow', 'red']));

    const t = await tradePage({ toMonth: '12' });
    expect(t.eventsTimeline).toHaveLength(20);
    expect(t.eventsTimeline.some((e) => e.overdue)).toBe(true);
  });

  it('one command removes it all, through rollback, leaving the tables empty and brands removed', async () => {
    await seedDemo({ userId: admin });
    const r = await unseedDemo({ userId: admin });
    expect(r.removed).toBe(4);
    for (const t of DATA_TABLES) expect(await count(t)).toBe(0);
    expect(await count('marcom_brand')).toBe(0);
    expect(await count('marcom_upload_batch', "status = 'ROLLED_BACK'")).toBe(4);
    expect((await spendingPage({})).hasData).toBe(false);
    expect(await unseedDemo({ userId: admin })).toEqual({ removed: 0 }); // idempotent
  });

  it('refuses to double-seed, and refuses to seed next to real uploads', async () => {
    await seedDemo({ userId: admin });
    await expect(seedDemo({ userId: admin })).rejects.toThrow(/already loaded/);
    await unseedDemo({ userId: admin });

    const real = await validateUpload({ buffer: await spendFile([[2026, 'May', 'Real Brand', 1, 1, 1, 1, 1, 1, 1, 1, 1]]), filename: 'real.xlsx', actor: { id: admin } });
    await commitUpload({ stagedUploadId: real.stagedUploadId, actor: { id: admin }, confirmNewBrands: true });
    await expect(seedDemo({ userId: admin })).rejects.toThrow(/Real MARCOM uploads exist/);
  });

  it('unseed refuses when a real upload sits on top of the demo data', async () => {
    await seedDemo({ userId: admin });
    const real = await validateUpload({ buffer: await spendFile([[2026, 'May', 'Real Brand', 1, 1, 1, 1, 1, 1, 1, 1, 1]]), filename: 'real.xlsx', actor: { id: admin } });
    await commitUpload({ stagedUploadId: real.stagedUploadId, actor: { id: admin }, confirmNewBrands: true });
    await expect(unseedDemo({ userId: admin })).rejects.toThrow(/real upload sitting on top/);
    expect(await count('marcom_upload_batch', "status = 'SUCCESS'")).toBe(5); // nothing was rolled back
  });
});
