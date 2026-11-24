import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { resolveProductPeriod } from '../../lib/last12Months';
import { lengthText, lifecycleBenchmark, lifecycleRule, lifecycleSegmentOf, rangeText, type LifecycleInput } from '../productLifecycle';

/**
 * Product Lifecycle segments on the Date filter's period (measures/productLifecycle.ts): the benchmark is the period vs the
 * prior period of the same length; New / Discontinued keep their fixed rules from the ETL run's date.
 */

const NOW = DateTime.fromISO('2026-11-24T10:00:00', { zone: 'Africa/Tripoli' });
const TODAY = '2026-11-24';
const RULE = lifecycleRule({ lifecycle: { new_first_sale_within_days: 180, growth_threshold_pct: 20, discontinued_no_sales_days: 365, trend_window_days: 90 } });
// An established product, last sold recently.
const sold = (volume: number, volumePrior: number): LifecycleInput => ({ firstSaleDate: '2022-01-10', lastSaleDate: '2026-11-20', volume, volumePrior });
const seg = (r: LifecycleInput) => lifecycleSegmentOf(r, RULE, TODAY);

describe('benchmark period', () => {
  it('defaults to the last 12 months against the 12 months before', () => {
    const p = resolveProductPeriod(undefined, undefined, NOW);
    expect([p.from, p.to, p.priorFrom, p.priorTo]).toEqual(['2025-11-24', '2026-11-24', '2024-11-23', '2025-11-23']);
    const b = lifecycleBenchmark(p, RULE, TODAY, TODAY);
    expect(b.label).toBe('Last 12 months');
    expect(b.priorLabel).toBe('Prior 12 months');
    expect(b.growthPct).toBe(20);
  });

  it('follows a custom range: 1 Dec 2025 – 30 Nov 2026 vs the 365 days before', () => {
    const p = resolveProductPeriod('2025-12-01', '2026-11-30', DateTime.fromISO('2026-12-05T10:00:00', { zone: 'Africa/Tripoli' }));
    expect([p.priorFrom, p.priorTo]).toEqual(['2024-12-01', '2025-11-30']);
    const b = lifecycleBenchmark(p, RULE, '2026-12-05', '2026-12-05');
    // 12 whole months, but not ending today: shown by its dates
    expect(b.label).toBe('1 Dec 2025 – 30 Nov 2026');
    expect(b.priorLabel).toBe('Prior 12 months');
  });

  it('names readable lengths and shows other ranges by their dates', () => {
    const named = (from: string) => lifecycleBenchmark(resolveProductPeriod(from, TODAY, NOW), RULE, TODAY, TODAY);
    expect(named('2026-05-24').label).toBe('Last 6 months');
    expect(named('2026-08-27').label).toBe('Last 90 days');
    const custom = named('2026-01-01');
    expect(custom.label).toBe('1 Jan – 24 Nov 2026');
    expect(custom.priorLabel).toBe('Prior period (7 Feb – 31 Dec 2025)');
    expect(rangeText('2026-11-03', '2026-11-24')).toBe('3 – 24 Nov 2026');
  });

  it('handles a range shorter than 30 days', () => {
    const p = resolveProductPeriod('2026-11-10', '2026-11-24', NOW);
    expect(p.days).toBe(15);
    expect([p.priorFrom, p.priorTo]).toEqual(['2026-10-26', '2026-11-09']);
    expect(lengthText(p)).toBeNull();
    const b = lifecycleBenchmark(p, RULE, TODAY, TODAY);
    expect(b.label).toBe('10 – 24 Nov 2026');
    expect(b.priorLabel).toBe('Prior period (26 Oct – 9 Nov 2026)');
    // the same ±20% rule on those 15 days
    expect(seg(sold(13, 10))).toBe('Growing');
    expect(seg(sold(10, 10))).toBe('Mature');
  });
});

describe('segment rule', () => {
  it('Growing above +20%, Mature within ±20% (boundaries included), Declining below -20%', () => {
    expect(seg(sold(121, 100))).toBe('Growing');
    expect(seg(sold(120, 100))).toBe('Mature');
    expect(seg(sold(80, 100))).toBe('Mature');
    expect(seg(sold(79, 100))).toBe('Declining');
  });

  it('a product with no sale in the prior period is Growing (no divide by zero); nothing in either period is Mature', () => {
    expect(seg(sold(5, 0))).toBe('Growing');
    expect(seg(sold(0, 0))).toBe('Mature');
  });

  it('keeps the fixed rules first: Never sold, Discontinued (365 d), New (180 d) from the as-of date', () => {
    expect(seg({ firstSaleDate: null, lastSaleDate: null, volume: 0, volumePrior: 0 })).toBe('Never sold');
    expect(seg({ firstSaleDate: '2020-01-01', lastSaleDate: '2025-11-24', volume: 0, volumePrior: 3 })).toBe('Discontinued');
    expect(seg({ firstSaleDate: '2020-01-01', lastSaleDate: '2025-11-25', volume: 0, volumePrior: 3 })).toBe('Declining');
    expect(seg({ firstSaleDate: '2026-05-29', lastSaleDate: '2026-11-20', volume: 1, volumePrior: 100 })).toBe('New');
    expect(seg({ firstSaleDate: '2026-05-28', lastSaleDate: '2026-11-20', volume: 1, volumePrior: 100 })).toBe('Declining');
  });

  it('changes with the period: the same product is Growing on 12 months and Declining on the last 90 days', () => {
    // 12 months: 400 units vs 300 before (+33%); last 90 days: 60 vs 120 in the 90 days before (-50%)
    expect(seg(sold(400, 300))).toBe('Growing');
    expect(seg(sold(60, 120))).toBe('Declining');
  });
});
