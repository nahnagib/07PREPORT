import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Debt Report Aging Map against a REAL MySQL (read-only: SELECT only). Opt-in, with the Debt Report DB tests:
 *
 *   DEBT_TEST_DB=1 DB_HOST=... DB_USER=... DB_PASSWORD=... DB_NAME=powerBI_Data npx vitest run -c vitest.debt-db.config.ts
 *
 * Needs migrations 0036 and 0037.
 *   1. The oldest-open-invoice rules, on the production SQL (agingSql) fed with literal rows -- MySQL evaluates the
 *      real CTE / ROW_NUMBER / LEFT JOIN on cfg_finance_payment_term_days, no table is written.
 *   2. GET /debt-report/aging on the real snapshot, every expectation computed with its own SQL on the fact table.
 *   3. The Debt Report invariants, per currency and for All currencies (LYD), with the defaults, one company (Majaal)
 *      and both toggles on: Overdue + Not yet due = Total debt (in the invoice currency and in LYD); both shares
 *      between 0% and 100%; the Aging Map total = Total debt; the toggles never change Total debt, Overdue or the map.
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
let aging: typeof import('../../measures/debtAging');
let snap = 0;
type Json = any;
const get = async (path: string, who = 'admin'): Promise<{ status: number; body: Json }> => {
  const res = await fetch(`${base}${path}`, { headers: { 'x-test-user': who } });
  return { status: res.status, body: await res.json() };
};
const qa = async (sql: string, params: unknown[] = []): Promise<Json[]> => (await pool.query(sql, params))[0] as Json[];
const n = (v: unknown) => Number(v ?? 0);

/** One literal receivable line (the columns agingSql reads from its source). */
interface Line {
  customer: number;
  move: number;
  line?: number;
  invoiceDate: string;
  dueDate?: string | null;
  residual: number;
  term?: number;
  currency?: string;
  /** default: invoice for a positive residual, payment otherwise */
  kind?: string;
}
/** A FROM clause of literal rows, alias l, as linesSource exposes it. */
function fixture(lines: Line[]): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const selects = lines.map((x, i) => {
    params.push(
      x.currency ?? 'LYD', x.customer, `Customer ${x.customer}`, x.term ?? 4, `term ${x.term ?? 4}`, x.move, x.line ?? i + 1,
      `INV/${x.move}`, Number(x.invoiceDate.replace(/-/g, '')), x.dueDate === undefined ? x.invoiceDate : x.dueDate, x.residual,
      x.residual * (x.currency && x.currency !== 'LYD' ? 10 : 1), x.kind ?? (x.residual >= 0 ? 'invoice' : 'payment'),
    );
    return `SELECT ? AS currency, ? AS CustomerKey, ? AS customer, 1 AS CompanyKey, 'MJ' AS company, ? AS PaymentTermKey,
                   ? AS payment_term, ? AS move_id, ? AS line_id, ? AS document, ? AS InvoiceDateKey, ? AS due_date,
                   CAST(? AS DECIMAL(20,6)) AS residual_doc_ccy, CAST(? AS DECIMAL(20,6)) AS residual_company_ccy, ? AS line_kind`;
  });
  return { sql: `FROM (${selects.join(' UNION ALL ')}) l`, params };
}
async function mapOf(lines: Line[], snapshotDate = '2026-10-04') {
  const a = aging.agingSql(fixture(lines));
  const rows = await qa(a.sql, a.params);
  const settings = await aging.fetchAgingSettings(pool);
  return aging.buildAging(rows, { snapshotDate, currency: null, term: null, settings });
}

