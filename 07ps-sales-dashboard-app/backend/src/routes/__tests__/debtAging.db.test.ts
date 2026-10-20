import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Credit Policy Escalation (GET /debt-report/aging) against a REAL MySQL (read-only: SELECT only). Opt-in, with the
 * Debt Report DB tests:
 *
 *   DEBT_TEST_DB=1 DB_HOST=... DB_USER=... DB_PASSWORD=... DB_NAME=powerBI_Data npx vitest run -c vitest.debt-db.config.ts
 *
 *   1. GET /debt-report/aging on the real snapshot, every expectation computed with its own SQL on the fact table:
 *      the unpaid invoice with the earliest due date decides, days overdue = snapshot date - (that due date + 1 day), zones as in
 *      config/creditPolicy.ts; the Customers table's bucket = the chart's zone for every customer.
 *   2. The Debt Report invariants, per currency and for All currencies (LYD), with the defaults, one company (Majaal)
 *      and both toggles on: Overdue + Not yet due = Total debt (in the invoice currency and in LYD); both shares
 *      between 0% and 100%; the chart's four zone totals = due-customer outstanding; the toggles never change them.
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
const qa = async (sql: string, params: unknown[] = []): Promise<Json[]> => (await pool.query(sql, params))[0] as Json[];
const n = (v: unknown) => Number(v ?? 0);
const isoOf = (k: number) => `${String(k).slice(0, 4)}-${String(k).slice(4, 6)}-${String(k).slice(6, 8)}`;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
/** Independent of config/creditPolicy.ts OVERDUE_OFFSET_DAYS on purpose: overdue from the day after the due date. */
const overdueDays = (due: string, asOf: string) => daysBetween(due, asOf) - 1;
const ZONES: [string, number, number][] = [['GREEN', 0, 15], ['YELLOW', 16, 30], ['RED', 31, 44], ['BLOCK', 45, Infinity]];
const zoneOf = (d: number) => (d < 0 ? 'NOT_YET_DUE' : ZONES.find(([, lo, hi]) => d >= lo && d <= hi)![0]);

