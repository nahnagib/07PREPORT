import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { fetchOpportunitiesByStatus, fetchOpportunityByStage, fetchProbabilityDistribution, fetchExpectedClosureByMonth, fetchOpportunityDetails } from '../pipelineHealth';
import { excludeLostClause, notArchivedClause, openOpportunityClause } from '../filters';

/**
 * Status (the outcome) vs stage (the kanban column), 2026-11-01: a deal marked Lost keeps its stage in Odoo, so every
 * stage-based visual must filter on OpportunityStatus = 'New', and no query may use a stage name. Mocks pool.query and
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
  it('open = New, not archived = New/Won/Lost, excludeLost = New/Won', () => {
    expect(openOpportunityClause('fo')).toBe("fo.OpportunityStatus = 'New'");
    expect(notArchivedClause('fo')).toBe("fo.OpportunityStatus IN ('New', 'Won', 'Lost')");
    expect(excludeLostClause('t')).toBe("t.OpportunityStatus IN ('New', 'Won')");
  });
});

describe('stage-based visuals show open opportunities only', () => {
  it.each([
    ['Opportunity by Stage', fetchOpportunityByStage],
    ['Probabilities Distribution', fetchProbabilityDistribution],
    ['Expected Closure', fetchExpectedClosureByMonth],
  ])('%s filters on status New', async (_name, fn) => {
    const { pool, sqls } = capture();
    await fn(pool, ANCHOR, {});
    expect(sqls.join('\n')).toContain("fo.OpportunityStatus = 'New'");
  });

  it('no Pipeline Health query reads a stage name', async () => {
    const { pool, sqls } = capture();
    await Promise.all([fetchOpportunityByStage(pool, ANCHOR, {}), fetchOpportunitiesByStatus(pool, ANCHOR, {}), fetchOpportunityDetails(pool, ANCHOR, {})]);
    for (const sql of sqls) expect(sql).not.toMatch(/Stage\s*(=|IN|LIKE)\s*\(?\s*'/i);
  });
});

describe('Opportunities by Status', () => {
  it('returns New, Won and Lost (zero-filled) and counts Archived separately', async () => {
    const { pool, sqls } = capture([
      { status: 'Won', cnt: 12, val: 5000 },
      { status: 'Lost', cnt: 4, val: 800 },
      { status: 'Archived', cnt: 2, val: 70 },
    ]);
    const out = await fetchOpportunitiesByStatus(pool, ANCHOR, { salespersonKeys: [7] });
    expect(out.slices).toEqual([
      { status: 'New', count: 0, expectedRevenue: 0 },
      { status: 'Won', count: 12, expectedRevenue: 5000 },
      { status: 'Lost', count: 4, expectedRevenue: 800 },
    ]);
    expect(out.archivedCount).toBe(2);
    expect(sqls[0]).toContain('GROUP BY fo.OpportunityStatus');
    expect(sqls[0]).toContain('SalespersonKey'); // page filters / role scope go through buildCrmWhereClause
  });
});

describe('Opportunity Details', () => {
  it('carries the status of every row and leaves Archived out', async () => {
    const { pool, sqls } = capture([{ opportunityId: 1, name: 'A', status: 'Lost', expectedRevenue: 10 }, { opportunityId: 2, name: 'B', status: 'New', expectedRevenue: 5 }]);
    const rows = await fetchOpportunityDetails(pool, ANCHOR, {});
    expect(rows.map((r) => [r.status, r.isOpen])).toEqual([['Lost', false], ['New', true]]);
    expect(sqls[0]).toContain("fo.OpportunityStatus IN ('New', 'Won', 'Lost')");
  });
});