describe.skipIf(!RUN)('Aging Map: oldest open invoice (production SQL on literal rows)', () => {
  beforeAll(async () => {
    ({ pool } = await import('../../db/pool'));
    aging = await import('../../measures/debtAging');
  });

  it('3 invoices, the oldest fully paid -> the second-oldest decides the zone', async () => {
    // term 4 = 30 days. A fully paid invoice has no open line in Odoo; a zero residual must be ignored too.
    const lines: Line[] = [
      { customer: 1, move: 11, invoiceDate: '2026-05-01', residual: 0 },
      { customer: 1, move: 12, invoiceDate: '2026-08-20', residual: 300 }, // 45 days -> yellow
      { customer: 1, move: 13, invoiceDate: '2026-09-25', residual: 700 },
    ];
    const m = await mapOf(lines);
    expect(m.customers).toHaveLength(1);
    expect(m.customers[0]).toMatchObject({ oldestOpenMoveId: 12, invoiceAge: 45, zone: 'yellow', outstanding: 1000, openInvoices: 2 });
    // without the fully paid one, nothing changes
    expect((await mapOf(lines.slice(1))).customers[0]).toMatchObject({ oldestOpenMoveId: 12, zone: 'yellow' });
  });

  it('a partial payment on the oldest invoice keeps the zone and lowers outstanding', async () => {
    const full: Line[] = [
      { customer: 2, move: 21, invoiceDate: '2026-06-01', residual: 1000 }, // 125 days on 30 -> black
      { customer: 2, move: 22, invoiceDate: '2026-09-30', residual: 500 },
    ];
    const partial = [{ ...full[0], residual: 250 }, full[1]];
    const a = (await mapOf(full)).customers[0];
    const b = (await mapOf(partial)).customers[0];
    expect(a).toMatchObject({ oldestOpenMoveId: 21, zone: 'black', outstanding: 1500 });
    expect(b).toMatchObject({ oldestOpenMoveId: 21, zone: 'black', outstanding: 750 });
  });

  it('credits never lower the outstanding amount or settle an invoice; credit-only customers are not placed', async () => {
    const lines: Line[] = [
      { customer: 3, move: 31, invoiceDate: '2026-07-01', residual: 800 },
      { customer: 3, move: 32, invoiceDate: '2026-09-01', dueDate: null, residual: -300, term: -1 }, // unreconciled receipt
      { customer: 3, move: 33, invoiceDate: '2026-09-02', dueDate: null, residual: -900, term: -1, kind: 'credit_note' },
      { customer: 9, move: 91, invoiceDate: '2026-09-01', dueDate: null, residual: -120, term: -1, kind: 'credit_note' },
      { customer: 9, move: 92, invoiceDate: '2026-09-03', dueDate: null, residual: -30, term: -1 },
      // other receivable entries / inter-company never reach the map, even with their toggles on
      { customer: 10, move: 101, invoiceDate: '2026-01-01', residual: 5000, kind: 'other' },
      { customer: 11, move: 111, invoiceDate: '2026-01-01', residual: 7000, kind: 'intercompany' },
    ];
    const m = await mapOf(lines);
    expect(m.customers.map((c) => c.customerKey)).toEqual([3]);
    expect(m.customers[0]).toMatchObject({ oldestOpenMoveId: 31, outstanding: 800, outstandingCompany: 800, openInvoices: 1 });
  });

  it('term from cfg_finance_payment_term_days; no term -> due date; no due date -> Missing term', async () => {
    const m = await mapOf([
      { customer: 4, move: 41, invoiceDate: '2026-07-06', residual: 10, term: 14 }, // 90 days configured
      { customer: 5, move: 51, invoiceDate: '2026-09-01', dueDate: '2026-09-22', residual: 10, term: -1 },
      { customer: 6, move: 61, invoiceDate: '2026-09-01', dueDate: null, residual: 10, term: -1 },
      { customer: 7, move: 71, invoiceDate: '2026-09-01', dueDate: '2026-09-11', residual: 10, term: 999999 }, // term without days
    ]);
    const by = (k: number) => m.customers.find((c) => c.customerKey === k);
    expect(by(4)).toMatchObject({ termSource: 'payment_term', termDays: 90, zone: 'green' });
    expect(by(5)).toMatchObject({ termSource: 'due_date', termDays: 21 });
    expect(by(6)).toMatchObject({ termSource: 'missing', termDays: 0, termLabel: 'Missing term' });
    expect(by(7)).toMatchObject({ termSource: 'due_date', termDays: 10 });
  });

  it('ties on the invoice date go to the earlier due date, then the lower line id; currencies stay apart', async () => {
    const m = await mapOf([
      { customer: 8, move: 81, line: 5, invoiceDate: '2026-08-01', dueDate: '2026-09-15', residual: 10 },
      { customer: 8, move: 82, line: 9, invoiceDate: '2026-08-01', dueDate: '2026-08-31', residual: 10 },
      { customer: 8, move: 83, invoiceDate: '2026-01-01', residual: 10, currency: 'USD' },
    ]);
    expect(m.customers[0]).toMatchObject({ oldestOpenMoveId: 82, outstanding: 20 });
    expect(m.currencies).toEqual(['LYD', 'USD']);
    const usd = aging.buildAging(await qa(aging.agingSql(fixture([{ customer: 8, move: 83, invoiceDate: '2026-01-01', residual: 10, currency: 'USD' }])).sql,
      fixture([{ customer: 8, move: 83, invoiceDate: '2026-01-01', residual: 10, currency: 'USD' }]).params), {
      snapshotDate: '2026-10-04', currency: 'USD', term: null, settings: await aging.fetchAgingSettings(pool),
    });
    expect(usd.customers[0]).toMatchObject({ outstanding: 10, outstandingCompany: 100 }); // the LYD residual as given, never a rate
  });
});

