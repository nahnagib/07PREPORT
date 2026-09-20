import { pool } from '../../db/pool';
import { commitUpload, rollbackBatch, validateUpload } from '../service';
import { buildDemoDataset } from './demoData';
import { DEMO_LABEL, buildDemoWorkbooks } from './demoWorkbooks';

export interface GuardEnv {
  NODE_ENV?: string;
  DB_HOST?: string;
  DB_NAME?: string;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const DEV_NAME = /(dev|test|demo|local|sandbox)/i;

/**
 * Hard guard for the demo seed (and its removal). Refuses when:
 *  - NODE_ENV is production;
 *  - the DB host is not this machine;
 *  - the DB name does not look like a dev/test database -- unless `acknowledgedDev` is set (the
 *    explicit --i-know-this-is-dev flag), for local databases with an ordinary name.
 * Returns the reason string when refusing, null when allowed.
 */
export function demoSeedRefusal(env: GuardEnv, acknowledgedDev = false): string | null {
  if ((env.NODE_ENV ?? '').toLowerCase() === 'production') return 'NODE_ENV is production.';
  const host = (env.DB_HOST ?? 'localhost').toLowerCase();
  if (!LOCAL_HOSTS.has(host)) return `DB_HOST "${host}" is not this machine (only localhost / 127.0.0.1 are allowed).`;
  const name = env.DB_NAME ?? '';
  if (!DEV_NAME.test(name) && !acknowledgedDev) {
    return `DB_NAME "${name}" does not look like a dev database. Re-run with --i-know-this-is-dev if it is one.`;
  }
  return null;
}

async function adminActor(userId?: number): Promise<number> {
  if (userId) return userId;
  const [rows] = await pool.query(
    `SELECT u.user_id FROM app_user u JOIN roles r ON r.role_id = u.role_id
      WHERE r.role_name = 'ADMIN' AND u.status = 'ACTIVE' ORDER BY u.user_id LIMIT 1`,
  );
  const id = (rows as { user_id: number }[])[0]?.user_id;
  if (!id) throw new Error('No active ADMIN user found to attribute the demo batches to (pass --user-id).');
  return id;
}

async function batchCounts(): Promise<{ demo: number; real: number }> {
  const [rows] = await pool.query(
    `SELECT SUM(filename LIKE ?) AS demo, SUM(filename NOT LIKE ?) AS real_ FROM marcom_upload_batch WHERE status = 'SUCCESS'`,
    [`${DEMO_LABEL}%`, `${DEMO_LABEL}%`],
  );
  const r = (rows as { demo: string | null; real_: string | null }[])[0];
  return { demo: Number(r?.demo ?? 0), real: Number(r?.real_ ?? 0) };
}

/** Loads the demo dataset through the normal validate -> commit path (one batch per file). */
export async function seedDemo(opts: { userId?: number; log?: (m: string) => void } = {}) {
  const log = opts.log ?? (() => undefined);
  const counts = await batchCounts();
  if (counts.real > 0) throw new Error('Real MARCOM uploads exist in this database; refusing to add demo data next to them.');
  if (counts.demo > 0) throw new Error('Demo data is already loaded. Run the unseed command first.');

  const actor = { id: await adminActor(opts.userId) };
  const data = buildDemoDataset();
  const results = [];
  for (const chunk of await buildDemoWorkbooks(data)) {
    const preview = await validateUpload({ buffer: chunk.buffer, filename: chunk.filename, actor });
    if (preview.errorCount > 0) {
      throw new Error(`Demo file "${chunk.label}" has ${preview.errorCount} error(s): ${preview.issues.filter((i) => i.severity === 'error').slice(0, 3).map((i) => `${i.sheet}!${i.cell} ${i.message}`).join(' | ')}`);
    }
    const res = await commitUpload({ stagedUploadId: preview.stagedUploadId, actor, confirmNewBrands: true });
    log(`${chunk.label}: batch #${res.batchId} - ${res.totals.inserted} inserted`);
    results.push({ label: chunk.label, batchId: res.batchId, inserted: res.totals.inserted });
  }
  return results;
}

/** Removes the demo data by rolling back the demo batches, newest first (the normal rollback path). */
export async function unseedDemo(opts: { userId?: number; log?: (m: string) => void } = {}) {
  const log = opts.log ?? (() => undefined);
  const actor = { id: await adminActor(opts.userId) };
  let removed = 0;
  if ((await batchCounts()).demo === 0) return { removed };
  for (;;) {
    const [rows] = await pool.query("SELECT batch_id, filename FROM marcom_upload_batch WHERE status = 'SUCCESS' ORDER BY batch_id DESC LIMIT 1");
    const latest = (rows as { batch_id: number; filename: string }[])[0];
    if (!latest || (await batchCounts()).demo === 0) break;
    if (!latest.filename.startsWith(DEMO_LABEL)) {
      throw new Error(`The latest batch (#${latest.batch_id}, "${latest.filename}") is a real upload sitting on top of the demo data. Roll it back first.`);
    }
    await rollbackBatch({ batchId: latest.batch_id, actor, reason: 'DEMO SEED removed' });
    log(`rolled back batch #${latest.batch_id}`);
    removed++;
  }
  return { removed };
}
