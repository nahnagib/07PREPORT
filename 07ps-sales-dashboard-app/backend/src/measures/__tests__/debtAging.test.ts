import { describe, expect, it } from 'vitest';
import { DebtQueryError } from '../debtReport';
import {
  addDays,
  agingSql,
  buildAging,
  classify,
  daysBetween,
  parseAgingQuery,
  resolveTerm,
  validateSettings,
  zoneRanges,
  type AgingSettings,
} from '../debtAging';

/** The seeded settings of migration 0037. */
const SETTINGS: AgingSettings = {
  zones: [
    { key: 'green', label: 'Green', upperMultiplier: 1, owner: 'Sales rep' },
    { key: 'yellow', label: 'Yellow', upperMultiplier: 2, owner: 'Sales director' },
    { key: 'red', label: 'Red', upperMultiplier: 3, owner: 'Management' },
    { key: 'black', label: 'Black', upperMultiplier: null, owner: 'Legal' },
  ],
  minStep: 7,
  escalationWindowDays: 7,
};
const zoneOf = (term: number, age: number) => SETTINGS.zones[classify(term, age, SETTINGS).zoneIndex].key;

describe('classify: zones scale with the term', () => {
  it.each([
    [90, 90, 'green'],
    [90, 91, 'yellow'],
    [90, 180, 'yellow'],
    [90, 181, 'red'],
    [90, 270, 'red'],
    [90, 271, 'black'],
    [15, 15, 'green'],
    [15, 16, 'yellow'],
    [15, 46, 'black'],
    [0, 7, 'green'], // Immediate Payment: W = min_step = 7
    [0, 8, 'yellow'],
  ])('term %i, invoice age %i -> %s', (term, age, zone) => {
    expect(zoneOf(term, age)).toBe(zone);
  });

  it('days to next zone: term 90 at age 90 -> 1; null once Black', () => {
    expect(classify(90, 90, SETTINGS).daysToNextZone).toBe(1);
    expect(classify(90, 271, SETTINGS).daysToNextZone).toBeNull();
    expect(classify(90, 271, SETTINGS).escalatingSoon).toBe(false);
  });

  it('derives days past due, position and escalating-soon', () => {
    const p = classify(30, 57, SETTINGS);
    expect(p).toEqual({ termWidth: 30, zoneIndex: 1, invoiceAge: 57, daysPastDue: 27, position: 1.9, daysToNextZone: 4, escalatingSoon: true });
    expect(classify(30, 52, SETTINGS).escalatingSoon).toBe(false); // 9 days to go
    expect(classify(0, 3, SETTINGS)).toMatchObject({ termWidth: 7, daysPastDue: 3, position: 3 / 7 });
  });

  it('an invoice dated after the as-of date counts as age 0 (green)', () => {
    expect(classify(30, -5, SETTINGS)).toMatchObject({ invoiceAge: 0, zoneIndex: 0, daysToNextZone: 31 });
  });

  it('follows changed settings: multipliers and min step are data, not code', () => {
    const wide: AgingSettings = {
      ...SETTINGS,
      minStep: 10,
      zones: SETTINGS.zones.map((z, i) => ({ ...z, upperMultiplier: [1.5, 3, 4, null][i] })),
    };
    expect(classify(0, 15, wide).zoneIndex).toBe(0); // W = 10, green to 15
    expect(classify(0, 16, wide).zoneIndex).toBe(1);
    expect(classify(20, 81, wide)).toMatchObject({ zoneIndex: 3, daysToNextZone: null });
  });

  it('zone ranges per term (the axis in real days)', () => {
    expect(zoneRanges(90, SETTINGS)).toEqual([
      { zone: 'green', from: 0, to: 90 },
      { zone: 'yellow', from: 91, to: 180 },
      { zone: 'red', from: 181, to: 270 },
      { zone: 'black', from: 271, to: null },
    ]);
    expect(zoneRanges(0, SETTINGS).map((r) => r.to)).toEqual([7, 14, 21, null]);
  });
});