describe.skipIf(!RUN)('Aging Map on the real warehouse (read-only)', () => {
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

  /** Independently: latest snapshot, customer invoices only (out_invoice, customer debt, no inter-company, no excluded
   * team); per customer + currency. */
  const independent = (extra = '', params: unknown[] = []) =>
    qa(
      `SELECT cur.currency, f.CustomerKey, SUM(f.residual_doc_ccy) AS net, SUM(f.residual_company_ccy) AS net_company,
              SUBSTRING_INDEX(GROUP_CONCAT(f.move_id ORDER BY f.InvoiceDateKey, f.due_date, f.line_id), ',', 1) AS oldest
       FROM fact_finance_receivable_snapshot f
       JOIN dim_currency cur ON cur.CurrencyKey = f.CurrencyKey
       JOIN dim_finance_invoice i ON i.move_id = f.move_id
       WHERE f.SnapshotDateKey = ? AND f.receivable_scope = 'customer_debt' AND f.is_intercompany = 0 AND f.PaymentKey = -1
         AND i.move_type = 'out_invoice' AND f.residual_doc_ccy > 0
         AND f.SalesTeamKey NOT IN (SELECT SalesTeamKey FROM v_finance_excluded_sales_team) ${extra}
       GROUP BY cur.currency, f.CustomerKey`,
      [snap, ...params],
    );

  it('every currency: same customers, same deciding invoice, same outstanding (invoice currency and LYD)', async () => {
    const want = await independent();
    const currencies = [...new Set(want.map((w) => String(w.currency)))];
    const first = await get('/debt-report/aging');
    expect(first.status).toBe(200);
    expect([...first.body.currencies].sort()).toEqual(currencies.sort());
    for (const c of currencies) {
      const { body } = await get(`/debt-report/aging?currency=${c}`);
      const mine = want.filter((w) => w.currency === c);
      expect(body.customers.length, c).toBe(mine.length);
      const got = new Map(body.customers.map((x: Json) => [x.customerKey, x]));
      for (const w of mine) {
        const g = got.get(n(w.CustomerKey)) as Json;
        expect(g, `${c} customer ${w.CustomerKey}`).toBeTruthy();
        expect(g.oldestOpenMoveId).toBe(n(w.oldest));
        expect(Math.abs(g.outstanding - n(w.net))).toBeLessThan(0.000001);
        expect(Math.abs(g.outstandingCompany - n(w.net_company))).toBeLessThan(0.000001);
      }
    }
  });

  it('the term filter keeps only that term', async () => {
    const now = (await get('/debt-report/aging')).body;
    const term = now.terms[0].key;
    const only = (await get(`/debt-report/aging?term=${term}`)).body;
    expect(only.customers.every((c: Json) => c.termKey === term)).toBe(true);
    expect(only.customers.length).toBe(now.terms[0].customers);
  });

  it("a salesperson's map is built from their own lines only; 403 while the role is not enabled", async () => {
    expect((await get('/debt-report/aging', 'salesperson')).status).toBe(403);
    const r = await get('/debt-report/aging', 'salespersonEnabled');
    expect(r.status).toBe(200);
    const want = await independent('AND f.SalespersonKey = ?', [spKey]);
    const mine = want.filter((w) => w.currency === r.body.currency);
    expect(r.body.customers.map((c: Json) => c.customerKey).sort()).toEqual(mine.map((w) => n(w.CustomerKey)).sort());
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

  it.each(SCOPES)('%s: Overdue + Not yet due = Total debt (invoice currency and LYD), both shares in [0%%, 100%%], map total = Total debt', async (label, qs) => {
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
      close(map.body.customers.reduce((t: number, x: Json) => t + x.outstanding, 0), k.openAmount, `${tag}: map total = total debt`);
      close(map.body.customers.reduce((t: number, x: Json) => t + x.outstandingCompany, 0), k.openAmountCompany, `${tag}: map total in LYD`);
      expect(map.body.customers.length, `${tag}: map customers = customers with an open invoice`).toBe(k.customers);
    }
    const all = overview.body.allCurrencies;
    close(all.overdueAmount + all.notDueAmount, all.openAmount, `${label} all currencies: overdue + not due = total debt`);
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
