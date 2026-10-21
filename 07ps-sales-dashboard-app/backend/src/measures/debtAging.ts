/**
 * "Credit Policy Escalation" (Receivables and Collections; GET /debt-report/aging, 2026-10-15): where every customer
 * stands in the credit policy. Replaces the term-multiple "Aging Map": no payment-term multiples any more -- a
 * customer is placed by DAYS OVERDUE (2026-10-20: counted from the overdue date, not the due date), in the zones of config/creditPolicy.ts (the one definition of the policy).
 *
 * Per customer (and per currency, or over every currency in LYD with `allCurrencies`):
 *   1. lines: the report's own source (linesSource) -- snapshot, report exclusions, scope toggles, the caller's
 *      scoped filters (role data scope, salesperson lock), customer search and customer category. The line-level page
 *      filters (overdue status, aging bucket, delivery status, payment term, invoice size) are NOT applied: they would
 *      change which invoice decides. Only customer invoices (line_kind 'invoice'), the base of the "Total debt" card,
 *      with future-due customers excluded from the chart.
 *   2. unpaid invoices: posted customer invoices whose open amount is above 0.
 *   3. each unpaid invoice's due date: the due date of its unpaid instalment (Odoo date_maturity of the open
 *      receivable line -- what Odoo's aged receivables uses; = invoice_date_due for a single-instalment invoice), else
 *      the invoice's invoice_date_due, else invoice date + the payment term's days (cfg_finance_payment_term_days).
 *      Never the invoice date alone, unless nothing else exists.
 *   4. the deciding invoice: the unpaid invoice with the EARLIEST due date (= the most days overdue); ties: the older
 *      invoice date, then the lower move id. It can differ from the invoice with the oldest invoice date.
 *   5. its overdue date = due date + OVERDUE_OFFSET_DAYS (1: the first day it is late); days overdue = as-of date -
 *      overdue date, in calendar days (as-of = the snapshot date, i.e. today for the latest snapshot). 0 = the first
 *      day overdue (due the day before); negative = "Not yet due", incl. due exactly on the as-of date (never GREEN).
 *   6. zone, owner and action: config/creditPolicy.ts. Dot size and zone totals = the customer's OVERDUE amount (2026-10-21):
 *      its lines whose own overdue date (line due_date, else the invoice's due date from step 3, + OVERDUE_OFFSET_DAYS) is on
 *      or before the as-of date, negative lines included. Total outstanding (every line) stays for reference.
 *
 * The same placement feeds the Customers table's "Aging bucket" (attachCreditZones), so a customer's bucket there is
 * the same policy status (not-yet-due customers are omitted from the chart). The payment-term filter only chooses which
 * customers are shown; it never moves a boundary.
 */
import type { Pool } from 'mysql2/promise';
import { odooWebBaseUrl } from '../config/finance';
import {
  CREDIT_POLICY_ZONES,
  ESCALATION_WINDOW_DAYS,
  NOT_YET_DUE,
  OVERDUE_OFFSET_DAYS,
  approachingNextZone,
  creditZoneForDays,
  creditActionForDays,
  nextCreditZone,
  type CreditPolicyZone,
  type CreditZoneKey,
} from '../config/creditPolicy';
import type { Filters } from './filters';
import { COMPANY_CURRENCY, DebtQueryError, isoOfKey, linesSource, parseDebtQuery, resolveSnapshot, withoutLineFilters, type DebtQuery } from './debtReport';

// ---- query ----------------------------------------------------------------------------------------------------------
export interface AgingQuery {
  debt: DebtQuery;
  /** 3-letter code; null = the currency with the most customers (unless allCurrencies) */
  currency: string | null;
  /** every currency together in LYD (one dot per customer); ignored when a currency is given */
  allCurrencies: boolean;
  /** PaymentTermKey of the deciding invoice (-1 = no payment term); null = every term. Filters customers only. */
  term: string | null;
}

export function parseAgingQuery(q: Record<string, unknown>): AgingQuery {
  const debt = parseDebtQuery(q);
  const currency = typeof q.currency === 'string' && q.currency.trim() ? q.currency.trim().toUpperCase() : null;
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) throw new DebtQueryError('currency must be a 3-letter code');
  const term = typeof q.term === 'string' && q.term.trim() ? q.term.trim() : null;
  if (term !== null && !/^-?\d+$/.test(term)) throw new DebtQueryError('term must be a payment term key');
  return {
    debt: withoutLineFilters(debt),
    currency,
    allCurrencies: currency === null && (q.allCurrencies === 'true' || q.allCurrencies === '1' || q.allCurrencies === true),
    term,
  };
}

