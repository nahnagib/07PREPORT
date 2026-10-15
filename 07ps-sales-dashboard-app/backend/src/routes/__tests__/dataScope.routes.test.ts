import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Role data scope with operators (2026-10-15) end to end over real HTTP: the REAL services/dataScopeService.ts, the
 * real scope middleware, the real Receivables and Collections router and the real admin Roles router. Only the
 * signed-in user, the grants and the database are faked: role_data_scope rows and dim_company live in memory, and
 * every SQL the API sends is recorded, so the tests see what reaches the queries -- server-side, not only the UI.
 */

const state = {
  /** role_data_scope rows of role 7 (the signed-in user's primary role) */
  rows: [] as { scope_id: number; role_id: number; dimension: string; operator: string; value: string }[],
  companies: [
    { k: -1, label: 'Unknown' },
    { k: 1, label: 'Majaal' },
    { k: 3, label: 'Tika' },
    { k: 9, label: 'Athena' },
    { k: 12, label: 'X' },
  ],
  /** simulate the database before migration 0044 (no operator column) */
  noOperatorColumn: false,
};
const queries: { sql: string; params: unknown[] }[] = [];

vi.mock('../../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = {
      id: 100, email: 'u@test.local', fullName: 'u', status: 'ACTIVE', mustChangePassword: false, roleId: 7, roleName: null,
      roleLabel: null, roles: [], isAdmin: true, roleTierCode: 'BI00_EXECUTIVE', salespersonKey: null, companyScope: 'ALL', jti: 'j',
    } as unknown as express.Request['user'];
    next();
  },
}));
vi.mock('../../services/permissionService', async () => {
  const actual = await vi.importActual<typeof import('../../services/permissionService')>('../../services/permissionService');
  return { ...actual, getRequestPermissions: async () => actual.computeEffectivePermissions({ isAdmin: true, roleGrants: [], overrides: [] }) };
});
vi.mock('../../services/roleService', () => ({
  ROLE_ENTITY: 'role',
  RoleInUseError: class extends Error {},
  createRole: vi.fn(),
  deleteRole: vi.fn(),
  duplicateRole: vi.fn(),
  getRoleDetail: vi.fn(async (id: number) => (id === 7 ? { role_id: 7 } : null)),
  listRoleTiers: vi.fn(async () => []),
  listRolesWithStats: vi.fn(async () => []),
  updateRole: vi.fn(),
}));
vi.mock('../../services/auditLogService', () => ({ writeAuditLog: vi.fn(async () => true) }));
vi.mock('../../measures/departmentFreshness', () => ({
  fetchDepartmentFreshness: async () => ({ department: 'finance', lastSuccessUtc: null, dataAsOf: null }),
}));

function answer(sql: string, params: unknown[]): unknown[] {
  if (/FROM role_data_scope/.test(sql) && /^\s*SELECT/i.test(sql)) {
    if (state.noOperatorColumn && /SELECT role_id, dimension, operator, value/.test(sql)) throw Object.assign(new Error('Unknown column'), { code: 'ER_BAD_FIELD_ERROR' });
    const roleId = params[0];
    return state.rows
      .filter((r) => roleId === undefined || r.role_id === roleId)
      .map((r) => ({ ...r, operator: state.noOperatorColumn ? null : r.operator }));
  }
  if (/FROM dim_company/.test(sql)) return state.companies.map((c) => ({ k: c.k, label: c.label }));
  if (/FROM dim_(segment|channel|sales_team|salesperson)\b/.test(sql)) return [{ k: -1, label: 'Unknown' }];
  if (/MAX\(SnapshotDateKey\) AS k/.test(sql)) return [{ k: 20261004 }];
  if (/SELECT 1 AS ok/.test(sql)) return [{ ok: 1 }];
  if (/FROM cfg_finance_aging_zone/.test(sql)) {
    return [
      { zone_key: 'green', label_en: 'Green', upper_multiplier: '1.000', owner_en: 'Sales rep' },
      { zone_key: 'black', label_en: 'Black', upper_multiplier: null, owner_en: 'Legal' },
    ];
  }
  return [];
}

