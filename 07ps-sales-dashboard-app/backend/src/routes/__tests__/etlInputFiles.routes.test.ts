import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/** /admin/etl/input-files and /admin/audit-log over HTTP, with the ETL service, the run tracker and
 * the database mocked -- no file is written and no ETL run can be started from here. */

const replaceMock = vi.fn();
const listMock = vi.fn();
const activeRunMock = vi.fn();
const writeAuditMock = vi.fn();
const latestAuditMock = vi.fn();
const listAuditMock = vi.fn();

vi.mock('../../middleware/auth', () => ({
  // Test identity from a header: "admin", "director", or absent (401).
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const who = req.header('x-test-user');
    if (!who) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    req.user = {
      id: who === 'admin' ? 7 : 8,
      email: `${who}@test.local`,
      fullName: who === 'admin' ? 'Admin User' : 'Director User',
      status: 'ACTIVE',
      mustChangePassword: false,
      roleId: 1,
      roleName: who === 'admin' ? 'ADMIN' : 'B2B_DIRECTOR',
      roleLabel: null,
      roleTierCode: null,
      salespersonKey: null,
      companyScope: 'ALL',
      jti: 'j',
    } as express.Request['user'];
    next();
  },
}));
vi.mock('../../services/permissionService', () => ({ hasPermission: vi.fn() }));
vi.mock('../../etl/services/etlLogger', () => ({ etlLogger: { info: vi.fn(), error: vi.fn() } }));
vi.mock('../../etl/services/etlRunTracker', () => ({ getActiveRun: () => activeRunMock() }));
vi.mock('../../etl/services/pythonRunner', async () => {
  class EtlInputFileError extends Error {
    status: number;
    problems: string[];
    constructor(status: number, message: string, problems: string[] = []) {
      super(message);
      this.status = status;
      this.problems = problems;
    }
  }
  return {
    EtlInputFileError,
    getEtlInputFiles: () => listMock(),
    replaceEtlInputFile: (name: string, buf: Buffer) => replaceMock(name, buf),
  };
});
vi.mock('../../services/auditLogService', () => ({
  ETL_INPUT_FILE_ENTITY: 'etl_input_file',
  writeAuditLog: (e: unknown) => writeAuditMock(e),
  latestAuditByEntity: (t: string) => latestAuditMock(t),
  listAuditLog: (f: unknown) => listAuditMock(f),
  listAuditEntityTypes: async () => ['etl_input_file', 'marcom_upload'],
}));

let server: Server;
let base = '';

type Json = Record<string, any>; // eslint-disable-line
type Res = Omit<Response, 'json'> & { json(): Promise<Json> };
function upload(name: string, who: string | null, content: Buffer | null, filename = 'OffDays.xlsx'): Promise<Res> {
  const fd = new FormData();
  if (content) fd.append('file', new Blob([content]), filename);
  return fetch(`${base}/admin/etl/input-files/${name}`, {
    method: 'PUT',
    headers: who ? { 'x-test-user': who } : {},
    body: fd,
  }) as Promise<Res>;
}
const get = (path: string, who: string | null): Promise<Res> =>
  fetch(`${base}${path}`, { headers: who ? { 'x-test-user': who } : {} }) as Promise<Res>;

const REPLACED = {
  name: 'OffDays.xlsx',
  input_dir: '/etl/input',
  previous: { path: '/etl/input/OffDays.xlsx', size_bytes: 10408, modified: '2026-07-23T10:50:00+00:00', sha256: 'old' },
  current: { path: '/etl/input/OffDays.xlsx', size_bytes: 10500, modified: '2026-09-23T09:00:00+00:00', sha256: 'new' },
  backup: { path: '/etl/input_backups/OffDays.20260923T090000Z.xlsx', size_bytes: 10408 },
  validation: { sheets: { 'first sheet': 'Sheet1' }, counts: { rows: 22 } },
};

beforeAll(async () => {
  const { adminEtlInputFilesRouter } = await import('../admin/etlInputFiles');
  const { adminAuditLogRouter } = await import('../admin/auditLog');
  const app = express();
  app.use('/admin/etl/input-files', adminEtlInputFilesRouter);
  app.use('/admin/audit-log', adminAuditLogRouter);
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
  vi.clearAllMocks();
  activeRunMock.mockResolvedValue(null);
  writeAuditMock.mockResolvedValue(true);
  replaceMock.mockResolvedValue(REPLACED);
});

