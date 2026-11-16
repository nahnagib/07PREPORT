import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../../db/pool';
import { clearSkuTrendCache, computeSkuTrend } from '../skuTrend';
import { computeProductDashboard } from '../productDashboard';

/**
 * SKU Trend against a real warehouse, read-only (2026-11-16). Opt-in: DB_* in the environment, then
 *   npx vitest run -c vitest.salesforce-db.config.ts
 * The latest column (the period in progress) = the Product Status cards with the Date filter on the same dates, per
 * company and granularity: same rows, same sales, same On Hand, same rule (Unclassified is not on the chart).
 */
const RUN = process.env.SALESFORCE_TEST_DB === '1';

afterAll(async () => {
  if (!RUN) return;
  clearSkuTrendCache();
  await pool.end();
});

describe.skipIf(!RUN)('SKU Trend latest period = the Product Status cards (real warehouse)', () => {
  for (const granularity of ['week', 'month', 'year'] as const) {
    for (const company of [undefined, 'Majaal', 'Tika']) {
      it(`${granularity}, ${company ?? 'All'}`, async () => {
        const t = await computeSkuTrend(pool, { granularity, to: '2026-11-16', company });
        const latest = t.points[t.points.length - 1];
        expect(latest.inProgress).toBe(true);
        const cards = (await computeProductDashboard(pool, { fromDate: latest.start, toDate: t.to, company })).statusSummary!;
        expect(latest.counts).toEqual({
          active: cards.active.count,
          nonActive: cards.nonActive.count,
          dormant: cards.dormant.count,
          total: cards.active.count + cards.nonActive.count + cards.dormant.count,
        });
      });
    }
  }
});
