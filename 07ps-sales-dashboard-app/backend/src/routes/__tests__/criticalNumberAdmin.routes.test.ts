import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

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
