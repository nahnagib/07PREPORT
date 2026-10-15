import React, { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ScopeValuePicker } from '../ScopeValuePicker';

const OPTIONS = [
  { value: '-1', label: 'Unknown company' },
  { value: '1', label: 'Majaal' },
  { value: '3', label: 'Tika' },
  { value: '9', label: 'Athena' },
  { value: '12', label: 'X' },
];

let last: string[] = [];
function Harness({ initial = [] as string[] }) {
  const [value, setValue] = useState<string[]>(initial);
  last = value;
  return <ScopeValuePicker label="Company values" options={OPTIONS} value={value} onChange={setValue} />;
}
const open = () => fireEvent.click(screen.getByRole('button', { name: /Open the list/ }));

afterEach(cleanup);

describe('ScopeValuePicker', () => {
  it('checks values with checkboxes and shows them as removable chips', () => {
    render(<Harness />);
    expect(screen.getByText('Choose values')).toBeTruthy();
    open();
    fireEvent.click(screen.getByRole('checkbox', { name: 'X' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Unknown company' }));
    expect(last).toEqual(['12', '-1']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove X' }));
    expect(last).toEqual(['-1']);
  });

  it('Select all takes the options matching the search; Clear empties', () => {
    render(<Harness />);
    open();
    fireEvent.change(screen.getByLabelText('Search Company values'), { target: { value: 'ik' } });
    fireEvent.click(screen.getByRole('button', { name: /Select all/ }));
    expect(last).toEqual(['3']); // Tika only
    fireEvent.change(screen.getByLabelText('Search Company values'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(last).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(last).toEqual([]);
  });

  it('collapses more than three chips into "+N more"', () => {
    render(<Harness initial={['1', '3', '9', '12']} />);
    expect(screen.getByText('+1 more')).toBeTruthy();
    expect(screen.queryByText('X')).toBeNull(); // the 4th value is behind "+1 more"
  });
});
