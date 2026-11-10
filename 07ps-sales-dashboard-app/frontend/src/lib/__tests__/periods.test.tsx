import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { inProgressTitle, withInProgressSegment } from '@07ps/ui';
import { CHANGE_LABEL, DEFAULT_GRANULARITY, formatChange, periodAxisLabel, periodTitle, periodWindowView } from '../periods';
import { PeriodTrendSelector } from '../../components/PeriodTrendSelector';

afterEach(cleanup);

describe('shared period labels', () => {
  it('Weekly is the default; the change label follows the granularity', () => {
    expect(DEFAULT_GRANULARITY).toBe('week');
    expect(CHANGE_LABEL).toEqual({ day: 'DoD', week: 'WoW', month: 'MoM', year: 'YoY' });
    expect(formatChange(0.1234, 'week')).toBe('+12.3% WoW');
    expect(formatChange(-0.05, 'year')).toBe('-5.0% YoY');
    expect(formatChange(null, 'month')).toBeNull();
  });

  it('axis labels are short and unique in a window; titles name the period in full', () => {
    expect(periodAxisLabel('2026-11-07', 'week')).toBe('07 Nov');
    expect(periodTitle('2026-11-07', 'week')).toBe('Wk of 07 Nov 2026');
    expect(periodTitle('2026-11-09', 'day')).toBe('Mon 09 Nov 2026');
    expect(periodAxisLabel('2026-11-01', 'month')).toBe('Nov 2026');
    expect(periodAxisLabel('2026-01-01', 'year')).toBe('2026');
    const win = periodWindowView('week');
    const points = [{ start: '2026-10-31', inProgress: false }, { start: '2026-11-07', inProgress: true }];
    expect(win.inProgressLabel(points)).toBe('07 Nov');
    expect(win.tooltipTitle(points)('31 Oct')).toBe('Wk of 31 Oct 2026');
  });
});

describe('PeriodTrendSelector', () => {
  it('offers Daily / Weekly / Monthly / Yearly and reports the choice', () => {
    const onChange = vi.fn();
    render(<PeriodTrendSelector value="week" onChange={onChange} label="Sales Trend period" />);
    expect(screen.getByRole('group', { name: 'Sales Trend period' })).toBeTruthy();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Daily', 'Weekly', 'Monthly', 'Yearly']);
    expect(screen.getByRole('button', { name: 'Weekly' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Yearly' }));
    expect(onChange).toHaveBeenCalledWith('year');
  });
});

describe('the in-progress period on the charts', () => {
  it('splits a line into a solid part and a dashed last segment, and notes it in the tooltip', () => {
    const pts = [{ label: 'a', v: 1 }, { label: 'b', v: 2 }, { label: 'c', v: 3 }];
    const out = withInProgressSegment(pts, ['v'], 2) as Record<string, unknown>[];
    expect(out.map((p) => [p.v, p.v__done, p.v__ip])).toEqual([[1, 1, null], [2, 2, 2], [3, null, 3]]);
    expect(withInProgressSegment(pts, ['v'], -1)).toBe(pts);
    expect(inProgressTitle('c', 'c', (l) => `Wk ${l}`)).toBe('Wk c · Period in progress');
    expect(inProgressTitle('b', 'c')).toBe('b');
  });
});

describe('trend axis numbers', () => {
  it('stay short at every scale (a narrow axis never clips them)', async () => {
    const { formatCompactNumber } = await import('../format');
    expect([160_400_000, 2_400_000, 579_600, 1_500, 840, 0, -2_000_000].map(formatCompactNumber)).toEqual(['160M', '2.4M', '580K', '1.5K', '840', '0', '-2M']);
  });
});
