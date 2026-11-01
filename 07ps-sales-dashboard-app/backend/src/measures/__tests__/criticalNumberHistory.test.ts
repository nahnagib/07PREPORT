import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import {
  FALLBACK_CRITICAL_NUMBER,
  criticalNumberLookup,
  criticalNumberOn,
  getCriticalNumber,
  type CriticalNumberHistoryRow,
} from '../criticalNumberHistory';

function row(id: number, valueLyd: number, effectiveFrom: string): CriticalNumberHistoryRow {
  return { id, valueLyd, effectiveFrom, createdBy: null, createdByName: null, createdByEmail: null, createdAt: '', note: null };
}

// newest first, as loadCriticalNumberHistory returns it
const history = [row(4, 700_000, '2026-12-01'), row(3, 650_000, '2026-11-01'), row(2, 600_000, '2026-11-01'), row(1, 560_000, '2026-01-01')];

describe('criticalNumberOn', () => {
  it('returns the value with the latest effective date on or before the day', () => {
    expect(criticalNumberOn(history, '2026-10-31')).toBe(560_000);
    expect(criticalNumberOn(history, '2026-12-01')).toBe(700_000);
    expect(criticalNumberOn(history, new Date(Date.UTC(2026, 11, 31)))).toBe(700_000);
  });

  it('several rows on one date: the newest row wins', () => {
    expect(criticalNumberOn(history, '2026-11-15')).toBe(650_000);
  });

  it('a day before the first row uses the first row', () => {
    expect(criticalNumberOn(history, '2025-06-01')).toBe(560_000);
  });

  it('the per-day lookup gives the same answers', () => {
    const lookup = criticalNumberLookup(history);
    expect(lookup(new Date(Date.UTC(2026, 10, 1)))).toBe(650_000);
    expect(lookup(new Date(Date.UTC(2026, 9, 21)))).toBe(560_000);
  });
});

describe('getCriticalNumber', () => {
  it('reads critical_number_history', async () => {
    const query = vi.fn(async () => [[{ id: 1, valueLyd: '560000.00', effectiveFrom: '2026-01-01', createdBy: null, createdAt: new Date(), note: null }]]);
    expect(await getCriticalNumber({ query } as unknown as Pool, '2026-10-21')).toBe(560_000);
  });

  it('falls back to 560,000 when the table cannot be read (migration 0055 not applied)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const query = vi.fn(async () => {
      throw Object.assign(new Error("Table 'critical_number_history' doesn't exist"), { code: 'ER_NO_SUCH_TABLE' });
    });
    expect(await getCriticalNumber({ query } as unknown as Pool, '2026-10-21')).toBe(FALLBACK_CRITICAL_NUMBER);
  });
});
