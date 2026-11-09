import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NpsReach, type ReachState } from '../NpsReach';
import type { NpsReach as ReachData } from '../../../lib/api';

afterEach(cleanup);
const ready: ReachData = {
  status: 'ready', dateFrom: '2026-10-01', dateTo: '2026-10-18', companyAndDateOnly: true,
  loadedAt: '2026-10-18 10:00:00', reachStart: '2026-10-03',
  totals: { totalReach: 12, delivered: 3, notDelivered: 2, read: 4, error: 2, otherState: 1 },
  errors: [{ key: 'phone_format', label: 'Phone format', fixable: true, hint: 'Correct the number in Odoo.', count: 2 }],
  isEstimated: false, estimateStatus: 'not_needed', estimate: null, measured: null, gap: null,
};
// YTD on the local warehouse (9 Nov 2026): measured since 03 Oct + the gap 12 Jul – 02 Oct (Error real)
const MEASURED = { totalReach: 1733, delivered: 365, notDelivered: 78, read: 857, error: 433, otherState: 0 };
const GAP = { totalReach: 3190, delivered: 764, notDelivered: 112, read: 1793, error: 521, otherState: 0 };
const estimated: ReachData = {
  ...ready, dateFrom: '2026-01-01', dateTo: '2026-11-09', companyAndDateOnly: false,
  totals: { totalReach: 4923, delivered: 1129, notDelivered: 190, read: 2650, error: 954, otherState: 0 },
  errors: [{ key: 'phone_format', label: 'Phone format', fixable: true, hint: 'Correct the number in Odoo.', count: 954 }],
  isEstimated: true, estimateStatus: 'applied', estimate: { from: '2026-07-12', to: '2026-10-02' }, measured: MEASURED, gap: GAP,
};
const state = (data: ReachData | null, extra: Partial<ReachState> = {}): ReachState => ({ data, loading: false, error: null, retry: vi.fn(), ...extra });

it('shows no numbers while waiting for the source', () => {
  render(<NpsReach part="boxes" state={state({ ...ready, status: 'waiting', totals: null, errors: [], loadedAt: null })} />);
  expect(screen.getByTestId('nps-waiting').textContent).toBe('Waiting for the WhatsApp message data');
  expect(screen.queryByText('Total Reach')).toBeNull();
});

