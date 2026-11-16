import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { SkuTrend as SkuTrendData, SkuTrendPoint } from '../../../lib/api';
import { periodWindowView } from '../../../lib/periods';

const trend = vi.hoisted(() => ({ data: null as unknown, granularities: [] as string[] }));
const chart = vi.hoisted(() => ({ props: null as null | Record<string, any> }));
const api = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('../../../lib/AuthProvider', () => ({ useAuth: () => ({ token: 't', error: null, retryAuth: vi.fn() }) }));
vi.mock('../../../lib/hooks', () => ({
  useSkuTrend: (_t: unknown, _e: unknown, _r: unknown, _s: unknown, g: string) => {
    trend.granularities.push(g);
    return { data: trend.data, loading: false, error: null, retry: vi.fn() };
  },
}));
vi.mock('../../../lib/api', async (orig) => ({
  ...await orig<typeof import('../../../lib/api')>(),
  fetchSkuTrendSkus: vi.fn(async (...args: unknown[]) => {
    api.calls.push(args);
    return {
      granularity: 'month', status: args[4], period: { start: '2026-10-01', end: '2026-10-31', stockDate: '2026-10-31' },
      skus: [{ odooProductId: '7', sku: 'M7', productName: 'Tile 60x60', companies: ['Majaal'], units: 12.5, value: 3400, onHandQty: 40, archived: false, status: 'active', odooUrl: null }],
    };
  }),
}));
// The shared ComboChart: record its props (jsdom has no layout for Recharts to measure)
vi.mock('@07ps/ui', async (orig) => ({
  ...await orig<typeof import('@07ps/ui')>(),
  ComboChart: (props: Record<string, any>) => {
    chart.props = props;
    return <div data-testid="combo-chart" />;
  },
}));

import { SkuTrend, SKU_TREND_GRANULARITIES, SKU_TREND_SERIES, TOTAL_SERIES, axisLabel, axisMax, periodRange, placeLineLabels, statusLine } from '../SkuTrend';

const counts = (active: number, nonActive: number, dormant: number) => ({ active, nonActive, dormant, total: active + nonActive + dormant });
const point = (start: string, end: string, c: ReturnType<typeof counts> | null, previous: ReturnType<typeof counts> | null, inProgress = false): SkuTrendPoint => ({
  start, end, inProgress, stockDate: inProgress ? '2026-11-16' : end, counts: c, previous,
});
const MONTHS: SkuTrendPoint[] = [
  point('2026-09-01', '2026-09-30', counts(860, 500, 470), counts(850, 510, 470)),
  point('2026-10-01', '2026-10-31', counts(868, 520, 462), counts(860, 500, 470)),
  point('2026-11-01', '2026-11-30', counts(880, 515, 455), counts(868, 520, 462), true),
];
const DATA: SkuTrendData = { granularity: 'month', view: 'BMH', from: '2026-09-01', to: '2026-11-16', points: MONTHS, stockLoaded: true, missingStockDates: [] };
const showMonthly = () => {
  trend.data = DATA;
  render(<SkuTrend scope={{ company: 'Majaal' }} companyLabel="Majaal + Tika" />);
  fireEvent.click(screen.getByRole('button', { name: 'Monthly' }));
  return chart.props!;
};

afterEach(() => {
  cleanup();
  trend.granularities = [];
  api.calls = [];
  chart.props = null;
});

describe('SKU Trend helpers', () => {
  it('tooltip line: count · % of the period’s SKUs · change vs the period before', () => {
    expect(statusLine('active', counts(880, 515, 455), counts(868, 520, 462), 'month')).toBe('Active 880 · 47.6% · +12 MoM');
    expect(statusLine('nonActive', counts(880, 515, 455), counts(868, 520, 462), 'week')).toBe('Non Active 515 · 27.8% · −5 WoW');
    expect(statusLine('dormant', counts(1, 1, 1), null, 'year')).toBe('Dormant 1 · 33.3% · no YoY');
  });

  it('the period in progress: "(to date)" on the axis, dates to the To Date', () => {
    const win = periodWindowView('month');
    expect(axisLabel(MONTHS[2], win)).toBe('Nov 2026 (to date)');
    expect(periodRange(MONTHS[2], '2026-11-16')).toBe('01 Nov 2026 – 16 Nov 2026');
  });

  it('the y-axis starts at 0 with ~15% headroom on a round top whose quarters are round', () => {
    expect(axisMax([4082, 3235])).toBe(4800);
    expect(axisMax([268, 126])).toBe(320);
    for (const totals of [[4082], [268], [3923, 3109], [89], [1]]) {
      const top = axisMax(totals);
      expect(top).toBeGreaterThanOrEqual(Math.max(...totals) * 1.15);
      expect(top).toBeLessThan(Math.max(...totals) * 1.15 * 1.5);
    }
  });

  it('line labels: never overlapping each other or the total label; none at all when they cannot all fit', () => {
    const wide = placeLineLabels(MONTHS, 2400, { width: 1100, height: 340 })!;
    expect(wide).not.toBeNull();
    const plotH = 340 - 24 - 30;
    const y = (v: number) => 24 + plotH * (1 - v / 2400);
    MONTHS.forEach((p, i) => {
      const centres = [y(p.counts!.total) - 12, ...SKU_TREND_SERIES.map((s) => (wide[i][s.key] === 'above' ? y(p.counts![s.key]) - 11 : y(p.counts![s.key]) + 12))];
      for (let a = 0; a < centres.length; a++) for (let b = a + 1; b < centres.length; b++) expect(Math.abs(centres[a] - centres[b])).toBeGreaterThanOrEqual(13);
    });
    // 12 weeks in a narrow card: slots narrower than "1,455" -> tooltip only
    const weeks = Array.from({ length: 12 }, (_, i) => point(`2026-0${(i % 9) + 1}-01`, '2026-09-30', counts(120, 1455, 1500), null));
    expect(placeLineLabels(weeks, 4000, { width: 500, height: 340 })).toBeNull(); // ~35 px slots < a "1,455" label
    // statuses too close together to label each one -> none
    expect(placeLineLabels([point('2026-10-01', '2026-10-31', counts(1000, 1010, 1020), null)], 4000, { width: 1100, height: 340 })).toBeNull();
  });
});

