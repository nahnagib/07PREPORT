import React from 'react';
import { describe, expect, it } from 'vitest';
import { CampaignsView } from '../views/CampaignsView';
import { DigitalView } from '../views/DigitalView';
import { SpendingView } from '../views/SpendingView';
import { TradeView } from '../views/TradeView';
import { EMPTY_FILTERS } from '../../../lib/marcom/filters';
import type { CampaignsData, DigitalData, PageKey, SpendingData, TradeData } from '../../../lib/marcom/types';
import { fixture, flat, render, testIds, visualHtml, visualsIn } from './helpers';

const noop = () => undefined;
const views = {
  spending: (d: unknown) => <SpendingView data={d as SpendingData} />,
  campaigns: (d: unknown) => <CampaignsView data={d as CampaignsData} />,
  digital: (d: unknown) => <DigitalView data={d as DigitalData} />,
  trade: (d: unknown) => <TradeView data={d as TradeData} filters={EMPTY_FILTERS} setFilters={noop} />,
} as const;
const page = (kind: PageKey, name = `demo.${kind}`) => render(views[kind](fixture(name)));

/** The brief's 24 visuals: id -> [component, the API field it reads]. Also documents the coverage checklist. */
const VISUALS: Record<PageKey, { id: string; chart: boolean }[]> = {
  spending: [
    { id: 'spending.spendVsRevenue', chart: true }, { id: 'spending.roiTrend', chart: true }, { id: 'spending.budgetUtilization', chart: true },
    { id: 'spending.brandGrowth', chart: true }, { id: 'spending.cac', chart: false }, { id: 'spending.cpc', chart: false },
  ],
  campaigns: [
    { id: 'campaigns.spendVsRevenue', chart: true }, { id: 'campaigns.rate', chart: false }, { id: 'campaigns.roiByCampaign', chart: true },
    { id: 'campaigns.timeline', chart: false }, { id: 'campaigns.coverage', chart: true }, { id: 'campaigns.costByType', chart: true },
  ],
  digital: [
    { id: 'digital.followers', chart: true }, { id: 'digital.ctr', chart: false }, { id: 'digital.engagementRate', chart: false },
    { id: 'digital.organicVsPaid', chart: true }, { id: 'digital.bounceRate', chart: false }, { id: 'digital.avgSession', chart: false },
  ],
  trade: [
    { id: 'trade.compliance', chart: false }, { id: 'trade.giveaways', chart: false }, { id: 'trade.printed', chart: false },
    { id: 'trade.eventsByType', chart: true }, { id: 'trade.eventsTimeline', chart: false }, { id: 'trade.attendance', chart: false },
  ],
};

describe.each(Object.keys(VISUALS) as PageKey[])('%s page renders all six visuals from the demo data', (kind) => {
  const html = page(kind);
  it('has exactly the six expected visuals, in order', () => {
    expect(visualsIn(html)).toEqual(VISUALS[kind].map((v) => v.id));
  });
  it.each(VISUALS[kind])('$id: title, accessible summary and a screen-reader data table', ({ id }) => {
    const v = visualHtml(html, id);
    expect(v).toMatch(/<h3[^>]*>[^<]+<\/h3>/);
    expect(v).toMatch(/aria-label="[^"]+"/);
    expect(v).toContain('data-testid="chart-table-sr"');
    expect(v).not.toMatch(/NaN|Infinity|undefined/);
  });
  it.each(VISUALS[kind].filter((v) => v.chart))('$id: draws an actual chart', ({ id }) => {
    expect(visualHtml(html, id)).toContain('recharts-surface');
  });
});

