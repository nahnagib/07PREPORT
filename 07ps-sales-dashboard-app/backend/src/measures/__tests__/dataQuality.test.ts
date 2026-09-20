import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { computeOpportunityDataQuality } from '../dataQuality';
import { TargetStatus } from '../classify';

/** Mocks pool.query with a single fixture row, same convention as criticalNumber.test.ts. */
function makeMockPool(row: Record<string, number>): Pool {
  const query = vi.fn(async () => [[row]]);
  return { query } as unknown as Pool;
}

describe('computeOpportunityDataQuality', () => {
  it('computes dirtyPct from dirtyRecords / totalRecords and passes through each issue count', async () => {
    const pool = makeMockPool({
      totalRecords: 200,
      missingStage: 4,
      missingSalesSegment: 12,
      missingCreatedDate: 0,
      openMissingExpectedClose: 3,
      conflictingStatusFlags: 1,
      dirtyRecords: 18,
    });

    const result = await computeOpportunityDataQuality(pool, {});

    expect(result.totalRecords).toBe(200);
    expect(result.dirtyRecords).toBe(18);
    expect(result.dirtyPct).toBeCloseTo(0.09, 5);
    expect(result.status).toBe(TargetStatus.RED); // 9% dirty >= the 5% red threshold
    expect(result.issues).toEqual([
      { key: 'missingStage', label: 'Missing Stage', count: 4 },
      { key: 'missingSalesSegment', label: 'Missing Sales Segment', count: 12 },
      { key: 'missingCreatedDate', label: 'Missing Created Date', count: 0 },
      { key: 'openMissingExpectedClose', label: 'Open, Missing Expected Close Date', count: 3 },
      { key: 'conflictingStatusFlags', label: 'Conflicting Status Flags (Open/Won/Lost)', count: 1 },
    ]);
  });

  it('returns a null dirtyPct rather than dividing by zero when there are no records', async () => {
    const pool = makeMockPool({
      totalRecords: 0,
      missingStage: 0,
      missingSalesSegment: 0,
      missingCreatedDate: 0,
      openMissingExpectedClose: 0,
      conflictingStatusFlags: 0,
      dirtyRecords: 0,
    });

    const result = await computeOpportunityDataQuality(pool, {});
    expect(result.dirtyPct).toBeNull();
    expect(result.status).toBe(TargetStatus.NO_TARGET);
  });

  it('bands status green below 2% dirty and yellow between 2% and 5%', async () => {
    const green = await computeOpportunityDataQuality(
      makeMockPool({ totalRecords: 1000, missingStage: 10, missingSalesSegment: 0, missingCreatedDate: 0, openMissingExpectedClose: 0, conflictingStatusFlags: 0, dirtyRecords: 10 }),
      {},
    );
    expect(green.dirtyPct).toBeCloseTo(0.01, 5);
    expect(green.status).toBe(TargetStatus.GREEN);

    const yellow = await computeOpportunityDataQuality(
      makeMockPool({ totalRecords: 1000, missingStage: 30, missingSalesSegment: 0, missingCreatedDate: 0, openMissingExpectedClose: 0, conflictingStatusFlags: 0, dirtyRecords: 30 }),
      {},
    );
    expect(yellow.dirtyPct).toBeCloseTo(0.03, 5);
    expect(yellow.status).toBe(TargetStatus.YELLOW);
  });

  it('does not scope the query by SalesSegment (a B2B filter would hide missing-segment rows)', async () => {
    const query = vi.fn(async (sql: string) => {
      expect(sql).not.toMatch(/SalesSegment\s*=\s*'B2B'/i);
      return [[{ totalRecords: 1, missingStage: 0, missingSalesSegment: 1, missingCreatedDate: 0, openMissingExpectedClose: 0, conflictingStatusFlags: 0, dirtyRecords: 1 }]];
    });
    const pool = { query } as unknown as Pool;
    await computeOpportunityDataQuality(pool, {});
    expect(query).toHaveBeenCalledTimes(1);
  });
});
