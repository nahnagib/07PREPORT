import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MarcomChartCard } from '../MarcomChartCard';
import { MarcomPageView, MarcomPageViewProps } from '../MarcomPageView';
import { MarcomFilterBar } from '../MarcomFilterBar';
import { MarcomFreshness } from '../MarcomFreshness';
import { SpendingView } from '../views/SpendingView';
import { EMPTY_FILTERS } from '../../../lib/marcom/filters';
import { MarcomKpiError } from '../../../lib/marcom/api';
import type { PageKey, SpendingData } from '../../../lib/marcom/types';
import { fixture, flat, render, visualsIn } from './helpers';

const noop = () => undefined;

describe('MarcomChartCard states', () => {
  const table = { caption: 'Cap', columns: ['Month', 'Value'], rows: [['Jan', '1,000']] };
  const base = { visual: 'x.y', title: 'My chart', summary: 'Jan 1,000', table };

  it('normal: chart + an always-present screen-reader table + a "view as table" toggle + an accessible summary', () => {
    const html = render(<MarcomChartCard {...base}><svg data-testid="the-chart" /></MarcomChartCard>);
    expect(html).toContain('data-testid="the-chart"');
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Jan 1,000"');
    expect(html).toContain('data-testid="chart-table-sr"');
    expect(flat(html)).toContain('1,000');
    expect(flat(html)).toContain('View as table');
    expect(html).toContain('aria-pressed="false"');
  });

  it('interactive charts (Gantt) are a group, not an image, so their bars stay reachable', () => {
    expect(render(<MarcomChartCard {...base} interactive><i /></MarcomChartCard>)).toContain('role="group"');
  });

  it('loading: skeleton, no chart, no table toggle, aria-busy', () => {
    const html = render(<MarcomChartCard {...base} loading><svg data-testid="the-chart" /></MarcomChartCard>);
    expect(html).not.toContain('the-chart');
    expect(html).toContain('aria-busy="true"');
    expect(flat(html)).not.toContain('View as table');
  });

  it('empty: "No data for the selected filters" instead of a blank frame', () => {
    const html = render(<MarcomChartCard {...base} empty><svg data-testid="the-chart" /></MarcomChartCard>);
    expect(flat(html)).toContain('No data for the selected filters');
    expect(html).not.toContain('the-chart');
  });

  it('error: message and a Retry button', () => {
    const html = render(<MarcomChartCard {...base} error="This chart could not load." onRetry={noop}><svg data-testid="the-chart" /></MarcomChartCard>);
    expect(flat(html)).toContain('This chart could not load.');
    expect(flat(html)).toContain('Retry');
    expect(html).not.toContain('the-chart');
  });

  it('refreshing keeps the chart but dims it and flags aria-busy', () => {
    const html = render(<MarcomChartCard {...base} refreshing><svg data-testid="the-chart" /></MarcomChartCard>);
    expect(html).toContain('the-chart');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('opacity:0.65');
  });

  it('wide charts scroll sideways instead of squashing', () => {
    const html = render(<MarcomChartCard {...base} minWidth={960}><i /></MarcomChartCard>);
    expect(html).toContain('overflow-x:auto');
    expect(html).toContain('min-width:960px');
  });
});

