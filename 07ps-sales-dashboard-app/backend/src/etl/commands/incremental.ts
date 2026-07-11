/**
 * `npm run etl:incremental [-- --sync]`
 *
 * Incremental Refresh: pulls only Odoo records changed since the last successful run (using the
 * latest order cursor already recorded in MySQL) and only touches the affected rows. Writes to
 * MySQL only (no Excel workbook). Uses `--fast` -- this is the production default cadence (see
 * ETL_SCHEDULE_INCREMENTAL_CRON), the same flags the old Windows-Task-Scheduler-driven
 * scheduler.py used to run 5x/day.
 */
import { runModeCommand } from './shared';

runModeCommand({
  label: 'incremental-refresh',
  mode: 'incremental',
  loadMode: 'incremental',
  outputMode: 'sql',
  fast: true,
}).catch(
  (err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  },
);
