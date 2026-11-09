import { describe, expect, it } from 'vitest';
import { allocateCredits, allocationKey, type AllocatableLine } from '../creditAllocation';
import { buildCreditPolicy, lineDueDate, placeCustomers, type CreditLine } from '../debtAging';

/** Unapplied credits netted FIFO against open invoices (2026-11-09), and what it does to the Credit Policy chart. */

let lineId = 0;
type L = AllocatableLine & { due: string | null };
function l(p: Partial<L> & { move_id: number; residual: number; kind?: string }): L {
  lineId += 1;
  const { residual, kind, ...rest } = p;
  return {
    line_id: lineId, CustomerKey: 1, CompanyKey: 1, currency: 'LYD', line_kind: kind ?? 'invoice', invoice_date: '2026-08-01', due: null,
    residual_doc_ccy: residual, residual_company_ccy: residual, ...rest,
  };
}
const alloc = (ls: L[], allCurrencies = false) => allocateCredits(ls, { allCurrencies, dueDateOf: (x) => x.due });

describe('allocateCredits', () => {
  it('credits of both kinds go FIFO by due date; a partly covered line keeps its remainder', () => {
    const g = alloc([
      l({ move_id: 2, residual: 300, due: '2026-09-10' }),
      l({ move_id: 1, residual: 100, due: '2026-09-01' }),
      l({ move_id: 9, residual: -150, kind: 'credit_note' }),
      l({ move_id: 8, residual: -20, kind: 'payment' }),
    ]).get(allocationKey(1, 1, 'LYD'))!;
    expect(g.credits).toBe(170);
    expect(g.applied).toBe(170);
    expect(g.leftover).toBe(0);
    expect(g.net).toBe(230);
    expect(g.invoices.map((x) => [x.line.move_id, x.remaining])).toEqual([[1, 0], [2, 230]]);
  });

  it('ties: older invoice date, then lower move id; no due date goes last', () => {
    const g = alloc([
      l({ move_id: 5, residual: 10, due: null, invoice_date: '2026-01-01' }),
      l({ move_id: 4, residual: 10, due: '2026-09-01', invoice_date: '2026-08-02' }),
      l({ move_id: 3, residual: 10, due: '2026-09-01', invoice_date: '2026-08-02' }),
      l({ move_id: 6, residual: 10, due: '2026-09-01', invoice_date: '2026-07-01' }),
      l({ move_id: 9, residual: -35, kind: 'credit_note' }),
    ]).get(allocationKey(1, 1, 'LYD'))!;
    expect(g.invoices.map((x) => [x.line.move_id, x.remaining])).toEqual([[6, 0], [3, 0], [4, 0], [5, 5]]);
  });

  it('credit larger than every invoice: all covered, the rest is a net credit balance', () => {
    const g = alloc([l({ move_id: 1, residual: 100, due: '2026-09-01' }), l({ move_id: 9, residual: -250, kind: 'credit_note' })]).get(allocationKey(1, 1, 'LYD'))!;
    expect(g.invoices[0].remaining).toBe(0);
    expect(g.leftover).toBe(150);
    expect(g.net).toBe(-150);
  });

  it('per customer AND per company: a credit of another company is not applied', () => {
    const m = alloc([l({ move_id: 1, residual: 100, due: '2026-09-01' }), l({ move_id: 9, CompanyKey: 2, residual: -100, kind: 'credit_note' })]);
    expect(m.get(allocationKey(1, 1, 'LYD'))!.invoices[0].remaining).toBe(100);
    expect(m.get(allocationKey(1, 2, 'LYD'))!.leftover).toBe(100);
  });

  it('a USD credit vs LYD invoices: per currency no netting; all currencies nets in LYD', () => {
    const ls = [
      l({ move_id: 1, residual: 700, due: '2026-09-01' }),
      { ...l({ move_id: 9, currency: 'USD', residual: -100, kind: 'credit_note' }), residual_company_ccy: -650 },
    ];
    expect(alloc(ls).get(allocationKey(1, 1, 'LYD'))!.invoices[0].remaining).toBe(700);
    expect(alloc(ls).get(allocationKey(1, 1, 'USD'))!.leftover).toBe(100);
    expect(alloc(ls, true).get(allocationKey(1, 1, null))!.invoices[0].remaining).toBe(50);
  });

  it('a positive credit-kind line lowers the pool; other kinds are ignored', () => {
    const g = alloc([
      l({ move_id: 1, residual: 100, due: '2026-09-01' }),
      l({ move_id: 9, residual: -80, kind: 'payment' }),
      l({ move_id: 8, residual: 30, kind: 'payment' }),
      l({ move_id: 7, residual: -500, kind: 'intercompany' }),
    ]).get(allocationKey(1, 1, 'LYD'))!;
    expect(g.applied).toBe(50);
    expect(g.invoices[0].remaining).toBe(50);
  });

  it('the other currency is scaled by the share left', () => {
    const g = alloc([
      { ...l({ move_id: 1, currency: 'USD', residual: 100, due: '2026-09-01' }), residual_company_ccy: 650 },
      { ...l({ move_id: 9, currency: 'USD', residual: -40, kind: 'credit_note' }), residual_company_ccy: -260 },
    ]);
    expect(g.get(allocationKey(1, 1, 'USD'))!.invoices[0]).toMatchObject({ remaining: 60, remainingDoc: 60, remainingCompany: 390 });
  });
});

