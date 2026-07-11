/**
 * `npm run etl:full [-- --sync]`
 *
 * Full Refresh: rebuilds every dimension and fact table (sales + CRM) from a complete Odoo
 * extract -- not just records changed since the last run. Writes to MySQL only (no Excel
 * workbook). This is the thorough/periodic mode: slower than `etl:incremental`, and runs full
 * QA/validation (no --fast).
 */
import { runModeCommand } from './shared';

runModeCommand({ label: 'full-refresh', mode: 'full', loadMode: 'full', outputMode: 'sql' }).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
