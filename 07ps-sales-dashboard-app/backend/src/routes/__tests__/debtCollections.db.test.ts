import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Collections trend on the real warehouse, READ-ONLY (npm run test:debt-db -- needs DB_* in the environment, e.g. the
 * local powerBI_Data after a finance_receivables run that loaded fact_finance_collection). Checks the ETL's invariants
 * in SQL and that the endpoints add up to the view, written independently.
 */
const RUN = process.env.DEBT_TEST_DB === '1';

vi.mock('../../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = {
      id: 100, email: 't@test.local', fullName: 't', status: 'ACTIVE', mustChangePassword: false, roleId: null, roleName: null,
      roleLabel: null, roles: [], isAdmin: true, roleTierCode: 'BI00_EXECUTIVE', salespersonKey: null, companyScope: 'ALL', jti: 'j',
    } as unknown as express.Request['user'];
    next();
  },
}));

vi.mock('../../services/permissionService', async () => {
  const actual = await vi.importActual<typeof import('../../services/permissionService')>('../../services/permissionService');
  return { ...actual, getRequestPermissions: async () => actual.computeEffectivePermissions({ isAdmin: true, roleGrants: [], overrides: [] }) };
});

let server: Server;
let base = '';
let pool: typeof import('../../db/pool').pool;
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const get = async (path: string): Promise<{ status: number; body: Json }> => {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
};
const qa = async (sql: string, params: unknown[] = []): Promise<Json[]> => (await pool.query(sql, params))[0] as Json[];
const q1 = async (sql: string, params: unknown[] = []): Promise<Json> => (await qa(sql, params))[0];
const n = (v: unknown) => Number(v ?? 0);

