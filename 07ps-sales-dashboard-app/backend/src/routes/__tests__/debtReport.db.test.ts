import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Debt Report against a REAL warehouse (read-only: SELECT only). Opt-in:
 *
 *   DEBT_TEST_DB=1 DB_HOST=... DB_USER=... DB_PASSWORD=... DB_NAME=powerBI_Data npx vitest run -c vitest.debt-db.config.ts
 *
 * Needs migration 0036 (cfg_finance_report_exclusion, v_finance_excluded_sales_team and the per-currency views).
 *
 * The real router, scope middleware and pool; only the signed-in user and their grants are faked (no app_user row is
 * written). Every expectation is computed here with its own SQL on the views, independently of measures/debtReport.ts,
 * and every amount is compared PER CURRENCY (residual_doc_ccy):
 *   - the exclusion config: each configured segment / team name exists (exact bytes) and resolves to exactly its teams;
 *   - (a) no line of an excluded segment or team reaches any endpoint, even with both toggles on or the teams asked for;
 *   - (b) overdue + not yet due = open in every currency, on the KPIs and the trend;
 *   - (c) every bar of the four charts, and customer-table rows, equal the sum of their drill-down;
 *   - defaults (latest snapshot, customer debt, no inter-company) = v_finance_receivable_latest / _customer_exposure /
 *     _trend; every filter = the same condition on v_finance_receivable_line;
 *   - the scope toggles add exactly the other-receivable and inter-company lines; all on + excluded = the fact total;
 *   - a salesperson (role enabled) sees exactly their own lines, gets 403 for another salesperson and 403 while the
 *     role is not enabled.
 */
const RUN = process.env.DEBT_TEST_DB === '1';

type Grant = [string, string];
const USERS: Record<string, { isAdmin?: boolean; tier: string; salespersonKey?: number | null; grants: Grant[] }> = {
  admin: { isAdmin: true, tier: 'BI00_EXECUTIVE', grants: [] },
  salesperson: { tier: 'SALESPERSON', salespersonKey: null, grants: [['tachometer', 'view']] },
  salespersonEnabled: { tier: 'SALESPERSON', salespersonKey: null, grants: [['debt_report', 'view']] },
};

vi.mock('../../middleware/auth', () => ({
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const u = USERS[req.header('x-test-user') ?? ''];
    if (!u) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    req.user = {
      id: 100, email: 't@test.local', fullName: 't', status: 'ACTIVE', mustChangePassword: false, roleId: null, roleName: null,
      roleLabel: null, roles: [], isAdmin: u.isAdmin === true, roleTierCode: u.tier, salespersonKey: u.salespersonKey ?? null,
      companyScope: 'ALL', jti: 'j',
    } as unknown as express.Request['user'];
    next();
  },
}));
vi.mock('../../services/permissionService', async () => {
  const actual = await vi.importActual<typeof import('../../services/permissionService')>('../../services/permissionService');
  return {
    ...actual,
    getRequestPermissions: async (req: express.Request) => {
      const u = USERS[req.header('x-test-user') ?? ''];
      return actual.computeEffectivePermissions({
        isAdmin: u?.isAdmin === true,
        roleGrants: (u?.grants ?? []).map(([page_key, action]) => ({ page_key, action: action as never, allowed: 1 })),
        overrides: [],
      });
    },
  };
});

let server: Server;
let base = '';
let pool: typeof import('../../db/pool').pool;
let snap = 0;
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const get = async (path: string, who = 'admin'): Promise<{ status: number; body: Json }> => {
  const res = await fetch(`${base}${path}`, { headers: { 'x-test-user': who } });
  return { status: res.status, body: await res.json() };
};
const q1 = async (sql: string, params: unknown[] = []): Promise<Json> => ((await pool.query(sql, params))[0] as Json[])[0];
const qa = async (sql: string, params: unknown[] = []): Promise<Json[]> => (await pool.query(sql, params))[0] as Json[];
const n = (v: unknown) => Number(v ?? 0);
const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(0.005);

