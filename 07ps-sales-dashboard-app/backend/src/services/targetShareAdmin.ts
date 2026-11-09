import { DateTime } from 'luxon';
import { pool } from '../db/pool';
import { getAppTimezone } from '../lib/timezone';
import { computeTargetShare } from '../measures/criticalNumber';
import type { Filters } from '../measures/filters';

/**
 * Admin > Companies / Customer Groups "Share of FY target (from sales_targets.xlsx)": read-only, the same
 * computeTargetShare the Critical Number page uses, for the current business year (APP_TIMEZONE). Replaced the
 * hand-typed critical_number_pct (2026-11-09); that column stays in the database, unused.
 *
 * Percent (0-100), or null when the row is not linked to an ETL key or the targets cannot be read (logged) -- an admin
 * list must not fail because of it.
 */
export async function targetSharePct(filters: Filters | null): Promise<number | null> {
  if (filters === null) return null;
  try {
    const year = DateTime.now().setZone(getAppTimezone()).year;
    const { share, shareSource } = await computeTargetShare(pool, filters, year);
    return shareSource === 'missing' ? null : share * 100;
  } catch (err) {
    console.error(`[targetShareAdmin] share of FY target failed for filters=${JSON.stringify(filters)}`, err);
    return null;
  }
}