describe('validateSettings', () => {
  it('accepts the seeded ladder and refuses broken ones', () => {
    expect(validateSettings(SETTINGS)).toBe(SETTINGS);
    const z = SETTINGS.zones;
    expect(() => validateSettings({ ...SETTINGS, zones: [z[0], z[2], z[1], z[3]] })).toThrow(/increase/);
    expect(() => validateSettings({ ...SETTINGS, zones: [z[0], z[1], z[2]] })).toThrow(/last zone/);
    expect(() => validateSettings({ ...SETTINGS, minStep: 0 })).toThrow(/min_step/);
  });
});

describe('resolveTerm', () => {
  const base = { paymentTermKey: 14, paymentTerm: '90 days', termDays: 90, invoiceDate: '2026-08-03', dueDate: '2026-11-01' };
  it('uses the payment term with its configured days', () => {
    expect(resolveTerm(base)).toEqual({ key: '14', label: '90 days', termDays: 90, source: 'payment_term' });
  });
  it('no term (or a term without configured days) -> the invoice due date', () => {
    expect(resolveTerm({ ...base, paymentTermKey: -1, paymentTerm: '(none)', termDays: null, dueDate: '2026-08-24' })).toEqual({
      key: 'due_date', label: 'By due date (21 days)', termDays: 21, source: 'due_date',
    });
    expect(resolveTerm({ ...base, termDays: null }).source).toBe('due_date');
  });
  it('no term and no due date -> Missing term, 0 days', () => {
    expect(resolveTerm({ ...base, paymentTermKey: -1, termDays: null, dueDate: null })).toEqual({ key: 'missing', label: 'Missing term', termDays: 0, source: 'missing' });
  });
});

describe('dates', () => {
  it('counts whole days across months and years', () => {
    expect(daysBetween('2026-08-03', '2026-10-06')).toBe(64);
    expect(daysBetween('2025-12-31', '2026-01-01')).toBe(1);
    expect(addDays('2026-10-04', 30)).toBe('2026-11-03');
  });
});

describe('parseAgingQuery', () => {
  it('drops the line-level page filters and keeps the customer-level ones', () => {
    const q = parseAgingQuery({
      overdueStatus: 'overdue', agingBucketKeys: '1,2', deliveryStatuses: 'full', ignoredDocumentType: 'move:out_invoice',
      paymentTermKeys: '4', invoiceTiers: 'large', customerCategories: 'B', includeOther: 'true',
      currency: 'usd', term: 'due_date',
    });
    expect(q.debt).toMatchObject({
      overdueStatus: 'all', agingBucketKeys: [], deliveryStatuses: [], paymentTermKeys: [], invoiceTiers: [],
      customerCategories: ['B'], includeOther: true,
    });
    expect(q).toMatchObject({ currency: 'USD', term: 'due_date' });
    expect(q).not.toHaveProperty('lookAheadDays');
  });
  it('400s on a bad currency or term', () => {
    expect(() => parseAgingQuery({ currency: 'LYDX' })).toThrow(DebtQueryError);
    expect(() => parseAgingQuery({ term: "1' OR 1=1" })).toThrow(DebtQueryError);
  });
});

describe('agingSql', () => {
  it('one statement: invoice lines only, oldest open line by ROW_NUMBER, balance by GROUP BY, term days joined', () => {
    const a = agingSql({ sql: 'FROM x l WHERE l.a = ?', params: [5] });
    expect(a.params).toEqual([5]);
    expect(a.sql).toContain('ROW_NUMBER() OVER (PARTITION BY ln.CustomerKey, ln.currency ORDER BY ln.InvoiceDateKey, ln.due_date, ln.line_id)');
    expect(a.sql).toContain("ln AS (SELECT * FROM src WHERE line_kind = 'invoice')"); // never credits / other entries / inter-company
    expect(a.sql).toContain('SUM(residual_company_ccy) AS outstanding_company');
    expect(a.sql).toContain('LEFT JOIN cfg_finance_payment_term_days td');
  });
});

