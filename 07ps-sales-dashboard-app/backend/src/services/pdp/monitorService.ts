import { DateTime } from 'luxon';
import { pool } from '../../db/pool';
import { PdpError, notFound } from './errors';
import { exec, inTransaction, isoDate, isoDateTime, one, rows } from './db';
import {
  applicableSignoffs, computeKpis, fastTrackOverdue, inFreeze, missingRoles, projectMix, quarterOf, quarterRange,
  type Classification, type DecisionRow, type Gate, type ProjectState,
} from './rules';
import { approverWarnings, assertDropdown, getSettings, listGateRules, listKpiTargets, listRoadmapYears } from './configService';
import { assertTikaCustomer, getProductRow, getTree, listProducts } from './treeService';
import { odooConfiguredBaseUrl, odooFormUrl } from '../../lib/odooLinks';
import { bool, businessDate, date, id, int, oneOf, optId, text, today } from './validate';

/**
 * Monitoring: the overview (KPI tiles, capacity, funnel, alerts, portfolio), the roadmap, launch tracking with
 * post-launch TIKA sales, and customer feedback with its follow-up. TIKA rows only, everywhere.
 */

/** "Open in Odoo" link of an Odoo customer (res.partner), opened in TIKA's company; null for a typed-in name. */
export function customerUrl(ck: number, customerKey: unknown): string | null {
  return odooFormUrl(odooConfiguredBaseUrl(), 'res.partner', customerKey === null || customerKey === undefined ? null : Number(customerKey), ck);
}

// ---------------------------------------------------------------------------- overview

