// Phase 7: p50/p95 of each Debt Report measure on the local warehouse (read-only). DB_* from the environment.
//   npx tsx scripts/debt_timing.ts [runs=10]
import { pool } from '../src/db/pool';
import { DEFAULT_DEBT_QUERY, fetchDebtCustomers, fetchDebtDrilldown, fetchDebtMeta, fetchDebtOverview, fetchDebtTrend, parseDebtQuery } from '../src/measures/debtReport';

const runs = Number(process.argv[2] ?? 10);
async function time(name: string, fn: () => Promise<unknown>) {
  const t: number[] = [];
  for (let i = 0; i < runs; i++) {
    const s = performance.now();
    await fn();
    t.push(performance.now() - s);
  }
  t.sort((a, b) => a - b);
  const p = (q: number) => t[Math.min(t.length - 1, Math.ceil(q * t.length) - 1)];
  console.log(`${name.padEnd(34)} p50 ${p(0.5).toFixed(0).padStart(6)} ms   p95 ${p(0.95).toFixed(0).padStart(6)} ms   max ${t[t.length - 1].toFixed(0).padStart(6)} ms`);
}
(async () => {
  const all = parseDebtQuery({ includeOther: 'true', includeIntercompany: 'true' });
  const top = (await fetchDebtCustomers(pool, DEFAULT_DEBT_QUERY, {})).rows[0];
  await time('meta', () => fetchDebtMeta(pool, DEFAULT_DEBT_QUERY, {}));
  await time('overview (default)', () => fetchDebtOverview(pool, DEFAULT_DEBT_QUERY, {}));
  await time('overview (all scopes)', () => fetchDebtOverview(pool, all, {}));
  await time('trend', () => fetchDebtTrend(pool, DEFAULT_DEBT_QUERY, {}));
  await time('customers (default)', () => fetchDebtCustomers(pool, DEFAULT_DEBT_QUERY, {}));
  await time('customers (all scopes)', () => fetchDebtCustomers(pool, all, {}));
  const account = { kind: 'account' as const, key: `${top.companyKey}:${top.customerKey}`, currency: top.currency };
  await time('drilldown (top customer row)', () => fetchDebtDrilldown(pool, DEFAULT_DEBT_QUERY, {}, account));
  await pool.end();
})();
