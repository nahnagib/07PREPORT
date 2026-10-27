import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * The follow-up page drives the NPS page, on a REAL warehouse. Opt-in, and it WRITES (then restores):
 *
 *   npx vitest run -c vitest.nps-live.config.ts      (DB_* in the environment, e.g. the local powerBI_Data)
 *
 * Edits one open case through the follow-up API (PATCH /nps-followup/cases/:id: status + reason, with its version),
 * then reads the NPS page's endpoints straight away: the detractor list and the follow-up summary must show the change
 * on the very next request (they read nps_followup_case live, not the nightly ETL). Afterwards the case row is put back
 * exactly as it was and the audit rows of the test are deleted.
 */
const RUN = process.env.NPS_TEST_DB_WRITE === '1';

vi.mock('../../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = {
      id: Number(process.env.NPS_TEST_ACTOR_ID), email: 't@test.local', fullName: 't', status: 'ACTIVE', mustChangePassword: false,
      roleId: null, roleName: null, roleLabel: null, roles: [], isAdmin: true, roleTierCode: 'BI00_EXECUTIVE', salespersonKey: null,
      companyScope: 'ALL', jti: 'j',
    } as unknown as express.Request['user'];
    next();
  },
}));

type Json = any;
let server: Server;
let base = '';
let pool: typeof import('../../db/pool').pool;
const qa = async (sql: string, params: unknown[] = []): Promise<Json[]> => (await pool.query(sql, params))[0] as Json[];
const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> => {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

describe.skipIf(!RUN)('an edit on the follow-up page shows on the NPS page at once (real warehouse, restored afterwards)', () => {
  let snapshot: Json;
  let lastAudit = 0;

  beforeAll(async () => {
    ({ pool } = await import('../../db/pool'));
    const [actor] = await qa("SELECT user_id FROM app_user WHERE is_active = 1 ORDER BY user_id LIMIT 1");
    process.env.NPS_TEST_ACTOR_ID = String(actor.user_id);
    const { npsScoreRouter } = await import('../npsScore');
    const { npsFollowupRouter } = await import('../npsFollowup');
    const app = express();
    app.use(express.json());
    app.use('/nps-score', npsScoreRouter);
    app.use('/nps-followup', npsFollowupRouter);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    [snapshot] = await qa(`SELECT c.* FROM nps_followup_case c JOIN fact_process_nps_response f ON f.response_id = c.response_id
                            WHERE c.status IN ('NEW', 'CONTACTED') AND f.nps_level = 1 ORDER BY c.rated_at_local DESC LIMIT 1`);
    const [a] = await qa('SELECT COALESCE(MAX(audit_id), 0) AS m FROM nps_followup_audit');
    lastAudit = Number(a.m);
  });

  afterAll(async () => {
    if (snapshot) {
      await pool.query(
        `UPDATE nps_followup_case SET status = ?, reason_id = ?, owner_user_id = ?, owner_name = ?, contacted_at = ?, solved_at = ?, root_cause = ?,
                action_taken = ?, notes = ?, version = ?, updated_by = ?, updated_at = ? WHERE case_id = ?`,
        [snapshot.status, snapshot.reason_id, snapshot.owner_user_id, snapshot.owner_name ?? null, snapshot.contacted_at, snapshot.solved_at, snapshot.root_cause,
          snapshot.action_taken, snapshot.notes, snapshot.version, snapshot.updated_by, snapshot.updated_at, snapshot.case_id]);
      await pool.query('DELETE FROM nps_followup_audit WHERE case_id = ? AND audit_id > ?', [snapshot.case_id, lastAudit]);
    }
    server?.close();
    await pool?.end();
  });

  it('status and reason edited through the API are returned by the NPS endpoints on the next request', async () => {
    expect(snapshot, 'an open (New / Contacted) detractor case to edit').toBeTruthy();
    const ratedOn = new Date(snapshot.rated_at_local).toISOString().slice(0, 10);
    const range = `dateFrom=${ratedOn.slice(0, 4)}-01-01&dateTo=${ratedOn}`;
    const [reason] = await qa('SELECT reason_id, name_en FROM nps_followup_reason WHERE is_active = 1 AND reason_id <> COALESCE(?, 0) ORDER BY sort_order LIMIT 1',
      [snapshot.reason_id]);

    const before = await call('GET', `/nps-score/followup-summary?${range}`);
    const countOf = (s: Json, id: number | null) => s.byReason.find((r: Json) => r.reasonId === id)?.count ?? 0;

    const edit = await call('PATCH', `/nps-followup/cases/${snapshot.case_id}`, { version: snapshot.version, status: 'IN_PROGRESS', reasonId: reason.reason_id });
    expect(edit.status).toBe(200);
    expect(edit.body.case).toMatchObject({ status: 'IN_PROGRESS', reasonId: reason.reason_id });

    const list = await call('GET', `/nps-score/detractors?${range}&pageSize=500`);
    const row = list.body.rows.find((r: Json) => r.caseId === Number(snapshot.case_id));
    expect(row).toMatchObject({ status: 'IN_PROGRESS', reason: reason.name_en });

    const after = await call('GET', `/nps-score/followup-summary?${range}`);
    expect(countOf(after.body, reason.reason_id)).toBe(countOf(before.body, reason.reason_id) + 1);
    expect(after.body.detractors).toBe(before.body.detractors);
    // still pending (In progress), so the status buckets keep their totals
    expect(after.body.byStatus).toEqual(before.body.byStatus);
  });
});
