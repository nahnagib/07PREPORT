import './env';
import mysql from 'mysql2/promise';

export async function dbAvailable(): Promise<boolean> {
  try {
    const c = await mysql.createConnection({
      host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER,
      password: process.env.DB_PASSWORD, database: process.env.DB_NAME, connectTimeout: 2000,
    });
    const [r] = await c.query("SHOW TABLES LIKE 'marcom_upload_batch'");
    await c.end();
    return (r as unknown[]).length > 0;
  } catch {
    if (process.env.MARCOM_REQUIRE_TEST_DB === '1') throw new Error('MARCOM test DB required but unavailable');
    return false;
  }
}

export const DATA_TABLES = [
  'marcom_spend_monthly', 'marcom_campaign', 'marcom_campaign_media', 'marcom_social_monthly',
  'marcom_web_monthly', 'marcom_trade_monthly', 'marcom_event',
] as const;

/** Wipes MARCOM data (tests only -- env.ts guarantees this is the throwaway database). */
export async function resetMarcom(pool: { query: (s: string) => Promise<unknown> }) {
  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of [...DATA_TABLES, 'marcom_brand', 'marcom_upload_batch', 'marcom_staged_upload']) {
    await pool.query(`TRUNCATE TABLE ${t}`);
  }
  await pool.query('SET FOREIGN_KEY_CHECKS = 1');
}

/** Every column of every data table except updated_at, in id order -- for exact before/after comparisons. */
export async function snapshot(pool: { query: (s: string) => Promise<[unknown, unknown]> }) {
  const out: Record<string, unknown[]> = {};
  for (const t of [...DATA_TABLES, 'marcom_brand']) {
    const [rows] = await pool.query(`SELECT * FROM ${t} ORDER BY ${t === 'marcom_brand' ? 'brand_id' : 'id'}`);
    out[t] = (rows as Record<string, unknown>[]).map((r) => { const { updated_at, ...rest } = r; void updated_at; return rest; });
  }
  return out;
}
