/**
 * Debt Report "Aging Map" (Finance / Price department): where every customer stands against its own payment term.
 * The ONE place the zone rules live -- the page only renders what GET /debt-report/aging returns.
 *
 * Per customer and currency (amounts are never added across currencies, like the rest of the Debt Report):
 *   1. lines: the Debt Report's own source (linesSource) -- snapshot, report exclusions, scope toggles, the caller's
 *      scoped filters (salesperson lock), customer search and customer size. The line-level page filters (overdue
 *      status, aging bucket, delivery status, document type, payment term, invoice size) are NOT applied: they would
 *      change which invoice is the oldest. The map has its own term filter, on the deciding invoice.
 *   2. the SAME base as the Debt Report's "Total debt" card (line_kind = 'invoice', debtReport.ts): only customer
 *      invoices, as Odoo matched them (amount_residual). Credit notes and unreconciled payments never settle an
 *      invoice here and never lower the outstanding amount; other receivable entries and inter-company lines are
 *      never on the map, whatever the toggles. So the map total = the Total debt card (same filters + currency).
 *   3. outstanding = the customer's open invoices in the invoice currency; outstandingCompany = the same in the
 *      company currency (LYD: Odoo's own amount_residual, never a rate of ours).
 *   4. the deciding invoice = the customer's OLDEST open invoice (invoice date, else the line date; then due date,
 *      then line id). A partial payment lowers outstanding but keeps the zone; settling the oldest invoice in full
 *      hands the decision to the next-oldest.
 *   5. its term (resolveTerm): the invoice's payment term (the ETL already falls back to the customer's default term)
 *      with term_days from cfg_finance_payment_term_days; else the invoice's own due date - invoice date; else
 *      "Missing term" with 0 days.
 *   6. its zone (classify): W = max(term_days, min_step); zone i runs up to upper_multiplier(i) x W days of invoice
 *      age (cfg_finance_aging_zone, cfg_finance_aging_setting -- migration 0037).
 *
 * Invoice age = snapshot date - invoice date, in days (never below 0).
 *
 * All currencies (`allCurrencies`, 2026-10-15: the page's default view): one dot per CUSTOMER over every currency --
 * the deciding invoice is its oldest open invoice in any currency, outstanding = its open invoices in the company
 * currency (Odoo's Amount Due in LYD, Odoo's own rate). The response then reads currency LYD and allCurrencies true.
 */
import type { Pool } from 'mysql2/promise';
import { odooWebBaseUrl } from '../config/finance';
import type { Filters } from './filters';
import { COMPANY_CURRENCY, DebtQueryError, isoOfKey, linesSource, parseDebtQuery, resolveSnapshot, type DebtQuery } from './debtReport';

// ---- settings -------------------------------------------------------------------------------------------------------
export interface AgingZoneSetting {
  key: string;
  label: string;
  /** the zone ends at this x W days of invoice age; null = the last zone */
  upperMultiplier: number | null;
  owner: string;
}

export interface AgingSettings {
  zones: AgingZoneSetting[];
  minStep: number;
  escalationWindowDays: number;
}

/** Throws when the configured zones / settings cannot form a ladder (so a bad edit fails loudly, not silently). */
export function validateSettings(s: AgingSettings): AgingSettings {
  const z = s.zones;
  if (z.length < 2) throw new Error('cfg_finance_aging_zone needs at least 2 zones');
  z.forEach((zone, i) => {
    const last = i === z.length - 1;
    if (last !== (zone.upperMultiplier === null)) throw new Error('cfg_finance_aging_zone: only the last zone has no upper_multiplier');
    if (!last && i > 0 && !((zone.upperMultiplier as number) > (z[i - 1].upperMultiplier as number))) {
      throw new Error('cfg_finance_aging_zone: upper_multiplier must increase zone by zone');
    }
    if (!last && !((zone.upperMultiplier as number) > 0)) throw new Error('cfg_finance_aging_zone: upper_multiplier must be above 0');
  });
  if (!(s.minStep >= 1)) throw new Error('cfg_finance_aging_setting: min_step must be at least 1');
  if (!(s.escalationWindowDays >= 0)) throw new Error('cfg_finance_aging_setting: escalation_window_days must not be negative');
  return s;
}

