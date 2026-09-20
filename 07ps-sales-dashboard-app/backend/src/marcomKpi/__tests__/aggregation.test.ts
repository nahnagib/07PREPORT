import { describe, expect, it } from 'vitest';
import { buildSpending } from '../spending';
import { buildDigital } from '../digital';
import { buildTrade } from '../trade';
import { buildCampaigns } from '../campaigns';
import { assertAllFinite, campaignExample, eventExample, socialExample, spendExample, tradeExample, webExample } from './fixtures';

const A = { id: 1, name: 'Brand A' };
const B = { id: 2, name: 'Brand B' };

describe('sum first, then divide (never average ratios)', () => {
  it('ROI over two months = ΣRevenue / ΣSpend, not the mean of monthly ROIs', () => {
    // Month 1: ROI 10.  Month 2: ROI 1.  Mean of ratios = 5.5; ratio of sums = 1900 / 1000 = 1.9.
    const p = buildSpending({
      year: 2026, fromMonth: 1, toMonth: 2, brands: [A], previous: [],
      current: [spendExample({ month: 1, spend: 100, revenue: 1000 }), spendExample({ month: 2, spend: 900, revenue: 900 })],
    });
    expect(p.roi.ytd.value).toBe(1.9);
    expect(p.roi.ytd.status).toBe('red');
    expect(p.roi.monthly.map((m) => m.current)).toEqual([10, 1]); // the monthly points stay per-month
  });

  it('overall CPC is ΣCost / ΣClicks, not the mean of the per-brand CPCs', () => {
    // A: 100 / 100 = 1.0.  B: 900 / 8100 = 0.111.  Mean of ratios = 0.556; ratio of sums = 1000 / 8200.
    const p = buildSpending({
      year: 2026, fromMonth: 8, toMonth: 8, previous: [], brands: [A, B],
      current: [spendExample({ brandId: 1, socialPostCost: 100, clicks: 100 }), spendExample({ brandId: 2, brand: 'Brand B', socialPostCost: 900, clicks: 8100 })],
    });
    expect(p.cpc.brands.map((b) => b.value)).toEqual([1, 900 / 8100]);
    expect(p.cpc.overall.value).toBeCloseTo(1000 / 8200, 12);
    expect(p.cpc.overall.value).not.toBeCloseTo((1 + 900 / 8100) / 2, 3);
  });

  it('CAC % of invoice uses the customer-weighted invoice, not a plain mean of invoices', () => {
    // 10 customers at 1000 and 90 customers at 100: weighted = (10000 + 9000) / 100 = 190 (plain mean would be 550).
    const p = buildSpending({
      year: 2026, fromMonth: 1, toMonth: 2, previous: [], brands: [A],
      current: [
        spendExample({ month: 1, spend: 5000, newCustomers: 10, avgInvoice: 1000 }),
        spendExample({ month: 2, spend: 5000, newCustomers: 90, avgInvoice: 100 }),
      ],
    });
    expect(p.cac.overall.weightedAvgInvoice).toBe(190);
    expect(p.cac.overall.value).toBe(100); // 10000 / 100
    expect(p.cac.overall.pctOfInvoice.value).toBeCloseTo((100 / 190) * 100, 10);
  });

  it('CTR / engagement across platforms and months use summed clicks / impressions', () => {
    const p = buildDigital({
      year: 2026, fromMonth: 1, toMonth: 2, web: [], platforms: ['Facebook', 'TikTok'],
      social: [
        socialExample({ month: 1, platform: 'Facebook', impressions: 100, clicks: 10 }),   // 10%
        socialExample({ month: 2, platform: 'TikTok', impressions: 9900, clicks: 99 }),    // 1%
      ],
    });
    expect(p.ctr.overall.value).toBeCloseTo((109 / 10000) * 100, 10); // 1.09%, not the mean 5.5%
    expect(p.ctr.byPlatform.map((x) => x.kpi.value)).toEqual([10, 1]);
  });

  it('bounce rate and average session are ratios of sums across months', () => {
    const p = buildDigital({
      year: 2026, fromMonth: 1, toMonth: 2, social: [], platforms: [],
      web: [
        webExample({ month: 1, bounce: 50, totalVisitors: 100, minutes: 100, sessions: 10 }),     // 50% / 10 min
        webExample({ month: 2, bounce: 100, totalVisitors: 900, minutes: 900, sessions: 900 }),   // 11.1% / 1 min
      ],
    });
    expect(p.bounceRate.kpi.value).toBe(15); // 150 / 1000, not (50 + 11.1) / 2
    expect(p.avgSession.kpi.value).toBeCloseTo(1000 / 910, 12);
  });

  it('attendance = ΣActual / ΣExpected across months', () => {
    const p = buildTrade({
      year: 2026, fromMonth: 1, toMonth: 2, today: '2026-09-01', completedOnly: false, events: [],
      trade: [tradeExample({ month: 1, actual: 10, expected: 10 }), tradeExample({ month: 2, actual: 10, expected: 90 })], // 100% and 11.1%
    });
    expect(p.attendance.kpi.value).toBe(20); // 20 / 100
  });

  it('brand growth is (ΣCurrent - ΣLY) / ΣLY over the range', () => {
    const p = buildSpending({
      year: 2026, fromMonth: 1, toMonth: 2, previous: [], brands: [A],
      current: [spendExample({ month: 1, companyCurrent: 100, companyLy: 100 }), spendExample({ month: 2, companyCurrent: 300, companyLy: 100 })], // +0% and +200%
    });
    expect(p.brandGrowth.overall.value).toBe(100); // (400 - 200) / 200
    const q = buildSpending({
      year: 2026, fromMonth: 1, toMonth: 2, previous: [], brands: [A],
      current: [spendExample({ month: 1, companyCurrent: 100, companyLy: 100 }), spendExample({ month: 2, companyCurrent: 900, companyLy: 300 })], // 0% and +200%
    });
    expect(q.brandGrowth.overall.value).toBe(150); // (1000 - 400) / 400; the mean of 0 and 200 would be 100
  });
});

