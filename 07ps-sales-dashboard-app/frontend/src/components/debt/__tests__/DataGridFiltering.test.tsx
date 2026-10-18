import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DataGrid, type DataGridColumn } from '../../../../../packages/ui/src/components/DataGrid';

const guard = vi.hoisted(() => ({ renders: 0 }));
vi.mock('../../../../../packages/ui/src/exportPermission', () => ({
  authorizeExport: () => false,
  useCanExport: () => {
    // Stop a pagination/render loop before it can hang the test worker.
    if (++guard.renders > 50) throw new Error('DataGrid did not settle');
    return false;
  },
}));

class RenderBoundary extends React.Component<{ children: React.ReactNode }, { error: string | null }> {
  state = { error: null };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() { return this.state.error ? <div role="alert">{this.state.error}</div> : this.props.children; }
}

type Customer = { id: string; customer: string };
const columns: DataGridColumn<Customer>[] = [{ key: 'customer', header: 'Customer' }];
const rows = Array.from({ length: 4 }, (_, i) => ({ id: String(i), customer: `Customer ${i}` }));
const getRowId = (row: Customer) => row.id;
const grid = (data: Customer[], enableFiltering = false) => (
  <RenderBoundary><DataGrid columns={columns} rows={data} getRowId={getRowId} enableFiltering={enableFiltering} pageSize={2} /></RenderBoundary>
);

beforeEach(() => { guard.renders = 0; });
afterEach(cleanup);

describe('DataGrid with column filtering disabled (receivables Customers)', () => {
  it('settles after a page filter replaces the rows and resets pagination', async () => {
    const view = render(grid(rows));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await act(async () => {});
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Customer 2')).toBeTruthy();

    view.rerender(grid([{ id: 'filtered', customer: 'Filtered customer' }]));
    await act(async () => {});
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Filtered customer')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(true);
    expect(guard.renders).toBeLessThan(20);
  });

  it('ignores retained column filters when disabled and restores them when enabled', async () => {
    const view = render(grid(rows, true));
    await act(async () => {});
    fireEvent.change(screen.getByPlaceholderText('Filter...'), { target: { value: 'Customer 3' } });
    await act(async () => {});
    expect(screen.queryByText('Customer 0')).toBeNull();
    expect(screen.getByText('Customer 3')).toBeTruthy();

    view.rerender(grid(rows));
    await act(async () => {});
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Customer 0')).toBeTruthy();

    view.rerender(grid(rows, true));
    await act(async () => {});
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Customer 0')).toBeNull();
    expect(screen.getByText('Customer 3')).toBeTruthy();
  });
});
