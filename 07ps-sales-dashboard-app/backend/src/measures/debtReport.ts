/**
 * Debt Report (Finance / Price department): open customer receivables from the daily snapshot
 * (fact_finance_receivable_snapshot, loaded by the ETL job finance_receivables at 06:30 Africa/Tripoli).
 *
 * Every query reads v_finance_receivable_line (0034: every snapshot, every receivable scope, inter-company
 * included, Odoo labels in English and Arabic) and applies, in this order:
 *   1. the snapshot date (default: the latest);
 *   2. the receivable scope: customer debt only by default; `includeOther` adds other receivable entries
 *      (outbound customer payments, journal entries without an invoice); `includeIntercompany` adds inter-company
 *      lines (own companies' partners + FINANCE_INTERCOMPANY_PARTNER_IDS). Both on = Odoo's Aged Receivable;
 *   3. the caller's scoped filters (routes go through resolveScopedFilters: role data scope + salesperson lock --
 *      a salesperson only ever sees lines whose SalespersonKey is their own). Segment = the line's sales team's
 *      segment and channel = its salesperson's channel, the same rule the sales lines use;
 *   4. the page filters (customer search, overdue status, aging bucket, delivery status, payment term, document type,
 *      invoice / customer size tier).
 * With the defaults (latest snapshot, customer debt, no inter-company, no filter) the figures equal the views
 * v_finance_receivable_latest, v_finance_customer_exposure and v_finance_receivable_trend.
 *
 * Size tiers (config/finance.ts) are computed at query time: a document's from the sum of its open lines, a
 * customer's from its open balance per company, on steps 1-3 (so a page filter never changes a tier).
 * Amounts are in company currency (LYD); residual_doc_ccy is in the document currency.
 */
import type { Pool } from 'mysql2/promise';
import { DEBT_CHANGE_WINDOWS, DEBT_SALES_WINDOW_DAYS, DEBT_TOP_CUSTOMERS, odooWebBaseUrl, sizeTiers, tierCaseSql, type SizeTier } from '../config/finance';
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

function addDays(key: number, days: number): number {
  const s = String(key);
  const d = new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8))));
  d.setUTCDate(d.getUTCDate() + days);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
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
 * Steps 1-3 (snapshot, scope toggles, scoped filters) on the slim source's own aliases: f = the fact, rs = the scope
 * dimension, st = the line's sales team (segment), sp = its salesperson (channel).
 */
function baseConditions(snap: SnapshotSelector, q: DebtQuery, f: Filters): Sql {
  const out = [typeof snap === 'number' ? 'f.SnapshotDateKey = ?' : 'f.SnapshotDateKey >= ?'];
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
 * FROM + WHERE over the receivable lines with every filter applied, exposing alias `l` with the columns of
 * v_finance_receivable_line the aggregations need, plus `doc_tier` (the line's document tier) and `customer_tier`
 * (its company + customer tier).
 *
 * A slim, single-pass source on fact_finance_receivable_snapshot with only the joins the filters need (the full line
 * view carries 16 joins for its labels and costs ~20x more per scan); the tiers are window sums over steps 1-3 in the
 * same pass. Its definitions -- scope, document_type_key, segment from the team, channel from the salesperson -- are
 * those of v_finance_receivable_line (0034); the DB-backed tests (debtReport.db.test.ts) check both agree.
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
        SELECT f.SnapshotDateKey, f.line_id, f.move_id, f.CompanyKey, co.Company AS company, f.CustomerKey, cu.customer,
               f.SalespersonKey, sp.salesperson, sp.ChannelKey, f.SalesTeamKey, st.SalesTeam AS sales_team, st.SegmentKey,
               f.PaymentTermKey, pt.payment_term, f.AgingBucketKey, f.days_past_due, f.residual_company_ccy, f.delivery_status,
               f.is_intercompany, f.receivable_scope, rs.is_default AS receivable_scope_is_default,
               CASE WHEN f.PaymentKey <> -1 THEN CONCAT('payment:', COALESCE(p.payment_type, '?'), ':', COALESCE(p.partner_type, '?'))
                    ELSE CONCAT('move:', COALESCE(i.move_type, '?')) END AS document_type_key,
               cc.credit_limit AS customer_credit_limit,
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
        LEFT JOIN dim_customer_company cc ON cc.CustomerKey = f.CustomerKey AND cc.CompanyKey = f.CompanyKey
        WHERE ${b.sql}
      ) m
    ) l
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  return { sql, params };
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
type Row = Record<string, any>;

