/**
 * `npm run etl:run [-- --full] [-- --sync]`
 *
 * Runs the full pipeline (all dimensions + facts, sales + CRM) -- see runOrEnqueue in shared.ts.
 * Defaults to an incremental, fast run (SQL only, matching the cadence the pipeline has run at in
 * production); pass --full for a full refresh (the periodic/nightly mode).
 */
import { runCommand } from './shared';

runCommand({ label: 'manual-run' }).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
