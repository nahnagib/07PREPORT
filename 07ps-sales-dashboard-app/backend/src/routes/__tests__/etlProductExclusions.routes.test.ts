import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/** GET /admin/etl/product-exclusions over HTTP: the latest successful conform_sales* task log that carries
 * details.product_exclusions, Admin only. The database, the queue and the ETL service are mocked. */

const queryMock = vi.fn();

vi.mock('../../db/pool', () => ({ pool: { query: (sql: string, params?: unknown[]) => queryMock(sql, params) } }));
vi.mock('../../middleware/auth', () => ({
  // Test identity from a header: "admin", "director", or absent (401).
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const who = req.header('x-test-user');
    if (!who) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    req.user = { id: 7, email: `${who}@test.local`, mustChangePassword: false, isAdmin: who === 'admin' } as express.Request['user'];
    next();
  },
}));
vi.mock('../../services/permissionService', () => ({ allows: vi.fn(), canViewAnyDashboard: vi.fn(), getRequestPermissions: vi.fn() }));
vi.mock('../../etl/queue/etlQueue', () => ({
  EtlAlreadyRunningError: class extends Error {},
  enqueuePipelineRun: vi.fn(),
  getEtlJob: vi.fn(),
  getEtlJobLogs: vi.fn(),
  hasActiveWorker: vi.fn(),
}));
vi.mock('../../etl/queue/queueHealth', () => ({ isQueueReachable: vi.fn() }));
vi.mock('../../etl/queue/etlControlChannel', () => ({ publishCancelRequest: vi.fn() }));
vi.mock('../../etl/services/etlLogger', () => ({ etlLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('../../etl/services/pythonRunner', () => ({ getEtlPreflight: vi.fn(), resetEtlApi: vi.fn() }));
vi.mock('../../etl/services/etlRunTracker', () => ({
  FINISHED_RUN_STATUSES: ['success', 'failed', 'cancelled'],
  forceResetActiveEtlRuns: vi.fn(),
  getActiveRun: vi.fn(),
  getActiveSalesBuild: vi.fn(),
  getLastFinishedRun: vi.fn(),
  getLastSalesBuild: vi.fn(),
  getRunById: vi.fn(),
  listRunHistory: vi.fn(),
  releaseOrphanedPipelineLock: vi.fn(),
}));

let server: Server;
let base = '';
const get = (who: string | null) =>
  fetch(`${base}/admin/etl/product-exclusions`, { headers: who ? { 'x-test-user': who } : {} });

const REPORT = {
  as_of: '2026-11-11',
  file: {
    file: 'ProductExclusions.xlsx',
    uploaded_at_utc: '2026-11-07T10:00:00Z',
    fallback_reason: null,
    active_rows: { Customers: { Keep: 10, Exclude: 2 }, Categories: { Exclude: 3 }, Products: { Exclude: 131 } },
    inactive_rows: { Customers: 0, Categories: 2, Products: 31 },
    skipped_rows: 1,
    skipped: [{ sheet: 'Customers', row: 6, name: 'E.GRECH CRISTAL BATH LTD', reason: 'Odoo Partner ID must be a whole positive number (got blank)' }],
    warning_rows: 0,
    warnings: [],
  },
  products_excluded: { archived: { total: 1578, by_company: { Majaal: 1500, Tika: 78 } } },
  sales_lines_excluded: { backoffice: { lines: 9375, qty: 1, value: 2, by_company: { Majaal: 9375 } } },
  archived_with_stock: [{ company: 'Majaal', product_id: '5071', product_name: 'Pietra Grey MT 120x120', quantity_on_hand: 259.2, total_value: 18940.74 }],
};

beforeAll(async () => {
  const { adminEtlControlRouter } = await import('../admin/etlControl');
  const app = express();
  app.use('/admin/etl', adminEtlControlRouter);
  // Express only treats 4-argument middleware as an error handler, so `_next` must stay.
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

beforeEach(() => {
  queryMock.mockReset();
});

describe('GET /admin/etl/product-exclusions', () => {
  it('returns the report of the latest successful sales build, with its task and finish time', async () => {
    queryMock.mockResolvedValue([[{ taskName: 'conform_sales', finishedAtUtc: '2026-11-11T08:30:00Z', report: JSON.stringify(REPORT) }]]);
    const res = await get('admin');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(body.report).toEqual({ ...REPORT, finishedAtUtc: '2026-11-11T08:30:00Z', taskName: 'conform_sales' });
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toMatch(/task_name IN \('conform_sales', 'conform_sales_from_mirror'\)/);
    expect(sql).toMatch(/status = 'success'/);
    expect(sql).toMatch(/JSON_EXTRACT\(details, '\$\.product_exclusions'\) IS NOT NULL/);
    expect(sql).toMatch(/ORDER BY finished_at_utc DESC LIMIT 1/);
  });

  it('accepts the report as a parsed JSON object (driver returning JSON columns already parsed)', async () => {
    queryMock.mockResolvedValue([[{ taskName: 'conform_sales_from_mirror', finishedAtUtc: '2026-11-11T09:00:00Z', report: REPORT }]]);
    const body = (await (await get('admin')).json()) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(body.report.taskName).toBe('conform_sales_from_mirror');
    expect(body.report.file.skipped_rows).toBe(1);
  });

  it('returns report: null when no sales build has written one yet', async () => {
    queryMock.mockResolvedValue([[]]);
    const res = await get('admin');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ report: null });
  });

  it('is Admin only: 401 without a user, 403 for a non-admin, and never queries then', async () => {
    expect((await get(null)).status).toBe(401);
    expect((await get('director')).status).toBe(403);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('passes a database error to the error handler (500)', async () => {
    queryMock.mockRejectedValue(new Error('db down'));
    const res = await get('admin');
    expect(res.status).toBe(500);
  });
});