async function rows(pool: Pool, sql: string, params: unknown[]): Promise<Row[]> {
  const [r] = await pool.query(sql, params);
  return r as Row[];
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

export interface Comparison {
  days: number;
  /** the snapshot compared with: the latest one on or before (snapshot - days); null while there is none */
  comparedWith: string | null;
  /** first date the comparison can be made (first snapshot + days) */
  availableFrom: string | null;
}

async function comparisons(pool: Pool, snapshotKey: number): Promise<{ c: Comparison; key: number | null }[]> {
  const first = (await rows(pool, 'SELECT MIN(SnapshotDateKey) AS k FROM fact_finance_receivable_snapshot', []))[0]?.k;
  const out = [];
  for (const days of DEBT_CHANGE_WINDOWS) {
    const target = addDays(snapshotKey, -days);
    const r = await rows(pool, 'SELECT MAX(SnapshotDateKey) AS k FROM fact_finance_receivable_snapshot WHERE SnapshotDateKey <= ?', [target]);
    const key = r[0]?.k ? Number(r[0].k) : null;
    out.push({ c: { days, comparedWith: isoOfKey(key), availableFrom: first ? isoOfKey(addDays(Number(first), days)) : null }, key });
  }
  return out;
}

// ---- meta -----------------------------------------------------------------------------------------------------------
export interface DebtOption {
  value: string;
  labelEn: string;
  labelAr: string | null;
}

export interface DebtMeta {
  snapshots: SnapshotInfo[];
  snapshotDate: string | null;
  options: {
    companies: DebtOption[];
    salespersons: DebtOption[];
    salesTeams: DebtOption[];
    agingBuckets: (DebtOption & { isOverdue: boolean })[];
    deliveryStatuses: DebtOption[];
    paymentTerms: DebtOption[];
    documentTypes: DebtOption[];
    scopes: (DebtOption & { isDefault: boolean; description: string | null })[];
    sizeTiers: (DebtOption & { min: number | null; max: number | null })[];
  };
  odooBaseUrl: string;
  topCustomers: number;
  changeWindows: readonly number[];
  salesWindowDays: number;
}

/** Filter options for one snapshot, within the caller's scope (role data scope / salesperson lock) and the scope
 * toggles -- never the page filters, so an option never disappears because of another selection. */
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
  const empty = { companies: [], salespersons: [], salesTeams: [], paymentTerms: [], documentTypes: [] };
  let dims: Record<keyof typeof empty, DebtOption[]> = empty;
  if (snapshotKey !== null) {
    const src = linesSource(snapshotKey, withoutPageFilters(q), f);
    const combos = await rows(
      pool,
      `SELECT l.CompanyKey, MAX(l.company) AS company, l.SalespersonKey, MAX(l.salesperson) AS salesperson, l.SalesTeamKey,
              MAX(l.sales_team) AS sales_team, l.PaymentTermKey, MAX(l.payment_term) AS payment_term, l.document_type_key
       ${src.sql}
       GROUP BY l.CompanyKey, l.SalespersonKey, l.SalesTeamKey, l.PaymentTermKey, l.document_type_key`,
      src.params,
    );
    const distinct = (key: string, label: string): DebtOption[] => {
      const m = new Map<string, string>();
      for (const c of combos) m.set(String(c[key]), String(c[label] ?? c[key]));
      return [...m].map(([value, labelEn]) => ({ value, labelEn, labelAr: null })).sort((a, b) => a.labelEn.localeCompare(b.labelEn));
    };
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
    odooBaseUrl: odooWebBaseUrl(),
    topCustomers: DEBT_TOP_CUSTOMERS,
    changeWindows: DEBT_CHANGE_WINDOWS,
    salesWindowDays: DEBT_SALES_WINDOW_DAYS,
  };
}

