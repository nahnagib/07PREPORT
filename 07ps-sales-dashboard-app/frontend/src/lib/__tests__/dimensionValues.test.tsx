import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { filterOptions, normalizeDimensionValues, normalizeSearch } from '../dataScope';

const getDimensionValues = vi.fn();
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, adminApi: { ...actual.adminApi, getDimensionValues: (...args: unknown[]) => getDimensionValues(...args) } };
});
vi.mock('../AuthProvider', () => ({ useAuth: () => ({ token: 't' }) }));

const { useDimensionValues, clearDimensionValuesCache } = await import('../useDimensionValues');

describe('normalizeDimensionValues: any API shape -> { value, label }', () => {
  it('accepts { value, label }, { id, name }, filter-endpoint rows, plain strings and a { values } envelope', () => {
    expect(normalizeDimensionValues([{ value: 1, label: 'Majaal' }])).toEqual([{ value: '1', label: 'Majaal' }]);
    expect(normalizeDimensionValues([{ id: 3, name: 'Tika' }])).toEqual([{ value: '3', label: 'Tika' }]);
    expect(normalizeDimensionValues([{ company_key: 9, company_name: 'Athena' }])).toEqual([{ value: '9', label: 'Athena' }]);
    expect(normalizeDimensionValues(['MJ-A', 7])).toEqual([{ value: 'MJ-A', label: 'MJ-A' }, { value: '7', label: '7' }]);
    expect(normalizeDimensionValues({ values: [{ value: '-1', label: 'Unassigned' }] })).toEqual([{ value: '-1', label: 'Unassigned' }]);
  });

  it('a missing label falls back to the key; unusable items and duplicates are dropped; anything else is []', () => {
    expect(normalizeDimensionValues([{ value: 5 }, { label: 'no key' }, null, { value: 5, label: 'again' }])).toEqual([{ value: '5', label: '5' }]);
    expect(normalizeDimensionValues(undefined)).toEqual([]);
    expect(normalizeDimensionValues({ error: 'x' })).toEqual([]);
  });
});

describe('search', () => {
  const options = [
    { value: '1', label: 'Majaal' },
    { value: '3', label: 'Tika' },
    { value: '20', label: 'شركة المتحدان' },
    { value: '21', label: 'إبراهيم البرغثي' },
  ];

  it('an empty, blank or missing query shows every option', () => {
    expect(filterOptions(options, '')).toHaveLength(4);
    expect(filterOptions(options, '   ')).toHaveLength(4);
    expect(filterOptions(options, undefined)).toHaveLength(4);
    expect(filterOptions(options, null)).toHaveLength(4);
  });

  it('ignores case, and Arabic letter variants (أ/إ/ا, ة/ه) and diacritics', () => {
    expect(filterOptions(options, 'MAJ').map((o) => o.value)).toEqual(['1']);
    expect(filterOptions(options, 'المتحدان').map((o) => o.value)).toEqual(['20']);
    expect(filterOptions(options, 'ابراهيم').map((o) => o.value)).toEqual(['21']); // typed without the hamza
    expect(filterOptions(options, 'شركه').map((o) => o.value)).toEqual(['20']); // ه for ة
    expect(normalizeSearch('شَرِكَة')).toBe(normalizeSearch('شركه'));
  });

  it('never throws on a label-less option', () => {
    expect(filterOptions([{ value: '1', label: undefined as unknown as string }], 'x')).toEqual([]);
  });
});

function Probe({ dimension }: { dimension: string }) {
  const { options, loading, error } = useDimensionValues(dimension);
  return <div data-testid="out">{loading ? 'loading' : error ? `error:${error}` : options.map((o) => o.label).join(',') || 'none'}</div>;
}

describe('useDimensionValues', () => {
  beforeEach(() => {
    clearDimensionValuesCache();
    getDimensionValues.mockReset();
  });
  afterEach(cleanup);

  it('loads on mount, and again when the dimension changes', async () => {
    getDimensionValues.mockImplementation(async (_t: string, d: string) =>
      d === 'companyKeys' ? { values: [{ value: '1', label: 'Majaal' }, { value: '3', label: 'Tika' }] } : { values: [{ value: '-1', label: 'Unassigned' }] },
    );
    const { rerender } = render(<Probe dimension="companyKeys" />);
    expect(screen.getByTestId('out').textContent).toBe('loading');
    await waitFor(() => expect(screen.getByTestId('out').textContent).toBe('Majaal,Tika'));
    rerender(<Probe dimension="salespersonKeys" />);
    await waitFor(() => expect(screen.getByTestId('out').textContent).toBe('Unassigned'));
    expect(getDimensionValues.mock.calls.map((c) => c[1])).toEqual(['companyKeys', 'salespersonKeys']);
  });

  it('shows a failed request as an error, not as an empty list', async () => {
    getDimensionValues.mockRejectedValue(new Error('boom'));
    render(<Probe dimension="companyKeys" />);
    await waitFor(() => expect(screen.getByTestId('out').textContent).toMatch(/^error:/));
  });

  it('no dimension = no request, no options', () => {
    render(<Probe dimension="" />);
    expect(screen.getByTestId('out').textContent).toBe('none');
    expect(getDimensionValues).not.toHaveBeenCalled();
  });
});

describe('ScopeValuePicker states', async () => {
  const { ScopeValuePicker } = await import('../../components/admin/ScopeValuePicker');
  afterEach(cleanup);
  const openList = () => fireEvent.click(screen.getByRole('button', { name: /Open the list/ }));
  const base = { label: 'Company values', value: [] as string[], onChange: () => undefined };

  it('loading, then every option with an empty search (no "No matches")', () => {
    const { rerender } = render(<ScopeValuePicker {...base} options={[]} loading />);
    openList();
    expect(screen.getAllByText('Loading values...').length).toBeGreaterThan(0);
    rerender(<ScopeValuePicker {...base} options={[{ value: '1', label: 'Majaal' }, { value: '3', label: 'Tika' }]} />);
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.queryByText('No matches')).toBeNull();
  });

  it('"No values available" for an empty dimension; "No matches" only for a search', () => {
    const { rerender } = render(<ScopeValuePicker {...base} options={[]} />);
    openList();
    expect(screen.getByText('No values available')).toBeTruthy();
    rerender(<ScopeValuePicker {...base} options={[{ value: '1', label: 'Majaal' }]} />);
    fireEvent.change(screen.getByLabelText('Search Company values'), { target: { value: 'zzz' } });
    expect(screen.getByText('No matches')).toBeTruthy();
  });

  it('a failed load is shown with a Retry', () => {
    const onRetry = vi.fn();
    render(<ScopeValuePicker {...base} options={[]} error="Could not load" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("a saved rule's chips keep their labels while the options load", () => {
    render(<ScopeValuePicker {...base} value={['12']} options={[]} loading savedLabels={{ '12': 'X' }} />);
    expect(screen.getByText('X')).toBeTruthy();
  });
});
