/**
 * `npm run etl:customers`
 *
 * IMPORTANT: this runs the exact same full pipeline as `etl:run`, just labeled differently in the
 * ETL log. The vendored pipeline (data/etl) is a single interdependent run -- dimensions and facts
 * are built in a fixed order with heavy cross-references (e.g. Dim_Customer depends on multiple
 * upstream builders; Fact_Sales depends on the CRM spine + Fact_Orders) -- so there is no existing
 * seam to extract "just the customers data" without restructuring the pipeline's internals. This
 * command exists so the command surface matches what was asked for and the door stays open for
 * true per-module runs later, but today it is an alias, not an isolated sub-pipeline.
 */
import { runCommand } from './shared';

runCommand({ label: 'customers' }).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
