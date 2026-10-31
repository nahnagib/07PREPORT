import { describe, expect, it } from 'vitest';
import { buildDebtReportQuery } from '../api';
import { formatCompactMoney, formatMoney } from '../format';
import {
  DEFAULT_DEBT_FILTERS,
  dailyTrendPoints,
  receivablesPeriodStart,
  receivablesTrendPoints,
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

  it('sends Customer group and Distribution Channel to every report endpoint and counts/reset them', () => {
    const filters = { ...DEFAULT_DEBT_FILTERS, segmentKeys: [1, 2], channelKeys: [3] };
    expect(buildDebtReportQuery(toScope(filters, false))).toBe('segmentKeys=1&segmentKeys=2&channelKeys=3');
    expect(activeFilterCount(filters)).toBe(2);
    expect(toScope(filters, true)).toMatchObject({ segmentKeys: [], channelKeys: [] });
    expect(DEFAULT_DEBT_FILTERS).toMatchObject({ segmentKeys: [], channelKeys: [] });
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

describe('Receivables trend by day / week / month', () => {
  const snap = (snapshotDate: string, open: number | null, overdue = 0) => ({ snapshotDate, currency: 'LYD', open, overdue, notDue: open === null ? null : open - overdue, net: open });
  // Sun 4 Oct .. Sat 10 Oct is one week; 11 Oct starts the next; 1 Nov a new month
  const pts = [snap('2026-10-05', 100, 10), snap('2026-10-09', 140, 30), snap('2026-10-10', null), snap('2026-10-12', 90, 5), snap('2026-11-01', 70, 7)];

  it('weeks run Saturday to Friday, months start on the 1st', () => {
    expect(receivablesPeriodStart('2026-10-10', 'week')).toBe('2026-10-10'); // Saturday starts its own week
    expect(receivablesPeriodStart('2026-10-11', 'week')).toBe('2026-10-10'); // Sunday belongs to Saturday’s week
    expect(receivablesPeriodStart('2026-10-27', 'month')).toBe('2026-10-01');
  });

  it('a week / month shows its LAST snapshot with a value (a balance is never summed), and says which day', () => {
    const w = receivablesTrendPoints(pts, 'week');
    expect(w.map((p) => [p.label, p.total, p.overdue, p.asOf])).toEqual([
      ['3 Oct 26', 140, 30, '2026-10-09'], // 10 Oct has no value, so 9 Oct closes the week -- not 100 + 140
      ['10 Oct 26', 90, 5, '2026-10-12'],
      ['31 Oct 26', 70, 7, '2026-11-01'],
    ]);
    const m = receivablesTrendPoints(pts, 'month');
    expect(m.map((p) => [p.label, p.total, p.asOf])).toEqual([['Oct 2026', 90, '2026-10-12'], ['Nov 2026', 70, '2026-11-01']]);
  });

  it('days keep one point per calendar day, gaps included', () => {
    const d = receivablesTrendPoints(pts, 'day');
    expect(d).toHaveLength(28); // 5 Oct .. 1 Nov
    expect(d[0]).toMatchObject({ total: 100, asOf: null });
    expect(d[1].total).toBeNull();
    expect(receivablesTrendPoints([], 'week')).toEqual([]);
  });
});