/** A row as the aging query returns it. */
const row = (o: Record<string, unknown>) => ({
  currency: 'LYD', CustomerKey: 1, customer: 'A', CompanyKey: 1, company: 'MJ', PaymentTermKey: 4, payment_term: '30 Days', term_days: 30,
  move_id: 100, document: 'INV/1', InvoiceDateKey: 20260901, due_date: '2026-10-01', outstanding: '1000.000000',
  outstanding_company: '1000.000000', open_invoices: 1, ...o,
});
const build = (rows: Record<string, unknown>[], over: Partial<Parameters<typeof buildAging>[1]> = {}) =>
  buildAging(rows, { snapshotDate: '2026-10-04', currency: null, term: null, settings: SETTINGS, ...over });

describe('buildAging', () => {
  it('places customers and sorts them worst first', () => {
    const r = build([
      row({ CustomerKey: 1, InvoiceDateKey: 20260901, outstanding: '0.100000' }), // 33 days on 30 -> yellow
      row({ CustomerKey: 2, InvoiceDateKey: 20260920, outstanding: '0.200000' }), // 14 days -> green
      row({ CustomerKey: 3, InvoiceDateKey: 20260601, outstanding: '0.300000' }), // 125 days -> black
    ]);
    expect(r.customers.map((c) => [c.customerKey, c.zone])).toEqual([[3, 'black'], [1, 'yellow'], [2, 'green']]);
    expect(r.customers.map((c) => c.outstanding)).toEqual([0.3, 0.1, 0.2]);
    expect(r.zones[0]).toEqual({ key: 'green', label: 'Green', owner: 'Sales rep', lowerMultiplier: 0, upperMultiplier: 1 });
    expect(r.settings).toEqual({ minStep: 7, escalationWindowDays: 7, axisCap: 4.5 });
  });

  it('the invoice age runs to the snapshot date; the dashed ring flags the last week of a zone', () => {
    const r = build([row({ InvoiceDateKey: 20260904 })]); // 30 days: last green day
    expect(r.customers[0]).toMatchObject({ invoiceAge: 30, zone: 'green', nextZone: 'yellow', daysToNextZone: 1, escalatingSoon: true });
  });

  it('carries the LYD amount (company currency) next to the invoice-currency amount', () => {
    const r = build([row({ currency: 'USD', outstanding: '1000.000000', outstanding_company: '9800.500000', open_invoices: 3 })]);
    expect(r.customers[0]).toMatchObject({ outstanding: 1000, outstandingCompany: 9800.5, openInvoices: 3, oldestOpenDocument: 'INV/1' });
  });

  it('missing / due-date terms, term options and the term filter', () => {
    const rows = [
      row({ CustomerKey: 1 }),
      row({ CustomerKey: 2, PaymentTermKey: -1, payment_term: '(none)', term_days: null, due_date: '2026-09-15' }), // 14 days by due date
      row({ CustomerKey: 3, PaymentTermKey: -1, payment_term: '(none)', term_days: null, due_date: null }),
    ];
    const r = build(rows);
    expect(r.customers.find((c) => c.customerKey === 2)).toMatchObject({ termSource: 'due_date', termDays: 14, termLabel: 'By due date (14 days)' });
    expect(r.customers.find((c) => c.customerKey === 3)).toMatchObject({ termSource: 'missing', termDays: 0, termLabel: 'Missing term' });
    expect(r.terms.map((t) => [t.key, t.termDays, t.customers])).toEqual([['4', 30, 1], ['due_date', null, 1], ['missing', 0, 1]]);
    const only30 = build(rows, { term: '4' });
    expect(only30.customers.map((c) => c.customerKey)).toEqual([1]);
    expect(only30.terms).toHaveLength(3); // options never disappear because of the filter
  });

  it('one currency at a time; default = most customers', () => {
    const rows = [row({ CustomerKey: 1 }), row({ CustomerKey: 2 }), row({ CustomerKey: 1, currency: 'USD', outstanding: '50' })];
    const lyd = build(rows);
    expect(lyd).toMatchObject({ currency: 'LYD', currencies: ['LYD', 'USD'] });
    expect(lyd.customers).toHaveLength(2);
    const usd = build(rows, { currency: 'USD' });
    expect(usd.currency).toBe('USD');
    expect(usd.customers.map((c) => c.outstanding)).toEqual([50]);
  });

  it('renders an empty map without a snapshot', () => {
    expect(build([], { snapshotDate: null })).toMatchObject({ snapshotDate: null, currency: null, currencies: [], customers: [] });
  });
});
