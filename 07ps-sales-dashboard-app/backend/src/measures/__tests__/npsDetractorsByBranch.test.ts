import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { fetchNpsDetractorsByBranch, parseNpsQuery } from '../npsScore';

describe('NPS detractors by branch (2026-11-15)', () => {
  it("the Detractors card's own WHERE, grouped by the effective branch; counts add up; shares of the total", async () => {
    const query = vi.fn(async () => [[{ k: 7, branch: 'East B2B', n: 3 }, { k: null, branch: 'Unknown', n: 1 }]]);
    const out = await fetchNpsDetractorsByBranch({ query } as unknown as Pool, parseNpsQuery({ dateFrom: '2026-01-01', dateTo: '2026-11-15' }), { companyKeys: [1] });
    expect(out).toEqual({ total: 4, branches: [
      { key: '7', branch: 'East B2B', count: 3, share: 0.75 },
      { key: null, branch: 'Unknown', count: 1, share: 0.25 },
    ] });
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/f\.nps_level = 1 AND f\.RatingDateKey BETWEEN \? AND \?/);
    expect(sql).toMatch(/sales_team_key_override/); // the Branch filter's own (admin-override aware) team
    expect(params.slice(0, 2)).toEqual([20260101, 20261115]);
  });
});