/** One customer-invoice line with what the placement needs (fetchCreditLines; literal rows in the tests). */
export interface CreditLine {
  currency: string;
  CustomerKey: number;
  customer: string;
  customer_ref?: string | null;
  CompanyKey: number;
  company: string;
  PaymentTermKey: number;
  payment_term: string | null;
  term_days?: number | null;
  move_id: number;
  line_id: number;
  document: string | null;
  /** YYYY-MM-DD */
  invoice_date: string | null;
  /** the line's own due date (Odoo date_maturity), YYYY-MM-DD */
  due_date: string | null;
  /** the invoice's invoice_date_due, YYYY-MM-DD */
  invoice_due_date?: string | null;
  residual_doc_ccy: number;
  residual_company_ccy: number;
}

/** The customer-invoice lines of one snapshot, line-level page filters cleared. */
export async function fetchCreditLines(pool: Pool, snapshotKey: number, debt: DebtQuery, f: Filters): Promise<CreditLine[]> {
  const s = linesSource(snapshotKey, withoutLineFilters(debt), f);
  const [rows] = await pool.query(
    `SELECT x.currency, x.CustomerKey, x.customer, cu.ref AS customer_ref, x.CompanyKey, x.company, x.PaymentTermKey, x.payment_term,
            td.term_days, x.move_id, x.line_id, x.document, x.invoice_date, x.due_date,
            DATE_FORMAT(i.invoice_final_due_date, '%Y-%m-%d') AS invoice_due_date, x.residual_doc_ccy, x.residual_company_ccy
     FROM (SELECT l.* ${s.sql}) x
     JOIN dim_finance_invoice i ON i.move_id = x.move_id
     JOIN dim_customer cu ON cu.CustomerKey = x.CustomerKey
     LEFT JOIN cfg_finance_payment_term_days td ON td.PaymentTermKey = x.PaymentTermKey
     WHERE x.line_kind = 'invoice'`,
    s.params,
  );
  return rows as CreditLine[];
}

// ---- dates (pure) -----------------------------------------------------------------------------------------------------
const DAY_MS = 86_400_000;
const isoDay = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
/** Whole calendar days from `a` to `b` (ISO dates). */
export const daysBetween = (a: string, b: string): number => Math.round((isoDay(b) - isoDay(a)) / DAY_MS);
export const addDays = (iso: string, days: number): string => new Date(isoDay(iso) + days * DAY_MS).toISOString().slice(0, 10);

/** Money adds up in millionths (the DECIMAL(20,6) scale) so the sums are exact. */
const micro = (v: unknown): number => Math.round(Number(v ?? 0) * 1e6);
const fromMicro = (v: number): number => v / 1e6;

// ---- placement (pure) --------------------------------------------------------------------------------------------------
export type DueDateSource = 'instalment' | 'invoice' | 'payment_term' | 'invoice_date';

export interface CreditCustomer {
  customerKey: number;
  /** Odoo partner reference, else the Odoo id */
  customerCode: string;
  customer: string;
  /** company of the deciding invoice */
  companyKey: number;
  company: string;
  /** payment term of the deciding invoice */
  paymentTermKey: number;
  paymentTerm: string;
  /** every invoice line of the customer (the tooltip's "Total open balance"), in the view's currency (LYD for all currencies) */
  totalOutstanding: number;
  /** the same in LYD (Odoo's own amount_residual) */
  totalOutstandingCompany: number;
  unpaidInvoiceCount: number;
  /** the lines overdue on the as-of date (line overdue date <= as-of; negative lines included): the dot's size and the
   * zone totals, in the view's currency */
  overdueAmount: number;
  /** the same in LYD */
  overdueAmountCompany: number;
  /** unpaid invoices with at least one open overdue line */
  overdueInvoiceCount: number;
  oldestInvoiceMoveId: number;
  oldestInvoiceNumber: string | null;
  oldestInvoiceDate: string | null;
  oldestDueDate: string;
  dueDateSource: DueDateSource;
  /** oldestDueDate + OVERDUE_OFFSET_DAYS: day 0 of the policy (the first day the invoice is late) */
  oldestOverdueDate: string;
  /** as-of date - oldestOverdueDate; negative (= not yet due) customers are excluded from the chart */
  daysOverdue: number;
  notYetDue: boolean;
  /** days until the earliest due date when not yet due (0 = due on the as-of date), else 0 */
  daysUntilDue: number;
  zone: CreditZoneKey;
  responsibleRole: string;
  requiredAction: string;
  actionDetails?: string;
  nextZone: CreditPolicyZone['key'] | null;
  daysToNextZone: number | null;
  approachingNextZone: boolean;
  odooUrl: string;
}