export async function fetchAgingSettings(pool: Pool): Promise<AgingSettings> {
  const [zones] = await pool.query('SELECT zone_key, label_en, upper_multiplier, owner_en FROM cfg_finance_aging_zone ORDER BY sort_order', []);
  const [settings] = await pool.query('SELECT setting_key, value_num FROM cfg_finance_aging_setting', []);
  const value = (key: string, fallback: number) => {
    const r = (settings as Row[]).find((x) => x.setting_key === key);
    return r ? Number(r.value_num) : fallback;
  };
  return validateSettings({
    zones: (zones as Row[]).map((z) => ({
      key: String(z.zone_key),
      label: String(z.label_en),
      upperMultiplier: z.upper_multiplier === null ? null : Number(z.upper_multiplier),
      owner: String(z.owner_en),
    })),
    minStep: value('min_step', 7),
    escalationWindowDays: value('escalation_window_days', 7),
  });
}

// ---- the zone rules (pure) ------------------------------------------------------------------------------------------
export interface Placement {
  /** W = max(term_days, min_step) */
  termWidth: number;
  zoneIndex: number;
  invoiceAge: number;
  daysPastDue: number;
  /** invoice age / W: the x position on the all-terms track (zone i spans the multipliers before and at it) */
  position: number;
  /** days until the first day of the next zone; null in the last zone */
  daysToNextZone: number | null;
  escalatingSoon: boolean;
}

export function classify(termDays: number, invoiceAge: number, s: AgingSettings): Placement {
  const w = Math.max(termDays, s.minStep);
  const age = Math.max(0, invoiceAge);
  const last = s.zones.length - 1;
  const found = s.zones.findIndex((z) => z.upperMultiplier !== null && age <= z.upperMultiplier * w);
  const zoneIndex = found < 0 ? last : found;
  const upper = s.zones[zoneIndex].upperMultiplier;
  const daysToNextZone = upper === null ? null : Math.floor(upper * w) + 1 - age;
  return {
    termWidth: w,
    zoneIndex,
    invoiceAge: age,
    daysPastDue: Math.max(0, age - termDays),
    position: age / w,
    daysToNextZone,
    escalatingSoon: daysToNextZone !== null && daysToNextZone <= s.escalationWindowDays,
  };
}

/** Day range of every zone for one term: [from, to], `to` null for the last zone. */
export function zoneRanges(termDays: number, s: AgingSettings): { zone: string; from: number; to: number | null }[] {
  const w = Math.max(termDays, s.minStep);
  let from = 0;
  return s.zones.map((z) => {
    const to = z.upperMultiplier === null ? null : Math.floor(z.upperMultiplier * w);
    const r = { zone: z.key, from, to };
    if (to !== null) from = to + 1;
    return r;
  });
}

export type TermSource = 'payment_term' | 'due_date' | 'missing';

export interface ResolvedTerm {
  /** the term filter value: PaymentTermKey, 'due_date' or 'missing' */
  key: string;
  label: string;
  termDays: number;
  source: TermSource;
}

export const DUE_DATE_TERM = 'due_date';
export const MISSING_TERM = 'missing';

const DAY_MS = 86_400_000;
const isoDay = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
/** Whole days from `a` to `b` (ISO dates). */
export const daysBetween = (a: string, b: string): number => Math.round((isoDay(b) - isoDay(a)) / DAY_MS);
export const addDays = (iso: string, days: number): string => new Date(isoDay(iso) + days * DAY_MS).toISOString().slice(0, 10);

/** The term of the deciding invoice: its payment term's configured days, else its own due date, else missing (0). */
export function resolveTerm(x: { paymentTermKey: number; paymentTerm: string | null; termDays: number | null; invoiceDate: string | null; dueDate: string | null }): ResolvedTerm {
  if (x.paymentTermKey !== -1 && x.termDays !== null) {
    return { key: String(x.paymentTermKey), label: x.paymentTerm ?? String(x.paymentTermKey), termDays: x.termDays, source: 'payment_term' };
  }
  if (x.invoiceDate && x.dueDate) {
    const days = Math.max(0, daysBetween(x.invoiceDate, x.dueDate));
    return { key: DUE_DATE_TERM, label: `By due date (${days} day${days === 1 ? '' : 's'})`, termDays: days, source: 'due_date' };
  }
  return { key: MISSING_TERM, label: 'Missing term', termDays: 0, source: 'missing' };
}

