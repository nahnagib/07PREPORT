import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pool } from '../db/pool';

/** Outside any web root: OS temp by default, overridable for deployments (must be private). */
export function stagingDir(): string {
  return process.env.MARCOM_STAGING_DIR ?? path.join(os.tmpdir(), '07ps-marcom-staging');
}

export const STAGED_TTL_MINUTES = Number(process.env.MARCOM_STAGED_TTL_MIN ?? 60);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (s: string) => UUID_RE.test(s);

/** Path is built only from a validated UUID -- never from anything the client supplied. */
export function stagedPath(stagedId: string): string {
  if (!isUuid(stagedId)) throw new Error('invalid staged id');
  return path.join(stagingDir(), `${stagedId.toLowerCase()}.xlsx`);
}

export function writeStaged(stagedId: string, buf: Buffer): string {
  fs.mkdirSync(stagingDir(), { recursive: true, mode: 0o700 });
  const p = stagedPath(stagedId);
  fs.writeFileSync(p, buf, { mode: 0o600 });
  return p;
}

export function removeStagedFile(stagedId: string): void {
  try { fs.unlinkSync(stagedPath(stagedId)); } catch { /* already gone */ }
}

/**
 * Deletes expired staged uploads (row + file) and any orphaned file older than the TTL.
 * Runs at startup and on an interval (server.ts), and opportunistically on each validate.
 */
export async function cleanupExpiredStaged(): Promise<{ removed: number }> {
  const [rows] = await pool.query('SELECT staged_id FROM marcom_staged_upload WHERE expires_at < NOW()');
  const ids = (rows as { staged_id: string }[]).map((r) => r.staged_id);
  for (const id of ids) removeStagedFile(id);
  if (ids.length) await pool.query('DELETE FROM marcom_staged_upload WHERE staged_id IN (?)', [ids]);

  let orphans = 0;
  try {
    const cutoff = Date.now() - STAGED_TTL_MINUTES * 60_000 * 2;
    for (const f of fs.readdirSync(stagingDir())) {
      const full = path.join(stagingDir(), f);
      if (fs.statSync(full).mtimeMs < cutoff) { fs.unlinkSync(full); orphans++; }
    }
  } catch { /* directory doesn't exist yet */ }
  return { removed: ids.length + orphans };
}
