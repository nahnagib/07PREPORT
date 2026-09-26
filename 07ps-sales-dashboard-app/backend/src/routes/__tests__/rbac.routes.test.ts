import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Server-side enforcement over real HTTP: the real routers and permission middleware, with the
 * signed-in user and their role grants supplied by the test. Only the database-backed services the
 * routers call are faked.
 */

type Grant = [pageKey: string, action: string];
const USERS: Record<string, { isAdmin?: boolean; grants: Grant[] }> = {
  // "Viewer – Revenue only": View on Revenue Trend, nothing else.
  viewer: { grants: [['revenue_trend', 'view']] },
  exporter: { grants: [['revenue_trend', 'view'], ['revenue_trend', 'export']] },
  companyViewer: { grants: [['admin_companies', 'view']] },
  companyEditor: { grants: [['admin_companies', 'view'], ['admin_companies', 'create'], ['admin_companies', 'edit']] },
  // Several roles combine: one gives Revenue Trend, another gives Roles view.
  twoRoles: { grants: [['revenue_trend', 'view'], ['admin_roles', 'view']] },
  admin: { isAdmin: true, grants: [] },
};

vi.mock('../../middleware/auth', () => ({
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const who = req.header('x-test-user');
    if (!who || !USERS[who]) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    req.user = {
      id: 100,
      email: `${who}@test.local`,
      fullName: who,
      status: 'ACTIVE',
      mustChangePassword: false,
      roleId: 1,
      roleName: null,
      roleLabel: null,
      roles: [],
      isAdmin: USERS[who].isAdmin === true,
      roleTierCode: 'BI00_EXECUTIVE',
      salespersonKey: null,
      companyScope: 'ALL',
      jti: 'j',
    } as express.Request['user'];
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

const companyService = {
  createCompany: vi.fn(async () => ({ company_id: 1 })),
  deleteCompany: vi.fn(async () => undefined),
  getCompanyById: vi.fn(async () => ({ company_id: 1 })),
  getEtlCompanyOptions: vi.fn(async () => []),
  listCompanies: vi.fn(async () => ({ rows: [], total: 0 })),
  updateCompany: vi.fn(async () => ({ company_id: 1 })),
};
vi.mock('../../services/companyAdminService', () => companyService);
vi.mock('../../services/roleService', () => ({
  ROLE_ENTITY: 'role',
  RoleInUseError: class extends Error {},
  createRole: vi.fn(async () => ({ role_id: 60 })),
  deleteRole: vi.fn(async () => undefined),
  duplicateRole: vi.fn(async () => ({ role_id: 61 })),
  getRoleDetail: vi.fn(async () => ({ role_id: 1 })),
  listRoleTiers: vi.fn(async () => []),
  listRolesWithStats: vi.fn(async () => []),
  updateRole: vi.fn(async () => ({ role_id: 1 })),
}));
vi.mock('../../services/dataScopeService', () => ({
  DATA_SCOPE_DIMENSIONS: [],
  addRoleDataScopeRule: vi.fn(),
  getAllRoleDataScopeRulesWithLabels: vi.fn(async () => ({})),
  removeRoleDataScopeRule: vi.fn(),
}));
vi.mock('../../services/auditLogService', () => ({ writeAuditLog: vi.fn(async () => true) }));

let server: Server;
let base = '';

beforeAll(async () => {
  const { exportsRouter } = await import('../exports');
  const { adminCompaniesRouter } = await import('../admin/companies');
  const { adminRolesRouter } = await import('../admin/roles');
  const { requireAnyDashboardView, requireAdminRole } = await import('../../middleware/permission');
  const { requireAuth } = await import('../../middleware/auth');
  const app = express();
  app.use(express.json());
  app.use('/exports', exportsRouter);
  app.use('/admin/companies', adminCompaniesRouter);
  app.use('/admin/roles', adminRolesRouter);
  // Stand-ins for the shared filter-bar endpoint and an Admin-role-only endpoint.
  app.get('/filters/probe', requireAuth, requireAnyDashboardView, (_req, res) => res.json({ ok: true }));
  app.get('/admin-only/probe', requireAuth, requireAdminRole, (_req, res) => res.json({ ok: true }));
  // eslint-disable-next-line no-unused-vars
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: String(err) });
  });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server?.close(r));
});