// ---- query ----------------------------------------------------------------------------------------------------------
export interface AgingQuery {
  debt: DebtQuery;
  /** 3-letter code; null = the currency with the most customers (unless allCurrencies) */
  currency: string | null;
  /** every currency together in LYD (one dot per customer); ignored when a currency is given */
  allCurrencies: boolean;
  /** PaymentTermKey, 'due_date' or 'missing'; null = every term */
  term: string | null;
}

export function parseAgingQuery(q: Record<string, unknown>): AgingQuery {
  const debt = parseDebtQuery(q);
  const currency = typeof q.currency === 'string' && q.currency.trim() ? q.currency.trim().toUpperCase() : null;
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) throw new DebtQueryError('currency must be a 3-letter code');
  const term = typeof q.term === 'string' && q.term.trim() ? q.term.trim() : null;
  if (term !== null && !/^(-?\d+|due_date|missing)$/.test(term)) throw new DebtQueryError('term must be a payment term key, due_date or missing');
  return {
    // the line-level page filters would change which invoice is the oldest: never applied here
    debt: { ...debt, overdueStatus: 'all', agingBucketKeys: [], deliveryStatuses: [], paymentTermKeys: [], invoiceTiers: [] },
    currency,
    allCurrencies: currency === null && (q.allCurrencies === 'true' || q.allCurrencies === '1' || q.allCurrencies === true),
    term,
  };
}

interface Sql {
  sql: string;
  params: unknown[];
}
type Row = Record<string, any>;

/**
 * One row per customer + currency with an open invoice: its open invoices (sum in the invoice currency and in the
 * company currency, count) and its deciding (oldest) invoice line with the configured days of that invoice's term.
 * One pass: a CTE over the source, ROW_NUMBER for the oldest invoice, GROUP BY for the sums. Only invoice lines are
 * read: credit notes, payments, other entries and inter-company lines never reach the map, whatever the toggles.
 *
 * `source` is a FROM clause exposing alias `l` (linesSource in production; literal rows in the SQL tests) with
 * currency, CustomerKey, customer, CompanyKey, company, PaymentTermKey, payment_term, move_id, line_id, document,
 * InvoiceDateKey, due_date (YYYY-MM-DD), residual_doc_ccy, residual_company_ccy and line_kind.
 *
 * `allCurrencies`: every line gets the company currency as its "currency" and its company-currency residual as its
 * amount, so the same query yields one row per customer over every currency, in LYD.
 */
export function agingSql(source: Sql, allCurrencies = false): Sql {
  const currency = allCurrencies ? `'${COMPANY_CURRENCY}' AS currency` : 'l.currency';
  const amount = allCurrencies ? 'l.residual_company_ccy AS residual_doc_ccy' : 'l.residual_doc_ccy';
  return {
    sql: `
      WITH src AS (
        SELECT ${currency}, l.CustomerKey, l.customer, l.CompanyKey, l.company, l.PaymentTermKey, l.payment_term, l.move_id, l.line_id,
               l.document, l.InvoiceDateKey, l.due_date, ${amount}, l.residual_company_ccy, l.line_kind
        ${source.sql}
      ),
      ln AS (SELECT * FROM src WHERE line_kind = 'invoice'),
      balance AS (
        SELECT CustomerKey, currency, SUM(residual_doc_ccy) AS outstanding, SUM(residual_company_ccy) AS outstanding_company,
               COUNT(DISTINCT CASE WHEN residual_doc_ccy > 0 THEN move_id END) AS open_invoices
        FROM ln
        GROUP BY CustomerKey, currency
      ),
      oldest AS (
        SELECT ln.*, ROW_NUMBER() OVER (PARTITION BY ln.CustomerKey, ln.currency ORDER BY ln.InvoiceDateKey, ln.due_date, ln.line_id) AS rn
        FROM ln
        WHERE ln.residual_doc_ccy > 0
      )
      SELECT b.currency, b.CustomerKey, o.customer, o.CompanyKey, o.company, o.PaymentTermKey, o.payment_term, td.term_days, o.move_id,
             o.document, o.InvoiceDateKey, o.due_date, b.outstanding, b.outstanding_company, b.open_invoices
      FROM balance b
      JOIN oldest o ON o.CustomerKey = b.CustomerKey AND o.currency = b.currency AND o.rn = 1
      LEFT JOIN cfg_finance_payment_term_days td ON td.PaymentTermKey = o.PaymentTermKey`,
    params: [...source.params],
  };
}