/** Per-currency totals on the line view: the same conditions the page means, written independently. */
type Totals = Map<string, { open: number; overdue: number; lines: number }>;
async function direct(where: string, params: unknown[] = []): Promise<Totals> {
  const r = await qa(
    `SELECT doc_currency AS c, SUM(residual_doc_ccy) AS open_amount,
            SUM(CASE WHEN days_past_due > 0 THEN residual_doc_ccy ELSE 0 END) AS overdue, COUNT(*) AS n
     FROM v_finance_receivable_line WHERE SnapshotDateKey = ? AND ${where} GROUP BY doc_currency`,
    [snap, ...params],
  );
  return new Map(r.map((x) => [String(x.c), { open: n(x.open_amount), overdue: n(x.overdue), lines: n(x.n) }]));
}
/** The overview's per-currency KPIs in the same shape. */
const kpiTotals = (body: Json): Totals =>
  new Map(body.currencies.map((c: Json) => [c.currency, { open: c.kpis.openAmount, overdue: c.kpis.overdueAmount, lines: c.kpis.lineCount }]));
function sameTotals(got: Totals, want: Totals, label: string) {
  expect([...got.keys()].sort(), label).toEqual([...want.keys()].sort());
  for (const [c, w] of want) {
    const g = got.get(c)!;
    expect(g.lines, `${label} ${c} lines`).toBe(w.lines);
    expect(Math.abs(g.open - w.open), `${label} ${c} open`).toBeLessThan(0.005);
    expect(Math.abs(g.overdue - w.overdue), `${label} ${c} overdue`).toBeLessThan(0.005);
  }
}
const KEPT = 'is_report_excluded = 0';
const DEFAULT = `receivable_scope = 'customer_debt' AND is_intercompany = 0 AND ${KEPT}`;
const tier = (expr: string) => `CASE WHEN ${expr} >= 100000 THEN 'large' WHEN ${expr} >= 10000 THEN 'medium' ELSE 'small' END`;

