import type { Pool, RowDataPacket } from 'mysql2/promise';
export const DEFAULT_DAILY_CRITICAL_NUMBER = 560_000;
export function validateCriticalNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1_000_000_000_000 || Math.abs(Math.round(value * 100) - value * 100) > 0.0001) throw new Error('Enter a positive LYD amount with at most two decimal places');
  return value;
}
export async function readCriticalNumber(pool: Pool): Promise<number> {
  try {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT numeric_value FROM dashboard_setting WHERE setting_key = 'daily_critical_number'");
    return rows.length ? Number(rows[0].numeric_value) : DEFAULT_DAILY_CRITICAL_NUMBER;
  } catch (error) {
    if ((error as { code?: string }).code === 'ER_NO_SUCH_TABLE') return DEFAULT_DAILY_CRITICAL_NUMBER;
    throw error;
  }
}
