import { describe, expect, it } from 'vitest';
import { buildTicks, dayNumber, layoutBar, markerPos, periodRange, pixelsPerDay, rangeDays, tickGranularity } from '../gantt';

const label = (y: number, m: number, showYear: boolean) => `${m}${showYear ? `/${y}` : ''}`;
const YEAR = { start: '2026-01-01', end: '2026-12-31' };

describe('bar geometry', () => {
  it('a bar inside the range', () => {
    // Feb 1 -> Mar 15 2026 = 42 days of 365
    const g = layoutBar(YEAR, { start: '2026-02-01', end: '2026-03-15' });
    expect(g).toMatchObject({ visible: true, clippedStart: false, clippedEnd: false, milestone: false });
    expect(g.left).toBeCloseTo((31 / 365) * 100, 6);
    expect(g.width).toBeCloseTo((43 / 365) * 100, 6); // inclusive of both end days
  });

  it('a bar that starts before the period is clipped at the start (arrow)', () => {
    const g = layoutBar(YEAR, { start: '2025-11-20', end: '2026-02-15' });
    expect(g).toMatchObject({ visible: true, clippedStart: true, clippedEnd: false, left: 0 });
    expect(g.width).toBeCloseTo((46 / 365) * 100, 6);
  });

  it('a bar that ends after the period is clipped at the end (arrow), and crossing a year boundary works', () => {
    const g = layoutBar(YEAR, { start: '2026-11-15', end: '2027-02-10' });
    expect(g).toMatchObject({ visible: true, clippedStart: false, clippedEnd: true });
    expect(g.left + g.width).toBeCloseTo(100, 6);
  });

  it('a bar spanning both sides fills the axis with two arrows', () => {
    const g = layoutBar(YEAR, { start: '2025-06-01', end: '2027-06-01' });
    expect(g).toMatchObject({ visible: true, clippedStart: true, clippedEnd: true, left: 0 });
    expect(g.width).toBeCloseTo(100, 6);
  });

  it('a bar entirely outside is not visible (but reports which side)', () => {
    expect(layoutBar(YEAR, { start: '2025-01-01', end: '2025-12-31' })).toMatchObject({ visible: false, clippedStart: true });
    expect(layoutBar(YEAR, { start: '2027-01-01', end: '2027-02-01' })).toMatchObject({ visible: false, clippedEnd: true });
  });

  it('a one-day bar is one day wide', () => {
    expect(layoutBar(YEAR, { start: '2026-05-05', end: '2026-05-05' }).width).toBeCloseTo((1 / 365) * 100, 6);
  });

  it('no end date -> a milestone on the start date', () => {
    const g = layoutBar(YEAR, { start: '2026-07-16', end: null });
    expect(g).toMatchObject({ visible: true, milestone: true });
    expect(g.width).toBeCloseTo((1 / 365) * 100, 6);
    expect(layoutBar(YEAR, { start: '2026-07-16' }).milestone).toBe(true);
    expect(layoutBar(YEAR, { start: '2027-07-16', end: null }).visible).toBe(false);
  });

  it('invalid input never yields NaN geometry', () => {
    const g = layoutBar(YEAR, { start: 'nope', end: '2026-01-02' });
    expect(g.visible).toBe(false);
    expect(Number.isNaN(g.left)).toBe(false);
  });

  it('the last day of the range is inside it', () => {
    expect(layoutBar(YEAR, { start: '2026-12-31', end: '2026-12-31' }).visible).toBe(true);
  });
});

describe('axis ticks adapt to the range', () => {
  it('granularity: days for short ranges, weeks for medium, months for long', () => {
    expect(tickGranularity(31)).toBe('day');
    expect(tickGranularity(120)).toBe('week');
    expect(tickGranularity(365)).toBe('month');
    expect(pixelsPerDay(31)).toBeGreaterThan(pixelsPerDay(120));
    expect(pixelsPerDay(120)).toBeGreaterThan(pixelsPerDay(365));
  });

  it('a full year: 12 month ticks and no day/week clutter', () => {
    const ticks = buildTicks(YEAR, label);
    expect(ticks.filter((t) => t.major)).toHaveLength(12);
    expect(ticks.filter((t) => !t.major)).toHaveLength(0);
    expect(ticks[0]).toMatchObject({ pos: 0, label: '1/2026' });
    expect(ticks[1].label).toBe('2'); // year only shown on January
  });

  it('a single month: one major tick plus a tick per day', () => {
    const ticks = buildTicks({ start: '2026-08-01', end: '2026-08-31' }, label);
    expect(ticks.filter((t) => t.major)).toHaveLength(1);
    expect(ticks.filter((t) => !t.major)).toHaveLength(30);
  });

  it('a few months: weekly ticks on Mondays', () => {
    const ticks = buildTicks({ start: '2026-02-01', end: '2026-05-31' }, label);
    const weeks = ticks.filter((t) => !t.major);
    expect(weeks.length).toBeGreaterThan(12);
    expect(weeks.length).toBeLessThan(20);
    expect(ticks.filter((t) => t.major)).toHaveLength(4);
  });

  it('a range that crosses a year boundary labels the year on the new year', () => {
    const ticks = buildTicks({ start: '2026-11-01', end: '2027-02-28' }, label).filter((t) => t.major);
    expect(ticks.map((t) => t.label)).toEqual(['11/2026', '12', '1/2027', '2']);
  });

  it('a range starting mid-month still gets a first label', () => {
    expect(buildTicks({ start: '2026-08-15', end: '2026-10-15' }, label)[0]).toMatchObject({ major: true, pos: 0 });
  });
});

describe('today marker and period range', () => {
  it('positions today inside the range, null outside', () => {
    expect(markerPos(YEAR, '2026-01-01')).toBeCloseTo((0.5 / 365) * 100, 6);
    expect(markerPos(YEAR, '2026-09-20')).toBeGreaterThan(70);
    expect(markerPos(YEAR, '2027-01-01')).toBeNull();
    expect(markerPos(YEAR, '2025-12-31')).toBeNull();
  });
  it('period -> axis range (last day handles leap years)', () => {
    expect(periodRange({ year: 2026, fromMonth: 1, toMonth: 8 })).toEqual({ start: '2026-01-01', end: '2026-08-31' });
    expect(periodRange({ year: 2028, fromMonth: 2, toMonth: 2 })).toEqual({ start: '2028-02-01', end: '2028-02-29' });
    expect(rangeDays(periodRange({ year: 2026, fromMonth: 1, toMonth: 12 }))).toBe(365);
  });
  it('day numbers are timezone-free', () => {
    expect(dayNumber('2026-03-15') - dayNumber('2026-02-01')).toBe(42);
    expect(Number.isNaN(dayNumber('x'))).toBe(true);
  });
});
