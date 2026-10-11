/**
 * `npm run reconcile:odoo -- [--odoo-exclude-teams 8,23,27 | --odoo-teams 3,5,9] [--snapshot 2026-10-07] [--out f.csv]` (from backend/)
 *
 * Receivables and Collections cards vs Odoo's own list, invoice by invoice. READ-ONLY on both sides: Odoo is read
 * through JSON-RPC with search_read / read_group only, MySQL with SELECTs only.
 *
 * Odoo side = exactly what Accounting > Customers > Invoices shows with the "Unpaid" filter (read from the database on
 * 2026-10-07: action account.action_move_out_invoice_type, search view account.invoice.select filter "open"):
 *     move_type = 'out_invoice'  AND  state != 'cancel'  AND  payment_state IN ('not_paid', 'partial')  AND  move_type != 'entry'
 * plus the Posted filter, state = 'posted' (decision 2026-10-08: drafts are not receivables; Unpaid alone lists them),
 * for companies ODOO_COMPANY_IDS (1 Majaal, 3 Tika), with the finance team's Sales Team filter: every team except
 * --odoo-exclude-teams (default 8 مبيعات الادارة المالية, 23 مبيعات BMH, 27 EXPORT) and never an invoice without a team
 * -- the report's own exclusions (migration 0039). --odoo-teams gives an explicit "Sales Team is in" list instead.
 * Amounts are Odoo's "Amount Due" column, amount_residual_signed (company currency, LYD), grouped by currency.
 * The draft invoices Odoo's Unpaid filter would also list are counted per team (for accounting to clean up).
 *
 * Dashboard side = the cards with the default filters and Company = All (fetchDebtCardInvoices: the cards' own SQL).
 * Odoo is read now; the cards are the latest snapshot. A record Odoo changed after the snapshot's finance run is
 * reported as "timing", so a run of this script right after a finance run should leave only real rule differences.
 *
 * Prints: totals per currency (Odoo vs cards), the team table (company x team x currency, Odoo vs every snapshot
 * invoice vs the cards, with the report's exclusion of each team), and every differing invoice grouped by reason.
 * Writes every differing invoice to the CSV (default logs/reconcile_odoo_<snapshot>.csv).
 * Exit code 0 when the cards equal Odoo (count and amount per currency), 1 otherwise.
 *
 * Odoo credentials: ODOO_URL / ODOO_DB / ODOO_USER / ODOO_API_KEY from the environment, else from ../data/etl/.env
 * (the ETL's read-only account). Refuses to run when ODOO_PROD_DB is set and differs from ODOO_DB.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { pool } from '../src/db/pool';
import { DEFAULT_DEBT_QUERY, fetchDebtCardInvoices, type DebtCardInvoice } from '../src/measures/debtReport';

// ---- arguments / settings -------------------------------------------------------------------------------------------
function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

function etlEnv(): Record<string, string> {
  const file = path.resolve(__dirname, '../../data/etl/.env');
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const ETL_ENV = etlEnv();
const setting = (name: string): string => process.env[name] ?? ETL_ENV[name] ?? '';

/** The "Unpaid" filter of Customers > Invoices, as Odoo defines it (see the header). */
export const ODOO_UNPAID_INVOICES: unknown[] = [
  ['move_type', '=', 'out_invoice'],
  ['state', '!=', 'cancel'],
  ['payment_state', 'in', ['not_paid', 'partial']],
  ['move_type', '!=', 'entry'],
];
/** The Posted filter of the same search view (state = 'posted'). */
export const ODOO_POSTED: unknown[] = [['state', '=', 'posted']];
/** The Odoo teams the finance team's filter leaves out (= the report's exclusions, 0039). */
const DEFAULT_EXCLUDED_ODOO_TEAMS = [8, 23, 27];
const MOVE_FIELDS = ['id', 'name', 'state', 'payment_state', 'company_id', 'currency_id', 'team_id', 'amount_residual',
  'amount_residual_signed', 'write_date', 'partner_id'];

// ---- read-only Odoo JSON-RPC client ---------------------------------------------------------------------------------
const READ_ONLY = new Set(['search_read', 'read_group', 'search_count', 'read', 'fields_get']);

class OdooReader {
  private uid: number | null = null;
  constructor(private readonly url: string, private readonly db: string, private readonly login: string, private readonly key: string,
              private readonly companyIds: number[]) {}

