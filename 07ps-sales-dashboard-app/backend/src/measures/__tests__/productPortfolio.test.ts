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
