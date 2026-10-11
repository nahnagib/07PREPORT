/**
 * Collections trend (Receivables and Collections page, next to the Receivables trend): money collected from customers
 * per day / week / month, from fact_finance_collection through v_finance_collection_trend (migrations 0040 + 0042,
 * loaded by the finance ETL, departments/finance/collections.py).
 *
 * A collection = a POSTED inbound customer payment that is not an internal transfer, dated by the payment's own date
 * (account.payment.date). Credit notes, write-offs and exchange differences are never collections. Every payment has
 * full history (not limited to the receivable snapshot dates). Amounts are in the PAYMENT currency, never converted;
 * one currency at a time (the page's "Charts currency").
 *
 * Per period: collected (the payments' amounts) = applied to invoices overdue on the payment date + applied to invoices
 * not yet due + applied to other receivable debits + not matched yet (as of the last load); the payment count; and the
 * collection rate of ar_weekly (reporting/ar_weekly/engine.py week_result): money applied in the period to the invoice
 * lines that were overdue at the START of the period / that start overdue. The start overdue comes from the receivable
 * snapshot dated the day BEFORE the period (the last state of that day: the 15:00 run replaces the 02:00 one, so the
 * snapshot of the first day itself already holds that day's payments), lines due on or before that day (= overdue when
 * the period starts; due today is not overdue), same filters as the page; no snapshot that day = no rate (null, the line
 * is hidden). Snapshots started on 2026-10-04, so the rate exists only from then on (a rebuild of past balances from partial reconciliations, as ar_weekly does, would give
 * history but a second definition of "overdue" next to the Debt Report's; not done). Differences from ar_weekly: dated by
 * payment date (ar_weekly: reconciliation max_date), and the numerator counts cash only (ar_weekly's collected_overdue
 * too; its credit notes / other settlements are not shown here).
 *
 * Scope = the Debt Report's: the view removes inter-company customers and the report exclusions; the caller's scoped
 * filters (role data scope, salesperson lock) and the page's company / salesperson / branch / segment / channel /
 * customer / customer category filters apply (to the allocation row: the invoice's salesperson + branch, or the
 * customer's for unmatched money). The line-level page filters (overdue status, aging bucket, delivery status, payment
 * term, invoice size) describe open invoices, not payments, and do not apply. Week = Sunday..Saturday (ar_weekly).
 */
import type { Pool } from 'mysql2/promise';
import { odooWebBaseUrl } from '../config/finance';
import { customerCategoryCondition } from '../lib/customerCategory';
import { DebtQueryError, linesSource, parseDebtQuery, type DebtQuery } from './debtReport';
import type { Filters } from './filters';

export type CollectionGrain = 'day' | 'week' | 'month';
export const COLLECTION_GRAINS: readonly CollectionGrain[] = ['day', 'week', 'month'];
/** Default range per grain: periods ending with the current one (business time zone). */
export const DEFAULT_PERIODS: Record<CollectionGrain, number> = { day: 30, week: 12, month: 12 };
const MAX_PERIODS = 400;
const DRILL_LIMIT = 1000;
export const BUSINESS_TIME_ZONE = 'Africa/Tripoli';

export interface CollectionsQuery {
  currency: string | null;
  grain: CollectionGrain;
  from: string;
  to: string;
  debt: DebtQuery;
}

// ---- dates (pure, UTC-noon arithmetic on ISO dates) -----------------------------------------------------------------
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const toDate = (iso: string) => new Date(`${iso}T12:00:00Z`);
const toIso = (d: Date) => d.toISOString().slice(0, 10);
export function addDays(iso: string, n: number): string {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toIso(d);
}
function addMonths(iso: string, n: number): string {
  const d = toDate(iso);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  return toIso(d);
}

