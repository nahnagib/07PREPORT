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
  includesManual: false, bySource: null, manualPeriods: [],
};
// YTD on the local warehouse (9 Nov 2026): measured since 03 Oct + the manual reach 12 Jul – 02 Oct (migration 0071)
const ETL = { totalReach: 1733, delivered: 365, notDelivered: 78, read: 857, error: 433, otherState: 0 };
const META = { totalReach: 1555, delivered: 361, notDelivered: 21, read: 766, error: 407, otherState: 0 };
const EST = { totalReach: 1207, delivered: 369, notDelivered: 5, read: 758, error: 75, otherState: 0 };
const PERIODS: ReachData['manualPeriods'] = [
  { from: '2026-07-12', to: '2026-08-12', source: 'estimate' },
  { from: '2026-08-13', to: '2026-08-31', source: 'meta_manual+estimate' },
  { from: '2026-09-01', to: '2026-09-30', source: 'meta_manual' },
  { from: '2026-10-01', to: '2026-10-02', source: 'meta_manual' },
];
const estimated: ReachData = {
  ...ready, dateFrom: '2026-01-01', dateTo: '2026-11-09', companyAndDateOnly: false,
  totals: { totalReach: 4495, delivered: 1095, notDelivered: 104, read: 2381, error: 915, otherState: 0 },
  errors: [{ key: 'phone_format', label: 'Phone format', fixable: true, hint: 'Correct the number in Odoo.', count: 433 },
    { key: 'meta_manual', label: 'Unclassified (Meta manual)', fixable: false, hint: 'No reason per message.', count: 482 }],
  includesManual: true, bySource: { etl: ETL, manual: META, estimate: EST }, manualPeriods: PERIODS,
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

it('manual reach in the period: combined totals, "incl. manual/est." on every card, tooltips measured / Meta manual / estimate, the subtitle', () => {
  render(<NpsReach part="boxes" state={state(estimated)} responseRate={{ status: 'ready', responders: 801, requestedDateFrom: estimated.dateFrom, dateFrom: '2026-07-12', dateTo: estimated.dateTo }} />);
  expect(screen.getByText('Survey Reach')).toBeTruthy();
  expect(screen.getByText('Rate of reach: 17.82%')).toBeTruthy();
  expect(screen.getByTestId('reach-box-Total Reach').getAttribute('title')).toContain('Rate of reach = Responders ÷ Total reach = 801 ÷ 4,495 = 17.82%');
  expect(screen.getByTestId('reach-subtitle').textContent)
    .toBe('12 Jul – 12 Aug estimated · 13 Aug – 02 Oct from Meta (manual; 13–31 Aug Delivered/Read estimated) · from 03 Oct measured');
  expect(screen.getByText('4,495')).toBeTruthy();
  expect(screen.getByText('24.36% of reach')).toBeTruthy(); // Delivered 1,095 / 4,495
  for (const label of ['Total Reach', 'Delivered', 'Not Delivered', 'Read', 'Error']) {
    expect(screen.getByTestId(`reach-box-${label}`).textContent).toContain('incl. manual/est.');
    expect(screen.getByTestId(`reach-box-${label}`).getAttribute('data-manual')).toBe('true');
  }
  expect(screen.getByTestId('reach-box-Delivered').getAttribute('title')).toContain('Measured (from 03 Oct): 365\nMeta manual: 361\nEstimate: 369\nTotal: 1,095');
  expect(screen.getByTestId('reach-box-Error').getAttribute('title')).toContain('Measured (from 03 Oct): 433\nMeta manual: 407\nEstimate: 75\nTotal: 915');
  // Delivered + Read = the Response Rate denominator (801 / 3,476 = 23.04 %)
  expect(estimated.totals!.delivered + estimated.totals!.read).toBe(3476);
});

it('a card without manual reach is not marked (only the source-split tooltip)', () => {
  const bySource = { etl: ETL, manual: { ...META, notDelivered: 0 }, estimate: { ...EST, notDelivered: 0 } };
  render(<NpsReach part="boxes" state={state({ ...estimated, bySource })} />);
  expect(screen.getByTestId('reach-box-Not Delivered').getAttribute('data-manual')).toBeNull();
  expect(screen.getByTestId('reach-box-Read').getAttribute('data-manual')).toBe('true');
});

it('a period fully after 03 Oct: exactly the measured numbers, no marks, the usual subtitle', () => {
  render(<NpsReach part="boxes" state={state(ready)} />);
  expect(screen.queryByText('incl. manual/est.')).toBeNull();
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
