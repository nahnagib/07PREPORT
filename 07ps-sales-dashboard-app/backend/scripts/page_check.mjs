// Phase 4 page check: calls every sales/product page endpoint of a LOCAL backend for a fixed set of scopes and saves
// the JSON responses, so pages can be checked against the regression totals and against each other.
//
//   API=http://127.0.0.1:4100 JWT_SECRET=<the local instance's test secret> USER_ID=<admin user id> OUT=<dir> \
//     node backend/scripts/page_check.mjs
//
// The token is signed with the LOCAL instance's own test secret (never a production secret) and only sent to API.
// Read-only: GET requests only.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');

const API = process.env.API ?? 'http://127.0.0.1:4100';
const OUT = process.env.OUT ?? 'page_check_out';
const USER_ID = String(process.env.USER_ID ?? '');
const ANCHOR = process.env.ANCHOR ?? '2026-09-30';
if (!process.env.JWT_SECRET || !USER_ID) throw new Error('JWT_SECRET and USER_ID are required');
const token = jwt.sign({ sub: USER_ID, jti: crypto.randomUUID() }, process.env.JWT_SECRET, { expiresIn: '30m' });

const SCOPES = {
  all: '',
  majaal: 'companyKeys=1',
  tika: 'companyKeys=3',
  team_mj_est_bb: 'salesTeamKeys=MJ-EST-BB',
  team_tk_ben_bc_03: 'salesTeamKeys=TK-BEN-BC-03',
  salesperson_49: 'salespersonKeys=49',
  segment_b2b: 'segmentKeys=1',
  channel_retail: 'channelKeys=3',
};
const ENDPOINTS = [
  ['tachometer_overview', '/tachometer/overview', `anchorDate=${ANCHOR}`],
  ['tachometer_breakdown_salesperson', '/tachometer/breakdown', `anchorDate=${ANCHOR}&metric=ytdValue&groupBy=salesperson`],
  ['tachometer_breakdown_team', '/tachometer/breakdown', `anchorDate=${ANCHOR}&metric=ytdValue&groupBy=salesTeam`],
  ['tachometer_breakdown_segment', '/tachometer/breakdown', `anchorDate=${ANCHOR}&metric=ytdValue&groupBy=segment`],
  ['tachometer_trend', '/tachometer/trend', `anchorDate=${ANCHOR}`],
  ['critical_number_overview', '/critical-number/overview', `anchorDate=${ANCHOR}`],
  ['critical_number_missing_trend', '/critical-number/missing-trend', `anchorDate=${ANCHOR}`],
  ['customer_growth_overview', '/customer-growth/overview', `anchorDate=${ANCHOR}`],
  ['revenue_trend_overview', '/revenue-trend/overview', `anchorDate=${ANCHOR}`],
  ['invoices_engine_overview', '/invoices-engine/overview', `anchorDate=${ANCHOR}`],
  ['pipeline_health_overview', '/pipeline-health/overview', `anchorDate=${ANCHOR}`],
  ['pipeline_trend_overview', '/pipeline-trend/overview', `anchorDate=${ANCHOR}`],
  ['activity_momentum_overview', '/activity-momentum/overview', `anchorDate=${ANCHOR}`],
  ['product_bcg_matrix', '/product-dashboard/bcg-matrix/overview', `anchorDate=${ANCHOR}`],
  ['product_stock_velocity', '/product-dashboard/stock-velocity/overview', `anchorDate=${ANCHOR}`],
  ['product_pim_contribution', '/product-dashboard/pim-contribution/overview', `anchorDate=${ANCHOR}`],
  ['product_lifecycle', '/product-dashboard/product-lifecycle/overview', `anchorDate=${ANCHOR}`],
  ['filters_options', '/filters/options', ''],
];
const ONCE = [
  ['meta_refresh_status', '/meta/refresh-status', ''],
  ['filters_business_units', '/filters/business-units', ''],
  ['filters_salespersons', '/filters/salespersons', ''],
  ['filters_branches', '/filters/branches', ''],
  ['filters_distribution_channels', '/filters/distribution-channels', ''],
  ['filters_customer_groups', '/filters/customer-groups', ''],
  ['auth_me', '/auth/me', ''],
];

mkdirSync(OUT, { recursive: true });
const results = [];
async function get(name, path, query) {
  const url = `${API}${path}${query ? `?${query}` : ''}`;
  const started = Date.now();
  let status = 0;
  let body = null;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    status = res.status;
    const text = await res.text();
    try { body = JSON.parse(text); } catch { body = text; }
  } catch (err) {
    body = { error: String(err) };
  }
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(body, null, 1));
  results.push({ name, path, query, status, ms: Date.now() - started, bytes: JSON.stringify(body ?? '').length });
}

for (const [name, path, query] of ONCE) await get(name, path, query);
for (const [ep, path, query] of ENDPOINTS) {
  for (const [scope, sq] of Object.entries(SCOPES)) {
    await get(`${ep}__${scope}`, path, [query, sq].filter(Boolean).join('&'));
  }
}
writeFileSync(join(OUT, '_results.json'), JSON.stringify(results, null, 1));
const bad = results.filter((r) => r.status !== 200);
console.log(`${results.length} request(s); non-200: ${bad.length}`);
for (const r of bad) console.log(`  ${r.status} ${r.name} ${r.path}?${r.query}`);
