import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComboChartProps } from '@07ps/ui';
import type { NpsTrend } from '../../../lib/api';
import { NpsTrendChart, RespondersTrend, type TrendState } from '../NpsTrends';

// Inspect chart inputs without depending on jsdom's absent SVG layout/ResizeObserver.
const { chart } = vi.hoisted(() => ({ chart: vi.fn() }));
vi.mock('@07ps/ui', async (importOriginal) => ({
  ...await importOriginal<typeof import('@07ps/ui')>(),
  ComboChart: (props: ComboChartProps) => { chart(props); return <div data-testid="combo-chart" />; },
}));
afterEach(() => { cleanup(); chart.mockClear(); });

const data: NpsTrend = {
  granularity: 'month', from: '2025-11-01', to: '2026-10-20', firstRatingDate: '2026-09-03', target: 90, csatTarget: 95, minResponders: 5,
  points: [
    { period: '2025-08-01', end: '2025-08-31', inProgress: false, measured: false, responders: 0, promoters: 0, passives: 0, detractors: 0,
      promotersPct: null, passivesPct: null, detractorsPct: null, nps: null, csat: null, npsBand: null, csatBand: null, belowMinimum: false },
    { period: '2026-09-01', end: '2026-09-30', inProgress: false, measured: true, responders: 10, promoters: 7, passives: 2, detractors: 1, promotersPct: 70, passivesPct: 20, detractorsPct: 10,
      nps: 60, csat: 90, npsBand: 'yellow', csatBand: 'yellow', belowMinimum: false },
    { period: '2026-10-01', end: '2026-10-31', inProgress: true, measured: true, responders: 0, promoters: 0, passives: 0, detractors: 0, promotersPct: null, passivesPct: null, detractorsPct: null,
      nps: null, csat: null, npsBand: null, csatBand: null, belowMinimum: true },
  ],
};
const state = (extra: Partial<TrendState> = {}): TrendState => ({ data, loading: false, error: null, retry: vi.fn(), ...extra });

it('shows NPS and CSAT by default without target lines or a CSAT toggle; the shared period selector', () => {
  const onGrainChange = vi.fn();
  render(<NpsTrendChart state={state()} granularity="month" onGranularityChange={onGrainChange} />);
  expect(screen.getByText('Satisfaction Trend')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'CSAT' })).toBeNull();
  const props: ComboChartProps = chart.mock.lastCall![0];
  expect(props.lines?.map((s) => s.key)).toEqual(['nps', 'npsSmall', 'csat', 'csatSmall']);
  fireEvent.click(screen.getByRole('button', { name: 'Weekly' }));
  expect(onGrainChange).toHaveBeenCalledWith('week');
  expect(screen.getByRole('button', { name: 'Monthly' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('button', { name: 'Daily' })).toBeTruthy();
  // the current month is marked in progress; months before the first rating are gaps, not 0
  expect(props.inProgressLabel).toBe('Oct 2026');
  expect(props.points.map((p) => [p.label, p.responders, p.nps])).toEqual([['Aug 2025', null, null], ['Sep 2026', 10, 60], ['Oct 2026', 0, null]]);
  expect(props.tooltipLabelFormatter?.('Aug 2025')).toBe('Aug 2025 · before the first rating');
});

it('same style as the Satisfaction Trend: responders as bars, Promoters / Passives / Detractors as three lines on the same axis', () => {
  render(<RespondersTrend state={state()} granularity="month" onGranularityChange={vi.fn()} />);
  const props: ComboChartProps = chart.mock.lastCall![0];
  expect(props.bars.map((s) => s.key)).toEqual(['responders']);
  expect(props.lines?.map((s) => [s.key, s.yAxisId])).toEqual([['promoters', 'left'], ['passives', 'left'], ['detractors', 'left']]);
  expect(props.points.map((p) => p.responders)).toEqual([null, 10, 0]);
  for (const p of props.points.slice(1)) expect(Number(p.promoters) + Number(p.passives) + Number(p.detractors)).toBe(p.responders);
  expect(props.tooltipFormatters?.promoters(7, props.points[1])).toBe('7 (70.00%)');
  expect(props.tooltipFormatters?.promoters(0, props.points[2])).toBe('0 (0.00%)');
});

it('hides stale chart data during filter reload and offers retry on failure', () => {
  const retry = vi.fn();
  const { rerender } = render(<RespondersTrend state={state({ loading: true })} granularity="month" onGranularityChange={vi.fn()} />);
  expect(screen.queryByTestId('combo-chart')).toBeNull();
  rerender(<RespondersTrend state={state({ error: 'Trend unavailable', retry })} granularity="month" onGranularityChange={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /retry/i }));
  expect(retry).toHaveBeenCalledOnce();
  rerender(<RespondersTrend state={state({ data: { ...data, points: data.points.slice(0, 1) } })} granularity="month" onGranularityChange={vi.fn()} />);
  expect(screen.getByText('No ratings in this period for these filters.')).toBeTruthy();
  // a response for another granularity (a slower previous request) is never drawn on the new axis
  rerender(<RespondersTrend state={state()} granularity="week" onGranularityChange={vi.fn()} />);
  expect(screen.queryByTestId('combo-chart')).toBeNull();
});

it('the Responders Trend has its own Daily / Weekly / Monthly / Yearly selector', () => {
  const onGrainChange = vi.fn();
  render(<RespondersTrend state={state({ data: { ...data, granularity: 'week' } })} granularity="week" onGranularityChange={onGrainChange} />);
  expect(screen.getByRole('group', { name: 'Responders Trend period' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Weekly' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Yearly' }));
  expect(onGrainChange).toHaveBeenCalledWith('year');
});