// ---- the chart ------------------------------------------------------------------------------------------------------
function cl(p: Partial<CreditLine> & { CustomerKey: number; move_id: number; due_date: string | null; residual: number }): CreditLine {
  lineId += 1;
  const { residual, ...rest } = p;
  return {
    currency: 'LYD', customer: `Customer ${p.CustomerKey}`, customer_ref: null, CompanyKey: 1, company: 'Majaal', PaymentTermKey: 1,
    payment_term: 'Immediate Payment', term_days: 0, line_kind: 'invoice', line_id: lineId, document: `INV/${p.move_id}`, invoice_date: '2026-10-06',
    invoice_due_date: p.due_date, residual_doc_ccy: residual, residual_company_ccy: residual, ...rest,
  } as CreditLine;
}
const asOf = '2026-11-08';
const chart = (ls: CreditLine[], allCurrencies = false, currency: string | null = null) =>
  buildCreditPolicy(ls, { snapshotDate: asOf, currency, allCurrencies, term: null });

describe('Credit Policy chart nets unapplied credits', () => {
  it('customer 27775 (9 Nov 2026): INV 1,045.000 vs two open credit notes = net 0 -> not on the chart', () => {
    const ls = [
      cl({ CustomerKey: 27775, customer_ref: '27775', move_id: 118, document: 'INV/2026/10/00118', due_date: '2026-10-06', residual: 1045 }),
      cl({ CustomerKey: 27775, move_id: 6, document: 'RINV/2026/10/0006', line_kind: 'credit_note', due_date: '2026-10-06', residual: -416.44 }),
      cl({ CustomerKey: 27775, move_id: 7, document: 'RINV/2026/10/0007', line_kind: 'credit_note', due_date: '2026-10-06', residual: -628.56 }),
    ];
    for (const all of [false, true]) {
      const v = chart(ls, all);
      expect(v.customers).toEqual([]);
      expect(v.summary.total).toEqual({ customers: 0, amount: 0 });
    }
    expect(placeCustomers(ls, asOf, false).size).toBe(0);
  });

  it('a credit covering part of the oldest invoice: same deciding invoice, less overdue; covering all of it: the next one decides', () => {
    const base = [
      cl({ CustomerKey: 2, move_id: 1, due_date: '2026-09-01', residual: 100 }),
      cl({ CustomerKey: 2, move_id: 2, due_date: '2026-10-01', residual: 200 }),
    ];
    const partly = chart([...base, cl({ CustomerKey: 2, move_id: 9, line_kind: 'credit_note', due_date: null, residual: -60 })]).customers[0];
    expect(partly).toMatchObject({ oldestInvoiceMoveId: 1, daysOverdue: 67, overdueAmount: 240, creditsApplied: 60, totalOutstanding: 240, overdueInvoiceCount: 2 });
    const covered = chart([...base, cl({ CustomerKey: 2, move_id: 9, line_kind: 'credit_note', due_date: null, residual: -130 })]).customers[0];
    expect(covered).toMatchObject({
      oldestInvoiceMoveId: 2, oldestDueDate: '2026-10-01', daysOverdue: 37, zone: 'RED', overdueAmount: 170, creditsApplied: 130,
      totalOutstanding: 170, overdueInvoiceCount: 1, unpaidInvoiceCount: 1,
    });
  });

  it('credit larger than every invoice: net credit, not shown', () => {
    const ls = [cl({ CustomerKey: 3, move_id: 1, due_date: '2026-09-01', residual: 100 }), cl({ CustomerKey: 3, move_id: 9, line_kind: 'credit_note', due_date: null, residual: -400 })];
    expect(chart(ls).customers).toEqual([]);
  });

  it('an unreconciled payment is a credit too', () => {
    const ls = [cl({ CustomerKey: 4, move_id: 1, due_date: '2026-09-01', residual: 100 }), cl({ CustomerKey: 4, move_id: 50, line_kind: 'payment', due_date: '2026-11-01', residual: -100 })];
    expect(chart(ls).customers).toEqual([]);
  });

  it('a USD credit vs a LYD invoice: per currency (LYD) still overdue; all currencies nets in LYD', () => {
    const ls = [
      cl({ CustomerKey: 5, move_id: 1, due_date: '2026-09-01', residual: 1000 }),
      { ...cl({ CustomerKey: 5, move_id: 9, currency: 'USD', line_kind: 'credit_note', due_date: null, residual: -100 }), residual_company_ccy: -650 },
    ];
    expect(chart(ls, false, 'LYD').customers[0]).toMatchObject({ overdueAmount: 1000, creditsApplied: 0 });
    expect(chart(ls, false, 'USD').customers).toEqual([]);
    expect(chart(ls, true).customers[0]).toMatchObject({ overdueAmount: 350, creditsApplied: 650, totalOutstanding: 350 });
  });

  it('FIFO: the credit covers the overdue invoice first; the not-yet-due one keeps its amount (not on the chart)', () => {
    const ls = [
      cl({ CustomerKey: 6, move_id: 2, due_date: '2026-12-01', residual: 500 }),
      cl({ CustomerKey: 6, move_id: 1, due_date: '2026-09-01', residual: 100 }),
      cl({ CustomerKey: 6, move_id: 9, line_kind: 'credit_note', due_date: null, residual: -100 }),
    ];
    expect(chart(ls).customers).toEqual([]);
    const placed = [...placeCustomers(ls, asOf, false).values()][0];
    expect(placed).toMatchObject({ notYetDue: true, oldestInvoiceMoveId: 2, overdueAmount: 0, totalOutstanding: 500, creditsApplied: 100 });
  });

  it('the line due date for FIFO falls back to the invoice due date, then invoice date + term', () => {
    expect(lineDueDate({ due_date: null, invoice_due_date: '2026-09-15', invoice_date: '2026-09-01', term_days: 30 })).toBe('2026-09-15');
    expect(lineDueDate({ due_date: null, invoice_due_date: null, invoice_date: '2026-09-01', term_days: 30 })).toBe('2026-10-01');
  });
});
