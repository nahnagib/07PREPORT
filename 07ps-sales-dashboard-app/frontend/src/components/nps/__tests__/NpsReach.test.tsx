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
  expect(screen.getByText('100% of reach')).toBeTruthy();
  expect(screen.getByText('25.00% of reach')).toBeTruthy(); // Delivered 3 / 12
  expect(screen.getByText('33.33% of reach')).toBeTruthy(); // Read 4 / 12
  for (const label of ['Total Reach', 'Delivered', 'Not Delivered', 'Read', 'Error']) {
    expect(screen.getByTestId(`reach-box-${label}`).getAttribute('title')).toContain('message date');
  }
  expect(screen.getByText('Reach data from 03 Oct 2026')).toBeTruthy();
});

it('no share when nothing was sent, and no start label for all history', () => {
  const empty = { ...ready, reachStart: null, totals: { totalReach: 0, delivered: 0, notDelivered: 0, read: 0, error: 0, otherState: 0 } };
  render(<NpsReach part="boxes" state={state(empty)} />);
  expect(screen.getAllByText('— of reach')).toHaveLength(4);
  expect(screen.queryByText(/Reach data from/)).toBeNull();
});

it('shows reasons, counts with their share, fixable flags and hints', () => {
  const errors = [...ready.errors, { key: 'other', label: 'Other', fixable: false, hint: 'Any other failure value.', count: 6 }];
  render(<NpsReach part="errors" state={state({ ...ready, errors })} />);
  expect(screen.getByText('Phone format · Fixable')).toBeTruthy();
  expect(screen.getByRole('img', { name: 'Phone format: 2 (25.00%)' })).toBeTruthy();
  expect(screen.getByRole('img', { name: 'Other: 6 (75.00%)' })).toBeTruthy();
  expect(screen.getByText('(75.00%)')).toBeTruthy();
  expect(screen.getByText('Correct the number in Odoo.')).toBeTruthy();
});

it('distinguishes a loaded empty period from waiting', () => {
  render(<NpsReach part="errors" state={state({ ...ready, errors: [] })} />);
  expect(screen.getByText('No message errors for these companies and dates.')).toBeTruthy();
  expect(screen.queryByTestId('nps-waiting')).toBeNull();
});

it('hides data for a role whose mandatory scope cannot apply to messages', () => {
  render(<NpsReach part="boxes" state={state({ ...ready, status: 'restricted', totals: null, errors: [], loadedAt: null })} />);
  expect(screen.getByText('Message reach is unavailable for your assigned data scope.')).toBeTruthy();
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
