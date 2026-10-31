import { describe, expect, it } from 'vitest';
import { STATUS_SLICER_OPTIONS, filterCustomerStatus } from '../customerStatus';
import type { CustomerStatusLabel } from '../api';
describe('Customer Status slicer', () => {
  it('includes Blocked before Other and uses consistent labels', () => {
    expect(STATUS_SLICER_OPTIONS.map(o => o.value)).toEqual(['Active Retained','New','Non Active','Reactivated','Blocked','Other']);
    expect(STATUS_SLICER_OPTIONS.every(o => o.label === o.value)).toBe(true);
  });
  it('keeps only Blocked rows for the table and its export input, and All resets', () => {
    const rows = STATUS_SLICER_OPTIONS.flatMap(o => Array.from({length: o.value === 'Blocked' ? 32 : 3}, (_,i) => ({ id: `${o.value}-${i}`, status: o.value as CustomerStatusLabel })));
    const filtered = filterCustomerStatus(rows,'Blocked');
    expect(filtered).toHaveLength(32);
    expect(filtered.every(row => row.status === 'Blocked')).toBe(true);
    expect(filterCustomerStatus(rows,null)).toEqual(rows);
  });
});