// ---- overview: KPIs + charts ----------------------------------------------------------------------------------------
export interface DebtKpis {
  openAmount: number;
  overdueAmount: number;
  overduePctOfOpen: number | null;
  overdueDocuments: number;
  customersOverdue: number;
  overdue90Plus: number;
  customersOverCreditLimit: number;
  customersWithCreditLimit: number;
  overdueChange: (Comparison & { previousOverdue: number | null; change: number | null })[];
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

export interface DebtOverview {
  snapshotDate: string | null;
  kpis: DebtKpis;
  aging: DebtAgingPoint[];
  topCustomers: DebtGroupPoint[];
  bySalesperson: DebtGroupPoint[];
  byTeam: DebtGroupPoint[];
}

async function overdueTotal(pool: Pool, snapshotKey: number, q: DebtQuery, f: Filters): Promise<number> {
  const s = linesSource(snapshotKey, q, f);
  const r = await rows(pool, `SELECT SUM(CASE WHEN l.days_past_due > 0 THEN l.residual_company_ccy ELSE 0 END) AS overdue ${s.sql}`, s.params);
  return num(r[0]?.overdue);
}

const pct = (part: number, whole: number) => (whole !== 0 ? part / whole : null);

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

/**
 * KPIs and charts of one snapshot. The filtered lines are read ONCE (a few thousand rows per snapshot) and aggregated
 * here; overdue = days_past_due > 0 (due today is not overdue). An overdue document / customer is one whose overdue
 * lines net to a positive amount (credit notes and payments net against the invoices).
 */
export async function fetchDebtOverview(pool: Pool, q: DebtQuery, f: Filters): Promise<DebtOverview> {
  const snapshotKey = await resolveSnapshot(pool, q);
  const bucketRows = await rows(pool, 'SELECT AgingBucketKey AS k, aging_bucket AS label, is_overdue FROM dim_finance_aging_bucket WHERE AgingBucketKey > 0 ORDER BY AgingBucketKey', []);
  let lines: Row[] = [];
  if (snapshotKey !== null) {
    const s = linesSource(snapshotKey, q, f);
    lines = await rows(
      pool,
      `SELECT l.move_id, l.CompanyKey, l.company, l.CustomerKey, l.customer, l.SalespersonKey, l.salesperson, l.SalesTeamKey,
              l.sales_team, l.AgingBucketKey, l.days_past_due, l.residual_company_ccy, l.customer_credit_limit
       ${s.sql}`,
      s.params,
    );
  }
  let open = 0;
  let overdue = 0;
  let overdue90 = 0;
  const docs = new Map<number, number>();
  const customers = new Map<string, { open: number; overdue: number; limit: number }>();
  const buckets = new Map<number, { amount: number; n: number }>();
  const byCustomer = new Map<string, GroupAcc>();
  const bySalesperson = new Map<string, GroupAcc>();
  const byTeam = new Map<string, GroupAcc>();
  for (const l of lines) {
    const amount = num(l.residual_company_ccy);
    const days = num(l.days_past_due);
    const od = days > 0 ? amount : 0;
    open += amount;
    overdue += od;
    if (days > 90) overdue90 += amount;
    docs.set(num(l.move_id), (docs.get(num(l.move_id)) ?? 0) + od);
    const ck = `${l.CompanyKey}:${l.CustomerKey}`;
    const c = customers.get(ck) ?? { open: 0, overdue: 0, limit: num(l.customer_credit_limit) };
    c.open += amount;
    c.overdue += od;
    customers.set(ck, c);
    const b = buckets.get(num(l.AgingBucketKey)) ?? { amount: 0, n: 0 };
    b.amount += amount;
    b.n += 1;
    buckets.set(num(l.AgingBucketKey), b);
    addTo(byCustomer, String(l.CustomerKey), String(l.customer), amount, od, String(l.company));
    addTo(bySalesperson, String(l.SalespersonKey), String(l.salesperson), amount, od);
    addTo(byTeam, String(l.SalesTeamKey), String(l.sales_team), amount, od);
  }
  const changes: DebtKpis['overdueChange'] = [];
  if (snapshotKey !== null) {
    for (const { c, key } of await comparisons(pool, snapshotKey)) {
      const previous = key !== null ? await overdueTotal(pool, key, q, f) : null;
      changes.push({ ...c, previousOverdue: previous, change: previous === null ? null : overdue - previous });
    }
  }
  const custs = [...customers.values()];
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
        pctOfOverdue: pct(g.overdue, overdue),
      }));
  return {
    snapshotDate: isoOfKey(snapshotKey),
    kpis: {
      openAmount: open,
      overdueAmount: overdue,
      overduePctOfOpen: pct(overdue, open),
      overdueDocuments: [...docs.values()].filter((v) => v > 0.005).length,
      customersOverdue: custs.filter((c) => c.overdue > 0.005).length,
      overdue90Plus: overdue90,
      customersOverCreditLimit: custs.filter((c) => c.limit > 0 && c.open > c.limit).length,
      customersWithCreditLimit: custs.filter((c) => c.limit > 0).length,
      overdueChange: changes,
      lineCount: lines.length,
    },
    aging: bucketRows.map((b) => ({
      agingBucketKey: num(b.k),
      label: String(b.label),
      isOverdue: Boolean(Number(b.is_overdue)),
      amount: buckets.get(num(b.k))?.amount ?? 0,
      lineCount: buckets.get(num(b.k))?.n ?? 0,
    })),
    topCustomers: points(byCustomer, DEBT_TOP_CUSTOMERS, true),
    bySalesperson: points(bySalesperson, null),
    byTeam: points(byTeam, null),
  };
}