export async function getOverview(ck: number, quarter: string | undefined, viewer: { userId: number; roles: string[] }) {
  const now = today();
  const q = quarter || quarterOf(now);
  const { from, to } = quarterRange(q);
  const settings = await getSettings(ck);

  const [targets, launchRows, trialRows, labRows, errRows, projects, decisions, rules, warnings, products, families] = await Promise.all([
    listKpiTargets(ck),
    rows<Record<string, unknown>>(pool, `SELECT project_id, classification, launched_at, submitted_at, target_launch_date FROM pdp_project
                                          WHERE company_key = ? AND deleted_at IS NULL AND launched_at IS NOT NULL`, [ck]),
    rows<Record<string, unknown>>(pool, `SELECT t.project_id, t.trial_date, t.passed FROM pdp_field_trial t JOIN pdp_project p ON p.project_id = t.project_id
                                          WHERE t.company_key = ? AND t.deleted_at IS NULL AND p.deleted_at IS NULL`, [ck]),
    rows<Record<string, unknown>>(pool, `SELECT t.project_id, t.trial_no, t.test_date, t.passed FROM pdp_lab_test t JOIN pdp_project p ON p.project_id = t.project_id
                                          WHERE t.company_key = ? AND t.deleted_at IS NULL AND p.deleted_at IS NULL`, [ck]),
    rows<Record<string, unknown>>(pool, `SELECT e.project_id, e.severity, e.found_date FROM pdp_documentation_error e JOIN pdp_project p ON p.project_id = e.project_id
                                          WHERE e.company_key = ? AND e.deleted_at IS NULL AND p.deleted_at IS NULL`, [ck]),
    rows<Record<string, unknown>>(pool,
      `SELECT p.project_id, p.code, p.title, p.classification, p.state, p.current_gate, p.gate_round, p.fast_track, p.submitted_at, p.target_launch_date,
              (SELECT COUNT(*) FROM pdp_checklist_template t LEFT JOIN pdp_project_checklist c ON c.template_id = t.template_id AND c.project_id = p.project_id
                WHERE t.company_key = p.company_key AND t.gate = 'G1' AND t.required = 1 AND t.is_active = 1 AND (c.item_id IS NULL OR c.status <> 'done')) AS feas_open
         FROM pdp_project p WHERE p.company_key = ? AND p.deleted_at IS NULL`, [ck]),
    rows<Record<string, unknown>>(pool, `SELECT d.project_id, d.gate, d.gate_round, d.decision, d.approver_role_code, d.approver_user_id FROM pdp_gate_decision d
                                          JOIN pdp_project p ON p.project_id = d.project_id AND d.gate = p.current_gate AND d.gate_round = p.gate_round
                                         WHERE d.company_key = ?`, [ck]),
    listGateRules(ck),
    approverWarnings(ck),
    listProducts(ck),
    rows<{ family_id: number; name: string; subfamily_id: number }>(pool,
      `SELECT f.family_id, f.name, s.subfamily_id FROM pdp_product_family f JOIN pdp_product_subfamily s ON s.family_id = f.family_id
        WHERE f.company_key = ? AND f.deleted_at IS NULL AND s.deleted_at IS NULL ORDER BY f.sort_order, f.name`, [ck]),
  ]);

  const kpis = computeKpis({
    launches: launchRows.map((l) => ({
      projectId: Number(l.project_id), classification: l.classification as Classification, launchedAt: businessDate(new Date(isoDateTime(l.launched_at) as string)),
      submittedAt: l.submitted_at ? businessDate(new Date(isoDateTime(l.submitted_at) as string)) : null, targetLaunchDate: isoDate(l.target_launch_date),
    })),
    fieldTrials: trialRows.map((t) => ({ projectId: Number(t.project_id), date: isoDate(t.trial_date) as string, passed: Boolean(t.passed) })),
    labTests: labRows.map((t) => ({ projectId: Number(t.project_id), trialNo: Number(t.trial_no), date: isoDate(t.test_date) as string, passed: Boolean(t.passed) })),
    docErrors: errRows.map((e) => ({ projectId: Number(e.project_id), severity: e.severity as 'critical' | 'minor', foundDate: isoDate(e.found_date) as string })),
  }, targets, from, to);

  const active = projects.filter((p) => p.state === 'active');
  const onHold = projects.filter((p) => p.state === 'on_hold');
  const capacity = {
    active: active.length, onHold: onHold.length, max: settings.max_concurrent_projects,
    mix: projectMix(active.map((p) => p.classification as Classification), { planned: settings.mix_target_planned, unplanned: settings.mix_target_unplanned, innovation: settings.mix_target_innovation }),
    freezeActive: inFreeze(now, settings.freeze_from_mmdd, settings.freeze_to_mmdd),
    freeze: { from: settings.freeze_from_mmdd, to: settings.freeze_to_mmdd },
  };

  const funnelStates: Record<string, number> = { G0: 0, G1: 0, G2: 0, G3: 0, G4: 0, G5: 0, launched: 0, closed: 0 };
  for (const p of projects) {
    if (p.state === 'launched') funnelStates.launched += 1;
    else if (p.state === 'closed') funnelStates.closed += 1;
    else if (p.state !== 'rejected') funnelStates[String(p.current_gate)] += 1;
  }

  // Alerts
  const nowDate = new Date();
  const alerts: { kind: string; message: string; projectCode?: string; productId?: number }[] = [];
  for (const g of warnings) alerts.push({ kind: 'no_approver', message: `No approver assigned for ${g}` });
  for (const p of projects) {
    const st = p.state as ProjectState;
    if (fastTrackOverdue({ fastTrack: Boolean(p.fast_track), submittedAt: isoDateTime(p.submitted_at), currentGate: p.current_gate as Gate, state: st }, Number(p.feas_open) === 0, settings.fast_track_feasibility_hours, nowDate)) {
      alerts.push({ kind: 'fast_track', message: `${p.code}: fast-track feasibility not done within ${settings.fast_track_feasibility_hours} h`, projectCode: String(p.code) });
    }
    const target = isoDate(p.target_launch_date);
    if (target && target < now && ['draft', 'submitted', 'active', 'on_hold'].includes(st)) {
      alerts.push({ kind: 'late_project', message: `${p.code}: past its target launch date (${target})`, projectCode: String(p.code) });
    }
    if (['submitted', 'active'].includes(st) && p.current_gate !== 'G0') {
      const round = toRows(decisions.filter((d) => Number(d.project_id) === Number(p.project_id)));
      // A sign-off still missing one of the viewer's roles (once they approve as that role it is no longer missing).
      const waiting = applicableSignoffs(rules, p.current_gate as Gate, p.classification as Classification)
        .some((s) => missingRoles(s, round).some((r) => viewer.roles.includes(r)));
      if (waiting) alerts.push({ kind: 'my_approval', message: `${p.code}: ${p.current_gate} waits for your decision`, projectCode: String(p.code) });
    }
  }
  for (const pr of products) {
    if (pr.status === 'under_development' && pr.planned_launch_date && pr.planned_launch_date < now) {
      alerts.push({ kind: 'late_product', message: `${pr.name}: planned launch ${pr.planned_launch_date} has passed${pr.launch_date_flexible ? ' (as market needs)' : ''}`, productId: pr.product_id });
    }
  }

  const familyOfSub = new Map(families.map((f) => [f.subfamily_id, f]));
  const byFamily = new Map<string, Record<string, number>>();
  for (const pr of products) {
    const f = familyOfSub.get(pr.subfamily_id);
    const key = f?.name ?? '—';
    const row = byFamily.get(key) ?? { in_market: 0, planned: 0, under_development: 0, discontinued: 0 };
    row[pr.status] += 1;
    byFamily.set(key, row);
  }

  return {
    quarter: q, from, to,
    kpis,
    capacity,
    funnel: funnelStates,
    alerts,
    portfolio: {
      byStatus: ['in_market', 'planned', 'under_development', 'discontinued'].map((s) => ({ status: s, count: products.filter((p) => p.status === s).length })),
      byFamily: [...byFamily.entries()].map(([family, counts]) => ({ family, ...counts })),
    },
  };
}

