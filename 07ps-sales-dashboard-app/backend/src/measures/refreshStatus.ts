/**
 * Last Update / Last Refresh Time -- required at the bottom of the Tachometer page -- and the
 * consistency check behind the "Refresh log looks wrong" banner. See docs/ETL.md sections 8-9.
 *
 *   Last Update       -> MAX(Fact_Orders.OrderDateTime)   (business-timezone wall-clock)
 *   Last Order Created-> MAX(Fact_Orders.QuotationDate)   (Odoo create_date; business-timezone wall-clock)
 *   Last Refresh Time -> etl_run_log.finished_at_utc of the most recent status = 'success' row
 *                        (UTC; written by the pipeline only after the load + validation passed, in
 *                        the same transaction that stores the watermark)
 *
 * Every instant is normalised to a UTC `Date` before any comparison; the display timezone
 * (APP_TIMEZONE) is only applied by the presentation layer. The check compares the loaded watermark
 * with what is actually in the target tables -- never with the live source -- and tolerates
 * REFRESH_CHECK_TOLERANCE_MINUTES (default 5) of skew.
 */

import type { Pool } from 'mysql2/promise';
import { DateTime } from 'luxon';
import { getAppTimezone, tripoliSqlDateTimeToDate, utcSqlDateTimeToDate } from '../lib/timezone';

export type RefreshCheckStatus =
  | 'ok'
  | 'no_refresh_log'
  | 'refresh_before_data'
  | 'data_ahead_of_watermark'
  | 'timezone_mismatch'
  | 'last_run_failed_after_load';

export interface RefreshCheck {
  status: RefreshCheckStatus;
  /** false only for a genuine inconsistency (drives the red banner); 'no_refresh_log' is a setup
   * gap, reported but not treated as "the log is wrong". */
  inconsistent: boolean;
  message: string;
  /** What the admin should do about it; null when status is 'ok'. */
  action: string | null;
  timezone: string;
  toleranceMinutes: number;
  lastRefreshUtc: string | null;
  latestLoadedOrderUtc: string | null;
  watermarkOrderCreatedUtc: string | null;
  /** latest loaded order minus last refresh, in minutes (positive = order is newer than the refresh). */
  differenceMinutes: number | null;
}

export interface RefreshStatus {
  lastUpdate: Date | null;
  lastOrderCreated: Date | null;
  lastRefreshTime: Date | null;
  isStale: boolean;
  /** Kept for the existing frontend contract: true iff refreshCheck.inconsistent. */
  isInverted: boolean;
  refreshCheck: RefreshCheck;
  displayTimezone: string;
}

export interface LastSuccessfulRun {
  runUid: string;
  finishedAtUtc: Date;
  watermarkOrderDateUtc: Date | null;
  watermarkOrderCreatedUtc: Date | null;
  businessTimezone: string | null;
  legacyBackfill: boolean;
}

/** A run that failed AFTER writing the tables (see etl_run_log.finish_failed(data_loaded=True)): it
 * explains data newer than the last success, so that data is not "unaccounted for". */
export interface FailedAfterLoadRun {
  runUid: string;
  finishedAtUtc: Date;
  watermarkOrderCreatedUtc: Date;
}

export interface RefreshCheckInput {
  lastRun: LastSuccessfulRun | null;
  /** The latest such run that finished after `lastRun`, if any. */
  failedAfterLoad?: FailedAfterLoadRun | null;
  /** MAX(QuotationDate) / MAX(OrderDateTime) of the loaded Fact_Orders, already converted to UTC. */
  targetOrderCreatedUtc: Date | null;
  targetOrderDateUtc: Date | null;
  toleranceMinutes: number;
  /** The backend's business/display zone (APP_TIMEZONE). */
  appTimezone: string;
}

const DEFAULT_TOLERANCE_MINUTES = 5;
const DEFAULT_STALE_AFTER_MINUTES = 270; // 1.5 x the 180-minute expected refresh cycle
const MS_PER_MINUTE = 60_000;

