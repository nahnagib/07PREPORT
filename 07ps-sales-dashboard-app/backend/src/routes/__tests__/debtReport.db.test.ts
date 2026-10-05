import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Debt Report against a REAL warehouse (read-only: SELECT only). Opt-in:
 *
 *   DEBT_TEST_DB=1 DB_HOST=... DB_USER=... DB_PASSWORD=... DB_NAME=powerBI_Data npx vitest run -c vitest.debt-db.config.ts
 *   (optional) DEBT_EXPECTED_ODOO_TOTAL=<Odoo's open receivable total of the latest snapshot, every company>
 *
 * The real router, scope middleware and pool; only the signed-in user and their grants are faked (no app_user row is
 * written). Every expectation is computed here with its own SQL on the views, independently of measures/debtReport.ts:
 *   - defaults (latest snapshot, customer debt, no inter-company) = v_finance_receivable_latest / _customer_exposure /
 *     _trend;
 *   - every filter = the same condition written directly on v_finance_receivable_line;
 *   - the scope toggles add exactly the other-receivable and inter-company lines; all on = the fact total (= Odoo);
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

/** Direct totals on the line view: the same conditions the page means, written independently. */
async function direct(where: string, params: unknown[] = []) {
  const r = await q1(
    `SELECT COALESCE(SUM(residual_company_ccy), 0) AS open_amount,
            COALESCE(SUM(CASE WHEN days_past_due > 0 THEN residual_company_ccy END), 0) AS overdue, COUNT(*) AS n
     FROM v_finance_receivable_line WHERE SnapshotDateKey = ? AND ${where}`,
    [snap, ...params],
  );
  return { open: n(r.open_amount), overdue: n(r.overdue), lines: n(r.n) };
}
const DEFAULT = 'receivable_scope = \'customer_debt\' AND is_intercompany = 0';
const tier = (expr: string) => `CASE WHEN ${expr} >= 100000 THEN 'large' WHEN ${expr} >= 10000 THEN 'medium' ELSE 'small' END`;

