import React from 'react';
import { describe, expect, it } from 'vitest';
import { CampaignsView } from '../views/CampaignsView';
import { DigitalView } from '../views/DigitalView';
import { SpendingView } from '../views/SpendingView';
import { TradeView } from '../views/TradeView';
import { EMPTY_FILTERS } from '../../../lib/marcom/filters';
import type { CampaignsData, DigitalData, SpendingData, TradeData } from '../../../lib/marcom/types';
import { fixture, flat, render, testIds, visualHtml } from './helpers';

/**
 * Golden check: the template's example rows loaded as data (the acceptance table). The payloads are
 * what GET /marcom/kpi/* returns for them (built by the real KPI builders; the same values are
 * asserted over HTTP against the test database in backend/src/routes/__tests__/marcomKpi.routes.test.ts).
 * These tests assert what the PAGES display for them.
 */
const status = (html: string, testId: string) => new RegExp(`data-testid="${testId}"[^>]*data-status="(\\w+)"`).exec(html)?.[1];

describe('golden: MARCOM Spending', () => {
  const html = render(<SpendingView data={fixture<SpendingData>('golden.spending')} />);
  it('ROI 1 : 5.6 -> Green ("On target"); no last-year data yet', () => {
    const v = visualHtml(html, 'spending.roiTrend');
    const card = testIds(v, 'kpi-roi-ytd')[0];
    expect(card).toContain('data-status="green"');
    expect(flat(v)).toContain('1 : 5.6');
    expect(flat(v)).toContain('On target');
    expect(flat(v)).toContain('No last-year data uploaded');
  });
  it('Budget utilization 90.9%, Brand growth +14.3%', () => {
    expect(flat(visualHtml(html, 'spending.budgetUtilization'))).toContain('90.9%');
    expect(flat(visualHtml(html, 'spending.brandGrowth'))).toContain('+14.3%');
  });
  it('CAC LYD 416.67 = 46.3% of a 900 invoice -> Red ("Off target")', () => {
    const v = visualHtml(html, 'spending.cac');
    expect(flat(v)).toContain('LYD 416.67');
    expect(flat(v)).toContain('46.3% of average invoice');
    expect(status(v, 'kpi-cac')).toBe('red');
    expect(flat(v)).toContain('Off target');
  });
  it('CPC LYD 2.29 -> Green', () => {
    const v = visualHtml(html, 'spending.cpc');
    expect(flat(v)).toContain('LYD 2.29');
    expect(status(v, 'kpi-cpc')).toBe('green');
  });
  it('spend and revenue totals', () => {
    const v = visualHtml(html, 'spending.spendVsRevenue');
    expect(flat(v)).toContain('LYD 50,000');
    expect(flat(v)).toContain('LYD 280,000');
  });
});

describe('golden: Media Campaign Performance', () => {
  const html = render(<CampaignsView data={fixture<CampaignsData>('golden.campaigns')} />);
  it('rate 541.7%, ROI 1 : 5.42 -> Green', () => {
    expect(flat(visualHtml(html, 'campaigns.rate'))).toContain('541.7%');
    const v = visualHtml(html, 'campaigns.roiByCampaign');
    expect(flat(v)).toContain('1 : 5.42');
    expect(flat(v)).toContain('On target');
  });
  it('timeline: Feb 1 -> Mar 15 2026 is 42 days', () => {
    const v = visualHtml(html, 'campaigns.timeline');
    // the bar's accessible description (and hover tooltip) carry the dates and duration
    expect(v).toContain('aria-label="Ramadan Lighting Campaign. Completed. 01/02/2026 – 15/03/2026. Brand Brand A. Duration 42 days.');
    expect(flat(v)).toContain('01/02/2026');
    expect(flat(v)).toContain('15/03/2026');
  });
  it('45 street-light units / LYD 30,000 appear in the coverage donut and the cost chart', () => {
    const cov = visualHtml(html, 'campaigns.coverage');
    expect(flat(cov)).toMatch(/Street Lights 45 100\.0%/);
    expect(flat(cov)).toContain('45'); // centre total
    expect(flat(visualHtml(html, 'campaigns.costByType'))).toContain('LYD 30,000');
    // the other four media types are still listed, as 0
    expect(cov.match(/data-testid="coverage-legend"/g)).toHaveLength(5);
  });
});

