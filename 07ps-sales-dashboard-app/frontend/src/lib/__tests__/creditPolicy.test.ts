import { describe, expect, it } from 'vitest';
import { ZONES } from './fixtures/creditZones';
import {
  CHART_MIN_WIDTH,
  chartColumns,
  creditBucket,
  creditBucketOptions,
  dotRadius,
  lastZoneAxisLabel,
  layoutCreditDots,
  nextZoneText,
  overlaps,
  placeTooltip,
  xOfDays,
  timelineSections,
  zoneRange,
} from '../debt/creditPolicy';


describe('words', () => {
  it('ranges and the last axis label', () => {
    expect(zoneRange(ZONES[0])).toBe('0 – 15 Days');
    expect(zoneRange(ZONES[3])).toBe('45+ Days');
    expect(lastZoneAxisLabel(ZONES)).toBe('>65 Days');
  });

  it('"Moves to [next zone / owner] in X days if unpaid."', () => {
    expect(nextZoneText({ nextZone: 'YELLOW', daysToNextZone: 3 }, ZONES)).toBe('Moves to YELLOW (Sales Director) in 3 days if unpaid.');
    expect(nextZoneText({ nextZone: null, daysToNextZone: null }, ZONES)).toBeNull();
  });
});

describe('Customer overdue analysis aging ranges', () => {
  it('uses standard aging rather than policy colors; keeps not due and credits-only distinct', () => {
    const ceo = creditBucket({ zone: 'BLOCK', daysOverdue: 49, daysUntilDue: 0 });
    const nyd = creditBucket({ zone: 'NOT_YET_DUE', daysOverdue: 0, daysUntilDue: 5 });
    const none = creditBucket(null);
    expect(ceo).toMatchObject({ label: 'Overdue 31 – 60', filterValue: 'Overdue 31 – 60', tone: null, sortValue: 50 });
    expect(nyd).toMatchObject({ label: 'Not yet due', tone: null });
    expect(none).toMatchObject({ label: '—', tone: null });
    expect(none.sortValue < nyd.sortValue && nyd.sortValue < creditBucket({ zone: 'GREEN', daysOverdue: 0, daysUntilDue: 0 }).sortValue).toBe(true);
    expect(creditBucket({ zone: 'NOT_YET_DUE', daysOverdue: 0, daysUntilDue: 30 }).sortValue).toBeLessThan(nyd.sortValue);
    expect(creditBucket({ zone: 'NOT_YET_DUE', daysOverdue: -1, daysUntilDue: 0 }).detail).toContain('due today');
  });

  it.each([[0, 'Overdue 1 – 30'], [29, 'Overdue 1 – 30'], [30, 'Overdue 31 – 60'], [59, 'Overdue 31 – 60'],
    [60, 'Overdue 61 – 90'], [89, 'Overdue 61 – 90'], [90, 'Overdue 90+'], [419, 'Overdue 90+']])('policy day %s maps to %s from the due date', (policyDays, label) => {
    const bucket = creditBucket({ zone: 'BLOCK', daysOverdue: Number(policyDays), daysUntilDue: 0 });
    expect(bucket.label).toBe(label);
    expect(bucket.detail).toContain(`${Number(policyDays) + 1} day`);
  });

  it('filter options are non-overlapping day ranges', () => {
    expect(creditBucketOptions().map((o) => o.value)).toEqual(['Not yet due', 'Overdue 1 – 30', 'Overdue 31 – 60', 'Overdue 61 – 90', 'Overdue 90+', '—']);
  });
});

