import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DateTime } from 'luxon';

/**
 * Admin > Critical Number API over real HTTP: the real router and requireAdminRole, the signed-in user supplied by
 * the test, the database-backed service faked. Only the Admin role may read or change the value -- no grantable
 * permission opens it.
 */

const USERS: Record<string, { isAdmin: boolean }> = {
  viewer: { isAdmin: false },
  // holds admin_companies (where the Critical Number shares live) -- still no access to the base value
  companyEditor: { isAdmin: false },
  admin: { isAdmin: true },
};

vi.mock('../../middleware/auth', () => ({
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const who = req.header('x-test-user');
    if (!who || !USERS[who]) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    req.user = { id: 100, email: `${who}@test.local`, fullName: who, mustChangePassword: false, isAdmin: USERS[who].isAdmin } as express.Request['user'];
    next();
  },
}));

const service = {
  getCriticalNumberAdminView: vi.fn(async () => ({ current: null, scheduled: [], history: [], today: '2026-10-21' })),
  createCriticalNumberChange: vi.fn(async () => ({ current: null, scheduled: [], history: [], today: '2026-10-21' })),
};
vi.mock('../../services/criticalNumberAdminService', () => service);

let server: Server;
let base = '';

beforeAll(async () => {
  const { adminCriticalNumberRouter } = await import('../admin/criticalNumber');
  const app = express();
  app.use(express.json());
  app.use('/admin/critical-number', adminCriticalNumberRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server?.close(r));
});

function call(method: string, who: string, body?: unknown): Promise<Response> {
  return fetch(`${base}/admin/critical-number`, {
    method,
    headers: { 'x-test-user': who, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('Admin > Critical Number API', () => {
  it('rejects every non-admin with 403, reads and writes alike', async () => {
    for (const who of ['viewer', 'companyEditor']) {
      expect((await call('GET', who)).status).toBe(403);
      expect((await call('POST', who, { value: 1, effectiveFrom: '2026-10-21' })).status).toBe(403);
    }
    expect(service.getCriticalNumberAdminView).not.toHaveBeenCalled();
    expect(service.createCriticalNumberChange).not.toHaveBeenCalled();
  });

  it('rejects an anonymous caller with 401', async () => {
    expect((await call('GET', 'nobody')).status).toBe(401);
  });

  it('lets the Admin role read and change it', async () => {
    expect((await call('GET', 'admin')).status).toBe(200);
    expect((await call('POST', 'admin', { value: 600000, effectiveFrom: '2026-11-01' })).status).toBe(201);
    expect(service.createCriticalNumberChange).toHaveBeenCalledWith(
      { value: 600000, effectiveFrom: '2026-11-01', note: undefined, confirmLargeChange: undefined },
      100,
    );
  });
});

/**
 * Admin > Companies / Customer Groups (2026-11-09): the hand-typed "Critical Number %" is gone. Each row carries a
 * read-only target_share_pct computed by the Critical Number page's own computeTargetShare (real services and
 * measure, database faked); criticalNumberPct in a request body is still accepted (older clients) but never written.
 */
const ADMIN_YEAR = DateTime.now().setZone(process.env.APP_TIMEZONE || 'Africa/Tripoli').year;
const db = vi.hoisted(() => ({ updates: [] as { sql: string; params: unknown[] }[], targetCalls: [] as unknown[][] }));

vi.mock('../../db/pool', () => ({
  pool: {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM v_sales_targets')) {
        db.targetCalls.push(params);
        // Tika (CompanyKey 3) / B2B (SegmentKey 1): their part of the year's total
        const scoped = params[0] === 3 ? 89_016_000 : 106_510_000;
        return [[{ year: ADMIN_YEAR, scoped, total: 169_164_533 }]];
      }
      if (sql.includes('SELECT COUNT(*) AS total')) return [[{ total: 1 }]];
      if (sql.includes('FROM admin_company co')) {
        return [[{ company_id: 7, name: 'Tika', definition: null, etl_company_key: 3, etl_company_name: 'Tika', display_order: 1,
          critical_number_pct: '52.56', is_active: 1, usage_count: 0 }]];
      }
      if (sql.includes('FROM admin_customer_group g')) {
        return [[{ customer_group_id: 8, name: 'B2B', definition: null, etl_segment_key: 1, etl_segment_name: 'B2B', display_order: 1,
          critical_number_pct: '62.88', is_active: 1, usage_count: '0' }]];
      }
      if (sql.startsWith('SELECT 1 FROM')) return [[]];
      if (sql.includes('UPDATE admin_company') || sql.includes('UPDATE admin_customer_group')) db.updates.push({ sql, params });
      return [{}];
    },
  },
}));
vi.mock('../../middleware/permission', async () => {
  const actual = await vi.importActual<typeof import('../../middleware/permission')>('../../middleware/permission');
  // the admin_companies / admin_customer_groups grants are not what this test is about
  return { ...actual, requirePermission: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next() };
});

describe('Admin > Companies / Customer Groups: share of FY target', () => {
  let adminServer: Server;
  let adminBase = '';

  beforeAll(async () => {
    const { adminCompaniesRouter } = await import('../admin/companies');
    const { adminCustomerGroupsRouter } = await import('../admin/customerGroups');
    const app = express();
    app.use(express.json());
    app.use('/admin/companies', adminCompaniesRouter);
    app.use('/admin/customer-groups', adminCustomerGroupsRouter);
    adminServer = app.listen(0);
    adminBase = `http://127.0.0.1:${(adminServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((r) => adminServer?.close(r));
  });

  type AdminRow = { target_share_pct: number; critical_number_pct: number };
  type AdminRows = { rows: AdminRow[] };

  function adminCall(path: string, method = 'GET', body?: unknown): Promise<Response> {
    return fetch(`${adminBase}${path}`, {
      method,
      headers: { 'x-test-user': 'admin', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  it('lists each row with its read-only share of the current year target, from the same share function', async () => {
    db.targetCalls.length = 0;
    const companies = (await (await adminCall('/admin/companies')).json()) as AdminRows;
    expect(companies.rows[0].target_share_pct).toBeCloseTo((89_016_000 / 169_164_533) * 100, 6);
    expect(companies.rows[0].critical_number_pct).toBe(52.56); // still returned (API compatible), no longer used
    const groups = (await (await adminCall('/admin/customer-groups')).json()) as AdminRows;
    expect(groups.rows[0].target_share_pct).toBeCloseTo((106_510_000 / 169_164_533) * 100, 6);
    expect(db.targetCalls).toEqual([[3], [1]]);
  });

  it('ignores criticalNumberPct on PATCH: the stored value is kept, the share is unchanged', async () => {
    db.updates.length = 0;
    const res = await adminCall('/admin/companies/7', 'PATCH', { criticalNumberPct: 99 });
    expect(res.status).toBe(200);
    const res2 = await adminCall('/admin/customer-groups/8', 'PATCH', { criticalNumberPct: 1 });
    expect(res2.status).toBe(200);
    expect(db.updates).toHaveLength(2);
    // SET name, definition, etl key, etl name, display_order, critical_number_pct, ...
    expect(db.updates[0].sql).toMatch(/display_order = \?, critical_number_pct = \?/);
    expect(db.updates[0].params[5]).toBe(52.56);
    expect(db.updates[1].params[5]).toBe(62.88);
    expect(((await res.json()) as { row: AdminRow }).row.target_share_pct).toBeCloseTo((89_016_000 / 169_164_533) * 100, 6);
  });
});