describe('golden: Digital Performance', () => {
  const html = render(<DigitalView data={fixture<DigitalData>('golden.digital')} />);
  it('CTR 5.3% -> Green; Engagement 4.1% (7,300 of 180,000) -> Yellow ("Watch")', () => {
    const ctr = visualHtml(html, 'digital.ctr');
    expect(flat(ctr)).toContain('5.3%');
    expect(status(ctr, 'kpi-ctr')).toBe('green');
    const er = visualHtml(html, 'digital.engagementRate');
    expect(flat(er)).toContain('4.1%');
    expect(status(er, 'kpi-er')).toBe('yellow');
    expect(flat(er)).toContain('Watch');
  });
  it('Bounce rate 28.3% (neutral)', () => {
    const v = visualHtml(html, 'digital.bounceRate');
    expect(flat(v)).toContain('28.3%');
    expect(status(v, 'kpi-bounce')).toBe('neutral');
  });
  it('Average session 3.5 min -> Green, with the "3 min 30 s" tooltip', () => {
    const v = visualHtml(html, 'digital.avgSession');
    expect(flat(v)).toContain('3.5 min');
    expect(status(v, 'kpi-session')).toBe('green');
    expect(v).toContain('title="3 min 30 s"');
  });
  it('Instagram followers 52,000; organic 3,100 + paid 4,200', () => {
    expect(flat(visualHtml(html, 'digital.followers'))).toContain('52,000');
    const combo = flat(visualHtml(html, 'digital.organicVsPaid'));
    expect(combo).toContain('4,200');
    expect(combo).toContain('3,100');
  });
});

describe('golden: Trade Marketing & Retail', () => {
  const html = render(<TradeView data={fixture<TradeData>('golden.trade')} filters={EMPTY_FILTERS} setFilters={() => undefined} />);
  it('Compliance 94% Green, Giveaways 88% Yellow, Printed 91% Green', () => {
    const c = visualHtml(html, 'trade.compliance');
    const g = visualHtml(html, 'trade.giveaways');
    const p = visualHtml(html, 'trade.printed');
    expect(flat(c)).toContain('94.0%');
    expect(status(c, 'trade.compliance-kpi')).toBe('green');
    expect(flat(g)).toContain('88.0%');
    expect(status(g, 'trade.giveaways-kpi')).toBe('yellow');
    expect(flat(g)).toContain('Watch');
    expect(flat(p)).toContain('91.0%');
    expect(status(p, 'trade.printed-kpi')).toBe('green');
  });
  it('Attendance 460 / 500 = 92% -> Green, with actual and expected underneath', () => {
    const v = visualHtml(html, 'trade.attendance');
    expect(flat(v)).toContain('92.0%');
    expect(status(v, 'kpi-attendance')).toBe('green');
    expect(flat(v)).toMatch(/Actual 460/);
    expect(flat(v)).toMatch(/Expected 500/);
  });
  it('the launch event is counted in August as "6-Launch & Opening" and appears in the timeline', () => {
    const by = visualHtml(html, 'trade.eventsByType');
    expect(flat(by)).toMatch(/Aug 0 0 0 0 0 1 0 0 1/); // month row: 8 types (only type 6 = 1) then total
    const tl = visualHtml(html, 'trade.eventsTimeline');
    expect(flat(tl)).toContain('Product Launch Night - Brand A');
    expect(flat(tl)).toContain('10/08/2026');
    expect(tl).toContain('data-testid="gantt-bar"'); // planned 10/08 = completed 10/08 -> a one-day bar, not overdue
    expect(tl).not.toContain('gantt-overdue');
  });
});