describe('MarcomPageView (page-level states)', () => {
  const data = fixture<SpendingData>('demo.spending');
  const props = (over: Partial<MarcomPageViewProps<SpendingData>> = {}): MarcomPageViewProps<SpendingData> => ({
    page: 'spending', title: 'MARCOM Spending', filters: EMPTY_FILTERS, onFilters: noop, onReset: noop,
    data, error: null, loading: false, refreshing: false, onRetry: noop, canUpload: false,
    children: (d) => <div data-testid="body">{d.page}</div>, ...over,
  });
  const view = (over: Partial<MarcomPageViewProps<SpendingData>> = {}) => render(<MarcomPageView<SpendingData> {...props(over)} />);

  it('with data: title, freshness line, filter bar and the page body', () => {
    const html = view();
    expect(flat(html)).toContain('MARCOM Spending');
    expect(flat(html)).toContain('Data as of August 2026 — uploaded by Demo Admin on 20/09/2026');
    expect(html).toContain('data-testid="marcom-filters"');
    expect(html).toContain('data-testid="body"');
  });

  it('the "Upload data" link exists only for admins with the upload permission', () => {
    expect(view({ canUpload: true })).toContain('data-testid="upload-link"');
    expect(view({ canUpload: true })).toContain('href="/admin/marcom-upload"');
    expect(view({ canUpload: false })).not.toContain('upload-link');
  });

  it('loading: skeletons instead of the page', () => {
    const html = view({ data: null, loading: true });
    expect(html).toContain('data-testid="page-loading"');
    expect(html).not.toContain('data-testid="body"');
    expect(html).not.toContain('marcom-filters');
  });

  it('API error with no data: message + Retry', () => {
    const html = view({ data: null, error: new MarcomKpiError(0, 'offline', 'NETWORK') });
    expect(flat(html)).toContain('This page could not load.');
    expect(flat(html)).toContain('Retry');
    expect(html).not.toContain('data-testid="body"');
  });

  it('API error with data already on screen: the data stays, an error banner is added', () => {
    const html = view({ error: new MarcomKpiError(500, 'boom') });
    expect(html).toContain('data-testid="body"');
    expect(flat(html)).toContain('This page could not load.');
  });

  it('403 from the API: a proper "no access" page, no data, no filters', () => {
    const html = view({ data: null, error: new MarcomKpiError(403, 'You do not have permission to access this resource.') });
    expect(html).toContain('data-testid="no-access"');
    expect(flat(html)).toContain('You do not have access to this page');
    expect(html).not.toContain('marcom-filters');
  });

  it('nothing ever uploaded: "No MARCOM data uploaded yet" (+ the upload link for admins only)', () => {
    const empty = fixture<SpendingData>('empty.spending');
    const admin = view({ data: empty, canUpload: true });
    const other = view({ data: empty, canUpload: false });
    expect(flat(admin)).toContain('No MARCOM data uploaded yet');
    expect(admin).toContain('href="/admin/marcom-upload"');
    expect(flat(admin)).toContain('Go to MARCOM Data Upload');
    expect(flat(other)).toContain('No MARCOM data uploaded yet');
    expect(other).not.toContain('marcom-upload');
    expect(admin).not.toContain('data-testid="body"');
  });

  it('data exists but the filters match nothing: "No data for the selected filters" with a reset action', () => {
    const html = view({ data: fixture<SpendingData>('filtered.spending') });
    expect(html).toContain('data-testid="no-data-filters"');
    expect(flat(html)).toContain('No data for the selected filters');
    expect(html).toContain('data-testid="marcom-filters"'); // the user can still change them
    expect(html).not.toContain('data-testid="body"');
  });

  it('refreshing (filter change in flight): previous data stays, subtle "Updating…"', () => {
    const html = view({ refreshing: true });
    expect(html).toContain('data-testid="body"');
    expect(flat(html)).toContain('Updating…');
  });
});

describe('freshness line', () => {
  it('renders nothing before any upload', () => {
    expect(render(<MarcomFreshness freshness={{ hasData: false }} />)).toBe('');
    expect(render(<MarcomFreshness freshness={null} />)).toBe('');
  });
  it('tolerates a missing uploader name', () => {
    const f = { hasData: true, latestPeriod: { year: 2026, month: 3, label: 'March 2026' }, uploadedBy: null, uploadedAt: '2026-04-02T10:00:00.000Z' };
    expect(flat(render(<MarcomFreshness freshness={f} />))).toBe('Data as of March 2026 — uploaded by unknown on 02/04/2026');
  });
});