describe('Page 1 — MARCOM Spending (demo data)', () => {
  const html = page('spending');
  const d = fixture<SpendingData>('demo.spending');

  it('1: spend and revenue KPI cards plus the clustered chart with the company-revenue overlay toggle', () => {
    const v = visualHtml(html, 'spending.spendVsRevenue');
    expect(v).toContain('data-testid="kpi-spend"');
    expect(v).toContain('data-testid="kpi-revenue"');
    expect(flat(v)).toContain('Total Spend');
    expect(flat(v)).toContain('Revenue Attributed to Marketing');
    expect(flat(v)).toContain('Overlay company revenue');
    expect((v.match(/<th scope="row"/g) ?? []).length).toBe(d.totals.spend.series.length); // one row per month in the table
    expect(flat(v)).toContain('LYD'); // axis unit label
  });

  it('2: YTD ROI as "1 : X" with status, LYTD beside it, dashed reference lines from the API bands', () => {
    const v = visualHtml(html, 'spending.roiTrend');
    expect(flat(v)).toMatch(/ROI \(YTD\)/);
    expect(flat(v)).toMatch(/1 : \d/);
    expect(v).toContain('data-testid="roi-lytd"');
    expect(flat(v)).toContain('Green above 1 : 5');
    expect(flat(v)).toContain('Red below 1 : 3');
    expect((v.match(/recharts-reference-line-line/g) ?? []).length).toBe(2);
    expect(v).toContain('stroke-dasharray="6 4"');
    expect(d.roi.bands).toEqual({ greenAbove: 5, redBelow: 3 });
  });

  it('3: budget utilization per brand, neutral bars, 100% reference line, over-budget flag', () => {
    const v = visualHtml(html, 'spending.budgetUtilization');
    expect(v).toContain('recharts-reference-line-line');
    expect(flat(v)).toContain('100% of budget');
    for (const b of d.budgetUtilization.brands) expect(flat(v)).toContain(b.brand);
    const over = d.budgetUtilization.brands.filter((b) => b.overBudget);
    expect(over.map((b) => b.brand)).toEqual(['Brand B']);
    expect(flat(v)).toContain('Over budget');
  });

  it('4: brand growth with positive AND negative bars, a zero line, and signed labels', () => {
    const v = visualHtml(html, 'spending.brandGrowth');
    expect(flat(v)).toContain('Brand C');
    expect(flat(v)).toMatch(/-8\.\d%/); // negative growth
    expect(flat(v)).toMatch(/\+14\.\d%/);
    expect(v).toContain('recharts-reference-line-line'); // zero line
  });

  it('5: CAC card (LYD, % of invoice, RAG) and a per-brand table with a status badge per row', () => {
    const v = visualHtml(html, 'spending.cac');
    expect(testIds(v, 'kpi-cac')).toHaveLength(1);
    expect(flat(v)).toMatch(/of average invoice/);
    const rows = v.match(/data-testid="cac-row"/g) ?? [];
    expect(rows).toHaveLength(4);
    const statuses = [...v.matchAll(/data-testid="cac-row"[\s\S]*?data-status="(\w+)"/g)].map((m) => m[1]);
    expect(new Set(statuses)).toEqual(new Set(['green', 'yellow', 'red']));
  });

  it('6: CPC card and per-brand mini bars coloured by status, each with a text status', () => {
    const v = visualHtml(html, 'spending.cpc');
    expect(testIds(v, 'kpi-cpc')).toHaveLength(1);
    const rows = [...v.matchAll(/data-testid="cpc-row" data-status="(\w+)"/g)].map((m) => m[1]);
    expect(rows).toEqual(['green', 'yellow', 'red', 'yellow']);
    expect(flat(v)).toContain('On target');
    expect(flat(v)).toContain('Off target');
  });
});

