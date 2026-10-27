import { describe, expect, it } from 'vitest';
import type { NpsCounts } from '../api';
import { NAV_ITEMS, departmentReports, pageKeyForPath } from '../navItems';
import {
  FOLLOWUP_BUCKETS,
  GROUPS,
  bandStatus,
  csatFooter,
  fmt2,
  fmtPts,
  followupCaseHref,
  longDate,
  npsBreakdown,
  npsFooter,
  npsPeriod,
  pct,
  periodCaption,
  periodLabel,
  responseRateMetrics,
  responseRateTooltip,
  smallSample,
  trendPoints,
  tripoliToday,
} from '../nps/view';

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
    expect(npsBreakdown(counts({ promotersPct: 70.0564971, detractorsPct: 5.0847457, nps: 64.97175141 }))).toBe('NPS = % Promoters − % Detractors = 70.06% − 5.08% = 64.97');
  });

  it('a small sample says "n = x"', () => {
    expect(smallSample(counts({ responders: 3, belowMinimum: true }))).toBe('n = 3');
    expect(smallSample(counts({ responders: 30 }))).toBeNull();
  });

  it('trend: no target series; a period below the minimum moves NPS and CSAT to the faded series', () => {
    const points = trendPoints({
      points: [
        { period: '2026-09', ...counts({}) },
        { period: '2026-10', ...counts({ responders: 177, nps: 64.97175141, csat: 94.915254 }) },
        { period: '2026-11', ...counts({ responders: 3, nps: 33.333, csat: 66.6667, belowMinimum: true }) },
      ],
    });
    expect(points.map((p) => [p.label, p.responders, p.nps, p.npsSmall, p.csat, p.csatSmall])).toEqual([
      ['Sep 2026', 0, null, null, null, null],
      ['Oct 2026', 177, 64.97, null, 94.92, null],
      ['Nov 2026', 3, null, 33.33, null, 66.67],
    ]);
    expect(points.every((p) => !('target' in p) && !('csatTarget' in p))).toBe(true);
    // a week is labelled by its Sunday
    expect([periodLabel('2026-10-04'), periodLabel('2026')]).toEqual(['04 Oct', '2026']);
  });

  it('is on the Process hub, next to the Kaizen Board, gated by nps_score', () => {
    const item = NAV_ITEMS.find((i) => i.href === '/process/nps-score');
    expect(item).toMatchObject({ label: 'NPS Score', pageKey: 'nps_score', department: 'process' });
    expect(departmentReports('process', () => true).map((i) => i.pageKey)).toContain('nps_score');
    expect(departmentReports('process', (k) => k !== 'nps_score').map((i) => i.pageKey)).not.toContain('nps_score');
    expect(pageKeyForPath('/process/nps-score')).toBe('nps_score');
  });
});

describe('the period: YTD by default, Tripoli time', () => {
  it('the untouched date filter (Jan 1 -> today in UTC) becomes Jan 1 -> today in Tripoli', () => {
    const now = new Date('2026-10-20T10:00:00Z');
    expect(tripoliToday(now)).toBe('2026-10-20');
    const p = npsPeriod('2026-01-01', '2026-10-20', now);
    expect(p).toEqual({ dateFrom: '2026-01-01', dateTo: '2026-10-20', ytd: true });
    expect(periodCaption(p)).toBe('YTD · 01 Jan – 20 Oct 2026');
  });

  it('just after midnight in Tripoli (still yesterday in UTC) the YTD already includes today', () => {
    const now = new Date('2026-10-20T22:30:00Z'); // 00:30 on 21 October in Tripoli
    expect(npsPeriod('2026-01-01', '2026-10-20', now)).toEqual({ dateFrom: '2026-01-01', dateTo: '2026-10-21', ytd: true });
    // on New Year's night the YTD starts over in Tripoli
    expect(npsPeriod('2026-01-01', '2026-12-31', new Date('2026-12-31T23:30:00Z'))).toEqual({ dateFrom: '2027-01-01', dateTo: '2027-01-01', ytd: true });
  });

  it('a chosen range is kept and labelled as it is', () => {
    const now = new Date('2026-10-20T10:00:00Z');
    const p = npsPeriod('2026-08-01', '2026-09-15', now);
    expect(p).toEqual({ dateFrom: '2026-08-01', dateTo: '2026-09-15', ytd: false });
    expect(periodCaption(p)).toBe('01 Aug – 15 Sep 2026');
    expect(periodCaption(npsPeriod('2025-12-15', '2026-01-10', now))).toBe('15 Dec 2025 – 10 Jan 2026');
    expect(longDate('2026-10-03')).toBe('03 Oct 2026');
    expect(longDate(null)).toBe('—');
  });
});

