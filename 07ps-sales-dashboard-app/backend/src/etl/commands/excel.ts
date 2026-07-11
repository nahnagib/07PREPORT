/**
 * `npm run etl:excel [-- --sync]`
 *
 * Excel Mode: produces the Excel workbook (data/etl/Exports/SalesModel_OneOutput.xlsx, plus the
 * Inventory_Validation.xlsx QA export) from a full Odoo extract. Writes NO MySQL data at all --
 * this combination (`--load-mode full --output excel`) is the one case where the vendored
 * pipeline's own settings validation (data/etl/config/settings.py's `validate()`) does not
 * require a database connection at all -- matching how Excel-only exports were run historically,
 * before this pipeline was integrated into the web app.
 */
import { runModeCommand } from './shared';

runModeCommand({ label: 'excel-export', mode: 'excel', loadMode: 'full', outputMode: 'excel' }).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
