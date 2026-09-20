import { beforeAll, describe, expect, it } from 'vitest';
import { deltaTone, fmtCompact, fmtDate, fmtDelta, fmtInt, fmtKpiValue, fmtLyd, fmtMinutes, fmtPct, fmtRatio, fmtSignedPct, fmtTimestampDate, minutesLong, monthName, monthYear, setFormatLocale } from '../format';

beforeAll(() => setFormatLocale('en-US'));

describe('formatters (the API returns raw numbers; formatting happens here)', () => {
  it('LYD amounts', () => {
    expect(fmtLyd(1234567)).toBe('LYD 1,234,567');
    expect(fmtLyd(416.6667, 2)).toBe('LYD 416.67');
    expect(fmtLyd(0)).toBe('LYD 0');
  });
  it('percentages have one decimal', () => {
    expect(fmtPct(5.2778)).toBe('5.3%');
    expect(fmtPct(28.3333)).toBe('28.3%');
    expect(fmtPct(94)).toBe('94.0%');
    expect(fmtSignedPct(14.2857)).toBe('+14.3%');
    expect(fmtSignedPct(-8)).toBe('-8.0%');
  });
  it('ratios read "1 : X" with trailing zeros trimmed', () => {
    expect(fmtRatio(5.6)).toBe('1 : 5.6');
    expect(fmtRatio(5.4167)).toBe('1 : 5.42');
    expect(fmtRatio(5)).toBe('1 : 5');
  });
  it('minutes read "3.5 min" with a "3 min 30 s" tooltip', () => {
    expect(fmtMinutes(3.5)).toBe('3.5 min');
    expect(minutesLong(3.5)).toBe('3 min 30 s');
    expect(minutesLong(0.8)).toBe('0 min 48 s');
    expect(minutesLong(1)).toBe('1 min 0 s');
  });
  it('dates are DD/MM/YYYY without timezone shifts', () => {
    expect(fmtDate('2026-08-10')).toBe('10/08/2026');
    expect(fmtDate('2026-01-01')).toBe('01/01/2026');
    expect(fmtDate('2026-12-31T23:59:59.000Z')).toBe('31/12/2026');
    expect(fmtTimestampDate('2026-09-20T09:00:00.000Z')).toBe('20/09/2026');
  });
  it('month names', () => {
    expect(monthName(8)).toBe('Aug');
    expect(monthName(8, 'long')).toBe('August');
    expect(monthYear(2026, 8)).toBe('August 2026');
    expect(monthName(13)).toBe('n/a');
  });
  it('compact axis ticks', () => {
    expect(fmtCompact(1_200_000)).toBe('1.2M');
    expect(fmtCompact(340_000)).toBe('340K');
    expect(fmtCompact(950)).toBe('950');
  });

  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('%s never renders as NaN / Infinity / undefined', (v) => {
    for (const out of [fmtInt(v), fmtLyd(v), fmtPct(v), fmtSignedPct(v), fmtRatio(v), fmtMinutes(v), minutesLong(v), fmtCompact(v)]) {
      expect(out).toBe('n/a');
    }
  });
  it('bad dates render n/a', () => {
    expect(fmtDate(null)).toBe('n/a');
    expect(fmtDate('garbage')).toBe('n/a');
    expect(fmtTimestampDate('nope')).toBe('n/a');
  });
});

describe('KPI value / delta formatting', () => {
  it('formats a KPI by its unit', () => {
    expect(fmtKpiValue({ value: 5.6, status: 'green', unit: 'ratio' })).toBe('1 : 5.6');
    expect(fmtKpiValue({ value: 46.2963, status: 'red', unit: 'percent' })).toBe('46.3%');
    expect(fmtKpiValue({ value: 416.6667, status: 'red', unit: 'lyd' })).toBe('LYD 416.67');
    expect(fmtKpiValue({ value: 2500, status: 'neutral', unit: 'lyd' })).toBe('LYD 2,500');
    expect(fmtKpiValue({ value: 3.5, status: 'green', unit: 'minutes' })).toBe('3.5 min');
    expect(fmtKpiValue({ value: null, status: 'na', unit: 'percent' })).toBe('n/a');
    expect(fmtKpiValue(null)).toBe('n/a');
  });
  it('deltas are signed in the KPI unit', () => {
    expect(fmtDelta({ value: 1, status: 'green', unit: 'percent', delta: 2.25 })).toBe('+2.3 pp');
    expect(fmtDelta({ value: 1, status: 'green', unit: 'percent', delta: -1.5 })).toBe('−1.5 pp');
    expect(fmtDelta({ value: 1, status: 'green', unit: 'minutes', delta: -0.5 })).toBe('−0.5 min');
    expect(fmtDelta({ value: 1, status: 'green', unit: 'ratio', delta: 2.6 })).toBe('+2.6');
    expect(fmtDelta({ value: 1, status: 'green', unit: 'ratio', delta: null })).toBeNull();
    expect(fmtDelta({ value: 1, status: 'green', unit: 'ratio' })).toBeNull();
  });
  it('whether a change is good or bad follows the API direction, not the sign', () => {
    const k = (delta: number, direction?: 'higher_better' | 'lower_better') => deltaTone({ value: 1, status: 'neutral', unit: 'percent', delta, direction });
    expect(k(2, 'higher_better')).toBe('good');
    expect(k(-2, 'higher_better')).toBe('bad');
    expect(k(2, 'lower_better')).toBe('bad'); // bounce rate up = worse
    expect(k(-2, 'lower_better')).toBe('good');
    expect(k(0, 'higher_better')).toBe('flat');
    expect(k(3)).toBe('unknown');
    expect(deltaTone({ value: 1, status: 'green', unit: 'percent' })).toBeNull();
  });
});
