import { describe, expect, it } from 'vitest';
import {
  CREDIT_POLICY_ZONES,
  approachingNextZone,
  creditZoneForDays,
  creditActionForDays,
  nextCreditZone,
  validateCreditPolicy,
  type CreditPolicyZone,
} from '../../config/creditPolicy';
import { buildCreditPolicy, daysBetween, invoiceDueDate, parseAgingQuery, placeCustomers, type CreditLine } from '../debtAging';

/** Credit Policy Escalation (2026-10-15): zones by days past due of the unpaid invoice with the earliest due date. */

let lineId = 0;
function line(p: Partial<CreditLine> & { CustomerKey: number; move_id: number; due_date: string | null; residual: number }): CreditLine {
  lineId += 1;
  const { residual, ...rest } = p;
  return {
    currency: 'LYD', customer: `Customer ${p.CustomerKey}`, customer_ref: null, CompanyKey: 1, company: 'Majaal', PaymentTermKey: 4,
    payment_term: '30 Days', term_days: 30, line_id: lineId, document: `INV/${p.move_id}`, invoice_date: '2026-08-01', invoice_due_date: p.due_date,
    residual_doc_ccy: residual, residual_company_ccy: residual, ...rest,
  } as CreditLine;
}

describe('the zones (config/creditPolicy.ts)', () => {
  it.each([
    [0, 'GREEN'], [15, 'GREEN'], [16, 'YELLOW'], [30, 'YELLOW'], [31, 'RED'], [44, 'RED'], [45, 'BLOCK'], [60, 'BLOCK'],
    [61, 'BLOCK'], [65, 'BLOCK'], [66, 'BLOCK'], [419, 'BLOCK'],
  ])('%i days past due -> %s', (days, zone) => {
    expect(creditZoneForDays(days)?.key).toBe(zone);
  });

  it('negative days = not yet due, never GREEN', () => {
    expect(creditZoneForDays(-1)).toBeNull();
  });

  it('owners follow the policy', () => {
    expect(CREDIT_POLICY_ZONES.map((z) => [z.key, z.minDays, z.maxDays, z.owner])).toEqual([
      ['GREEN', 0, 15, 'Sales Manager'],
      ['YELLOW', 16, 30, 'Sales Director'],
      ['RED', 31, 44, 'CEO'],
      ['BLOCK', 45, null, 'GCEO + CFO'],
    ]);
  });

  it('a gap, an overlap or a closed last zone fails at load', () => {
    const z = CREDIT_POLICY_ZONES.map((x) => ({ ...x }));
    expect(() => validateCreditPolicy(z)).not.toThrow();
    expect(() => validateCreditPolicy([{ ...z[0], maxDays: 14 }, ...z.slice(1)] as CreditPolicyZone[])).toThrow(/gap or overlap/);
    expect(() => validateCreditPolicy([...z.slice(0, -1), { ...z[3], maxDays: 999 }] as CreditPolicyZone[])).toThrow(/open-ended/);
  });

  it('the dashed ring: within 7 days of the next zone (days >= upper - 6); never within BLOCK', () => {
    expect(approachingNextZone(8)).toBe(false);
    expect(approachingNextZone(9)).toBe(true); // GREEN ends at 15: moves in 7 days
    expect(nextCreditZone(9)).toEqual({ zone: expect.objectContaining({ key: 'YELLOW' }), inDays: 7 });
    expect(approachingNextZone(38)).toBe(true); // RED ends at 44
    expect(approachingNextZone(61)).toBe(false); // internal action changes keep the customer in BLOCK
    expect(approachingNextZone(66)).toBe(false);
    expect(approachingNextZone(419)).toBe(false);
    expect(nextCreditZone(500)).toBeNull();
  });
});

