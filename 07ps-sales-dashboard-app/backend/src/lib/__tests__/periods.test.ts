import { describe, expect, it } from 'vitest';
import {
  PeriodQueryError,
  changePct,
  lastYearInterval,
  lastYearIso,
  parseGranularity,
  periodBucketSql,
  periodRangeSql,
  periodStartIso,
  periodWindow,
} from '../periods';

describe('the shared period window (Daily / Weekly / Monthly / Yearly)', () => {
  it('Weekly is the default; anything else that is not a granularity is a 400', () => {
    expect(parseGranularity(undefined)).toBe('week');
    expect(parseGranularity('')).toBe('week');
    expect(parseGranularity('year')).toBe('year');
    expect(() => parseGranularity('quarter')).toThrow(PeriodQueryError);
    expect(() => parseGranularity(['day'])).toThrow(PeriodQueryError);
  });

  it('always 30 / 12 / 12 / 5 periods, ending with the period holding today (flagged in progress)', () => {
    const today = '2026-11-09'; // a Monday
    const d = periodWindow('day', today);
    expect([d.periods.length, d.from, d.to, d.periods.at(-1)?.start]).toEqual([30, '2026-10-11', '2026-11-09', '2026-11-09']);
    const w = periodWindow('week', today);
    expect([w.periods.length, w.from, w.to]).toEqual([12, '2026-08-22', '2026-11-09']);
    expect(w.periods.at(-1)).toEqual({ start: '2026-11-07', end: '2026-11-13', inProgress: true });
    expect(w.previous).toEqual({ start: '2026-08-15', end: '2026-08-21' });
    const m = periodWindow('month', today);
    expect([m.periods.length, m.from, m.periods.at(-1)?.end]).toEqual([12, '2025-12-01', '2026-11-30']);
    const y = periodWindow('year', today);
    expect(y.periods.map((p) => p.start)).toEqual(['2022-01-01', '2023-01-01', '2024-01-01', '2025-01-01', '2026-01-01']);
    for (const win of [d, w, m, y]) expect(win.periods.filter((p) => p.inProgress)).toHaveLength(1);
  });

  it('weeks run Saturday..Friday (lib/businessWeek.ts, the Collections and NPS week)', () => {
    expect(periodStartIso('2026-11-07', 'week')).toBe('2026-11-07'); // Saturday
    expect(periodStartIso('2026-11-13', 'week')).toBe('2026-11-07'); // its Friday
    expect(periodStartIso('2026-11-14', 'week')).toBe('2026-11-14');
    expect(periodWindow('week', '2027-01-02').periods.at(-1)?.start).toBe('2027-01-02'); // a week across New Year
    expect(periodWindow('week', '2027-01-01').periods.at(-1)?.start).toBe('2026-12-26');
  });

  it('months and years cross the year end; a leap day is handled', () => {
    expect(periodWindow('month', '2026-01-31').from).toBe('2025-02-01');
    expect(periodWindow('day', '2024-03-01').periods.map((p) => p.start)).toContain('2024-02-29');
    expect(lastYearIso('2024-02-29', 'month')).toBe('2023-02-28');
    expect(lastYearIso('2026-11-07', 'week')).toBe('2025-11-08'); // 52 weeks back: the same weekday
    expect([lastYearInterval('day'), lastYearInterval('year')]).toEqual(['INTERVAL 364 DAY', 'INTERVAL 1 YEAR']);
  });

  it('SQL: bucketing in SELECT / GROUP BY, a plain range on the column in WHERE (the date index still applies)', () => {
    expect(periodBucketSql('day', 'dd.Date')).toBe("DATE_FORMAT(dd.Date, '%Y-%m-%d')");
    expect(periodBucketSql('week', 'dd.Date')).toBe("DATE_FORMAT(DATE_SUB(dd.Date, INTERVAL MOD(DAYOFWEEK(dd.Date), 7) DAY), '%Y-%m-%d')");
    expect(periodBucketSql('month', 'dd.Date')).toBe("DATE_FORMAT(dd.Date, '%Y-%m-01')");
    expect(periodBucketSql('year', 'dd.Date')).toBe("DATE_FORMAT(dd.Date, '%Y-01-01')");
    expect(periodRangeSql('t.OrderDate', '2026-08-15', '2026-11-09')).toEqual({ sql: 't.OrderDate >= ? AND t.OrderDate < ?', params: ['2026-08-15', '2026-11-10'] });
  });

  it('period-over-period change: null without a previous value or against 0', () => {
    expect(changePct(150, 100)).toBe(0.5);
    expect(changePct(50, -100)).toBe(1.5);
    expect(changePct(10, 0)).toBeNull();
    expect(changePct(null, 10)).toBeNull();
  });
});