function toRows(ds: Record<string, unknown>[]): DecisionRow[] {
  return ds.map((d) => ({ gate: String(d.gate), round: Number(d.gate_round), decision: d.decision as DecisionRow['decision'], roleCode: String(d.approver_role_code), userId: d.approver_user_id === null ? null : Number(d.approver_user_id) }));
}

// ---------------------------------------------------------------------------- roadmap

/** Products placed by actual (in market) or planned launch date, per quarter; late = planned date passed, not launched. */
export async function getRoadmap(ck: number) {
  const now = today();
  const [years, tree] = await Promise.all([listRoadmapYears(ck), getTree(ck)]);
  const items = tree.flatMap((b) => b.families.flatMap((f) => f.subfamilies.flatMap((s) => s.products.map((p) => {
    const when = p.status === 'in_market' ? p.actual_launch_date ?? p.planned_launch_date : p.planned_launch_date;
    return {
      product_id: p.product_id, name: p.name, status: p.status, family_id: f.family_id, family: f.name, subfamily: s.name,
      date: when, quarter: when ? quarterOf(when) : null, flexible: p.launch_date_flexible,
      late: p.status !== 'in_market' && p.status !== 'discontinued' && !!p.planned_launch_date && p.planned_launch_date < now,
    };
  }))));
  return { years, items, today: now };
}

// ---------------------------------------------------------------------------- product side panel

export async function getProductPanel(ck: number, productId: number) {
  const product = await getProductRow(ck, productId);
  const [projects, launch, feedback, hist] = await Promise.all([
    rows<Record<string, unknown>>(pool, 'SELECT code, title, classification, current_gate, state, target_launch_date FROM pdp_project WHERE company_key = ? AND product_id = ? AND deleted_at IS NULL ORDER BY created_at DESC', [ck, productId]),
    one<Record<string, unknown>>(pool, 'SELECT * FROM pdp_launch WHERE company_key = ? AND product_id = ? AND deleted_at IS NULL', [ck, productId]),
    rows<Record<string, unknown>>(pool, 'SELECT feedback_id, feedback_date, rating, followup_status, customer_key, COALESCE(customer_name, (SELECT customer FROM dim_customer c WHERE c.CustomerKey = f.customer_key)) AS customer FROM pdp_customer_feedback f WHERE company_key = ? AND product_id = ? AND deleted_at IS NULL ORDER BY feedback_date DESC LIMIT 20', [ck, productId]),
    rows<Record<string, unknown>>(pool, 'SELECT h.field, h.from_value, h.to_value, h.reason, h.changed_at, u.display_name AS changed_by_name FROM pdp_product_history h LEFT JOIN app_user u ON u.user_id = h.changed_by WHERE h.product_id = ? ORDER BY h.changed_at DESC, h.history_id DESC LIMIT 30', [productId]),
  ]);
  const ratings = feedback.map((f) => Number(f.rating));
  return {
    product,
    projects: projects.map((p) => ({ ...p, target_launch_date: isoDate(p.target_launch_date) })),
    launch: launch ? { ...launch, launch_date: isoDate(launch.launch_date) } : null,
    feedback: feedback.map((f) => ({ ...f, feedback_date: isoDate(f.feedback_date), customer_odoo_url: customerUrl(ck, f.customer_key) })),
    avgRating: ratings.length ? Math.round((ratings.reduce((s, r) => s + r, 0) / ratings.length) * 10) / 10 : null,
    history: hist.map((h) => ({ ...h, changed_at: isoDateTime(h.changed_at) })),
  };
}

