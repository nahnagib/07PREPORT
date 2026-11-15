import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Product Development Plan end to end against a REAL test database (opt-in, writes, cleans up after itself):
 *
 *   PDP_TEST_DB=1 DB_HOST=127.0.0.1 DB_PORT=33309 DB_NAME=powerBI_Data DB_USER=... DB_PASSWORD=... \
 *     [PDP_IMPORT_DIR=...\Input\product_development] npx vitest run -c vitest.pdp-db.config.ts
 *
 * Needs migrations 0075-0077 and the app users 3, 4, 5, 9, 21, 23-27 of the local test database. Refuses to run on port
 * 3306 (the local production copy). The real router, services and pool; only the signed-in user and the page grants
 * are faked. Everything the test creates lives under its own family "PDP-TEST family", never the imported tree, and
 * is removed at the end (governance members included, so the admin screen stays empty for the real assignment).
 */
const RUN = process.env.PDP_TEST_DB === '1' && process.env.DB_HOST === '127.0.0.1' && process.env.DB_PORT === '33309';

const ENTRY_ALL = ['view', 'create', 'edit', 'delete', 'export'].map((a) => ['product_development_entry', a]);
const APPROVE = [['product_development_approval', 'view'], ['product_development_approval', 'edit']];
const FULL = [['product_development_plan', 'view'], ...ENTRY_ALL, ...APPROVE] as [string, string][];
// test-DB user ids (all active)
const U = { admin: 21, chairman: 5, ceo: 4, exco: 9, tm: 24, rnd: 25, qc: 26, prod: 27, ts: 3, mkt: 23 } as const;
type Who = keyof typeof U;

vi.mock('../../middleware/auth', () => ({
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const who = req.header('x-test-user') as Who | undefined;
    if (!who || !(who in U)) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    req.user = {
      id: U[who], email: `${who}@test.local`, fullName: who, status: 'ACTIVE', mustChangePassword: false, roleId: 1, roleName: null, roleLabel: null,
      roles: [], isAdmin: who === 'admin', roleTierCode: null, salespersonKey: null, companyScope: 'ALL', jti: 'j',
    } as unknown as express.Request['user'];
    next();
  },
}));
vi.mock('../../services/permissionService', async () => {
  const actual = await vi.importActual<typeof import('../../services/permissionService')>('../../services/permissionService');
  return {
    ...actual,
    getRequestPermissions: async (req: express.Request) => actual.computeEffectivePermissions({
      isAdmin: req.header('x-test-user') === 'admin',
      roleGrants: FULL.map(([page_key, action]) => ({ page_key, action: action as never, allowed: 1 })),
      overrides: [],
    }),
  };
});

