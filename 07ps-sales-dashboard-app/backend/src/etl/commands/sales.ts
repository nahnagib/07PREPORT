/**
 * `npm run etl:sales` -- alias for the full pipeline run. See customers.ts's header comment for
 * why: the vendored pipeline has no independent "sales only" seam today.
 */
import { runCommand } from './shared';

runCommand({ label: 'sales' }).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
