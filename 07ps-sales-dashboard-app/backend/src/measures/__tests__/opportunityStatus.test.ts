import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { computeBenchmarkCohort, computeStageBenchmark, fetchOpportunitiesByStatus, fetchOpportunityByStage, fetchProbabilityDistribution, fetchExpectedClosureByMonth, fetchOpportunityDetails } from '../pipelineHealth';
import { excludeLostClause, notArchivedClause, openOpportunityClause } from '../filters';
import { PipelineStageOrder } from '../../config/pipelineStages';

/**
 * Status (the outcome) vs stage (the kanban column), 2026-11-01: a deal marked Lost keeps its stage in Odoo, so every
 * stage-based visual must filter on OpportunityStatus = 'Pending', and no query may use a stage name. Mocks pool.query and
 * inspects the SQL text, same convention as activityMomentum.test.ts.
 */
function capture(rows: unknown[] = []) {
  const sqls: string[] = [];
  const query = vi.fn(async (sql: string) => {
    sqls.push(sql);
    return [rows];
  });
  return { pool: { query } as unknown as Pool, sqls };
}

const ANCHOR = new Date('2026-11-01T12:00:00Z');

describe('status clauses', () => {
  it('open = Pending, not archived = Pending/Won/Lost, excludeLost = Pending/Won', () => {
    expect(openOpportunityClause('fo')).toBe("fo.OpportunityStatus = 'Pending'");
    expect(notArchivedClause('fo')).toBe("fo.OpportunityStatus IN ('Pending', 'Won', 'Lost')");
    expect(excludeLostClause('t')).toBe("t.OpportunityStatus IN ('Pending', 'Won')");
  });
});

