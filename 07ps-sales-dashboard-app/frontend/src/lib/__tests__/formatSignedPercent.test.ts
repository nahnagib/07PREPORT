import { describe, expect, it } from 'vitest';
import { formatSignedPercent, formatVariance } from '../format';

describe('formatSignedPercent (2026-11-15)', () => {
  it('uses the typographic minus U+2212, same digits as formatVariance', () => {
    expect(formatSignedPercent(-0.6608)).toBe('−66.08%');
    expect(formatSignedPercent(0.032)).toBe('+3.20%');
    expect(formatSignedPercent(0)).toBe('+0.00%');
    expect(formatSignedPercent(null)).toBeUndefined();
    expect(formatSignedPercent(Number.NaN)).toBeUndefined();
    // formatVariance (other pages) keeps the ASCII hyphen
    expect(formatVariance(-0.6608)).toBe('-66.08%');
  });
});
