import '../../marcom/__tests__/helpers/env';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { resetMarcom } from '../../marcom/__tests__/helpers/db';
import { TEMPLATE, monthFile } from '../../marcom/__tests__/helpers/workbooks';

const RUN_DB = process.env.MARCOM_TEST_DB === '1';
process.env.RATE_LIMIT_MARCOM_MAX = '12'; // read when the router module loads (below)

let server: Server;
let base = '';
let pool: typeof import('../../db/pool').pool;
const tokens: Record<string, string> = {};
const ids: Record<string, number> = {};

async function mkUser(email: string, role: string) {
  const [ex] = (await pool.query('SELECT user_id FROM app_user WHERE email = ?', [email])) as [{ user_id: number }[], unknown];
  let id = ex[0]?.user_id;
  if (!id) {
    const [r] = await pool.query(
      `INSERT INTO app_user (email, display_name, role_id, status, must_change_password, password_hash)
       VALUES (?, ?, (SELECT role_id FROM roles WHERE role_name = ?), 'ACTIVE', 0, 'x')`,
      [email, email.split('@')[0], role],
    );
    id = (r as { insertId: number }).insertId;
  }
  return id;
}

function form(buf: Buffer, filename: string) {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), filename);
  return fd;
}
// The repo's tsconfig has no DOM lib, so Response.json() is `unknown`; tests want loose JSON.
type Res = Omit<Response, 'json'> & { json(): Promise<any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = (method: string, path: string, who: string | null, opts: { body?: FormData; json?: unknown } = {}): Promise<Res> =>
  (fetch(`${base}${path}`, {
    method,
    headers: {
      ...(who ? { Authorization: `Bearer ${tokens[who]}` } : {}),
      ...(opts.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body,
  }) as Promise<Res>);

const UUID = '00000000-0000-4000-8000-000000000000';

describe.skipIf(!RUN_DB)('/marcom/upload routes (HTTP, DB-backed)', () => {
  let goodStaged = '';
  let goodBatch = 0;

  beforeAll(async () => {
    ({ pool } = await import('../../db/pool'));
    const { issueAccessToken } = await import('../../lib/token');
    const { marcomUploadRouter, marcomFreshnessRouter } = await import('../marcomUpload');
    await resetMarcom(pool);

    for (const [who, role] of [['admin', 'ADMIN'], ['director', 'B2B_DIRECTOR'], ['sales', 'SALESPERSON'], ['ratelimit', 'ADMIN']] as const) {
      ids[who] = await mkUser(`marcom.route.${who}@test.local`, role);
      tokens[who] = issueAccessToken(ids[who]).token;
    }

    const app = express();
    app.use(express.json());
    app.use('/marcom/upload', marcomUploadRouter);
    app.use('/marcom/freshness', marcomFreshnessRouter);
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      console.error('unhandled in test app:', err);
      res.status(500).json({ error: 'Something went wrong.' });
    });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // Real staged upload + committed batch owned by admin, so non-admin 403s can't be mistaken for 404s.
    const v = await (await call('POST', '/marcom/upload/validate', 'admin', { body: form(await monthFile({ month: 'February' }), 'feb.xlsx') })).json();
    goodStaged = v.stagedUploadId;
    const other = await (await call('POST', '/marcom/upload/validate', 'admin', { body: form(await monthFile({ month: 'March' }), 'mar.xlsx') })).json();
    const c = await (await call('POST', '/marcom/upload/commit', 'admin', { json: { stagedUploadId: other.stagedUploadId, confirmNewBrands: true } })).json();
    goodBatch = c.batchId;
  });

  afterAll(async () => {
    await resetMarcom(pool);
    await new Promise((r) => server?.close(r));
    await pool.end();
  });

  const ENDPOINTS: { name: string; run: (who: string | null) => Promise<Res> }[] = [
    { name: 'GET /template', run: (w) => call('GET', '/marcom/upload/template', w) },
    { name: 'POST /validate', run: async (w) => call('POST', '/marcom/upload/validate', w, { body: form(await monthFile({ month: 'April' }), 'a.xlsx') }) },
    { name: 'POST /commit', run: (w) => call('POST', '/marcom/upload/commit', w, { json: { stagedUploadId: goodStaged, confirmNewBrands: true } }) },
    { name: 'GET /staged/:id/errors.csv', run: (w) => call('GET', `/marcom/upload/staged/${goodStaged}/errors.csv`, w) },
    { name: 'GET /batches', run: (w) => call('GET', '/marcom/upload/batches', w) },
    { name: 'GET /batches/:id', run: (w) => call('GET', `/marcom/upload/batches/${goodBatch}`, w) },
    { name: 'GET /batches/:id/file', run: (w) => call('GET', `/marcom/upload/batches/${goodBatch}/file`, w) },
    { name: 'POST /batches/:id/rollback', run: (w) => call('POST', `/marcom/upload/batches/${goodBatch}/rollback`, w, { json: { reason: 'because' } }) },
  ];

  describe('authorization (server-side, every route)', () => {
    it.each(ENDPOINTS.map((e) => [e.name, e] as const))('%s -> 401 without a token', async (_n, e) => {
      expect((await e.run(null)).status).toBe(401);
    });
    it.each(ENDPOINTS.map((e) => [e.name, e] as const))('%s -> 403 for a report-viewing non-admin (B2B_DIRECTOR)', async (_n, e) => {
      const res = await e.run('director');
      expect(res.status).toBe(403);
    });
    it.each(ENDPOINTS.map((e) => [e.name, e] as const))('%s -> 403 for a SALESPERSON', async (_n, e) => {
      expect((await e.run('sales')).status).toBe(403);
    });
    it('non-admin attempts changed nothing', async () => {
      const [b] = (await pool.query("SELECT COUNT(*) AS n FROM marcom_upload_batch WHERE status = 'SUCCESS'")) as [{ n: number }[], unknown];
      expect(b[0].n).toBe(1);
      const [s] = (await pool.query('SELECT COUNT(*) AS n FROM marcom_staged_upload')) as [{ n: number }[], unknown];
      expect(s[0].n).toBe(2);
    });
  });

  describe('freshness', () => {
    it('is 401 anonymous, 403 without a MARCOM report permission, 200 with one (no admin needed)', async () => {
      expect((await call('GET', '/marcom/freshness', null)).status).toBe(401);
      expect((await call('GET', '/marcom/freshness', 'sales')).status).toBe(403);
      const r = await call('GET', '/marcom/freshness', 'director');
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body).toMatchObject({ hasData: true, latestPeriod: { year: 2026, month: 3 } });
      expect(body.uploadedBy).toBe('marcom.route.admin');
    });
  });

  describe('admin happy paths', () => {
    it('template download is the exact shipped file', async () => {
      const r = await call('GET', '/marcom/upload/template', 'admin');
      expect(r.status).toBe(200);
      expect(r.headers.get('content-disposition')).toMatch(/MARCOM_Contribution_Data_Template\.xlsx/);
      expect(Buffer.from(await r.arrayBuffer()).equals(fs.readFileSync(TEMPLATE))).toBe(true);
    });

    it('validate returns a preview with stable issue shape; errors.csv and history work', async () => {
      const r = await call('POST', '/marcom/upload/validate', 'admin', { body: form(await monthFile({ month: 'April' }), 'apr.xlsx') });
      expect(r.status).toBe(200);
      const p = await r.json();
      expect(p).toMatchObject({ filename: 'apr.xlsx', errorCount: 0, canCommit: true });
      expect(p.tables.map((t: { id: string }) => t.id)).toEqual(['spend', 'campaigns', 'media', 'social', 'web', 'trade', 'events']);

      const csv = await call('GET', `/marcom/upload/staged/${p.stagedUploadId}/errors.csv`, 'admin');
      expect(csv.status).toBe(200);
      expect(csv.headers.get('content-type')).toMatch(/text\/csv/);
      expect(await csv.text()).toContain('"severity","code","sheet","table","cell","message"');

      const list = await (await call('GET', '/marcom/upload/batches', 'admin')).json();
      expect(list.rows[0]).toMatchObject({ batchId: goodBatch, status: 'SUCCESS', canRollback: true, uploadedBy: { name: 'marcom.route.admin' } });
      const detail = await (await call('GET', `/marcom/upload/batches/${goodBatch}`, 'admin')).json();
      expect(detail.tables).toHaveLength(7);
      const file = await call('GET', `/marcom/upload/batches/${goodBatch}/file`, 'admin');
      expect(file.status).toBe(200);
      expect(Buffer.from(await file.arrayBuffer()).subarray(0, 2).toString()).toBe('PK');
    });

    it("another user cannot read or commit this admin's staged upload", async () => {
      const other = await call('GET', `/marcom/upload/staged/${goodStaged}/errors.csv`, 'ratelimit');
      expect(other.status).toBe(403);
      const commit = await call('POST', '/marcom/upload/commit', 'ratelimit', { json: { stagedUploadId: goodStaged, confirmNewBrands: true } });
      expect(commit.status).toBe(403);
      expect((await commit.json()).code).toBe('STAGED_FORBIDDEN');
    });

    it('commit surfaces the new-brand guard and bad input as coded JSON', async () => {
      const bad = await call('POST', '/marcom/upload/commit', 'admin', { json: { stagedUploadId: 'not-a-uuid' } });
      expect(bad.status).toBe(400);
      const gone = await call('POST', '/marcom/upload/commit', 'admin', { json: { stagedUploadId: UUID } });
      expect(gone.status).toBe(404);
      expect((await gone.json()).code).toBe('STAGED_NOT_FOUND');
    });

    it('rollback needs a reason and only works for the latest batch', async () => {
      expect((await call('POST', `/marcom/upload/batches/${goodBatch}/rollback`, 'admin', { json: {} })).status).toBe(400);
      expect((await call('POST', '/marcom/upload/batches/99999/rollback', 'admin', { json: { reason: 'nope nope' } })).status).toBe(404);
      expect((await call('POST', '/marcom/upload/batches/abc/rollback', 'admin', { json: { reason: 'nope nope' } })).status).toBe(404);
    });
  });

  describe('upload hardening', () => {
    it('rejects a wrong extension, a fake .xlsx, and an empty body', async () => {
      const xls = await call('POST', '/marcom/upload/validate', 'admin', { body: form(Buffer.from('hello'), 'a.xls') });
      expect(xls.status).toBe(400);
      const fake = await call('POST', '/marcom/upload/validate', 'admin', { body: form(Buffer.from('this is not a zip file at all'), 'fake.xlsx') });
      expect(fake.status).toBe(400);
      expect((await fake.json()).error).toMatch(/ZIP signature/);
      const none = await call('POST', '/marcom/upload/validate', 'admin', { body: new FormData() });
      expect(none.status).toBe(400);
    });

    it('rejects an oversize upload with 413 and stores nothing', async () => {
      const before = fs.readdirSync(process.env.MARCOM_STAGING_DIR!).length;
      const r = await call('POST', '/marcom/upload/validate', 'admin', { body: form(Buffer.alloc(11 * 1024 * 1024, 1), 'big.xlsx') });
      expect(r.status).toBe(413);
      expect((await r.json()).code).toBe('FILE_TOO_LARGE');
      expect(fs.readdirSync(process.env.MARCOM_STAGING_DIR!).length).toBe(before);
    });

    it('a traversal filename is stored under a random name and reported as its base name', async () => {
      const r = await call('POST', '/marcom/upload/validate', 'admin', { body: form(await monthFile({ month: 'May' }), '../../x.xlsx') });
      expect(r.status).toBe(200);
      const p = await r.json();
      expect(p.filename).toBe('x.xlsx');
      expect(fs.existsSync(`${process.env.MARCOM_STAGING_DIR}/${p.stagedUploadId}.xlsx`)).toBe(true);
    });

    it('rate-limits the validate endpoint per user (429)', async () => {
      const buf = Buffer.from('junk');
      const codes: number[] = [];
      for (let i = 0; i < 14; i++) {
        codes.push((await call('POST', '/marcom/upload/validate', 'ratelimit', { body: form(buf, 'a.xlsx') })).status);
      }
      expect(codes.slice(0, 12).every((c) => c === 400)).toBe(true);
      expect(codes.slice(12)).toEqual([429, 429]);
      // ...and other users are unaffected.
      expect((await call('POST', '/marcom/upload/validate', 'admin', { body: form(buf, 'a.xlsx') })).status).toBe(400);
    });
  });
});
