import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, departmentReports, firstAccessiblePath, isComingSoon, pageKeyForPath } from '../navItems';

describe('"Coming soon" placeholder pages', () => {
  const soon = NAV_ITEMS.filter(isComingSoon);
  it('Process: Quality Assurance and Customer Pulse; Product: Product Development Plan', () => {
    expect(soon.map((i) => [i.label, i.department, i.href, i.pageKey])).toEqual([
      ['Product Development Plan', 'product', '/product/product-development-plan', 'product_development_plan'],
      ['Quality Assurance', 'process', '/process/quality-assurance', 'quality_assurance'],
      ['Customer Pulse', 'process', '/process/customer-pulse', 'customer_pulse'],
    ]);
  });
  it('they sit in their department with their own permission, after the live reports', () => {
    const all = () => true;
    expect(departmentReports('process', all).map((i) => i.label).slice(-2)).toEqual(['Quality Assurance', 'Customer Pulse']);
    expect(departmentReports('product', all).map((i) => i.label).at(-1)).toBe('Product Development Plan');
    expect(departmentReports('process', (k) => k !== 'customer_pulse').map((i) => i.label)).not.toContain('Customer Pulse');
    expect(pageKeyForPath('/process/quality-assurance')).toBe('quality_assurance');
  });
  it('a placeholder is never the landing page after sign-in', () => {
    expect(firstAccessiblePath((k) => k === 'quality_assurance' || k === 'nps_score', false)).toBe('/process/nps-score');
    expect(firstAccessiblePath((k) => k === 'quality_assurance', false)).toBe('/');
  });
});