describe('placement: days past due of the earliest unpaid due date', () => {
  it('payment term 30, due 1 Sep, as of 20 Oct = 49 days -> BLOCK (never "1.63x term")', () => {
    const c = [...placeCustomers([line({ CustomerKey: 1, move_id: 10, due_date: '2026-09-01', residual: 100 })], '2026-10-20', false).values()][0];
    expect(c.daysPastDue).toBe(49);
    expect(c.zone).toBe('BLOCK');
    expect(c.responsibleRole).toBe('GCEO + CFO');
    expect(c.requiredAction).toBe('Management Escalation');
    expect(c).not.toHaveProperty('position');
  });

  it('due tomorrow = NOT YET DUE (not 0 / GREEN); due today = day 0, GREEN', () => {
    const tomorrow = [...placeCustomers([line({ CustomerKey: 1, move_id: 10, due_date: '2026-10-21', residual: 100 })], '2026-10-20', false).values()][0];
    expect(tomorrow).toMatchObject({ zone: 'NOT_YET_DUE', notYetDue: true, daysPastDue: -1, daysUntilDue: 1, approachingNextZone: false });
    const today = [...placeCustomers([line({ CustomerKey: 1, move_id: 10, due_date: '2026-10-20', residual: 100 })], '2026-10-20', false).values()][0];
    expect(today).toMatchObject({ zone: 'GREEN', notYetDue: false, daysPastDue: 0 });
  });

  it('the invoice with the EARLIEST due date decides, even when another invoice is older', () => {
    const c = [
      ...placeCustomers(
        [
          // older invoice (1 Jul) with a 90-day term: due 29 Sep
          line({ CustomerKey: 7, move_id: 1, invoice_date: '2026-07-01', due_date: '2026-09-29', residual: 500 }),
          // newer invoice (1 Aug), cash: due 1 Aug -> the earliest due date
          line({ CustomerKey: 7, move_id: 2, invoice_date: '2026-08-01', due_date: '2026-08-01', residual: 200 }),
        ],
        '2026-10-20',
        false,
      ).values(),
    ][0];
    expect(c.oldestInvoiceMoveId).toBe(2);
    expect(c.oldestDueDate).toBe('2026-08-01');
    expect(c.daysPastDue).toBe(80);
    expect(c.zone).toBe('BLOCK');
    // one dot per customer, sized by every unpaid invoice
    expect(c.totalOutstanding).toBe(700);
    expect(c.unpaidInvoiceCount).toBe(2);
  });

  it('a paid-off invoice never decides; a negative line on an invoice lowers the outstanding', () => {
    const c = [
      ...placeCustomers(
        [
          line({ CustomerKey: 3, move_id: 1, due_date: '2026-06-01', residual: 0 }),
          line({ CustomerKey: 3, move_id: 2, due_date: '2026-10-10', residual: 300 }),
          line({ CustomerKey: 3, move_id: 2, due_date: '2026-10-10', residual: -50 }),
        ],
        '2026-10-20',
        false,
      ).values(),
    ][0];
    expect(c.oldestInvoiceMoveId).toBe(2);
    expect(c.daysPastDue).toBe(10);
    expect(c.totalOutstanding).toBe(250);
  });

  it('due date: the unpaid instalment, else invoice_date_due, else invoice date + term', () => {
    expect(invoiceDueDate({ openDue: '2026-08-14', invoiceDue: '2026-10-13', invoiceDate: '2026-04-16', termDays: 30 })).toEqual({ date: '2026-08-14', source: 'instalment' });
    expect(invoiceDueDate({ openDue: null, invoiceDue: '2026-10-13', invoiceDate: '2026-04-16', termDays: 30 })).toEqual({ date: '2026-10-13', source: 'invoice' });
    expect(invoiceDueDate({ openDue: null, invoiceDue: null, invoiceDate: '2026-09-01', termDays: 30 })).toEqual({ date: '2026-10-01', source: 'payment_term' });
  });

  it('all currencies: one dot per customer over every currency, amounts in LYD', () => {
    const lines = [
      line({ CustomerKey: 5, move_id: 1, currency: 'LYD', due_date: '2026-10-01', residual: 1000 }),
      { ...line({ CustomerKey: 5, move_id: 2, currency: 'USD', due_date: '2026-07-01', residual: 100 }), residual_company_ccy: 900 },
    ];
    expect(placeCustomers(lines, '2026-10-20', false).size).toBe(2);
    const all = [...placeCustomers(lines, '2026-10-20', true).values()];
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ totalOutstanding: 1900, oldestDueDate: '2026-07-01', zone: 'BLOCK' });
  });

  it('calendar days', () => {
    expect(daysBetween('2026-09-01', '2026-10-20')).toBe(49);
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
  });
});

