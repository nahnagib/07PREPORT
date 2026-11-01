import { describe, expect, it } from 'vitest';
import { changeRatio, isLargeChange, parseCriticalNumberInput } from '../criticalNumberAdmin';
import { formatCompactCurrency } from '../format';

describe('Admin > Critical Number input', () => {
  it('accepts a full number, thousands separators included, and previews it compactly', () => {
    expect(parseCriticalNumberInput('560000')).toEqual({ ok: true, value: 560_000 });
    expect(parseCriticalNumberInput(' 560,000.5 ')).toEqual({ ok: true, value: 560_000.5 });
    expect(formatCompactCurrency(560_000)).toBe('LYD 560.0K');
  });

  it('rejects empty, zero, negative, text and more than 2 decimals', () => {
    for (const raw of ['', '0', '-5', '560K', 'abc', '560000.123']) expect(parseCriticalNumberInput(raw).ok).toBe(false);
  });

  it('asks for confirmation only above +/-50% of the current value', () => {
    expect(changeRatio(616_000, 560_000)).toBeCloseTo(0.1, 9);
    expect(isLargeChange(840_000, 560_000)).toBe(false);
    expect(isLargeChange(840_001, 560_000)).toBe(true);
    expect(isLargeChange(279_999, 560_000)).toBe(true);
    expect(isLargeChange(900_000, null)).toBe(false);
  });
});