// ---------------------------------------------------------------------------- launches

/** Launch records plus "launching" projects (at G4/G5) with their readiness checklist. */
export async function listLaunches(ck: number) {
  const r = await rows<Record<string, unknown>>(pool,
    `SELECT l.*, p.name AS product_name, p.status AS product_status, p.dim_product_key, p.actual_launch_date, fam.name AS family,
            pj.code AS project_code,
            (SELECT COUNT(*) FROM pdp_checklist_template t LEFT JOIN pdp_project_checklist c ON c.template_id = t.template_id AND c.project_id = l.project_id
              WHERE t.company_key = l.company_key AND t.list_code = 'DOCUMENTATION' AND t.required = 1 AND t.is_active = 1 AND (c.item_id IS NULL OR c.status <> 'done')) AS docs_open,
            (SELECT ROUND(AVG(f.rating), 1) FROM pdp_customer_feedback f WHERE f.product_id = l.product_id AND f.deleted_at IS NULL) AS avg_rating
       FROM pdp_launch l JOIN pdp_product p ON p.product_id = l.product_id
       JOIN pdp_product_subfamily s ON s.subfamily_id = p.subfamily_id JOIN pdp_product_family fam ON fam.family_id = s.family_id
       LEFT JOIN pdp_project pj ON pj.project_id = l.project_id
      WHERE l.company_key = ? AND l.deleted_at IS NULL ORDER BY COALESCE(l.launch_date, '9999-12-31') DESC`, [ck]);
  const upcoming = await rows<Record<string, unknown>>(pool,
    `SELECT pj.code, pj.title, pj.current_gate, pj.target_launch_date, p.product_id, p.name AS product_name,
            (SELECT COUNT(*) FROM pdp_checklist_template t LEFT JOIN pdp_project_checklist c ON c.template_id = t.template_id AND c.project_id = pj.project_id
              WHERE t.company_key = pj.company_key AND t.list_code = 'DOCUMENTATION' AND t.required = 1 AND t.is_active = 1 AND (c.item_id IS NULL OR c.status <> 'done')) AS docs_open
       FROM pdp_project pj JOIN pdp_product p ON p.product_id = pj.product_id
      WHERE pj.company_key = ? AND pj.deleted_at IS NULL AND pj.state = 'active' AND pj.current_gate IN ('G4', 'G5')
        AND NOT EXISTS (SELECT 1 FROM pdp_launch l WHERE l.product_id = p.product_id AND l.deleted_at IS NULL)
      ORDER BY pj.target_launch_date`, [ck]);
  return {
    launches: r.map((l) => ({
      product_odoo_url: odooFormUrl(odooConfiguredBaseUrl(), 'product.product', l.dim_product_key === null ? null : Number(l.dim_product_key), ck),
      ...l, launch_date: isoDate(l.launch_date), actual_launch_date: isoDate(l.actual_launch_date),
      readiness: { documentation: l.project_id ? Number(l.docs_open) === 0 : null, training: Boolean(l.training_done), communication: Boolean(l.communication_done), exco: l.exco_decision_id !== null },
      avg_rating: l.avg_rating === null ? null : Number(l.avg_rating),
    })),
    upcoming: upcoming.map((u) => ({ ...u, target_launch_date: isoDate(u.target_launch_date), documentation: Number(u.docs_open) === 0 })),
  };
}

/** Readiness record before the launch (e.g. while the project is at G4/G5); the G5 approval completes it. */
export async function createLaunch(ck: number, input: Record<string, unknown>, actor: number) {
  const productId = id(input.productId, 'productId', 'Product');
  await getProductRow(ck, productId);
  if (await one(pool, 'SELECT 1 FROM pdp_launch WHERE product_id = ? AND deleted_at IS NULL', [productId])) throw new PdpError('launch.exists', 'This product already has a launch record.', 'productId', 409);
  const project = await one<{ project_id: number }>(pool, "SELECT project_id FROM pdp_project WHERE company_key = ? AND product_id = ? AND deleted_at IS NULL AND state IN ('active', 'launched') ORDER BY created_at DESC LIMIT 1", [ck, productId]);
  const r = await exec(pool, "INSERT INTO pdp_launch (company_key, product_id, project_id, launch_date, status, notes, created_by, updated_by) VALUES (?, ?, ?, ?, 'planned', ?, ?, ?)",
    [ck, productId, project?.project_id ?? null, date(input.launchDate, 'launchDate', { label: 'Launch date' }), text(input.notes, 'notes', { max: 5000 }), actor, actor]);
  return { launch_id: r.insertId };
}