interface InvoiceAcc {
  moveId: number;
  residual: number;
  openDue: string | null;
  invoiceDue: string | null;
  invoiceDate: string | null;
  document: string | null;
  termDays: number | null;
  companyKey: number;
  company: string;
  paymentTermKey: number;
  paymentTerm: string | null;
}

/** An unpaid invoice's due date and where it came from (module doc, step 3). */
export function invoiceDueDate(inv: Pick<InvoiceAcc, 'openDue' | 'invoiceDue' | 'invoiceDate' | 'termDays'>): { date: string; source: DueDateSource } | null {
  if (inv.openDue) return { date: inv.openDue, source: 'instalment' };
  if (inv.invoiceDue) return { date: inv.invoiceDue, source: 'invoice' };
  if (inv.invoiceDate && inv.termDays !== null) return { date: addDays(inv.invoiceDate, inv.termDays), source: 'payment_term' };
  if (inv.invoiceDate) return { date: inv.invoiceDate, source: 'invoice_date' };
  return null;
}

export type PlacedCustomer = CreditCustomer & { currency: string };

/**
 * Every customer's placement, one entry per group: per customer + currency (amounts in the invoice currency), or with
 * `allCurrencies` per customer over every currency (amounts in LYD). Customers without an unpaid invoice are left out.
 * Map key: "<CustomerKey>|<currency>" or "<CustomerKey>|*".
 */
export function placeCustomers(lines: CreditLine[], asOf: string, allCurrencies: boolean): Map<string, PlacedCustomer> {
  const groups = new Map<string, { currency: string; lines: CreditLine[] }>();
  for (const l of lines) {
    const key = `${l.CustomerKey}|${allCurrencies ? '*' : l.currency}`;
    const g = groups.get(key) ?? { currency: allCurrencies ? COMPANY_CURRENCY : String(l.currency), lines: [] };
    g.lines.push(l);
    groups.set(key, g);
  }
  const base = odooWebBaseUrl();
  const out = new Map<string, PlacedCustomer>();
  for (const [key, g] of groups) {
    let total = 0;
    let totalCompany = 0;
    const invoices = new Map<number, InvoiceAcc>();
    for (const l of g.lines) {
      const amount = micro(allCurrencies ? l.residual_company_ccy : l.residual_doc_ccy);
      total += amount;
      totalCompany += micro(l.residual_company_ccy);
      const inv = invoices.get(Number(l.move_id)) ?? {
        moveId: Number(l.move_id), residual: 0, openDue: null, invoiceDue: l.invoice_due_date ?? null, invoiceDate: l.invoice_date ?? null,
        document: l.document ?? null, termDays: l.term_days === null || l.term_days === undefined ? null : Number(l.term_days),
        companyKey: Number(l.CompanyKey), company: String(l.company), paymentTermKey: Number(l.PaymentTermKey), paymentTerm: l.payment_term ?? null,
      };
      inv.residual += amount;
      // the unpaid instalment's own due date: the earliest among the invoice's lines still open
      if (amount > 0 && l.due_date && (inv.openDue === null || l.due_date < inv.openDue)) inv.openDue = l.due_date;
      invoices.set(inv.moveId, inv);
    }
    // overdue part: lines whose own overdue date (line due_date, else the invoice's resolved due date, + the offset) is on
    // or before the as-of date; negative lines lower it like they lower the total. Second pass: the fallback needs the
    // whole invoice.
    let overdue = 0;
    let overdueCompany = 0;
    const overdueMoves = new Set<number>();
    for (const l of g.lines) {
      const inv = invoices.get(Number(l.move_id)) as InvoiceAcc;
      const lineDue = l.due_date ?? invoiceDueDate(inv)?.date ?? null;
      if (lineDue === null || addDays(lineDue, OVERDUE_OFFSET_DAYS) > asOf) continue;
      const amount = micro(allCurrencies ? l.residual_company_ccy : l.residual_doc_ccy);
      overdue += amount;
      overdueCompany += micro(l.residual_company_ccy);
      if (amount > 0 && inv.residual > 0) overdueMoves.add(inv.moveId);
    }
    const unpaid = [...invoices.values()]
      .filter((i) => i.residual > 0)
      .map((i) => ({ inv: i, due: invoiceDueDate(i) }))
      .filter((x): x is { inv: InvoiceAcc; due: { date: string; source: DueDateSource } } => x.due !== null);
    if (unpaid.length === 0) continue;
    // the deciding invoice: earliest due date, then the older invoice, then the lower move id
    unpaid.sort(
      (a, b) =>
        a.due.date.localeCompare(b.due.date) || (a.inv.invoiceDate ?? '').localeCompare(b.inv.invoiceDate ?? '') || a.inv.moveId - b.inv.moveId,
    );
    const { inv, due } = unpaid[0];
    const overdueDate = addDays(due.date, OVERDUE_OFFSET_DAYS);
    const days = daysBetween(overdueDate, asOf);
    const notYetDue = days < 0;
    const zone = notYetDue ? null : creditZoneForDays(days);
    const next = notYetDue ? null : nextCreditZone(days);
    const first = g.lines[0];
    out.set(key, {
      currency: g.currency,
      customerKey: Number(first.CustomerKey),
      customerCode: first.customer_ref ? String(first.customer_ref) : String(first.CustomerKey),
      customer: String(first.customer),
      companyKey: inv.companyKey,
      company: inv.company,
      paymentTermKey: inv.paymentTermKey,
      paymentTerm: inv.paymentTermKey === -1 || !inv.paymentTerm ? 'No payment term' : inv.paymentTerm,
      totalOutstanding: fromMicro(total),
      totalOutstandingCompany: fromMicro(totalCompany),
      unpaidInvoiceCount: unpaid.length,
      overdueAmount: fromMicro(overdue),
      overdueAmountCompany: fromMicro(overdueCompany),
      overdueInvoiceCount: overdueMoves.size,
      oldestInvoiceMoveId: inv.moveId,
      oldestInvoiceNumber: inv.document,
      oldestInvoiceDate: inv.invoiceDate,
      oldestDueDate: due.date,
      dueDateSource: due.source,
      oldestOverdueDate: overdueDate,
      daysOverdue: days,
      notYetDue,
      daysUntilDue: notYetDue ? daysBetween(asOf, due.date) : 0,
      zone: zone ? zone.key : NOT_YET_DUE.key,
      responsibleRole: zone ? zone.owner : '—',
      requiredAction: zone ? creditActionForDays(days)?.action ?? zone.action : 'None until the due date',
      actionDetails: creditActionForDays(days)?.details,
      nextZone: next ? next.zone.key : null,
      daysToNextZone: next ? next.inDays : null,
      approachingNextZone: !notYetDue && approachingNextZone(days),
      odooUrl: `${base}/web#id=${inv.moveId}&model=account.move&view_type=form`,
    });
  }
  return out;
}