describe('zero or missing denominators never produce NaN/Infinity', () => {
  it('spending: zero spend / budget / customers / clicks / LY revenue -> null + na', () => {
    const p = buildSpending({
      year: 2026, fromMonth: 8, toMonth: 8, previous: [], brands: [A],
      current: [spendExample({ spend: 0, budget: 0, newCustomers: 0, clicks: 0, companyLy: 0 })],
    });
    assertAllFinite(p);
    for (const k of [p.roi.ytd, p.budgetUtilization.overall, p.brandGrowth.overall, p.cac.overall, p.cac.overall.pctOfInvoice, p.cpc.overall]) {
      expect(k).toMatchObject({ value: null, status: 'na' });
    }
    expect(p.budgetUtilization.overall.overBudget).toBe(false);
  });

  it('spending: no rows at all -> hasData false and empty-but-complete structures', () => {
    const p = buildSpending({ year: 2026, fromMonth: 1, toMonth: 3, current: [], previous: [], brands: [A, B] });
    assertAllFinite(p);
    expect(p.hasData).toBe(false);
    expect(p.roi.ytd).toMatchObject({ value: null, status: 'na' });
    expect(p.roi.monthly).toHaveLength(3);
    expect(p.budgetUtilization.brands).toHaveLength(2);
    expect(p.totals.spend.series).toEqual([{ month: 1, value: null }, { month: 2, value: null }, { month: 3, value: null }]);
  });

  it('digital: zero impressions / clicks / sessions / visitors', () => {
    const p = buildDigital({
      year: 2026, fromMonth: 8, toMonth: 8, platforms: ['Instagram'],
      social: [socialExample({ impressions: 0, clicks: 0, paid: 0, organic: 0 })], web: [webExample({ totalVisitors: 0, sessions: 0, bounce: 0, minutes: 0 })],
    });
    assertAllFinite(p);
    expect(p.ctr.overall).toMatchObject({ value: null, status: 'na' });
    expect(p.engagementRate.overall).toMatchObject({ value: null, status: 'na' });
    expect(p.bounceRate.kpi).toMatchObject({ value: null, status: 'na' });
    expect(p.avgSession.kpi).toMatchObject({ value: null, status: 'na' });
    expect(p.engagementMonthly[0].organicShare).toBeNull();
  });

  it('trade: zero expected attendees, no events; campaigns: zero spend', () => {
    const t = buildTrade({ year: 2026, fromMonth: 8, toMonth: 8, today: '2026-09-01', completedOnly: false, trade: [tradeExample({ expected: 0, actual: 5 })], events: [] });
    assertAllFinite(t);
    expect(t.attendance.kpi).toMatchObject({ value: null, status: 'na' });
    expect(t.eventsMonthlySummary[0]).toMatchObject({ planned: 0, completed: 0, completionPct: null });

    const c = buildCampaigns({ year: 2026, fromMonth: 1, toMonth: 12, today: '2026-09-01', media: [], campaigns: [campaignExample({ spend: 0, revenue: 0 })] });
    assertAllFinite(c);
    expect(c.roiByCampaign.campaigns[0].roi).toMatchObject({ value: null, status: 'na' });
    expect(c.totals.rate).toMatchObject({ value: null, status: 'na' });
    expect(c.costByType.types.every((x) => x.costPerUnit === null)).toBe(true);
  });
});

