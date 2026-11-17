import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { computeYtdCard } from '../tachometer';
import { directorTargets, fetchDirectors } from '../salesPeoplePerformance';

/**
 * Director targets (2026-11-17). sales_targets.xlsx rows with TargetLevel = Director carry a B2B / B2C Director's own key
 * and target (= the sum of the segment's Salesperson rows). Every total sums TargetLevel = Salesperson rows only, so the
 * company target never counts a director; the director people of Salesforce Performance read the Director rows.
 */
const ANCHOR = new Date('2026-06-30T00:00:00.000Z'); // end of June: target-to-date = 6 full months

describe('TargetLevel = Director rows', () => {
  it('never count in a company / channel total: every target query sums TargetLevel = Salesperson rows only', async () => {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push(sql);
      if (sql.includes('FROM v_sales_lines')) return [[{ value: 900, volume: 9 }]];
      if (sql.includes('SELECT salesperson_key, target_override_amount')) return [[]];
      if (sql.includes('FROM v_sales_targets')) {
        const months = sql.includes('ftp.Month = ?') ? 1 : sql.includes('ftp.Month < ?') ? Number(params[1]) - 1 : 12;
        return [[{ salespersonKey: 7, target_revenue: 100 * months, target_volume: 0 }]];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const card = await computeYtdCard({ query } as unknown as Pool, ANCHOR, { segmentKeys: [1] }, 'value');
    expect(card.fullPeriodTarget).toBe(1200);
    expect(card.targetToDate).toBeCloseTo(600, 6);
    const targetSql = calls.filter((s) => s.includes('FROM v_sales_targets'));
    expect(targetSql.length).toBeGreaterThan(0);
    for (const sql of targetSql) expect(sql).toContain("LOWER(TRIM(COALESCE(ftp.TargetLevel, ''))) = 'salesperson'");
  });

  it('the directors of the year: one per key and segment, their twelve months, named as in the Salesperson filter', async () => {
    const seen: { sql: string; params: unknown[] }[] = [];
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      seen.push({ sql, params });
      return [[
        { personKey: 54, segmentKey: 1, month: 1, name: 'Mustapha Shaddad', target: 6_210_365.02 },
        { personKey: 54, segmentKey: 1, month: 2, name: 'Mustapha Shaddad', target: 4_140_278.68 },
        { personKey: 42, segmentKey: 2, month: 1, name: 'Mohamed Eljhawi', target: 3_714_456.6 },
      ]];
    });
    const directors = await fetchDirectors({ query } as unknown as Pool, 2026);
    expect(directors.map((d) => [d.key, d.segmentKey, d.name])).toEqual([[54, 1, 'Mustapha Shaddad'], [42, 2, 'Mohamed Eljhawi']]);
    expect(directors[0].monthly.slice(0, 3)).toEqual([6_210_365.02, 4_140_278.68, 0]);
    // the raw SegmentKey of the Director row: an admin override of the director's own invoices never moves the target
    expect(seen[0].sql).toContain("LOWER(TRIM(COALESCE(f.TargetLevel, ''))) = 'director'");
    expect(seen[0].sql).toContain('f.SegmentKey IN (?)');
    expect(seen[0].sql).not.toContain('segment_key_override');
    expect(seen[0].params).toEqual([2026, [1, 2]]);
  });

  it('the own target of a director is prorated like the Tachometer: full months, then the elapsed share of the anchor month', () => {
    const monthly = Array.from({ length: 12 }, (_, i) => (i + 1) * 10); // 10, 20, ... 120
    expect(directorTargets(monthly, ANCHOR)).toEqual({ ytd: 210, fullYear: 780 }); // 10+20+...+60
    const mid = directorTargets(monthly, new Date('2026-07-16T00:00:00.000Z'));
    expect(mid.ytd).toBeCloseTo(210 + 70 * (16 / 31), 6);
  });
});