describe.skipIf(!RUN)('Debt Report on the real warehouse (read-only)', () => {
  let excludedTeamKeys: Set<string>;
  let excludedSegments: Set<string>;

  beforeAll(async () => {
    ({ pool } = await import('../../db/pool'));
    const { debtReportRouter } = await import('../debtReport');
    const app = express();
    app.use('/debt-report', debtReportRouter);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    snap = n((await q1('SELECT MAX(SnapshotDateKey) AS k FROM fact_finance_receivable_snapshot')).k);
    const sp = await q1(
      `SELECT SalespersonKey AS k FROM v_finance_receivable_line WHERE SnapshotDateKey = ? AND ${DEFAULT} AND SalespersonKey > 0
       GROUP BY SalespersonKey ORDER BY COUNT(*) DESC LIMIT 1`,
      [snap],
    );
    USERS.salesperson.salespersonKey = n(sp.k);
    USERS.salespersonEnabled.salespersonKey = n(sp.k);
    const x = await qa('SELECT SalesTeamKey FROM v_finance_excluded_sales_team');
    excludedTeamKeys = new Set(x.map((r) => String(r.SalesTeamKey)));
    excludedSegments = new Set((await qa("SELECT name FROM cfg_finance_report_exclusion WHERE rule_type = 'segment'")).map((r) => String(r.name)));
  });
  afterAll(async () => {
    server?.close();
    await pool?.end();
  });

  // ---- the exclusion config --------------------------------------------------------------------------------------
  it('every configured segment exists in dim_segment and every configured team name in dim_sales_team (exact bytes)', async () => {
    const cfg = await qa('SELECT rule_type, name FROM cfg_finance_report_exclusion');
    expect(cfg.filter((c) => c.rule_type === 'segment').length).toBeGreaterThan(0);
    expect(cfg.filter((c) => c.rule_type === 'sales_team').length).toBeGreaterThan(0);
    for (const c of cfg) {
      const sql =
        c.rule_type === 'segment'
          ? 'SELECT COUNT(*) AS k FROM dim_segment WHERE Segment COLLATE utf8mb4_bin = ?'
          : 'SELECT COUNT(*) AS k FROM dim_sales_team WHERE SalesTeam COLLATE utf8mb4_bin = ?';
      expect(n((await q1(sql, [c.name])).k), `${c.rule_type} "${c.name}"`).toBeGreaterThan(0);
    }
  });

  it('the excluded-team view holds exactly the teams of the excluded segments and of the excluded names', async () => {
    const want = await qa(
      `SELECT st.SalesTeamKey FROM dim_sales_team st LEFT JOIN dim_segment sg ON sg.SegmentKey = st.SegmentKey
       WHERE BINARY sg.Segment IN (SELECT BINARY name FROM cfg_finance_report_exclusion WHERE rule_type = 'segment')
          OR BINARY st.SalesTeam IN (SELECT BINARY name FROM cfg_finance_report_exclusion WHERE rule_type = 'sales_team')`,
    );
    expect([...excludedTeamKeys].sort()).toEqual(want.map((r) => String(r.SalesTeamKey)).sort());
    // decisions of 2026-10-05; the look-alike مبيعات الإدارة (BMH-ALL-01, hamza) must not be caught
    for (const k of ['BMH-ALL-00', 'BMH-ALL-02', 'MJ-ALL-03', 'TK-ALL-03']) expect(excludedTeamKeys.has(k), k).toBe(true);
    expect(excludedTeamKeys.has('BMH-ALL-01')).toBe(false);
  });

  // ---- (a) no excluded line reaches any endpoint -----------------------------------------------------------------
  it('(a) no line of an excluded segment or team reaches any endpoint, even with both toggles on', async () => {
    const excludedLines = n((await q1(`SELECT COUNT(*) AS k FROM v_finance_receivable_line WHERE SnapshotDateKey = ? AND is_report_excluded = 1`, [snap])).k);
    expect(excludedLines).toBeGreaterThan(0); // otherwise this test proves nothing
    for (const qs of ['', 'includeOther=true&includeIntercompany=true', `salesTeamKeys=${[...excludedTeamKeys].map(encodeURIComponent).join('&salesTeamKeys=')}`]) {
      const meta = (await get(`/debt-report/meta?${qs}`)).body;
      for (const t of meta.options.salesTeams) expect(excludedTeamKeys.has(t.value), `meta team ${t.value} ${qs}`).toBe(false);
      const o = await get(`/debt-report/overview?${qs}`);
      expect(o.status).toBe(200);
      for (const c of o.body.currencies) {
        for (const t of c.byTeam) expect(excludedTeamKeys.has(t.key), `overview team ${t.key} ${qs}`).toBe(false);
        for (const kind of ['customer', 'salesperson', 'team'] as const) {
          const list = kind === 'customer' ? c.topCustomers : kind === 'salesperson' ? c.bySalesperson : c.byTeam;
          for (const p of list.slice(0, 5)) {
            const d = (await get(`/debt-report/drilldown?${qs}&kind=${kind}&key=${encodeURIComponent(p.key)}&currency=${c.currency}`)).body;
            for (const r of d.rows) {
              expect(excludedTeamKeys.has(r.salesTeamKey), `drill ${kind} ${p.key} team ${r.salesTeamKey}`).toBe(false);
              expect(excludedSegments.has(r.segment), `drill segment ${r.segment}`).toBe(false);
            }
          }
        }
      }
      const cust = (await get(`/debt-report/customers?${qs}`)).body;
      for (const r of cust.rows) for (const s of r.segments) expect(excludedSegments.has(s), `customer row segment ${s}`).toBe(false);
      // totals = the kept lines only (when the excluded teams were asked for: nothing at all)
      const asked = qs.startsWith('salesTeamKeys');
      const scope = qs.includes('includeOther') ? KEPT : DEFAULT;
      const want = asked ? new Map() : await direct(scope);
      sameTotals(kpiTotals(o.body), want, `overview ${qs}`);
    }
  });

  it('(a) the drill-down of every excluded line set is empty: asking for an excluded team returns no row', async () => {
    for (const key of excludedTeamKeys) {
      for (const currency of ['LYD', 'USD', 'EUR']) {
        const d = await get(`/debt-report/drilldown?kind=team&key=${encodeURIComponent(key)}&currency=${currency}&includeOther=true&includeIntercompany=true`);
        expect(d.status).toBe(200);
        expect(d.body.rows, `${key} ${currency}`).toEqual([]);
      }
    }
  });

  // ---- (b) overdue + not due = open, per currency ----------------------------------------------------------------
  it('(b) overdue + not yet due = open debt in every currency (KPIs and trend)', async () => {
    for (const qs of ['', 'includeOther=true&includeIntercompany=true', 'overdueStatus=overdue']) {
      const o = (await get(`/debt-report/overview?${qs}`)).body;
      expect(o.currencies.length).toBeGreaterThan(0);
      for (const c of o.currencies) {
        close(c.kpis.overdueAmount + c.kpis.notDueAmount, c.kpis.openAmount);
        close(c.aging.reduce((s: number, a: Json) => s + a.amount, 0), c.kpis.openAmount);
      }
      const t = (await get(`/debt-report/trend?${qs}`)).body;
      for (const p of t.points) close(p.overdue + p.notDue, p.open);
    }
  });

  // ---- (c) drill-down totals = chart totals ----------------------------------------------------------------------
  it('(c) every bar of every chart, in every currency, equals the sum of its drill-down', async () => {
    const o = (await get('/debt-report/overview')).body;
    let checked = 0;
    for (const c of o.currencies) {
      const drills: [string, string, number][] = [
        ...c.topCustomers.map((p: Json) => ['customer', p.key, p.overdue] as [string, string, number]),
        ...c.bySalesperson.map((p: Json) => ['salesperson', p.key, p.overdue] as [string, string, number]),
        ...c.byTeam.map((p: Json) => ['team', p.key, p.overdue] as [string, string, number]),
        ...c.aging.filter((a: Json) => a.lineCount > 0).map((a: Json) => ['aging', String(a.agingBucketKey), a.amount] as [string, string, number]),
      ];
      for (const [kind, key, value] of drills) {
        const d = (await get(`/debt-report/drilldown?kind=${kind}&key=${encodeURIComponent(key)}&currency=${c.currency}`)).body;
        const total = kind === 'aging' ? d.totals.openBalance : d.totals.overdueAmount;
        expect(Math.abs(total - value), `${c.currency} ${kind} ${key}`).toBeLessThan(0.005);
        close(d.rows.reduce((s: number, r: Json) => s + (kind === 'aging' ? r.openBalance : r.overdueAmount), 0), value);
        for (const r of d.rows) expect(r.currency).toBe(c.currency);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('(c) customer-table rows equal their drill-down (open, due debt, open documents, invoice amount)', async () => {
    const rows = (await get('/debt-report/customers')).body.rows as Json[];
    for (const r of [...rows.slice(0, 10), ...rows.filter((x) => x.currency !== 'LYD').slice(0, 5)]) {
      const d = (await get(`/debt-report/drilldown?kind=account&key=${r.companyKey}:${r.customerKey}&currency=${r.currency}`)).body;
      close(d.totals.openBalance, r.open);
      close(d.totals.overdueAmount, r.overdue);
      close(d.totals.invoiceAmount, r.invoiceAmount);
      expect(d.totals.openDocuments).toBe(r.openDocuments);
    }
  });

  // ---- defaults = the views ---------------------------------------------------------------------------------------
  it('default overview = v_finance_receivable_latest, per currency', async () => {
    const v = await qa(
      `SELECT doc_currency AS c, SUM(residual_doc_ccy) AS o, SUM(CASE WHEN days_past_due > 0 THEN residual_doc_ccy ELSE 0 END) AS d,
              COUNT(*) AS n, COUNT(DISTINCT move_id) AS docs, COUNT(DISTINCT CustomerKey) AS cust
       FROM v_finance_receivable_latest GROUP BY doc_currency`,
    );
    const { status, body } = await get('/debt-report/overview');
    expect(status).toBe(200);
    expect(body.currencies.map((c: Json) => c.currency).sort()).toEqual(v.map((x) => x.c).sort());
    for (const x of v) {
      const c = body.currencies.find((y: Json) => y.currency === x.c);
      close(c.kpis.openAmount, n(x.o));
      close(c.kpis.overdueAmount, n(x.d));
      expect(c.kpis.lineCount).toBe(n(x.n));
      expect(c.kpis.openDocuments).toBe(n(x.docs));
      expect(c.kpis.customers).toBe(n(x.cust));
      close(c.bySalesperson.reduce((s: number, a: Json) => s + a.overdue, 0), n(x.d));
      close(c.byTeam.reduce((s: number, a: Json) => s + a.overdue, 0), n(x.d));
      expect(c.aging.map((a: Json) => a.agingBucketKey)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(c.topCustomers.length).toBeLessThanOrEqual(15);
    }
  });

  it('default customers = v_finance_customer_exposure (one row per company + customer + currency)', async () => {
    const view = await qa('SELECT CompanyKey, CustomerKey, currency, open_documents, invoice_amount, open_amount, overdue_amount, not_due_amount FROM v_finance_customer_exposure');
    const { body } = await get('/debt-report/customers');
    expect(body.rows.length).toBe(view.length);
    const byKey = new Map(body.rows.map((r: Json) => [`${r.companyKey}:${r.customerKey}:${r.currency}`, r]));
    for (const v of view) {
      const r = byKey.get(`${v.CompanyKey}:${v.CustomerKey}:${v.currency}`) as Json;
      expect(r).toBeDefined();
      close(r.open, n(v.open_amount));
      close(r.overdue, n(v.overdue_amount));
      close(r.notDue, n(v.not_due_amount));
      close(r.invoiceAmount, n(v.invoice_amount));
      expect(r.openDocuments).toBe(n(v.open_documents));
    }
  });

  it('default trend (latest point per currency) = v_finance_receivable_trend', async () => {
    const v = await qa('SELECT currency AS c, SUM(open_amount) AS o, SUM(overdue_amount) AS d, SUM(not_due_amount) AS nd FROM v_finance_receivable_trend WHERE SnapshotDateKey = ? GROUP BY currency', [snap]);
    const { body } = await get('/debt-report/trend');
    const iso = `${String(snap).slice(0, 4)}-${String(snap).slice(4, 6)}-${String(snap).slice(6, 8)}`;
    for (const x of v) {
      const p = body.points.find((y: Json) => y.currency === x.c && y.snapshotDate === iso);
      close(p.open, n(x.o));
      close(p.overdue, n(x.d));
      close(p.notDue, n(x.nd));
    }
  });

  // ---- filters, toggles, salesperson ------------------------------------------------------------------------------
  it('every filter = the same condition written directly on the line view, per currency', async () => {
    const pick = async (col: string) =>
      (await qa(`SELECT ${col} AS v FROM v_finance_receivable_line WHERE SnapshotDateKey = ? AND ${DEFAULT} GROUP BY ${col} ORDER BY COUNT(*) DESC LIMIT 2`, [snap])).map((r) => r.v);
    const cases: [string, string, unknown[]][] = [];
    for (const c of await pick('CompanyKey')) cases.push([`companyKeys=${c}`, 'CompanyKey = ?', [c]]);
    for (const s of await pick('SalespersonKey')) cases.push([`salespersonKeys=${s}`, 'SalespersonKey = ?', [s]]);
    for (const t of await pick('SalesTeamKey')) cases.push([`salesTeamKeys=${encodeURIComponent(t)}`, 'SalesTeamKey = ?', [t]]);
    for (const t of await pick('PaymentTermKey')) cases.push([`paymentTermKeys=${t}`, 'PaymentTermKey = ?', [t]]);
    for (const d of await pick('document_type_key')) cases.push([`documentTypeKeys=${encodeURIComponent(d)}`, 'document_type_key = ?', [d]]);
    for (let b = 1; b <= 8; b++) cases.push([`agingBucketKeys=${b}`, 'AgingBucketKey = ?', [b]]);
    cases.push(['overdueStatus=overdue', 'days_past_due > 0', []]);
    cases.push(['overdueStatus=not_due', 'days_past_due <= 0', []]);
    for (const d of ['full', 'partial', 'pending']) cases.push([`deliveryStatuses=${d}`, 'delivery_status = ?', [d]]);
    cases.push(['deliveryStatuses=none', 'delivery_status IS NULL', []]);
    const cust = await q1(`SELECT CustomerKey AS k, customer AS c FROM v_finance_receivable_line WHERE SnapshotDateKey = ? AND ${DEFAULT} AND CustomerKey > 0 ORDER BY residual_company_ccy DESC LIMIT 1`, [snap]);
    const term = String(cust.c).slice(0, 6);
    cases.push([`customerSearch=${encodeURIComponent(term)}`, 'customer LIKE ?', [`%${term}%`]]);
    cases.push([`customerKeys=${cust.k}`, 'CustomerKey = ?', [cust.k]]);
    // size tiers classify on the LYD residual (company currency)
    for (const t of ['large', 'medium', 'small']) {
      cases.push([
        `invoiceTiers=${t}`,
        `move_id IN (SELECT move_id FROM v_finance_receivable_line WHERE SnapshotDateKey = ${snap} AND ${DEFAULT} GROUP BY move_id HAVING ${tier('SUM(residual_company_ccy)')} = ?)`,
        [t],
      ]);
      cases.push([
        `customerTiers=${t}`,
        `(CompanyKey, CustomerKey) IN (SELECT CompanyKey, CustomerKey FROM v_finance_receivable_line WHERE SnapshotDateKey = ${snap} AND ${DEFAULT} GROUP BY CompanyKey, CustomerKey HAVING ${tier('SUM(residual_company_ccy)')} = ?)`,
        [t],
      ]);
    }
    expect(cases.length).toBeGreaterThan(30);
    for (const [param, where, params] of cases) {
      const want = await direct(`${DEFAULT} AND ${where}`, params);
      const { status, body } = await get(`/debt-report/overview?${param}`);
      expect(status, param).toBe(200);
      sameTotals(kpiTotals(body), want, param);
      const c = (await get(`/debt-report/customers?${param}`)).body.rows as Json[];
      for (const [ccy, w] of want) close(c.filter((r) => r.currency === ccy).reduce((s, r) => s + r.open, 0), w.open);
    }
  });

  it('scope toggles add exactly the other-receivable and inter-company lines; all on + excluded = the fact total (= Odoo)', async () => {
    sameTotals(kpiTotals((await get('/debt-report/overview?includeOther=true')).body), await direct(`is_intercompany = 0 AND ${KEPT}`), 'includeOther');
    sameTotals(
      kpiTotals((await get('/debt-report/overview?includeIntercompany=true')).body),
      await direct(`receivable_scope = 'customer_debt' AND ${KEPT}`),
      'includeIntercompany',
    );
    const both = kpiTotals((await get('/debt-report/overview?includeOther=true&includeIntercompany=true')).body);
    const excluded = await direct('is_report_excluded = 1');
    const fact = await direct('1 = 1');
    for (const [c, f] of fact) {
      const kept = both.get(c) ?? { open: 0, overdue: 0, lines: 0 };
      const x = excluded.get(c) ?? { open: 0, overdue: 0, lines: 0 };
      close(kept.open + x.open, f.open);
      expect(kept.lines + x.lines).toBe(f.lines);
    }
    const factRows = n((await q1('SELECT COUNT(*) AS c FROM fact_finance_receivable_snapshot WHERE SnapshotDateKey = ?', [snap])).c);
    expect([...fact.values()].reduce((s, v) => s + v.lines, 0)).toBe(factRows); // the line view loses no fact row
  });

  it('drill-down rows carry the requested columns and link to Odoo', async () => {
    const top = (await get('/debt-report/customers')).body.rows[0];
    const { body } = await get(`/debt-report/drilldown?kind=account&key=${top.companyKey}:${top.customerKey}&currency=${top.currency}`);
    const r = body.rows[0];
    for (const k of ['company', 'document', 'invoiceDate', 'dueDate', 'daysOverdue', 'customer', 'currency', 'invoiceAmount', 'openBalance', 'overdueAmount', 'salesperson', 'salesTeam', 'segment']) {
      expect(r, k).toHaveProperty(k);
    }
    expect(r.odooUrl).toMatch(/\/web#id=\d+&model=account\.move&view_type=form$/);
    expect(body.rows.every((x: Json) => /^\d{4}-\d{2}-\d{2}$/.test(x.dueDate))).toBe(true);
    expect(body.rows.every((x: Json) => x.daysOverdue >= 0 && (x.daysOverdue > 0 ? x.overdueAmount === x.openBalance : x.overdueAmount === 0))).toBe(true);
  });

  it('a salesperson (role enabled) sees exactly their own lines; 403 for another salesperson; 403 while not enabled', async () => {
    const k = USERS.salespersonEnabled.salespersonKey as number;
    const want = await direct(`${DEFAULT} AND SalespersonKey = ?`, [k]);
    const { status, body } = await get('/debt-report/overview', 'salespersonEnabled');
    expect(status).toBe(200);
    sameTotals(kpiTotals(body), want, 'salesperson');
    const cust = (await get('/debt-report/customers', 'salespersonEnabled')).body.rows as Json[];
    for (const [ccy, w] of want) close(cust.filter((r) => r.currency === ccy).reduce((s, r) => s + r.open, 0), w.open);
    const other = await q1(`SELECT SalespersonKey AS k FROM v_finance_receivable_line WHERE SnapshotDateKey = ? AND SalespersonKey NOT IN (?, -1) LIMIT 1`, [snap, k]);
    expect((await get(`/debt-report/customers?salespersonKeys=${other.k}`, 'salespersonEnabled')).status).toBe(403);
    // another salesperson's customer: the drill-down returns only this salesperson's own lines of it (none)
    const foreign = await q1(
      `SELECT CompanyKey AS co, CustomerKey AS c, doc_currency AS ccy FROM v_finance_receivable_line WHERE SnapshotDateKey = ? AND ${DEFAULT}
       GROUP BY CompanyKey, CustomerKey, doc_currency HAVING SUM(SalespersonKey = ?) = 0 LIMIT 1`,
      [snap, k],
    );
    const drill = `/drilldown?kind=account&key=${foreign.co}:${foreign.c}&currency=${foreign.ccy}`;
    expect((await get(`/debt-report${drill}`, 'salespersonEnabled')).body.rows).toEqual([]);
    for (const path of ['/meta', '/overview', '/trend', '/customers', drill]) {
      expect((await get(`/debt-report${path}`, 'salesperson')).status, path).toBe(403);
    }
  });
});
