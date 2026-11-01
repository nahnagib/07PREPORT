import { describe, expect, it } from 'vitest';
import { parseCriticalNumberChange } from '../criticalNumberAdminService';

const TODAY = '2026-10-21';

describe('parseCriticalNumberChange', () => {
  it('accepts a full number, with or without thousands separators', () => {
    expect(parseCriticalNumberChange({ value: 600000, effectiveFrom: TODAY }, TODAY, 560_000)).toEqual({ value: 600_000, effectiveFrom: TODAY, note: null });
    expect(parseCriticalNumberChange({ value: '600,000.50', effectiveFrom: '2026-11-01', note: '  Q4 push ' }, TODAY, 560_000)).toEqual({
      value: 600_000.5,
      effectiveFrom: '2026-11-01',
      note: 'Q4 push',
    });
  });

  it('rejects zero, negative, non-numeric and more than 2 decimals', () => {
    for (const value of [0, -1, 'abc', '', null, 560000.123]) {
      expect(() => parseCriticalNumberChange({ value, effectiveFrom: TODAY }, TODAY, 560_000)).toThrow();
    }
  });

  it('rejects a missing, malformed or past effective date', () => {
    expect(() => parseCriticalNumberChange({ value: 560000, effectiveFrom: '' }, TODAY, 560_000)).toThrow(/Effective from/);
    expect(() => parseCriticalNumberChange({ value: 560000, effectiveFrom: '2026-13-01' }, TODAY, 560_000)).toThrow(/Effective from/);
    expect(() => parseCriticalNumberChange({ value: 560000, effectiveFrom: '2026-10-20' }, TODAY, 560_000)).toThrow(/past/);
  });

  it('needs confirmation for a change of more than 50% of the current value', () => {
    expect(() => parseCriticalNumberChange({ value: 900000, effectiveFrom: TODAY }, TODAY, 560_000)).toThrow(/confirm/);
    expect(() => parseCriticalNumberChange({ value: 200000, effectiveFrom: TODAY }, TODAY, 560_000)).toThrow(/confirm/);
    expect(parseCriticalNumberChange({ value: 900000, effectiveFrom: TODAY, confirmLargeChange: true }, TODAY, 560_000).value).toBe(900_000);
    // exactly 50% is not "more than"
    expect(parseCriticalNumberChange({ value: 840000, effectiveFrom: TODAY }, TODAY, 560_000).value).toBe(840_000);
  });

  it('rejects a note longer than 500 characters', () => {
    expect(() => parseCriticalNumberChange({ value: 560000, effectiveFrom: TODAY, note: 'x'.repeat(501) }, TODAY, 560_000)).toThrow(/500/);
  });
});