// ---- trend ----------------------------------------------------------------------------------------------------------
export interface DebtTrendPoint {
  snapshotDate: string;
  open: number;
  overdue: number;
}

/** Open and overdue per snapshot date (every snapshot), the same filters; tiers are recomputed per snapshot (the
 * window sums partition by snapshot). One grouped query. */
export async function fetchDebtTrend(pool: Pool, q: DebtQuery, f: Filters): Promise<{ points: DebtTrendPoint[]; snapshotCount: number }> {
  const s = linesSource({ from: 0 }, q, f);
  const r = await rows(
    pool,
    `SELECT l.SnapshotDateKey AS k, SUM(l.residual_company_ccy) AS open_amount,
            SUM(CASE WHEN l.days_past_due > 0 THEN l.residual_company_ccy ELSE 0 END) AS overdue
     ${s.sql}
     GROUP BY l.SnapshotDateKey`,
    s.params,
  );
  const byKey = new Map(r.map((x) => [num(x.k), x]));
  const snaps = await fetchSnapshots(pool);
  return {
    snapshotCount: snaps.length,
    points: snaps.map((sn) => {
      const x = byKey.get(dateKeyOf(sn.date));
      return { snapshotDate: sn.date, open: num(x?.open_amount), overdue: num(x?.overdue) };
    }),
  };
}

// ---- customer exposure ----------------------------------------------------------------------------------------------
export interface DebtCustomerRow {
  companyKey: number;
  company: string;
  customerKey: number;
  customer: string;
  open: number;
  overdue: number;
  overdue90Plus: number;
  creditLimit: number | null;
  overCreditLimit: boolean;
  oldestOverdueDays: number | null;
  salesLast90d: number;
  dsoDays: number | null;
  change7d: number | null;
  change30d: number | null;
  customerTier: SizeTier;
  lineCount: number;
}

/**
 * One row per company + customer (v_finance_customer_exposure's grain), default sort overdue descending.
 * sales_last_90d / DSO come from fact_sales_lines of the same company + customer in the 90 days up to the snapshot
 * date, restricted by the caller's SECURITY scope only (salesperson lock / role data scope: `security`) -- a page
 * filter on the receivables does not change a customer's sales.
 */
