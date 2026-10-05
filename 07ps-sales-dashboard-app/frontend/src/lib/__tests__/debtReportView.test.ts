import { describe, expect, it } from 'vitest';
import { buildDebtReportQuery } from '../api';
import {
  DEFAULT_DEBT_FILTERS,
  activeFilterCount,
  agingColors,
  changeCell,
  changeLine,
  isDefaultFilters,
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

  it('says when a comparison becomes available until the snapshot exists', () => {
    expect(changeLine({ days: 7, comparedWith: null, availableFrom: '2026-10-11', change: null })).toBe('7d: available from 11 Oct 2026');
    expect(changeLine({ days: 30, comparedWith: '2026-09-04', availableFrom: '2026-10-04', change: 1_250_000 })).toBe('30d: +LYD 1.3M');
    expect(changeCell(null)).toBe('—');
    expect(changeCell(-1234.5)).toBe('LYD -1,234.500');
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
    const qs = buildDebtReportQuery({ companyKeys: [1, 3], includeOther: true, overdueStatus: 'all', invoiceTiers: ['large'] }, { customerKey: 5 });
    expect(qs).toBe('includeOther=true&companyKeys=1&companyKeys=3&invoiceTiers=large&customerKey=5');
    expect(buildDebtReportQuery({})).toBe('');
  });

  it('renders only http(s) Odoo links', () => {
    expect(safeOdooUrl('https://majaal.odoo.com/web#id=1&model=account.move&view_type=form')).not.toBeNull();
    expect(safeOdooUrl('javascript:alert(1)')).toBeNull();
  });
});