describe('Page 2 — Media Campaign Performance (demo data)', () => {
  const html = page('campaigns');
  const d = fixture<CampaignsData>('demo.campaigns');

  it('1: spend vs revenue per campaign (sorted by revenue, descending)', () => {
    const rows = [...visualHtml(html, 'campaigns.spendVsRevenue').matchAll(/<th scope="row"[^>]*>([^<]+)<\/th>/g)].map((m) => m[1]);
    expect(rows).toEqual(d.spendVsRevenue.map((c) => c.name));
    const revenues = d.spendVsRevenue.map((c) => c.revenue);
    expect(revenues).toEqual([...revenues].sort((a, b) => b - a));
  });

  it('2: rate card with the rate % as the headline and total spend / revenue', () => {
    const v = visualHtml(html, 'campaigns.rate');
    expect(testIds(v, 'kpi-rate')).toHaveLength(1);
    expect(flat(v)).toMatch(/\d+\.\d%/);
    expect(v).toContain('data-testid="rate-spend"');
    expect(v).toContain('data-testid="rate-revenue"');
  });

  it('3: ROI per campaign with a green / yellow / red legend and two reference lines; n/a campaigns are listed', () => {
    const v = visualHtml(html, 'campaigns.roiByCampaign');
    expect(flat(v)).toContain('On target: Above 1 : 5');
    expect(flat(v)).toContain('Watch: 1 : 3 to 1 : 5');
    expect(flat(v)).toContain('Off target: Below 1 : 3');
    expect((v.match(/recharts-reference-line-line/g) ?? []).length).toBe(2);
    expect(flat(v)).toContain('ROI not available for: Year-End Mega Sale'); // zero spend
    expect(flat(v)).toContain('n/a');
  });

  it('4: campaign timeline is a Gantt with a today marker and one row per campaign', () => {
    const v = visualHtml(html, 'campaigns.timeline');
    expect(v.match(/data-testid="gantt-row"/g)).toHaveLength(d.timeline.length);
    expect(v).toContain('data-testid="gantt-today"');
    for (const s of d.options.statuses!) expect(flat(v)).toContain(s); // legend from the API's status list
    expect(v.match(/data-testid="gantt-bar"/g)).toHaveLength(d.timeline.length);
  });

  it('5: coverage donut with the total in the centre and all 5 types in the legend', () => {
    const v = visualHtml(html, 'campaigns.coverage');
    expect(v.match(/data-testid="coverage-legend"/g)).toHaveLength(5);
    expect(v).toContain('data-testid="coverage-total"');
    expect(flat(v)).toContain(String(d.coverageByType.totalUnits));
    expect(v).toContain('recharts-pie');
  });

  it('6: cost by type as bars, with the bars/bubbles toggle', () => {
    const v = visualHtml(html, 'campaigns.costByType');
    expect(flat(v)).toContain('Bars');
    expect(flat(v)).toContain('Bubbles');
    expect(v).toContain('aria-pressed="true"');
    expect(v.match(/<th scope="row"/g)).toHaveLength(5);
  });
});

describe('Page 3 — Digital Performance (demo data)', () => {
  const html = page('digital');
  const d = fixture<DigitalData>('demo.digital');

  it('1: followers donut: total in the centre, Meta total subtitle, all five platforms', () => {
    const v = visualHtml(html, 'digital.followers');
    expect(v).toContain('data-testid="followers-total"');
    expect(flat(v)).toMatch(/Meta total \(Facebook \+ Instagram\): [\d,]+/);
    expect(v.match(/data-testid="followers-legend"/g)).toHaveLength(5);
    expect(v).toContain('recharts-pie');
    // every platform's latest snapshot is August, so no per-platform "as of" clutter
    expect(v.match(/data-testid="followers-legend"[\s\S]*?<\/li>/g)!.join('')).not.toContain('as of');
  });

  it('2 + 3: CTR and Engagement Rate: an overall card plus one small RAG tile per platform, all three colours', () => {
    for (const [id, tid] of [['digital.ctr', 'kpi-ctr'], ['digital.engagementRate', 'kpi-er']] as const) {
      const v = visualHtml(html, id);
      expect(testIds(v, tid)).toHaveLength(1);
      const tiles = [...v.matchAll(new RegExp(`data-testid="${tid}-(\\w+)"[^>]*data-status="(\\w+)"`, 'g'))].map((m) => m[2]);
      expect(tiles).toHaveLength(5);
      expect(new Set(tiles)).toEqual(new Set(['green', 'yellow', 'red']));
    }
  });

  it('4: paid vs organic combo chart with the stacked / grouped toggle and a share line on a second axis', () => {
    const v = visualHtml(html, 'digital.organicVsPaid');
    expect(flat(v)).toContain('Stacked');
    expect(flat(v)).toContain('Grouped');
    expect(v).toContain('recharts-yAxis');
    expect((v.match(/recharts-yAxis yAxis/g) ?? []).length).toBe(2);
    expect(v).toContain('recharts-line');
    expect(v.match(/<th scope="row"/g)).toHaveLength(d.engagementMonthly.length);
  });

  it('5: bounce rate is a neutral card with a lower-is-better note, a trend arrow and a sparkline', () => {
    const v = visualHtml(html, 'digital.bounceRate');
    expect(v).toContain('data-status="neutral"');
    expect(flat(v)).toContain('Lower is better');
    expect(v).toContain('data-testid="kpi-delta"');
    expect(v).toContain('<svg');
    expect(d.bounceRate.kpi.direction).toBe('lower_better');
  });

  it('6: average session has RAG status, a sparkline and the seconds tooltip', () => {
    const v = visualHtml(html, 'digital.avgSession');
    expect(v).toContain('data-testid="kpi-session"');
    expect(v).toMatch(/title="\d+ min \d+ s"/);
    expect(flat(v)).toMatch(/\d(\.\d)? min/);
    expect(flat(v)).toContain('Off target'); // the seed has a month under 1 min
  });
});