// ---- response -------------------------------------------------------------------------------------------------------
export interface DebtAgingCustomer {
  customerKey: number;
  customer: string;
  /** company of the deciding invoice */
  companyKey: number;
  company: string;
  termKey: string;
  termLabel: string;
  termDays: number;
  termSource: TermSource;
  oldestOpenMoveId: number;
  oldestOpenDocument: string | null;
  odooUrl: string;
  invoiceDate: string;
  dueDate: string | null;
  invoiceAge: number;
  daysPastDue: number;
  termWidth: number;
  position: number;
  zone: string;
  zoneIndex: number;
  owner: string;
  nextZone: string | null;
  daysToNextZone: number | null;
  escalatingSoon: boolean;
  /** open invoices in the invoice currency */
  outstanding: number;
  /** the same in the company currency (LYD): Odoo's own amount_residual, the "Amount Due" column */
  outstandingCompany: number;
  openInvoices: number;
}

export interface DebtAgingZone {
  key: string;
  label: string;
  owner: string;
  lowerMultiplier: number;
  upperMultiplier: number | null;
}

export interface DebtAgingTerm {
  key: string;
  label: string;
  /** null for the due-date group (each customer has its own days) */
  termDays: number | null;
  customers: number;
  /** day range per zone when the term has fixed days (the axis in real days) */
  ranges: { zone: string; from: number; to: number | null }[] | null;
}

export interface DebtAging {
  snapshotDate: string | null;
  currency: string | null;
  /** true = every currency together, amounts in LYD (≈) */
  allCurrencies: boolean;
  /** currencies with at least one customer on the map, most customers first */
  currencies: string[];
  settings: { minStep: number; escalationWindowDays: number; axisCap: number };
  zones: DebtAgingZone[];
  /** term filter options in the chosen currency, before the term filter */
  terms: DebtAgingTerm[];
  /** sorted by position, worst first */
  customers: DebtAgingCustomer[];
}

/** Money adds up in millionths (the DECIMAL(20,6) scale) so the sums are exact. */
const micro = (v: unknown): number => Math.round(Number(v ?? 0) * 1e6);
const fromMicro = (v: number): number => v / 1e6;