describe.skipIf(!RUN)('Collections on the real warehouse (read-only)', () => {
  beforeAll(async () => {
    ({ pool } = await import('../../db/pool'));
    const { debtReportRouter } = await import('../debtReport');
    const app = express();
    app.use('/debt-report', debtReportRouter);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server?.close();
    await pool?.end();
  });

  it('the fact is loaded', async () => {
    expect(n((await q1('SELECT COUNT(*) AS k FROM fact_finance_collection')).k)).toBeGreaterThan(0);
  });

  it('the rows of every payment add up to the payment, and every row to its split', async () => {
    const bad = await qa(
      `SELECT c.payment_id FROM fact_finance_collection c JOIN raw_odoo_customer_payment r ON r.id = c.payment_id
        GROUP BY c.payment_id, r.amount HAVING ABS(SUM(c.amount_doc_ccy) - r.amount) > 0.01 LIMIT 5`,
    );
    expect(bad).toEqual([]);
    const split = await qa(
      `SELECT payment_id FROM fact_finance_collection WHERE ABS(applied_overdue_doc_ccy + applied_not_due_doc_ccy + applied_other_doc_ccy
        + unapplied_doc_ccy - amount_doc_ccy) > 0.01 LIMIT 5`,
    );
    expect(split).toEqual([]);
    const shares = await qa('SELECT payment_id FROM fact_finance_collection GROUP BY payment_id HAVING ABS(SUM(share) - 1) > 0.000001 LIMIT 5');
    expect(shares).toEqual([]);
  });

  it('exactly the posted inbound customer payments that are not internal transfers (non-zero) are in the fact', async () => {
    const r = await q1(
      `SELECT (SELECT COUNT(*) FROM raw_odoo_customer_payment WHERE state = 'posted' AND is_internal_transfer = 0 AND amount <> 0) AS want,
              (SELECT COUNT(DISTINCT payment_id) FROM fact_finance_collection) AS got,
              (SELECT COUNT(*) FROM fact_finance_collection c JOIN raw_odoo_customer_payment r ON r.id = c.payment_id
                WHERE r.state <> 'posted' OR r.is_internal_transfer = 1) AS wrong`,
    );
    expect(n(r.got)).toBe(n(r.want));
    expect(n(r.wrong)).toBe(0);
  });

  it('the payment -> invoice matches add up to the applied part of their allocation', async () => {
    const bad = await qa(
      `SELECT c.payment_id, c.allocation_no FROM fact_finance_collection c
         LEFT JOIN (SELECT payment_id, allocation_no, SUM(CASE WHEN kind = 'other' THEN 0 ELSE applied_doc_ccy END) AS inv,
                           SUM(CASE WHEN kind = 'other' THEN applied_doc_ccy ELSE 0 END) AS oth
                      FROM fact_finance_collection_invoice GROUP BY payment_id, allocation_no) m
           ON m.payment_id = c.payment_id AND m.allocation_no = c.allocation_no
        WHERE ABS(COALESCE(m.inv, 0) - c.applied_overdue_doc_ccy - c.applied_not_due_doc_ccy) > 0.01
           OR ABS(COALESCE(m.oth, 0) - c.applied_other_doc_ccy) > 0.01 LIMIT 5`,
    );
    expect(bad).toEqual([]);
  });

  it('the view drops the inter-company customers and the report exclusions, nothing else', async () => {
    const r = await q1(
      `SELECT (SELECT COUNT(*) FROM v_finance_collection_trend) AS kept,
              (SELECT COUNT(*) FROM fact_finance_collection c WHERE c.is_intercompany = 0 AND NOT EXISTS (
                 SELECT 1 FROM v_finance_excluded_sales_team x WHERE x.SalesTeamKey = c.SalesTeamKey AND (x.invoices_only = 0 OR c.attribution = 'invoice'))) AS want`,
    );
    expect(n(r.kept)).toBe(n(r.want));
  });

  it('trend sums only prior invoice portions per week; drill-down rows = the bar', async () => {
    const from = '2026-08-30';
    const to = '2026-09-26';
    const t = (await get(`/debt-report/collections-trend?currency=LYD&grain=week&from=${from}&to=${to}`)).body;
    expect(t.points.map((p: Json) => p.periodStart)).toEqual(['2026-08-30', '2026-09-06', '2026-09-13', '2026-09-20']);
    const direct = await qa(
      `SELECT DATE_FORMAT(DATE_SUB(v.payment_date, INTERVAL (DAYOFWEEK(v.payment_date) - 1) DAY), '%Y-%m-%d') AS w,
              SUM(m.applied_doc_ccy) AS s, COUNT(DISTINCT v.payment_id) AS k
         FROM v_finance_collection_trend v
         JOIN fact_finance_collection_invoice m ON m.payment_id = v.payment_id AND m.allocation_no = v.allocation_no
         JOIN dim_finance_collection_invoice_date d ON d.move_id = m.move_id
        WHERE v.currency = 'LYD' AND v.payment_date BETWEEN ? AND ?
          AND m.move_type IN ('out_invoice', 'out_receipt') AND m.applied_doc_ccy > 0 AND d.invoice_date < v.payment_date GROUP BY w`,
      [from, to],
    );
    for (const p of t.points) {
      const d = direct.find((x) => x.w === p.periodStart);
      expect(Math.abs(p.collected - n(d?.s))).toBeLessThan(0.01);
      expect(p.payments).toBe(n(d?.k));
      expect(Math.abs(p.appliedOverdue + p.appliedNotDue + p.appliedOther + p.unapplied - p.collected)).toBeLessThan(0.01);
    }
    const busiest = t.points.reduce((a: Json, b: Json) => (b.collected > a.collected ? b : a));
    const dd = (await get(`/debt-report/collections-drilldown?currency=LYD&grain=week&period=${busiest.periodStart}`)).body;
    if (!dd.truncated) expect(Math.abs(dd.rows.reduce((s: number, r: Json) => s + r.amount, 0) - busiest.collected)).toBeLessThan(0.01);
  });

  it('month and day grains cover the same money as the week grain over whole months', async () => {
    const m = (await get('/debt-report/collections-trend?currency=LYD&grain=month&from=2026-09-01&to=2026-09-30')).body;
    const d = (await get('/debt-report/collections-trend?currency=LYD&grain=day&from=2026-09-01&to=2026-09-30')).body;
    expect(d.points).toHaveLength(30);
    expect(Math.abs(m.points[0].collected - d.points.reduce((s: number, p: Json) => s + p.collected, 0))).toBeLessThan(0.01);
  });

  it('a company filter keeps that company only', async () => {
    const all = (await get('/debt-report/collections-trend?currency=LYD&grain=month&from=2026-09-01&to=2026-09-30')).body.points[0].collected;
    const parts = await Promise.all([1, 3, 9].map(async (c) => (await get(`/debt-report/collections-trend?currency=LYD&grain=month&from=2026-09-01&to=2026-09-30&companyKeys=${c}`)).body.points[0].collected));
    expect(Math.abs(parts.reduce((s, v) => s + v, 0) - all)).toBeLessThan(0.01);
  });

  it('all currencies (≈ LYD): qualifying invoice portions at each payment rate; drill-down = bar', async () => {
    const from = '2026-08-30';
    const to = '2026-10-10';
    const t = (await get(`/debt-report/collections-trend?allCurrencies=true&grain=week&from=${from}&to=${to}`)).body;
    expect(t.allCurrencies).toBe(true);
    expect(t.currency).toBe('LYD');
    const direct = await qa(
      `SELECT DATE_FORMAT(DATE_SUB(v.payment_date, INTERVAL (DAYOFWEEK(v.payment_date) - 1) DAY), '%Y-%m-%d') AS w,
              SUM(COALESCE(m.applied_doc_ccy * v.amount_company_ccy / NULLIF(v.amount_doc_ccy, 0), 0)) AS s,
              COUNT(DISTINCT v.payment_id) AS k
         FROM v_finance_collection_trend v
         JOIN fact_finance_collection_invoice m ON m.payment_id = v.payment_id AND m.allocation_no = v.allocation_no
         JOIN dim_finance_collection_invoice_date d ON d.move_id = m.move_id
        WHERE v.payment_date BETWEEN ? AND ? AND m.move_type IN ('out_invoice', 'out_receipt')
          AND m.applied_doc_ccy > 0 AND d.invoice_date < v.payment_date GROUP BY w`,
      [from, to],
    );
    for (const p of t.points) {
      const d = direct.find((x) => x.w === p.periodStart);
      expect(Math.abs(p.collected - n(d?.s))).toBeLessThan(0.01);
      expect(p.payments).toBe(n(d?.k));
      expect(Math.abs(p.appliedOverdue + p.appliedNotDue + p.appliedOther + p.unapplied - p.collected)).toBeLessThan(0.05);
      if (p.collectionRate !== null) expect(p.collectionRate).toBeGreaterThanOrEqual(0);
    }
    const busiest = t.points.reduce((a: Json, b: Json) => (b.collected > a.collected ? b : a));
    const dd = (await get(`/debt-report/collections-drilldown?allCurrencies=true&grain=week&period=${busiest.periodStart}`)).body;
    expect(dd.allCurrencies).toBe(true);
    if (!dd.truncated) expect(Math.abs(dd.rows.reduce((s: number, r: Json) => s + r.amountCompany, 0) - busiest.collected)).toBeLessThan(0.01);
    expect((await get(`/debt-report/collections-drilldown?grain=week&period=${busiest.periodStart}`)).status).toBe(400);
  });

  it('all historical invoice matches have dates, and same-day sales exist but cannot qualify', async () => {
    const r = await q1(`SELECT SUM(d.invoice_date IS NULL) AS missing,
         SUM(d.invoice_date = c.payment_date) AS same_day, SUM(d.invoice_date < c.payment_date) AS earlier
       FROM fact_finance_collection_invoice m
       JOIN fact_finance_collection c ON c.payment_id = m.payment_id AND c.allocation_no = m.allocation_no
       LEFT JOIN dim_finance_collection_invoice_date d ON d.move_id = m.move_id
       WHERE m.move_type IN ('out_invoice','out_receipt')`);
    expect(n(r.missing)).toBe(0);
    expect(n(r.same_day)).toBeGreaterThan(0);
    expect(n(r.earlier)).toBeGreaterThan(0);
  });

  it('bad parameters are a 400', async () => {
    expect((await get('/debt-report/collections-trend?grain=year')).status).toBe(400);
    expect((await get('/debt-report/collections-drilldown?currency=LYD&period=x')).status).toBe(400);
  });
});