describe('stage-based visuals show open opportunities only', () => {
  it.each([
    ['Opportunity by Stage', fetchOpportunityByStage],
    ['Probabilities Distribution', fetchProbabilityDistribution],
    ['Expected Closure', fetchExpectedClosureByMonth],
  ])('%s filters on status Pending', async (_name, fn) => {
    const { pool, sqls } = capture();
    await fn(pool, ANCHOR, {});
    expect(sqls.join('\n')).toContain("fo.OpportunityStatus = 'Pending'");
  });

  it('no Pipeline Health query reads a stage name', async () => {
    const { pool, sqls } = capture();
    await Promise.all([fetchOpportunityByStage(pool, ANCHOR, {}), fetchOpportunitiesByStatus(pool, ANCHOR, {}), fetchOpportunityDetails(pool, ANCHOR, {})]);
    for (const sql of sqls) expect(sql).not.toMatch(/Stage\s*(=|IN|LIKE)\s*\(?\s*'/i);
  });
});

describe('Opportunity by Status', () => {
  it('returns Won, Lost and Pending (zero-filled) and counts Archived separately', async () => {
    const { pool, sqls } = capture([
      { status: 'Won', cnt: 12, val: 5000 },
      { status: 'Lost', cnt: 4, val: 800 },
      { status: 'Archived', cnt: 2, val: 70 },
    ]);
    const out = await fetchOpportunitiesByStatus(pool, ANCHOR, { salespersonKeys: [7] });
    expect(out.slices).toEqual([
      { status: 'Won', count: 12, expectedRevenue: 5000 },
      { status: 'Lost', count: 4, expectedRevenue: 800 },
      { status: 'Pending', count: 0, expectedRevenue: 0 },
    ]);
    expect(out.archivedCount).toBe(2);
    expect(sqls[0]).toContain('GROUP BY fo.OpportunityStatus');
    expect(sqls[0]).toContain('SalespersonKey'); // page filters / role scope go through buildCrmWhereClause
  });
});

describe('Opportunity Details', () => {
  it('carries the status of every row and leaves Archived out', async () => {
    const { pool, sqls } = capture([{ opportunityId: 1, name: 'A', status: 'Lost', expectedRevenue: 10 }, { opportunityId: 2, name: 'B', status: 'Pending', expectedRevenue: 5 }]);
    const rows = await fetchOpportunityDetails(pool, ANCHOR, {});
    expect(rows.map((r) => [r.status, r.isOpen])).toEqual([['Lost', false], ['Pending', true]]);
    expect(sqls[0]).toContain("fo.OpportunityStatus IN ('Pending', 'Won', 'Lost')");
  });
});

describe('Stage Benchmark cohort (option A)', () => {
  const rec = (opportunityId: string | null, extra: Record<string, unknown> = {}) => ({ value: 0, ...extra, opportunityId }) as any;
  const opp = (opportunityId: string, expectedRevenue = 0) => ({ opportunityId, expectedRevenue });
  it('counts only cohort opportunities, each step a subset of the one before, so no count step exceeds 100%', () => {
    const cohort = computeBenchmarkCohort([opp('1'), opp('2'), opp('3'), opp('4')], {
      // 9 is outside the cohort (other period / archived); 5 has an order without a cohort quotation
      quotations: [rec('1'), rec('1'), rec('2'), rec('3'), rec('9'), rec(null)],
      salesOrders: [rec('1'), rec('2'), rec('5'), rec('9')],
      deliveries: [rec('1', { deliveryStatus: 'Fully Delivered' }), rec('2', { deliveryStatus: 'Not Delivered' }), rec('9', { deliveryStatus: 'Started' })],
    } as any);
    expect(cohort).toMatchObject({ opportunities: 4, quotations: 3, salesOrders: 2, deliveries: 1 });
    const rows = computeStageBenchmark(cohort);
    expect(rows.map((r) => [r.fromCount, r.toCount])).toEqual([[4, 3], [3, 2], [2, 1]]);
    for (const r of rows) expect(r.countPct!).toBeLessThanOrEqual(1);
  });

  it('converts by value (LYD): next stage value ÷ previous stage value, on the same cohort', () => {
    const cohort = computeBenchmarkCohort([opp('1', 1000), opp('2', 500), opp('3', 300)], {
      quotations: [
        rec('1', { orderNumber: 'S1', value: 600 }),
        rec('1', { orderNumber: 'S1b', value: 100 }), // a second revision counts too
        rec('2', { orderNumber: 'S2', value: 200 }),
        rec('9', { orderNumber: 'S9', value: 99999 }), // outside the cohort
      ],
      salesOrders: [rec('1', { orderNumber: 'S1', value: 600 }), rec('2', { orderNumber: 'S2', value: 200 }), rec('9', { orderNumber: 'S9', value: 99999 })],
      deliveries: [
        rec('1', { orderNumber: 'S1', deliveryStatus: 'Partially Delivered' }),
        rec('1', { orderNumber: 'S1', deliveryStatus: 'Fully Delivered' }), // two pickings, one order: counted once
        rec('2', { orderNumber: 'S2', deliveryStatus: 'Not Delivered' }),
      ],
    } as any);
    expect(cohort.values).toEqual({ opportunities: 1800, quotations: 900, salesOrders: 800, deliveries: 600 });
    const rows = computeStageBenchmark(cohort);
    expect(rows.map((r) => [r.fromValue, r.toValue])).toEqual([[1800, 900], [900, 800], [800, 600]]);
    expect(rows.map((r) => Number(r.actualPct!.toFixed(4)))).toEqual([0.5, 0.8889, 0.75]);
    expect(rows.map((r) => r.countPct)).toEqual([2 / 3, 1, 0.5]);
    expect(rows.map((r) => r.targetPct)).toEqual([0.8, 0.15, 0.98]); // count-era targets kept for now
  });

  it('no value at the start of a step: no %, never NaN', () => {
    const rows = computeStageBenchmark(computeBenchmarkCohort([], { quotations: [], salesOrders: [], deliveries: [] }));
    for (const r of rows) {
      expect(r.actualPct).toBeNull();
      expect(r.status).toBe('no_target');
    }
  });
});

describe('Opportunity by Stage: pipeline order by stage id, not by value or name', () => {
  it('orders the slices New → Design → Qualified → Cross Selling → Proposition → Negotiations → LOA → On Hold, then others by Odoo sequence', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('dim_sales_crm_stage')) {
        return [[
          { stageId: 1, stage: 'New', sequence: 0 }, { stageId: 9, stage: 'Design Stage', sequence: 1 }, { stageId: 2, stage: 'Qualified', sequence: 2 },
          { stageId: 4, stage: 'Won', sequence: 3 }, { stageId: 7, stage: 'Proposition', sequence: 4 }, { stageId: 8, stage: 'Cross Selling', sequence: 5 },
          { stageId: 10, stage: 'Negotiations', sequence: 6 }, { stageId: 6, stage: 'On Hold -Resolution Issue', sequence: 7 },
          { stageId: 11, stage: 'Waiting For LOA', sequence: 8 }, { stageId: 5, stage: 'Lost', sequence: 9 }, { stageId: 12, stage: 'Renamed later', sequence: 1 },
        ]];
      }
      // value order deliberately different from the pipeline order
      return [[
        { stageId: 5, stage: 'Lost', value: 3, cnt: 1 }, { stageId: 6, stage: 'On Hold -Resolution Issue', value: 1, cnt: 1 },
        { stageId: 9, stage: 'Design Stage', value: 29, cnt: 1 }, { stageId: 1, stage: 'New', value: 17, cnt: 1 },
        { stageId: 8, stage: 'Cross Selling', value: 16, cnt: 1 }, { stageId: 2, stage: 'Qualified', value: 5, cnt: 1 },
        { stageId: 7, stage: 'Proposition', value: 8, cnt: 1 }, { stageId: 10, stage: 'Negotiations', value: 1, cnt: 1 },
        { stageId: 12, stage: 'Renamed later', value: 2, cnt: 1 }, { stageId: null, stage: null, value: 1, cnt: 1 },
      ]];
    });
    const slices = await fetchOpportunityByStage({ query } as unknown as Pool, ANCHOR, {});
    expect(slices.map((s) => s.stage)).toEqual([
      'New', 'Design Stage', 'Qualified', 'Cross Selling', 'Proposition', 'Negotiations', 'On Hold -Resolution Issue',
      'Renamed later', 'Lost', 'Unspecified',
    ]);
    const colors = slices.map((s) => s.colorKey);
    expect(new Set(colors).size).toBe(colors.length); // every stage its own colour
    expect(query.mock.calls.map((c) => c[0]).join('\n')).toContain('GROUP BY fo.StageID');
  });

  it('keeps working when the stage table cannot be read (fixed order, others last)', () => {
    const order = new PipelineStageOrder([]);
    expect(order.of(9).position).toBeLessThan(order.of(2).position);
    expect(order.of(5, 'Lost').position).toBeGreaterThan(order.of(6).position);
  });
});