describe('LYTD is never invented', () => {
  const cur = [spendExample({ month: 1, spend: 100, revenue: 400 })];
  it('without prior-year rows: lytd null, meta.missing lists lastYearData, monthly lastYear null', () => {
    const p = buildSpending({ year: 2026, fromMonth: 1, toMonth: 1, current: cur, previous: [], brands: [A] });
    expect(p.roi.lytd).toBeNull();
    expect(p.meta.missing).toContain('lastYearData');
    expect(p.roi.monthly[0]).toMatchObject({ lastYear: null, lastYearStatus: 'na' });
    expect(p.roi.ytd.previous).toBeNull();
  });
  it('with prior-year rows: LYTD KPI, previous and delta on the YTD card', () => {
    const p = buildSpending({ year: 2026, fromMonth: 1, toMonth: 1, current: cur, previous: [spendExample({ year: 2025, month: 1, spend: 100, revenue: 300 })], brands: [A] });
    expect(p.roi.lytd).toMatchObject({ value: 3, status: 'yellow' });
    expect(p.roi.ytd).toMatchObject({ value: 4, previous: 3, delta: 1, status: 'yellow' });
    expect(p.meta.missing).not.toContain('lastYearData');
    expect(p.roi.bands).toEqual({ greenAbove: 5, redBelow: 3 });
  });
});

describe('followers are snapshots', () => {
  const social = [
    socialExample({ month: 1, followers: 100 }), socialExample({ month: 2, followers: 150 }), socialExample({ month: 3, followers: 200 }),
    socialExample({ month: 2, platform: 'Facebook', followers: 1000 }),
  ];
  it('takes the latest month <= toMonth per platform and never sums across months', () => {
    const p = buildDigital({ year: 2026, fromMonth: 1, toMonth: 3, social, web: [], platforms: ['Facebook', 'Instagram', 'TikTok'] });
    expect(p.followers.platforms).toEqual([
      { platform: 'Facebook', value: 1000, asOf: { year: 2026, month: 2 } },
      { platform: 'Instagram', value: 200, asOf: { year: 2026, month: 3 } },
      { platform: 'TikTok', value: null, asOf: null },
    ]);
    expect(p.followers.total).toBe(1200);      // not 100 + 150 + 200 + 1000
    expect(p.followers.metaTotal).toBe(1200);  // Facebook + Instagram
  });
  it('honours toMonth (rows after it are ignored by the loader; earlier snapshot wins)', () => {
    const p = buildDigital({ year: 2026, fromMonth: 2, toMonth: 2, social: social.filter((s) => s.month <= 2), web: [], platforms: ['Instagram'] });
    expect(p.followers.platforms[0]).toEqual({ platform: 'Instagram', value: 150, asOf: { year: 2026, month: 2 } });
  });
});

describe('month-over-month delta (pages 3 and 4)', () => {
  it('last month vs previous month with data, in percentage points / minutes', () => {
    const p = buildDigital({
      year: 2026, fromMonth: 1, toMonth: 4, social: [], platforms: [],
      web: [
        webExample({ month: 1, sessions: 100, minutes: 200 }), webExample({ month: 2, sessions: 100, minutes: 300 }),
        webExample({ month: 4, sessions: 100, minutes: 250 }), // month 3 has no data: previous is month 2
      ],
    });
    expect(p.avgSession.kpi.previous).toBe(3);
    expect(p.avgSession.kpi.delta).toBe(-0.5);
    expect(p.avgSession.series.map((s) => s.value)).toEqual([2, 3, null, 2.5]);
  });
  it('omitted when fewer than two months have data', () => {
    const p = buildTrade({ year: 2026, fromMonth: 8, toMonth: 8, today: '2026-09-01', completedOnly: false, events: [], trade: [tradeExample()] });
    expect(p.attendance.kpi).not.toHaveProperty('delta');
    expect(p.compliance.headline.previous).toBeNull();
  });
  it('compliance headline is the latest month; average is the simple mean of the range; series carries per-month status', () => {
    const p = buildTrade({
      year: 2026, fromMonth: 1, toMonth: 3, today: '2026-09-01', completedOnly: false, events: [],
      trade: [tradeExample({ month: 1, compliance: '0.95' }), tradeExample({ month: 2, compliance: '0.85' }), tradeExample({ month: 3, compliance: '0.70' })],
    });
    expect(p.compliance.headline).toMatchObject({ value: 70, status: 'red', previous: 85, delta: -15, asOf: { year: 2026, month: 3 } });
    expect(p.compliance.average).toMatchObject({ value: 83.33333333333333, status: 'yellow' });
    expect(p.compliance.series.map((s) => s.status)).toEqual(['green', 'yellow', 'red']);
  });
});