describe.skipIf(!RUN)('Debt Report on the real warehouse (read-only)', () => {
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
  });
  afterAll(async () => {
    server?.close();
    await pool?.end();
  });

  it('default overview = v_finance_receivable_latest', async () => {
    const v = await q1(
      'SELECT SUM(residual_company_ccy) AS o, SUM(CASE WHEN days_past_due > 0 THEN residual_company_ccy ELSE 0 END) AS d, ' +
        'SUM(CASE WHEN days_past_due > 90 THEN residual_company_ccy ELSE 0 END) AS d90, COUNT(*) AS c FROM v_finance_receivable_latest',
    );
    const { status, body } = await get('/debt-report/overview');
    expect(status).toBe(200);
    close(body.kpis.openAmount, n(v.o));
    close(body.kpis.overdueAmount, n(v.d));
    close(body.kpis.overdue90Plus, n(v.d90));
    expect(body.kpis.lineCount).toBe(n(v.c));
    close(body.aging.reduce((s: number, a: Json) => s + a.amount, 0), n(v.o));
    expect(body.aging.map((a: Json) => a.agingBucketKey)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    close(body.bySalesperson.reduce((s: number, a: Json) => s + a.overdue, 0), n(v.d));
    close(body.byTeam.reduce((s: number, a: Json) => s + a.overdue, 0), n(v.d));
    expect(body.topCustomers.length).toBeLessThanOrEqual(15);
  });

  it('default customers = v_finance_customer_exposure (one row per company + customer)', async () => {
    const view = await qa('SELECT CompanyKey, CustomerKey, open_amount, overdue_amount, overdue_90_plus, sales_last_90d, dso_days, oldest_overdue_days FROM v_finance_customer_exposure');
    const { body } = await get('/debt-report/customers');
    expect(body.rows.length).toBe(view.length);
    const byKey = new Map(body.rows.map((r: Json) => [`${r.companyKey}:${r.customerKey}`, r]));
    for (const v of view) {
      const r = byKey.get(`${v.CompanyKey}:${v.CustomerKey}`) as Json;
      expect(r).toBeDefined();
      close(r.open, n(v.open_amount));
      close(r.overdue, n(v.overdue_amount));
      close(r.overdue90Plus, n(v.overdue_90_plus));
      close(r.salesLast90d, n(v.sales_last_90d));
      if (v.dso_days === null) expect(r.dsoDays).toBeNull();
      else close(r.dsoDays, n(v.dso_days));
      expect(r.oldestOverdueDays).toBe(v.oldest_overdue_days === null ? null : n(v.oldest_overdue_days));
    }
    const overdue = body.rows.map((r: Json) => r.overdue);
    expect(overdue).toEqual([...overdue].sort((a: number, b: number) => b - a)); // default sort: overdue descending
  });

  it('default trend (latest point) = v_finance_receivable_trend', async () => {
    const v = await q1('SELECT SUM(open_amount) AS o, SUM(overdue_amount) AS d FROM v_finance_receivable_trend WHERE SnapshotDateKey = ?', [snap]);
    const { body } = await get('/debt-report/trend');
    const last = body.points[body.points.length - 1];
    close(last.open, n(v.o));
    close(last.overdue, n(v.d));
  });

  it('every filter = the same condition written directly on the line view', async () => {
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
      expect(body.kpis.lineCount, param).toBe(want.lines);
      expect(Math.abs(body.kpis.openAmount - want.open), param).toBeLessThan(0.005);
      expect(Math.abs(body.kpis.overdueAmount - want.overdue), param).toBeLessThan(0.005);
      const c = await get(`/debt-report/customers?${param}`);
      expect(Math.abs(c.body.rows.reduce((s: number, r: Json) => s + r.open, 0) - want.open), `customers ${param}`).toBeLessThan(0.01);
    }
  });

  it('scope toggles add exactly the other-receivable and inter-company lines; all on = the fact total (= Odoo)', async () => {
    const def = await direct(DEFAULT);
    const other = await direct("receivable_scope = 'other_receivable' AND is_intercompany = 0");
    const icDebt = await direct("receivable_scope = 'customer_debt' AND is_intercompany = 1");
    const all = await direct('1 = 1');
    const fact = await q1('SELECT SUM(residual_company_ccy) AS t, COUNT(*) AS c FROM fact_finance_receivable_snapshot WHERE SnapshotDateKey = ?', [snap]);
    close((await get('/debt-report/overview?includeOther=true')).body.kpis.openAmount, def.open + other.open);
    close((await get('/debt-report/overview?includeIntercompany=true')).body.kpis.openAmount, def.open + icDebt.open);
    const both = (await get('/debt-report/overview?includeOther=true&includeIntercompany=true')).body.kpis;
    close(both.openAmount, all.open);
    close(both.openAmount, n(fact.t));
    expect(both.lineCount).toBe(n(fact.c));
    if (process.env.DEBT_EXPECTED_ODOO_TOTAL) close(both.openAmount, Number(process.env.DEBT_EXPECTED_ODOO_TOTAL));
    const docs = await get('/debt-report/customers?includeOther=true&includeIntercompany=true');
    close(docs.body.rows.reduce((s: number, r: Json) => s + r.open, 0), n(fact.t));
  });

  it("drill-down documents add up to the customer's exposure row and link to Odoo", async () => {
    const top = (await get('/debt-report/customers')).body.rows[0];
    const { body } = await get(`/debt-report/documents?customerKey=${top.customerKey}&companyKeys=${top.companyKey}`);
    close(body.rows.reduce((s: number, r: Json) => s + r.residualCompanyCcy, 0), top.open);
    expect(body.rows[0].odooUrl).toMatch(/\/web#id=\d+&model=account\.move&view_type=form$/);
    expect(body.rows.every((r: Json) => /^\d{4}-\d{2}-\d{2}$/.test(r.dueDate))).toBe(true);
  });

  it('a salesperson (role enabled) sees exactly their own lines; 403 for another salesperson; 403 while not enabled', async () => {
    const k = USERS.salespersonEnabled.salespersonKey as number;
    const want = await direct(`${DEFAULT} AND SalespersonKey = ?`, [k]);
    const { status, body } = await get('/debt-report/overview', 'salespersonEnabled');
    expect(status).toBe(200);
    close(body.kpis.openAmount, want.open);
    expect(body.kpis.lineCount).toBe(want.lines);
    const cust = await get('/debt-report/customers', 'salespersonEnabled');
    close(cust.body.rows.reduce((s: number, r: Json) => s + r.open, 0), want.open);
    const other = await q1(`SELECT SalespersonKey AS k FROM v_finance_receivable_line WHERE SnapshotDateKey = ? AND SalespersonKey NOT IN (?, -1) LIMIT 1`, [snap, k]);
    expect((await get(`/debt-report/customers?salespersonKeys=${other.k}`, 'salespersonEnabled')).status).toBe(403);
    // another salesperson's customer: the drill-down returns only this salesperson's own lines of it (none)
    const foreign = await q1(
      `SELECT CustomerKey AS c FROM v_finance_receivable_line WHERE SnapshotDateKey = ? AND ${DEFAULT} GROUP BY CustomerKey
       HAVING SUM(SalespersonKey = ?) = 0 LIMIT 1`,
      [snap, k],
    );
    expect((await get(`/debt-report/documents?customerKey=${foreign.c}`, 'salespersonEnabled')).body.rows).toEqual([]);
    for (const path of ['/meta', '/overview', '/trend', '/customers', `/documents?customerKey=${foreign.c}`]) {
      expect((await get(`/debt-report${path}`, 'salesperson')).status, path).toBe(403);
    }
  });
});
