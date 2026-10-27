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
  grain: 'month', target: 90, csatTarget: 95, minResponders: 5,
  points: [
    { period: '2026-09', responders: 10, promoters: 7, passives: 2, detractors: 1, promotersPct: 70, passivesPct: 20, detractorsPct: 10,
      nps: 60, csat: 90, npsBand: 'yellow', csatBand: 'yellow', belowMinimum: false },
    { period: '2026-10', responders: 0, promoters: 0, passives: 0, detractors: 0, promotersPct: null, passivesPct: null, detractorsPct: null,
      nps: null, csat: null, npsBand: null, csatBand: null, belowMinimum: true },
  ],
};
const state = (extra: Partial<TrendState> = {}): TrendState => ({ data, loading: false, error: null, retry: vi.fn(), ...extra });

it('shows NPS and CSAT by default without target lines or a CSAT toggle; preserves the grain controls', () => {
  const onGrainChange = vi.fn();
  render(<NpsTrendChart state={state()} grain="month" onGrainChange={onGrainChange} />);
  expect(screen.getByText('Satisfaction Trend')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'CSAT' })).toBeNull();
  const props: ComboChartProps = chart.mock.lastCall![0];
  expect(props.lines?.map((s) => s.key)).toEqual(['nps', 'npsSmall', 'csat', 'csatSmall']);
  fireEvent.click(screen.getByRole('button', { name: 'Weekly' }));
  expect(onGrainChange).toHaveBeenCalledWith('week');
  expect(screen.getByRole('button', { name: 'Monthly' }).getAttribute('aria-pressed')).toBe('true');
});

it('same style as the Satisfaction Trend: responders as bars, Promoters / Passives / Detractors as three lines on the same axis', () => {
  render(<RespondersTrend state={state()} grain="month" onGrainChange={vi.fn()} />);
  const props: ComboChartProps = chart.mock.lastCall![0];
  expect(props.bars.map((s) => s.key)).toEqual(['responders']);
  expect(props.lines?.map((s) => [s.key, s.yAxisId])).toEqual([['promoters', 'left'], ['passives', 'left'], ['detractors', 'left']]);
  expect(props.points.map((p) => p.responders)).toEqual([10, 0]);
  for (const p of props.points) expect(Number(p.promoters) + Number(p.passives) + Number(p.detractors)).toBe(p.responders);
  expect(props.tooltipFormatters?.promoters(7, props.points[0])).toBe('7 (70.00%)');
  expect(props.tooltipFormatters?.promoters(0, props.points[1])).toBe('0 (0.00%)');
});

it('hides stale chart data during filter reload and offers retry on failure', () => {
  const retry = vi.fn();
  const { rerender } = render(<RespondersTrend state={state({ loading: true })} grain="month" onGrainChange={vi.fn()} />);
  expect(screen.queryByTestId('combo-chart')).toBeNull();
  rerender(<RespondersTrend state={state({ error: 'Trend unavailable', retry })} grain="month" onGrainChange={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /retry/i }));
  expect(retry).toHaveBeenCalledOnce();
  rerender(<RespondersTrend state={state({ data: { ...data, points: [] } })} grain="month" onGrainChange={vi.fn()} />);
  expect(screen.getByText('No ratings for these filters and dates.')).toBeTruthy();
});

it('the Responders Trend has its own Weekly / Monthly / Yearly switch', () => {
  const onGrainChange = vi.fn();
  render(<RespondersTrend state={state()} grain="week" onGrainChange={onGrainChange} />);
  expect(screen.getByRole('group', { name: 'Responders Trend period' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Weekly' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Yearly' }));
  expect(onGrainChange).toHaveBeenCalledWith('year');
});
