/**
 * Unapplied credits netted against open invoices (2026-11-09): the ONE allocation rule behind every "overdue" that must
 * match what the customer really owes (Odoo partner "Due"). Pure; the callers fetch the lines.
 *
 * Why: Odoo shows a customer whose invoice is fully covered by open credit notes (or an unreconciled payment) with a
 * Due of 0, but an invoice-only overdue (the 2026-10-06 rule) still showed the invoice as overdue -- e.g. customer 27775
 * (INV/2026/10/00118 1,045.000 vs RINV/2026/10/0006 + 0007) sat in RED with 1,045 overdue while owing nothing.
 *
 * Rule, per group = customer (CustomerKey, the commercial partner) + company (CompanyKey) + currency:
 *   - per-currency views: amounts in the line's own currency (residual_doc_ccy), one group per currency -- currencies
 *     are never mixed; the "All currencies (≈ LYD)" view: residual_company_ccy, one group per customer + company.
 *   - credit pool = the unapplied credits (credit_note + payment lines, any due date) plus any negative invoice line,
 *     as a positive amount; a positive credit-kind line (e.g. money paid back out) lowers the pool. Pool <= 0: nothing
 *     to apply.
 *   - the pool is applied FIFO to the open (positive) invoice lines: earliest due date first (= earliest overdue
 *     date; a line without one goes last), ties by the older invoice date, then the lower move id, then line id.
 *     A partly covered line keeps its remainder. What is left of the pool is a net credit balance.
 * Lines arrive already filtered (snapshot, report exclusions, scope, role scope): excluded lines never enter a pool.
 */

/** What the allocation needs of a receivable line. */
export interface AllocatableLine {
  line_id: number;
  move_id: number;
  CustomerKey: number;
  CompanyKey: number;
  currency: string;
  /** 'invoice' | 'credit_note' | 'payment' (other kinds are ignored) */
  line_kind?: string | null;
  residual_doc_ccy: number;
  residual_company_ccy: number;
  /** YYYY-MM-DD */
  invoice_date: string | null;
}

export const ALLOCATED_KINDS = ['invoice', 'credit_note', 'payment'] as const;

/** One open invoice line after the credits. `remaining*` in both currencies (the other one scaled by the share left). */
export interface AllocatedLine<T> {
  line: T;
  /** in the allocation currency (doc currency per currency, LYD for all currencies) */
  open: number;
  remaining: number;
  /** remaining in the line's own currency and in LYD */
  remainingDoc: number;
  remainingCompany: number;
}

export interface AllocationGroup<T> {
  key: string;
  customerKey: number;
  companyKey: number;
  /** the group's currency, or 'LYD' with allCurrencies */
  currency: string;
  /** the credit pool (positive) */
  credits: number;
  /** credits consumed by invoices */
  applied: number;
  /** credits left over: a net credit balance */
  leftover: number;
  /** every line of the group, signed: invoices - credits (= Odoo's partner balance for the group) */
  net: number;
  invoices: AllocatedLine<T>[];
}

/** Money adds up in millionths (the DECIMAL(20,6) scale) so sums and comparisons are exact. */
const micro = (v: unknown): number => Math.round(Number(v ?? 0) * 1e6);
const fromMicro = (v: number): number => v / 1e6;

export interface AllocationOptions<T> {
  /** true = the "All currencies (≈ LYD)" view: residual_company_ccy, groups per customer + company */
  allCurrencies: boolean;
  /** the line's own due date (YYYY-MM-DD) for the FIFO order; null = last */
  dueDateOf: (line: T) => string | null;
  /** the kind of a line; default line.line_kind ?? 'invoice' */
  kindOf?: (line: T) => string;
}

export function allocationKey(customerKey: number, companyKey: number, currency: string | null): string {
  return `${customerKey}|${companyKey}|${currency ?? '*'}`;
}

/** Applies every group's unapplied credits to its open invoice lines (module doc). */
export function allocateCredits<T extends AllocatableLine>(lines: readonly T[], opts: AllocationOptions<T>): Map<string, AllocationGroup<T>> {
  const kindOf = opts.kindOf ?? ((l: T) => String(l.line_kind ?? 'invoice'));
  const groups = new Map<string, { g: AllocationGroup<T>; pool: number; net: number; open: { line: T; amount: number; due: string | null }[] }>();
  for (const l of lines) {
    const kind = kindOf(l);
    if (!(ALLOCATED_KINDS as readonly string[]).includes(kind)) continue;
    const currency = opts.allCurrencies ? 'LYD' : String(l.currency);
    const key = allocationKey(Number(l.CustomerKey), Number(l.CompanyKey), opts.allCurrencies ? null : currency);
    let acc = groups.get(key);
    if (!acc) {
      acc = {
        g: { key, customerKey: Number(l.CustomerKey), companyKey: Number(l.CompanyKey), currency, credits: 0, applied: 0, leftover: 0, net: 0, invoices: [] },
        pool: 0, net: 0, open: [],
      };
      groups.set(key, acc);
    }
    const amount = micro(opts.allCurrencies ? l.residual_company_ccy : l.residual_doc_ccy);
    acc.net += amount;
    if (kind === 'invoice' && amount > 0) acc.open.push({ line: l, amount, due: opts.dueDateOf(l) });
    else acc.pool -= amount; // credits (negative) grow the pool; a positive credit-kind line shrinks it
  }
  const out = new Map<string, AllocationGroup<T>>();
  for (const [key, acc] of groups) {
    acc.open.sort(
      (a, b) =>
        (a.due === null ? 1 : 0) - (b.due === null ? 1 : 0) ||
        (a.due ?? '').localeCompare(b.due ?? '') ||
        (a.line.invoice_date ?? '').localeCompare(b.line.invoice_date ?? '') ||
        Number(a.line.move_id) - Number(b.line.move_id) ||
        Number(a.line.line_id) - Number(b.line.line_id),
    );
    let left = Math.max(0, acc.pool);
    for (const o of acc.open) {
      const take = Math.min(left, o.amount);
      left -= take;
      const remaining = o.amount - take;
      const share = remaining / o.amount;
      const doc = Number(o.line.residual_doc_ccy ?? 0);
      const company = Number(o.line.residual_company_ccy ?? 0);
      acc.g.invoices.push({
        line: o.line,
        open: fromMicro(o.amount),
        remaining: fromMicro(remaining),
        remainingDoc: remaining === o.amount ? doc : fromMicro(Math.round(micro(doc) * share)),
        remainingCompany: remaining === o.amount ? company : fromMicro(Math.round(micro(company) * share)),
      });
    }
    const pool = Math.max(0, acc.pool);
    acc.g.credits = fromMicro(pool);
    acc.g.applied = fromMicro(pool - left);
    acc.g.leftover = fromMicro(left);
    acc.g.net = fromMicro(acc.net);
    out.set(key, acc.g);
  }
  return out;
}
