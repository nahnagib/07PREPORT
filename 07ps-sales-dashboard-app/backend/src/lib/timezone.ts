import { DateTime } from 'luxon';

/**
 * Every DATETIME column in this warehouse is a naive Libya wall-clock value, not UTC -- either
 * because the Python ETL already localized it from Odoo's UTC before writing (see
 * data/etl/src/sales_pipeline/odoo/sales_report_repository.py's odoo_utc_datetime_to_local,
 * default timezone="Africa/Tripoli"), or because it was written via MySQL's own CURRENT_TIMESTAMP
 * under a Tripoli-zoned DB server (etlRunTracker.ts's queued_at/started_at/finished_at).
 *
 * mysql2 has no option to interpret a naive DATETIME as a specific IANA zone -- its `timezone`
 * config only accepts 'local' (the Node process's own OS zone) or a fixed numeric offset, and the
 * pool intentionally isn't reconfigured globally here (that would touch every other measure's
 * queries, most of which never call this module). Instead, the handful of queries that read a
 * user-facing timestamp CAST/DATE_FORMAT the column to a plain string, and this function is the
 * one place that turns that string into the correct absolute instant.
 *
 * IANA identifier, not a hardcoded +2 -- Libya has no DST today, but this resolves the offset from
 * the runtime's own tz database at call time, so a future rule change needs no code change here.
 */
const DEFAULT_APP_TIMEZONE = 'Africa/Tripoli';

/** The single configured business/display timezone (APP_TIMEZONE, IANA id). It is BOTH the zone the
 * naive business fact columns (Fact_Orders.OrderDateTime/QuotationDate, ...) are stored in -- it must
 * equal the ETL's TIMEZONE, the refresh check flags a mismatch -- and the zone shown to users.
 * Operational metadata (etl_run_log.*_utc) is UTC and is never converted with this. Read lazily so
 * tests can set the variable. An invalid value falls back to the default rather than throwing on
 * every request. */
export function getAppTimezone(): string {
  const configured = process.env.APP_TIMEZONE?.trim();
  return configured && DateTime.local().setZone(configured).isValid ? configured : DEFAULT_APP_TIMEZONE;
}

/** `raw` is a naive 'YYYY-MM-DD HH:mm:ss'-style string, as produced by
 * `DATE_FORMAT(col, '%Y-%m-%d %H:%i:%s')` (or MySQL's default string rendering of a DATETIME).
 * Returns a `Date` whose absolute instant is correct regardless of the Node process's own OS
 * timezone -- callers keep working with a plain `Date` exactly as before (`.getTime()`,
 * `res.json()`'s automatic `.toISOString()`, etc.), nothing downstream needs to change. */
export function tripoliSqlDateTimeToDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const dt = DateTime.fromSQL(raw, { zone: getAppTimezone() });
  return dt.isValid ? dt.toJSDate() : null;
}

/** Same as above for columns that hold a UTC wall-clock value: the `*_utc` columns of etl_run_log and
 * TIMESTAMP columns read under the pool's `SET time_zone = '+00:00'` session (etl_job_runs). */
export function utcSqlDateTimeToDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const dt = DateTime.fromSQL(raw, { zone: 'utc' });
  return dt.isValid ? dt.toJSDate() : null;
}
