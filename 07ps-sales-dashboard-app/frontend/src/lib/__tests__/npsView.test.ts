import { describe, expect, it } from 'vitest';
import type { NpsCounts } from '../api';
import { NAV_ITEMS, departmentReports, pageKeyForPath } from '../navItems';
import {
  FOLLOWUP_STATUS_SLICES,
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
  estimateBadge,
  measuredLine,
  rateFraction,
  reachBoxTooltip,
  reachSubtitle,
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

  it('trend: no target series; a period below the minimum moves NPS and CSAT to the faded series; before the first rating = a gap', () => {
    const at = (period: string, measured: boolean, c: Parameters<typeof counts>[0]) => ({ period, end: period, inProgress: false, measured, ...counts(c) });
    const points = trendPoints({
      granularity: 'month',
      points: [
        at('2026-08-01', false, {}),
        at('2026-09-01', true, {}),
        at('2026-10-01', true, { responders: 177, nps: 64.97175141, csat: 94.915254 }),
        at('2026-11-01', true, { responders: 3, nps: 33.333, csat: 66.6667, belowMinimum: true }),
      ],
    });
    expect(points.map((p) => [p.label, p.responders, p.nps, p.npsSmall, p.csat, p.csatSmall])).toEqual([
      ['Aug 2026', null, null, null, null, null],
      ['Sep 2026', 0, null, null, null, null],
      ['Oct 2026', 177, 64.97, null, 94.92, null],
      ['Nov 2026', 3, null, 33.33, null, 66.67],
    ]);
    expect(points.every((p) => !('target' in p) && !('csatTarget' in p))).toBe(true);
    // a week is labelled by its Saturday (Saturday..Friday)
    expect(trendPoints({ granularity: 'week', points: [at('2026-10-03', true, {})] })[0].label).toBe('03 Oct');
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
      'Customers can only answer a message that reached them.',
    ]);
  });

  it('response rate with the estimate: formula, one line per company, the basis (outage week left out), measured-only rate, why', () => {
    const r = {
      responders: 801, delivered: 1129, read: 2650, reached: 3779, totalReach: 4923, rate: (801 / 3779) * 100, rateOfReach: 16.3,
      reachStart: '2026-10-03', isEstimated: true, measured: { from: '2026-10-03', responders: 269, reached: 1222, rate: (269 / 1222) * 100 },
      estimate: { from: '2026-07-12', to: '2026-10-02', weeks: 83 / 7, perWeek: 278, reached: 2557, basis: 'auto' as const, basisWeeks: 4, basisFrom: '2026-10-03',
        basisTo: '2026-10-30', excludedWeeks: ['2026-10-31'],
        byCompany: [{ companyKey: 1, company: 'MAJAAL', from: '2026-07-12', to: '2026-10-02', weeks: 83 / 7, perWeek: 86.25, reached: 1023 },
          { companyKey: 3, company: 'TIKA', from: '2026-08-08', to: '2026-10-02', weeks: 8, perWeek: 191.75, reached: 1534 }] },
    };
    expect(responseRateTooltip(r).split('\n')).toEqual([
      'Responders ÷ (Delivered + Read) = 801 ÷ (1,222 measured + 2,557 estimated) = 21.20%',
      'MAJAAL: 86.3 per week × 11.86 weeks (12 Jul – 02 Oct) = 1,023',
      'TIKA: 191.8 per week × 8.00 weeks (08 Aug – 02 Oct) = 1,534',
      'Per week = average Delivered + Read of 4 complete weeks, 03 Oct – 30 Oct; left out: week of 31 Oct (Meta outage)',
      'Measured since 03 Oct: 269 ÷ 1,222 = 22.01%',
      'The WhatsApp source did not keep successful messages before 03 Oct, so that part is estimated.',
    ]);
    expect(responseRateTooltip({ ...r, estimate: { ...r.estimate, basis: 'fixed' as const, basisWeeks: 0, basisFrom: null, basisTo: null, excludedWeeks: [] } }).split('\n')[3])
      .toBe("Per week: fixed setting, split by the companies' measured share");
    expect(rateFraction(r)).toBe('801 responders ÷ 3,779 reached');
    expect(estimateBadge(r)).toBe('incl. estimate · 12 Jul – 02 Oct');
    expect(estimateBadge({ isEstimated: false, estimate: null })).toBeNull();
    expect(measuredLine(r)).toBe('Measured since 03 Oct: 22.01%');
    expect(measuredLine({ measured: null, reachStart: '2026-10-03' })).toBe('Measured since 03 Oct: —');
  });

  it('Message reach: the card tooltip (measured + gap; Error actual) and the subtitle', () => {
    const est = { from: '2026-07-12', to: '2026-10-02' };
    expect(reachBoxTooltip('delivered', 365, 764, '2026-10-03', est)).toBe('Measured from 03 Oct: 365\n12 Jul – 02 Oct (estimated): 764\nTotal: 1,129');
    expect(reachBoxTooltip('error', 433, 521, '2026-10-03', est)).toBe('Measured from 03 Oct: 433\n12 Jul – 02 Oct (actual, kept by the source): 521\nTotal: 954');
    expect(reachSubtitle('2026-10-03', est)).toBe('Measured from 03 Oct 2026 · 12 Jul – 02 Oct estimated');
  });
});

describe('follow-up', () => {
  it('the status colours', () => {
    expect(FOLLOWUP_STATUS_SLICES.OPEN.color).toBe('var(--ps-fu-open)');
    expect(FOLLOWUP_STATUS_SLICES.CLOSE.color).toBe('var(--ps-fu-close)');
    expect(FOLLOWUP_STATUS_SLICES.DISPUTED.color).toBe('var(--ps-fu-disputed)');
  });

  it('a row opens its case on the follow-up page; a Historical case over the List view', () => {
    expect(followupCaseHref(12)).toBe('/process/nps-followup?case=12');
    expect(followupCaseHref(7, true)).toBe('/process/nps-followup?view=list&case=7');
  });
});
