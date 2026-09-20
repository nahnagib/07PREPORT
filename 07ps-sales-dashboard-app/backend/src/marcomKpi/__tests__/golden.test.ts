import { describe, expect, it } from 'vitest';
import { buildSpending } from '../spending';
import { buildCampaigns } from '../campaigns';
import { buildDigital } from '../digital';
import { buildTrade } from '../trade';
import { durationDays } from '../formulas';
import { campaignExample, eventExample, socialExample, spendExample, tradeExample, webExample } from './fixtures';

/** The acceptance table (brief §12): the template's example rows must produce exactly these values. */
const brands = [{ id: 1, name: 'Brand A' }];
const period = { year: 2026, fromMonth: 8, toMonth: 8 };

describe('golden values -- P1 MARCOM Spending', () => {
  const p = buildSpending({ ...period, brands, current: [spendExample()], previous: [] });

  it('ROI 1 : 5.6 -> Green', () => {
    expect(p.roi.ytd).toMatchObject({ value: 5.6, status: 'green', unit: 'ratio' });
  });
  it('Budget utilization 90.9% (neutral, not over budget)', () => {
    expect(p.budgetUtilization.overall.value).toBeCloseTo(90.909, 2);
    expect(p.budgetUtilization.overall).toMatchObject({ status: 'neutral', overBudget: false });
  });
  it('Brand growth +14.3%', () => {
    expect(p.brandGrowth.overall.value).toBeCloseTo(14.2857, 3);
    expect(p.brandGrowth.overall).toMatchObject({ revenueCurrent: 1200000, revenueLastYear: 1050000 });
  });
  it('CAC 416.67 LYD = 46.3% of a 900 invoice -> Red', () => {
    expect(p.cac.overall.value).toBeCloseTo(416.6667, 3);
    expect(p.cac.overall.pctOfInvoice.value).toBeCloseTo(46.2963, 3);
    expect(p.cac.overall.pctOfInvoice.status).toBe('red');
    expect(p.cac.overall.status).toBe('red'); // the card takes the %-of-invoice colour
  });
  it('CPC 2.29 LYD -> Green', () => {
    expect(p.cpc.overall.value).toBeCloseTo(2.2857, 3);
    expect(p.cpc.overall.status).toBe('green');
  });
});

describe('golden values -- P2 Media Campaigns', () => {
  const p = buildCampaigns({
    ...period, today: '2026-09-20', campaigns: [campaignExample()],
    media: [{ campaignName: 'Ramadan Lighting Campaign', mediaType: '1-Street Lights', units: 45, cost: 30000 }],
  });

  it('duration is 42 days (Feb 1 -> Mar 15 2026)', () => {
    expect(durationDays('2026-02-01', '2026-03-15')).toBe(42);
    expect(p.timeline[0].durationDays).toBe(42);
  });
  it('rate 541.7% and ROI 1 : 5.42 -> Green', () => {
    expect(p.totals.rate.value).toBeCloseTo(541.6667, 3);
    expect(p.timeline[0].rate).toBeCloseTo(541.6667, 3);
    expect(p.roiByCampaign.campaigns[0].roi).toMatchObject({ status: 'green' });
    expect(p.roiByCampaign.campaigns[0].roi.value).toBeCloseTo(5.4167, 3);
  });
  it('45 units / 30,000 LYD of Street Lights appear in the coverage and cost charts', () => {
    expect(p.coverageByType.types.find((t) => t.mediaType === '1-Street Lights')).toMatchObject({ units: 45 });
    expect(p.costByType.types.find((t) => t.mediaType === '1-Street Lights')).toMatchObject({ cost: 30000, units: 45 });
    expect(p.coverageByType.totalUnits).toBe(45);
  });
});

describe('golden values -- P3 Digital', () => {
  const p = buildDigital({ ...period, platforms: ['Instagram'], social: [socialExample()], web: [webExample()] });

  it('CTR 5.28% -> Green', () => {
    expect(p.ctr.overall.value).toBeCloseTo(5.2778, 3);
    expect(p.ctr.overall.status).toBe('green');
  });
  it('Engagement rate 4.06% (4,200 + 3,100 = 7,300) -> Yellow', () => {
    expect(p.engagementRate.overall.value).toBeCloseTo(4.0556, 3);
    expect(p.engagementRate.overall.status).toBe('yellow');
    expect(p.engagementMonthly[0]).toMatchObject({ paid: 4200, organic: 3100 });
  });
  it('Bounce rate 28.3% (neutral, lower is better)', () => {
    expect(p.bounceRate.kpi.value).toBeCloseTo(28.3333, 3);
    expect(p.bounceRate.kpi).toMatchObject({ status: 'neutral', direction: 'lower_better' });
  });
  it('Avg session 3.5 min -> Green', () => {
    expect(p.avgSession.kpi).toMatchObject({ value: 3.5, status: 'green', unit: 'minutes' });
  });
  it('followers: snapshot 52,000 as of Aug 2026', () => {
    expect(p.followers.platforms[0]).toEqual({ platform: 'Instagram', value: 52000, asOf: { year: 2026, month: 8 } });
  });
});

describe('golden values -- P4 Trade Marketing', () => {
  const p = buildTrade({ ...period, today: '2026-09-20', completedOnly: false, trade: [tradeExample()], events: [eventExample()] });

  it('Compliance Green, Giveaways Yellow, Printed Green', () => {
    expect(p.compliance.headline).toMatchObject({ value: 94, status: 'green' });
    expect(p.giveawaysStock.headline).toMatchObject({ value: 88, status: 'yellow' });
    expect(p.printedStock.headline).toMatchObject({ value: 91, status: 'green' });
  });
  it('Attendance 460 / 500 = 92% -> Green', () => {
    expect(p.attendance.kpi).toMatchObject({ value: 92, status: 'green' });
    expect(p.attendance).toMatchObject({ actual: 460, expected: 500 });
  });
  it('the launch event is counted in August under 6-Launch & Opening', () => {
    const aug = p.eventsByTypeMonthly.find((m) => m.month === 8)!;
    expect(aug.byType['6-Launch & Opening']).toBe(1);
    expect(aug.total).toBe(1);
    expect(p.eventsTimeline[0]).toMatchObject({ status: 'Completed', overdue: false });
  });
});
