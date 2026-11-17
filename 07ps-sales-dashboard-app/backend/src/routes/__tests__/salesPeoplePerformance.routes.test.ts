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
  DIRECTOR_CHANNELS: [
    { channel: 'B2B', segmentKey: 1, roleLabel: 'B2B Director' },
    { channel: 'B2C', segmentKey: 2, roleLabel: 'B2C Director' },
  ],
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

describe('director cards and the reconciliation (2026-11-15)', () => {
  const options = () => vi.mocked(computeSalesPeoplePerformance).mock.calls[0][3]!;

  it('an unrestricted viewer gets both channels, each with the page filters and Customer Group = that channel', async () => {
    expect((await get('/overview?anchorDate=2026-11-09&companyKeys=1&segmentKeys=1&segmentKeys=2', 'viewer')).status).toBe(200);
    expect(options().directorFilters).toMatchObject({
      B2B: { companyKeys: [1], segmentKeys: [1] },
      B2C: { companyKeys: [1], segmentKeys: [2] },
    });
  });

  it('a B2B Director (role scope Customer Group B2B) sees their own channel only, never the B2C card', async () => {
    vi.mocked(getRoleDataScopeRules).mockResolvedValue([{ dimension: 'segmentKeys', value: '1' }]);
    expect((await get('/overview?anchorDate=2026-11-09', 'viewer')).status).toBe(200);
    expect(vi.mocked(computeSalesPeoplePerformance).mock.calls[0][2].segmentKeys).toEqual([1]);
    expect(options().directorFilters).toMatchObject({ B2B: { segmentKeys: [1] }, B2C: null });
  });

  it('a B2C Director (role scope Customer Group B2C) sees the B2C card only', async () => {
    vi.mocked(getRoleDataScopeRules).mockResolvedValue([{ dimension: 'segmentKeys', value: '2' }]);
    expect((await get('/overview?anchorDate=2026-11-09', 'viewer')).status).toBe(200);
    expect(options().directorFilters).toMatchObject({ B2B: null, B2C: { segmentKeys: [2] } });
  });

  it('picking a director in the Salesperson filter (2026-11-17): the director still gets the whole channel, not their own invoices', async () => {
    expect((await get('/overview?anchorDate=2026-11-09&salespersonKeys=54', 'viewer')).status).toBe(200);
    expect(vi.mocked(computeSalesPeoplePerformance).mock.calls[0][2].salespersonKeys).toEqual([54]);
    expect(options().directorFilters?.B2B?.salespersonKeys).toBeUndefined();
    expect(options().directorFilters?.B2B).toMatchObject({ segmentKeys: [1] });
  });

  it('a role scope that limits the salespeople cannot see a whole channel: no director', async () => {
    vi.mocked(getRoleDataScopeRules).mockResolvedValue([{ dimension: 'salespersonKeys', value: '7' }]);
    expect((await get('/overview?anchorDate=2026-11-09', 'viewer')).status).toBe(200);
    expect(options().directorFilters).toEqual({ B2B: null, B2C: null });
  });

  it('a salesperson gets no director card', async () => {
    expect((await get('/overview?anchorDate=2026-11-09', 'person')).status).toBe(200);
    expect(options().directorFilters).toEqual({ B2B: null, B2C: null });
  });

  it('the reconciliation is computed for admins only', async () => {
    await get('/overview?anchorDate=2026-11-09', 'viewer');
    expect(options().withReconciliation).toBe(false);
    vi.mocked(computeSalesPeoplePerformance).mockClear();
    await get('/overview?anchorDate=2026-11-09', 'admin');
    expect(options().withReconciliation).toBe(true);
  });
});
