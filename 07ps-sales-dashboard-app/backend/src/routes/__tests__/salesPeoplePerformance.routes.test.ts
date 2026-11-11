import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { computePersonContributions, computeSalesPeoplePerformance } from '../../measures/salesPeoplePerformance';
import { getRoleDataScopeRules } from '../../services/dataScopeService';

vi.mock('../../db/pool', () => ({ pool: {} }));
vi.mock('../../measures/salesPeoplePerformance', () => ({
  computeSalesPeoplePerformance: vi.fn(async () => ({ people: [] })),
  computePersonContributions: vi.fn(async () => ({ rows: [] })),
}));
vi.mock('../../services/dataScopeService', () => ({ getRoleDataScopeRules: vi.fn(async () => []) }));
vi.mock('../../middleware/auth', () => ({
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const who = req.header('x-test-user');
    if (!who) { res.status(401).json({ error: 'Unauthenticated' }); return; }
    req.user = { id: 1, isAdmin: who === 'admin', mustChangePassword: who === 'password', roleId: 7,
      roleTierCode: who === 'person' ? 'SALESPERSON' : 'BI00_EXECUTIVE', salespersonKey: who === 'person' ? 1 : null } as express.Request['user'];
    next();
  },
}));
vi.mock('../../services/permissionService', async () => {
  const actual = await vi.importActual<typeof import('../../services/permissionService')>('../../services/permissionService');
  return { ...actual, getRequestPermissions: async (req: express.Request) => actual.computeEffectivePermissions({
    isAdmin: req.user?.isAdmin ?? false, overrides: [], roleGrants: req.header('x-test-user') === 'denied' ? [] : [
      { page_key: 'sales_people_performance', action: 'view', allowed: 1 },
    ],
  }) };
});
let server: Server;
let base: string;
beforeAll(async () => {
  const { salesPeoplePerformanceRouter } = await import('../salesPeoplePerformance');
  const app = express(); app.use('/performance', salesPeoplePerformanceRouter);
  server = await new Promise<Server>((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/performance`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => { vi.mocked(getRoleDataScopeRules).mockResolvedValue([]); vi.mocked(computeSalesPeoplePerformance).mockClear(); vi.mocked(computePersonContributions).mockClear(); });
const get = (path: string, who?: string) => fetch(`${base}${path}`, { headers: who ? { 'x-test-user': who } : {} });

describe('performance HTTP permissions and data scope', () => {
  it('rejects unauthenticated and ungranted access before queries', async () => {
    expect((await get('/overview?anchorDate=2026-11-09')).status).toBe(401);
    expect((await get('/overview?anchorDate=2026-11-09', 'denied')).status).toBe(403);
    expect(computeSalesPeoplePerformance).not.toHaveBeenCalled();
  });
  it('blocks forced-password-change accounts', async () => {
    expect((await get('/overview?anchorDate=2026-11-09', 'password')).status).toBe(403);
  });
  it.each(['2026-02-30', 'nonsense', '2026-13-01', ''])('rejects invalid anchor %s', async (anchor) => {
    expect((await get(`/overview?anchorDate=${anchor}`, 'admin')).status).toBe(400);
  });
  it('forces the salesperson lock and rejects a forged salesperson filter', async () => {
    expect((await get('/overview?anchorDate=2026-11-09', 'person')).status).toBe(200);
    expect(vi.mocked(computeSalesPeoplePerformance).mock.calls[0][2].salespersonKeys).toEqual([1]);
    expect((await get('/overview?anchorDate=2026-11-09&salespersonKeys=2', 'person')).status).toBe(403);
  });
  it('rejects contribution requests for another locked person', async () => {
    expect((await get('/contributions/2?anchorDate=2026-11-09', 'person')).status).toBe(403);
    expect(computePersonContributions).not.toHaveBeenCalled();
  });
  it('preserves role restrictions in both numerator and denominator, while removing UI filters', async () => {
    vi.mocked(getRoleDataScopeRules).mockResolvedValue([{ dimension: 'companyKeys', value: '3' }]);
    expect((await get('/contributions/1?anchorDate=2026-11-09&segmentKeys=1&salespersonKeys=1', 'viewer')).status).toBe(200);
    expect(vi.mocked(computePersonContributions).mock.calls[0][2]).toEqual({ companyKeys: [3] });
    expect((await get('/overview?anchorDate=2026-11-09&companyKeys=1', 'viewer')).status).toBe(403);
  });
});