export async function updateLaunch(ck: number, launchId: number, input: Record<string, unknown>, actor: number) {
  const cur = await one<Record<string, unknown>>(pool, 'SELECT * FROM pdp_launch WHERE company_key = ? AND launch_id = ? AND deleted_at IS NULL', [ck, launchId]);
  if (!cur) throw notFound('launch');
  const training = input.trainingDone === undefined ? Boolean(cur.training_done) : bool(input.trainingDone);
  const comm = input.communicationDone === undefined ? Boolean(cur.communication_done) : bool(input.communicationDone);
  const launchDate = input.launchDate === undefined ? isoDate(cur.launch_date) : date(input.launchDate, 'launchDate', { label: 'Launch date' });
  const notes = input.notes === undefined ? (cur.notes as string | null) : text(input.notes, 'notes', { max: 5000 });
  // launched only through the EXCO approval (G5); otherwise ready once training and communication are done
  const status = cur.status === 'launched' ? 'launched' : training && comm ? 'ready' : 'planned';
  await exec(pool, 'UPDATE pdp_launch SET training_done = ?, communication_done = ?, launch_date = ?, notes = ?, status = ?, updated_by = ? WHERE launch_id = ?',
    [training, comm, launchDate, notes, status, actor, launchId]);
}

/**
 * Post-launch sales from the warehouse: monthly quantity and revenue of the linked Odoo product for the first 12 months
 * from its launch, TIKA rows only (the same v_sales_product_daily the Product pages read; intercompany shown apart).
 */
export async function launchSales(ck: number, productId: number) {
  const p = await getProductRow(ck, productId);
  const start = p.actual_launch_date;
  if (!p.dim_product_key) return { linked: false, start, months: [] };
  if (!start) return { linked: true, start: null, months: [] };
  const from = DateTime.fromISO(start).startOf('month');
  const to = from.plus({ months: 12 }).minus({ days: 1 });
  const r = await rows<{ ym: string; qty: string; value: string; ic_value: string; uom: string | null }>(pool,
    `SELECT DATE_FORMAT(d.OrderDate, '%Y-%m') AS ym, SUM(d.Qty) AS qty, SUM(d.Value) AS value,
            SUM(CASE WHEN d.IsIntercompany = 1 THEN d.Value ELSE 0 END) AS ic_value, MAX(d.UoM) AS uom
       FROM v_sales_product_daily d
      WHERE d.ProductKey = ? AND d.CompanyKey = ? AND d.OrderDate BETWEEN ? AND ?
      GROUP BY DATE_FORMAT(d.OrderDate, '%Y-%m') ORDER BY ym`,
    [p.dim_product_key, ck, from.toISODate(), to.toISODate()]);
  const byMonth = new Map(r.map((x) => [x.ym, x]));
  const months = Array.from({ length: 12 }, (_, i) => {
    const ym = from.plus({ months: i }).toFormat('yyyy-MM');
    const m = byMonth.get(ym);
    return { month: ym, qty: m ? Number(m.qty) : 0, value: m ? Number(m.value) : 0, intercompanyValue: m ? Number(m.ic_value) : 0, uom: m?.uom ?? null };
  });
  return { linked: true, start, odooName: p.odoo_name, odooUrl: p.odoo_url, months };
}

// ---------------------------------------------------------------------------- customer feedback

export const FEEDBACK_STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const;

