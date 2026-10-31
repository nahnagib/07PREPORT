import type { CustomerStatusLabel } from './api';
/** All is represented by an empty selection in MultiSelect. */
export const STATUS_SLICER_OPTIONS: { value: CustomerStatusLabel; label: string }[] = [
  { value: 'Active Retained', label: 'Active Retained' },
  { value: 'New', label: 'New' },
  { value: 'Non Active', label: 'Non Active' },
  { value: 'Reactivated', label: 'Reactivated' },
  { value: 'Blocked', label: 'Blocked' },
  { value: 'Other', label: 'Other' },
];
export function filterCustomerStatus<T extends { status: CustomerStatusLabel }>(rows: readonly T[], status: CustomerStatusLabel | null): T[] {
  return rows.filter(row => status === null || row.status === status);
}
