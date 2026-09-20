import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { CampaignsView } from '../views/CampaignsView';
import { DigitalView } from '../views/DigitalView';
import { SpendingView } from '../views/SpendingView';
import { TradeView } from '../views/TradeView';
import { EMPTY_FILTERS } from '../../../lib/marcom/filters';
import type { CampaignsData, DigitalData, PageKey, SpendingData, TradeData } from '../../../lib/marcom/types';
import { fixture, flat, render, visualHtml, visualsIn } from './helpers';

const noop = () => undefined;
const draw = (kind: PageKey, data: unknown) => render(
  kind === 'spending' ? <SpendingView data={data as SpendingData} />
    : kind === 'campaigns' ? <CampaignsView data={data as CampaignsData} />
      : kind === 'digital' ? <DigitalView data={data as DigitalData} />
        : <TradeView data={data as TradeData} filters={EMPTY_FILTERS} setFilters={noop} />,
);

describe('no fixture ever renders NaN, Infinity or "undefined"', () => {
  const dir = path.join(__dirname, '..', '__fixtures__');
  const names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));

  it.each(names.filter((n) => !n.startsWith('empty.')))('%s', (name) => {
    const kind = name.split('.')[1].replace(/CompletedOnly$/, '') as PageKey;
    const html = draw(kind, fixture(name));
    expect(flat(html)).not.toMatch(/NaN|Infinity|undefined/);
    expect(html).not.toMatch(/="NaN"|="Infinity"|="undefined"/);
    expect(visualsIn(html)).toHaveLength(6);
  });
});

describe('one month of data', () => {
  it('spending renders all six visuals with a single month', () => {
    const d = fixture<SpendingData>('oneMonth.spending');
    const html = draw('spending', d);
    expect(d.totals.spend.series).toHaveLength(1);
    expect(visualsIn(html)).toHaveLength(6);
    expect(visualHtml(html, 'spending.spendVsRevenue')).toContain('recharts-surface');
    // The only arrow is the ROI card's YTD-vs-LYTD comparison (last year's August exists); nothing
    // else has a month-over-month history to compare, so no other arrow is invented.
    expect(html.match(/data-testid="kpi-delta"/g) ?? []).toHaveLength(1);
  });
  it('trade renders with a single month (no delta arrows, summary strip of one)', () => {
    const html = draw('trade', fixture('oneMonth.trade'));
    expect(html.match(/data-testid="summary-cell"/g)).toHaveLength(1);
    expect(html).not.toContain('data-testid="kpi-delta"');
  });
});

describe('a brand with no rows / all-null KPIs', () => {
  it('brands without data show n/a per row (not 0, not NaN)', () => {
    const html = draw('spending', fixture('brandNoRows.spending'));
    const cac = visualHtml(html, 'spending.cac');
    const rows = [...cac.matchAll(/data-testid="cac-row"[\s\S]*?<\/tr>/g)].map((m) => flat(m[0]));
    expect(rows).toHaveLength(4);
    expect(rows[0]).not.toContain('n/a');
    for (const r of rows.slice(1)) expect(r).toContain('n/a');
    expect(flat(visualHtml(html, 'spending.budgetUtilization'))).toContain('n/a');
  });
  it('all-null KPIs: every card says n/a with the explanatory tooltip, and the page still renders', () => {
    const html = draw('spending', fixture('allNull.spending'));
    expect(visualsIn(html)).toHaveLength(6);
    for (const id of ['kpi-roi-ytd', 'kpi-cac', 'kpi-cpc']) {
      expect(html).toMatch(new RegExp(`data-testid="${id}"[^>]*data-status="na"`));
    }
    expect(html).toContain('Not available: there is no data, or a zero denominator');
  });
});

describe('20+ campaigns, very long names, campaigns crossing the year boundary', () => {
  const d = fixture<CampaignsData>('stress.campaigns');
  const html = draw('campaigns', d);
  const tl = visualHtml(html, 'campaigns.timeline');

  it('draws every campaign as a Gantt row', () => {
    expect(d.timeline).toHaveLength(24);
    expect(tl.match(/data-testid="gantt-row"/g)).toHaveLength(24);
  });
  it('long names are truncated in the chart and label column with the full text on hover / in the table', () => {
    const long = d.timeline.map((c) => c.name).sort((a, b) => b.length - a.length)[0];
    expect(long.length).toBeGreaterThan(50);
    expect(tl).toContain(`title="${long} — `);
    expect(tl).toContain('text-overflow:ellipsis');
    expect(visualHtml(html, 'campaigns.spendVsRevenue')).toContain(long); // full text in the data table
  });
  it('campaigns crossing the year boundary are clipped with arrows on the right sides', () => {
    expect(tl.match(/data-testid="gantt-clip-start"/g)).toHaveLength(2); // started last year, spans both
    expect(tl.match(/data-testid="gantt-clip-end"/g)).toHaveLength(2); // crosses into next year, spans both
  });
  it('the chart area scrolls sideways rather than squashing 24 groups', () => {
    const v = visualHtml(html, 'campaigns.spendVsRevenue');
    expect(v).toMatch(/min-width:\d{4,}px/);
    expect(v).toContain('overflow-x:auto');
  });
});

describe('30 events, some with no completion date', () => {
  const d = fixture<TradeData>('stress.trade');
  const html = draw('trade', d);
  const tl = visualHtml(html, 'trade.eventsTimeline');

  it('renders 30 rows; events with no completion date are milestones, the rest bars', () => {
    expect(d.eventsTimeline).toHaveLength(30);
    expect(tl.match(/data-testid="gantt-row"/g)).toHaveLength(30);
    const milestones = d.eventsTimeline.filter((e) => e.completion === null).length;
    expect(milestones).toBeGreaterThan(0);
    expect(tl.match(/data-testid="gantt-milestone"/g)).toHaveLength(milestones);
    expect(tl.match(/data-testid="gantt-bar"/g)).toHaveLength(30 - milestones);
  });
  it('overdue flags come from the API', () => {
    expect(tl.match(/data-testid="gantt-overdue"/g)).toHaveLength(d.eventsTimeline.filter((e) => e.overdue).length);
  });
  it('the table alternative lists every event', () => {
    expect(visualHtml(html, 'trade.eventsTimeline').match(/<th scope="row"/g)).toHaveLength(30);
  });
});

describe('period with no data / a year with no data (server says hasData=false)', () => {
  it('the API returns complete empty structures that still render safely', () => {
    for (const [kind, name] of [['spending', 'filtered.spending'], ['spending', 'empty.spending'], ['campaigns', 'empty.campaigns'], ['digital', 'empty.digital'], ['trade', 'empty.trade']] as [PageKey, string][]) {
      const html = draw(kind, fixture(name));
      expect(flat(html)).not.toMatch(/NaN|Infinity|undefined/);
    }
  });
});
