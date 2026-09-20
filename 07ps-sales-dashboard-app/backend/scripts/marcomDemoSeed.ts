/**
 * DEV-ONLY: loads (or removes) realistic dummy MARCOM data for visual testing of the four pages.
 *
 *   npm run marcom:demo-seed   --workspace backend [-- --user-id 3] [-- --i-know-this-is-dev]
 *   npm run marcom:demo-unseed --workspace backend
 *
 * Goes through the normal validate -> commit path (append-only batches labelled "DEMO SEED ..."), so
 * rollback and freshness behave like real data. Refuses to run when NODE_ENV=production, when the DB
 * host is not localhost, or when the DB name does not look like a dev database (unless you pass
 * --i-know-this-is-dev). Also refuses to seed next to real uploads.
 */
import 'dotenv/config';
import { demoSeedRefusal, seedDemo, unseedDemo } from '../src/marcom/demo/demoSeed';

// A CLI: parse in-process rather than in a worker thread.
process.env.MARCOM_PARSE_INLINE = '1';

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] === 'unseed' ? 'unseed' : 'seed';
  const ack = args.includes('--i-know-this-is-dev');
  const uid = args.indexOf('--user-id');
  const userId = uid >= 0 ? Number(args[uid + 1]) : undefined;

  const refusal = demoSeedRefusal(process.env, ack);
  if (refusal) {
    console.error(`Refusing to ${cmd}: ${refusal}`);
    process.exit(2);
  }
  console.log(`${cmd === 'seed' ? 'Seeding' : 'Removing'} demo data in ${process.env.DB_NAME}@${process.env.DB_HOST ?? 'localhost'} ...`);
  const log = (m: string) => console.log('  ' + m);
  if (cmd === 'seed') {
    const r = await seedDemo({ userId, log });
    console.log(`Done: ${r.length} batches loaded.`);
  } else {
    const r = await unseedDemo({ userId, log });
    console.log(`Done: ${r.removed} demo batch(es) rolled back.`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
