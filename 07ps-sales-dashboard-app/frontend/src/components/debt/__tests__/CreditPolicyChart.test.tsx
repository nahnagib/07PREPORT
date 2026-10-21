import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CreditPolicyChart } from '../CreditPolicyChart';
import type { CreditCustomer, DebtAging } from '../../../lib/api';
import { ZONES } from '../../../lib/__tests__/fixtures/creditZones';
import { formatDate, formatMoney } from '../../../lib/format';

function customer(p: Partial<CreditCustomer> & { customerKey: number; zone: CreditCustomer['zone']; daysOverdue: number; totalOutstanding: number }): CreditCustomer {
  return {
    customerCode: `C${p.customerKey}`, customer: `Customer ${p.customerKey}`, companyKey: 1, company: 'Majaal', paymentTermKey: 4, paymentTerm: '30 Days',
    totalOutstandingCompany: p.totalOutstanding, unpaidInvoiceCount: 2,
    overdueAmount: p.totalOutstanding, overdueAmountCompany: p.overdueAmount ?? p.totalOutstanding, overdueInvoiceCount: 2, oldestInvoiceMoveId: 10, oldestInvoiceNumber: 'INV/2026/0001',
    oldestInvoiceDate: '2026-08-01', oldestDueDate: '2026-08-31', oldestOverdueDate: '2026-09-01', dueDateSource: 'instalment', notYetDue: p.zone === 'NOT_YET_DUE', daysUntilDue: 0,
    responsibleRole: 'GCEO + CFO', requiredAction: 'Management Escalation', nextZone: null, daysToNextZone: null, approachingNextZone: false,
    odooUrl: 'https://x/web#id=10', ...p,
  };
}

const data: DebtAging = {
  snapshotDate: '2026-10-20', asOf: '2026-10-20', currency: 'LYD', allCurrencies: true, currencies: ['LYD', 'USD'], zones: ZONES, escalationWindowDays: 7,
  terms: [{ key: '4', label: '30 Days', customers: 3 }],
  summary: {
    zones: ZONES.map((z) => ({ key: z.key, customers: z.key === 'BLOCK' ? 2 : z.key === 'GREEN' ? 1 : 0,
      amount: z.key === 'BLOCK' ? 700 : z.key === 'GREEN' ? 200 : 0, amountCompany: z.key === 'BLOCK' ? 700 : z.key === 'GREEN' ? 200 : 0 })),
    total: { customers: 3, amount: 900 },
  },
  customers: [
    customer({ customerKey: 4, zone: 'BLOCK', daysOverdue: 419, totalOutstanding: 400, responsibleRole: 'GCEO + CFO', requiredAction: 'Legal Action' }),
    customer({ customerKey: 3, zone: 'BLOCK', daysOverdue: 49, totalOutstanding: 300 }),
    customer({ customerKey: 2, zone: 'GREEN', daysOverdue: 10, totalOutstanding: 200, approachingNextZone: true, nextZone: 'YELLOW', daysToNextZone: 6 }),
    customer({ customerKey: 1, zone: 'NOT_YET_DUE', daysOverdue: -6, daysUntilDue: 5, totalOutstanding: 100 }),
  ],
};

afterEach(cleanup);

