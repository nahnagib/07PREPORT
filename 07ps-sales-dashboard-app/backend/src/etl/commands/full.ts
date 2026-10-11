/**
 * `npm run etl:full [-- --sync]`
 *
 * Full Refresh = ETL job `full_all`: core dims, then today's receivables snapshot, then a rebuild of
 * every sales table from a complete Odoo extract -- not just records changed since the last run. Writes to MySQL only (no Excel
 * workbook). This is the thorough/periodic mode: slower than `etl:incremental`, and runs full
 * QA/validation (no --fast).
 */
import { runModeCommand } from './shared';

runModeCommand({ label: 'full-refresh', mode: 'full', loadMode: 'full', outputMode: 'sql' }).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