describe('events', () => {
  const events = [
    eventExample({ name: 'A', type: '1-Professionals', planned: '2026-08-05', status: 'Completed' }),
    eventExample({ name: 'B', type: '1-Professionals', planned: '2026-08-06', completion: null, status: 'Planned' }),
    eventExample({ name: 'C', type: '4-CSR', planned: '2026-08-07', completion: null, status: 'Cancelled' }),
    eventExample({ name: 'D', type: '4-CSR', planned: '2026-08-08', completion: null, status: 'Postponed' }),
    eventExample({ name: 'E', type: '8-Exhibitions', planned: '2026-10-01', completion: null, status: 'Planned' }),
  ];
  const base = { year: 2026, fromMonth: 8, toMonth: 8, today: '2026-09-20', trade: [] as never[] };

  it('by type: Cancelled excluded by default, all 8 types always present', () => {
    const aug = buildTrade({ ...base, events, completedOnly: false }).eventsByTypeMonthly[0];
    expect(Object.keys(aug.byType)).toHaveLength(8);
    expect(aug.byType['1-Professionals']).toBe(2);
    expect(aug.byType['4-CSR']).toBe(1); // D only; C is cancelled
    expect(aug.total).toBe(3);
  });
  it('completedOnly=true keeps Completed events only', () => {
    const aug = buildTrade({ ...base, events, completedOnly: true }).eventsByTypeMonthly[0];
    expect(aug.total).toBe(1);
    expect(aug.byType['1-Professionals']).toBe(1);
  });
  it('overdue = not Completed/Cancelled and planned before today', () => {
    const t = buildTrade({ ...base, events, completedOnly: false }).eventsTimeline;
    expect(Object.fromEntries(t.map((e) => [e.name, e.overdue]))).toEqual({ A: false, B: true, C: false, D: true, E: false });
  });
  it('monthly summary: planned excludes Cancelled; completion % = completed / planned', () => {
    const s = buildTrade({ ...base, events, completedOnly: false }).eventsMonthlySummary[0];
    expect(s).toMatchObject({ month: 8, planned: 3, completed: 1 });
    expect(s.completionPct).toBeCloseTo(33.3333, 3);
  });
});

describe('campaign payload', () => {
  const campaigns = [
    campaignExample({ name: 'Low', revenue: 100, spend: 100 }),
    campaignExample({ name: 'High', revenue: 900000, spend: 100000 }),
    campaignExample({ name: 'Mid', revenue: 500000, spend: 100000 }),
  ];
  const p = buildCampaigns({ year: 2026, fromMonth: 1, toMonth: 12, today: '2026-09-20', campaigns, media: [] });

  it('sorts spend-vs-revenue by revenue descending and reports the band boundaries', () => {
    expect(p.spendVsRevenue.map((c) => c.name)).toEqual(['High', 'Mid', 'Low']);
    expect(p.roiByCampaign.bands).toEqual({ greenAbove: 5, redBelow: 3 });
    expect(p.roiByCampaign.campaigns.map((c) => c.roi.status)).toEqual(['green', 'yellow', 'red']); // 9.0, 5.0 (boundary), 1.0
  });
  it('always lists all 5 media types, zero-filled, and echoes today', () => {
    expect(p.coverageByType.types).toHaveLength(5);
    expect(p.costByType.types.map((t) => t.cost)).toEqual([0, 0, 0, 0, 0]);
    expect(p.today).toBe('2026-09-20');
  });
});