it('renders the five message counts, limited-filter label, other states and refresh time', () => {
  render(<NpsReach part="boxes" state={state(ready)} />);
  for (const label of ['Total Reach', 'Delivered', 'Not Delivered', 'Read', 'Error']) expect(screen.getByText(label)).toBeTruthy();
  expect(screen.getByText('12')).toBeTruthy();
  expect(screen.getByText('Company and date filters only')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toContain('1 messages have other states');
  expect(screen.getByText('Message refresh 2026-10-18 10:00:00 UTC')).toBeTruthy();
});

it('each box shows its share of Total Reach and a tooltip saying reach uses the message date', () => {
  render(<NpsReach part="boxes" state={state(ready)} />);
  expect(screen.getByText('Rate of reach: —')).toBeTruthy();
  expect(screen.getByText('25.00% of reach')).toBeTruthy(); // Delivered 3 / 12
  expect(screen.getByText('33.33% of reach')).toBeTruthy(); // Read 4 / 12
  for (const label of ['Total Reach', 'Delivered', 'Not Delivered', 'Read', 'Error']) {
    expect(screen.getByTestId(`reach-box-${label}`).getAttribute('title')).toContain('message date');
  }
  expect(screen.getByText('Reach data from 03 Oct 2026')).toBeTruthy();
});

it('the gap in the period: official totals, "incl. est." on the estimated cards, "incl. gap" on Error, tooltips measured + gap, the subtitle', () => {
  render(<NpsReach part="boxes" state={state(estimated)} responseRate={{ status: 'ready', responders: 801, requestedDateFrom: estimated.dateFrom, dateFrom: '2026-07-12', dateTo: estimated.dateTo }} />);
  expect(screen.getByText('Survey Reach')).toBeTruthy();
  expect(screen.getByText('Rate of reach: 16.27%')).toBeTruthy();
  expect(screen.queryByText('100% of reach')).toBeNull();
  expect(screen.getByTestId('reach-box-Total Reach').getAttribute('title')).toContain('Rate of reach = Responders ÷ Total reach = 801 ÷ 4,923 = 16.27%');
  expect(screen.getByTestId('reach-subtitle').textContent).toBe('Measured from 03 Oct 2026 · 12 Jul – 02 Oct estimated');
  expect(screen.getByText('4,923')).toBeTruthy();
  expect(screen.getByText('22.93% of reach')).toBeTruthy(); // Delivered 1,129 / 4,923, on the new totals
  for (const label of ['Total Reach', 'Delivered', 'Not Delivered', 'Read']) {
    expect(screen.getByTestId(`reach-box-${label}`).textContent).toContain('incl. est.');
    expect(screen.getByTestId(`reach-box-${label}`).getAttribute('data-estimated')).toBe('true');
  }
  expect(screen.getByTestId('reach-box-Error').textContent).toContain('incl. gap');
  expect(screen.getByTestId('reach-box-Delivered').getAttribute('title')).toContain('Measured from 03 Oct: 365\n12 Jul – 02 Oct (estimated): 764\nTotal: 1,129');
  expect(screen.getByTestId('reach-box-Error').getAttribute('title')).toContain('12 Jul – 02 Oct (actual, kept by the source): 521');
  // Delivered + Read = the Response Rate denominator (801 / 3,779 = 21.20 %)
  expect(estimated.totals!.delivered + estimated.totals!.read).toBe(3779);
});

it('a period fully after 03 Oct: exactly the measured numbers, no marks, the usual subtitle', () => {
  render(<NpsReach part="boxes" state={state(ready)} />);
  expect(screen.queryByText('incl. est.')).toBeNull();
  expect(screen.queryByText('incl. gap')).toBeNull();
  expect(screen.getByTestId('reach-subtitle').textContent).toBe('Reach data from 03 Oct 2026');
});

it('no share when nothing was sent, and no start label for all history', () => {
  const empty = { ...ready, reachStart: null, totals: { totalReach: 0, delivered: 0, notDelivered: 0, read: 0, error: 0, otherState: 0 } };
  render(<NpsReach part="boxes" state={state(empty)} />);
  expect(screen.getAllByText('— of reach')).toHaveLength(4);
  expect(screen.queryByText(/Reach data from/)).toBeNull();
});

it('shows short reasons and shares in a pie, with causes and fixable details only on hover', () => {
  const errors = [...ready.errors, { key: 'other', label: 'Other', fixable: false, hint: 'Any other failure value.', count: 6 }];
  render(<NpsReach part="errors" state={state({ ...ready, errors })} />);
  expect(screen.getByText('Phone wrong')).toBeTruthy();
  const phone = screen.getByRole('button', { name: 'Phone wrong: 2 (25.00%)' });
  expect(screen.getByRole('button', { name: 'Other: 6 (75.00%)' })).toBeTruthy();
  expect(screen.getByRole('img', { name: 'Message errors by reason. Total: 8' })).toBeTruthy();
  expect(screen.getByText('(75.00%)')).toBeTruthy();
  expect(screen.queryByRole('tooltip')).toBeNull();
  expect(screen.queryByText(/Correct the number in Odoo/)).toBeNull();
  fireEvent.mouseEnter(phone);
  expect(screen.getByRole('tooltip').textContent).toContain('Correct the number in Odoo.');
  expect(screen.getByRole('tooltip').textContent).toContain('Fixable:');
  fireEvent.mouseLeave(phone);
  expect(screen.queryByRole('tooltip')).toBeNull();
  fireEvent.focus(phone);
  expect(screen.getByRole('tooltip').textContent).toContain('incorrect number');
  fireEvent.keyDown(phone, { key: 'Escape' });
  expect(screen.queryByRole('tooltip')).toBeNull();
  fireEvent.click(phone);
  expect(screen.getByRole('tooltip').textContent).toContain('incorrect number');
});

it('distinguishes a loaded empty period from waiting', () => {
  render(<NpsReach part="errors" state={state({ ...ready, errors: [] })} />);
  expect(screen.getByText('No message errors for these companies and dates.')).toBeTruthy();
  expect(screen.queryByTestId('nps-waiting')).toBeNull();
});

it('hides data for a role whose mandatory scope cannot apply to messages', () => {
  render(<NpsReach part="boxes" state={state({ ...ready, status: 'restricted', totals: null, errors: [], loadedAt: null })} />);
  expect(screen.getByText('Survey Reach is unavailable for your assigned data scope.')).toBeTruthy();
  expect(screen.queryByText('Total Reach')).toBeNull();
});

it('does not show an old snapshot while reloading filters and supports retry on failure', () => {
  const retry = vi.fn();
  const { rerender } = render(<NpsReach part="boxes" state={state(ready, { loading: true })} />);
  expect(screen.queryByText('Total Reach')).toBeNull();
  rerender(<NpsReach part="boxes" state={state(null, { error: 'Request failed', retry })} />);
  expect(screen.getByText('Request failed')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /retry/i }));
  expect(retry).toHaveBeenCalledOnce();
});

it('does not show a stale-period rate or divide by zero', () => {
  const { rerender } = render(<NpsReach part="boxes" state={state(ready)} responseRate={{ status: 'ready', responders: 801, requestedDateFrom: estimated.dateFrom, dateFrom: '2026-07-12', dateTo: estimated.dateTo }} />);
  expect(screen.getByText('Rate of reach: —')).toBeTruthy();
  rerender(<NpsReach part="boxes" state={state({ ...ready, totals: { ...ready.totals!, totalReach: 0 } })} responseRate={{ status: 'ready', responders: 0, dateFrom: ready.dateFrom, dateTo: ready.dateTo }} />);
  expect(screen.getByText('Rate of reach: —')).toBeTruthy();
});

it('rejects a stale requested start even when the end date and effective start match', () => {
  render(<NpsReach part="boxes" state={state(estimated)} responseRate={{ status: 'ready', responders: 801, requestedDateFrom: '2026-07-01', dateFrom: '2026-07-12', dateTo: estimated.dateTo }} />);
  expect(screen.getByText('Rate of reach: —')).toBeTruthy();
});
