import { describe, expect, it } from 'vitest';
import { CUSTOMER_CATEGORIES, customerCategoryColor, customerCategoryLabel, isCustomerCategory } from '../customerCategory';

describe('customer category (shared by Customer Growth and Receivables and Collections)', () => {
  it('keeps the Customer Growth order, labels and palette', () => {
    expect([...CUSTOMER_CATEGORIES]).toEqual(['A', 'B', 'C', 'D']);
    expect(customerCategoryLabel('A')).toBe('Category A');
    expect(customerCategoryLabel(null)).toBe('No category');
    expect(customerCategoryLabel('none')).toBe('No category');
    expect(isCustomerCategory('D') && !isCustomerCategory('E')).toBe(true);
    expect(customerCategoryColor(0)).toBe('var(--ps-color-trend-target)');
    expect(customerCategoryColor(6)).toBe(customerCategoryColor(0));
  });
});