function call(method: string, path: string, who: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'x-test-user': who, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('Viewer – Revenue only', () => {
  it('can use the shared filter endpoints (not tied to Tachometer any more)', async () => {
    expect((await call('GET', '/filters/probe', 'viewer')).status).toBe(200);
  });

  it('gets 403 from the export check on Revenue Trend (no Export permission)', async () => {
    expect((await call('POST', '/exports/authorize', 'viewer', { pageKey: 'revenue_trend', format: 'pdf' })).status).toBe(403);
  });

  it('gets 403 exporting from a page it cannot even view', async () => {
    expect((await call('POST', '/exports/authorize', 'viewer', { pageKey: 'tachometer', format: 'csv' })).status).toBe(403);
  });

  it('gets 403 from admin API endpoints', async () => {
    expect((await call('GET', '/admin/companies', 'viewer')).status).toBe(403);
    expect((await call('GET', '/admin/roles', 'viewer')).status).toBe(403);
    expect((await call('POST', '/admin/roles', 'viewer', { name: 'x' })).status).toBe(403);
    expect((await call('GET', '/admin-only/probe', 'viewer')).status).toBe(403);
  });
});

describe('export check', () => {
  it('allows a user with Export on the page', async () => {
    expect((await call('POST', '/exports/authorize', 'exporter', { pageKey: 'revenue_trend', format: 'image' })).status).toBe(200);
  });

  it('rejects pages without an Export action and unknown formats', async () => {
    expect((await call('POST', '/exports/authorize', 'admin', { pageKey: 'admin_users', format: 'pdf' })).status).toBe(400);
    expect((await call('POST', '/exports/authorize', 'admin', { pageKey: 'revenue_trend', format: 'docx' })).status).toBe(400);
  });
});

describe('admin endpoints check the right action, not just View', () => {
  it('View only: can read, cannot create/edit/delete', async () => {
    expect((await call('GET', '/admin/companies', 'companyViewer')).status).toBe(200);
    expect((await call('POST', '/admin/companies', 'companyViewer', { name: 'X' })).status).toBe(403);
    expect((await call('PATCH', '/admin/companies/1', 'companyViewer', { name: 'X' })).status).toBe(403);
    expect((await call('DELETE', '/admin/companies/1', 'companyViewer')).status).toBe(403);
    expect(companyService.createCompany).not.toHaveBeenCalled();
    expect(companyService.deleteCompany).not.toHaveBeenCalled();
  });

  it('Create + Edit but not Delete', async () => {
    expect((await call('POST', '/admin/companies', 'companyEditor', { name: 'X' })).status).toBe(201);
    expect((await call('PATCH', '/admin/companies/1', 'companyEditor', { name: 'X' })).status).toBe(200);
    expect((await call('DELETE', '/admin/companies/1', 'companyEditor')).status).toBe(403);
  });

  it('a user with no dashboard at all cannot use the shared filter endpoints', async () => {
    expect((await call('GET', '/filters/probe', 'companyEditor')).status).toBe(403);
  });
});

describe('several roles combine', () => {
  it('gets what each role grants', async () => {
    expect((await call('GET', '/filters/probe', 'twoRoles')).status).toBe(200);
    expect((await call('GET', '/admin/roles', 'twoRoles')).status).toBe(200);
    expect((await call('POST', '/admin/roles', 'twoRoles', { name: 'x' })).status).toBe(403);
  });
});

describe('Admin', () => {
  it('passes every check', async () => {
    expect((await call('POST', '/exports/authorize', 'admin', { pageKey: 'tachometer', format: 'xlsx' })).status).toBe(200);
    expect((await call('DELETE', '/admin/companies/1', 'admin')).status).toBe(200);
    expect((await call('POST', '/admin/roles', 'admin', { name: 'x' })).status).toBe(201);
    expect((await call('GET', '/admin-only/probe', 'admin')).status).toBe(200);
  });
});
