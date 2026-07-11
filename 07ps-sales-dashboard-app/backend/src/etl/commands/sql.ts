/**
 * `npm run etl:sql [-- --sync]`
 *
 * SQL Mode: writes to MySQL only, no Excel workbook produced. Uses incremental load mode
 * (changed records only) WITHOUT `--fast`, so QA exports and full scoped validation still run --
 * use `etl:incremental` instead when you want the faster, validation-light production cadence.
 * This is the general "just sync the database" command.
 */
import { runModeCommand } from './shared';

runModeCommand({ label: 'sql-sync', mode: 'sql', loadMode: 'incremental', outputMode: 'sql' }).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