describe('PUT /admin/etl/input-files/:name', () => {
  it('401 without a user, 403 for a non-admin role -- the ETL service is never called', async () => {
    expect((await upload('OffDays.xlsx', null, Buffer.from('PK'))).status).toBe(401);
    expect((await upload('OffDays.xlsx', 'director', Buffer.from('PK'))).status).toBe(403);
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('forwards the bytes, then writes who/what/backup to audit_log', async () => {
    const bytes = Buffer.from('PK fake workbook');
    const res = await upload('OffDays.xlsx', 'admin', bytes, 'OffDays (edited).xlsx');
    expect(res.status).toBe(200);
    expect((await res.json()).auditLogged).toBe(true);
    expect(replaceMock).toHaveBeenCalledWith('OffDays.xlsx', bytes);
    expect(writeAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'etl_input_file',
        entityId: 'OffDays.xlsx',
        action: 'UPDATE',
        changedBy: 7,
        before: REPLACED.previous,
        after: expect.objectContaining({
          sha256: 'new',
          uploadedFilename: 'OffDays (edited).xlsx',
          uploadedBy: 'Admin User',
          backupPath: REPLACED.backup.path,
          rowCounts: { rows: 22 },
        }),
      }),
    );
  });

  it('logs a first-time file as CREATE', async () => {
    replaceMock.mockResolvedValue({ ...REPLACED, previous: null, backup: null });
    await upload('OffDays.xlsx', 'admin', Buffer.from('PK'));
    expect(writeAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'CREATE', before: null }));
  });

  it('409 while a run is queued or running, without touching the file', async () => {
    activeRunMock.mockResolvedValue({ id: 3, status: 'queued' });
    const res = await upload('OffDays.xlsx', 'admin', Buffer.from('PK'));
    expect(res.status).toBe(409);
    expect(replaceMock).not.toHaveBeenCalled();
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('rejects non-.xlsx names and files over 5 MB before reaching the ETL service', async () => {
    expect((await upload('OffDays.xlsx', 'admin', Buffer.from('a,b'), 'OffDays.csv')).status).toBe(400);
    expect((await upload('OffDays.xlsx', 'admin', Buffer.alloc(5 * 1024 * 1024 + 1))).status).toBe(413);
    expect((await upload('OffDays.xlsx', 'admin', null)).status).toBe(400);
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('passes the ETL service validation error through, and does not audit a rejected upload', async () => {
    const { EtlInputFileError } = await import('../../etl/services/pythonRunner');
    replaceMock.mockRejectedValue(
      new EtlInputFileError(422, 'OffDays.xlsx does not have the structure the ETL expects.', ["missing required column(s): Country"]),
    );
    const res = await upload('OffDays.xlsx', 'admin', Buffer.from('PK'));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/structure/);
    expect(body.problems).toEqual(['missing required column(s): Country']);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('reports a lost audit row instead of hiding it', async () => {
    writeAuditMock.mockResolvedValue(false);
    const res = await upload('OffDays.xlsx', 'admin', Buffer.from('PK'));
    expect(res.status).toBe(200);
    expect((await res.json()).auditLogged).toBe(false);
  });
});

describe('GET /admin/etl/input-files', () => {
  it('merges the last upload from audit_log into each file', async () => {
    listMock.mockResolvedValue({
      input_dir: '/etl/input',
      backup_dir: '/etl/input_backups',
      max_bytes: 5242880,
      files: [{ name: 'OffDays.xlsx' }, { name: 'PRODUCTS.xlsx' }],
    });
    latestAuditMock.mockResolvedValue(
      new Map([['OffDays.xlsx', { changed_at: new Date('2026-09-23T09:00:00Z'), changed_by: 7, changed_by_name: 'Admin User' }]]),
    );
    const body = await (await get('/admin/etl/input-files', 'admin')).json();
    expect(latestAuditMock).toHaveBeenCalledWith('etl_input_file');
    expect(body.files[0].lastUpload).toEqual({ at: '2026-09-23T09:00:00.000Z', byUserId: 7, byName: 'Admin User' });
    expect(body.files[1].lastUpload).toBeNull();
  });

  it('403 for a non-admin role', async () => {
    expect((await get('/admin/etl/input-files', 'director')).status).toBe(403);
  });
});

describe('GET /admin/audit-log', () => {
  it('is admin-only and passes filters/paging through', async () => {
    listAuditMock.mockResolvedValue({ rows: [], total: 0 });
    expect((await get('/admin/audit-log', 'director')).status).toBe(403);
    const res = await get('/admin/audit-log?entityType=etl_input_file&page=2&pageSize=500', 'admin');
    expect(res.status).toBe(200);
    expect(listAuditMock).toHaveBeenCalledWith({ entityType: 'etl_input_file', entityId: undefined, page: 2, pageSize: 100 });
    expect((await (await get('/admin/audit-log/entity-types', 'admin')).json()).entityTypes).toContain('etl_input_file');
  });
});
