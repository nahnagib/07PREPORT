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
 *
 * lastOrderCreated is a separate, later addition: Odoo's sale.order.create_date (when the record
 * was first created), distinct from date_order/OrderDateTime above (the order/confirmation date --
 * the two can differ by minutes, e.g. a quotation created and confirmed to a Sales Order a little
 * later). Same MAX(Fact_Orders.CreatedDateTime) aggregate shape as lastUpdate, so it can legitimately
 * point at a different order than lastUpdate does -- the most recently *created* order isn't
 * necessarily the one with the latest *order date*.
 */

import type { Pool } from 'mysql2/promise';
import { tripoliSqlDateTimeToDate } from '../lib/timezone';

export interface RefreshStatus {
  lastUpdate: Date | null;
  lastOrderCreated: Date | null;
  lastRefreshTime: Date | null;
  isStale: boolean;
  isInverted: boolean;
}

const EXPECTED_CYCLE_MINUTES = 180;
const STALE_AFTER_MS = EXPECTED_CYCLE_MINUTES * 60 * 1000 * 1.5;

/** OrderDateTime/pipeline_end_time are naive DATETIME columns storing Libya wall-clock time (see
 * lib/timezone.ts's header) -- DATE_FORMAT'd to a plain string here so mysql2's own 'local'-zone
 * Date conversion (which would misread this as whatever OS timezone the Node process happens to
 * run under) never gets a chance to run; tripoliSqlDateTimeToDate is the one place that then
 * interprets it correctly, as Africa/Tripoli specifically. */
export async function fetchLastUpdate(pool: Pool): Promise<Date | null> {
  const [rows] = await pool.query(
    "SELECT DATE_FORMAT(MAX(OrderDateTime), '%Y-%m-%d %H:%i:%s') AS last_update FROM Fact_Orders",
  );
  const row = (rows as any[])[0];
  return tripoliSqlDateTimeToDate(row?.last_update ?? null);
}

/** Same DATE_FORMAT'd-string-then-tripoliSqlDateTimeToDate handling as fetchLastUpdate -- see this
 * file's header for what "created" means here and why it's sourced/aggregated separately from
 * OrderDateTime.
 *
 * Fact_Orders has no literal CreatedDateTime column (confirmed via SHOW COLUMNS against the live
 * warehouse -- querying it threw "Unknown column" on every single call, which is what was
 * actually blanking out both header fields, not a missing-data-for-today condition: this and
 * fetchLastUpdate run via Promise.all in fetchRefreshStatus below, so this query throwing took
 * fetchLastUpdate's otherwise-valid result down with it too).
 *
 * Odoo's sale.order.create_date is written to the QuotationDate column instead (see
 * data/etl/src/sales_pipeline/facts/fact_sales.py's SalesFactBuilder.build: `order_create_date =
 * ...orders.get("create_date")...; out["QuotationDate"] = order_create_date.combine_first(...
 * OrderDateTime)` -- create_date falling back to date_order/OrderDateTime only when Odoo's
 * create_date itself is missing). MAX(QuotationDate) already returns the most recent real order
 * regardless of whether today's ETL run has landed yet -- no separate fallback logic needed here. */
export async function fetchLastOrderCreated(pool: Pool): Promise<Date | null> {
  const [rows] = await pool.query(
    "SELECT DATE_FORMAT(MAX(QuotationDate), '%Y-%m-%d %H:%i:%s') AS last_created FROM Fact_Orders",
  );
  const row = (rows as any[])[0];
  return tripoliSqlDateTimeToDate(row?.last_created ?? null);
}

export async function fetchLastRefreshTime(pool: Pool): Promise<Date | null> {
  try {
    const [rows] = await pool.query(
      `SELECT DATE_FORMAT(pipeline_end_time, '%Y-%m-%d %H:%i:%s') AS pipeline_end_time
       FROM pipeline_run_log WHERE status = "SUCCESS" ORDER BY pipeline_end_time DESC LIMIT 1`,
    );
    const row = (rows as any[])[0];
    return tripoliSqlDateTimeToDate(row?.pipeline_end_time ?? null);
  } catch (err) {
    return null;
  }
}

export async function fetchRefreshStatus(pool: Pool): Promise<RefreshStatus> {
  const [lastUpdate, lastOrderCreated, lastRefreshTime] = await Promise.all([
    fetchLastUpdate(pool),
    fetchLastOrderCreated(pool),
    fetchLastRefreshTime(pool),
  ]);
  const isStale =
    lastRefreshTime === null || Date.now() - lastRefreshTime.getTime() > STALE_AFTER_MS;
  // A successful refresh can never legitimately predate the most recent order it was supposed to
  // include -- if it does, either pipeline_run_log has a bad/placeholder timestamp or the ETL
  // read stale data. This should never happen in production; surfacing it beats silently hiding it.
  const isInverted =
    lastUpdate !== null && lastRefreshTime !== null && lastRefreshTime.getTime() < lastUpdate.getTime();
  return { lastUpdate, lastOrderCreated, lastRefreshTime, isStale, isInverted };
}
