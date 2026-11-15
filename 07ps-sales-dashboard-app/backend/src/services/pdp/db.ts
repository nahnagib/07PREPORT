import type { Pool, PoolConnection } from 'mysql2/promise';
import { pool } from '../../db/pool';

/** A pool or a connection inside a transaction: every PDP query helper takes one. */
export type Db = Pool | PoolConnection;

export async function rows<T>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  const [r] = await db.query(sql, params);
  return r as T[];
}

export async function one<T>(db: Db, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await rows<T>(db, sql, params))[0];
}

export async function exec(db: Db, sql: string, params: unknown[] = []): Promise<{ insertId: number; affectedRows: number }> {
  const [r] = await db.query(sql, params);
  return r as { insertId: number; affectedRows: number };
}

/** Runs `fn` in one transaction: commit on success, rollback on any error. */
// eslint-disable-next-line no-unused-vars -- parameter name of a function type (the base rule misreads it)
export async function inTransaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (err) {
    await conn.rollback().catch(() => undefined);
    throw err;
  } finally {
    conn.release();
  }
}

/** A DATE column as YYYY-MM-DD. The pool reads in UTC (db/pool.ts `timezone: 'Z'`), so a DATE is UTC midnight. */
export function isoDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/** A DATETIME column (written by CURRENT_TIMESTAMP under the pool's UTC session) as an ISO instant ("...Z"). */
export function isoDateTime(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v).replace(' ', 'T');
  return s.endsWith('Z') ? s : `${s}Z`;
}