export async function fetchDebtCustomers(pool: Pool, q: DebtQuery, f: Filters, security: Filters): Promise<{ snapshotDate: string | null; rows: DebtCustomerRow[]; changes: Comparison[] }> {
  const snapshotKey = await resolveSnapshot(pool, q);
  if (snapshotKey === null) return { snapshotDate: null, rows: [], changes: [] };
  const s = linesSource(snapshotKey, q, f);
  const salesWhere: string[] = ['sl.DateKey > ?', 'sl.DateKey <= ?'];
  const salesParams: unknown[] = [addDays(snapshotKey, -DEBT_SALES_WINDOW_DAYS), snapshotKey];
  inList('sl.CompanyKey', security.companyKeys ?? [], salesWhere, salesParams);
  inList('sl.SalespersonKey', security.salespersonKeys ?? [], salesWhere, salesParams);
  inList('sl.SalesTeamKey', security.salesTeamKeys ?? [], salesWhere, salesParams);
  inList('sl.SegmentKey', security.segmentKeys ?? [], salesWhere, salesParams);
  inList('sl.ChannelKey', security.channelKeys ?? [], salesWhere, salesParams);
  const r = await rows(
    pool,
    `SELECT x.*, COALESCE(sa.sales, 0) AS sales_last_90d
     FROM (SELECT l.CompanyKey, MAX(l.company) AS company, l.CustomerKey, MAX(l.customer) AS customer,
                  SUM(l.residual_company_ccy) AS open_amount,
                  SUM(CASE WHEN l.days_past_due > 0 THEN l.residual_company_ccy ELSE 0 END) AS overdue,
                  SUM(CASE WHEN l.days_past_due > 90 THEN l.residual_company_ccy ELSE 0 END) AS overdue_90,
                  MAX(CASE WHEN l.days_past_due > 0 THEN l.days_past_due END) AS oldest_overdue_days,
                  MAX(l.customer_credit_limit) AS credit_limit, MAX(l.customer_tier) AS customer_tier, COUNT(*) AS n
           ${s.sql}
           GROUP BY l.CompanyKey, l.CustomerKey) x
     LEFT JOIN (SELECT sl.CompanyKey, sl.CustomerKey, SUM(sl.Value) AS sales FROM fact_sales_lines sl
                WHERE ${salesWhere.join(' AND ')} GROUP BY sl.CompanyKey, sl.CustomerKey) sa
       ON sa.CompanyKey = x.CompanyKey AND sa.CustomerKey = x.CustomerKey
     ORDER BY x.overdue DESC, x.open_amount DESC`,
    [...s.params, ...salesParams],
  );
  const comps = await comparisons(pool, snapshotKey);
  const previous: Map<string, number>[] = [];
  for (const { key } of comps) {
    const m = new Map<string, number>();
    if (key !== null) {
      const p = linesSource(key, q, f);
      for (const x of await rows(
        pool,
        `SELECT l.CompanyKey AS co, l.CustomerKey AS cu, SUM(CASE WHEN l.days_past_due > 0 THEN l.residual_company_ccy ELSE 0 END) AS overdue
         ${p.sql} GROUP BY l.CompanyKey, l.CustomerKey`,
        p.params,
      )) {
        m.set(`${x.co}:${x.cu}`, num(x.overdue));
      }
    }
    previous.push(m);
  }
  const change = (i: number, id: string, overdue: number) => (comps[i].key === null ? null : overdue - (previous[i].get(id) ?? 0));
  return {
    snapshotDate: isoOfKey(snapshotKey),
    changes: comps.map((c) => c.c),
    rows: r.map((x) => {
      const open = num(x.open_amount);
      const overdue = num(x.overdue);
      const limit = numOrNull(x.credit_limit);
      const sales = num(x.sales_last_90d);
      const id = `${x.CompanyKey}:${x.CustomerKey}`;
      return {
        companyKey: num(x.CompanyKey),
        company: String(x.company),
        customerKey: num(x.CustomerKey),
        customer: String(x.customer),
        open,
        overdue,
        overdue90Plus: num(x.overdue_90),
        creditLimit: limit !== null && limit > 0 ? limit : null,
        overCreditLimit: limit !== null && limit > 0 && open > limit,
        oldestOverdueDays: numOrNull(x.oldest_overdue_days),
        salesLast90d: sales,
        dsoDays: sales > 0 ? (open / sales) * DEBT_SALES_WINDOW_DAYS : null,
        change7d: change(0, id, overdue),
        change30d: change(1, id, overdue),
        customerTier: x.customer_tier as SizeTier,
        lineCount: num(x.n),
      };
    }),
  };
}

