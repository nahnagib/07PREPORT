import { describe, expect, it } from 'vitest';
import { buildDebtReportQuery } from '../api';
import { formatCompactMoney, formatMoney } from '../format';
import {
  DEFAULT_DEBT_FILTERS,
  dailyTrendPoints,
  activeFilterCount,
  fromIncludeValues,
  includeValues,
  OVERDUE_STATUS_OPTIONS,
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
  currencyFromSearch,
  searchWithCurrency,
  toggleCurrency,
  customerAgingBucket,
  customerBucketColor,
  customerBucketOptions,
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
    expect(SIZE_TIER_HINT).toBe("Size tier based on the invoice's open LYD value");
  });

  it('defaults to customer debt without inter-company and counts what is set', () => {
    expect(isDefaultFilters(DEFAULT_DEBT_FILTERS)).toBe(true);
    const f = { ...DEFAULT_DEBT_FILTERS, includeOther: true, agingBucketKeys: [8], customerKeys: [42], customerCategories: ['A'] };
    expect(isDefaultFilters(f)).toBe(false);
    expect(activeFilterCount(f)).toBe(4);
    expect(DEFAULT_DEBT_FILTERS).not.toHaveProperty('documentTypeKeys');
    expect(DEFAULT_DEBT_FILTERS).not.toHaveProperty('customerSearch');
  });

  it('maps the dropdowns: Include multi-select, Overdue status in the words of the cards (the Select adds "All")', () => {
    expect(includeValues({ includeOther: true, includeIntercompany: false })).toEqual(['other']);
    expect(fromIncludeValues(['intercompany'])).toEqual({ includeOther: false, includeIntercompany: true });
    expect(OVERDUE_STATUS_OPTIONS.map((o) => o.label)).toEqual(['Overdue', 'Not yet due']);
    const qs = buildDebtReportQuery(toScope({ ...DEFAULT_DEBT_FILTERS, customerKeys: [42], customerCategories: ['B', 'none'] }, false));
    expect(qs).toBe('customerKeys=42&customerCategories=B&customerCategories=none');
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

describe('dailyTrendPoints (Receivables trend on a calendar axis, 2026-10-11)', () => {
  it('one point per day from the first to the last snapshot; missing days and empty snapshots are gaps', () => {
    const p = (snapshotDate: string, open: number | null) => ({ snapshotDate, currency: 'LYD', open, overdue: open, notDue: open === null ? null : 0, net: open });
    const out = dailyTrendPoints([p('2026-10-04', null), p('2026-10-06', 10), p('2026-10-08', 12)]);
    expect(out.map((x) => x.total)).toEqual([null, null, 10, null, 12]);
    expect(out).toHaveLength(5);
    expect(dailyTrendPoints([])).toEqual([]);
  });
});

describe('page currency filter (2026-10-15)', () => {
  it('reads ?currency= from the URL; absent or invalid = all currencies', () => {
    expect(currencyFromSearch('?currency=usd')).toBe('USD');
    expect(currencyFromSearch('?x=1&currency=EUR')).toBe('EUR');
    expect(currencyFromSearch('')).toBeNull();
    expect(currencyFromSearch('?currency=DOLLARS')).toBeNull();
  });

  it('writes it back keeping the other parameters', () => {
    expect(searchWithCurrency('?x=1', 'USD')).toBe('?x=1&currency=USD');
    expect(searchWithCurrency('?x=1&currency=USD', null)).toBe('?x=1');
    expect(searchWithCurrency('?currency=USD', null)).toBe('');
  });

  it('a row click selects; the same row again clears; another row switches', () => {
    expect(toggleCurrency(null, 'USD')).toBe('USD');
    expect(toggleCurrency('USD', 'USD')).toBeNull();
    expect(toggleCurrency('USD', 'EUR')).toBe('EUR');
  });

  it('drill-down title of the all-currencies view', () => {
    expect(drillTitle('aging', 'Overdue 90+', null)).toBe('Open documents in Overdue 90+ · All currencies (≈ LYD)');
  });
});

describe('customer Aging bucket column (2026-10-15)', () => {
  const buckets = [
    { value: '1', labelEn: 'Not due 60+', isOverdue: false },
    { value: '4', labelEn: 'Not due 0-15', isOverdue: false },
    { value: '5', labelEn: 'Overdue 1-30', isOverdue: true },
    { value: '6', labelEn: 'Overdue 31-60', isOverdue: true },
    { value: '7', labelEn: 'Overdue 61-90', isOverdue: true },
    { value: '8', labelEn: 'Overdue 90+', isOverdue: true },
  ];

  it('the oldest overdue invoice decides; Not due without overdue; — with credits only', () => {
    expect(customerAgingBucket({ openDocuments: 3, oldestOverdueBucketKey: 8 }, buckets)).toEqual({ label: 'Overdue 90+', rank: 4, severity: 1 });
    expect(customerAgingBucket({ openDocuments: 1, oldestOverdueBucketKey: 5 }, buckets)).toEqual({ label: 'Overdue 1-30', rank: 1, severity: 0 });
    expect(customerAgingBucket({ openDocuments: 2, oldestOverdueBucketKey: null }, buckets).label).toBe('Not due');
    expect(customerAgingBucket({ openDocuments: 0, oldestOverdueBucketKey: null }, buckets).label).toBe('—');
  });

  it('filter options run from Not due to the oldest bucket, then —', () => {
    expect(customerBucketOptions(buckets).map((o) => o.value)).toEqual(['Not due', 'Overdue 1-30', 'Overdue 31-60', 'Overdue 61-90', 'Overdue 90+', '—']);
  });

  it('green for Not due, stronger red as the bucket ages', () => {
    expect(customerBucketColor({ label: 'Not due', rank: 0, severity: null })).toBe('var(--ps-color-success)');
    expect(customerBucketColor({ label: 'Overdue 1-30', rank: 1, severity: 0 })).toContain('alert) 25%');
    expect(customerBucketColor({ label: 'Overdue 90+', rank: 4, severity: 1 })).toContain('alert) 100%');
  });
});
