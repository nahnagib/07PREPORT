import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NpsReach, type ReachState } from '../NpsReach';
import type { NpsReach as ReachData } from '../../../lib/api';

afterEach(cleanup);
const ready: ReachData = {
  status: 'ready', dateFrom: '2026-10-01', dateTo: '2026-10-18', companyAndDateOnly: true,
  loadedAt: '2026-10-18 10:00:00',
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

it('shows reasons, counts, fixable flags and hints', () => {
  render(<NpsReach part="errors" state={state(ready)} />);
  expect(screen.getByText('Phone format · Fixable')).toBeTruthy();
  expect(screen.getByRole('img', { name: 'Phone format: 2' })).toBeTruthy();
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