export async function listFeedback(ck: number, f: { productId?: number; status?: string } = {}) {
  const where = ['f.company_key = ?', 'f.deleted_at IS NULL'];
  const params: unknown[] = [ck];
  if (f.productId) { where.push('f.product_id = ?'); params.push(f.productId); }
  if (f.status) { where.push('f.followup_status = ?'); params.push(f.status); }
  const r = await rows<Record<string, unknown>>(pool,
    `SELECT f.*, p.name AS product_name, p.dim_product_key, ch.label AS channel, ca.label AS category, u.display_name AS owner_name, c.customer AS odoo_customer
       FROM pdp_customer_feedback f JOIN pdp_product p ON p.product_id = f.product_id
       JOIN pdp_dropdown_value ch ON ch.value_id = f.channel_id JOIN pdp_dropdown_value ca ON ca.value_id = f.category_id
       LEFT JOIN app_user u ON u.user_id = f.followup_owner_user_id LEFT JOIN dim_customer c ON c.CustomerKey = f.customer_key
      WHERE ${where.join(' AND ')} ORDER BY f.feedback_date DESC, f.feedback_id DESC`, params);
  const list = r.map((x) => ({ ...x, customer_odoo_url: customerUrl(ck, x.customer_key), product_odoo_url: odooFormUrl(odooConfiguredBaseUrl(), 'product.product', x.dim_product_key === null || x.dim_product_key === undefined ? null : Number(x.dim_product_key), ck), feedback_date: isoDate(x.feedback_date), due_date: isoDate(x.due_date), resolved_at: isoDateTime(x.resolved_at), created_at: isoDateTime(x.created_at), updated_at: isoDateTime(x.updated_at) }));
  const byProduct = new Map<string, { product_id: number; product: string; n: number; sum: number }>();
  for (const x of r) {
    const k = String(x.product_id);
    const cur = byProduct.get(k) ?? { product_id: Number(x.product_id), product: String(x.product_name), n: 0, sum: 0 };
    cur.n += 1;
    cur.sum += Number(x.rating);
    byProduct.set(k, cur);
  }
  return {
    feedback: list,
    averages: [...byProduct.values()].map((v) => ({ product_id: v.product_id, product: v.product, count: v.n, avgRating: Math.round((v.sum / v.n) * 10) / 10 })).sort((a, b) => a.product.localeCompare(b.product)),
    openFollowups: r.filter((x) => x.followup_status === 'open' || x.followup_status === 'in_progress').length,
  };
}

async function feedbackHistory(conn: Parameters<typeof exec>[0], ck: number, feedbackId: number, field: string, from: unknown, to: unknown, comment: string | null, actor: number) {
  const s = (v: unknown) => (v === null || v === undefined ? null : String(v).slice(0, 500));
  await exec(conn, 'INSERT INTO pdp_feedback_history (company_key, feedback_id, field, from_value, to_value, comment, changed_by) VALUES (?, ?, ?, ?, ?, ?, ?)', [ck, feedbackId, field, s(from), s(to), comment, actor]);
}

async function parseFeedback(ck: number, input: Record<string, unknown>) {
  const productId = id(input.productId, 'productId', 'Product');
  await getProductRow(ck, productId);
  const customerKey = await assertTikaCustomer(ck, input.customerKey);
  const customerName = text(input.customerName, 'customerName', { max: 200, label: 'Customer' });
  if (!customerKey && !customerName) throw new PdpError('field.required', 'Pick the customer or type their name.', 'customerName');
  return {
    productId, customerKey, customerName,
    feedbackDate: date(input.feedbackDate, 'feedbackDate', { required: true, label: 'Date' }),
    channelId: await assertDropdown(ck, input.channelId, 'feedback_channel', 'channelId', 'Channel'),
    rating: int(input.rating, 'rating', { min: 1, max: 5, required: true, label: 'Rating' }) as number,
    categoryId: await assertDropdown(ck, input.categoryId, 'feedback_category', 'categoryId', 'Category'),
    comment: text(input.comment, 'comment', { max: 5000 }),
    owner: optId(input.followupOwnerUserId, 'followupOwnerUserId'),
    dueDate: date(input.dueDate, 'dueDate', { label: 'Due date' }),
  };
}

