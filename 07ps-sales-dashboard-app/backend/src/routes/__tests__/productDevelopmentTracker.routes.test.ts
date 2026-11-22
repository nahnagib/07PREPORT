import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Product Development Plan tracker access over real HTTP: the real router and permission middleware, faked users and
 * service. A plan-View-only user reads the dashboard but cannot write; an entry user can; the settings are Admin-only;
 * errors keep the `{ error, code, field }` shape.
 */

type Grant = [string, string];
const PLAN: Grant[] = [['product_development_plan', 'view']];
const ENTRY_ALL: Grant[] = ['view', 'create', 'edit', 'delete', 'export'].map((a) => ['product_development_entry', a] as Grant);
const USERS: Record<string, { isAdmin?: boolean; grants: Grant[] }> = {
  admin: { isAdmin: true, grants: [] },
  nobody: { grants: [['tachometer', 'view']] },
  viewer: { grants: PLAN },
  viewerExport: { grants: [...PLAN, ['product_development_plan', 'export']] },
  entry: { grants: ENTRY_ALL },
  entryNoDelete: { grants: ['view', 'create', 'edit'].map((a) => ['product_development_entry', a] as Grant) },
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

const calls: { fn: string; args: unknown[] }[] = [];
const rec = (fn: string, value: unknown = { ok: true }) => async (...args: unknown[]) => {
  calls.push({ fn, args });
  return value;
};
vi.mock('../../services/pdt/trackerService', async () => {
  const { PdpError } = await vi.importActual<typeof import('../../services/pdp/errors')>('../../services/pdp/errors');
  return {
    getOptions: rec('getOptions', { dropdowns: [], users: [{ user_id: 1, display_name: 'A' }], owners: [] }),
    getDashboard: rec('getDashboard', { kpis: {} }),
    listProducts: rec('listProducts', []),
    getProduct: async (code: string) => {
      calls.push({ fn: 'getProduct', args: [code] });
      if (code === 'P-404') throw new PdpError('product.notFound', 'Product not found.');
      return { product: { code } };
    },
    createProduct: async (body: Record<string, unknown>, userId: number) => {
      calls.push({ fn: 'createProduct', args: [body, userId] });
      if (!body.name) throw new PdpError('name.required', 'This field is required.', 'name');
      return { product: { code: 'P-009' } };
    },
    updateProduct: rec('updateProduct'),
    deleteProduct: rec('deleteProduct'),
    changeStage: rec('changeStage'),
    postUpdate: rec('postUpdate'),
    editUpdate: rec('editUpdate'),
    deleteUpdate: rec('deleteUpdate'),
    listBlockers: rec('listBlockers', []),
    createBlocker: rec('createBlocker', { blocker: {}, healthForced: true, healthReviewRequired: false }),
    updateBlocker: rec('updateBlocker'),
    resolveBlocker: rec('resolveBlocker'),
    deleteBlocker: rec('deleteBlocker', { healthForced: false, healthReviewRequired: true }),
    getFollowup: rec('getFollowup', { items: [] }),
    listDropdowns: rec('listDropdowns', []),
    getSettings: rec('getSettings', {}),
    createDropdown: rec('createDropdown'),
    updateDropdown: rec('updateDropdown'),
    deleteDropdown: rec('deleteDropdown'),
    updateSettings: rec('updateSettings'),
  };
});
vi.mock('../../services/pdt/exportService', () => ({
  exportDashboard: async () => Buffer.from('xlsx'),
  exportFollowup: async () => Buffer.from('xlsx'),
}));
vi.mock('../../services/pdt/importService', () => ({
  previewImport: async (_b: Buffer, name: string) => {
    calls.push({ fn: 'previewImport', args: [name] });
    return { canConfirm: true, sha256: 'abc' };
  },
  confirmImport: async (_b: Buffer, name: string, sha: unknown, uid: number) => {
    calls.push({ fn: 'confirmImport', args: [name, sha, uid] });
    return { importId: 1 };
  },
  importHistory: rec('importHistory', []),
  exportWorkbook: async () => Buffer.from('xlsx'),
}));

let server: Server;
let base = '';

beforeAll(async () => {
  const { productDevelopmentTrackerRouter } = await import('../productDevelopmentTracker');
  const app = express();
  app.use(express.json());
  app.use('/product-development/tracker', productDevelopmentTrackerRouter);
  // eslint-disable-next-line no-unused-vars -- Express needs the 4-argument signature to treat it as an error handler
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: String(err) }));
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/product-development/tracker`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  calls.length = 0;
});

// JSON bodies of every shape.
async function api(method: string, path: string, who: string, body?: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(base + path, { method, headers: { 'x-test-user': who, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const ct = r.headers.get('content-type') ?? '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text() };
}

const WRITES: [string, string, string][] = [
  ['POST', '/products', 'create'],
  ['PATCH', '/products/P-001', 'edit'],
  ['DELETE', '/products/P-001', 'delete'],
  ['POST', '/products/P-001/stage', 'edit'],
  ['POST', '/products/P-001/updates', 'create'],
  ['PATCH', '/updates/3', 'edit'],
  ['DELETE', '/updates/3', 'delete'],
  ['POST', '/blockers', 'create'],
  ['PATCH', '/blockers/2', 'edit'],
  ['POST', '/blockers/2/resolve', 'edit'],
  ['DELETE', '/blockers/2', 'delete'],
];

describe('reading', () => {
  it('refuses a user without either page', async () => {
    expect((await api('GET', '/dashboard', 'nobody')).status).toBe(403);
    expect((await api('GET', '/options', 'nobody')).status).toBe(403);
  });
  it('lets plan View read the dashboard and product details but not the entry lists', async () => {
    expect((await api('GET', '/dashboard?stages=IDEA,BOGUS&owners=Maya%20Chen&launchFrom=2026-11-01&launchTo=nope', 'viewer')).status).toBe(200);
    const f = calls.find((c) => c.fn === 'getDashboard')!.args[0] as Record<string, unknown>;
    expect(f).toMatchObject({ stages: ['IDEA'], owners: ['Maya Chen'], launchFrom: '2026-11-01', launchTo: undefined });
    expect((await api('GET', '/products/p-001', 'viewer')).body).toEqual({ product: { code: 'P-001' } });
    expect((await api('GET', '/followup', 'viewer')).status).toBe(403);
    expect((await api('GET', '/blockers', 'viewer')).status).toBe(403);
  });
  it('hides the app-user picker from a dashboard-only user', async () => {
    expect((await api('GET', '/options', 'viewer')).body.users).toEqual([]);
    expect((await api('GET', '/options', 'entry')).body.users).toHaveLength(1);
  });
  it('exports the dashboard with plan Export or entry Export only', async () => {
    expect((await api('GET', '/dashboard/export', 'viewer')).status).toBe(403);
    expect((await api('GET', '/dashboard/export', 'viewerExport')).status).toBe(200);
    expect((await api('GET', '/dashboard/export', 'entry')).status).toBe(200);
    expect((await api('GET', '/followup/export', 'viewerExport')).status).toBe(403);
    expect((await api('GET', '/followup/export', 'entry')).status).toBe(200);
  });
});

describe('writing', () => {
  it.each(WRITES)('%s %s is refused for a dashboard-only user', async (method, path) => {
    expect((await api(method, path, 'viewerExport', {})).status).toBe(403);
  });
  it.each(WRITES)('%s %s is allowed for an entry user', async (method, path) => {
    expect((await api(method, path, 'entry', { name: 'X' })).status).toBeLessThan(300);
  });
  it('needs entry Delete to delete', async () => {
    expect((await api('DELETE', '/products/P-001', 'entryNoDelete')).status).toBe(403);
    expect((await api('PATCH', '/products/P-001', 'entryNoDelete', {})).status).toBe(200);
  });
  it('passes the signed-in user to the service and answers 201 on create', async () => {
    const r = await api('POST', '/products', 'entry', { name: 'New' });
    expect(r.status).toBe(201);
    expect(calls.find((c) => c.fn === 'createProduct')!.args[1]).toBe(42);
  });
  it('returns the blocker health notices', async () => {
    expect((await api('POST', '/blockers', 'entry', {})).body).toMatchObject({ healthForced: true });
    expect((await api('DELETE', '/blockers/2', 'entry')).body).toEqual({ success: true, healthForced: false, healthReviewRequired: true });
  });
});

describe('errors', () => {
  it('keeps { error, code, field } and 404 for not found', async () => {
    expect(await api('POST', '/products', 'entry', {})).toEqual({ status: 400, body: { error: 'This field is required.', code: 'name.required', field: 'name' } });
    expect((await api('GET', '/products/P-404', 'entry')).status).toBe(404);
    expect((await api('PATCH', '/updates/abc', 'entry', {})).status).toBe(404);
  });
});

describe('Excel import', () => {
  const upload = (path: string, who: string, name = 'Product_Development_Input.xlsx', extra: Record<string, string> = {}) => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([80, 75, 3, 4])]), name);
    for (const [k, v] of Object.entries(extra)) form.append(k, v);
    return fetch(base + path, { method: 'POST', headers: { 'x-test-user': who }, body: form }).then(async (r) => ({ status: r.status, body: await r.json() }));
  };
  it('previews for an entry user, never for a dashboard-only user', async () => {
    expect((await upload('/import/preview', 'viewerExport')).status).toBe(403);
    const r = await upload('/import/preview', 'entry');
    expect(r).toEqual({ status: 200, body: { canConfirm: true, sha256: 'abc' } });
  });
  it('confirms with the previewed hash and the signed-in user; needs Create and Edit', async () => {
    expect((await upload('/import/confirm', 'entryNoDelete', undefined, { sha256: 'abc' })).status).toBe(200);
    expect(calls.find((c) => c.fn === 'confirmImport')!.args).toEqual(['Product_Development_Input.xlsx', 'abc', 42]);
    expect((await upload('/import/confirm', 'viewer', undefined, { sha256: 'abc' })).status).toBe(403);
  });
  it('accepts only .xlsx and asks for a file', async () => {
    expect((await upload('/import/preview', 'entry', 'data.csv')).body).toMatchObject({ code: 'import.fileType', field: 'file' });
    const r = await fetch(base + '/import/preview', { method: 'POST', headers: { 'x-test-user': 'entry' } });
    expect(await r.json()).toMatchObject({ code: 'import.noFile' });
  });
  it('exports the input file with Export; shows the history with entry View', async () => {
    expect((await api('GET', '/import/export', 'viewer')).status).toBe(403);
    expect((await api('GET', '/import/export', 'viewerExport')).status).toBe(200);
    expect((await api('GET', '/import/history', 'entry')).status).toBe(200);
    expect((await api('GET', '/import/history', 'viewer')).status).toBe(403);
  });
});

describe('admin settings', () => {
  it('is Admin-role only, even with every entry action', async () => {
    expect((await api('GET', '/admin/dropdowns', 'entry')).status).toBe(403);
    expect((await api('PUT', '/admin/settings', 'entry', { staleDays: 10 })).status).toBe(403);
    expect((await api('GET', '/admin/dropdowns', 'admin')).status).toBe(200);
    expect((await api('PUT', '/admin/settings', 'admin', { staleDays: 10 })).status).toBe(200);
  });
});