describe('SkuTrend section', () => {
  it('without stock history: the empty state only -- no chart, no export', () => {
    trend.data = { ...DATA, granularity: 'week', stockLoaded: false, points: MONTHS.map((p) => (p.inProgress ? p : { ...p, counts: null })) };
    render(<SkuTrend scope={{}} companyLabel="Majaal + Tika" />);
    expect(screen.getByTestId('sku-trend-not-loaded').textContent).toContain('Stock history not loaded yet – run the backfill script');
    expect(screen.queryByTestId('combo-chart')).toBeNull();
    expect(screen.queryByRole('button', { name: /Export/ })).toBeNull();
  });

  it('Weekly by default; Weekly / Monthly / Yearly; one subtitle; legend Total SKUs + the 3 lines', () => {
    showMonthly();
    expect(trend.granularities[0]).toBe('week');
    expect(SKU_TREND_GRANULARITIES).toEqual(['week', 'month', 'year']);
    expect(within(screen.getByTestId('period-trend-selector')).getAllByRole('button').map((b) => b.textContent)).toEqual(['Weekly', 'Monthly', 'Yearly']);
    expect(screen.getByTestId('sku-trend-subtitle').textContent).toBe('Monthly · last 12 months to 16 Nov 2026 · Majaal + Tika');
    expect(screen.getByTestId('sku-trend-legend').textContent).toBe('Total SKUsActiveNon ActiveDormant');
  });

  it('the shared ComboChart: slate total bars with labels, 3 status lines on the same axis, faded period in progress', () => {
    const p = showMonthly();
    expect(p.bars).toHaveLength(1);
    expect(p.bars[0]).toMatchObject({ key: 'total', name: 'Total SKUs', color: TOTAL_SERIES.color });
    expect(['var(--ps-color-success)', 'var(--ps-color-watch)', 'var(--ps-color-alert)']).not.toContain(p.bars[0].color);
    expect(p.bars[0].labelFormatter(4082)).toBe('4,082');
    expect(p.lines.map((l: { key: string; color: string; yAxisId: string }) => [l.key, l.color, l.yAxisId])).toEqual([
      ['active', 'var(--ps-color-success)', 'left'], ['nonActive', 'var(--ps-color-watch)', 'left'], ['dormant', 'var(--ps-color-alert)', 'left'],
    ]);
    expect(p.lines.every((l: { labelContent?: unknown }) => typeof l.labelContent === 'function')).toBe(true);
    expect(p.leftDomain).toEqual([0, axisMax([1830, 1850, 1850])]);
    expect(p.leftDomain[1]).toBeGreaterThanOrEqual(1850 * 1.15);
    expect(p).toMatchObject({ barCategoryGap: '22%', maxBarSize: 72, inProgressBarStyle: 'faded', inProgressLabel: 'Nov 2026 (to date)',
      connectNulls: false, showLegend: false, showExportButton: false });
    expect(p.points.map((r: { label: string; total: number }) => [r.label, r.total])).toEqual([['Sep 2026', 1830], ['Oct 2026', 1850], ['Nov 2026 (to date)', 1850]]);
  });

  it('the tooltip: the dates, the total first, then each status with % and MoM', () => {
    const p = showMonthly();
    render(<>{p.tooltipContent({ active: true, label: 'Nov 2026 (to date)', payload: [] })}</>);
    const tip = screen.getByTestId('sku-trend-tooltip').textContent!;
    expect(tip).toContain('01 Nov 2026 – 16 Nov 2026');
    expect(tip.indexOf('Total 1,850 · ±0 MoM')).toBeLessThan(tip.indexOf('Active 880 · 47.6% · +12 MoM'));
    expect(tip).toContain('Dormant 455 · 24.6% · −7 MoM');
  });

  it('drill-down: the bar lists every SKU of the period (with a Status column), a line point that status’s SKUs', async () => {
    const p = showMonthly();
    p.onSeriesClick('Oct 2026', 'total');
    const table = await screen.findByTestId('sku-trend-drill-table');
    expect(api.calls[0].slice(1)).toEqual([{ company: 'Majaal' }, 'month', '2026-10-01', 'all']);
    expect(table.textContent).toMatch(/Status/);
    expect(table.textContent).toContain('Tile 60x60');
    expect(screen.getByRole('button', { name: /as CSV/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Back to the trend/ }));
    p.onSeriesClick('Oct 2026', 'dormant');
    await screen.findByTestId('sku-trend-drill-table');
    expect(api.calls.at(-1)!.slice(3)).toEqual(['2026-10-01', 'dormant']);
    expect(screen.getByTestId('sku-trend-drill-table').textContent).not.toMatch(/Status/);
    fireEvent.click(screen.getByRole('button', { name: /^All SKUs/ }));
    await screen.findByTestId('sku-trend-drill-table');
    expect(api.calls.at(-1)!.slice(3)).toEqual(['2026-10-01', 'all']);
  });
});