describe('the chart dataset', () => {
  const lines = [
    line({ CustomerKey: 1, move_id: 1, due_date: '2026-10-25', residual: 100 }), // not yet due
    line({ CustomerKey: 2, move_id: 2, due_date: '2026-10-10', residual: 200 }), // 10 days, GREEN
    line({ CustomerKey: 3, move_id: 3, due_date: '2026-09-01', residual: 300, PaymentTermKey: 9, payment_term: '60 Days' }), // 49, BLOCK
    line({ CustomerKey: 4, move_id: 4, due_date: '2025-08-27', residual: 400 }), // 419, BLOCK
  ];
  const view = (term: string | null = null) => buildCreditPolicy(lines, { snapshotDate: '2026-10-20', currency: 'LYD', allCurrencies: false, term });

  it('four zone summaries include only due customers and combine all BLOCK actions', () => {
    const v = view();
    const zones = Object.fromEntries(v.summary.zones.map((z) => [z.key, [z.customers, z.amount]]));
    expect(zones).toMatchObject({ GREEN: [1, 200], YELLOW: [0, 0], RED: [0, 0], BLOCK: [2, 700] });
    expect(v.summary).not.toHaveProperty('notYetDue');
    expect(v.customers.every((c) => c.daysPastDue >= 0 && !c.notYetDue)).toBe(true);
    expect(v.summary.zones.reduce((t, z) => t + z.amount, 0)).toBe(900);
    expect(v.summary.total).toEqual({ customers: 3, amount: 900 });
    expect(v.customers.map((c) => c.daysPastDue)).toEqual([419, 49, 10]); // most past due first, future-due excluded
  });

  it('the payment-term filter only chooses customers: zones and boundaries never move', () => {
    const v = view('9');
    expect(v.customers.map((c) => [c.customerKey, c.zone, c.daysPastDue])).toEqual([[3, 'BLOCK', 49]]);
    expect(v.zones).toBe(CREDIT_POLICY_ZONES);
    expect(v.terms.map((t) => [t.key, t.customers])).toEqual([['4', 2], ['9', 1]]);
  });

  it('carries every customer-level field the chart needs', () => {
    const c = view().customers[0];
    for (const k of ['customerKey', 'customerCode', 'customer', 'paymentTerm', 'totalOutstanding', 'unpaidInvoiceCount', 'oldestInvoiceNumber',
      'oldestInvoiceDate', 'oldestDueDate', 'daysPastDue', 'zone', 'responsibleRole', 'requiredAction']) {
      expect(c, k).toHaveProperty(k);
    }
  });

  it('parses the query: term is a payment term key', () => {
    expect(parseAgingQuery({ term: '4' }).term).toBe('4');
    expect(() => parseAgingQuery({ term: 'due_date' })).toThrow();
  });
});


describe('status, owner and action at every policy edge', () => {
  it.each([
    [0, 'GREEN', 'Sales Manager', 'Payment Reminder'],
    [15, 'GREEN', 'Sales Manager', 'Payment Reminder'],
    [16, 'YELLOW', 'Sales Director', 'Follow-up / Customer Visit'],
    [30, 'YELLOW', 'Sales Director', 'Follow-up / Customer Visit'],
    [31, 'RED', 'CEO', 'CEO Intervention'],
    [44, 'RED', 'CEO', 'CEO Intervention'],
    [45, 'BLOCK', 'GCEO + CFO', 'Management Escalation'],
    [60, 'BLOCK', 'GCEO + CFO', 'Management Escalation'],
    [61, 'BLOCK', 'GCEO + CFO', 'Final Warning + Stop Supply'],
    [65, 'BLOCK', 'GCEO + CFO', 'Final Warning + Stop Supply'],
    [66, 'BLOCK', 'GCEO + CFO', 'Legal Action'],
    [156, 'BLOCK', 'GCEO + CFO', 'Legal Action'],
  ])('%i days -> %s / %s / %s', (days, zone, owner, action) => {
    const c = [...placeCustomers([line({ CustomerKey: 1, move_id: 1, due_date: '2026-01-01', residual: 100 })],
      new Date(Date.UTC(2026, 0, 1 + Number(days))).toISOString().slice(0, 10), false).values()][0];
    expect(c).toMatchObject({ zone, responsibleRole: owner, requiredAction: action });
  });

  it('supplies the additional BLOCK instructions', () => {
    expect(creditActionForDays(63)?.details).toContain('registered mail');
    expect(creditActionForDays(156)?.details).toContain('consultation with GCEO');
  });

  it('keeps LYD summaries while preserving the currency-based dot amounts', () => {
    const v = buildCreditPolicy([{ ...line({ CustomerKey: 1, move_id: 1, currency: 'USD', due_date: '2026-01-01', residual: 100 }), residual_company_ccy: 650 }],
      { snapshotDate: '2026-10-15', currency: 'USD', allCurrencies: false, term: null });
    expect(v.customers[0].totalOutstanding).toBe(100);
    expect(v.summary.zones.find((z) => z.key === 'BLOCK')).toMatchObject({ customers: 1, amount: 100, amountCompany: 650 });
  });
});
