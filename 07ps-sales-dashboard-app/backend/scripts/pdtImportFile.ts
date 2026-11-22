/**
 * TEST-STACK ONLY: imports Product_Development_Input.xlsx the way the Data entry screen does (preview, then confirm the
 * same file), so the local test stack shows the real Xtreme pipeline.
 *
 *   (PowerShell, from backend/)  $env:DB_HOST='127.0.0.1'; $env:DB_PORT='33309'; $env:DB_NAME='powerBI_Data'
 *   npm run pdt:import-file [-- <path to .xlsx>] [-- --preview] [-- --user-id 3]
 *
 * Default file: ../../Input/product_development/Product_Development_Input.xlsx. Refuses any database but the local test
 * stack (127.0.0.1:33309): production imports go through the screen, by a person, after checking the preview.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const TEST_PORT = '33309';

async function main() {
  const args = process.argv.slice(2);
  const host = (process.env.DB_HOST ?? '').toLowerCase();
  if ((process.env.NODE_ENV ?? '').toLowerCase() === 'production' || !['127.0.0.1', 'localhost'].includes(host) || process.env.DB_PORT !== TEST_PORT) {
    console.error(`Refusing: the database is ${host || '(unset)'}:${process.env.DB_PORT ?? '(unset)'}; only the local test stack 127.0.0.1:${TEST_PORT} is allowed.`);
    process.exit(2);
  }
  const file = path.resolve(args.find((a) => a.endsWith('.xlsx')) ?? path.join(__dirname, '../../../Input/product_development/Product_Development_Input.xlsx'));
  const { pool } = await import('../src/db/pool');
  const { previewImport, confirmImport } = await import('../src/services/pdt/importService');
  const buffer = readFileSync(file);
  const name = path.basename(file);
  const pv = await previewImport(buffer, name);
  const c = pv.counts;
  console.log(`Preview of ${name} (${process.env.DB_NAME}@${host}:${process.env.DB_PORT}, today ${pv.today}):`);
  console.log(`  Products  ${c.products.rows} rows: ${c.products.new} new, ${c.products.changed} changed, ${c.products.unchanged} unchanged, ${c.products.stageChanges} stage changes, ${c.products.errors} errors`);
  console.log(`  Updates   ${c.updates.rows} rows: ${c.updates.new} new, ${c.updates.duplicates} duplicates, ${c.updates.errors} errors`);
  console.log(`  Blockers  ${c.blockers.rows} rows: ${c.blockers.new} new, ${c.blockers.changed} changed, ${c.blockers.unchanged} unchanged, ${c.blockers.errors} errors`);
  console.log(`  Families  ${c.families.inFile} in Lists: ${c.families.new} new, ${c.families.changed} description changes`);
  if (pv.missingFromFile.length) console.log(`  Kept, not in the file: ${pv.missingFromFile.map((m) => m.code).join(', ')}`);
  for (const e of pv.errors.slice(0, 30)) console.log(`  ERROR ${e.sheet} row ${e.row} ${e.field}: ${e.message} (${e.code})`);
  console.log('  Where we stand: ' + pv.whereWeStand.map((r) => `${r.family} ${r.total}`).join(' | '));
  if (args.includes('--preview') || !pv.canConfirm) {
    if (!pv.canConfirm) console.error('Not imported: fix the errors first.');
    await pool.end();
    process.exit(pv.canConfirm ? 0 : 1);
  }
  const uidArg = args.indexOf('--user-id');
  const [u] = (await pool.query(
    "SELECT u.user_id FROM app_user u JOIN roles r ON r.role_id = u.role_id WHERE r.role_name = 'ADMIN' AND u.is_active = 1 ORDER BY u.user_id LIMIT 1",
  )) as unknown as [{ user_id: number }[]];
  const uid = uidArg >= 0 ? Number(args[uidArg + 1]) : u[0]?.user_id;
  if (!uid) throw new Error('No active ADMIN user to attribute the import to (pass --user-id).');
  const done = await confirmImport(buffer, name, pv.sha256, uid);
  console.log(`Imported (import #${done.importId}).`);
  await pool.end();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
