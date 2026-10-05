/**
 * Debt Report (Finance / Price department): open customer receivables from the daily snapshot
 * (fact_finance_receivable_snapshot, loaded by the ETL job finance_receivables at 06:30 Africa/Tripoli).
 *
 * Every query reads the receivable lines once (linesSource) and applies, in this order:
 *   1. the snapshot date (default: the latest);
 *   2. the report exclusions -- ALWAYS, whatever the parameters: the lines of every sales team in an excluded segment
 *      or with an excluded name (cfg_finance_report_exclusion via v_finance_excluded_sales_team, migration 0036;
 *      segment = the line's own sales team's segment, the rule of the segment filter and role scoping);
 *   3. the receivable scope: customer debt only by default; `includeOther` adds other receivable entries
 *      (outbound customer payments, journal entries without an invoice); `includeIntercompany` adds inter-company
 *      lines (own companies' partners + FINANCE_INTERCOMPANY_PARTNER_IDS);
 *   4. the caller's scoped filters (routes go through resolveScopedFilters: role data scope + salesperson lock --
 *      a salesperson only ever sees lines whose SalespersonKey is their own). Segment = the line's sales team's
 *      segment and channel = its salesperson's channel, the same rule the sales lines use;
 *   5. the page filters (customer search, overdue status, aging bucket, delivery status, payment term, document type,
 *      invoice / customer size tier).
 *
 * Amounts are PER CURRENCY: residual_doc_ccy (Odoo amount_residual_currency) in the line's own currency (CurrencyKey),
 * never added across currencies and never converted. Overdue = days_past_due > 0 (due today is not overdue), so
 * overdue + not due = open in every currency. With the defaults (latest snapshot, customer debt, no inter-company, no
 * filter) the figures equal the views v_finance_receivable_latest, v_finance_customer_exposure and
 * v_finance_receivable_trend (0036).
 *
 * Size tiers (config/finance.ts) are the one place the company-currency (LYD) residual is still used: it classifies a
 * document (sum of its open lines) or a company + customer (its open balance) into Large / Medium / Small, on steps
 * 1-4 (so a page filter never changes a tier). It is never shown or added up.
 */
import type { Pool } from 'mysql2/promise';
import { DEBT_TOP_CUSTOMERS, odooWebBaseUrl, sizeTiers, tierCaseSql, type SizeTier } from '../config/finance';
import type { Filters } from './filters';

export class DebtQueryError extends Error {}

export type OverdueStatus = 'all' | 'overdue' | 'not_due';

export interface DebtQuery {
  /** yyyymmdd; null = the latest snapshot */
  snapshotDateKey: number | null;
  includeOther: boolean;
  includeIntercompany: boolean;
  customerSearch: string | null;
  overdueStatus: OverdueStatus;
  agingBucketKeys: number[];
  /** Odoo sale.order delivery_status values; 'none' = invoice without a sales order / not an invoice */
  deliveryStatuses: string[];
  paymentTermKeys: number[];
  /** v_finance_receivable_line.document_type_key, e.g. move:out_invoice, payment:inbound:customer */
  documentTypeKeys: string[];
  invoiceTiers: SizeTier[];
  customerTiers: SizeTier[];
}

const TIERS: readonly SizeTier[] = ['large', 'medium', 'small'];
const NONE_DELIVERY = 'none';

/** The query with its page filters cleared (snapshot and scope toggles kept): filter options never disappear because
 * of another selection. */
function withoutPageFilters(q: DebtQuery): DebtQuery {
  return { ...q, customerSearch: null, overdueStatus: 'all', agingBucketKeys: [], deliveryStatuses: [], paymentTermKeys: [], documentTypeKeys: [], invoiceTiers: [], customerTiers: [] };
}

function list(raw: unknown): string[] {
  if (raw === undefined || raw === null || raw === '') return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values.flatMap((v) => String(v).split(',')).map((v) => v.trim()).filter(Boolean);
}

function intList(raw: unknown, name: string): number[] {
  return list(raw).map((v) => {
    const n = Number(v);
    if (!Number.isInteger(n)) throw new DebtQueryError(`${name} must be integers`);
    return n;
  });
}

function bool(raw: unknown): boolean {
  return raw === true || raw === 'true' || raw === '1';
}

export function dateKeyOf(iso: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new DebtQueryError('snapshotDate must be YYYY-MM-DD');
  return Number(iso.replace(/-/g, ''));
}