describe('filter bar', () => {
  const data = fixture<SpendingData>('demo.spending');
  const bar = (page: PageKey, over: Partial<React.ComponentProps<typeof MarcomFilterBar>> = {}) => render(
    <MarcomFilterBar page={page} filters={EMPTY_FILTERS} options={{ ...data.options, platforms: ['Facebook', 'TikTok'], statuses: ['Planned', 'Ongoing'] }} applied={{ year: 2026, fromMonth: 1, toMonth: 8 }} onChange={noop} onReset={noop} {...over} />,
  );

  it('page 1 / 4: year, month range, brand', () => {
    for (const page of ['spending', 'trade'] as PageKey[]) {
      const html = bar(page);
      expect(flat(html)).toMatch(/Year.*From.*To.*Brand/);
      expect(html).not.toContain('data-testid="filter-Platform"');
      expect(html).not.toContain('data-testid="filter-Campaign status"');
    }
  });
  it('page 2: year, brand, campaign status (no month range: campaigns are date ranges)', () => {
    const html = bar('campaigns');
    expect(flat(html)).toMatch(/Year.*Brand.*Campaign status/);
    expect(flat(html)).not.toContain('From');
  });
  it('page 3: year, month range, platform', () => {
    const html = bar('digital');
    expect(flat(html)).toMatch(/Year.*From.*To.*Platform/);
    expect(html).not.toContain('data-testid="filter-Brand"');
  });
  it('options come from the API: years, brands, platforms, statuses', () => {
    expect(flat(bar('spending'))).toContain('Brand A');
    expect(flat(bar('spending'))).toContain('Brand D');
    expect(flat(bar('digital'))).toContain('TikTok');
    expect(flat(bar('campaigns'))).toContain('Ongoing');
    const years = bar('spending').match(/<option[^>]*value="(\d{4})"/g) ?? [];
    expect(years.map((y) => y.match(/\d{4}/)![0])).toEqual(['2026', '2025']);
  });
  it('shows what the API applied when the user set nothing, and selected filters when they did', () => {
    const html = bar('spending');
    expect(html).toContain('<option value="2026" selected');
    expect(html).toContain('<option value="8" selected');
    expect(flat(bar('spending', { filters: { ...EMPTY_FILTERS, brandIds: [2] } }))).toContain('Brand B');
    expect(flat(bar('spending', { filters: { ...EMPTY_FILTERS, brandIds: [1, 2] } }))).toContain('2 selected');
  });
  it('a year with no uploaded data is still selectable (so the empty state is reachable)', () => {
    expect(bar('spending', { applied: { year: 2031, fromMonth: 1, toMonth: 12 } })).toContain('value="2031"');
  });
  it('Reset is disabled on the default view and enabled once a filter is set', () => {
    expect(bar('spending')).toMatch(/<button[^>]*disabled[^>]*>Reset/);
    expect(bar('spending', { filters: { ...EMPTY_FILTERS, year: 2025 } })).not.toMatch(/<button[^>]*disabled[^>]*>Reset/);
  });
  it('every control is a labelled, native form control (keyboard operable)', () => {
    const html = bar('spending');
    expect(html).toContain('role="search"');
    expect(html.match(/<select/g)).toHaveLength(3);
    expect(html).toContain('<details');
    expect(html).toContain('<summary');
    expect(html).toContain('type="checkbox"');
  });
});

describe('lastYearData missing', () => {
  const html = render(<SpendingView data={fixture<SpendingData>('noLastYear.spending')} />);
  it('shows "No last-year data uploaded" in place of the LYTD card', () => {
    expect(html).toContain('data-testid="no-last-year"');
    expect(flat(html)).toContain('No last-year data uploaded');
    expect(html).not.toContain('data-testid="roi-lytd"');
  });
  it('draws only the current-year ROI line (no fake or zero last-year line) and lists n/a in the table', () => {
    const roi = html.slice(html.indexOf('data-visual="spending.roiTrend"'), html.indexOf('data-visual="spending.budgetUtilization"'));
    expect((roi.match(/class="recharts-layer recharts-line"/g) ?? []).length).toBe(1);
    expect(flat(roi)).toContain('Last year');
    expect(flat(roi)).not.toMatch(/Last year[^|]*1 : 0\b/);
  });
  it('with last-year data the LYTD value sits beside YTD and both lines are drawn', () => {
    const ok = render(<SpendingView data={fixture<SpendingData>('demo.spending')} />);
    expect(ok).toContain('data-testid="roi-lytd"');
    expect(ok).not.toContain('data-testid="no-last-year"');
    const roi = ok.slice(ok.indexOf('data-visual="spending.roiTrend"'), ok.indexOf('data-visual="spending.budgetUtilization"'));
    expect((roi.match(/class="recharts-layer recharts-line"/g) ?? []).length).toBe(2);
  });
  it('the page still renders all six visuals', () => {
    expect(visualsIn(html)).toHaveLength(6);
  });
});

void vi;