describe('CreditPolicyChart', () => {
  const props = { data, loading: false, error: null, onRetry: () => undefined, term: null, onTermChange: () => undefined, viewLabel: 'All currencies (≈ LYD)' };

  it('title follows the currency view; zone headers show range, owner, action and live counts', () => {
    render(<CreditPolicyChart {...props} onCustomerClick={() => undefined} />);
    expect(screen.getByText('Credit Policy Escalation · All currencies (≈ LYD)')).toBeTruthy();
    for (const t of ['GREEN', 'YELLOW', 'RED', 'BLOCK', '0 – 15 Days', '16 – 30 Days', '31 – 44 Days', '45+ Days', '45 – 60 Days', '61 – 65 Days', '>65 Days', 'Final Warning + Stop Supply', 'GCEO + CFO']) {
      expect(screen.getAllByText(t).length, t).toBeGreaterThan(0);
    }
    expect(document.querySelector('svg')?.textContent ?? document.body.textContent).toBeDefined();
    expect(document.body.textContent).toContain('Overdue date');
    expect(document.body.textContent).not.toContain('Due Date');
    expect(document.body.textContent).toContain('(Day 0)');
    expect(document.body.textContent).toContain('placed by the number of days overdue of its oldest unpaid invoice (counted from the overdue date = day');
    expect(screen.getAllByText('>65 Days')).toHaveLength(2);
    expect(screen.getByText('PAYMENT TERM (FILTER)')).toBeTruthy();
    // Counts combine BLOCK ranges; future-due customers have no visible content.
    expect(document.body.textContent).toContain('≈ LYD 700');
    expect(document.body.textContent?.toLowerCase()).not.toContain('not yet due');
    expect(document.querySelectorAll('[data-status]')).toHaveLength(4);
    expect(document.querySelectorAll('[data-zone=BLOCK]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-block-action]')).toHaveLength(3);
    for (const day of [0, 15, 30, 45, 60, 65]) expect(document.querySelector(`[data-boundary="${day}"]`)).toBeTruthy();
    for (const day of [60, 65]) expect(document.querySelector(`[data-boundary="${day}"]`)?.getAttribute('data-internal')).toBe('true');
    expect(document.querySelectorAll('[data-customer]')).toHaveLength(3);
  });

  it('a dot within 7 days of the next zone has a dashed ring; LEGAL never', () => {
    render(<CreditPolicyChart {...props} onCustomerClick={() => undefined} />);
    const ringed = (key: number) => document.querySelector(`[data-customer="${key}"] circle[stroke-dasharray]`) !== null;
    expect(ringed(2)).toBe(true);
    expect(ringed(3)).toBe(false);
    expect(ringed(4)).toBe(false);
    expect(document.querySelector('[data-customer="2"]')?.getAttribute('aria-label')).toContain('Moves to YELLOW (Sales Director) in 6 days if unpaid.');
  });

  it('hover shows the details; a click opens the customer', () => {
    const onClick = vi.fn();
    render(<CreditPolicyChart {...props} onCustomerClick={onClick} />);
    const dot = document.querySelector('[data-customer="3"]') as Element;
    fireEvent.pointerEnter(dot);
    const tip = screen.getByRole('tooltip');
    for (const t of ['Customer 3', 'Code C3', 'INV/2026/0001', '49', '30 Days', 'Management Escalation', '2']) expect(tip.textContent, t).toContain(t);
    // both dates, and the count labelled days overdue
    const terms = [...tip.querySelectorAll('dt')].map((dt) => dt.textContent);
    for (const t of ['Due date', 'Overdue date', 'Days overdue']) expect(terms, t).toContain(t);
    expect(terms).not.toContain('Days past due');
    expect(tip.textContent).toContain(formatDate('2026-09-01'));
    expect(dot.getAttribute('aria-label')).toContain('49 days overdue');
    fireEvent.click(dot);
    expect(onClick).toHaveBeenCalledWith(expect.objectContaining({ customerKey: 3 }));
    fireEvent.keyDown(dot, { key: 'Enter' });
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('tooltip: overdue amount and overdue invoices; the total open balance only as a muted reference', () => {
    // one overdue invoice (100) + one not-yet-due invoice (400)
    const mixed = customer({ customerKey: 7, zone: 'GREEN', daysOverdue: 5, totalOutstanding: 500, overdueAmount: 100, overdueAmountCompany: 100,
      unpaidInvoiceCount: 2, overdueInvoiceCount: 1 });
    const one: DebtAging = { ...data, customers: [mixed],
      summary: { zones: ZONES.map((z) => ({ key: z.key, customers: z.key === 'GREEN' ? 1 : 0, amount: z.key === 'GREEN' ? 100 : 0, amountCompany: z.key === 'GREEN' ? 100 : 0 })),
        total: { customers: 1, amount: 100 } } };
    render(<CreditPolicyChart {...props} data={one} onCustomerClick={() => undefined} />);
    fireEvent.pointerEnter(document.querySelector('[data-customer="7"]') as Element);
    const rows = Object.fromEntries([...screen.getByRole('tooltip').querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling as HTMLElement]));
    expect(rows['Overdue amount LYD'].textContent).toBe(formatMoney('LYD', 100));
    expect(rows['Overdue amount LYD'].querySelector('strong')).toBeTruthy();
    expect(rows['Overdue invoices'].textContent).toBe('1');
    expect(rows['Total open balance LYD'].textContent).toBe(formatMoney('LYD', 500));
    expect(rows['Total open balance LYD'].style.color).toBe('var(--ps-color-muted-text)');
    expect(rows).not.toHaveProperty('Total Outstanding LYD');
    expect(rows).not.toHaveProperty('Unpaid invoices');
    expect(document.querySelector('[data-customer="7"]')?.getAttribute('aria-label')).toContain(`${formatMoney('LYD', 100)} overdue`);
  });

  it('foreign currency view: overdue in the invoice currency too', () => {
    const usd = customer({ customerKey: 8, zone: 'BLOCK', daysOverdue: 50, totalOutstanding: 500, overdueAmount: 100, totalOutstandingCompany: 3000, overdueAmountCompany: 600 });
    render(<CreditPolicyChart {...props} data={{ ...data, allCurrencies: false, currency: 'USD', customers: [usd] }} onCustomerClick={() => undefined} />);
    fireEvent.pointerEnter(document.querySelector('[data-customer="8"]') as Element);
    const rows = Object.fromEntries([...screen.getByRole('tooltip').querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]));
    expect(rows['Overdue amount LYD']).toBe(formatMoney('LYD', 600));
    expect(rows['Overdue, invoice currency']).toBe(formatMoney('USD', 100));
    expect(rows['Total open balance LYD']).toBe(formatMoney('LYD', 3000));
    expect(rows['Total open, invoice currency']).toBe(formatMoney('USD', 500));
  });

  it('dot size follows the overdue amount, not the total open balance', () => {
    const big = customer({ customerKey: 20, zone: 'BLOCK', daysOverdue: 50, totalOutstanding: 100, overdueAmount: 100 });
    const smallOverdue = customer({ customerKey: 21, zone: 'BLOCK', daysOverdue: 55, totalOutstanding: 100000, overdueAmount: 1 });
    render(<CreditPolicyChart {...props} data={{ ...data, customers: [big, smallOverdue] }} onCustomerClick={() => undefined} />);
    const r = (k: number) => Number(document.querySelector(`[data-customer="${k}"] circle:not([stroke-dasharray])`)!.getAttribute('r'));
    expect(r(20)).toBeGreaterThan(r(21));
  });

  it('all BLOCK dots are black with a light outline, including >65 days', () => {
    render(<CreditPolicyChart {...props} onCustomerClick={() => undefined} />);
    for (const id of [3, 4]) {
      const dot = document.querySelector(`[data-customer="${id}"] circle`)!;
      expect(dot.getAttribute('fill')).toBe('var(--ps-credit-block)');
      expect(dot.getAttribute('stroke')).toBe('#f3f4f6');
    }
  });

  it('shows an empty state when only future-due customers are returned', () => {
    render(<CreditPolicyChart {...props} data={{ ...data, customers: data.customers.filter((c) => c.notYetDue) }} onCustomerClick={() => undefined} />);
    expect(screen.getByText('No customer is due or overdue with these filters.')).toBeTruthy();
    expect(document.querySelectorAll('[data-customer]')).toHaveLength(0);
  });

  it('edge cases in days overdue: due today is not drawn; due yesterday = day 0 in GREEN; 15/16/44/45/65/66 land in their zone', () => {
    const cases: [number, number, CreditCustomer['zone']][] = [
      [10, 0, 'GREEN'], [11, 15, 'GREEN'], [12, 16, 'YELLOW'], [13, 44, 'RED'], [14, 45, 'BLOCK'], [15, 65, 'BLOCK'], [16, 66, 'BLOCK'],
    ];
    const dueToday = customer({ customerKey: 99, zone: 'NOT_YET_DUE', daysOverdue: -1, daysUntilDue: 0, totalOutstanding: 100 });
    const edge = { ...data, customers: [...cases.map(([customerKey, daysOverdue, zone]) => customer({ customerKey, zone, daysOverdue, totalOutstanding: 100 })), dueToday] };
    render(<CreditPolicyChart {...props} data={edge} onCustomerClick={() => undefined} />);
    expect(document.querySelector('[data-customer="99"]')).toBeNull();
    expect(document.querySelectorAll('[data-customer]')).toHaveLength(cases.length);
    for (const [key, days, zone] of cases) {
      const g = document.querySelector(`[data-customer="${key}"]`)!;
      expect(g.getAttribute('aria-label'), `${days}`).toContain(`${days} day${days === 1 ? '' : 's'} overdue · ${zone}`);
      const band = document.querySelector(`[data-zone="${zone}"]`)!;
      const x0 = Number(band.getAttribute('x'));
      const cx = Number(g.querySelector('circle:not([stroke-dasharray])')!.getAttribute('cx'));
      expect(cx, `${days} days in ${zone}`).toBeGreaterThanOrEqual(x0);
      expect(cx, `${days} days in ${zone}`).toBeLessThanOrEqual(x0 + Number(band.getAttribute('width')));
    }
  });

  it('the legend', () => {
    render(<CreditPolicyChart {...props} onCustomerClick={() => undefined} />);
    for (const t of ['Dot size = overdue amount', 'Position = days overdue of the oldest unpaid invoice (from overdue date)', 'Each customer appears once']) {
      expect(screen.getByText(t)).toBeTruthy();
    }
  });
});
