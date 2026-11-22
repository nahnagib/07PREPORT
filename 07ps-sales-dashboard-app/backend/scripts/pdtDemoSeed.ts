/**
 * TEST-STACK ONLY: loads (or removes) the 8 demo products of the Product Development Plan draft, with their stage history,
 * one recent status update each and the 3 open blockers / decisions (docs/product-development-standalone.md §6).
 *
 *   (PowerShell, from backend/)  $env:DB_HOST='127.0.0.1'; $env:DB_PORT='33309'; $env:DB_NAME='powerbi_data'
 *   npm run pdt:demo-seed           [-- --user-id 3]
 *   npm run pdt:demo-unseed
 *
 * Goes through the normal service (trackerService), so every rule and the audit log apply. Refuses to run unless the
 * database is the local TEST stack (127.0.0.1:33309, test-stack-start.cmd): backend/.env points at the production copy
 * on 3306, which must start empty. Refuses to seed twice (unseed first).
 */
import 'dotenv/config';

const TEST_PORT = '33309';

interface Seed {
  name: string;
  category: string;
  stage: 'IDEA' | 'RESEARCH' | 'DEVELOPMENT' | 'TESTING' | 'LAUNCH_READY' | 'LAUNCHED';
  owner: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  health: 'ON_TRACK' | 'AT_RISK' | 'BLOCKED';
  readiness: number;
  target: string;
  created: string;
  summary: string;
  nextStep?: [string, string];
}

// Brief §4. `created` is the stage-entry date (so the timeline shows days in stage); updates are dated a few days ago.
const PRODUCTS: Seed[] = [
  { name: 'Daily Hydration', category: 'Skincare', stage: 'LAUNCH_READY', owner: 'Maya Chen', priority: 'HIGH', health: 'ON_TRACK', readiness: 95, target: '2026-11-28', created: '2026-10-20', summary: 'Final artwork approved; first production lot booked.', nextStep: ['Release first lot to warehouse', '2026-11-24'] },
  { name: 'Botanical Cleanser', category: 'Skincare', stage: 'TESTING', owner: 'Omar Ali', priority: 'HIGH', health: 'BLOCKED', readiness: 72, target: '2026-12-15', created: '2026-10-05', summary: 'Stability testing waiting for the lab report.', nextStep: ['Chase lab for report date', '2026-11-19'] },
  { name: 'Night Renewal Serum', category: 'Skincare', stage: 'DEVELOPMENT', owner: 'Maya Chen', priority: 'HIGH', health: 'ON_TRACK', readiness: 48, target: '2027-01-22', created: '2026-10-01', summary: 'Second formula trial done; texture approved.', nextStep: ['Lock final formula', '2026-11-28'] },
  { name: 'Mineral SPF 50', category: 'Sun care', stage: 'DEVELOPMENT', owner: 'Sara Ahmed', priority: 'HIGH', health: 'AT_RISK', readiness: 42, target: '2027-02-12', created: '2026-09-22', summary: 'Packaging supplier quotes 10 weeks lead time.', nextStep: ['Get quote from alternative supplier', '2026-11-21'] },
  { name: 'Travel Essentials Kit', category: 'Sets & kits', stage: 'RESEARCH', owner: 'Leo Martin', priority: 'MEDIUM', health: 'ON_TRACK', readiness: 22, target: '2027-02-26', created: '2026-10-27', summary: 'Shortlisted 6 mini formats with the sales team.' },
  { name: 'Barrier Repair Balm', category: 'Skincare', stage: 'IDEA', owner: 'Sara Ahmed', priority: 'MEDIUM', health: 'ON_TRACK', readiness: 8, target: '2027-04-16', created: '2026-11-03', summary: 'Concept brief written; market scan started.' },
  { name: 'Refill Collection', category: 'Sustainability', stage: 'IDEA', owner: 'Leo Martin', priority: 'LOW', health: 'AT_RISK', readiness: 5, target: '2027-05-21', created: '2026-11-06', summary: 'Refill cost per unit above the target margin.' },
  { name: 'Essential Hand Care', category: 'Body care', stage: 'LAUNCHED', owner: 'Omar Ali', priority: 'MEDIUM', health: 'ON_TRACK', readiness: 100, target: '2026-11-05', created: '2026-11-05', summary: 'Launched in all branches.' },
];

// Brief §4: item 1 is a Blocker (keeps Botanical Cleanser Blocked); 2 and 3 are decisions (their products stay At risk).
const ITEMS = [
  { product: 'Botanical Cleanser', kind: 'BLOCKER', title: 'Stability report pending', owner: 'Omar Ali', due: '2026-11-18', action: 'Confirm lab turnaround and release testing report.' },
  { product: 'Mineral SPF 50', kind: 'DECISION', title: 'Packaging lead time exceeds plan', owner: 'Sara Ahmed', due: '2026-11-21', action: 'Approve alternative packaging supplier.' },
  { product: 'Refill Collection', kind: 'DECISION', title: 'Unit economics need approval', owner: 'Leo Martin', due: '2026-11-27', action: 'Review refill cost assumptions with finance.' },
] as const;