describe('the top row', () => {
  it('pill status from the API band: red Critical, yellow Behind Target, green On Track, none grey', () => {
    expect([bandStatus('red'), bandStatus('yellow'), bandStatus('green'), bandStatus(null)]).toEqual(['alert', 'watch', 'success', 'neutral']);
  });

  it('variance in points with a real minus sign', () => {
    expect(fmtPts(-11.5384)).toBe('−11.54 pts');
    expect(fmtPts(1.249)).toBe('+1.25 pts');
    expect(fmtPts(0.001)).toBe('0.00 pts');
    expect(fmtPts(null)).toBe('—');
  });

  it('NPS footer: Promoters % · Passives % · Detractors % · Responders (no last-year tiles)', () => {
    const t = counts({ responders: 177, promoters: 124, passives: 44, detractors: 9, promotersPct: 70.0564971, passivesPct: 24.858757, detractorsPct: 5.0847457 });
    expect(npsFooter(t).map((m) => [m.label, m.value])).toEqual([
      ['Promoters', '70.06%'], ['Passives', '24.86%'], ['Detractors', '5.08%'], ['Responders', '177'],
    ]);
  });

  it('CSAT footer: Satisfied (# Passives + Promoters) · Responders · Target 95 · Variance (pts)', () => {
    const t = counts({ responders: 177, promoters: 124, passives: 44, detractors: 9, csat: 94.915254 });
    expect(csatFooter(t, 95).map((m) => [m.label, m.value])).toEqual([
      ['Satisfied', '168'], ['Responders', '177'], ['Target', '95'], ['Variance', '−0.08 pts'],
    ]);
    // the consistency rule the page relies on: satisfied + detractors = responders
    expect(Number(csatFooter(t, 95)[0].value) + t.detractors).toBe(t.responders);
  });

  it('response rate: "Target 30%", variance in points, and the tooltip with both views', () => {
    expect(responseRateMetrics({ target: 30, variancePts: -11.54 }).map((m) => [m.label, m.value])).toEqual([['Target', '30%'], ['Variance', '−11.54 pts']]);
    const tip = responseRateTooltip({ responders: 120, delivered: 300, read: 350, reached: 650, totalReach: 900, rate: (120 / 650) * 100, rateOfReach: (120 / 900) * 100 });
    expect(tip.split('\n')).toEqual([
      'Responders ÷ (Delivered + Read) = 120 ÷ (300 + 350) = 18.46%',
      'Responders ÷ Total Reach = 120 ÷ 900 = 13.33%',
      'Customers can only answer a message that reached them.',
    ]);
  });
});

describe('follow-up', () => {
  it('status buckets: muted semantic accents for solved, blue pending', () => {
    expect(FOLLOWUP_BUCKETS.map((b) => [b.key, b.color])).toEqual([
      ['solved_48h', 'var(--ps-nps-teal)'], ['solved_5d', 'var(--ps-nps-amber)'], ['solved_late', 'var(--ps-nps-rose)'], ['pending', 'var(--ps-nps-blue)'],
    ]);
  });

  it('a row opens its case on the follow-up page; a Historical case over the List view', () => {
    expect(followupCaseHref(12)).toBe('/process/nps-followup?case=12');
    expect(followupCaseHref(7, true)).toBe('/process/nps-followup?view=list&case=7');
  });
});