// ---- response -----------------------------------------------------------------------------------------------------------
export interface CreditZoneSummary {
  key: CreditZoneKey;
  customers: number;
  /** the customers' overdue amounts (overdueAmount), in the view's currency */
  amount: number;
  /** The same overdue amount in LYD, for the policy zone headers. */
  amountCompany: number;
}

export interface CreditPolicyView {
  snapshotDate: string | null;
  /** the date days overdue are counted to (the snapshot date) */
  asOf: string | null;
  currency: string | null;
  /** true = every currency together, amounts in LYD (≈) */
  allCurrencies: boolean;
  /** currencies with at least one customer, most customers first */
  currencies: string[];
  /** config/creditPolicy.ts, as is: the page draws every zone from this */
  zones: readonly CreditPolicyZone[];
  escalationWindowDays: number;
  /** payment-term filter options (deciding invoice's term), before the term filter */
  terms: { key: string; label: string; customers: number }[];
  /** Four main zones, overdue customers only, after the term filter. */
  summary: { zones: CreditZoneSummary[]; total: { customers: number; amount: number } };
  /** Overdue customers after the term filter, most days overdue first. */
  customers: CreditCustomer[];
}

/** Turns the lines into the chart (pure: the tests feed it rows directly). */
export function buildCreditPolicy(
  lines: CreditLine[],
  opts: { snapshotDate: string | null; currency: string | null; allCurrencies: boolean; term: string | null },
): CreditPolicyView {
  const asOf = opts.snapshotDate;
  const perCurrency = new Map<string, number>();
  for (const k of new Set(lines.map((l) => `${l.CustomerKey}|${l.currency}`))) {
    const c = k.split('|')[1];
    perCurrency.set(c, (perCurrency.get(c) ?? 0) + 1);
  }
  const currencies = [...perCurrency].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c]) => c);
  const currency = opts.allCurrencies ? COMPANY_CURRENCY : (opts.currency ?? currencies[0] ?? null);
  const placed = asOf
    ? [...placeCustomers(opts.allCurrencies ? lines : lines.filter((l) => l.currency === currency), asOf, opts.allCurrencies).values()].filter((c) => !c.notYetDue)
    : [];

  const termMap = new Map<string, { key: string; label: string; customers: number }>();
  for (const c of placed) {
    const key = String(c.paymentTermKey);
    const t = termMap.get(key) ?? { key, label: c.paymentTerm, customers: 0 };
    t.customers += 1;
    termMap.set(key, t);
  }
  const terms = [...termMap.values()].sort((a, b) => Number(a.key === '-1') - Number(b.key === '-1') || a.label.localeCompare(b.label));

  const shown = (opts.term === null ? placed : placed.filter((c) => String(c.paymentTermKey) === opts.term)).sort(
    (a, b) =>
      Number(a.notYetDue) - Number(b.notYetDue) ||
      b.daysOverdue - a.daysOverdue ||
      a.daysUntilDue - b.daysUntilDue ||
      b.overdueAmount - a.overdueAmount ||
      a.customerKey - b.customerKey,
  );
  const sum = (key: CreditZoneKey): CreditZoneSummary => {
    const list = shown.filter((c) => c.zone === key);
    return { key, customers: list.length, amount: fromMicro(list.reduce((t, c) => t + micro(c.overdueAmount), 0)),
      amountCompany: fromMicro(list.reduce((t, c) => t + micro(c.overdueAmountCompany), 0)) };
  };

  return {
    snapshotDate: opts.snapshotDate,
    asOf,
    currency,
    allCurrencies: opts.allCurrencies,
    currencies,
    zones: CREDIT_POLICY_ZONES,
    escalationWindowDays: ESCALATION_WINDOW_DAYS,
    terms,
    summary: {
      zones: CREDIT_POLICY_ZONES.map((z) => sum(z.key)),
      total: { customers: shown.length, amount: fromMicro(shown.reduce((t, c) => t + micro(c.overdueAmount), 0)) },
    },
    customers: shown.map((c) => {
      const { currency: _currency, ...rest } = c;
      void _currency;
      return rest;
    }),
  };
}