export function getToleranceMinutes(): number {
  const parsed = Number(process.env.REFRESH_CHECK_TOLERANCE_MINUTES);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TOLERANCE_MINUTES;
}

function getStaleAfterMs(): number {
  const parsed = Number(process.env.REFRESH_STALE_AFTER_MINUTES);
  return (Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STALE_AFTER_MINUTES) * MS_PER_MINUTE;
}

const minutesBetween = (later: Date, earlier: Date): number => (later.getTime() - earlier.getTime()) / MS_PER_MINUTE;
const fmt = (d: Date | null, zone: string): string =>
  d ? `${DateTime.fromJSDate(d).setZone(zone).toFormat('yyyy-LL-dd HH:mm')} ${zone}` : '—';
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/**
 * Pure decision function (unit-tested with fixed instants). Only reports a problem when the refresh
 * log is genuinely inconsistent with the data in the target tables:
 *
 *  1. no successful run recorded            -> 'no_refresh_log' (setup gap, not "wrong")
 *  2. the run converted with another zone   -> 'timezone_mismatch' (ETL TIMEZONE != APP_TIMEZONE)
 *  3. target holds orders newer than every recorded run's watermark (beyond tolerance)
 *                                           -> 'data_ahead_of_watermark' (a run loaded data but never
 *                                              recorded it, or data was loaded outside the ETL)
 *  4. last refresh predates the newest loaded order's creation time (beyond tolerance) and no failed
 *     run explains it                       -> 'refresh_before_data' (clock skew / timezone bug: a
 *                                              refresh cannot finish before the order it loaded exists)
 *  5. otherwise, if the newest run failed after loading -> 'last_run_failed_after_load' (informational:
 *     the log is accurate, the last run just did not complete; not an inconsistency)
 *
 * A failed-after-load run counts as an explanation for checks 3 and 4: the log recorded what it wrote.
 */
