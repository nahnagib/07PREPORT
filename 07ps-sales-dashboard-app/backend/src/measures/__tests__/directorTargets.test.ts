import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { computeYtdCard } from '../tachometer';
import { directorCard } from '../salesPeoplePerformance';

/**
 * Director targets (2026-11-15). sales_targets.xlsx rows with TargetLevel = Director (SalesSegment B2B / B2C) are a
 * channel owner's own target: they replace the channel sum on that director's card and never add to any total.
 * The fake pool answers by SQL text: people rows (TargetLevel <> 'director') = 1,200 / year (100 a month),
 * director rows (TargetLevel = 'director') = `director` / year, sales = 900.
 */
function fakePool(directorPerYear: number) {
  const calls: string[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push(sql);
    if (sql.includes('FROM v_sales_lines')) return [[{ value: 900, volume: 9 }]];
    if (sql.includes('SELECT salesperson_key, target_override_amount')) return [[]];
    if (sql.includes('FROM v_sales_targets')) {
      const months = sql.includes('ftp.Month = ?') ? 1 : sql.includes('ftp.Month < ?') ? Number(params[1]) - 1 : 12;
      const director = sql.includes("= 'director'");
      const perMonth = director ? directorPerYear / 12 : 100;
      return [director && directorPerYear === 0 ? [] : [{ salespersonKey: director ? null : 7, target_revenue: perMonth * months, target_volume: 0 }]];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  return { pool: { query } as unknown as Pool, calls };
}

const ANCHOR = new Date('2026-06-30T00:00:00.000Z'); // end of June: target-to-date = 6 full months

describe('TargetLevel = Director rows', () => {
  it('never count in a company / channel total: every people target query leaves them out', async () => {
    const { pool, calls } = fakePool(2400);
    const card = await computeYtdCard(pool, ANCHOR, { segmentKeys: [1] }, 'value');
    expect(card.fullPeriodTarget).toBe(1200);
    expect(card.targetToDate).toBeCloseTo(600, 6);
    const targetSql = calls.filter((s) => s.includes('FROM v_sales_targets'));
    expect(targetSql.length).toBeGreaterThan(0);
    for (const sql of targetSql) expect(sql).toContain("LOWER(TRIM(COALESCE(ftp.TargetLevel, ''))) <> 'director'");
  });

  it('replace the channel sum on the director card when the channel has any', async () => {
    const { pool } = fakePool(2400);
    const card = await directorCard(pool, ANCHOR, { segmentKeys: [1] });
    expect(card.targetSource).toBe('director_rows');
    expect(card.fullYearTarget).toBe(2400);
    expect(card.target).toBeCloseTo(1200, 6);   // 6 of 12 months, the same proration as the Tachometer
    expect(card.actual).toBe(900);               // the channel's sales, unchanged
    expect(card.status).toBe('need_attention');  // 900 / 1,200 = 75%
  });

  it('without director rows the card uses the channel target (the people rows of that channel)', async () => {
    const { pool } = fakePool(0);
    const card = await directorCard(pool, ANCHOR, { segmentKeys: [2] });
    expect(card.targetSource).toBe('channel');
    expect(card.fullYearTarget).toBe(1200);
    expect(card.target).toBeCloseTo(600, 6);
    expect(card.status).toBe('top_performer');   // 900 / 600 = 150%
  });

  it('admin overrides apply to people rows only, never to a director row', async () => {
    const { pool, calls } = fakePool(2400);
    await computeYtdCard(pool, ANCHOR, { segmentKeys: [1] }, 'value', { targetLevel: 'director' });
    expect(calls.some((s) => s.includes('SELECT salesperson_key, target_override_amount'))).toBe(false);
  });
});