  private async rpc(service: string, method: string, args: unknown[]): Promise<any> {
    const res = await fetch(`${this.url.replace(/\/$/, '')}/jsonrpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: Date.now() }),
    });
    const body = (await res.json()) as { result?: unknown; error?: { data?: { message?: string }; message?: string } };
    if (body.error) throw new Error(`Odoo ${service}.${method}: ${body.error.data?.message ?? body.error.message}`);
    return body.result;
  }

  async call(model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}): Promise<any> {
    if (!READ_ONLY.has(method)) throw new Error(`Blocked Odoo call ${model}.${method}: this script is read-only`);
    if (this.uid === null) {
      this.uid = (await this.rpc('common', 'authenticate', [this.db, this.login, this.key, {}])) as number;
      if (!this.uid) throw new Error('Odoo login failed (ODOO_USER / ODOO_API_KEY)');
    }
    return this.rpc('object', 'execute_kw', [this.db, this.uid, this.key, model, method, args,
      { context: { allowed_company_ids: this.companyIds }, ...kwargs }]);
  }

  async searchReadAll(model: string, domain: unknown[], fields: string[]): Promise<any[]> {
    const out: any[] = [];
    for (let offset = 0; ; offset += 2000) {
      const page = (await this.call(model, 'search_read', [domain], { fields, limit: 2000, offset, order: 'id' })) as any[];
      out.push(...page);
      if (page.length < 2000) return out;
    }
  }
}

// ---- helpers --------------------------------------------------------------------------------------------------------
const m2oId = (v: unknown): number | null => (Array.isArray(v) ? Number(v[0]) : null);
const m2oName = (v: unknown): string => (Array.isArray(v) ? String(v[1]) : '(none)');
const r2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

interface OdooInvoice {
  id: number;
  name: string;
  state: string;
  paymentState: string;
  companyId: number | null;
  company: string;
  currency: string;
  teamId: number | null;
  team: string;
  partner: string;
  residualSigned: number;
  residual: number;
  writeDateUtc: string;
}

function toInvoice(r: any): OdooInvoice {
  return {
    id: Number(r.id), name: String(r.name || `(draft ${r.id})`), state: String(r.state), paymentState: String(r.payment_state),
    companyId: m2oId(r.company_id), company: m2oName(r.company_id), currency: m2oName(r.currency_id), teamId: m2oId(r.team_id),
    team: m2oName(r.team_id), partner: m2oName(r.partner_id), residualSigned: Number(r.amount_residual_signed ?? 0),
    residual: Number(r.amount_residual ?? 0), writeDateUtc: String(r.write_date ?? ''),
  };
}

interface Diff {
  reason: string;
  side: 'odoo only' | 'cards only' | 'both';
  moveId: number;
  document: string;
  company: string;
  currency: string;
  odooTeam: string;
  dashboardTeam: string;
  odooState: string;
  odooPaymentState: string;
  odooAmountDue: number | null;
  cardsAmount: number | null;
  difference: number;
}

// ---- main -----------------------------------------------------------------------------------------------------------
async function main() {
  const url = setting('ODOO_URL');
  const db = setting('ODOO_DB');
  const prodDb = setting('ODOO_PROD_DB');
  if (!url || !db || !setting('ODOO_USER') || !setting('ODOO_API_KEY')) throw new Error('ODOO_URL / ODOO_DB / ODOO_USER / ODOO_API_KEY are not set');
  if (prodDb && prodDb !== db) throw new Error(`ODOO_DB (${db}) is not ODOO_PROD_DB (${prodDb}): refusing to compare with a non-production Odoo`);
  const companyIds = (setting('ODOO_COMPANY_IDS') || '1,3').split(',').map((s) => Number(s.trim())).filter(Boolean);
  const ids = (raw: string | null) => raw?.split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0) ?? null;
  const odooTeams = ids(arg('odoo-teams'));
  const excludedTeams = odooTeams ? [] : ids(arg('odoo-exclude-teams')) ?? DEFAULT_EXCLUDED_ODOO_TEAMS;
  const inTeamFilter = (i: { teamId: number | null }) =>
    i.teamId !== null && (odooTeams ? odooTeams.includes(i.teamId) : !excludedTeams.includes(i.teamId));
  const odoo = new OdooReader(url, db, setting('ODOO_USER'), setting('ODOO_API_KEY'), companyIds);

  // dashboard: the snapshot and the cards
  const q = { ...DEFAULT_DEBT_QUERY, snapshotDateKey: arg('snapshot') ? Number(arg('snapshot')!.replace(/-/g, '')) : null };
  const cards = await fetchDebtCardInvoices(pool, q, {});
  const [snapRows] = await pool.query('SELECT MAX(SnapshotDateKey) AS k FROM fact_finance_receivable_snapshot');
  const snapshotKey = q.snapshotDateKey ?? Number((snapRows as any[])[0]?.k);
  // the moment the snapshot read Odoo: the start of the extract task of the last successful finance run of that day
  // (anything Odoo changed after it is timing; the run's finish time would be minutes too late)
  const [runRows] = await pool.query(
    `SELECT DATE_FORMAT(t.started_at_utc, '%Y-%m-%d %H:%i:%s') AS at
       FROM etl_run_log r JOIN etl_task_log t ON t.run_uid = r.run_uid AND t.task_name = 'extract_receivables'
      WHERE r.job_name = 'finance_receivables' AND r.status = 'success'
        AND DATE_FORMAT(CONVERT_TZ(r.finished_at_utc, '+00:00', '+02:00'), '%Y%m%d') = ?
      ORDER BY r.finished_at_utc DESC LIMIT 1`,
    [String(snapshotKey)],
  );
  const snapshotRunUtc: string | null = (runRows as any[])[0]?.at ?? null;
  // every customer invoice of the snapshot, before the report's exclusions and the inter-company rule
  const [allRows] = await pool.query(
    `SELECT f.move_id, MAX(i.document) AS document, MAX(co.Company) AS company, MAX(cur.currency) AS currency, MAX(f.SalesTeamKey) AS team_key,
            MAX(st.SalesTeam) AS team, MAX(sg.Segment) AS segment, MAX(f.is_intercompany) AS ic, MAX(rs.is_default) AS dflt,
            MAX(x.SalesTeamKey IS NOT NULL) AS excluded, SUM(f.residual_company_ccy) AS co
       FROM fact_finance_receivable_snapshot f
       JOIN dim_finance_invoice i ON i.move_id = f.move_id
       JOIN dim_finance_receivable_scope rs ON rs.receivable_scope = f.receivable_scope
       JOIN dim_company co ON co.CompanyKey = f.CompanyKey
       JOIN dim_currency cur ON cur.CurrencyKey = f.CurrencyKey
       JOIN dim_sales_team st ON st.SalesTeamKey = f.SalesTeamKey
       LEFT JOIN dim_segment sg ON sg.SegmentKey = st.SegmentKey
       LEFT JOIN v_finance_excluded_sales_team x ON x.SalesTeamKey = f.SalesTeamKey
      WHERE f.SnapshotDateKey = ? AND f.PaymentKey = -1 AND i.move_type = 'out_invoice'
      GROUP BY f.move_id`,
    [snapshotKey],
  );
  const snapInvoices = new Map((allRows as any[]).map((r) => [Number(r.move_id), r]));
  const [teamRows] = await pool.query(
    `SELECT st.SalesTeamKey AS k, st.SalesTeam AS name, sg.Segment AS segment, x.excluded_by_segment AS bySeg, x.excluded_by_team AS byTeam,
            x.excluded_invoices AS byInvoice
       FROM dim_sales_team st LEFT JOIN dim_segment sg ON sg.SegmentKey = st.SegmentKey
       LEFT JOIN v_finance_excluded_sales_team x ON x.SalesTeamKey = st.SalesTeamKey`,
  );
  const teams = new Map((teamRows as any[]).map((t) => [String(t.k), t]));
  // as the finance ETL maps them: a team that follows the salesperson (EXPORT) keeps its own member ODOO-TEAM-<id>
  const [mapRows] = await pool.query('SELECT odoo_team_id, SalesTeamKey, follows_salesperson FROM map_odoo_team_sales_team');
  const odooTeamToKey = new Map((mapRows as any[]).map((m) => [Number(m.odoo_team_id),
    Number(m.follows_salesperson) ? `ODOO-TEAM-${m.odoo_team_id}` : String(m.SalesTeamKey)]));
  // CompanyKey is the Odoo company id: name Odoo's companies as the dashboard does ("TIKA" in Odoo is "Tika" here)
  const [companyRows] = await pool.query('SELECT CompanyKey, Company FROM dim_company');
  const companyName = new Map((companyRows as any[]).map((c) => [Number(c.CompanyKey), String(c.Company)]));

  // Odoo: the Unpaid list (every team), then the team filter if given
  const domain = [...ODOO_UNPAID_INVOICES, ['company_id', 'in', companyIds]];
  const named = (i: OdooInvoice): OdooInvoice => ({ ...i, company: (i.companyId !== null && companyName.get(i.companyId)) || i.company });
  // every Unpaid invoice (drafts included, every team) is read once: the posted ones are the list, the drafts are counted
  const unpaid = (await odoo.searchReadAll('account.move', domain, MOVE_FIELDS)).map(toInvoice).map(named);
  const listAll = unpaid.filter((i) => i.state === 'posted');
  const drafts = unpaid.filter((i) => i.state === 'draft' && inTeamFilter(i));
  const list = listAll.filter(inTeamFilter);
  const listIds = new Set(list.map((i) => i.id));
  const cardIds = new Set(cards.map((c) => c.moveId));
  // the cards' invoices Odoo no longer lists (or lists under another team): read their current state
  const missing = cards.filter((c) => !listIds.has(c.moveId)).map((c) => c.moveId);
  const current = new Map<number, OdooInvoice>();
  for (let i = 0; i < missing.length; i += 500) {
    const page = await odoo.call('account.move', 'search_read', [[['id', 'in', missing.slice(i, i + 500)]]], { fields: MOVE_FIELDS });
    for (const r of page as any[]) current.set(Number(r.id), named(toInvoice(r)));
  }
  for (const inv of listAll) current.set(inv.id, inv);
  const changedAfterSnapshot = (inv: OdooInvoice | undefined) =>
    Boolean(inv && snapshotRunUtc && inv.writeDateUtc && inv.writeDateUtc > snapshotRunUtc);

  // ---- 1. totals per currency ----------------------------------------------------------------------------------------
  const currencies = [...new Set([...list.map((i) => i.currency), ...cards.map((c) => c.currency)])].sort((a, b) => (a === 'LYD' ? -1 : b === 'LYD' ? 1 : a.localeCompare(b)));
  console.log(`Snapshot ${snapshotKey}, read from Odoo at ${snapshotRunUtc ?? '?'} UTC. Odoo read now (${new Date().toISOString()}).`);
  console.log(`Odoo list: Customers > Invoices, Unpaid + Posted, companies ${companyIds.join(',')}, ` +
    (odooTeams ? `Sales Team in (${odooTeams.join(',')})` : `Sales Team set and not in (${excludedTeams.join(',')})`));
  const totals = currencies.map((ccy) => {
    const o = list.filter((i) => i.currency === ccy);
    const c = cards.filter((x) => x.currency === ccy);
    const oAmt = r2(o.reduce((s, i) => s + i.residualSigned, 0));
    const cAmt = r2(c.reduce((s, x) => s + x.residualCompany, 0));
    return { currency: ccy, odoo_invoices: o.length, cards_invoices: c.length, count_diff: c.length - o.length,
      odoo_amount_due_LYD: money(oAmt), cards_amount_LYD: money(cAmt), amount_diff: money(r2(cAmt - oAmt)), _o: oAmt, _c: cAmt };
  });
  const tO = r2(totals.reduce((s, t) => s + t._o, 0));
  const tC = r2(totals.reduce((s, t) => s + t._c, 0));
  console.log('\n== 1. Cards vs Odoo, per currency (amounts = Odoo Amount Due, LYD)');
  console.table([...totals.map(({ _o, _c, ...t }) => t), {
    currency: 'TOTAL', odoo_invoices: list.length, cards_invoices: cards.length, count_diff: cards.length - list.length,
    odoo_amount_due_LYD: money(tO), cards_amount_LYD: money(tC), amount_diff: money(r2(tC - tO)),
  }]);

  // ---- 2. team table -------------------------------------------------------------------------------------------------
  type Cell = { n: number; amt: number };
  const table = new Map<string, { company: string; teamKey: string; currency: string; odooTeams: Set<string>; odoo: Cell; snap: Cell; cards: Cell }>();
  const cell = (company: string, teamKey: string, currency: string) => {
    const k = `${company}|${teamKey}|${currency}`;
    let r = table.get(k);
    if (!r) {
      r = { company, teamKey, currency, odooTeams: new Set(), odoo: { n: 0, amt: 0 }, snap: { n: 0, amt: 0 }, cards: { n: 0, amt: 0 } };
      table.set(k, r);
    }
    return r;
  };
  for (const i of listAll) {
    const key = i.teamId === null ? '-1' : odooTeamToKey.get(i.teamId) ?? `odoo:${i.teamId}`;
    const r = cell(i.company, key, i.currency);
    r.odooTeams.add(i.teamId === null ? '(none)' : `${i.teamId} ${i.team}`);
    r.odoo.n += 1;
    r.odoo.amt += i.residualSigned;
  }
  for (const s of snapInvoices.values()) {
    const r = cell(String(s.company), String(s.team_key), String(s.currency));
    r.snap.n += 1;
    r.snap.amt += Number(s.co);
  }
  for (const c of cards) {
    const r = cell(c.company, c.salesTeamKey, c.currency);
    r.cards.n += 1;
    r.cards.amt += c.residualCompany;
  }
  console.log('\n== 2. Team table: company x team x currency (Odoo = Unpaid + Posted, every team; snapshot = every customer invoice; cards = after the exclusions)');
  console.table([...table.values()]
    .sort((a, b) => a.company.localeCompare(b.company) || a.teamKey.localeCompare(b.teamKey) || a.currency.localeCompare(b.currency))
    .map((r) => {
      const t = teams.get(r.teamKey);
      const excluded = [t?.bySeg ? `segment ${t.segment}` : null, t?.byTeam ? 'team name' : null, t?.byInvoice ? 'its invoices (no Odoo team)' : null]
        .filter(Boolean).join(' + ');
      return {
        company: r.company, team: r.teamKey, dashboard_team: t?.name ?? '', segment: t?.segment ?? '', excluded_today: excluded,
        odoo_teams: [...r.odooTeams].join('; '), ccy: r.currency,
        odoo_n: r.odoo.n, odoo_LYD: money(r2(r.odoo.amt)), snapshot_n: r.snap.n, snapshot_LYD: money(r2(r.snap.amt)),
        cards_n: r.cards.n, cards_LYD: money(r2(r.cards.amt)),
      };
    }));

  // ---- 3. invoice by invoice ------------------------------------------------------------------------------------------
  const diffs: Diff[] = [];
  const dashTeam = (k: string | undefined) => (k === undefined ? '' : `${k} ${teams.get(k)?.name ?? ''}`.trim());
  for (const i of list) {
    if (cardIds.has(i.id)) continue;
    const snap = snapInvoices.get(i.id);
    let reason: string;
    if (Math.abs(i.residual) < 0.005) reason = 'Odoo lists it with 0 amount due (the ETL loads only lines with an amount due)';
    else if (snap && Number(snap.excluded)) reason = 'the report excludes its team';
    else if (snap && Number(snap.ic)) reason = 'inter-company (the report leaves it out by default)';
    else if (snap && !Number(snap.dflt)) reason = 'not customer debt scope (other receivable entries)';
    else if (changedAfterSnapshot(i)) reason = 'timing: changed in Odoo after the snapshot';
    else reason = 'not in the snapshot (other)';
    diffs.push({ reason, side: 'odoo only', moveId: i.id, document: i.name, company: i.company, currency: i.currency, odooTeam: i.team,
      dashboardTeam: dashTeam(snap?.team_key), odooState: i.state, odooPaymentState: i.paymentState, odooAmountDue: i.residualSigned,
      cardsAmount: null, difference: -i.residualSigned });
  }
  for (const c of cards) {
    const o = current.get(c.moveId);
    if (listIds.has(c.moveId)) {
      const d = r2(c.residualCompany - (o?.residualSigned ?? 0));
      if (Math.abs(d) >= 0.01) {
        diffs.push({ reason: changedAfterSnapshot(o) ? 'timing: amount changed in Odoo after the snapshot' : 'amount differs (other)', side: 'both',
          moveId: c.moveId, document: c.document, company: c.company, currency: c.currency, odooTeam: o?.team ?? '',
          dashboardTeam: dashTeam(c.salesTeamKey), odooState: o?.state ?? '', odooPaymentState: o?.paymentState ?? '',
          odooAmountDue: o?.residualSigned ?? null, cardsAmount: c.residualCompany, difference: d });
      }
      continue;
    }
    let reason: string;
    if (!o) reason = 'not found in Odoo';
    else if (!inTeamFilter(o) && o.paymentState !== 'paid' && o.paymentState !== 'in_payment')
      reason = o.teamId === null ? 'no Sales Team on the invoice: Odoo\'s team filter leaves it out, the report keeps it' : 'its Odoo team is not in the Odoo team filter';
    // the snapshot only loads lines still unreconciled when it reads Odoo: paid / in payment now = paid after the read
    else if (changedAfterSnapshot(o) || o.paymentState === 'paid' || o.paymentState === 'in_payment')
      reason = `timing: now ${o.paymentState} in Odoo (changed after the snapshot)`;
    else reason = `Odoo payment_state ${o.paymentState}, state ${o.state} (not in the Unpaid list)`;
    diffs.push({ reason, side: 'cards only', moveId: c.moveId, document: c.document, company: c.company, currency: c.currency,
      odooTeam: o?.team ?? '', dashboardTeam: dashTeam(c.salesTeamKey), odooState: o?.state ?? '', odooPaymentState: o?.paymentState ?? '',
      odooAmountDue: o?.residualSigned ?? null, cardsAmount: c.residualCompany, difference: c.residualCompany });
  }
  const groups = new Map<string, { side: string; reason: string; currency: string; n: number; amt: number; sample: string[] }>();
  for (const d of diffs) {
    const k = `${d.side}|${d.reason}|${d.currency}`;
    const g = groups.get(k) ?? { side: d.side, reason: d.reason, currency: d.currency, n: 0, amt: 0, sample: [] };
    g.n += 1;
    g.amt += d.difference;
    if (g.sample.length < 3) g.sample.push(d.document);
    groups.set(k, g);
  }
  console.log('\n== 3. Differences by reason (difference = cards - Odoo, LYD)');
  console.table([...groups.values()].sort((a, b) => a.side.localeCompare(b.side) || b.n - a.n)
    .map((g) => ({ side: g.side, reason: g.reason, ccy: g.currency, invoices: g.n, difference_LYD: money(r2(g.amt)), e_g: g.sample.join(', ') })));

  // draft invoices of the filtered teams: Odoo's Unpaid filter lists them, the report never counts them
  const draftTeams = new Map<string, { n: number; zero: number; amt: number }>();
  for (const d of drafts) {
    const k = `${d.company} / ${d.team}`;
    const g = draftTeams.get(k) ?? { n: 0, zero: 0, amt: 0 };
    g.n += 1;
    g.zero += Math.abs(d.residualSigned) < 0.005 ? 1 : 0;
    g.amt += d.residualSigned;
    draftTeams.set(k, g);
  }
  console.log(`\nDraft invoices per team (Odoo Unpaid lists them, not posted, not counted here): ${drafts.length} -- ` +
    ([...draftTeams].sort((a, b) => b[1].n - a[1].n).map(([k, g]) => `${k} ${g.n}${g.zero ? ` (${g.zero} with 0 due)` : ''} = ${money(r2(g.amt))} LYD`).join('; ') || 'none'));

  const out = arg('out') ?? path.join('logs', `reconcile_odoo_${snapshotKey}.csv`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const cols: (keyof Diff)[] = ['side', 'reason', 'moveId', 'document', 'company', 'currency', 'odooTeam', 'dashboardTeam', 'odooState',
    'odooPaymentState', 'odooAmountDue', 'cardsAmount', 'difference'];
  fs.writeFileSync(out, '﻿' + [cols.join(','), ...diffs.map((d) => cols.map((c) => csvCell(d[c])).join(','))].join('\n'), 'utf8');
  console.log(`\n${diffs.length} differing invoice(s) written to ${out}`);
  const match = totals.every((t) => t.count_diff === 0 && Math.abs(t._c - t._o) < 0.005);
  const real = diffs.filter((d) => !d.reason.startsWith('timing'));
  if (match) console.log('MATCH: the cards equal Odoo per currency (count and amount)');
  else {
    console.log(`DIFFERENCE: ${diffs.length - real.length} invoice(s) changed in Odoo after the snapshot read (timing); ` +
      `not explained by timing: ${real.length} invoice(s), ${money(r2(real.reduce((x, d) => x + d.difference, 0)))} LYD`);
    if (real.length === 0) console.log('MATCH up to timing: run right after a finance run (or the Receivables Snapshot) for an exact match');
  }
  return match || real.length === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 2;
  })
  .finally(() => pool.end());

export type { DebtCardInvoice };
