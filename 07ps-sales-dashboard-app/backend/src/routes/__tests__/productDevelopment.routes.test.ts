import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Product Development Plan access over real HTTP: the real router and permission middleware, faked users and services.
 * Covers the three page keys (plan / entry / approval), the Admin-only configuration and import, the TIKA-only
 * company guard (a Majaal key is refused) and the `{ error, code, field }` error shape.
 */

type Grant = [string, string];
const PLAN: Grant[] = [['product_development_plan', 'view']];
const USERS: Record<string, { isAdmin?: boolean; grants: Grant[] }> = {
  admin: { isAdmin: true, grants: [] },
  nobody: { grants: [['tachometer', 'view']] },
  viewer: { grants: PLAN },
  viewerExport: { grants: [...PLAN, ['product_development_plan', 'export']] },
  entry: { grants: ['view', 'create', 'edit', 'delete', 'export'].map((a) => ['product_development_entry', a] as Grant) },
  entryNoDelete: { grants: ['view', 'create', 'edit'].map((a) => ['product_development_entry', a] as Grant) },
  approver: { grants: [...PLAN, ['product_development_approval', 'view'], ['product_development_approval', 'edit']] },
};

vi.mock('../../middleware/auth', () => ({
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const who = req.header('x-test-user') ?? '';
    if (!USERS[who]) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    req.user = {
      id: 42, email: `${who}@test.local`, fullName: who, status: 'ACTIVE', mustChangePassword: false, roleId: 1, roleName: null, roleLabel: null,
      roles: [], isAdmin: USERS[who].isAdmin === true, roleTierCode: null, salespersonKey: null, companyScope: 'ALL', jti: 'j',
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

// TIKA = 3 (core dim_company); Majaal = 1.
vi.mock('../../services/pdp/company', async () => {
  const actual = await vi.importActual<typeof import('../../services/pdp/company')>('../../services/pdp/company');
  return { ...actual, tikaCompanyKey: async () => 3 };
});

const calls: { fn: string; args: unknown[] }[] = [];
const rec = (fn: string, value: unknown = { ok: true }) => async (...args: unknown[]) => {
  calls.push({ fn, args });
  return value;
};
vi.mock('../../services/pdp/configService', () => ({
  userGovernanceRoles: async () => ['CEO'],
  listDropdowns: rec('listDropdowns', []), listGovernance: rec('listGovernance', []), listCriteria: rec('listCriteria', []), getSettings: rec('getSettings', {}),
  listActiveUsers: rec('listActiveUsers', []), listChecklistTemplates: rec('listChecklistTemplates', []), listGateRules: rec('listGateRules', []),
  approverWarnings: rec('approverWarnings', []), updateSettings: rec('updateSettings'), saveCriteria: rec('saveCriteria'), addGovernanceMember: rec('addGovernanceMember'),
  getPolicy: rec('getPolicy'), listGapItems: rec('listGapItems', []), listKpiTargets: rec('listKpiTargets', []), listRoadmapYears: rec('listRoadmapYears', []),
  createDropdown: rec('createDropdown'),
}));
vi.mock('../../services/pdp/treeService', () => ({ getTree: rec('getTree', []), createProduct: rec('createProduct', { product_id: 1 }), searchOdooProducts: rec('searchOdooProducts', []) }));
vi.mock('../../services/pdp/monitorService', () => ({ getOverview: rec('getOverview', { kpis: [] }), listLaunches: rec('listLaunches') }));
vi.mock('../../services/pdp/exportService', () => ({ exportTree: async () => Buffer.from('xlsx'), exportProjects: async () => Buffer.from('xlsx'), exportFeedback: async () => Buffer.from('xlsx') }));
vi.mock('../../services/pdp/attachmentService', () => ({ MAX_ATTACHMENT_BYTES: 10 * 1024 * 1024 }));
vi.mock('../../services/pdp/importService', () => ({ IMPORT_FILES: {}, importFolder: () => null, readImportFolder: async () => ({}), runImport: rec('runImport', { mode: 'dry-run' }) }));
vi.mock('../../services/pdp/projectService', async () => {
  const { PdpError } = await vi.importActual<typeof import('../../services/pdp/errors')>('../../services/pdp/errors');
  return {
    listProjects: rec('listProjects', []),
    createProject: rec('createProject', { code: 'RD-2026-001' }),
    deleteProject: rec('deleteProject'),
    decide: rec('decide', { state: 'active', currentGate: 'G2' }),
    submitProject: async () => { throw new PdpError('freeze.active', 'New requests are frozen.', 'classification', 409); },
  };
});

let server: Server;
let base = '';
type Res = { status: number; body: any };
async function call(method: string, path: string, who: string, body?: unknown): Promise<Res> {
  const r = await fetch(`${base}${path}`, { method, headers: { 'x-test-user': who, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* binary */ }
  return { status: r.status, body: parsed };
}

beforeAll(async () => {
  const { productDevelopmentRouter } = await import('../productDevelopment');
  const app = express();
  app.use(express.json());
  app.use('/product-development', productDevelopmentRouter);
  // Express needs the 4-argument signature to treat this as the error handler.
  // eslint-disable-next-line no-unused-vars
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(500).json({ error: 'internal' }); });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/product-development`;
});
afterAll(() => server.close());
beforeEach(() => { calls.length = 0; });

describe('product_development_plan (read-only views)', () => {
  it('View opens the overview and lists; no View = 403', async () => {
    expect((await call('GET', '/overview', 'viewer')).status).toBe(200);
    expect((await call('GET', '/projects', 'viewer')).status).toBe(200);
    expect((await call('GET', '/overview', 'nobody')).status).toBe(403);
  });
  it('Export is a separate action', async () => {
    expect((await call('GET', '/tree/export', 'viewer')).status).toBe(403);
    expect((await call('GET', '/tree/export', 'viewerExport')).status).toBe(200);
    expect((await call('GET', '/projects/export', 'entry')).status).toBe(200);
  });
  it('a plan viewer cannot write anything', async () => {
    expect((await call('POST', '/projects', 'viewer', { title: 'x' })).status).toBe(403);
    expect((await call('POST', '/products', 'viewer', {})).status).toBe(403);
    expect((await call('POST', '/projects/RD-2026-001/decisions', 'viewer', {})).status).toBe(403);
  });
});

describe('product_development_entry (forms)', () => {
  it('Create / Delete are checked per action', async () => {
    expect((await call('POST', '/projects', 'entry', { title: 'x' })).status).toBe(201);
    expect(calls.some((c) => c.fn === 'createProject')).toBe(true);
    expect((await call('DELETE', '/projects/RD-2026-001', 'entryNoDelete')).status).toBe(403);
    expect((await call('DELETE', '/projects/RD-2026-001', 'entry')).status).toBe(200);
  });
  it('data entry does not include deciding a gate', async () => {
    expect((await call('POST', '/projects/RD-2026-001/decisions', 'entry', { decision: 'approve' })).status).toBe(403);
  });
  it('business-rule errors come back as { error, code, field }', async () => {
    const r = await call('POST', '/projects/RD-2026-001/submit', 'entry', {});
    expect(r).toEqual({ status: 409, body: { error: 'New requests are frozen.', code: 'freeze.active', field: 'classification' } });
  });
});

describe('product_development_approval (gate decisions)', () => {
  it('Edit lets the decision reach the service, with the user\'s governance roles (the service checks the role)', async () => {
    const r = await call('POST', '/projects/RD-2026-001/decisions', 'approver', { decision: 'approve', roleCode: 'CEO' });
    expect(r.status).toBe(200);
    const d = calls.find((c) => c.fn === 'decide');
    expect(d?.args.slice(0, 2)).toEqual([3, 'RD-2026-001']);
    expect(d?.args[4]).toEqual(['CEO']);
  });
  it('an approver cannot enter data', async () => {
    expect((await call('POST', '/projects', 'approver', { title: 'x' })).status).toBe(403);
  });
});

describe('Admin-only configuration and import', () => {
  it('settings, criteria and governance members: Admin role only', async () => {
    expect((await call('PUT', '/admin/settings', 'entry', {})).status).toBe(403);
    expect((await call('PUT', '/admin/criteria', 'entry', { criteria: [] })).status).toBe(403);
    expect((await call('POST', '/admin/governance', 'entry', {})).status).toBe(403);
    expect((await call('PUT', '/admin/settings', 'admin', {})).status).toBe(200);
  });
  it('drop-downs are reference data: entry Edit', async () => {
    expect((await call('POST', '/admin/dropdowns', 'viewer', {})).status).toBe(403);
    expect((await call('POST', '/admin/dropdowns', 'entry', {})).status).toBe(201);
  });
  it('the one-time import is Admin role only', async () => {
    expect((await call('POST', '/import', 'entry')).status).toBe(403);
    expect((await call('POST', '/import', 'admin')).status).toBe(200);
  });
});

describe('TIKA only', () => {
  it('a request naming Majaal (company key 1) is refused before any service runs', async () => {
    const r = await call('POST', '/projects', 'entry', { title: 'x', companyKey: 1 });
    expect(r).toMatchObject({ status: 400, body: { code: 'company.notAllowed', field: 'companyKey' } });
    expect(calls.some((c) => c.fn === 'createProject')).toBe(false);
    expect((await call('GET', '/overview?companyKey=1', 'viewer')).body.code).toBe('company.notAllowed');
    expect((await call('POST', '/products', 'admin', { company_key: 1 })).status).toBe(400);
  });
  it('every service call gets TIKA\'s key (3)', async () => {
    await call('GET', '/overview', 'viewer');
    expect(calls.find((c) => c.fn === 'getOverview')?.args[0]).toBe(3);
    expect((await call('POST', '/projects', 'entry', { title: 'x', companyKey: 3 })).status).toBe(201);
  });
});
