/**
 * Last Update / Last Refresh Time -- required at the bottom of the Tachometer page.
 *
 * Ported 1:1 from data/warehouse/measures/refresh_status.py.
 *
 * Manual definitions:
 *   Last Update       - "the latest Odoo sales invoice date included in the page" /
 *                       "the latest sales order date included in the page"
 *   Last Refresh Time - "the time when the page last read and loaded the data"
 *
 *   Last Update       -> MAX(Fact_Orders.OrderDateTime)
 *   Last Refresh Time -> pipeline_run_log.pipeline_end_time for the most recent row with
 *                         status = 'SUCCESS'
 */

import type { Pool } from 'mysql2/promise';

export interface RefreshStatus {
  lastUpdate: Date | null;
  lastRefreshTime: Date | null;
  isStale: boolean;
  isInverted: boolean;
}

const EXPECTED_CYCLE_MINUTES = 180;
const STALE_AFTER_MS = EXPECTED_CYCLE_MINUTES * 60 * 1000 * 1.5;

export async function fetchLastUpdate(pool: Pool): Promise<Date | null> {
  const [rows] = await pool.query('SELECT MAX(OrderDateTime) AS last_update FROM Fact_Orders');
  const row = (rows as any[])[0];
  return row?.last_update ?? null;
}

export async function fetchLastRefreshTime(pool: Pool): Promise<Date | null> {
  try {
    const [rows] = await pool.query(
      'SELECT pipeline_end_time FROM pipeline_run_log WHERE status = "SUCCESS" ORDER BY pipeline_end_time DESC LIMIT 1',
    );
    const row = (rows as any[])[0];
    return row?.pipeline_end_time ?? null;
  } catch (err) {
    return null;
  }
}

export async function fetchRefreshStatus(pool: Pool): Promise<RefreshStatus> {
  const [lastUpdate, lastRefreshTime] = await Promise.all([
    fetchLastUpdate(pool),
    fetchLastRefreshTime(pool),
  ]);
  const isStale =
    lastRefreshTime === null || Date.now() - lastRefreshTime.getTime() > STALE_AFTER_MS;
  // A successful refresh can never legitimately predate the most recent order it was supposed to
  // include -- if it does, either pipeline_run_log has a bad/placeholder timestamp or the ETL
  // read stale data. This should never happen in production; surfacing it beats silently hiding it.
  const isInverted =
    lastUpdate !== null && lastRefreshTime !== null && lastRefreshTime.getTime() < lastUpdate.getTime();
  return { lastUpdate, lastRefreshTime, isStale, isInverted };
}