export function todayIn(timeZone = BUSINESS_TIME_ZONE, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** First day of the period holding `iso`: the day, the Sunday of its week (Sunday..Saturday), the 1st of its month. */
export function periodStart(iso: string, grain: CollectionGrain): string {
  if (grain === 'day') return iso;
  if (grain === 'month') return `${iso.slice(0, 7)}-01`;
  return addDays(iso, -toDate(iso).getUTCDay());
}

export function periodEnd(start: string, grain: CollectionGrain): string {
  if (grain === 'day') return start;
  if (grain === 'week') return addDays(start, 6);
  return addDays(addMonths(start, 1), -1);
}

function nextStart(start: string, grain: CollectionGrain): string {
  return grain === 'month' ? addMonths(start, 1) : addDays(start, grain === 'week' ? 7 : 1);
}

export interface Period {
  start: string;
  end: string;
}

/** Every period from the one holding `from` to the one holding `to`, in order. */
export function periodsBetween(from: string, to: string, grain: CollectionGrain): Period[] {
  const out: Period[] = [];
  for (let s = periodStart(from, grain); s <= to && out.length <= MAX_PERIODS; s = nextStart(s, grain)) out.push({ start: s, end: periodEnd(s, grain) });
  if (out.length > MAX_PERIODS) throw new DebtQueryError(`at most ${MAX_PERIODS} periods: use a coarser grain or a shorter range`);
  return out;
}

export function parseCollectionsQuery(q: Record<string, unknown>, today = todayIn()): CollectionsQuery {
  const grain = (q.grain ?? 'week') as CollectionGrain;
  if (!COLLECTION_GRAINS.includes(grain)) throw new DebtQueryError('grain must be day, week or month');
  for (const k of ['from', 'to'] as const) {
    if (q[k] !== undefined && q[k] !== '' && (typeof q[k] !== 'string' || !ISO.test(q[k] as string))) throw new DebtQueryError(`${k} must be YYYY-MM-DD`);
  }
  const to = (q.to as string) || periodEnd(periodStart(today, grain), grain);
  let from = q.from as string;
  if (!from) {
    const last = periodStart(to, grain);
    const n = DEFAULT_PERIODS[grain] - 1;
    from = grain === 'month' ? addMonths(last, -n) : addDays(last, -n * (grain === 'week' ? 7 : 1));
  }
  if (from > to) throw new DebtQueryError('from must be on or before to');
  periodsBetween(from, to, grain); // 400 at most
  const currency = typeof q.currency === 'string' && q.currency ? q.currency : null;
  if (currency && !/^[A-Z]{3}$/.test(currency)) throw new DebtQueryError('currency must be a 3-letter code');
  return { currency, grain, from, to, debt: parseDebtQuery(q) };
}

// ---- SQL --------------------------------------------------------------------------------------------------------------
interface Sql {
  sql: string;
  params: unknown[];
}

const PERIOD_SQL: Record<CollectionGrain, string> = {
  day: 'v.payment_date',
  week: 'DATE_SUB(v.payment_date, INTERVAL (DAYOFWEEK(v.payment_date) - 1) DAY)',
  month: "DATE_FORMAT(v.payment_date, '%Y-%m-01')",
};

function inList(column: string, values: readonly unknown[] | undefined, out: string[], params: unknown[]): void {
  if (!values || values.length === 0) return;
  out.push(`${column} IN (${values.map(() => '?').join(', ')})`);
  params.push(...values);
}

/** FROM + WHERE on v_finance_collection_trend (alias v, customer cu) for the range and every applicable filter. */
export function collectionSource(cq: CollectionsQuery, f: Filters, currency: string | null): Sql {
  const where = ['v.payment_date BETWEEN ? AND ?'];
  const params: unknown[] = [cq.from, cq.to];
  if (currency) {
    where.push('v.currency = ?');
    params.push(currency);
  }
  inList('v.CompanyKey', f.companyKeys, where, params);
  inList('v.SalespersonKey', f.salespersonKeys, where, params);
  inList('v.SalesTeamKey', f.salesTeamKeys, where, params);
  inList('v.SegmentKey', f.segmentKeys, where, params);
  inList('v.ChannelKey', f.channelKeys, where, params);
  inList('v.CustomerKey', f.customerKeys, where, params);
  const cat = customerCategoryCondition('cu', cq.debt.customerCategories);
  if (cat) {
    where.push(cat.sql);
    params.push(...cat.params);
  }
  return { sql: `FROM v_finance_collection_trend v JOIN dim_customer cu ON cu.CustomerKey = v.CustomerKey WHERE ${where.join(' AND ')}`, params };
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
type Row = Record<string, any>;
async function rows(pool: Pool, sql: string, params: unknown[]): Promise<Row[]> {
  const [r] = await pool.query(sql, params);
  return r as Row[];
}

// ---- trend -------------------------------------------------------------------------------------------------------------
export interface CollectionPoint {
  periodStart: string;
  periodEnd: string;
  collected: number;
  appliedOverdue: number;
  appliedNotDue: number;
  appliedOther: number;
  unapplied: number;
  payments: number;
  /** overdue open at the start of the period (receivable snapshot of that day); null = no snapshot that day */
  startOverdue: number | null;
  /** applied in the period to the invoice lines overdue at the start (invoice currency) */
  collectedOnStartOverdue: number | null;
  /** collectedOnStartOverdue / startOverdue (ar_weekly's collection rate); null without a start balance */
  collectionRate: number | null;
}

export interface CollectionsTrend {
  currency: string | null;
  currencies: string[];
  grain: CollectionGrain;
  from: string;
  to: string;
  points: CollectionPoint[];
  /** the first payment date in the warehouse (history starts there) and the last load */
  firstPaymentDate: string | null;
  loadedAt: string | null;
}

export async function fetchCollectionsTrend(pool: Pool, cq: CollectionsQuery, f: Filters): Promise<CollectionsTrend> {
  const all = collectionSource(cq, f, null);
  const byCcy = await rows(pool, `SELECT v.currency, COUNT(DISTINCT v.payment_id) AS n ${all.sql} GROUP BY v.currency ORDER BY n DESC, v.currency`, all.params);
  const currencies = byCcy.map((r) => String(r.currency));
  const currency = cq.currency ?? currencies[0] ?? null;
  const periods = periodsBetween(cq.from, cq.to, cq.grain);
  const meta = (await rows(pool, "SELECT DATE_FORMAT(MIN(payment_date), '%Y-%m-%d') AS first, DATE_FORMAT(MAX(loaded_at_utc), '%Y-%m-%dT%H:%i:%sZ') AS loaded FROM fact_finance_collection", []))[0] ?? {};
  const empty = (p: Period): CollectionPoint => ({
    periodStart: p.start, periodEnd: p.end, collected: 0, appliedOverdue: 0, appliedNotDue: 0, appliedOther: 0, unapplied: 0, payments: 0,
    startOverdue: null, collectedOnStartOverdue: null, collectionRate: null,
  });
  if (!currency) return { currency, currencies, grain: cq.grain, from: cq.from, to: cq.to, points: periods.map(empty), firstPaymentDate: meta.first ?? null, loadedAt: meta.loaded ?? null };
  const s = collectionSource(cq, f, currency);
  const r = await rows(
    pool,
    `SELECT DATE_FORMAT(${PERIOD_SQL[cq.grain]}, '%Y-%m-%d') AS p, SUM(v.amount_doc_ccy) AS collected,
            SUM(v.applied_overdue_doc_ccy) AS overdue, SUM(v.applied_not_due_doc_ccy) AS not_due,
            SUM(v.applied_other_doc_ccy) AS other, SUM(v.unapplied_doc_ccy) AS unapplied, COUNT(DISTINCT v.payment_id) AS payments
     ${s.sql} GROUP BY p`,
    s.params,
  );
  const byPeriod = new Map(r.map((x) => [String(x.p), x]));
  const rates = await startOverdueRates(pool, cq, f, currency, periods);
  return {
    currency,
    currencies,
    grain: cq.grain,
    from: cq.from,
    to: cq.to,
    firstPaymentDate: meta.first ?? null,
    loadedAt: meta.loaded ?? null,
    points: periods.map((p) => {
      const x = byPeriod.get(p.start);
      const rate = rates.get(p.start);
      return {
        ...empty(p),
        collected: num(x?.collected),
        appliedOverdue: num(x?.overdue),
        appliedNotDue: num(x?.not_due),
        appliedOther: num(x?.other),
        unapplied: num(x?.unapplied),
        payments: num(x?.payments),
        startOverdue: rate ? rate.start : null,
        collectedOnStartOverdue: rate ? rate.collected : null,
        collectionRate: rate && rate.start > 0 ? rate.collected / rate.start : null,
      };
    }),
  };
}

/** Per period with a receivable snapshot on the day before it: the overdue open when the period starts (same filters)
 * and the money applied to those very invoice lines by payments dated in the period. */
async function startOverdueRates(pool: Pool, cq: CollectionsQuery, f: Filters, currency: string, periods: Period[]): Promise<Map<string, { start: number; collected: number }>> {
  const snaps = new Set(
    (await rows(pool, "SELECT DISTINCT DATE_FORMAT(STR_TO_DATE(SnapshotDateKey, '%Y%m%d'), '%Y-%m-%d') AS d FROM fact_finance_receivable_snapshot", [])).map((x) => String(x.d)),
  );
  const out = new Map<string, { start: number; collected: number }>();
  const q: DebtQuery = { ...cq.debt, overdueStatus: 'all', agingBucketKeys: [], deliveryStatuses: [], paymentTermKeys: [], invoiceTiers: [] };
  for (const p of periods.filter((x) => snaps.has(addDays(x.start, -1)))) {
    const s = linesSource(Number(addDays(p.start, -1).replace(/-/g, '')), q, f);
    // aged as of the day before: due on or before it (days_past_due >= 0) = overdue on the period's first day
    const outerWhere = /\)\s*l\s*WHERE/.test(s.sql); // linesSource adds the outer WHERE only for page filters
    const cond = `${outerWhere ? ' AND' : ' WHERE'} l.line_kind = 'invoice' AND l.currency = ? AND l.days_past_due >= 0`;
    const [x] = await rows(
      pool,
      `SELECT (SELECT SUM(l.residual_doc_ccy) ${s.sql}${cond}) AS start_overdue,
              (SELECT SUM(m.applied_invoice_ccy) FROM fact_finance_collection_invoice m
                 JOIN fact_finance_collection c ON c.payment_id = m.payment_id AND c.allocation_no = m.allocation_no
                WHERE c.payment_date BETWEEN ? AND ? AND c.is_intercompany = 0
                  AND m.debit_line_id IN (SELECT l.line_id ${s.sql}${cond})) AS collected`,
      [...s.params, currency, p.start, p.end, ...s.params, currency],
    );
    out.set(p.start, { start: num(x?.start_overdue), collected: num(x?.collected) });
  }
  return out;
}

// ---- drill-down: the payments of one period -----------------------------------------------------------------------------
export interface CollectionPaymentRow {
  paymentId: number;
  payment: string;
  paymentDate: string;
  company: string;
  customer: string;
  salesperson: string;
  salesTeam: string;
  attribution: string;
  amount: number;
  appliedOverdue: number;
  appliedNotDue: number;
  appliedOther: number;
  unapplied: number;
  /** "INV/2026/0012 (1,000.00)" per matched invoice of this allocation */
  invoices: string;
  odooUrl: string;
}

export async function fetchCollectionsDrilldown(pool: Pool, cq: CollectionsQuery, f: Filters, period: string): Promise<{ rows: CollectionPaymentRow[]; truncated: boolean; currency: string | null; period: Period }> {
  if (!ISO.test(period)) throw new DebtQueryError('period must be YYYY-MM-DD (the first day of the period)');
  const p = { start: periodStart(period, cq.grain), end: periodEnd(periodStart(period, cq.grain), cq.grain) };
  const currency = cq.currency;
  if (!currency) throw new DebtQueryError('currency is required');
  const s = collectionSource({ ...cq, from: p.start, to: p.end }, f, currency);
  const r = await rows(
    pool,
    `SELECT v.payment_id, v.allocation_no, v.payment_name, DATE_FORMAT(v.payment_date, '%Y-%m-%d') AS payment_date, v.company, v.customer,
            v.salesperson, v.sales_team, v.attribution, v.amount_doc_ccy, v.applied_overdue_doc_ccy, v.applied_not_due_doc_ccy,
            v.applied_other_doc_ccy, v.unapplied_doc_ccy
     ${s.sql} ORDER BY v.payment_date, v.amount_doc_ccy DESC, v.payment_id, v.allocation_no LIMIT ${DRILL_LIMIT + 1}`,
    s.params,
  );
  const truncated = r.length > DRILL_LIMIT;
  const page = r.slice(0, DRILL_LIMIT);
  const invoices = new Map<string, string[]>();
  if (page.length) {
    const ids = [...new Set(page.map((x) => num(x.payment_id)))];
    const m = await rows(
      pool,
      `SELECT payment_id, allocation_no, document, applied_doc_ccy FROM fact_finance_collection_invoice
        WHERE payment_id IN (${ids.map(() => '?').join(', ')}) ORDER BY payment_id, allocation_no, partial_id`,
      ids,
    );
    for (const x of m) {
      const k = `${num(x.payment_id)}:${num(x.allocation_no)}`;
      const list = invoices.get(k) ?? [];
      list.push(`${x.document ?? '?'} (${num(x.applied_doc_ccy).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`);
      invoices.set(k, list);
    }
  }
  const base = odooWebBaseUrl();
  return {
    currency,
    period: p,
    truncated,
    rows: page.map((x) => ({
      paymentId: num(x.payment_id),
      payment: String(x.payment_name ?? ''),
      paymentDate: String(x.payment_date),
      company: String(x.company ?? ''),
      customer: String(x.customer ?? ''),
      salesperson: String(x.salesperson ?? ''),
      salesTeam: String(x.sales_team ?? ''),
      attribution: String(x.attribution),
      amount: num(x.amount_doc_ccy),
      appliedOverdue: num(x.applied_overdue_doc_ccy),
      appliedNotDue: num(x.applied_not_due_doc_ccy),
      appliedOther: num(x.applied_other_doc_ccy),
      unapplied: num(x.unapplied_doc_ccy),
      invoices: (invoices.get(`${num(x.payment_id)}:${num(x.allocation_no)}`) ?? []).join(', '),
      odooUrl: `${base}/web#id=${num(x.payment_id)}&model=account.payment&view_type=form`,
    })),
  };
}