export function isoOfKey(key: number | null | undefined): string | null {
  if (!key) return null;
  const s = String(key);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** Page parameters of every Debt Report endpoint (company / salesperson / team / customer keys come from
 * resolveScopedFilters, never from here). */
export function parseDebtQuery(q: Record<string, unknown>): DebtQuery {
  const overdue = (q.overdueStatus ?? 'all') as string;
  if (!['all', 'overdue', 'not_due'].includes(overdue)) throw new DebtQueryError('overdueStatus must be all, overdue or not_due');
  const tiers = (raw: unknown, name: string) =>
    list(raw).map((t) => {
      if (!TIERS.includes(t as SizeTier)) throw new DebtQueryError(`${name} must be large, medium or small`);
      return t as SizeTier;
    });
  const docTypes = list(q.documentTypeKeys);
  if (docTypes.some((d) => !/^(move|payment):[a-z_?:]+$/.test(d))) throw new DebtQueryError('documentTypeKeys are invalid');
  const search = typeof q.customerSearch === 'string' && q.customerSearch.trim() ? q.customerSearch.trim().slice(0, 100) : null;
  return {
    snapshotDateKey: typeof q.snapshotDate === 'string' && q.snapshotDate ? dateKeyOf(q.snapshotDate) : null,
    includeOther: bool(q.includeOther),
    includeIntercompany: bool(q.includeIntercompany),
    customerSearch: search,
    overdueStatus: overdue as OverdueStatus,
    agingBucketKeys: intList(q.agingBucketKeys, 'agingBucketKeys'),
    deliveryStatuses: list(q.deliveryStatuses).filter((v) => /^[a-z_]+$/.test(v)),
    paymentTermKeys: intList(q.paymentTermKeys, 'paymentTermKeys'),
    documentTypeKeys: docTypes,
    invoiceTiers: tiers(q.invoiceTiers, 'invoiceTiers'),
    customerTiers: tiers(q.customerTiers, 'customerTiers'),
  };
}

export const DEFAULT_DEBT_QUERY: DebtQuery = parseDebtQuery({});

interface Sql {
  sql: string;
  params: unknown[];
}

function inList(column: string, values: readonly unknown[], out: string[], params: unknown[]): void {
  if (!values || values.length === 0) return;
  out.push(`${column} IN (${values.map(() => '?').join(', ')})`);
  params.push(...values);
}

/** Which snapshots a source covers: one date, or every date from `from` on (the trend). */
export type SnapshotSelector = number | { from: number };

/**
 * The report exclusions (step 2): the lines of every excluded sales team -- in an excluded segment or with an excluded
 * name (cfg_finance_report_exclusion, resolved to team keys by v_finance_excluded_sales_team). Part of every query; no
 * parameter or toggle removes it.
 */
export const EXCLUDED_TEAMS_CONDITION = 'f.SalesTeamKey NOT IN (SELECT x.SalesTeamKey FROM v_finance_excluded_sales_team x)';

/**
 * Steps 1-4 (snapshot, exclusions, scope toggles, scoped filters) on the slim source's own aliases: f = the fact,
 * rs = the scope dimension, st = the line's sales team (segment), sp = its salesperson (channel).
 */
function baseConditions(snap: SnapshotSelector, q: DebtQuery, f: Filters): Sql {
  const out = [typeof snap === 'number' ? 'f.SnapshotDateKey = ?' : 'f.SnapshotDateKey >= ?', EXCLUDED_TEAMS_CONDITION];
  const params: unknown[] = [typeof snap === 'number' ? snap : snap.from];
  if (!q.includeOther) out.push('rs.is_default = 1');
  if (!q.includeIntercompany) out.push('f.is_intercompany = 0');
  inList('f.CompanyKey', f.companyKeys ?? [], out, params);
  inList('f.SalespersonKey', f.salespersonKeys ?? [], out, params);
  inList('f.SalesTeamKey', f.salesTeamKeys ?? [], out, params);
  inList('st.SegmentKey', f.segmentKeys ?? [], out, params);
  inList('sp.ChannelKey', f.channelKeys ?? [], out, params);
  inList('f.CustomerKey', f.customerKeys ?? [], out, params);
  return { sql: out.join(' AND '), params };
}

/**
 * FROM + WHERE over the receivable lines with every filter applied, exposing alias `l` with the columns the
 * aggregations and the drill-down need, plus `doc_tier` (the line's document tier) and `customer_tier` (its company +
 * customer tier).
 *
 * A slim, single-pass source on fact_finance_receivable_snapshot with only the joins the report needs (the full line
 * view carries 18 joins for its labels and costs ~20x more per scan); the tiers are window sums over steps 1-4 in the
 * same pass. Its definitions -- scope, document_type_key, segment from the team, channel from the salesperson,
 * invoice_total_signed, the exclusions -- are those of v_finance_receivable_line (0036); the DB-backed tests
 * (debtReport.db.test.ts) check both agree.
 */
export function linesSource(snap: SnapshotSelector, q: DebtQuery, f: Filters): Sql {
  const b = baseConditions(snap, q, f);
  const docTier = tierCaseSql('m.doc_amount');
  const custTier = tierCaseSql('m.customer_amount');
  const where: string[] = [];
  const params: unknown[] = [...docTier.params, ...custTier.params, ...b.params];
  if (q.customerSearch) {
    where.push('(l.customer LIKE ? OR CAST(l.CustomerKey AS CHAR) = ?)');
    params.push(`%${q.customerSearch.replace(/[\\%_]/g, (m) => `\\${m}`)}%`, q.customerSearch);
  }
  if (q.overdueStatus === 'overdue') where.push('l.days_past_due > 0');
  if (q.overdueStatus === 'not_due') where.push('l.days_past_due <= 0');
  inList('l.AgingBucketKey', q.agingBucketKeys, where, params);
  inList('l.PaymentTermKey', q.paymentTermKeys, where, params);
  inList('l.document_type_key', q.documentTypeKeys, where, params);
  if (q.deliveryStatuses.length > 0) {
    const values = q.deliveryStatuses.filter((v) => v !== NONE_DELIVERY);
    const parts: string[] = [];
    if (values.length > 0) {
      parts.push(`l.delivery_status IN (${values.map(() => '?').join(', ')})`);
      params.push(...values);
    }
    if (q.deliveryStatuses.includes(NONE_DELIVERY)) parts.push('l.delivery_status IS NULL');
    where.push(`(${parts.join(' OR ')})`);
  }
  inList('l.doc_tier', q.invoiceTiers, where, params);
  inList('l.customer_tier', q.customerTiers, where, params);
  const sql = `
    FROM (
      SELECT m.*, ${docTier.sql} AS doc_tier, ${custTier.sql} AS customer_tier
      FROM (
        SELECT f.SnapshotDateKey, f.line_id, f.move_id, i.document, DATE_FORMAT(i.invoice_date, '%Y-%m-%d') AS invoice_date,
               DATE_FORMAT(f.due_date, '%Y-%m-%d') AS due_date, f.CompanyKey, co.Company AS company, f.CustomerKey, cu.customer,
               f.SalespersonKey, sp.salesperson, sp.ChannelKey, f.SalesTeamKey, st.SalesTeam AS sales_team, st.SegmentKey,
               sg.Segment AS segment, f.PaymentTermKey, pt.payment_term, f.AgingBucketKey, f.days_past_due,
               f.CurrencyKey, cur.currency, f.residual_doc_ccy,
               CASE WHEN f.residual_doc_ccy < 0 THEN -i.amount_total ELSE i.amount_total END AS invoice_total_signed,
               f.residual_company_ccy, f.delivery_status, f.is_intercompany, f.receivable_scope, rs.is_default AS receivable_scope_is_default,
               CASE WHEN f.PaymentKey <> -1 THEN CONCAT('payment:', COALESCE(p.payment_type, '?'), ':', COALESCE(p.partner_type, '?'))
                    ELSE CONCAT('move:', COALESCE(i.move_type, '?')) END AS document_type_key,
               SUM(f.residual_company_ccy) OVER (PARTITION BY f.SnapshotDateKey, f.move_id) AS doc_amount,
               SUM(f.residual_company_ccy) OVER (PARTITION BY f.SnapshotDateKey, f.CompanyKey, f.CustomerKey) AS customer_amount
        FROM fact_finance_receivable_snapshot f
        JOIN dim_finance_receivable_scope rs ON rs.receivable_scope = f.receivable_scope
        JOIN dim_finance_invoice i ON i.move_id = f.move_id
        JOIN dim_finance_payment p ON p.PaymentKey = f.PaymentKey
        JOIN dim_customer cu ON cu.CustomerKey = f.CustomerKey
        JOIN dim_company co ON co.CompanyKey = f.CompanyKey
        JOIN dim_salesperson sp ON sp.SalespersonKey = f.SalespersonKey
        JOIN dim_sales_team st ON st.SalesTeamKey = f.SalesTeamKey
        JOIN dim_payment_term pt ON pt.PaymentTermKey = f.PaymentTermKey
        JOIN dim_currency cur ON cur.CurrencyKey = f.CurrencyKey
        LEFT JOIN dim_segment sg ON sg.SegmentKey = st.SegmentKey
        WHERE ${b.sql}
      ) m
    ) l
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  return { sql, params };
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
type Row = Record<string, any>;

async function rows(pool: Pool, sql: string, params: unknown[]): Promise<Row[]> {
  const [r] = await pool.query(sql, params);
  return r as Row[];
}

const pct = (part: number, whole: number) => (whole !== 0 ? part / whole : null);
const overdueOf = (l: Row): number => (num(l.days_past_due) > 0 ? num(l.residual_doc_ccy) : 0);

/** Currencies in display order: most open lines first (the company currency, LYD), then by code. */
function orderCurrencies(counts: Map<string, number>): string[] {
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c]) => c);
}

/** Sum of the documents' original amounts, each document once (a document with several open lines -- instalments --
 * carries the same amount on each; the lowest line id counts). */
class DocumentAmounts {
  private readonly docs = new Map<number, { lineId: number; amount: number }>();
  add(l: Row): void {
    const id = num(l.move_id);
    const cur = this.docs.get(id);
    if (!cur || num(l.line_id) < cur.lineId) this.docs.set(id, { lineId: num(l.line_id), amount: num(l.invoice_total_signed) });
  }
  get count(): number {
    return this.docs.size;
  }
  get total(): number {
    let t = 0;
    for (const d of this.docs.values()) t += d.amount;
    return t;
  }
}

// ---- snapshots ------------------------------------------------------------------------------------------------------
export interface SnapshotInfo {
  date: string;
  lineCount: number;
}

export async function fetchSnapshots(pool: Pool): Promise<SnapshotInfo[]> {
  const r = await rows(pool, 'SELECT SnapshotDateKey AS k, COUNT(*) AS n FROM fact_finance_receivable_snapshot GROUP BY SnapshotDateKey ORDER BY SnapshotDateKey', []);
  return r.map((x) => ({ date: isoOfKey(Number(x.k)) as string, lineCount: num(x.n) }));
}

/** The snapshot to read: the requested one (it must exist) or the latest. Null when there is no snapshot at all. */
export async function resolveSnapshot(pool: Pool, q: DebtQuery): Promise<number | null> {
  if (q.snapshotDateKey !== null) {
    const r = await rows(pool, 'SELECT 1 AS ok FROM fact_finance_receivable_snapshot WHERE SnapshotDateKey = ? LIMIT 1', [q.snapshotDateKey]);
    if (r.length === 0) throw new DebtQueryError(`No receivable snapshot for ${isoOfKey(q.snapshotDateKey)}`);
    return q.snapshotDateKey;
  }
  const r = await rows(pool, 'SELECT MAX(SnapshotDateKey) AS k FROM fact_finance_receivable_snapshot', []);
  return r[0]?.k ? Number(r[0].k) : null;
}

// ---- meta -----------------------------------------------------------------------------------------------------------
export interface DebtOption {
  value: string;
  labelEn: string;
  labelAr: string | null;
}

export interface DebtExclusions {
  /** cfg_finance_report_exclusion rule_type = 'segment' */
  segments: string[];
  /** cfg_finance_report_exclusion rule_type = 'sales_team' */
  salesTeams: string[];
  /** the sales teams those rules resolve to, with the rule(s) that caught each */
  teams: { salesTeamKey: string; salesTeam: string; segment: string | null; bySegment: boolean; byTeam: boolean }[];
}

export interface DebtMeta {
  snapshots: SnapshotInfo[];
  snapshotDate: string | null;
  options: {
    companies: DebtOption[];
    salespersons: DebtOption[];
    salesTeams: DebtOption[];
    currencies: DebtOption[];
    agingBuckets: (DebtOption & { isOverdue: boolean })[];
    deliveryStatuses: DebtOption[];
    paymentTerms: DebtOption[];
    documentTypes: DebtOption[];
    scopes: (DebtOption & { isDefault: boolean; description: string | null })[];
    sizeTiers: (DebtOption & { min: number | null; max: number | null })[];
  };
  exclusions: DebtExclusions;
  odooBaseUrl: string;
  topCustomers: number;
}

export async function fetchDebtExclusions(pool: Pool): Promise<DebtExclusions> {
  const cfg = await rows(pool, 'SELECT rule_type, name FROM cfg_finance_report_exclusion ORDER BY rule_type, name', []);
  const teams = await rows(
    pool,
    'SELECT SalesTeamKey, sales_team, segment, excluded_by_segment, excluded_by_team FROM v_finance_excluded_sales_team ORDER BY SalesTeamKey',
    [],
  );
  return {
    segments: cfg.filter((r) => r.rule_type === 'segment').map((r) => String(r.name)),
    salesTeams: cfg.filter((r) => r.rule_type === 'sales_team').map((r) => String(r.name)),
    teams: teams.map((t) => ({
      salesTeamKey: String(t.SalesTeamKey),
      salesTeam: String(t.sales_team),
      segment: t.segment === null || t.segment === undefined ? null : String(t.segment),
      bySegment: Boolean(Number(t.excluded_by_segment)),
      byTeam: Boolean(Number(t.excluded_by_team)),
    })),
  };
}

/** Filter options for one snapshot, within the caller's scope (role data scope / salesperson lock), the exclusions
 * and the scope toggles -- never the page filters, so an option never disappears because of another selection. */
export async function fetchDebtMeta(pool: Pool, q: DebtQuery, f: Filters): Promise<DebtMeta> {
  const snapshots = await fetchSnapshots(pool);
  const snapshotKey = await resolveSnapshot(pool, q);
  const labels = (rowsIn: Row[]): DebtOption[] =>
    rowsIn.map((r) => ({ value: String(r.v), labelEn: String(r.en ?? r.v), labelAr: r.ar === undefined || r.ar === null ? null : String(r.ar) }));
  const scopes = await rows(pool, 'SELECT receivable_scope AS v, label_en AS en, label_ar AS ar, is_default, description FROM dim_finance_receivable_scope ORDER BY sort_order', []);
  const buckets = await rows(
    pool,
    'SELECT AgingBucketKey AS v, aging_bucket AS en, is_overdue FROM dim_finance_aging_bucket WHERE AgingBucketKey > 0 ORDER BY AgingBucketKey',
    [],
  );
  const delivery = await rows(
    pool,
    "SELECT value AS v, label_en AS en, label_ar AS ar FROM dim_odoo_selection_label WHERE model = 'sale.order' AND field = 'delivery_status' ORDER BY value",
    [],
  );
  const empty = { companies: [], salespersons: [], salesTeams: [], currencies: [], paymentTerms: [], documentTypes: [] };
  let dims: Record<keyof typeof empty, DebtOption[]> = empty;
  if (snapshotKey !== null) {
    const src = linesSource(snapshotKey, withoutPageFilters(q), f);
    const combos = await rows(
      pool,
      `SELECT l.CompanyKey, MAX(l.company) AS company, l.SalespersonKey, MAX(l.salesperson) AS salesperson, l.SalesTeamKey,
              MAX(l.sales_team) AS sales_team, l.PaymentTermKey, MAX(l.payment_term) AS payment_term, l.document_type_key,
              l.currency, COUNT(*) AS n
       ${src.sql}
       GROUP BY l.CompanyKey, l.SalespersonKey, l.SalesTeamKey, l.PaymentTermKey, l.document_type_key, l.currency`,
      src.params,
    );
    const distinct = (key: string, label: string): DebtOption[] => {
      const m = new Map<string, string>();
      for (const c of combos) m.set(String(c[key]), String(c[label] ?? c[key]));
      return [...m].map(([value, labelEn]) => ({ value, labelEn, labelAr: null })).sort((a, b) => a.labelEn.localeCompare(b.labelEn));
    };
    const currencyCounts = new Map<string, number>();
    for (const c of combos) currencyCounts.set(String(c.currency), (currencyCounts.get(String(c.currency)) ?? 0) + num(c.n));
    const selection = await rows(
      pool,
      "SELECT model, field, value, label_en, label_ar FROM dim_odoo_selection_label WHERE (model = 'account.move' AND field = 'move_type') OR (model = 'account.payment' AND field IN ('payment_type', 'partner_type'))",
      [],
    );
    const lab = (model: string, field: string, value: string, lang: 'label_en' | 'label_ar'): string | null =>
      selection.find((r) => r.model === model && r.field === field && r.value === value)?.[lang] ?? null;
    // Odoo's own labels, built as v_finance_receivable_line.document_type_label_en / _ar builds them
    const docLabel = (key: string, lang: 'label_en' | 'label_ar'): string | null => {
      const [kind, a, b] = key.split(':');
      if (kind === 'move') return lab('account.move', 'move_type', a, lang);
      const parts = [lab('account.payment', 'payment_type', a, lang), lab('account.payment', 'partner_type', b, lang)].filter(Boolean);
      return parts.length ? parts.join(' / ') : null;
    };
    dims = {
      companies: distinct('CompanyKey', 'company'),
      salespersons: distinct('SalespersonKey', 'salesperson'),
      salesTeams: distinct('SalesTeamKey', 'sales_team'),
      currencies: orderCurrencies(currencyCounts).map((c) => ({ value: c, labelEn: c, labelAr: null })),
      paymentTerms: distinct('PaymentTermKey', 'payment_term'),
      documentTypes: [...new Set(combos.map((c) => String(c.document_type_key)))]
        .map((value) => ({ value, labelEn: docLabel(value, 'label_en') ?? value, labelAr: docLabel(value, 'label_ar') }))
        .sort((a, b) => a.labelEn.localeCompare(b.labelEn)),
    };
  }
  return {
    snapshots,
    snapshotDate: isoOfKey(snapshotKey),
    options: {
      ...dims,
      agingBuckets: buckets.map((r) => ({ value: String(r.v), labelEn: String(r.en), labelAr: null, isOverdue: Boolean(Number(r.is_overdue)) })),
      deliveryStatuses: [...labels(delivery), { value: NONE_DELIVERY, labelEn: 'No sales order', labelAr: 'بدون أمر بيع' }],
      scopes: scopes.map((r) => ({
        value: String(r.v),
        labelEn: String(r.en),
        labelAr: r.ar ? String(r.ar) : null,
        isDefault: Boolean(Number(r.is_default)),
        description: r.description ? String(r.description) : null,
      })),
      sizeTiers: sizeTiers().map((t) => ({ value: t.key, labelEn: t.labelEn, labelAr: t.labelAr, min: t.min, max: t.max })),
    },
    exclusions: await fetchDebtExclusions(pool),
    odooBaseUrl: odooWebBaseUrl(),
    topCustomers: DEBT_TOP_CUSTOMERS,
  };
}

// ---- overview: KPIs + charts, per currency --------------------------------------------------------------------------
export interface DebtKpis {
  openAmount: number;
  /** distinct documents with an open line: invoices, credit notes, unreconciled payments */
  openDocuments: number;
  /** distinct customers with an open line */
  customers: number;
  overdueAmount: number;
  overduePctOfOpen: number | null;
  notDueAmount: number;
  notDuePctOfOpen: number | null;
  lineCount: number;
}

export interface DebtGroupPoint {
  key: string;
  label: string;
  /** company names when the group spans companies (customers) */
  detail?: string | null;
  overdue: number;
  open: number;
  pctOfOverdue: number | null;
}

export interface DebtAgingPoint {
  agingBucketKey: number;
  label: string;
  isOverdue: boolean;
  amount: number;
  lineCount: number;
}

export interface DebtCurrencyOverview {
  currency: string;
  kpis: DebtKpis;
  aging: DebtAgingPoint[];
  topCustomers: DebtGroupPoint[];
  bySalesperson: DebtGroupPoint[];
  byTeam: DebtGroupPoint[];
}

export interface DebtOverview {
  snapshotDate: string | null;
  lineCount: number;
  /** one entry per currency with an open line, in display order */
  currencies: DebtCurrencyOverview[];
}

interface GroupAcc {
  label: string;
  details: Set<string>;
  overdue: number;
  open: number;
}

function addTo(m: Map<string, GroupAcc>, key: string, label: string, open: number, overdue: number, detail?: string): void {
  const g = m.get(key) ?? { label, details: new Set<string>(), overdue: 0, open: 0 };
  g.open += open;
  g.overdue += overdue;
  if (detail) g.details.add(detail);
  m.set(key, g);
}

interface CurrencyAcc {
  open: number;
  overdue: number;
  docs: Set<number>;
  customers: Set<number>;
  n: number;
  buckets: Map<number, { amount: number; n: number }>;
  byCustomer: Map<string, GroupAcc>;
  bySalesperson: Map<string, GroupAcc>;
  byTeam: Map<string, GroupAcc>;
}

/**
 * KPIs and charts of one snapshot, per currency. The filtered lines are read ONCE (a few thousand rows per snapshot)
 * and aggregated here. Each chart point is the sum the drill-down of that point lists (fetchDebtDrilldown): the
 * customer / salesperson / team bars are the overdue lines of the group, an aging bar every line of the bucket.
 */
export async function fetchDebtOverview(pool: Pool, q: DebtQuery, f: Filters): Promise<DebtOverview> {
  const snapshotKey = await resolveSnapshot(pool, q);
  const bucketRows = await rows(pool, 'SELECT AgingBucketKey AS k, aging_bucket AS label, is_overdue FROM dim_finance_aging_bucket WHERE AgingBucketKey > 0 ORDER BY AgingBucketKey', []);
  let lines: Row[] = [];
  if (snapshotKey !== null) {
    const s = linesSource(snapshotKey, q, f);
    lines = await rows(
      pool,
      `SELECT l.move_id, l.company, l.CustomerKey, l.customer, l.SalespersonKey, l.salesperson, l.SalesTeamKey, l.sales_team,
              l.AgingBucketKey, l.days_past_due, l.currency, l.residual_doc_ccy
       ${s.sql}`,
      s.params,
    );
  }
  const byCurrency = new Map<string, CurrencyAcc>();
  for (const l of lines) {
    const ccy = String(l.currency);
    let c = byCurrency.get(ccy);
    if (!c) {
      c = { open: 0, overdue: 0, docs: new Set(), customers: new Set(), n: 0, buckets: new Map(), byCustomer: new Map(), bySalesperson: new Map(), byTeam: new Map() };
      byCurrency.set(ccy, c);
    }
    const amount = num(l.residual_doc_ccy);
    const od = overdueOf(l);
    c.open += amount;
    c.overdue += od;
    c.n += 1;
    c.docs.add(num(l.move_id));
    c.customers.add(num(l.CustomerKey));
    const b = c.buckets.get(num(l.AgingBucketKey)) ?? { amount: 0, n: 0 };
    b.amount += amount;
    b.n += 1;
    c.buckets.set(num(l.AgingBucketKey), b);
    addTo(c.byCustomer, String(l.CustomerKey), String(l.customer), amount, od, String(l.company));
    addTo(c.bySalesperson, String(l.SalespersonKey), String(l.salesperson), amount, od);
    addTo(c.byTeam, String(l.SalesTeamKey), String(l.sales_team), amount, od);
  }
  const order = orderCurrencies(new Map([...byCurrency].map(([k, v]) => [k, v.n])));
  return {
    snapshotDate: isoOfKey(snapshotKey),
    lineCount: lines.length,
    currencies: order.map((currency) => {
      const c = byCurrency.get(currency) as CurrencyAcc;
      const notDue = c.open - c.overdue;
      const points = (m: Map<string, GroupAcc>, limit: number | null, withDetail = false): DebtGroupPoint[] =>
        [...m]
          .filter(([, g]) => Math.abs(g.overdue) >= 0.005)
          .sort((a, b) => b[1].overdue - a[1].overdue)
          .slice(0, limit ?? undefined)
          .map(([key, g]) => ({
            key,
            label: g.label,
            ...(withDetail ? { detail: [...g.details].sort().join(', ') || null } : {}),
            overdue: g.overdue,
            open: g.open,
            pctOfOverdue: pct(g.overdue, c.overdue),
          }));
      return {
        currency,
        kpis: {
          openAmount: c.open,
          openDocuments: c.docs.size,
          customers: c.customers.size,
          overdueAmount: c.overdue,
          overduePctOfOpen: pct(c.overdue, c.open),
          notDueAmount: notDue,
          notDuePctOfOpen: pct(notDue, c.open),
          lineCount: c.n,
        },
        aging: bucketRows.map((b) => ({
          agingBucketKey: num(b.k),
          label: String(b.label),
          isOverdue: Boolean(Number(b.is_overdue)),
          amount: c.buckets.get(num(b.k))?.amount ?? 0,
          lineCount: c.buckets.get(num(b.k))?.n ?? 0,
        })),
        topCustomers: points(c.byCustomer, DEBT_TOP_CUSTOMERS, true),
        bySalesperson: points(c.bySalesperson, null),
        byTeam: points(c.byTeam, null),
      };
    }),
  };
}

// ---- trend ----------------------------------------------------------------------------------------------------------
export interface DebtTrendPoint {
  snapshotDate: string;
  currency: string;
  open: number;
  overdue: number;
  notDue: number;
}

/** Open, overdue and not due per snapshot date and currency (every snapshot), the same filters; tiers are recomputed
 * per snapshot (the window sums partition by snapshot). One grouped query. A currency without lines on a snapshot
 * gets a zero point, so every currency has one point per snapshot. */
export async function fetchDebtTrend(pool: Pool, q: DebtQuery, f: Filters): Promise<{ points: DebtTrendPoint[]; currencies: string[]; snapshotCount: number }> {
  const s = linesSource({ from: 0 }, q, f);
  const r = await rows(
    pool,
    `SELECT l.SnapshotDateKey AS k, l.currency, COUNT(*) AS n, SUM(l.residual_doc_ccy) AS open_amount,
            SUM(CASE WHEN l.days_past_due > 0 THEN l.residual_doc_ccy ELSE 0 END) AS overdue
     ${s.sql}
     GROUP BY l.SnapshotDateKey, l.currency`,
    s.params,
  );
  const counts = new Map<string, number>();
  for (const x of r) counts.set(String(x.currency), (counts.get(String(x.currency)) ?? 0) + num(x.n));
  const currencies = orderCurrencies(counts);
  const byKey = new Map(r.map((x) => [`${num(x.k)}:${x.currency}`, x]));
  const snaps = await fetchSnapshots(pool);
  return {
    snapshotCount: snaps.length,
    currencies,
    points: currencies.flatMap((currency) =>
      snaps.map((sn) => {
        const x = byKey.get(`${dateKeyOf(sn.date)}:${currency}`);
        const open = num(x?.open_amount);
        const overdue = num(x?.overdue);
        return { snapshotDate: sn.date, currency, open, overdue, notDue: open - overdue };
      }),
    ),
  };
}

// ---- customers (company + customer + currency) ----------------------------------------------------------------------
export interface DebtCustomerRow {
  companyKey: number;
  company: string;
  customerKey: number;
  customer: string;
  currency: string;
  /** distinct documents with an open line: invoices, credit notes, unreconciled payments */
  openDocuments: number;
  /** their original amounts in this currency, signed like their balance (each document once) */
  invoiceAmount: number;
  open: number;
  overdue: number;
  notDue: number;
  salespersons: string[];
  salesTeams: string[];
  segments: string[];
  lineCount: number;
}

/** One row per company + customer + currency (v_finance_customer_exposure's grain), sorted by currency (display order)
 * then overdue descending. Salespeople / teams / segments list every value on the row's lines. */
export async function fetchDebtCustomers(pool: Pool, q: DebtQuery, f: Filters): Promise<{ snapshotDate: string | null; currencies: string[]; rows: DebtCustomerRow[] }> {
  const snapshotKey = await resolveSnapshot(pool, q);
  if (snapshotKey === null) return { snapshotDate: null, currencies: [], rows: [] };
  const s = linesSource(snapshotKey, q, f);
  const lines = await rows(
    pool,
    `SELECT l.line_id, l.move_id, l.CompanyKey, l.company, l.CustomerKey, l.customer, l.currency, l.days_past_due, l.residual_doc_ccy,
            l.invoice_total_signed, l.salesperson, l.sales_team, l.segment
     ${s.sql}`,
    s.params,
  );
  type Acc = Omit<DebtCustomerRow, 'openDocuments' | 'invoiceAmount' | 'salespersons' | 'salesTeams' | 'segments'> & {
    docs: DocumentAmounts;
    sp: Set<string>;
    tm: Set<string>;
    sg: Set<string>;
  };
  const groups = new Map<string, Acc>();
  const counts = new Map<string, number>();
  for (const l of lines) {
    const id = `${l.CompanyKey}:${l.CustomerKey}:${l.currency}`;
    let g = groups.get(id);
    if (!g) {
      g = {
        companyKey: num(l.CompanyKey), company: String(l.company), customerKey: num(l.CustomerKey), customer: String(l.customer),
        currency: String(l.currency), open: 0, overdue: 0, notDue: 0, lineCount: 0,
        docs: new DocumentAmounts(), sp: new Set(), tm: new Set(), sg: new Set(),
      };
      groups.set(id, g);
    }
    const amount = num(l.residual_doc_ccy);
    const od = overdueOf(l);
    g.open += amount;
    g.overdue += od;
    g.notDue += amount - od;
    g.lineCount += 1;
    g.docs.add(l);
    if (l.salesperson) g.sp.add(String(l.salesperson));
    if (l.sales_team) g.tm.add(String(l.sales_team));
    if (l.segment) g.sg.add(String(l.segment));
    counts.set(String(l.currency), (counts.get(String(l.currency)) ?? 0) + 1);
  }
  const currencies = orderCurrencies(counts);
  const rank = new Map(currencies.map((c, i) => [c, i]));
  const sorted = (x: Set<string>) => [...x].sort((a, b) => a.localeCompare(b));
  return {
    snapshotDate: isoOfKey(snapshotKey),
    currencies,
    rows: [...groups.values()]
      .sort((a, b) => (rank.get(a.currency) ?? 0) - (rank.get(b.currency) ?? 0) || b.overdue - a.overdue || b.open - a.open)
      .map(({ docs, sp, tm, sg, ...g }) => ({
        ...g,
        openDocuments: docs.count,
        invoiceAmount: docs.total,
        salespersons: sorted(sp),
        salesTeams: sorted(tm),
        segments: sorted(sg),
      })),
  };
}

// ---- drill-down -----------------------------------------------------------------------------------------------------
/**
 * What a drill-down lists, always in ONE currency:
 *   customer     the overdue lines of a customer (every company)      = its bar in "Overdue by customer"
 *   aging        every line of an aging bucket                         = its bar in "Distribution"
 *   salesperson  the overdue lines of a salesperson                    = its bar in "Overdue by salesperson"
 *   team         the overdue lines of a sales team                     = its bar in "Overdue by team"
 *   account      every line of one company + customer (key "co:cu")    = its row in the customer table
 */
export type DebtDrillKind = 'customer' | 'aging' | 'salesperson' | 'team' | 'account';

export interface DebtDrill {
  kind: DebtDrillKind;
  key: string;
  currency: string;
}

const DRILL_KINDS: readonly DebtDrillKind[] = ['customer', 'aging', 'salesperson', 'team', 'account'];

export function parseDrill(q: Record<string, unknown>): DebtDrill {
  const kind = String(q.kind ?? '') as DebtDrillKind;
  if (!DRILL_KINDS.includes(kind)) throw new DebtQueryError(`kind must be one of ${DRILL_KINDS.join(', ')}`);
  const key = typeof q.key === 'string' ? q.key.trim() : '';
  const valid =
    kind === 'team' ? /^[A-Za-z0-9_-]{1,64}$/.test(key) : kind === 'account' ? /^-?\d+:-?\d+$/.test(key) : /^-?\d+$/.test(key);
  if (!valid) throw new DebtQueryError(`key is invalid for kind ${kind}`);
  const currency = typeof q.currency === 'string' ? q.currency.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(currency)) throw new DebtQueryError('currency must be a 3-letter code');
  return { kind, key, currency };
}

function drillCondition(d: DebtDrill): Sql {
  switch (d.kind) {
    case 'customer':
      return { sql: 'd.CustomerKey = ? AND d.days_past_due > 0', params: [Number(d.key)] };
    case 'aging':
      return { sql: 'd.AgingBucketKey = ?', params: [Number(d.key)] };
    case 'salesperson':
      return { sql: 'd.SalespersonKey = ? AND d.days_past_due > 0', params: [Number(d.key)] };
    case 'team':
      return { sql: 'd.SalesTeamKey = ? AND d.days_past_due > 0', params: [d.key] };
    case 'account': {
      const [co, cu] = d.key.split(':').map(Number);
      return { sql: 'd.CompanyKey = ? AND d.CustomerKey = ?', params: [co, cu] };
    }
  }
}

export interface DebtDrillRow {
  lineId: number;
  moveId: number;
  company: string;
  document: string | null;
  documentTypeKey: string;
  invoiceDate: string | null;
  dueDate: string | null;
  /** days past the line's own due date; 0 when not yet due */
  daysOverdue: number;
  customerKey: number;
  customer: string;
  currency: string;
  /** the document's original amount in its currency, signed like its balance */
  invoiceAmount: number;
  openBalance: number;
  overdueAmount: number;
  salesperson: string;
  salesTeamKey: string;
  salesTeam: string;
  segment: string | null;
  odooUrl: string;
}

export interface DebtDrilldown {
  snapshotDate: string | null;
  drill: DebtDrill;
  rows: DebtDrillRow[];
  totals: { lines: number; openDocuments: number; invoiceAmount: number; openBalance: number; overdueAmount: number };
}

/** The open lines behind one chart point (or customer-table row), every page filter and the exclusions applied, in
 * one currency. Overdue drill-downs sum to the bar's overdue, the aging one to the bucket's open amount. The due date
 * is the line's own (an instalment's maturity). */
export async function fetchDebtDrilldown(pool: Pool, q: DebtQuery, f: Filters, d: DebtDrill): Promise<DebtDrilldown> {
  const snapshotKey = await resolveSnapshot(pool, q);
  const empty = { lines: 0, openDocuments: 0, invoiceAmount: 0, openBalance: 0, overdueAmount: 0 };
  if (snapshotKey === null) return { snapshotDate: null, drill: d, rows: [], totals: empty };
  const s = linesSource(snapshotKey, q, f);
  const c = drillCondition(d);
  const r = await rows(
    pool,
    `SELECT d.line_id, d.move_id, d.company, d.document, d.document_type_key, d.invoice_date, d.due_date, d.days_past_due,
            d.CustomerKey, d.customer, d.currency, d.invoice_total_signed, d.residual_doc_ccy, d.salesperson, d.SalesTeamKey, d.sales_team, d.segment
     FROM (SELECT l.* ${s.sql}) d
     WHERE d.currency = ? AND ${c.sql}
     ORDER BY d.days_past_due DESC, d.due_date, d.line_id`,
    [...s.params, d.currency, ...c.params],
  );
  const base = odooWebBaseUrl();
  const docs = new DocumentAmounts();
  const out: DebtDrillRow[] = r.map((x) => {
    docs.add(x);
    const days = num(x.days_past_due);
    const open = num(x.residual_doc_ccy);
    return {
      lineId: num(x.line_id),
      moveId: num(x.move_id),
      company: String(x.company),
      document: x.document ?? null,
      documentTypeKey: String(x.document_type_key),
      invoiceDate: x.invoice_date ?? null,
      dueDate: x.due_date ?? null,
      daysOverdue: Math.max(0, days),
      customerKey: num(x.CustomerKey),
      customer: String(x.customer),
      currency: String(x.currency),
      invoiceAmount: num(x.invoice_total_signed),
      openBalance: open,
      overdueAmount: days > 0 ? open : 0,
      salesperson: String(x.salesperson),
      salesTeamKey: String(x.SalesTeamKey),
      salesTeam: String(x.sales_team),
      segment: x.segment ?? null,
      odooUrl: `${base}/web#id=${num(x.move_id)}&model=account.move&view_type=form`,
    };
  });
  return {
    snapshotDate: isoOfKey(snapshotKey),
    drill: d,
    rows: out,
    totals: {
      lines: out.length,
      openDocuments: docs.count,
      invoiceAmount: docs.total,
      openBalance: out.reduce((t, x) => t + x.openBalance, 0),
      overdueAmount: out.reduce((t, x) => t + x.overdueAmount, 0),
    },
  };
}