export function evaluateRefreshConsistency(input: RefreshCheckInput): RefreshCheck {
  const { lastRun, targetOrderCreatedUtc, toleranceMinutes, appTimezone } = input;
  const base = {
    timezone: appTimezone,
    toleranceMinutes,
    lastRefreshUtc: iso(lastRun?.finishedAtUtc ?? null),
    latestLoadedOrderUtc: iso(targetOrderCreatedUtc),
    watermarkOrderCreatedUtc: iso(lastRun?.watermarkOrderCreatedUtc ?? null),
    differenceMinutes:
      lastRun && targetOrderCreatedUtc ? Math.round(minutesBetween(targetOrderCreatedUtc, lastRun.finishedAtUtc) * 10) / 10 : null,
  };

  if (!lastRun) {
    return {
      ...base,
      status: 'no_refresh_log',
      inconsistent: false,
      message: 'No successful ETL run is recorded in etl_run_log, so "Last Refresh" is unknown.',
      action:
        'Start an ETL run from Admin -> ETL Control Center. If this database has run before, apply migration 0022 and run data/etl/scripts/backfill_etl_run_log.py once.',
    };
  }

  if (lastRun.businessTimezone && lastRun.businessTimezone !== appTimezone) {
    return {
      ...base,
      status: 'timezone_mismatch',
      inconsistent: true,
      message:
        `The last refresh was loaded with business timezone ${lastRun.businessTimezone} but the backend reads it as ${appTimezone}; ` +
        'order times cannot be compared reliably.',
      action: 'Set the ETL TIMEZONE and the backend APP_TIMEZONE to the same IANA zone, then run a full refresh.',
    };
  }

  const zoneLabel = appTimezone;
  const describe = (order: Date | null, diff: number | null) =>
    `Last refresh ${fmt(lastRun.finishedAtUtc, zoneLabel)}, latest loaded order ${fmt(order, zoneLabel)}, ` +
    `difference ${diff === null ? '—' : Math.abs(Math.round(diff))} min, timezone ${zoneLabel}`;

  const failed = input.failedAfterLoad ?? null;
  // The newest thing the log accounts for: the later of the last success and any failed-after-load run.
  const accountedWatermark = [lastRun.watermarkOrderCreatedUtc, failed?.watermarkOrderCreatedUtc]
    .filter((d): d is Date => d != null)
    .reduce<Date | null>((max, d) => (max === null || d > max ? d : max), null);
  const accountedFinish = failed && failed.finishedAtUtc > lastRun.finishedAtUtc ? failed.finishedAtUtc : lastRun.finishedAtUtc;

  if (accountedWatermark && targetOrderCreatedUtc && minutesBetween(targetOrderCreatedUtc, accountedWatermark) > toleranceMinutes) {
    const gap = minutesBetween(targetOrderCreatedUtc, accountedWatermark);
    return {
      ...base,
      status: 'data_ahead_of_watermark',
      inconsistent: true,
      message:
        `${describe(targetOrderCreatedUtc, base.differenceMinutes)}. The tables hold orders ${Math.round(gap)} min newer than the newest run recorded in etl_run_log ` +
        `(watermark ${fmt(accountedWatermark, zoneLabel)}): a run loaded data but did not record it, or data was loaded outside the ETL.`,
      action: 'Open Admin -> ETL Runs, check the most recent failed run, then start an incremental refresh so a successful run records the current data.',
    };
  }

  if (targetOrderCreatedUtc && minutesBetween(targetOrderCreatedUtc, accountedFinish) > toleranceMinutes) {
    return {
      ...base,
      status: 'refresh_before_data',
      inconsistent: true,
      message:
        `${describe(targetOrderCreatedUtc, base.differenceMinutes)}. A refresh cannot finish before the newest order it loaded was created.`,
      action:
        'Check that ETL TIMEZONE, APP_TIMEZONE and the DB session time_zone are set, and that the app, DB and ETL server clocks agree (NTP). If rows predate the UTC fix, run the etl_run_log backfill.',
    };
  }

  if (failed) {
    return {
      ...base,
      status: 'last_run_failed_after_load',
      inconsistent: false,
      message:
        `${describe(targetOrderCreatedUtc, base.differenceMinutes)}. The latest ETL run (${fmt(failed.finishedAtUtc, zoneLabel)}) failed after loading data; ` +
        '"Last refresh" still refers to the last fully successful run.',
      action: 'Open Admin -> ETL Runs, fix the cause of the failed run and start an incremental refresh.',
    };
  }

  return {
    ...base,
    status: 'ok',
    inconsistent: false,
    message: describe(targetOrderCreatedUtc, base.differenceMinutes),
    action: null,
  };
}

/** Business-timezone naive DATETIME aggregate -> UTC instant. DATE_FORMAT'd to a plain string so
 * mysql2's own Date conversion (which would read it in the Node process's OS zone) never runs. */
async function fetchTargetMax(pool: Pool, column: 'OrderDateTime' | 'QuotationDate'): Promise<Date | null> {
  try {
    const [rows] = await pool.query(
      `SELECT DATE_FORMAT(MAX(${column}), '%Y-%m-%d %H:%i:%s') AS v FROM Fact_Orders`,
    );
    return tripoliSqlDateTimeToDate((rows as any[])[0]?.v ?? null);
  } catch (err) {
    // Unknown column / missing table (1054 / 1146): Fact_Orders only has QuotationDate when Fact_Sales
    // had rows to align it with, so "unknown" is a legitimate answer. Anything else (connection loss,
    // permissions) is a real failure and still propagates.
    const errno = (err as { errno?: number }).errno;
    if (errno === 1054 || errno === 1146) return null;
    throw err;
  }
}

export const fetchLastUpdate = (pool: Pool) => fetchTargetMax(pool, 'OrderDateTime');

/** Fact_Orders has no literal CreatedDateTime column: Odoo's sale.order.create_date is written to
 * QuotationDate (data/etl/src/sales_pipeline/facts/fact_sales.py), falling back to date_order only
 * when create_date itself is missing. */
export const fetchLastOrderCreated = (pool: Pool) => fetchTargetMax(pool, 'QuotationDate');

