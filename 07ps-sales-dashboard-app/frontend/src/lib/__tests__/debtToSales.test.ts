import { describe, expect, it } from 'vitest';
import { debtToSales } from '../debt/debtToSales';

describe('Debt to YTD Sales % (2026-11-15)', () => {
  const bands = { greenMaxPct: 10, yellowMaxPct: 20 };
  it('= debt ÷ YTD sales × 100; 0–10 green, 10–20 yellow, 20+ red', () => {
    expect(debtToSales(5, 100, bands)).toEqual({ pct: 5, tone: 'success' });
    expect(debtToSales(10, 100, bands)).toEqual({ pct: 10, tone: 'watch' });
    expect(debtToSales(19.9, 100, bands).tone).toBe('watch');
    expect(debtToSales(20, 100, bands)).toEqual({ pct: 20, tone: 'alert' });
  });
  it('no YTD sales: no percentage', () => {
    expect(debtToSales(5, 0, bands)).toEqual({ pct: null, tone: 'neutral' });
    expect(debtToSales(5, null, bands).pct).toBeNull();
  });
});