describe.skipIf(!RUN)('Credit Policy Escalation on the real warehouse (read-only)', () => {
  let spKey = 0;
  beforeAll(async () => {
    ({ pool } = await import('../../db/pool'));
    const { debtReportRouter } = await import('../debtReport');
    const app = express();
    app.use('/debt-report', debtReportRouter);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    snap = n((await qa('SELECT MAX(SnapshotDateKey) AS k FROM fact_finance_receivable_snapshot'))[0].k);
    const sp = await qa(
      `SELECT SalespersonKey AS k FROM fact_finance_receivable_snapshot WHERE SnapshotDateKey = ? AND receivable_scope = 'customer_debt'
         AND is_intercompany = 0 AND residual_doc_ccy > 0 AND SalespersonKey > 0 GROUP BY SalespersonKey ORDER BY COUNT(*) DESC LIMIT 1`,
      [snap],
    );
    spKey = n(sp[0].k);
    USERS.salesperson.salespersonKey = spKey;
    USERS.salespersonEnabled.salespersonKey = spKey;
  });
  afterAll(() => server?.close());

  /** Independently, per customer + currency: customer invoices only (out_invoice, customer debt, no inter-company, no
   * excluded team); every invoice line's residual adds to the outstanding; the unpaid invoices' due date = the
   * earliest due date of their open lines; the earliest of those decides. */
  const independent = async (extra = '', params: unknown[] = []) => {
    const invoices = await qa(
      `SELECT cur.currency, f.CustomerKey, f.move_id, SUM(f.residual_doc_ccy) AS residual, SUM(f.residual_company_ccy) AS residual_company,
              DATE_FORMAT(MIN(CASE WHEN f.residual_doc_ccy > 0 THEN f.due_date END), '%Y-%m-%d') AS due
       FROM fact_finance_receivable_snapshot f
       JOIN dim_currency cur ON cur.CurrencyKey = f.CurrencyKey
       JOIN dim_finance_invoice i ON i.move_id = f.move_id
       WHERE f.SnapshotDateKey = ? AND f.receivable_scope = 'customer_debt' AND f.is_intercompany = 0 AND f.PaymentKey = -1
         AND i.move_type = 'out_invoice'
         AND NOT EXISTS (SELECT 1 FROM v_finance_excluded_sales_team x WHERE x.SalesTeamKey = f.SalesTeamKey) ${extra}
       GROUP BY cur.currency, f.CustomerKey, f.move_id`,
      [snap, ...params],
    );
    const by = new Map<string, { currency: string; customer: number; total: number; totalCompany: number; due: string | null; unpaid: number }>();
    for (const r of invoices) {
      const k = `${r.CustomerKey}|${r.currency}`;
      const g = by.get(k) ?? { currency: String(r.currency), customer: n(r.CustomerKey), total: 0, totalCompany: 0, due: null, unpaid: 0 };
      g.total += n(r.residual);
      g.totalCompany += n(r.residual_company);
      if (n(r.residual) > 0 && r.due) {
        g.unpaid += 1;
        if (g.due === null || r.due < g.due) g.due = String(r.due);
      }
      by.set(k, g);
    }
    return [...by.values()].filter((g) => g.unpaid > 0);
  };

  it('every currency: same customers, same earliest due date, same days overdue, zone and outstanding', async () => {
    const want = await independent();
    const asOf = isoOf(snap);
    const currencies = [...new Set(want.map((w) => w.currency))];
    for (const c of currencies) {
      const { status, body } = await get(`/debt-report/aging?currency=${c}`);
      expect(status).toBe(200);
      expect(body.asOf).toBe(asOf);
      const mine = want.filter((w) => w.currency === c && w.due !== null && overdueDays(w.due, asOf) >= 0);
      expect(body.customers.length, c).toBe(mine.length);
      const got = new Map(body.customers.map((x: Json) => [x.customerKey, x]));
      for (const w of mine) {
        const g = got.get(w.customer) as Json;
        expect(g, `${c} customer ${w.customer}`).toBeTruthy();
        const days = overdueDays(w.due as string, asOf);
        expect(g.oldestDueDate, `${c} ${w.customer}`).toBe(w.due);
        expect(g.daysOverdue).toBe(days);
        expect(g.zone).toBe(zoneOf(days));
        expect(Math.abs(g.totalOutstanding - w.total)).toBeLessThan(0.000001);
        expect(Math.abs(g.totalOutstandingCompany - w.totalCompany)).toBeLessThan(0.000001);
        expect(g.unpaidInvoiceCount).toBe(w.unpaid);
      }
    }
  });

  it('the Customers table bucket = the chart zone, in each currency and over all currencies', async () => {
    const rows = (await get('/debt-report/customers')).body.rows as Json[];
    const allDots = new Map((await get('/debt-report/aging?allCurrencies=true')).body.customers.map((c: Json) => [c.customerKey, c.zone]));
    const perCurrency = new Map<string, Map<number, string>>();
    for (const ccy of [...new Set(rows.map((r) => String(r.currency)))]) {
      perCurrency.set(ccy, new Map((await get(`/debt-report/aging?currency=${ccy}`)).body.customers.map((c: Json) => [c.customerKey, c.zone])));
    }
    let checked = 0;
    for (const r of rows) {
      expect(r.creditZone?.currency?.zone === 'NOT_YET_DUE' ? null : r.creditZone?.currency?.zone ?? null, `${r.customer} ${r.currency}`).toBe(perCurrency.get(r.currency)!.get(r.customerKey) ?? null);
      expect(r.creditZone?.all?.zone === 'NOT_YET_DUE' ? null : r.creditZone?.all?.zone ?? null, `${r.customer} all`).toBe(allDots.get(r.customerKey) ?? null);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('a dot drills down to exactly its total outstanding', async () => {
    const dots = (await get('/debt-report/aging?allCurrencies=true')).body.customers.slice(0, 8) as Json[];
    for (const d of dots) {
      const dd = (await get(`/debt-report/drilldown?kind=customer_open&key=${d.customerKey}`)).body;
      expect(Math.abs(dd.totals.openBalance - d.totalOutstanding), d.customer).toBeLessThan(0.005);
    }
  });

  it('the payment-term filter keeps only that term and never changes a zone', async () => {
    const now = (await get('/debt-report/aging')).body;
    const term = now.terms[0].key;
    const only = (await get(`/debt-report/aging?term=${term}`)).body;
    expect(only.customers.every((c: Json) => String(c.paymentTermKey) === term)).toBe(true);
    expect(only.customers.length).toBe(now.terms[0].customers);
    const zoneBefore = new Map(now.customers.map((c: Json) => [c.customerKey, c.zone]));
    for (const c of only.customers) expect(c.zone).toBe(zoneBefore.get(c.customerKey));
  });

  it("a salesperson's chart is built from their own lines only; 403 while the role is not enabled", async () => {
    expect((await get('/debt-report/aging', 'salesperson')).status).toBe(403);
    const r = await get('/debt-report/aging', 'salespersonEnabled');
    expect(r.status).toBe(200);
    const want = (await independent('AND f.SalespersonKey = ?', [spKey])).filter((w) => w.currency === r.body.currency && w.due !== null && overdueDays(w.due, isoOf(snap)) >= 0);
    expect(r.body.customers.map((c: Json) => c.customerKey).sort()).toEqual(want.map((w) => w.customer).sort());
    expect((await get('/debt-report/aging?salespersonKeys=999999', 'salespersonEnabled')).status).toBe(403);
  });
});

describe.skipIf(!RUN)('Debt Report invariants on the real warehouse (read-only)', () => {
  beforeAll(async () => {
    ({ pool } = await import('../../db/pool'));
    // the previous suite closed its server: start this suite's own
    const { debtReportRouter } = await import('../debtReport');
    const app = express();
    app.use('/debt-report', debtReportRouter);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server?.close());

  const close = (a: number, b: number, label: string) => expect(Math.abs(a - b), label).toBeLessThan(0.005);
  const SCOPES: [string, string][] = [
    ['defaults', ''],
    ['Majaal only', 'companyKeys=1'],
    ['both toggles on', 'includeOther=true&includeIntercompany=true'],
  ];

  it.each(SCOPES)('%s: Overdue + Not yet due = Total debt (invoice currency and LYD), both shares in [0%%, 100%%], escalation zones = due-customer outstanding', async (label, qs) => {
    const sep = qs ? `?${qs}` : '';
    const overview = await get(`/debt-report/overview${sep}`);
    expect(overview.status).toBe(200);
    const withInvoices = overview.body.currencies.filter((c: Json) => c.kpis.openDocuments > 0);
    expect(withInvoices.length, label).toBeGreaterThan(0);
    for (const c of overview.body.currencies) {
      const k = c.kpis;
      const tag = `${label} ${c.currency}`;
      close(k.overdueAmount + k.notDueAmount, k.openAmount, `${tag}: overdue + not due = open`);
      close(k.overdueAmountCompany + k.notDueAmountCompany, k.openAmountCompany, `${tag}: overdue + not due = open, in LYD`);
      expect(k.openAmount, `${tag}: open invoices are never negative`).toBeGreaterThanOrEqual(0);
      for (const share of [k.overduePctOfOpen, k.notDuePctOfOpen]) {
        if (share === null) continue; // no open invoice in this currency
        expect(share, `${tag}: share >= 0%`).toBeGreaterThanOrEqual(0);
        expect(share, `${tag}: share <= 100%`).toBeLessThanOrEqual(1);
      }
      expect(k.unappliedCredits, `${tag}: unapplied credits are never positive`).toBeLessThanOrEqual(0.005);
      close(k.openAmount + k.unappliedCredits + k.otherEntries + k.intercompany, k.netBalance, `${tag}: net balance`);
      const map = await get(`/debt-report/aging?currency=${c.currency}${qs ? `&${qs}` : ''}`);
      expect(map.status).toBe(200);
      const s = map.body.summary;
      const dots = map.body.customers;
      expect(dots.every((x: Json) => x.daysOverdue >= 0 && !x.notYetDue)).toBe(true);
      close(s.zones.reduce((t: number, z: Json) => t + z.amount, 0), dots.reduce((t: number, x: Json) => t + x.totalOutstanding, 0), `${tag}: zones = due-customer outstanding`);
      close(s.zones.reduce((t: number, z: Json) => t + z.amountCompany, 0), dots.reduce((t: number, x: Json) => t + x.totalOutstandingCompany, 0), `${tag}: zones in LYD`);
      expect(new Set(dots.map((x: Json) => x.customerKey)).size).toBe(dots.length);
      expect(dots.length).toBeLessThanOrEqual(k.customers);
      expect(s.zones.reduce((t: number, z: Json) => t + z.customers, 0)).toBe(dots.length);
    }
    const all = overview.body.allCurrencies;
    close(all.overdueAmount + all.notDueAmount, all.openAmount, `${label} all currencies: overdue + not due = total debt`);
    // the all-currencies chart: one dot per due customer (any currency), its outstanding in LYD
    const allMap = await get(`/debt-report/aging?allCurrencies=true${qs ? `&${qs}` : ''}`);
    expect(allMap.body.allCurrencies).toBe(true);
    const as = allMap.body.summary;
    close(as.zones.reduce((t: number, z: Json) => t + z.amount, 0), allMap.body.customers.reduce((t: number, x: Json) => t + x.totalOutstanding, 0), `${label}: all-currencies zones = due-customer outstanding`);
    expect(allMap.body.customers.every((x: Json) => x.daysOverdue >= 0 && !x.notYetDue)).toBe(true);
    expect(allMap.body.customers.length, `${label}: one dot per customer`).toBeLessThanOrEqual(all.customers);
    close(all.openAmount, overview.body.currencies.reduce((t: number, c: Json) => t + c.kpis.openAmountCompany, 0), `${label} all currencies = sum of LYD`);
    expect(all.openDocuments).toBe(overview.body.currencies.reduce((t: number, c: Json) => t + c.kpis.openDocuments, 0));
    expect(all.customers).toBeLessThanOrEqual(overview.body.currencies.reduce((t: number, c: Json) => t + c.kpis.customers, 0));
  });

  it('the toggles never change Total debt, Overdue, Not yet due or the map', async () => {
    const off = (await get('/debt-report/overview')).body;
    const on = (await get('/debt-report/overview?includeOther=true&includeIntercompany=true')).body;
    for (const c of off.currencies) {
      const o = on.currencies.find((x: Json) => x.currency === c.currency);
      expect(o, c.currency).toBeTruthy();
      for (const key of ['openAmount', 'openDocuments', 'customers', 'overdueAmount', 'notDueAmount', 'openAmountCompany', 'overdueAmountCompany', 'unappliedCredits']) {
        close(o.kpis[key], c.kpis[key], `${c.currency} ${key}`);
      }
      expect(c.kpis.otherEntries).toBe(0);
      expect(c.kpis.intercompany).toBe(0);
    }
  });

  it('Total debt = the customer invoices on the fact table, counted like Odoo (invoices with an amount due)', async () => {
    const snapKey = n((await qa('SELECT MAX(SnapshotDateKey) AS k FROM fact_finance_receivable_snapshot'))[0].k);
    const want = await qa(
      `SELECT cur.currency, COUNT(DISTINCT f.move_id) AS docs, COUNT(DISTINCT f.CustomerKey) AS customers, SUM(f.residual_doc_ccy) AS open_amount,
              SUM(f.residual_company_ccy) AS open_company
       FROM fact_finance_receivable_snapshot f
       JOIN dim_currency cur ON cur.CurrencyKey = f.CurrencyKey
       JOIN dim_finance_invoice i ON i.move_id = f.move_id
       WHERE f.SnapshotDateKey = ? AND f.receivable_scope = 'customer_debt' AND f.is_intercompany = 0 AND f.PaymentKey = -1
         AND i.move_type = 'out_invoice'
         AND f.SalesTeamKey NOT IN (SELECT SalesTeamKey FROM v_finance_excluded_sales_team)
       GROUP BY cur.currency`,
      [snapKey],
    );
    const got = (await get('/debt-report/overview')).body;
    for (const w of want) {
      const c = got.currencies.find((x: Json) => x.currency === w.currency);
      expect(c, w.currency).toBeTruthy();
      expect(c.kpis.openDocuments, `${w.currency} invoices`).toBe(n(w.docs));
      expect(c.kpis.customers, `${w.currency} customers`).toBe(n(w.customers));
      close(c.kpis.openAmount, n(w.open_amount), `${w.currency} open`);
      close(c.kpis.openAmountCompany, n(w.open_company), `${w.currency} open in LYD`);
    }
    close(got.allCurrencies.openAmount, want.reduce((t, w) => t + n(w.open_company), 0), 'all currencies in LYD');
  });
});
