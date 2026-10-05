import { describe, expect, it } from 'vitest';
import { buildDebtReportQuery } from '../api';
import { formatCompactMoney, formatMoney } from '../format';
import {
  DEFAULT_DEBT_FILTERS,
  activeFilterCount,
  SIZE_TIER_HINT,
  agingColors,
  drillReconciles,
  drillTitle,
  isDefaultFilters,
  pctLabel,
  optLabel,
  safeOdooUrl,
  tierLabel,
  toScope,
} from '../debt/view';

describe('Debt Report view helpers', () => {
  it('uses Odoo Arabic labels when chosen, English otherwise or when no translation exists', () => {
    expect(optLabel({ labelEn: 'Customer Invoice', labelAr: 'فاتورة العميل' }, 'ar')).toBe('فاتورة العميل');
    expect(optLabel({ labelEn: 'Customer Invoice', labelAr: 'فاتورة العميل' }, 'en')).toBe('Customer Invoice');
    expect(optLabel({ labelEn: 'Net 30', labelAr: null }, 'ar')).toBe('Net 30');
  });

  it('builds tier labels from the configured thresholds', () => {
    expect(tierLabel({ value: 'large', labelEn: 'Large', labelAr: 'كبير', min: 100000, max: null }, 'en')).toBe('Large (≥ LYD 100,000)');
    expect(tierLabel({ value: 'medium', labelEn: 'Medium', labelAr: 'متوسط', min: 10000, max: 100000 }, 'en')).toBe('Medium (LYD 10,000–LYD 100,000)');
    expect(tierLabel({ value: 'small', labelEn: 'Small', labelAr: 'صغير', min: null, max: 10000 }, 'ar')).toBe('صغير (< LYD 10,000)');
  });

  it('colours not-due buckets in the accent family and overdue ones in the alert family', () => {
    const buckets = [1, 2, 3, 4, 5, 6, 7, 8].map((k) => ({ agingBucketKey: k, isOverdue: k >= 5 }));
    const colors = agingColors(buckets);
    expect([1, 2, 3, 4].every((k) => colors.get(k)?.includes('--ps-color-accent'))).toBe(true);
    expect([5, 6, 7, 8].every((k) => colors.get(k)?.includes('--ps-color-alert'))).toBe(true);
    expect(new Set(colors.values()).size).toBe(8);
  });

  it('shows every amount with its own currency code, never converted', () => {
    expect(formatCompactMoney('LYD', 579_600)).toBe('LYD 579.6K');
    expect(formatCompactMoney('USD', 42_100)).toBe('USD 42.1K');
    expect(formatMoney('LYD', -1234.5)).toBe('LYD -1,234.500');
    expect(formatMoney('EUR', 5034.4)).toBe('EUR 5,034.40');
    expect(formatMoney('USD', null)).toBe('—');
    expect(pctLabel(0.6)).toBe('60.0%');
    expect(pctLabel(null)).toBe('—');
  });

  it('titles a drill-down by what was clicked and reconciles it to the right figure', () => {
    expect(drillTitle('customer', 'ACME', 'USD')).toBe('Overdue documents of ACME · USD');
    expect(drillTitle('aging', 'Overdue 90+', 'LYD')).toBe('Open documents in Overdue 90+ · LYD');
    expect(drillReconciles('team')).toBe('overdueAmount');
    expect(drillReconciles('salesperson')).toBe('overdueAmount');
    expect(drillReconciles('aging')).toBe('openBalance');
    expect(drillReconciles('account')).toBe('openBalance');
    expect(SIZE_TIER_HINT).toBe('Size tier based on LYD value');
  });

  it('defaults to customer debt without inter-company and counts what is set', () => {
    expect(isDefaultFilters(DEFAULT_DEBT_FILTERS)).toBe(true);
    const f = { ...DEFAULT_DEBT_FILTERS, includeOther: true, agingBucketKeys: [8], customerSearch: ' acme ' };
    expect(isDefaultFilters(f)).toBe(false);
    expect(activeFilterCount(f)).toBe(3);
  });

  it("never sends a salesperson's own company / salesperson / team selection (the server locks them)", () => {
    const f = { ...DEFAULT_DEBT_FILTERS, salespersonKeys: [60], companyKeys: [1], salesTeamKeys: ['MJ-EST-BB'] };
    expect(toScope(f, true)).toMatchObject({ salespersonKeys: [], companyKeys: [], salesTeamKeys: [] });
    expect(toScope(f, false)).toMatchObject({ salespersonKeys: [60], companyKeys: [1], salesTeamKeys: ['MJ-EST-BB'] });
  });

  it('sends lists as repeated parameters and leaves defaults out', () => {
    const qs = buildDebtReportQuery({ companyKeys: [1, 3], includeOther: true, overdueStatus: 'all', invoiceTiers: ['large'] }, { kind: 'aging', key: 8, currency: 'USD' });
    expect(qs).toBe('includeOther=true&companyKeys=1&companyKeys=3&invoiceTiers=large&kind=aging&key=8&currency=USD');
    expect(buildDebtReportQuery({})).toBe('');
  });

  it('renders only http(s) Odoo links', () => {
    expect(safeOdooUrl('https://majaal.odoo.com/web#id=1&model=account.move&view_type=form')).not.toBeNull();
    expect(safeOdooUrl('javascript:alert(1)')).toBeNull();
  });
});
