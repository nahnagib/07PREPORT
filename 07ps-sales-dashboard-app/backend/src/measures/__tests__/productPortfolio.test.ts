import { describe, expect, it } from 'vitest';
import { combineStatuses, isPortfolioStatus, productStatusOf } from '../productPortfolio';

describe('one definition of "our products" (2026-11-15)', () => {
  it('Unclassified > Dormant > Active > Non Active, per company row', () => {
    expect(productStatusOf({ ExcludedByCategory: 1, IsActive: 0 }, true)).toBe('Unclassified'); // archived AND excluded
    expect(productStatusOf({ ProductStatus: 'Unclassified' }, true)).toBe('Unclassified');
    expect(productStatusOf({ IsActive: 0 }, true)).toBe('Dormant'); // archived, even if sold
    expect(productStatusOf({ ProductStatus: 'Dormant', IsActive: 1 }, false)).toBe('Dormant');
    expect(productStatusOf({ IsActive: 1, ProductStatus: 'NonActive' }, true)).toBe('Active'); // the period decides
    expect(productStatusOf({ IsActive: 1, ProductStatus: 'Active' }, false)).toBe('NonActive');
    expect(productStatusOf({ IsActive: null }, false)).toBe('NonActive');
  });

  it('a SKU (variant in both companies) is one bucket; the portfolio is Active + Non Active', () => {
    expect(combineStatuses(['Dormant', 'Unclassified'])).toBe('Unclassified');
    expect(combineStatuses(['Dormant', 'Active'])).toBe('Active');
    expect(combineStatuses(['Dormant', 'Dormant'])).toBe('Dormant');
    expect(combineStatuses(['Dormant', 'NonActive'])).toBe('NonActive');
    expect(['Active', 'NonActive', 'Dormant', 'Unclassified'].map(isPortfolioStatus)).toEqual([true, true, false, false]);
  });
});

describe('Product Movement "Discontinued" = the Product Lifecycle rule (2026-11-15)', () => {
  it('no sale in the last 365 days before the period end; archive status plays no part; never sold = no movement', async () => {
    const { movementOf } = await import('../productDashboard');
    const period = { from: '2025-11-15', to: '2026-11-15', days: 366, priorFrom: '2024-11-14', priorTo: '2025-11-14', isDefault: true, label: 'Last 12 Months' } as never;
    const rule = { bandPct: 10, newWithinDays: 180, noSalesDays: 365 };
    const row = (over: Record<string, unknown>) => ({ lines: 0, volume: 0, volumePrior: 0, valuePrior: 0, isActive: 1, firstSaleDate: '2023-01-01', lastSaleDate: null, ...over }) as never;
    expect(movementOf(row({ lastSaleDate: '2025-06-01' }), period, rule)).toBe('Discontinued');                 // 17 months ago
    expect(movementOf(row({ lastSaleDate: '2025-06-01', volumePrior: 5, valuePrior: 50 }), period, rule)).toBe('Discontinued');
    expect(movementOf(row({ lastSaleDate: '2026-10-01', lines: 3, volume: 10, volumePrior: 10, valuePrior: 1, isActive: 0 }), period, rule)).toBe('Stable');
    expect(movementOf(row({ lastSaleDate: null }), period, rule)).toBeNull();                                     // never sold
    expect(movementOf(row({ lastSaleDate: '2026-11-14', lines: 1, volume: 20, volumePrior: 10, valuePrior: 1 }), period, rule)).toBe('Improved');
  });
});
