import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NO_FILTERS } from '../rules';

/**
 * Product Development Plan tracker against a REAL test database (opt-in, writes, cleans up after itself):
 *
 *   PDT_TEST_DB=1 DB_HOST=127.0.0.1 DB_PORT=33309 DB_NAME=powerbi_data DB_USER=... DB_PASSWORD=... \
 *     npx vitest run -c vitest.pdt-db.config.ts
 *
 * Needs migrations 0080 + 0081 on the local TEST stack (test-stack-start.cmd). Refuses any port but 33309, so it can never write
 * to the production copy on 3306. Everything it creates is named "PDT-TEST ..." and is hard-deleted at the end.
 */
const RUN = process.env.PDT_TEST_DB === '1' && process.env.DB_HOST === '127.0.0.1' && process.env.DB_PORT === '33309';

const TODAY = '2026-11-18';
const NAME = 'PDT-TEST Night cream';

describe.skipIf(!RUN)('pdt tracker on the test database', () => {
  let svc: typeof import('../trackerService');
  let pool: typeof import('../../../db/pool').pool;
  let uid = 0;
  let code = '';
  let familyId = 0;

  const err = async (p: Promise<unknown>) => p.then(() => null, (e: { code?: string }) => e.code ?? String(e));

  beforeAll(async () => {
    svc = await import('../trackerService');
    ({ pool } = await import('../../../db/pool'));
    const [u] = (await pool.query('SELECT MIN(user_id) AS id FROM app_user')) as unknown as [{ id: number }[]];
    uid = u[0].id;
    const [c] = (await pool.query("SELECT value_id FROM pdt_dropdown_value WHERE list_key = 'family' ORDER BY sort_order LIMIT 1")) as unknown as [{ value_id: number }[]];
    familyId = c[0].value_id;
  });

  afterAll(async () => {
    if (!pool) return;
    const [r] = (await pool.query("SELECT product_id, code FROM pdt_product WHERE name LIKE 'PDT-TEST%'")) as unknown as [{ product_id: number; code: string }[]];
    for (const p of r) {
      await pool.query('DELETE FROM pdt_blocker WHERE product_id = ?', [p.product_id]);
      await pool.query('DELETE FROM pdt_status_update WHERE product_id = ?', [p.product_id]);
      await pool.query('DELETE FROM pdt_stage_history WHERE product_id = ?', [p.product_id]);
      await pool.query('DELETE FROM pdt_product WHERE product_id = ?', [p.product_id]);
      await pool.query("DELETE FROM audit_log WHERE entity_type = 'pdt_product' AND entity_id = ?", [p.code]);
    }
    await pool.end();
  });

  it('creates a product with a code and a first history row', async () => {
    const out = await svc.createProduct({ name: NAME, familyId, ownerName: 'Test Owner', priority: 'HIGH', stage: 'DEVELOPMENT', health: 'ON_TRACK', readinessPct: 40, targetLaunch: '2027-03-01' }, uid, TODAY);
    code = out.product.code;
    expect(code).toMatch(/^XT-\d{3,}$/);
    expect(out.history).toHaveLength(1);
    expect(out.history[0]).toMatchObject({ fromStage: null, toStage: 'DEVELOPMENT', current: true });
    expect(out.audit.updatedAt).toBeTruthy();
  });

  it('refuses a duplicate active name, any case', async () => {
    expect(await err(svc.createProduct({ name: NAME.toUpperCase(), familyId, ownerName: 'X', stage: 'IDEA' }, uid, TODAY))).toBe('product.nameTaken');
  });

  it('changes the stage only through the action, with a comment, and records the history', async () => {
    expect(await err(svc.updateProduct(code, { stage: 'TESTING' }, uid, TODAY))).toBe('product.stageViaAction');
    expect(await err(svc.changeStage(code, { toStage: 'TESTING' }, uid, TODAY))).toBe('comment.required');
    const out = await svc.changeStage(code, { toStage: 'TESTING', comment: 'Formula frozen' }, uid, '2026-11-20');
    expect(out.product.stage).toBe('TESTING');
    expect(out.history.map((h) => [h.fromStage, h.toStage, h.comment])).toEqual([[null, 'DEVELOPMENT', 'Product created'], ['DEVELOPMENT', 'TESTING', 'Formula frozen']]);
    expect(out.history[0].days).toBe(2);
  });

  it('forces Blocked while a Blocker is open, and asks for the health when the last one is resolved', async () => {
    const created = await svc.createBlocker({ productCode: code, kind: 'BLOCKER', title: 'PDT-TEST lab', requiredAction: 'Chase lab', ownerName: 'Test Owner', dueDate: '2026-11-25' }, uid, TODAY);
    expect(created.healthForced).toBe(true);
    expect((await svc.getProduct(code, TODAY)).product.health).toBe('BLOCKED');

    expect(await err(svc.updateProduct(code, { health: 'ON_TRACK' }, uid, TODAY))).toBe('health.blockedByBlocker');
    expect(await err(svc.postUpdate(code, { health: 'AT_RISK', readinessPct: 50, summary: 'x' }, uid, TODAY))).toBe('health.blockedByBlocker');

    // A decision never changes health.
    const decision = await svc.createBlocker({ productCode: code, kind: 'DECISION', title: 'PDT-TEST pick supplier', requiredAction: 'Decide', ownerName: 'Test Owner', dueDate: '2026-11-30' }, uid, TODAY);
    expect(decision.healthForced).toBe(false);

    expect(await err(svc.resolveBlocker(created.blocker.blockerId, { status: 'RESOLVED' }, uid, TODAY))).toBe('resolutionNote.required');
    const resolved = await svc.resolveBlocker(created.blocker.blockerId, { status: 'RESOLVED', resolutionNote: 'Report received' }, uid, TODAY);
    expect(resolved).toMatchObject({ healthForced: false, healthReviewRequired: true });
    const p = (await svc.getProduct(code, TODAY)).product;
    expect([p.health, p.healthReviewRequired]).toEqual(['BLOCKED', true]);

    // Blocked without a Blocker is not allowed; choosing another health clears the review.
    expect(await err(svc.updateProduct(code, { health: 'BLOCKED' }, uid, TODAY))).toBe('health.blockedNeedsBlocker');
    const after = (await svc.updateProduct(code, { health: 'AT_RISK' }, uid, TODAY)).product;
    expect([after.health, after.healthReviewRequired]).toEqual(['AT_RISK', false]);
  });

  it('copies the latest status update onto the product and clears the stale clock', async () => {
    const out = await svc.postUpdate(code, { updateDate: TODAY, health: 'ON_TRACK', readinessPct: 60, summary: 'Stability passed', nextStep: 'Pack test', nextStepDue: '2026-11-19' }, uid, TODAY);
    expect(out.product).toMatchObject({ health: 'ON_TRACK', readinessPct: 60, lastUpdateAt: TODAY, stale: false });
    expect(await err(svc.postUpdate(code, { health: 'ON_TRACK', readinessPct: 100, summary: 'x' }, uid, TODAY))).toBe('product.readinessFull');

    // The next step shows on the follow-up board once overdue, and leaves it when marked done.
    const board = await svc.getFollowup({ ...NO_FILTERS, search: 'PDT-TEST' }, '2026-11-21');
    expect(board.items.map((i) => i.kind)).toContain('NEXT_STEP_OVERDUE');
    await svc.editUpdate(out.updates[0].updateId as number, { nextStepDone: true }, uid, TODAY);
    const after = await svc.getFollowup({ ...NO_FILTERS, search: 'PDT-TEST' }, '2026-11-21');
    expect(after.items.map((i) => i.kind)).not.toContain('NEXT_STEP_OVERDUE');
  });

  it('soft-deletes: the product leaves every list but keeps its row', async () => {
    await svc.deleteProduct(code, uid);
    expect((await svc.loadProducts()).some((p) => p.code === code)).toBe(false);
    const [r] = (await pool.query('SELECT deleted_at FROM pdt_product WHERE code = ?', [code])) as unknown as [{ deleted_at: unknown }[]];
    expect(r[0].deleted_at).toBeTruthy();
  });
});