/** The most recent successful run, or null if etl_run_log is missing/empty (migration 0022 not applied). */
export async function fetchLastSuccessfulRun(pool: Pool): Promise<LastSuccessfulRun | null> {
  try {
    const [rows] = await pool.query(
      `SELECT run_uid,
              DATE_FORMAT(finished_at_utc, '%Y-%m-%d %H:%i:%s') AS finished_at_utc,
              DATE_FORMAT(watermark_order_date_utc, '%Y-%m-%d %H:%i:%s') AS watermark_order_date_utc,
              DATE_FORMAT(watermark_order_created_utc, '%Y-%m-%d %H:%i:%s') AS watermark_order_created_utc,
              business_timezone, legacy_backfill
       FROM etl_run_log
       WHERE status = 'success' AND finished_at_utc IS NOT NULL
       ORDER BY finished_at_utc DESC, run_id DESC LIMIT 1`,
    );
    const row = (rows as any[])[0];
    const finished = utcSqlDateTimeToDate(row?.finished_at_utc ?? null);
    if (!row || !finished) return null;
    return {
      runUid: row.run_uid,
      finishedAtUtc: finished,
      watermarkOrderDateUtc: utcSqlDateTimeToDate(row.watermark_order_date_utc),
      watermarkOrderCreatedUtc: utcSqlDateTimeToDate(row.watermark_order_created_utc),
      businessTimezone: row.business_timezone ?? null,
      legacyBackfill: Boolean(row.legacy_backfill),
    };
  } catch {
    return null;
  }
}

/** The newest run that FAILED after writing the tables and finished after `since` (the last success). */
export async function fetchFailedAfterLoad(pool: Pool, since: Date | null): Promise<FailedAfterLoadRun | null> {
  try {
    const [rows] = await pool.query(
      `SELECT run_uid,
              DATE_FORMAT(finished_at_utc, '%Y-%m-%d %H:%i:%s') AS finished_at_utc,
              DATE_FORMAT(watermark_order_created_utc, '%Y-%m-%d %H:%i:%s') AS watermark_order_created_utc
       FROM etl_run_log
       WHERE status = 'failed' AND watermark_order_created_utc IS NOT NULL AND finished_at_utc IS NOT NULL
       ORDER BY finished_at_utc DESC, run_id DESC LIMIT 1`,
    );
    const row = (rows as any[])[0];
    const finished = utcSqlDateTimeToDate(row?.finished_at_utc ?? null);
    const watermark = utcSqlDateTimeToDate(row?.watermark_order_created_utc ?? null);
    if (!row || !finished || !watermark || (since && finished <= since)) return null;
    return { runUid: row.run_uid, finishedAtUtc: finished, watermarkOrderCreatedUtc: watermark };
  } catch {
    return null;
  }
}

export async function fetchRefreshStatus(pool: Pool): Promise<RefreshStatus> {
  const [lastUpdate, lastOrderCreated, lastRun] = await Promise.all([
    fetchLastUpdate(pool),
    fetchLastOrderCreated(pool),
    fetchLastSuccessfulRun(pool),
  ]);
  const failedAfterLoad = lastRun ? await fetchFailedAfterLoad(pool, lastRun.finishedAtUtc) : null;
  const lastRefreshTime = lastRun?.finishedAtUtc ?? null;
  const isStale = lastRefreshTime === null || Date.now() - lastRefreshTime.getTime() > getStaleAfterMs();
  const refreshCheck = evaluateRefreshConsistency({
    lastRun,
    failedAfterLoad,
    targetOrderCreatedUtc: lastOrderCreated,
    targetOrderDateUtc: lastUpdate,
    toleranceMinutes: getToleranceMinutes(),
    appTimezone: getAppTimezone(),
  });
  return {
    lastUpdate,
    lastOrderCreated,
    lastRefreshTime,
    isStale,
    isInverted: refreshCheck.inconsistent,
    refreshCheck,
    displayTimezone: getAppTimezone(),
  };
}