let server: Server;
let base = '';
let pool: typeof import('../../db/pool').pool;
let tika = 0;
type R = { status: number; body: any };
async function api(method: string, path: string, who: Who, body?: unknown): Promise<R> {
  const r = await fetch(`${base}${path}`, { method, headers: { 'x-test-user': who, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let b: unknown = t;
  try { b = JSON.parse(t); } catch { /* binary */ }
  return { status: r.status, body: b };
}
async function q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await pool.query(sql, params);
  return rows as T[];
}
const ok = (r: R, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const fails = (r: R, code: string) => expect(r.body?.code, JSON.stringify(r.body)).toBe(code);

const created = { members: [] as number[], projects: [] as string[], products: [] as number[], families: [] as number[], subfamilies: [] as number[], feedback: [] as number[] };
let settingsBefore: Record<string, string> = {};
let familyId = 0;
let subfamilyId = 0;

async function setSetting(k: string, v: string) {
  await q('UPDATE pdp_setting SET setting_value = ? WHERE company_key = ? AND setting_key = ?', [v, tika, k]);
}
async function detail(code: string) {
  return ok(await api('GET', `/projects/${code}`, 'tm'));
}
async function itemIds(code: string, list: string) {
  const d = await detail(code);
  return (d.checklist as any[]).filter((c) => c.template.list_code === list).map((c) => ({ id: c.item.item_id, code: c.template.item_code, required: c.template.required }));
}
async function completeList(code: string, list: string, withLink = false) {
  for (const it of await itemIds(code, list)) {
    if (!it.required) continue;
    ok(await api('PATCH', `/projects/${code}/checklist/${it.id}`, 'tm', { status: 'done', ...(withLink ? { linkUrl: `https://docs.example/${it.code}` } : {}) }));
  }
}
async function scoreRound(code: string, scores: number[]) {
  const crit = (await q<{ criterion_id: number }>('SELECT criterion_id FROM pdp_scoring_criterion WHERE company_key = ? AND is_active = 1 ORDER BY sort_order', [tika]));
  return api('POST', `/projects/${code}/scores`, 'rnd', { scores: crit.map((c, i) => ({ criterionId: c.criterion_id, score: scores[i], evidence: `reason ${i}` })) });
}
const decide = (code: string, who: Who, roleCode: string, decision = 'approve', extra: Record<string, unknown> = {}) =>
  api('POST', `/projects/${code}/decisions`, who, { decision, roleCode, ...extra });

async function newProject(who: Who, body: Record<string, unknown>) {
  const types = await q<{ value_id: number; list_key: string }>("SELECT value_id, list_key FROM pdp_dropdown_value WHERE company_key = ? AND list_key IN ('project_type','request_source') ORDER BY sort_order", [tika]);
  const r = ok(await api('POST', '/projects', who, {
    title: 'PDP-TEST project', projectTypeId: types.find((t) => t.list_key === 'project_type')!.value_id,
    requestSourceId: types.find((t) => t.list_key === 'request_source')!.value_id, requestedBy: 'Sales team', classification: 'planned', ...body,
  }), 201);
  created.projects.push(r.code);
  return r.code as string;
}
async function readyForG1(code: string, scores = [4, 4, 4, 4, 4, 4]) {
  ok(await scoreRound(code, scores), 201);
  await completeList(code, 'FEASIBILITY');
  ok(await api('POST', `/projects/${code}/members`, 'tm', { userId: U.rnd, roleLabel: 'Formulation' }), 201);
  ok(await api('PATCH', `/projects/${code}`, 'tm', { objectives: 'Launch a competitive product', targetLaunchDate: '2027-06-30' }));
}

describe.skipIf(!RUN)('Product Development Plan on a real database', () => {
  beforeAll(async () => {
    ({ pool } = await import('../../db/pool'));
    const { tikaCompanyKey } = await import('../../services/pdp/company');
    tika = await tikaCompanyKey();
    const { productDevelopmentRouter } = await import('../productDevelopment');
    const app = express();
    app.use(express.json());
    app.use('/product-development', productDevelopmentRouter);
    // Express needs the 4-argument signature to treat this as the error handler.
    // eslint-disable-next-line no-unused-vars
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(500).json({ error: String(err) }); });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/product-development`;
    settingsBefore = Object.fromEntries((await q<{ setting_key: string; setting_value: string }>('SELECT setting_key, setting_value FROM pdp_setting WHERE company_key = ?', [tika])).map((s) => [s.setting_key, s.setting_value]));
    if ((await q('SELECT 1 FROM pdp_governance_member WHERE company_key = ? AND deleted_at IS NULL', [tika])).length) throw new Error('governance members already assigned: this test would change real approvers');
    if ((await q("SELECT 1 FROM pdp_project WHERE company_key = ? AND state = 'active' AND deleted_at IS NULL", [tika])).length) throw new Error('active projects exist: the capacity checks need an empty pipeline');
  });

  afterAll(async () => {
    if (!pool) return;
    for (const [k, v] of Object.entries(settingsBefore)) await setSetting(k, v);
    const pids = created.projects.length ? (await q<{ project_id: number }>('SELECT project_id FROM pdp_project WHERE code IN (?)', [created.projects])).map((p) => p.project_id) : [];
    const prodIds = [...created.products, ...(pids.length ? (await q<{ product_id: number }>('SELECT product_id FROM pdp_project WHERE project_id IN (?) AND product_id IS NOT NULL', [pids])).map((p) => p.product_id) : [])];
    const del = async (sql: string, ids: unknown[]) => { if (ids.length) await q(sql, [ids]); };
    if (created.feedback.length) await del('DELETE FROM pdp_feedback_history WHERE feedback_id IN (?)', created.feedback);
    await del('DELETE FROM pdp_customer_feedback WHERE feedback_id IN (?)', created.feedback);
    await del("DELETE FROM pdp_attachment WHERE (owner_type = 'checklist' AND owner_id IN (SELECT item_id FROM pdp_project_checklist WHERE project_id IN (?)))", pids);
    await del('DELETE FROM pdp_launch WHERE project_id IN (?)', pids);
    await del('DELETE FROM pdp_launch WHERE product_id IN (?)', prodIds);
    for (const t of ['pdp_project_checklist', 'pdp_lab_test', 'pdp_field_trial', 'pdp_pilot_batch', 'pdp_documentation_error', 'pdp_gate_decision', 'pdp_project_member', 'pdp_project_history']) {
      await del(`DELETE FROM ${t} WHERE project_id IN (?)`, pids);
    }
    await del('DELETE s FROM pdp_project_score s JOIN pdp_score_round r ON r.round_id = s.round_id WHERE r.project_id IN (?)', pids);
    await del('DELETE FROM pdp_score_round WHERE project_id IN (?)', pids);
    await del('DELETE FROM pdp_project WHERE project_id IN (?)', pids);
    await del('DELETE FROM pdp_product_history WHERE product_id IN (?)', prodIds);
    await del('DELETE FROM pdp_product WHERE product_id IN (?)', prodIds);
    await del('DELETE FROM pdp_product WHERE subfamily_id IN (?)', created.subfamilies);
    await del('DELETE FROM pdp_product_subfamily WHERE subfamily_id IN (?)', created.subfamilies);
    await del('DELETE FROM pdp_product_family WHERE family_id IN (?)', created.families);
    await del('DELETE FROM pdp_governance_member WHERE member_id IN (?)', created.members);
    await q("DELETE FROM pdp_project_seq WHERE company_key = ? AND last_no > 0 AND NOT EXISTS (SELECT 1 FROM pdp_project)", [tika]);
    server?.close();
    await pool.end();
  });

  it('no approvers yet: every gate warns "No approver assigned"; then the governance members are assigned (Admin only)', async () => {
    expect(ok(await api('GET', '/reference', 'tm')).noApprover).toEqual(['G1', 'G2', 'G3', 'G4', 'G5']);
    fails(await api('POST', '/admin/governance', 'tm', { roleCode: 'CEO', userId: U.ceo }), undefined as never); // 403 has no code
    expect((await api('POST', '/admin/governance', 'tm', { roleCode: 'CEO', userId: U.ceo })).status).toBe(403);
    const assign: [string, Who][] = [['CHAIRMAN', 'chairman'], ['CEO', 'ceo'], ['EXCO', 'exco'], ['TECH_MANAGER', 'tm'], ['RND', 'rnd'], ['QC_QA', 'qc'], ['TS', 'ts'], ['MARKETING', 'mkt']];
    for (const [role, who] of assign) created.members.push(ok(await api('POST', '/admin/governance', 'admin', { roleCode: role, userId: U[who] }), 201).member_id);
    expect(ok(await api('GET', '/reference', 'tm')).noApprover).toEqual(['G2']); // Production still missing
    created.members.push(ok(await api('POST', '/admin/governance', 'admin', { roleCode: 'PRODUCTION', userId: U.prod }), 201).member_id);
    expect(ok(await api('GET', '/reference', 'tm')).noApprover).toEqual([]);
  });

  it('builds a test family/subfamily in the tree (entry)', async () => {
    const brand = (await q<{ brand_id: number }>('SELECT brand_id FROM pdp_brand WHERE company_key = ? AND deleted_at IS NULL LIMIT 1', [tika]))[0];
    expect(brand, 'run the import first').toBeTruthy();
    familyId = ok(await api('POST', '/families', 'tm', { brandId: brand.brand_id, name: 'PDP-TEST family', description: 'وصف تجريبي' }), 201).family_id;
    created.families.push(familyId);
    subfamilyId = ok(await api('POST', '/subfamilies', 'tm', { familyId, name: 'PDP-TEST sub' }), 201).subfamily_id;
    created.subfamilies.push(subfamilyId);
  });

  it('TIKA only: a Majaal company key is refused; every row is written with TIKA\'s key', async () => {
    const majaal = (await q<{ CompanyKey: number }>("SELECT CompanyKey FROM dim_company WHERE LOWER(Company) = 'majaal'"))[0].CompanyKey;
    expect(majaal).not.toBe(tika);
    fails(await api('POST', '/products', 'tm', { subfamilyId, name: 'PDP-TEST Majaal', companyKey: majaal }), 'company.notAllowed');
    fails(await api('GET', `/tree?companyKey=${majaal}`, 'tm'), 'company.notAllowed');
    expect(await q('SELECT 1 FROM pdp_product WHERE name = ?', ['PDP-TEST Majaal'])).toEqual([]);
  });

  it('rule 1: no project without a Product Tree link', async () => {
    fails(await api('POST', '/projects', 'tm', { title: 'x', classification: 'planned', projectTypeId: 1, requestSourceId: 1, requestedBy: 'x' }), 'project.treeLink');
  });

  let A = '';
  let B = '';
  it('project B (unplanned): a Chairman kick-off is not enough, the CEO/EXCO approval completes it', async () => {
    B = await newProject('tm', { classification: 'unplanned', proposedProductName: 'PDP-TEST B product', proposedSubfamilyId: subfamilyId });
    ok(await api('POST', `/projects/${B}/submit`, 'tm', {}));
    await readyForG1(B, [4, 4, 4, 4, 4, 4]);
    expect(ok(await decide(B, 'chairman', 'CHAIRMAN')).state).toBe('submitted');
    expect(ok(await decide(B, 'exco', 'EXCO'))).toEqual({ currentGate: 'G2', state: 'active' });
    const product = (await q<{ status: string; source: string }>('SELECT p.status, p.source FROM pdp_project j JOIN pdp_product p ON p.product_id = j.product_id WHERE j.code = ?', [B]))[0];
    expect(product).toEqual({ status: 'under_development', source: 'PROJECT' }); // the proposal became a product at the kick-off
  });

  it('project A: G0 submit, then every G1 rule (score, revise, feasibility, team, roles, capacity)', async () => {
    A = await newProject('tm', { proposedProductName: 'PDP-TEST A product', proposedSubfamilyId: subfamilyId });
    expect((await detail(A)).project).toMatchObject({ state: 'draft', current_gate: 'G0' });
    fails(await decide(A, 'ceo', 'CEO'), 'project.notSubmitted');
    ok(await api('POST', `/projects/${A}/submit`, 'tm', {}));
    fails(await api('POST', `/projects/${A}/submit`, 'tm', {}), 'project.alreadySubmitted');
    fails(await decide(A, 'ceo', 'CEO'), 'gate.scoreMissing');
    // 58: below 60 -> only reject / revise
    expect(ok(await scoreRound(A, [4, 3, 2, 5, 1, 0]), 201)).toMatchObject({ total: 58, passed: false });
    fails(await scoreRound(A, [4, 3, 2, 5, 1, 9]), 'score.range');
    fails(await decide(A, 'ceo', 'CEO'), 'gate.scoreBelowMin');
    fails(await decide(A, 'ceo', 'CEO', 'revise'), 'decision.commentRequired');
    ok(await decide(A, 'ceo', 'CEO', 'revise', { comment: 'Rework the cost structure' }));
    expect((await detail(A)).project.gate_round).toBe(2);
    // exactly 60 passes the score rule; the rest of G1 still blocks
    expect(ok(await scoreRound(A, [3, 3, 3, 3, 3, 3]), 201)).toMatchObject({ total: 60, passed: true });
    fails(await decide(A, 'ceo', 'CEO'), 'gate.checklistOpen');
    await completeList(A, 'FEASIBILITY');
    fails(await decide(A, 'ceo', 'CEO'), 'gate.teamRequired');
    ok(await api('POST', `/projects/${A}/members`, 'tm', { userId: U.rnd, roleLabel: 'Formulation' }), 201);
    fails(await decide(A, 'ceo', 'CEO'), 'gate.objectivesRequired');
    ok(await api('PATCH', `/projects/${A}`, 'tm', { objectives: 'A tile adhesive for hot climates', targetLaunchDate: '2027-03-31' }));
    // roles: the permission alone is not enough; the role must be one G1 needs
    fails(await decide(A, 'tm', 'CEO'), 'decision.notMember');
    fails(await decide(A, 'qc', 'QC_QA'), 'decision.roleNotRequired');
    fails(await decide(A, 'ts', 'TS'), 'decision.roleNotRequired'); // a later gate's approver cannot skip ahead
    // capacity: B is active; a cap of 1 blocks the kick-off for the Chairman, the CEO overrides with a reason
    await setSetting('max_concurrent_projects', '1');
    fails(await decide(A, 'chairman', 'CHAIRMAN'), 'capacity.full');
    fails(await decide(A, 'ceo', 'CEO'), 'capacity.reasonRequired');
    expect(ok(await decide(A, 'ceo', 'CEO', 'approve', { overrideReason: 'Strategic customer contract' }))).toEqual({ currentGate: 'G2', state: 'active' });
    await setSetting('max_concurrent_projects', settingsBefore.max_concurrent_projects ?? '6');
    const hist = (await detail(A)).history as any[];
    expect(hist.find((h) => h.event === 'capacity_override')?.comment).toBe('Strategic customer contract');
  });

  it('G2: a lab test and the technical evaluation by R&D + QC/QA + Production', async () => {
    const props = await q<{ value_id: number; list_key: string }>("SELECT value_id, list_key FROM pdp_dropdown_value WHERE company_key = ? AND list_key IN ('lab_property','competitor') ORDER BY sort_order", [tika]);
    fails(await decide(A, 'rnd', 'RND'), 'gate.labTestRequired');
    ok(await api('POST', `/projects/${A}/lab-tests`, 'rnd', { trialNo: 1, testDate: '2026-11-10', propertyId: props.find((p) => p.list_key === 'lab_property')!.value_id, competitorId: props.find((p) => p.list_key === 'competitor')!.value_id, target: '>= 1.0 N/mm2', result: '1.2 N/mm2', passed: true }), 201);
    expect(ok(await decide(A, 'rnd', 'RND')).currentGate).toBe('G2');
    fails(await decide(A, 'rnd', 'RND'), 'decision.duplicate');
    expect(ok(await decide(A, 'qc', 'QC_QA')).currentGate).toBe('G2');
    expect(ok(await decide(A, 'prod', 'PRODUCTION'))).toEqual({ currentGate: 'G3', state: 'active' });
  });

  it('G3: a field trial led by Technical Support and the TS pre-launch validation', async () => {
    fails(await decide(A, 'ts', 'TS'), 'gate.fieldTrialRequired');
    const trial = { trialDate: '2026-11-12', site: 'Tripoli villa project', customerName: 'شركة الاختبار', scoreSetting: 4, scoreBonding: 5, scoreFlexibility: 4, scoreCoverage: 4, scoreSatisfaction: 5, passed: true };
    fails(await api('POST', `/projects/${A}/field-trials`, 'tm', { ...trial, tsLeadUserId: U.rnd }), 'trial.tsLead');
    ok(await api('POST', `/projects/${A}/field-trials`, 'tm', { ...trial, tsLeadUserId: U.ts }), 201);
    expect(ok(await decide(A, 'ts', 'TS'))).toEqual({ currentGate: 'G4', state: 'active' });
  });

  it('G4: a 500-1500 kg pilot batch confirmed by QC, R&D and Production, the raw-material checks, then the Technical Manager', async () => {
    fails(await api('POST', `/projects/${A}/pilot-batches`, 'tm', { batchNo: 1, batchDate: '2026-11-13', batchKg: 400 }), 'batch.kgRange');
    fails(await api('POST', `/projects/${A}/pilot-batches`, 'tm', { batchNo: 1, batchDate: '2026-11-13', batchKg: 1600 }), 'batch.kgRange');
    const batch = ok(await api('POST', `/projects/${A}/pilot-batches`, 'tm', { batchNo: 1, batchDate: '2026-11-13', batchKg: 800 }), 201).batch_id;
    fails(await decide(A, 'tm', 'TECH_MANAGER'), 'gate.pilotRequired');
    fails(await api('POST', `/projects/${A}/pilot-batches/${batch}/confirm`, 'rnd', { kind: 'qc' }), 'batch.notMember');
    for (const [who, kind] of [['qc', 'qc'], ['rnd', 'rnd'], ['prod', 'production']] as [Who, string][]) ok(await api('POST', `/projects/${A}/pilot-batches/${batch}/confirm`, who, { kind }));
    fails(await decide(A, 'tm', 'TECH_MANAGER'), 'gate.checklistOpen'); // raw-material approval items
    await completeList(A, 'RAW_MATERIAL');
    expect(ok(await decide(A, 'tm', 'TECH_MANAGER'))).toEqual({ currentGate: 'G5', state: 'active' });
  });

  it('attachments: 10 MB, PDF/images/DOCX/XLSX only, checked by content', async () => {
    const item = (await itemIds(A, 'DOCUMENTATION')).find((i) => i.code === 'DOC_TDS')!;
    const send = async (name: string, content: Buffer) => {
      const fd = new FormData();
      fd.append('ownerType', 'checklist');
      fd.append('ownerId', String(item.id));
      fd.append('file', new Blob([content]), name);
      const r = await fetch(`${base}/attachments`, { method: 'POST', headers: { 'x-test-user': 'rnd' }, body: fd });
      return { status: r.status, body: await r.json() as any };
    };
    fails(await send('tool.exe', Buffer.from('MZ fake executable padding')), 'attachment.type');
    fails(await send('fake.pdf', Buffer.from('this is plain text, not a pdf')), 'attachment.mismatch');
    const pdf = await send('TDS.pdf', Buffer.from('%PDF-1.4\n% test file\n'));
    expect(pdf.status).toBe(201);
    const back = await fetch(`${base}/attachments/${pdf.body.attachment_id}`, { headers: { 'x-test-user': 'tm' } });
    expect(Buffer.from(await back.arrayBuffer()).toString('latin1')).toBe('%PDF-1.4\n% test file\n');
  });

  it('G5: the 7-document package (Packaging stays optional) and EXCO -> launched, product in market, launch record', async () => {
    fails(await decide(A, 'exco', 'EXCO'), 'gate.checklistOpen');
    // done without evidence still blocks (each document needs an attachment or a link)
    const docs = (await itemIds(A, 'DOCUMENTATION')).filter((i) => i.required && i.code !== 'DOC_TDS');
    ok(await api('PATCH', `/projects/${A}/checklist/${docs[0].id}`, 'tm', { status: 'done' }));
    ok(await api('PATCH', `/projects/${A}/checklist/${(await itemIds(A, 'DOCUMENTATION')).find((i) => i.code === 'DOC_TDS')!.id}`, 'tm', { status: 'done' }));
    fails(await decide(A, 'exco', 'EXCO'), 'gate.checklistOpen');
    await completeList(A, 'DOCUMENTATION', true);
    fails(await decide(A, 'ceo', 'CEO'), 'decision.roleNotRequired');
    expect(ok(await decide(A, 'exco', 'EXCO'))).toEqual({ currentGate: 'G5', state: 'launched' });
    const p = (await q<{ status: string; actual_launch_date: Date | null; product_id: number }>('SELECT p.product_id, p.status, p.actual_launch_date FROM pdp_project j JOIN pdp_product p ON p.product_id = j.product_id WHERE j.code = ?', [A]))[0];
    expect(p.status).toBe('in_market');
    expect(p.actual_launch_date).not.toBeNull();
    expect((await q('SELECT status FROM pdp_launch WHERE product_id = ? AND deleted_at IS NULL', [p.product_id]))[0]).toEqual({ status: 'launched' });
    fails(await decide(A, 'exco', 'EXCO'), 'project.readOnly');
  });

  it('documentation errors are entered by QC/QA; closure needs a report and makes the project read-only (admins excepted)', async () => {
    fails(await api('POST', `/projects/${A}/doc-errors`, 'rnd', { document: 'TDS', severity: 'critical', foundDate: '2026-11-14', description: 'Wrong coverage' }), 'docError.notQc');
    ok(await api('POST', `/projects/${A}/doc-errors`, 'qc', { document: 'TDS', severity: 'critical', foundDate: '2026-11-14', description: 'Wrong coverage figure' }), 201);
    fails(await api('POST', `/projects/${A}/close`, 'qc', { closureReport: 'x' }), 'project.closeNotAllowed');
    fails(await api('POST', `/projects/${A}/close`, 'tm', {}), 'field.required');
    ok(await api('POST', `/projects/${A}/close`, 'tm', { closureReport: 'Launched on time; data archived; KPIs reviewed.' }));
    expect((await detail(A)).project.state).toBe('closed');
    fails(await api('PATCH', `/projects/${A}`, 'tm', { title: 'changed' }), 'project.closed');
    ok(await api('PATCH', `/projects/${A}`, 'admin', { title: 'PDP-TEST project (admin fix)' }));
  });

  it('every gate decision and status change is in the append-only history', async () => {
    const pid = (await q<{ project_id: number }>('SELECT project_id FROM pdp_project WHERE code = ?', [A]))[0].project_id;
    const events = (await q<{ event: string }>('SELECT event FROM pdp_project_history WHERE project_id = ? ORDER BY history_id', [pid])).map((e) => e.event);
    expect(events.filter((e) => e === 'gate_decision').length).toBe(8); // revise + CEO + RND/QC/PROD + TS + TM + EXCO (+ blocked ones are not written)
    expect(events.filter((e) => e === 'gate_passed').length).toBe(5);
    expect(events).toEqual(expect.arrayContaining(['created', 'submitted', 'revise', 'capacity_override', 'scoring_round', 'state']));
    const decisions = await q<{ gate: string; decision: string; approver_role_code: string }>('SELECT gate, decision, approver_role_code FROM pdp_gate_decision WHERE project_id = ? ORDER BY decision_id', [pid]);
    expect(decisions.map((d) => `${d.gate}:${d.decision}:${d.approver_role_code}`)).toEqual([
      'G1:revise:CEO', 'G1:approve:CEO', 'G2:approve:RND', 'G2:approve:QC_QA', 'G2:approve:PRODUCTION', 'G3:approve:TS', 'G4:approve:TECH_MANAGER', 'G5:approve:EXCO',
    ]);
  });

  it('on hold does not count toward the cap; resuming is checked like a G1 approval', async () => {
    ok(await api('POST', `/projects/${B}/hold`, 'tm', { reason: 'Raw material shortage' }));
    const ov = ok(await api('GET', '/overview', 'tm'));
    expect(ov.capacity).toMatchObject({ active: 0, onHold: 1 });
    // another project becomes active, then the cap is 1
    const C = await newProject('tm', { proposedProductName: 'PDP-TEST C product', proposedSubfamilyId: subfamilyId });
    ok(await api('POST', `/projects/${C}/submit`, 'tm', {}));
    await readyForG1(C);
    ok(await decide(C, 'chairman', 'CHAIRMAN'));
    await setSetting('max_concurrent_projects', '1');
    fails(await api('POST', `/projects/${B}/resume`, 'tm', {}), 'capacity.full');
    fails(await api('POST', `/projects/${B}/resume`, 'ceo', {}), 'capacity.reasonRequired');
    ok(await api('POST', `/projects/${B}/resume`, 'ceo', { overrideReason: 'Material arrived' }));
    await setSetting('max_concurrent_projects', settingsBefore.max_concurrent_projects ?? '6');
    // a reject ends the project
    fails(await decide(B, 'rnd', 'RND', 'reject'), 'decision.commentRequired');
    ok(await decide(B, 'rnd', 'RND', 'reject', { comment: 'Not viable at this cost' }));
    expect((await detail(B)).project.state).toBe('rejected');
    fails(await decide(B, 'qc', 'QC_QA'), 'project.readOnly');
  });

  it('fast-track: G2/G3 work may start at G1 (approvals stay sequential); the 72 h alert; a normal project must wait', async () => {
    const D = await newProject('tm', { fastTrack: true, proposedProductName: 'PDP-TEST D product', proposedSubfamilyId: subfamilyId });
    ok(await api('POST', `/projects/${D}/submit`, 'tm', {}));
    const prop = (await q<{ value_id: number }>("SELECT value_id FROM pdp_dropdown_value WHERE company_key = ? AND list_key = 'lab_property' LIMIT 1", [tika]))[0].value_id;
    ok(await api('POST', `/projects/${D}/lab-tests`, 'rnd', { trialNo: 1, testDate: '2026-11-14', propertyId: prop, target: 'x', result: 'y', passed: false }), 201);
    fails(await decide(D, 'rnd', 'RND'), 'decision.roleNotRequired');
    await q('UPDATE pdp_project SET submitted_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 73 HOUR) WHERE code = ?', [D]);
    const alerts = ok(await api('GET', '/overview', 'tm')).alerts as any[];
    expect(alerts.some((a) => a.kind === 'fast_track' && a.projectCode === D)).toBe(true);
    const E = await newProject('tm', { proposedProductName: 'PDP-TEST E product', proposedSubfamilyId: subfamilyId });
    ok(await api('POST', `/projects/${E}/submit`, 'tm', {}));
    fails(await api('POST', `/projects/${E}/lab-tests`, 'rnd', { trialNo: 1, testDate: '2026-11-14', propertyId: prop, target: 'x', result: 'y', passed: true }), 'work.tooEarly');
    // a draft can be deleted; a submitted project cannot
    fails(await api('DELETE', `/projects/${E}`, 'tm'), 'project.notDraft');
  });

  it('peak-season freeze: blocked unless unplanned and submitted by the CEO/EXCO with a reason', async () => {
    const today = new Date().toISOString().slice(5, 10);
    await setSetting('freeze_from_mmdd', today);
    await setSetting('freeze_to_mmdd', today);
    const F = await newProject('tm', { proposedProductName: 'PDP-TEST F product', proposedSubfamilyId: subfamilyId });
    fails(await api('POST', `/projects/${F}/submit`, 'tm', {}), 'freeze.active');
    const G = await newProject('tm', { classification: 'unplanned', proposedProductName: 'PDP-TEST G product', proposedSubfamilyId: subfamilyId });
    fails(await api('POST', `/projects/${G}/submit`, 'tm', { freezeReason: 'x' }), 'freeze.needsExec');
    fails(await api('POST', `/projects/${G}/submit`, 'exco', {}), 'freeze.reasonRequired');
    ok(await api('POST', `/projects/${G}/submit`, 'exco', { freezeReason: 'Customer site failure' }));
    await setSetting('freeze_from_mmdd', '');
    await setSetting('freeze_to_mmdd', '');
    ok(await api('DELETE', `/projects/${F}`, 'tm'));
  });

  it('the KPI tiles, funnel and alerts calculate from the entered data', async () => {
    const ov = ok(await api('GET', '/overview', 'exco'));
    const t = Object.fromEntries((ov.kpis as any[]).map((k) => [k.code, k]));
    const aId = (await q<{ project_id: number }>('SELECT project_id FROM pdp_project WHERE code = ?', [A]))[0].project_id;
    expect(t.NEW_PRODUCTS.projectIds).toContain(aId);
    expect(t.CRITICAL_DOC_ERRORS.value).toBeGreaterThanOrEqual(1);
    expect(t.CRITICAL_DOC_ERRORS.status).toBe('red');
    expect(t.FIELD_TRIAL_SUCCESS.denominator).toBeGreaterThanOrEqual(1);
    expect(t.CYCLE_TIME.value).not.toBeNull();
    expect(ov.funnel.closed).toBeGreaterThanOrEqual(1);
    expect((ov.alerts as any[]).some((a) => a.kind === 'late_product')).toBe(true); // the imported tree's past launch dates
  });

  it('launch tracking: post-launch sales of a product linked to Odoo, TIKA rows only, first 12 months', async () => {
    const src = (await q<{ ProductKey: number }>(`SELECT d.ProductKey FROM v_sales_product_daily d JOIN dim_product p ON p.ProductKey = d.ProductKey
        WHERE d.CompanyKey = ? AND d.OrderDate >= '2025-01-01' AND d.OrderDate < '2026-01-01' AND p.CompanyKey IN (?, -1) GROUP BY d.ProductKey ORDER BY SUM(d.Value) DESC LIMIT 1`, [tika, tika]))[0];
    expect(src, 'TIKA sales in 2025 on the test DB').toBeTruthy();
    const pid = ok(await api('POST', '/products', 'tm', { subfamilyId, name: 'PDP-TEST launched', status: 'in_market', actualLaunchDate: '2025-01-15', dimProductKey: src.ProductKey }), 201).product_id;
    created.products.push(pid);
    const sales = ok(await api('GET', `/products/${pid}/sales`, 'tm'));
    expect(sales.months).toHaveLength(12);
    expect(sales.months[0].month).toBe('2025-01');
    const expected = await q<{ ym: string; v: string; qn: string }>(`SELECT DATE_FORMAT(OrderDate, '%Y-%m') AS ym, SUM(Value) AS v, SUM(Qty) AS qn FROM fact_sales_product_daily
        WHERE ProductKey = ? AND CompanyKey = ? AND OrderDate BETWEEN '2025-01-01' AND '2025-12-31' GROUP BY ym`, [src.ProductKey, tika]);
    for (const e of expected) {
      const m = sales.months.find((x: any) => x.month === e.ym);
      expect(m.value).toBeCloseTo(Number(e.v), 2);
      expect(m.qty).toBeCloseTo(Number(e.qn), 2);
    }
    const majaal = (await q<{ n: number }>("SELECT COUNT(*) AS n FROM dim_company WHERE LOWER(Company) = 'majaal'"))[0];
    expect(Number(majaal.n)).toBe(1);
    // a Majaal-only product cannot be linked
    const mj = (await q<{ ProductKey: number }>("SELECT ProductKey FROM dim_product WHERE CompanyKey = (SELECT CompanyKey FROM dim_company WHERE LOWER(Company) = 'majaal') LIMIT 1"))[0];
    if (mj) fails(await api('PATCH', `/products/${pid}`, 'tm', { dimProductKey: mj.ProductKey, reason: 'test' }), 'product.odooNotTika');
  });

  it('customer feedback: entry, Arabic text kept, follow-up with history, average per product', async () => {
    const pid = created.products[0];
    const dd = await q<{ value_id: number; list_key: string }>("SELECT value_id, list_key FROM pdp_dropdown_value WHERE company_key = ? AND list_key IN ('feedback_channel','feedback_category')", [tika]);
    const body = { productId: pid, customerName: 'مؤسسة البناء الحديث', feedbackDate: '2026-11-14', channelId: dd.find((d) => d.list_key === 'feedback_channel')!.value_id,
      categoryId: dd.find((d) => d.list_key === 'feedback_category')!.value_id, rating: 2, comment: 'التماسك ضعيف في الحرارة العالية', followupOwnerUserId: U.ts };
    fails(await api('POST', '/feedback', 'tm', { ...body, rating: 6 }), 'field.range');
    const id = ok(await api('POST', '/feedback', 'tm', body), 201).feedback_id;
    created.feedback.push(id);
    fails(await api('PATCH', `/feedback/${id}`, 'ts', { followupStatus: 'resolved' }), 'feedback.resolutionRequired');
    ok(await api('PATCH', `/feedback/${id}`, 'ts', { followupStatus: 'resolved', resolution: 'Site visit; application corrected' }));
    const list = ok(await api('GET', `/feedback?productId=${pid}`, 'tm'));
    expect(list.feedback[0]).toMatchObject({ customer_name: 'مؤسسة البناء الحديث', comment: 'التماسك ضعيف في الحرارة العالية', followup_status: 'resolved' });
    expect(list.averages[0]).toMatchObject({ product_id: pid, avgRating: 2 });
    expect((ok(await api('GET', `/feedback/${id}/history`, 'tm')).history as any[]).map((h) => h.field)).toEqual(expect.arrayContaining(['followup_status', 'created']));
  });

  it('serializes concurrent resumes so only one project takes the last slot', async () => {
    const codes: string[] = [];
    for (const suffix of ['H', 'I']) {
      const code = await newProject('tm', { proposedProductName: `PDP-TEST ${suffix} product`, proposedSubfamilyId: subfamilyId });
      codes.push(code);
      ok(await api('POST', `/projects/${code}/submit`, 'tm', {}));
      await readyForG1(code);
      ok(await decide(code, 'ceo', 'CEO'));
      ok(await api('POST', `/projects/${code}/hold`, 'tm', { reason: 'Waiting for capacity' }));
    }
    const [{ n }] = await q<{n:number}>("SELECT COUNT(*) AS n FROM pdp_project WHERE state='active' AND deleted_at IS NULL AND company_key=?", [tika]);
    await setSetting('max_concurrent_projects', String(Number(n) + 1));
    try {
      const results = await Promise.all(codes.map(code => api('POST', `/projects/${code}/resume`, 'tm', {})));
      expect(results.filter(r => r.status === 200)).toHaveLength(1);
      expect(results.filter(r => r.body.code === 'capacity.full')).toHaveLength(1);
    } finally { await setSetting('max_concurrent_projects', settingsBefore.max_concurrent_projects ?? '6'); }
  });

  it('policy drafts preserve published versions and cannot edit them after publication', async () => {
    const v = ok(await api('POST', '/admin/policy-versions', 'admin', {versionLabel:'PDP-TEST-version'}), 201).version_id;
    try {
      const d = ok(await api('GET', `/policy?version=${v}`, 'admin'));
      const section = d.sections[0];
      expect(d.sections).toHaveLength(21);
      ok(await api('PATCH', `/admin/policy-versions/${v}/sections/${section.section_id}`, 'admin', {sectionNo:section.section_no,title:section.title,body:'اختبار سياسة التطوير'}));
      ok(await api('POST', `/admin/policy-versions/${v}/publish`, 'admin', {}));
      fails(await api('PATCH', `/admin/policy-versions/${v}/sections/${section.section_id}`, 'admin', {sectionNo:1,title:'Changed',body:'Changed'}), 'policy.published');
      fails(await api('DELETE', `/admin/policy-versions/${v}`, 'admin'), 'policy.published');
      const published = ok(await api('GET', `/policy?version=${v}`, 'admin'));
      expect(published.sections[0].body).toBe('اختبار سياسة التطوير');
    } finally {
      await q('DELETE FROM pdp_policy_section WHERE version_id=?', [v]);
      await q('DELETE FROM pdp_policy_version WHERE version_id=?', [v]);
    }
  });

  it.skipIf(!process.env.PDP_IMPORT_DIR)('the import is idempotent: a re-run creates nothing', async () => {
    const r = ok(await api('POST', '/import?source=folder', 'admin'));
    const createdRows = Object.values(r.tables as Record<string, { created: number }>).reduce((s, c) => s + c.created, 0);
    expect(createdRows).toBe(0);
    expect(r.tree).toMatchObject({ families: 8, subfamilies: 20, products: 55 });
    expect((await api('POST', '/import?source=folder', 'tm')).status).toBe(403);
  });
});