describe('Page 4 — Trade Marketing & Retail (demo data)', () => {
  const html = page('trade');
  const d = fixture<TradeData>('demo.trade');

  it('1-3: compliance / giveaways / printed cards with the latest month, sparkline and period average; headlines are Green, Yellow, Red', () => {
    const s = (id: string) => /data-testid="trade\.\w+-kpi" data-status="(\w+)"/.exec(visualHtml(html, id))![1];
    expect([s('trade.compliance'), s('trade.giveaways'), s('trade.printed')]).toEqual(['green', 'yellow', 'red']);
    for (const id of ['trade.compliance', 'trade.giveaways', 'trade.printed']) {
      const v = visualHtml(html, id);
      expect(flat(v)).toContain('Latest month: August 2026');
      expect(flat(v)).toContain('Average for the period');
      expect(v).toContain('<svg');
      expect(v.match(/<th scope="row"/g)).toHaveLength(8);
    }
  });

  it('4: events by type: stacked bars with eight fixed-colour series, a legend, the include-planned / completed-only toggle and the cancelled footnote', () => {
    const v = visualHtml(html, 'trade.eventsByType');
    const keys = Object.keys(d.eventsByTypeMonthly[0].byType);
    expect(keys).toHaveLength(8);
    for (const k of keys) expect(flat(v)).toContain(k);
    expect(v.match(/recharts-legend-item /g)).toHaveLength(8);
    expect(flat(v)).toContain('Include planned');
    expect(flat(v)).toContain('Completed only');
    expect(v).toMatch(/aria-pressed="true"[^>]*>Include planned/);
    expect(flat(v)).toContain('Cancelled events are excluded.');
  });

  it('4b: "Completed only" is reflected in the toggle and the API-provided counts', () => {
    const co = fixture<TradeData>('demo.tradeCompletedOnly');
    const v = visualHtml(render(<TradeView data={co} filters={{ ...EMPTY_FILTERS, completedOnly: true }} setFilters={noop} />), 'trade.eventsByType');
    expect(v).toMatch(/aria-pressed="true"[^>]*>Completed only/);
    const sum = (x: TradeData) => x.eventsByTypeMonthly.reduce((n, m) => n + m.total, 0);
    expect(sum(co)).toBeLessThan(sum(d));
  });

  it('5: events timeline: monthly summary strip, a Gantt with milestones and overdue flags, and a Gantt/Table toggle', () => {
    const v = visualHtml(html, 'trade.eventsTimeline');
    expect(v.match(/data-testid="summary-cell"/g)).toHaveLength(8);
    expect(flat(v)).toMatch(/Planned: \d+ Completed: \d+ Completion: \d+%/);
    expect(v).toContain('data-testid="gantt"');
    expect(v.match(/data-testid="gantt-row"/g)).toHaveLength(d.eventsTimeline.length);
    expect(v.match(/data-testid="gantt-milestone"/g)!.length).toBe(d.eventsTimeline.filter((e) => e.completion === null).length);
    expect(v.match(/data-testid="gantt-overdue"/g)!.length).toBe(d.eventsTimeline.filter((e) => e.overdue).length);
    expect(flat(v)).toContain('Timeline');
    expect(flat(v)).toContain('Table');
    // Period is Jan-Aug and today is 20 Sep, so the today marker correctly does not appear here
    // (it does on the campaign timeline, whose period is the whole year).
    expect(v).not.toContain('data-testid="gantt-today"');
  });

  it('6: attendance card with actual and expected underneath', () => {
    const v = visualHtml(html, 'trade.attendance');
    expect(testIds(v, 'kpi-attendance')).toHaveLength(1);
    expect(flat(visualHtml(html, 'trade.attendance'))).toContain('4,900'); // actual
    expect(flat(v)).toContain('6,000'); // expected
  });
});

/** Coverage checklist source of truth: 24 visuals across four pages. */
describe('coverage', () => {
  it('24 visuals', () => {
    expect(Object.values(VISUALS).flat()).toHaveLength(24);
  });
});