export async function createFeedback(ck: number, input: Record<string, unknown>, actor: number) {
  const v = await parseFeedback(ck, input);
  return inTransaction(async (conn) => {
    const r = await exec(conn,
      `INSERT INTO pdp_customer_feedback (company_key, product_id, customer_key, customer_name, feedback_date, channel_id, rating, category_id, comment, followup_owner_user_id, due_date, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ck, v.productId, v.customerKey, v.customerName, v.feedbackDate, v.channelId, v.rating, v.categoryId, v.comment, v.owner, v.dueDate, actor, actor]);
    await feedbackHistory(conn, ck, r.insertId, 'created', null, `rating ${v.rating}`, null, actor);
    return { feedback_id: r.insertId };
  });
}

/** Edit the feedback or move its follow-up (open -> in progress -> resolved -> closed); resolving needs a resolution. */
export async function updateFeedback(ck: number, feedbackId: number, input: Record<string, unknown>, actor: number) {
  return inTransaction(async (conn) => {
    const cur = await one<Record<string, unknown>>(conn, 'SELECT * FROM pdp_customer_feedback WHERE company_key = ? AND feedback_id = ? AND deleted_at IS NULL FOR UPDATE', [ck, feedbackId]);
    if (!cur) throw notFound('feedback');
    const status = input.followupStatus === undefined ? String(cur.followup_status) : oneOf(input.followupStatus, FEEDBACK_STATUSES, 'followupStatus', 'Follow-up status');
    const resolution = input.resolution === undefined ? (cur.resolution as string | null) : text(input.resolution, 'resolution', { max: 5000 });
    if ((status === 'resolved' || status === 'closed') && !resolution) throw new PdpError('feedback.resolutionRequired', 'Describe the resolution before resolving.', 'resolution');
    const owner = input.followupOwnerUserId === undefined ? (cur.followup_owner_user_id as number | null) : optId(input.followupOwnerUserId, 'followupOwnerUserId');
    const dueDate = input.dueDate === undefined ? isoDate(cur.due_date) : date(input.dueDate, 'dueDate', { label: 'Due date' });
    const comment = input.comment === undefined ? (cur.comment as string | null) : text(input.comment, 'comment', { max: 5000 });
    const rating = input.rating === undefined ? Number(cur.rating) : (int(input.rating, 'rating', { min: 1, max: 5, required: true, label: 'Rating' }) as number);
    const resolvedAt = status === 'resolved' || status === 'closed' ? (cur.resolved_at ? 'keep' : 'now') : 'clear';
    await exec(conn,
      `UPDATE pdp_customer_feedback SET followup_status = ?, resolution = ?, followup_owner_user_id = ?, due_date = ?, comment = ?, rating = ?,
              resolved_at = ${resolvedAt === 'now' ? 'CURRENT_TIMESTAMP' : resolvedAt === 'clear' ? 'NULL' : 'resolved_at'}, updated_by = ? WHERE feedback_id = ?`,
      [status, resolution, owner, dueDate, comment, rating, actor, feedbackId]);
    const note = text(input.note, 'note', { max: 2000 });
    if (status !== cur.followup_status) await feedbackHistory(conn, ck, feedbackId, 'followup_status', cur.followup_status, status, note, actor);
    if (owner !== (cur.followup_owner_user_id ?? null)) await feedbackHistory(conn, ck, feedbackId, 'followup_owner', cur.followup_owner_user_id, owner, note, actor);
    if (rating !== Number(cur.rating)) await feedbackHistory(conn, ck, feedbackId, 'rating', cur.rating, rating, note, actor);
    if (resolution !== (cur.resolution ?? null)) await feedbackHistory(conn, ck, feedbackId, 'resolution', null, resolution, note, actor);
  });
}

export async function feedbackHistoryList(ck: number, feedbackId: number) {
  const r = await rows<Record<string, unknown>>(pool,
    `SELECT h.field, h.from_value, h.to_value, h.comment, h.changed_at, u.display_name AS changed_by_name FROM pdp_feedback_history h
       LEFT JOIN app_user u ON u.user_id = h.changed_by WHERE h.company_key = ? AND h.feedback_id = ? ORDER BY h.changed_at DESC, h.history_id DESC`, [ck, feedbackId]);
  return r.map((h) => ({ ...h, changed_at: isoDateTime(h.changed_at) }));
}

export async function deleteFeedback(ck: number, feedbackId: number, actor: number) {
  const r = await exec(pool, 'UPDATE pdp_customer_feedback SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ? WHERE company_key = ? AND feedback_id = ? AND deleted_at IS NULL', [actor, ck, feedbackId]);
  if (r.affectedRows === 0) throw notFound('feedback');
  await feedbackHistory(pool, ck, feedbackId, 'deleted', null, null, null, actor);
}
