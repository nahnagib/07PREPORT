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
const BUSINESS_TIMEZONE = 'Africa/Tripoli';

/** `raw` is a naive 'YYYY-MM-DD HH:mm:ss'-style string, as produced by
 * `DATE_FORMAT(col, '%Y-%m-%d %H:%i:%s')` (or MySQL's default string rendering of a DATETIME).
 * Returns a `Date` whose absolute instant is correct regardless of the Node process's own OS
 * timezone -- callers keep working with a plain `Date` exactly as before (`.getTime()`,
 * `res.json()`'s automatic `.toISOString()`, etc.), nothing downstream needs to change. */
export function tripoliSqlDateTimeToDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const dt = DateTime.fromSQL(raw, { zone: BUSINESS_TIMEZONE });
  return dt.isValid ? dt.toJSDate() : null;
}