vi.mock('../../db/pool', () => {
  const query = async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    return [answer(sql, params), []];
  };
  return {
    pool: {
      query,
      getConnection: async () => {
        const pending: typeof state.rows = [];
        let deleted: { dimension: string } | null = null;
        return {
          beginTransaction: async () => undefined,
          query: async (sql: string, params: unknown[] = []) => {
            queries.push({ sql, params });
            if (/^DELETE FROM role_data_scope/.test(sql)) deleted = { dimension: String(params[1]) };
            if (/^INSERT INTO role_data_scope/.test(sql)) {
              pending.push({ scope_id: 1000 + pending.length, role_id: Number(params[0]), dimension: String(params[1]), operator: String(params[2]), value: String(params[3]) });
            }
            return [[], []];
          },
          commit: async () => {
            if (deleted) state.rows = state.rows.filter((r) => r.dimension !== deleted!.dimension);
            state.rows.push(...pending);
          },
          rollback: async () => undefined,
          release: () => undefined,
        };
      },
    },
  };
});

let server: Server;
let base = '';
type Body = {
  error?: string;
  dataScope?: Record<number, unknown>;
  values?: { value: string; label: string }[];
};
type Res = { status: number; body: Body };
async function call(method: string, path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: ((await res.json().catch(() => null)) ?? {}) as Body };
}
const setRules = (rules: { dimension: string; operator: string; values: string[] }[]) => {
  state.rows = rules.flatMap((r, i) => r.values.map((value, j) => ({ scope_id: i * 100 + j, role_id: 7, dimension: r.dimension, operator: r.operator, value })));
};
/** The company condition every pass over the receivable lines carries, and its parameters. */
function receivableCompanyParams(): unknown[] {
  const lineQueries = queries.filter((q) => q.sql.includes('FROM fact_finance_receivable_snapshot f'));
  expect(lineQueries.length).toBeGreaterThan(0);
  const seen = lineQueries.map((q) => {
    const m = q.sql.match(/f\.CompanyKey IN \(([?, ]+)\)/);
    expect(m, 'every receivable query is scoped by company').toBeTruthy();
    const n = m![1].split(',').length;
    // the clause's own parameters: as many as the placeholders before it in the SQL (not the '?' string literals)
    const i = (q.sql.slice(0, m!.index).match(/'[^']*'|\?/g) ?? []).filter((t) => t === '?').length;
    return q.params.slice(i, i + n);
  });
  for (const s of seen) expect(s).toEqual(seen[0]);
  return seen[0];
}

beforeAll(async () => {
  const { debtReportRouter } = await import('../debtReport');
  const { adminRolesRouter } = await import('../admin/roles');
  const app = express();
  app.use(express.json());
  app.use('/debt-report', debtReportRouter);
  app.use('/admin/roles', adminRolesRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  queries.length = 0;
  state.noOperatorColumn = false;
  state.companies = state.companies.filter((c) => c.k !== 14);
});

describe('data scope operators, enforced on the server (Receivables and Collections)', () => {
  it('"Company is none of [X]": every receivable query sees Majaal, Tika, Athena (and Unknown), never X', async () => {
    setRules([{ dimension: 'companyKeys', operator: 'not_in', values: ['12'] }]);
    for (const path of ['/overview', '/customers', '/trend', '/drilldown?kind=aging&key=8', '/aging?allCurrencies=true']) {
      queries.length = 0;
      expect((await call('GET', `/debt-report${path}`)).status, path).toBe(200);
      expect(receivableCompanyParams(), path).toEqual([-1, 1, 3, 9]);
    }
  });

  it('a company added later is visible without touching the role', async () => {
    setRules([{ dimension: 'companyKeys', operator: 'not_in', values: ['12'] }]);
    state.companies.push({ k: 14, label: 'Y' });
    expect((await call('GET', '/debt-report/customers')).status).toBe(200);
    expect(receivableCompanyParams()).toEqual([-1, 1, 3, 9, 14]);
    expect(state.rows.map((r) => [r.operator, r.value])).toEqual([['not_in', '12']]); // still an exclusion
  });

  it('asking for the excluded company directly is a 403, before any receivable query', async () => {
    setRules([{ dimension: 'companyKeys', operator: 'not_in', values: ['12'] }]);
    expect((await call('GET', '/debt-report/customers?companyKeys=12')).status).toBe(403);
    expect(queries.some((q) => q.sql.includes('fact_finance_receivable_snapshot'))).toBe(false);
    // narrowing inside the scope still works
    expect((await call('GET', '/debt-report/customers?companyKeys=3')).status).toBe(200);
    expect(receivableCompanyParams()).toEqual([3]);
  });

  it('"Company is any of [Majaal, Tika]" shows only those two', async () => {
    setRules([{ dimension: 'companyKeys', operator: 'in', values: ['1', '3'] }]);
    expect((await call('GET', '/debt-report/overview')).status).toBe(200);
    expect(receivableCompanyParams()).toEqual([1, 3]);
    expect((await call('GET', '/debt-report/overview?companyKeys=9')).status).toBe(403);
  });

  it('rules on different dimensions combine with AND', async () => {
    setRules([
      { dimension: 'companyKeys', operator: 'not_in', values: ['12'] },
      { dimension: 'salesTeamKeys', operator: 'in', values: ['MJ-A', 'MJ-B'] },
    ]);
    expect((await call('GET', '/debt-report/customers')).status).toBe(200);
    const q = queries.find((x) => x.sql.includes('FROM fact_finance_receivable_snapshot f'))!;
    expect(q.sql).toMatch(/f\.CompanyKey IN \(\?, \?, \?, \?\) AND f\.SalesTeamKey IN \(\?, \?\)/);
    expect(q.params).toEqual(expect.arrayContaining([-1, 1, 3, 9, 'MJ-A', 'MJ-B']));
  });

  it('before migration 0044 (no operator column) the old rows keep working as "is any of"', async () => {
    setRules([{ dimension: 'companyKeys', operator: 'in', values: ['1'] }]);
    state.noOperatorColumn = true;
    expect((await call('GET', '/debt-report/overview')).status).toBe(200);
    expect(receivableCompanyParams()).toEqual([1]);
  });
});

describe('Roles page API: rules are validated on save, never trusted', () => {
  it('saves { operator, values } as one rule per dimension and returns it with labels', async () => {
    setRules([{ dimension: 'companyKeys', operator: 'in', values: ['1'] }]);
    const res = await call('PUT', '/admin/roles/7/data-scope/companyKeys', { operator: 'not_in', values: ['12', 12] });
    expect(res.status).toBe(200);
    expect(state.rows.map((r) => [r.dimension, r.operator, r.value])).toEqual([['companyKeys', 'not_in', '12']]); // replaced, de-duplicated
    expect(res.body.dataScope?.[7]).toEqual([{ dimension: 'companyKeys', operator: 'not_in', values: [{ value: '12', label: 'X' }] }]);
  });

  it.each([
    [{ operator: 'nope', values: ['1'] }, /Operator/],
    [{ operator: 'in', values: [] }, /at least one value/],
    [{ operator: 'in' }, /list/],
    [{ operator: 'not_in', values: ['99'] }, /Unknown value/],
  ])('400 on %j', async (body, message) => {
    setRules([]);
    const res = await call('PUT', '/admin/roles/7/data-scope/companyKeys', body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
    expect(state.rows).toEqual([]);
  });

  it('400 on an unknown dimension, 404 on an unknown role', async () => {
    expect((await call('PUT', '/admin/roles/7/data-scope/customerKeys', { operator: 'in', values: ['1'] })).status).toBe(400);
    expect((await call('PUT', '/admin/roles/8/data-scope/companyKeys', { operator: 'in', values: ['1'] })).status).toBe(404);
  });

  it('removing a rule lifts the restriction on that dimension', async () => {
    setRules([{ dimension: 'companyKeys', operator: 'not_in', values: ['12'] }]);
    expect((await call('DELETE', '/admin/roles/7/data-scope/companyKeys')).status).toBe(200);
    expect(queries.some((q) => /DELETE FROM role_data_scope WHERE role_id = \? AND dimension = \?/.test(q.sql))).toBe(true);
  });

  it('the picker offers every value of a dimension, Unknown / Unassigned included', async () => {
    const res = await call('GET', '/admin/roles/dimension-values/companyKeys');
    expect(res.status).toBe(200);
    expect(res.body.values?.[0]).toEqual({ value: '-1', label: 'Unknown company' });
    expect(res.body.values?.map((v) => v.value)).toEqual(['-1', '9', '1', '3', '12']);
    expect((await call('GET', '/admin/roles/dimension-values/salespersonKeys')).body.values).toEqual([{ value: '-1', label: 'Unassigned' }]);
    expect((await call('GET', '/admin/roles/dimension-values/nope')).status).toBe(400);
  });

  it("is never narrowed by the signed-in admin's own data scope", async () => {
    setRules([{ dimension: 'companyKeys', operator: 'in', values: ['1'] }]); // the admin's own role: Majaal only
    const res = await call('GET', '/admin/roles/dimension-values/companyKeys');
    expect(res.body.values?.map((v) => v.label)).toEqual(['Unknown company', 'Athena', 'Majaal', 'Tika', 'X']);
  });
});