/** GET /debt-report/aging. */
export async function fetchDebtAging(pool: Pool, q: AgingQuery, f: Filters): Promise<CreditPolicyView> {
  const snapshotKey = await resolveSnapshot(pool, q.debt);
  const lines = snapshotKey === null ? [] : await fetchCreditLines(pool, snapshotKey, q.debt, f);
  return buildCreditPolicy(lines, { snapshotDate: isoOfKey(snapshotKey), currency: q.currency, allCurrencies: q.allCurrencies, term: q.term });
}

// ---- Customers table: the same placement -----------------------------------------------------------------------------
/** A table row's credit-policy bucket. */
export interface RowCreditZone {
  zone: CreditZoneKey;
  daysOverdue: number;
  daysUntilDue: number;
}

/**
 * Adds `creditZone: { currency, all }` to every Customers-table row: its customer's zone in the row's currency, and
 * over every currency (the all-currencies view) -- from the same lines and placement as the chart (line-level page
 * filters cleared), so a customer's bucket in the table is always its zone on the chart. null when the customer has
 * no unpaid invoice (credits only).
 */
export async function attachCreditZones<T extends { customerKey: number; currency: string }>(
  pool: Pool,
  debt: DebtQuery,
  f: Filters,
  result: { snapshotDate: string | null; currencies: string[]; rows: T[] },
): Promise<{ snapshotDate: string | null; currencies: string[]; rows: (T & { creditZone: { currency: RowCreditZone | null; all: RowCreditZone | null } })[] }> {
  const snapshotKey = await resolveSnapshot(pool, debt);
  const asOf = result.snapshotDate;
  const lines = snapshotKey === null || !asOf ? [] : await fetchCreditLines(pool, snapshotKey, debt, f);
  const byCurrency = asOf ? placeCustomers(lines, asOf, false) : new Map<string, PlacedCustomer>();
  const byCustomer = asOf ? placeCustomers(lines, asOf, true) : new Map<string, PlacedCustomer>();
  const pick = (c: PlacedCustomer | undefined): RowCreditZone | null => (c ? { zone: c.zone, daysOverdue: c.daysOverdue, daysUntilDue: c.daysUntilDue } : null);
  return {
    ...result,
    rows: result.rows.map((r) => ({
      ...r,
      creditZone: { currency: pick(byCurrency.get(`${r.customerKey}|${r.currency}`)), all: pick(byCustomer.get(`${r.customerKey}|*`)) },
    })),
  };
}
