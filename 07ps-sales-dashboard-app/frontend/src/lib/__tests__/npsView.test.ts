import { describe, expect, it } from 'vitest';
import type { NpsBandScale, NpsCounts } from '../api';
import { NAV_ITEMS, departmentReports, pageKeyForPath } from '../navItems';
import { GROUPS, barRatio, csatStatus, fmt2, gaugeValue, npsBreakdown, pct, periodLabel, smallSample, trendPoints } from '../nps/view';

const NPS: NpsBandScale = { yellowFrom: 50, greenFrom: 90, target: 90, min: 0, max: 100 };
const CSAT: NpsBandScale = { yellowFrom: 85, greenFrom: 95, target: 95, min: 0, max: 100 };

function counts(p: Partial<NpsCounts>): NpsCounts {
  return { responders: 0, promoters: 0, passives: 0, detractors: 0, promotersPct: null, passivesPct: null, detractorsPct: null,
    nps: null, csat: null, npsBand: null, csatBand: null, belowMinimum: false, ...p };
}

describe('NPS Score view helpers', () => {
  it('the three groups, best first, with stars and Arabic names', () => {
    expect(GROUPS.map((g) => [g.stars, g.label, g.labelAr])).toEqual([
      ['★★★', 'Promoters', 'المروجون'], ['★★', 'Passives', 'المحايدون'], ['★', 'Detractors', 'المنتقدون'],
    ]);
  });

  it('two decimals at display time only; "—" without a value', () => {
    expect(fmt2(64.97175141)).toBe('64.97');
    expect(fmt2(-12.5)).toBe('-12.50');
    expect(fmt2(null)).toBe('—');
    expect(pct(70.0564971)).toBe('70.06%');
    expect(npsBreakdown(counts({ promotersPct: 70.0564971, detractorsPct: 5.0847457 }))).toBe('Promoters 70.06% − Detractors 5.08%');
  });

  it('a small sample says "n = x"', () => {
    expect(smallSample(counts({ responders: 3, belowMinimum: true }))).toBe('n = 3');
    expect(smallSample(counts({ responders: 30 }))).toBeNull();
  });

  it('the gauge is drawn 0..100: a negative NPS pins the needle at 0', () => {
    expect(gaugeValue(-35, NPS)).toBe(0);
    expect(gaugeValue(64.97, NPS)).toBe(64.97);
    expect(gaugeValue(null, NPS)).toBe(0);
    expect(barRatio(95, CSAT)).toBeCloseTo(0.95, 10);
    expect(barRatio(120, CSAT)).toBe(1);
  });

  it('trend: target on every point; a period below the minimum moves to the faded series', () => {
    const points = trendPoints({
      target: 90,
      points: [
        { period: '2026-09', ...counts({}) },
        { period: '2026-10', ...counts({ responders: 177, nps: 64.97175141 }) },
        { period: '2026-11', ...counts({ responders: 3, nps: 33.333, belowMinimum: true }) },
      ],
    });
    expect(points.map((p) => [p.label, p.responders, p.nps, p.npsSmall, p.target])).toEqual([
      ['Sep 2026', 0, null, null, 90], ['Oct 2026', 177, 64.97, null, 90], ['Nov 2026', 3, null, 33.33, 90],
    ]);
    expect([periodLabel('2026-10-05'), periodLabel('2026')]).toEqual(['05 Oct', '2026']);
  });

  it('is on the Process hub, next to the Kaizen Board, gated by nps_score', () => {
    const item = NAV_ITEMS.find((i) => i.href === '/process/nps-score');
    expect(item).toMatchObject({ label: 'NPS Score', pageKey: 'nps_score', department: 'process' });
    expect(departmentReports('process', () => true).map((i) => i.pageKey)).toEqual(['kaizen_board', 'nps_score']);
    expect(departmentReports('process', (k) => k !== 'nps_score').map((i) => i.pageKey)).toEqual(['kaizen_board']);
    expect(pageKeyForPath('/process/nps-score')).toBe('nps_score');
  });
});

describe('csatStatus (bands from config/npsThresholds.ts: red < 85 <= yellow < 95 <= green, target 95)', () => {
  it.each([
    [84.99, 'red', 'Red · 10.01 pts below target 95'],
    [85, 'yellow', 'Yellow · 10.00 pts below target 95'],
    [94.52, 'yellow', 'Yellow · 0.48 pts below target 95'],
    [94.99, 'yellow', 'Yellow · 0.01 pts below target 95'],
    [94.999, 'yellow', 'Yellow · 0.01 pts below target 95'], // shows 95.00% but is below: never "0.00 pts"
    [95, 'green', 'Green · on target'],
    [100, 'green', 'Green · on target'],
  ] as const)('%s -> %s', (value, band, text) => {
    expect(csatStatus(value, band, 95)).toBe(text);
  });

  it('no value, no line', () => {
    expect(csatStatus(null, null, 95)).toBeNull();
  });
});