function refusal(): string | null {
  if ((process.env.NODE_ENV ?? '').toLowerCase() === 'production') return 'NODE_ENV is production.';
  const host = (process.env.DB_HOST ?? '').toLowerCase();
  if (!['127.0.0.1', 'localhost'].includes(host) || process.env.DB_PORT !== TEST_PORT) {
    return `the database is ${host || '(unset)'}:${process.env.DB_PORT ?? '(unset)'}; only the local test stack 127.0.0.1:${TEST_PORT} is allowed.`;
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] === 'unseed' ? 'unseed' : 'seed';
  const r = refusal();
  if (r) {
    console.error(`Refusing to ${cmd}: ${r}`);
    process.exit(2);
  }
  const { pool } = await import('../src/db/pool');
  const svc = await import('../src/services/pdt/trackerService');
  const { businessToday, addDays } = await import('../src/services/pdt/rules');
  const names = PRODUCTS.map((p) => p.name);
  const [existing] = (await pool.query('SELECT product_id, code FROM pdt_product WHERE name IN (?)', [names])) as unknown as [{ product_id: number; code: string }[]];

  if (cmd === 'unseed') {
    for (const p of existing) {
      await pool.query('DELETE FROM pdt_blocker WHERE product_id = ?', [p.product_id]);
      await pool.query('DELETE FROM pdt_status_update WHERE product_id = ?', [p.product_id]);
      await pool.query('DELETE FROM pdt_stage_history WHERE product_id = ?', [p.product_id]);
      await pool.query('DELETE FROM pdt_product WHERE product_id = ?', [p.product_id]);
    }
    console.log(`Removed ${existing.length} demo product(s).`);
    await pool.end();
    return;
  }

  if (existing.length) {
    console.error(`Refusing to seed: ${existing.length} demo product(s) already exist (${existing.map((e) => e.code).join(', ')}). Run pdt:demo-unseed first.`);
    process.exit(2);
  }
  const uidArg = args.indexOf('--user-id');
  const [u] = (await pool.query(
    "SELECT u.user_id FROM app_user u JOIN roles r ON r.role_id = u.role_id WHERE r.role_name = 'ADMIN' AND u.is_active = 1 ORDER BY u.user_id LIMIT 1",
  )) as unknown as [{ user_id: number }[]];
  const uid = uidArg >= 0 ? Number(args[uidArg + 1]) : u[0]?.user_id;
  if (!uid) throw new Error('No active ADMIN user to attribute the demo data to (pass --user-id).');

  const [cats] = (await pool.query("SELECT value_id, label FROM pdt_dropdown_value WHERE list_key = 'category'")) as unknown as [{ value_id: number; label: string }[]];
  const catId = new Map(cats.map((c) => [c.label, c.value_id]));
  const today = businessToday();
  const codes = new Map<string, string>();

  console.log(`Seeding the Product Development Plan demo in ${process.env.DB_NAME}@${process.env.DB_HOST}:${process.env.DB_PORT} (today ${today}) ...`);
  for (const [i, s] of PRODUCTS.entries()) {
    const out = await svc.createProduct(
      {
        name: s.name, categoryId: catId.get(s.category), ownerName: s.owner, priority: s.priority, stage: s.stage,
        // Blocked comes from the Blocker below; created On track first.
        health: s.health === 'BLOCKED' ? 'ON_TRACK' : s.health,
        readinessPct: s.readiness, targetLaunch: s.target, actualLaunch: s.stage === 'LAUNCHED' ? s.target : undefined,
        comment: 'Imported from the planning draft',
      },
      uid,
      s.created,
    );
    codes.set(s.name, out.product.code);
    console.log(`  ${out.product.code} ${s.name}`);
    if (s.stage === 'LAUNCHED') continue;
    const item = ITEMS.find((x) => x.product === s.name && x.kind === 'BLOCKER');
    if (item) {
      await svc.createBlocker({ productCode: out.product.code, kind: item.kind, title: item.title, requiredAction: item.action, ownerName: item.owner, dueDate: item.due }, uid, today);
    }
    // One recent update (1-6 days ago) so nothing shows "No update".
    await svc.postUpdate(
      out.product.code,
      { updateDate: addDays(today, -1 - (i % 6)), health: s.health, readinessPct: s.readiness, summary: s.summary, nextStep: s.nextStep?.[0], nextStepDue: s.nextStep?.[1] },
      uid,
      today,
    );
  }
  for (const item of ITEMS.filter((x) => x.kind === 'DECISION')) {
    await svc.createBlocker({ productCode: codes.get(item.product), kind: item.kind, title: item.title, requiredAction: item.action, ownerName: item.owner, dueDate: item.due }, uid, today);
  }
  const dash = await svc.getDashboard({ stages: [], owners: [], categoryIds: [], priorities: [], health: [] }, today);
  console.log('KPIs:', JSON.stringify(dash.kpis), `| roadmap ${dash.roadmap.months.map((m) => `${m.month}:${m.products.length}`).join(' ')} outside ${dash.roadmap.outsideWindow} | open items ${dash.blockers.length}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