/** Turns the query rows into the map (pure: the tests feed it rows directly). */
export function buildAging(
  rows: Row[],
  opts: { snapshotDate: string | null; currency: string | null; term: string | null; settings: AgingSettings; allCurrencies?: boolean },
): DebtAging {
  const s = opts.settings;
  const finite = s.zones.filter((z) => z.upperMultiplier !== null).map((z) => z.upperMultiplier as number);
  const lastFinite = finite[finite.length - 1];

  const customersPerCurrency = new Map<string, number>();
  for (const r of rows) customersPerCurrency.set(String(r.currency), (customersPerCurrency.get(String(r.currency)) ?? 0) + 1);
  const currencies = [...customersPerCurrency].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c]) => c);
  const currency = opts.currency ?? currencies[0] ?? null;

  const base = odooWebBaseUrl();
  const all: DebtAgingCustomer[] = rows
    .filter((r) => String(r.currency) === currency)
    .map((r) => {
      const invoiceDate = isoOfKey(Number(r.InvoiceDateKey)) as string;
      const dueDate = r.due_date ? String(r.due_date) : null;
      const term = resolveTerm({
        paymentTermKey: Number(r.PaymentTermKey),
        paymentTerm: r.payment_term ?? null,
        termDays: r.term_days === null || r.term_days === undefined ? null : Number(r.term_days),
        invoiceDate,
        dueDate,
      });
      const p = classify(term.termDays, opts.snapshotDate ? daysBetween(invoiceDate, opts.snapshotDate) : 0, s);
      const zone = s.zones[p.zoneIndex];
      return {
        customerKey: Number(r.CustomerKey),
        customer: String(r.customer),
        companyKey: Number(r.CompanyKey),
        company: String(r.company),
        termKey: term.key,
        termLabel: term.label,
        termDays: term.termDays,
        termSource: term.source,
        oldestOpenMoveId: Number(r.move_id),
        oldestOpenDocument: r.document ?? null,
        odooUrl: `${base}/web#id=${Number(r.move_id)}&model=account.move&view_type=form`,
        invoiceDate,
        dueDate,
        invoiceAge: p.invoiceAge,
        daysPastDue: p.daysPastDue,
        termWidth: p.termWidth,
        position: p.position,
        zone: zone.key,
        zoneIndex: p.zoneIndex,
        owner: zone.owner,
        nextZone: s.zones[p.zoneIndex + 1]?.key ?? null,
        daysToNextZone: p.daysToNextZone,
        escalatingSoon: p.escalatingSoon,
        outstanding: fromMicro(micro(r.outstanding)),
        outstandingCompany: fromMicro(micro(r.outstanding_company)),
        openInvoices: Number(r.open_invoices),
      };
    });

  // term options (before the term filter)
  const termMap = new Map<string, DebtAgingTerm>();
  for (const c of all) {
    const t = termMap.get(c.termKey);
    if (t) t.customers += 1;
    else {
      const fixed = c.termSource !== 'due_date';
      termMap.set(c.termKey, {
        key: c.termKey,
        label: c.termSource === 'due_date' ? 'No term · by due date' : c.termLabel,
        termDays: fixed ? c.termDays : null,
        customers: 1,
        ranges: fixed ? zoneRanges(c.termDays, s) : null,
      });
    }
  }
  const sourceRank = (k: string) => (k === DUE_DATE_TERM ? 1 : k === MISSING_TERM ? 2 : 0);
  const terms = [...termMap.values()].sort(
    (a, b) => sourceRank(a.key) - sourceRank(b.key) || (a.termDays ?? 0) - (b.termDays ?? 0) || a.label.localeCompare(b.label),
  );

  const customers = (opts.term ? all.filter((c) => c.termKey === opts.term) : all).sort(
    (a, b) => b.position - a.position || b.outstanding - a.outstanding || a.customerKey - b.customerKey,
  );

  return {
    snapshotDate: opts.snapshotDate,
    currency,
    allCurrencies: Boolean(opts.allCurrencies),
    currencies,
    settings: { minStep: s.minStep, escalationWindowDays: s.escalationWindowDays, axisCap: lastFinite * 1.5 },
    zones: s.zones.map((z, i) => ({
      key: z.key,
      label: z.label,
      owner: z.owner,
      lowerMultiplier: i === 0 ? 0 : (s.zones[i - 1].upperMultiplier as number),
      upperMultiplier: z.upperMultiplier,
    })),
    terms,
    customers,
  };
}

/** GET /debt-report/aging. */
export async function fetchDebtAging(pool: Pool, q: AgingQuery, f: Filters): Promise<DebtAging> {
  const settings = await fetchAgingSettings(pool);
  const snapshotKey = await resolveSnapshot(pool, q.debt);
  let rows: Row[] = [];
  if (snapshotKey !== null) {
    const a = agingSql(linesSource(snapshotKey, q.debt, f), q.allCurrencies);
    [rows] = (await pool.query(a.sql, a.params)) as unknown as [Row[]];
  }
  return buildAging(rows, {
    snapshotDate: isoOfKey(snapshotKey),
    currency: q.allCurrencies ? COMPANY_CURRENCY : q.currency,
    term: q.term,
    settings,
    allCurrencies: q.allCurrencies,
  });
}