describe('chart geometry', () => {
  it('columns: Day 0, then four main zones left to right without gaps; the 5-day zone keeps room for its text', () => {
    const c = chartColumns(1200, ZONES);
    expect(c.zones).toHaveLength(4);
    expect(c.sections).toHaveLength(6);
    expect(c.zones[0].x0).toBe(0);
    for (let i = 1; i < c.zones.length; i++) expect(c.zones[i].x0).toBeCloseTo(c.zones[i - 1].x1, 6);
    expect(c.zones[c.zones.length - 1].x1).toBe(1200);
    expect(c.sections[4].x1 - c.sections[4].x0).toBeGreaterThanOrEqual(128); // CRITICAL, 61-65
    expect(c.zones.slice(0, 4).every((z) => z.x1 - z.x0 >= 96)).toBe(true);
  });

  it('a narrow screen keeps the minimum width (the chart scrolls inside its panel)', () => {
    expect(chartColumns(360, ZONES).width).toBe(CHART_MIN_WIDTH);
  });

  it('inside a zone, x is linear in days', () => {
    const col = { key: 'CEO', x0: 500, x1: 660 };
    const a = xOfDays(45, timelineSections(ZONES)[3], col);
    const b = xOfDays(52.5, timelineSections(ZONES)[3], col);
    const c = xOfDays(60, timelineSections(ZONES)[3], col);
    expect(b - a).toBeCloseTo(c - b, 6);
    expect(a).toBeGreaterThan(col.x0);
    expect(c).toBeLessThan(col.x1);
  });

  it('overflow x reflects actual days, not customer rank', () => {
    const customers = [66, 67, 156].map((daysOverdue, customerKey) => ({ customerKey, daysOverdue, zone: 'BLOCK' as const, overdueAmount: 100 }));
    const { dots } = layoutCreditDots(customers, ZONES, chartColumns(1200, ZONES));
    const x = (id: number) => dots.find((d) => d.id === String(id))!.x;
    expect((x(2) - x(1)) / (x(1) - x(0))).toBeCloseTo(89, 6);
  });

  it('fits dense clusters into a compact band without overlaps, changing x, or dropping customers', () => {
    const customers = Array.from({ length: 180 }, (_, i) => ({ customerKey: i + 1, zone: 'BLOCK' as const,
      daysOverdue: 66 + i % 15, overdueAmount: 1000 + i * 100 }));
    const cols = chartColumns(1100, ZONES);
    const original = layoutCreditDots(customers, ZONES, cols);
    const compact = layoutCreditDots(customers, ZONES, cols, { maxHeight: 170 });
    expect(original.bottom - original.top).toBeGreaterThan(170);
    expect(compact.bottom - compact.top).toBeLessThanOrEqual(170);
    expect(compact.dots).toHaveLength(customers.length);
    const before = new Map(original.dots.map((d) => [d.id, d]));
    const scales = compact.dots.map((d) => d.r / before.get(d.id)!.r);
    for (const d of compact.dots) expect(d.x).toBe(before.get(d.id)!.x);
    for (const scale of scales) expect(scale).toBeCloseTo(scales[0], 6);
    for (let i = 0; i < compact.dots.length; i++) for (let j = i + 1; j < compact.dots.length; j++) {
      expect(overlaps(compact.dots[i], compact.dots[j])).toBe(false);
    }
  });

  it('dot area is proportional to the amount (sqrt), within min / max', () => {
    expect(dotRadius(100, 100)).toBe(17);
    expect(dotRadius(25, 100)).toBeCloseTo(8.5, 6);
    expect(dotRadius(0.0001, 100)).toBe(3.5);
  });

  it('every dot in its own zone, none overlapping; BLOCK overflow follows days; not-yet-due has no dot', () => {
    const customers = [
      ...Array.from({ length: 120 }, (_, i) => ({ customerKey: i + 1, zone: 'GREEN' as const, daysOverdue: i % 16, overdueAmount: 1000 + i * 37 })),
      ...Array.from({ length: 60 }, (_, i) => ({ customerKey: 500 + i, zone: 'BLOCK' as const, daysOverdue: 66 + i * 7, overdueAmount: 20000 - i * 100 })),
      { customerKey: 900, zone: 'BLOCK' as const, daysOverdue: 63, overdueAmount: 5000 },
      { customerKey: 901, zone: 'NOT_YET_DUE' as const, daysOverdue: 0, overdueAmount: 9000 },
    ];
    const cols = chartColumns(1200, ZONES);
    const { dots } = layoutCreditDots(customers, ZONES, cols);
    expect(dots).toHaveLength(customers.length - 1);
    for (let i = 0; i < dots.length; i++) for (let j = i + 1; j < dots.length; j++) expect(overlaps(dots[i], dots[j]), `${dots[i].id} / ${dots[j].id}`).toBe(false);
    const legal = cols.sections[5];
    const legalDots = dots.filter((d) => Number(d.id) >= 500 && Number(d.id) < 900);
    expect(legalDots.every((d) => d.overflow && d.x > legal.x0 && d.x < legal.x1)).toBe(true);
    const critical = dots.find((d) => d.id === '900')!;
    expect(critical.x).toBeGreaterThan(cols.sections[4].x0);
    expect(critical.x).toBeLessThan(cols.sections[4].x1);
  });
});

describe('tooltip placement', () => {
  it('beside the dot when there is room, always inside the viewport', () => {
    expect(placeTooltip({ left: 100, top: 100, right: 110, bottom: 110 }, { width: 300, height: 200 }, { width: 1200, height: 800 })).toEqual({ left: 120, top: 8 });
    const nearRight = placeTooltip({ left: 1180, top: 400, right: 1190, bottom: 410 }, { width: 300, height: 200 }, { width: 1200, height: 800 });
    expect(nearRight.left + 300).toBeLessThanOrEqual(1192);
    const phone = placeTooltip({ left: 180, top: 700, right: 190, bottom: 710 }, { width: 340, height: 260 }, { width: 360, height: 760 });
    expect(phone.left).toBeGreaterThanOrEqual(8);
    expect(phone.top + 260).toBeLessThanOrEqual(752);
  });
});