// ---- documents (drill-down) -----------------------------------------------------------------------------------------
export interface DebtDocumentRow {
  lineId: number;
  moveId: number;
  document: string | null;
  documentTypeKey: string;
  documentTypeLabelEn: string | null;
  documentTypeLabelAr: string | null;
  journalEn: string | null;
  journalAr: string | null;
  receivableScope: string;
  isIntercompany: boolean;
  company: string;
  invoiceDate: string | null;
  dueDate: string | null;
  daysPastDue: number;
  agingBucketKey: number;
  agingBucket: string;
  residualCompanyCcy: number;
  companyCurrency: string | null;
  residualDocCcy: number | null;
  docCurrency: string | null;
  paymentTerm: string | null;
  salesperson: string | null;
  salespersonSource: string;
  salesTeam: string | null;
  deliveryStatus: string | null;
  deliveryStatusLabelEn: string | null;
  deliveryStatusLabelAr: string | null;
  paymentStateLabelEn: string | null;
  paymentStateLabelAr: string | null;
  invoiceTier: SizeTier;
  odooUrl: string;
}

/** The open lines of one customer (optionally one company), every filter applied; the due date is the line's own
 * (an instalment's maturity), never the invoice's last due date. */
export async function fetchDebtDocuments(pool: Pool, q: DebtQuery, f: Filters, customerKey: number): Promise<{ snapshotDate: string | null; rows: DebtDocumentRow[] }> {
  const snapshotKey = await resolveSnapshot(pool, q);
  if (snapshotKey === null) return { snapshotDate: null, rows: [] };
  const s = linesSource(snapshotKey, q, { ...f, customerKeys: [customerKey] });
  const base = odooWebBaseUrl();
  const r = await rows(
    pool,
    `SELECT v.line_id, v.move_id, v.document, v.document_type_key, v.document_type_label_en, v.document_type_label_ar,
            v.payment_journal_en, v.payment_journal_ar, v.receivable_scope, v.is_intercompany, v.company,
            DATE_FORMAT(v.invoice_date, '%Y-%m-%d') AS invoice_date, DATE_FORMAT(v.due_date, '%Y-%m-%d') AS due_date,
            v.days_past_due, v.AgingBucketKey, v.aging_bucket, v.residual_company_ccy, v.company_currency, v.residual_doc_ccy, v.doc_currency,
            v.payment_term, v.salesperson, v.salesperson_source, v.sales_team, v.delivery_status, v.delivery_status_label_en,
            v.delivery_status_label_ar, v.payment_state_label_en, v.payment_state_label_ar, f.doc_tier
     FROM (SELECT l.SnapshotDateKey, l.line_id, l.doc_tier ${s.sql}) f
     JOIN v_finance_receivable_line v ON v.SnapshotDateKey = f.SnapshotDateKey AND v.line_id = f.line_id
     ORDER BY v.days_past_due DESC, v.due_date, v.line_id`,
    s.params,
  );
  return {
    snapshotDate: isoOfKey(snapshotKey),
    rows: r.map((x) => ({
      lineId: num(x.line_id),
      moveId: num(x.move_id),
      document: x.document ?? null,
      documentTypeKey: String(x.document_type_key),
      documentTypeLabelEn: x.document_type_label_en ?? null,
      documentTypeLabelAr: x.document_type_label_ar ?? null,
      journalEn: x.payment_journal_en ?? null,
      journalAr: x.payment_journal_ar ?? null,
      receivableScope: String(x.receivable_scope),
      isIntercompany: Boolean(Number(x.is_intercompany)),
      company: String(x.company),
      invoiceDate: x.invoice_date ?? null,
      dueDate: x.due_date ?? null,
      daysPastDue: num(x.days_past_due),
      agingBucketKey: num(x.AgingBucketKey),
      agingBucket: String(x.aging_bucket),
      residualCompanyCcy: num(x.residual_company_ccy),
      companyCurrency: x.company_currency ?? null,
      residualDocCcy: numOrNull(x.residual_doc_ccy),
      docCurrency: x.doc_currency ?? null,
      paymentTerm: x.payment_term ?? null,
      salesperson: x.salesperson ?? null,
      salespersonSource: String(x.salesperson_source),
      salesTeam: x.sales_team ?? null,
      deliveryStatus: x.delivery_status ?? null,
      deliveryStatusLabelEn: x.delivery_status_label_en ?? null,
      deliveryStatusLabelAr: x.delivery_status_label_ar ?? null,
      paymentStateLabelEn: x.payment_state_label_en ?? null,
      paymentStateLabelAr: x.payment_state_label_ar ?? null,
      invoiceTier: x.doc_tier as SizeTier,
      odooUrl: `${base}/web#id=${num(x.move_id)}&model=account.move&view_type=form`,
    })),
  };
}
