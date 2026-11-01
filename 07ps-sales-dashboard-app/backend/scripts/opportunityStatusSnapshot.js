/* eslint-disable */
/**
 * Before/after snapshot of every CRM visual that reads the opportunity status (Pipeline Health, Activity Momentum,
 * Pipeline Trend, data quality), company-wide (no filters), as JSON. Plain CommonJS on purpose: it runs against any
 * compiled backend (`dist`), so the same script measures the old build (inside the running container) and the new one.
 *
 *   node scripts/opportunityStatusSnapshot.js [distDir=dist] [anchor=YYYY-MM-DD] > snapshot.json
 */
const path = require('node:path');

const dist = path.resolve(process.argv[2] || 'dist');
const anchor = process.argv[3] ? new Date(`${process.argv[3]}T12:00:00`) : new Date();
const load = (m) => require(path.join(dist, m));

/** Long row lists become their length (and value total when the rows carry one); everything else is kept. */
function summarize(value) {
  if (Array.isArray(value)) {
    if (value.length > 24 && value.every((v) => v && typeof v === 'object')) {
      const out = { rows: value.length };
      for (const key of ['expectedRevenue', 'value']) {
        if (value.some((v) => typeof v[key] === 'number')) out[`${key}Total`] = Math.round(value.reduce((s, v) => s + (Number(v[key]) || 0), 0));
      }
      return out;
    }
    return value.map(summarize);
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, summarize(v)]));
  }
  return typeof value === 'number' ? Math.round(value * 100) / 100 : value;
}

async function main() {
  const { pool } = load('db/pool');
  const ph = load('measures/pipelineHealth');
  const am = load('measures/activityMomentum');
  const pt = load('measures/pipelineTrend');
  const filters = {};
  const out = {
    anchor: anchor.toISOString().slice(0, 10),
    pipelineHealth: summarize(await ph.computePipelineHealthOverview(pool, anchor, filters)),
    activityMomentum: summarize(await am.computeActivityMomentumOverview(pool, anchor, filters)),
    pipelineTrend: summarize(await pt.computePipelineTrendOverview(pool, anchor, filters)),
  };
  for (const page of Object.values(out)) {
    if (page && typeof page === 'object') { delete page.funnelStageRecords; delete page.opportunityChains; }
  }
  process.stdout.write(JSON.stringify(out, null, 2));
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
