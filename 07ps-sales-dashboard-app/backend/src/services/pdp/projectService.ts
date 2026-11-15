import type { PoolConnection } from 'mysql2/promise';
import { pool } from '../../db/pool';
import { PdpError, notFound } from './errors';
import { exec, inTransaction, isoDate, isoDateTime, one, rows, type Db } from './db';
import {
  CLASSIFICATIONS, INNOVATION_CATEGORIES, GATES, afterGateApproved, applicableSignoffs, checkCapacity, checkSubmit, evaluateDecision,
  fastTrackOverdue, gatePreconditionErrors, inFreeze, missingRoles, scoreRound,
  type Classification, type DecisionRow, type Gate, type GateFacts, type ProjectState,
} from './rules';
import {
  assertDropdown, getSettings, listChecklistTemplates, listCriteria, listGateRules, approverWarnings, type PdpSettings,
} from './configService';
import { assertOdooProduct, assertTikaCustomer, createProduct, getProductRow, writeProductHistory } from './treeService';
import { customerUrl } from './monitorService';
import { bool, date, id, int, num, oneOf, optId, reqText, text, today, url } from './validate';

/**
 * R&D projects through the gates G0..G5 and closure (docs/product-development-plan.md section 3). The rules
 * themselves live in rules.ts; this module loads the facts, calls them, and writes the outcome in one transaction
 * with the project row locked (SELECT ... FOR UPDATE), plus an append-only pdp_project_history row for every change.
 */

export interface ProjectRow {
  project_id: number;
  code: string;
  title: string;
  description: string | null;
  product_id: number | null;
  proposed_product_name: string | null;
  proposed_subfamily_id: number | null;
  classification: Classification;
  project_type_id: number;
  innovation_category: string | null;
  requested_by: string;
  request_source_id: number;
  fast_track: boolean;
  owner_user_id: number | null;
  current_gate: Gate;
  gate_round: number;
  state: ProjectState;
  submitted_at: string | null;
  target_launch_date: string | null;
  start_date: string | null;
  launched_at: string | null;
  closed_date: string | null;
  objectives: string | null;
  closure_report: string | null;
  created_at: string | null;
}

function mapProject(r: Record<string, unknown>): ProjectRow {
  return {
    ...(r as unknown as ProjectRow),
    project_id: Number(r.project_id), fast_track: Boolean(r.fast_track), gate_round: Number(r.gate_round),
    product_id: r.product_id === null ? null : Number(r.product_id),
    proposed_subfamily_id: r.proposed_subfamily_id === null ? null : Number(r.proposed_subfamily_id),
    submitted_at: isoDateTime(r.submitted_at), launched_at: isoDateTime(r.launched_at), created_at: isoDateTime(r.created_at),
    target_launch_date: isoDate(r.target_launch_date), start_date: isoDate(r.start_date), closed_date: isoDate(r.closed_date),
  };
}

async function loadProject(db: Db, ck: number, code: string, lock = false): Promise<ProjectRow> {
  const r = await one<Record<string, unknown>>(db, `SELECT * FROM pdp_project WHERE company_key = ? AND code = ? AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [ck, code]);
  if (!r) throw notFound('project');
  return mapProject(r);
}

export async function history(db: Db, ck: number, projectId: number, event: string, from: unknown, to: unknown, comment: string | null, actor: number | null) {
  const s = (v: unknown) => (v === null || v === undefined ? null : String(v).slice(0, 500));
  await exec(db, 'INSERT INTO pdp_project_history (company_key, project_id, event, from_value, to_value, comment, changed_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [ck, projectId, event, s(from), s(to), comment, actor]);
}

/** Who may change a project: closed and rejected projects are read-only except for an admin; a launched one only closes. */
function assertEditable(p: ProjectRow, isAdmin: boolean, what: 'data' | 'close' = 'data') {
  if (isAdmin) return;
  if (p.state === 'closed') throw new PdpError('project.closed', 'This project is closed and read-only.', undefined, 409);
  if (p.state === 'rejected') throw new PdpError('project.rejected', 'This project was rejected and is read-only.', undefined, 409);
  if (p.state === 'launched' && what !== 'close') throw new PdpError('project.launched', 'This project is launched: only its closure can be recorded.', undefined, 409);
}

const gateIndex = (g: Gate) => GATES.indexOf(g);

// ---------------------------------------------------------------------------- list / detail

export interface ProjectFilters {
  classification?: string;
  projectTypeId?: number;
  familyId?: number;
  ownerUserId?: number;
  fastTrack?: boolean;
  state?: string;
  gate?: string;
  search?: string;
  ids?: number[];
}

export async function listProjects(ck: number, f: ProjectFilters = {}) {
  const where = ['p.company_key = ?', 'p.deleted_at IS NULL'];
  const params: unknown[] = [ck];
  if (f.classification) { where.push('p.classification = ?'); params.push(f.classification); }
  if (f.projectTypeId) { where.push('p.project_type_id = ?'); params.push(f.projectTypeId); }
  if (f.familyId) { where.push('COALESCE(sf.family_id, psf.family_id) = ?'); params.push(f.familyId); }
  if (f.ownerUserId) { where.push('p.owner_user_id = ?'); params.push(f.ownerUserId); }
  if (f.fastTrack) where.push('p.fast_track = 1');
  if (f.state) { where.push('p.state = ?'); params.push(f.state); }
  if (f.gate) { where.push('p.current_gate = ?'); params.push(f.gate); }
  if (f.search) { where.push('(p.code LIKE ? OR p.title LIKE ? OR pr.name LIKE ? OR p.proposed_product_name LIKE ?)'); const t = `%${f.search}%`; params.push(t, t, t, t); }
  if (f.ids) { if (f.ids.length === 0) return []; where.push('p.project_id IN (?)'); params.push(f.ids); }
  const r = await rows<Record<string, unknown>>(
    pool,
    `SELECT p.*, pr.name AS product_name, pr.status AS product_status, COALESCE(fam.name, pfam.name) AS family_name,
            COALESCE(fam.family_id, pfam.family_id) AS family_id, dt.label AS project_type, ds.label AS request_source,
            u.display_name AS owner_name,
            (SELECT sr.total FROM pdp_score_round sr WHERE sr.project_id = p.project_id ORDER BY sr.round_no DESC LIMIT 1) AS latest_score
       FROM pdp_project p
       LEFT JOIN pdp_product pr ON pr.product_id = p.product_id
       LEFT JOIN pdp_product_subfamily sf ON sf.subfamily_id = pr.subfamily_id
       LEFT JOIN pdp_product_family fam ON fam.family_id = sf.family_id
       LEFT JOIN pdp_product_subfamily psf ON psf.subfamily_id = p.proposed_subfamily_id
       LEFT JOIN pdp_product_family pfam ON pfam.family_id = psf.family_id
       LEFT JOIN pdp_dropdown_value dt ON dt.value_id = p.project_type_id
       LEFT JOIN pdp_dropdown_value ds ON ds.value_id = p.request_source_id
       LEFT JOIN app_user u ON u.user_id = p.owner_user_id
      WHERE ${where.join(' AND ')}
      ORDER BY p.created_at DESC, p.project_id DESC`,
    params,
  );
  const now = today();
  return r.map((x) => {
    const p = mapProject(x);
    return {
      ...p,
      product_name: (x.product_name as string) ?? null, product_status: (x.product_status as string) ?? null,
      family_name: (x.family_name as string) ?? null, family_id: x.family_id === null ? null : Number(x.family_id),
      project_type: x.project_type as string, request_source: x.request_source as string, owner_name: (x.owner_name as string) ?? null,
      latest_score: x.latest_score === null ? null : Number(x.latest_score),
      late: !!p.target_launch_date && p.target_launch_date < now && ['draft', 'submitted', 'active', 'on_hold'].includes(p.state),
    };
  });
}

async function gateFacts(db: Db, ck: number, p: ProjectRow, settings: PdpSettings, gate: Gate = p.current_gate): Promise<GateFacts> {
  const [score, open, team, lab, trials, batches] = await Promise.all([
    one<{ total: string }>(db, 'SELECT total FROM pdp_score_round WHERE project_id = ? ORDER BY round_no DESC LIMIT 1', [p.project_id]),
    rows<{ label: string }>(db,
      `SELECT t.label FROM pdp_checklist_template t
         LEFT JOIN pdp_project_checklist c ON c.template_id = t.template_id AND c.project_id = ?
        WHERE t.company_key = ? AND t.gate = ? AND t.required = 1 AND t.is_active = 1
          AND (c.item_id IS NULL OR c.status <> 'done'
               OR (t.needs_evidence = 1 AND COALESCE(c.link_url, '') = ''
                   AND NOT EXISTS (SELECT 1 FROM pdp_attachment a WHERE a.owner_type = 'checklist' AND a.owner_id = c.item_id AND a.deleted_at IS NULL)))
        ORDER BY t.sort_order`, [p.project_id, ck, gate]),
    one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM pdp_project_member WHERE project_id = ? AND deleted_at IS NULL', [p.project_id]),
    one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM pdp_lab_test WHERE project_id = ? AND deleted_at IS NULL', [p.project_id]),
    one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM pdp_field_trial WHERE project_id = ? AND deleted_at IS NULL AND ts_lead_user_id IS NOT NULL', [p.project_id]),
    one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM pdp_pilot_batch WHERE project_id = ? AND deleted_at IS NULL
                              AND batch_kg BETWEEN ? AND ? AND qc_ok = 1 AND rnd_ok = 1 AND production_ok = 1`, [p.project_id, settings.pilot_kg_min, settings.pilot_kg_max]),
  ]);
  return {
    latestScore: score ? { total: Number(score.total) } : null,
    minScore: settings.min_score,
    openChecklist: open.map((o) => o.label),
    teamSize: Number(team?.n ?? 0),
    hasObjectives: !!p.objectives?.trim(),
    hasTargetLaunchDate: !!p.target_launch_date,
    labTests: Number(lab?.n ?? 0),
    fieldTrialsWithTsLead: Number(trials?.n ?? 0),
    confirmedBatches: Number(batches?.n ?? 0),
  };
}

async function activeCount(db: Db, ck: number): Promise<number> {
  const r = await one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM pdp_project WHERE company_key = ? AND deleted_at IS NULL AND state = 'active'", [ck]);
  return Number(r?.n ?? 0);
}

async function decisionsOf(db: Db, projectId: number) {
  const r = await rows<Record<string, unknown>>(db,
    `SELECT d.decision_id, d.gate, d.gate_round, d.decision, d.approver_user_id, d.approver_role_code, d.comment, d.override_reason, d.decided_at,
            u.display_name AS approver_name
       FROM pdp_gate_decision d LEFT JOIN app_user u ON u.user_id = d.approver_user_id
      WHERE d.project_id = ? ORDER BY d.decided_at, d.decision_id`, [projectId]);
  return r.map((d) => ({ ...d, decided_at: isoDateTime(d.decided_at) }));
}

function toDecisionRows(ds: Record<string, unknown>[]): DecisionRow[] {
  return ds.map((d) => ({ gate: String(d.gate), round: Number(d.gate_round), decision: d.decision as DecisionRow['decision'], roleCode: String(d.approver_role_code), userId: d.approver_user_id === null ? null : Number(d.approver_user_id) }));
}

/** Everything the project page shows, including what the current gate still needs and who can decide it. */
export async function getProject(ck: number, code: string, viewer: { userId: number; roles: string[] }) {
  const p = await loadProject(pool, ck, code);
  const settings = await getSettings(ck);
  const [product, proposedSub, members, rounds, scores, checklist, attachments, lab, trials, batches, docErrors, decisions, hist, rules, templates, warnings, criteria] = await Promise.all([
    p.product_id ? getProductRow(ck, p.product_id).catch(() => null) : Promise.resolve(null),
    p.proposed_subfamily_id ? one<{ name: string; family: string }>(pool, 'SELECT s.name, f.name AS family FROM pdp_product_subfamily s JOIN pdp_product_family f ON f.family_id = s.family_id WHERE s.subfamily_id = ?', [p.proposed_subfamily_id]) : Promise.resolve(undefined),
    rows(pool, 'SELECT m.member_id, m.user_id, m.role_label, u.display_name FROM pdp_project_member m JOIN app_user u ON u.user_id = m.user_id WHERE m.project_id = ? AND m.deleted_at IS NULL ORDER BY m.member_id', [p.project_id]),
    rows<Record<string, unknown>>(pool, 'SELECT r.round_id, r.round_no, r.total, r.min_score, r.passed, r.scored_at, u.display_name AS scored_by_name FROM pdp_score_round r LEFT JOIN app_user u ON u.user_id = r.scored_by WHERE r.project_id = ? ORDER BY r.round_no DESC', [p.project_id]),
    rows<Record<string, unknown>>(pool, 'SELECT s.round_id, s.criterion_id, s.criterion_name, s.weight, s.score, s.weighted, s.meaning, s.evidence FROM pdp_project_score s JOIN pdp_score_round r ON r.round_id = s.round_id WHERE r.project_id = ? ORDER BY s.score_id', [p.project_id]),
    rows<Record<string, unknown>>(pool,
      `SELECT c.item_id, c.template_id, c.status, c.owner_user_id, u.display_name AS owner_name, c.done_date, c.link_url, c.note, c.updated_at
         FROM pdp_project_checklist c LEFT JOIN app_user u ON u.user_id = c.owner_user_id WHERE c.project_id = ?`, [p.project_id]),
    rows<Record<string, unknown>>(pool,
      `SELECT a.attachment_id, a.owner_type, a.owner_id, a.file_name, a.mime_type, a.size_bytes, a.created_at FROM pdp_attachment a
        WHERE a.company_key = ? AND a.deleted_at IS NULL AND ((a.owner_type = 'checklist' AND a.owner_id IN (SELECT item_id FROM pdp_project_checklist WHERE project_id = ?))
           OR (a.owner_type = 'field_trial' AND a.owner_id IN (SELECT trial_id FROM pdp_field_trial WHERE project_id = ?))
           OR (a.owner_type IN ('project') AND a.owner_id = ?))`, [ck, p.project_id, p.project_id, p.project_id]),
    rows<Record<string, unknown>>(pool, `SELECT t.*, c.label AS competitor, pp.label AS property FROM pdp_lab_test t LEFT JOIN pdp_dropdown_value c ON c.value_id = t.competitor_id
                                          JOIN pdp_dropdown_value pp ON pp.value_id = t.property_id WHERE t.project_id = ? AND t.deleted_at IS NULL ORDER BY t.trial_no, t.test_id`, [p.project_id]),
    rows<Record<string, unknown>>(pool, `SELECT t.*, u.display_name AS ts_lead_name, c.customer AS odoo_customer FROM pdp_field_trial t LEFT JOIN app_user u ON u.user_id = t.ts_lead_user_id
                                          LEFT JOIN dim_customer c ON c.CustomerKey = t.customer_key WHERE t.project_id = ? AND t.deleted_at IS NULL ORDER BY t.trial_date, t.trial_id`, [p.project_id]),
    rows<Record<string, unknown>>(pool, `SELECT b.*, q.display_name AS qc_name, r.display_name AS rnd_name, pr.display_name AS production_name FROM pdp_pilot_batch b
                                          LEFT JOIN app_user q ON q.user_id = b.qc_by LEFT JOIN app_user r ON r.user_id = b.rnd_by LEFT JOIN app_user pr ON pr.user_id = b.production_by
                                         WHERE b.project_id = ? AND b.deleted_at IS NULL ORDER BY b.batch_no`, [p.project_id]),
    rows<Record<string, unknown>>(pool, 'SELECT e.*, u.display_name AS created_by_name FROM pdp_documentation_error e LEFT JOIN app_user u ON u.user_id = e.created_by WHERE e.project_id = ? AND e.deleted_at IS NULL ORDER BY e.found_date DESC', [p.project_id]),
    decisionsOf(pool, p.project_id),
    rows<Record<string, unknown>>(pool, 'SELECT h.history_id, h.event, h.from_value, h.to_value, h.comment, h.changed_at, u.display_name AS changed_by_name FROM pdp_project_history h LEFT JOIN app_user u ON u.user_id = h.changed_by WHERE h.project_id = ? ORDER BY h.changed_at DESC, h.history_id DESC', [p.project_id]),
    listGateRules(ck),
    listChecklistTemplates(ck),
    approverWarnings(ck),
    listCriteria(ck, true),
  ]);

  const fmtDates = (r: Record<string, unknown>, keys: string[]) => {
    const o = { ...r };
    for (const k of keys) o[k] = k.endsWith('_at') ? isoDateTime(r[k]) : isoDate(r[k]);
    return o;
  };
  const facts = await gateFacts(pool, ck, p, settings);
  const roundDecisions = toDecisionRows(decisions as Record<string, unknown>[]).filter((d) => d.gate === p.current_gate && d.round === p.gate_round);
  const signoffs = applicableSignoffs(rules, p.current_gate, p.classification).map((r) => ({
    code: r.code, label: r.label, roles: r.roles, mode: r.mode, missing: missingRoles(r, roundDecisions),
  }));
  const openGate = ['submitted', 'active'].includes(p.state) && p.current_gate !== 'G0';
  const myRoles = viewer.roles.filter((r) => signoffs.some((s) => s.roles.includes(r)) && !roundDecisions.some((d) => d.roleCode === r && d.decision === 'approve'));
  const feasibilityDone = !(await gateFacts(pool, ck, p, settings, 'G1')).openChecklist.length;

  return {
    project: p,
    product,
    proposedSubfamily: proposedSub ?? null,
    members,
    scoreRounds: rounds.map((r) => ({
      ...fmtDates(r, ['scored_at']), total: Number(r.total), passed: Boolean(r.passed),
      scores: scores.filter((s) => s.round_id === r.round_id).map((s) => ({ ...s, weighted: Number(s.weighted) })),
    })),
    criteria,
    checklist: templates.filter((t) => t.is_active).map((t) => {
      const c = checklist.find((x) => Number(x.template_id) === t.template_id);
      return {
        template: t,
        item: c ? { ...fmtDates(c, ['done_date', 'updated_at']), attachments: attachments.filter((a) => a.owner_type === 'checklist' && Number(a.owner_id) === Number(c.item_id)) } : null,
      };
    }),
    attachments: attachments.filter((a) => a.owner_type === 'project'),
    labTests: lab.map((t) => fmtDates(t, ['test_date'])),
    fieldTrials: trials.map((t) => ({ ...fmtDates(t, ['trial_date']), customer_odoo_url: customerUrl(ck, t.customer_key), attachments: attachments.filter((a) => a.owner_type === 'field_trial' && Number(a.owner_id) === Number(t.trial_id)) })),
    pilotBatches: batches.map((b) => fmtDates(b, ['batch_date', 'qc_at', 'rnd_at', 'production_at'])),
    docErrors: docErrors.map((e) => fmtDates(e, ['found_date', 'fixed_date'])),
    decisions,
    history: hist.map((h) => ({ ...h, changed_at: isoDateTime(h.changed_at) })),
    gate: {
      current: p.current_gate,
      round: p.gate_round,
      open: openGate,
      signoffs,
      preconditionErrors: openGate ? gatePreconditionErrors(p.current_gate, facts).map((e) => ({ code: e.code, message: e.message, field: e.field })) : [],
      myRoles: openGate ? myRoles : [],
      noApprover: warnings,
    },
    capacity: { active: await activeCount(pool, ck), max: settings.max_concurrent_projects },
    fastTrack: p.fast_track && p.submitted_at
      ? { deadline: new Date(new Date(p.submitted_at).getTime() + settings.fast_track_feasibility_hours * 3600_000).toISOString(), feasibilityDone,
          overdue: fastTrackOverdue({ fastTrack: p.fast_track, submittedAt: p.submitted_at, currentGate: p.current_gate, state: p.state }, feasibilityDone, settings.fast_track_feasibility_hours, new Date()) }
      : null,
    settings: { min_score: settings.min_score, pilot_kg_min: settings.pilot_kg_min, pilot_kg_max: settings.pilot_kg_max },
  };
}

// ---------------------------------------------------------------------------- create / edit

async function nextCode(conn: PoolConnection, ck: number): Promise<string> {
  const year = Number(today().slice(0, 4));
  await exec(conn, 'INSERT INTO pdp_project_seq (company_key, year, last_no) VALUES (?, ?, LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE last_no = LAST_INSERT_ID(last_no + 1)', [ck, year]);
  const r = await one<{ n: number }>(conn, 'SELECT LAST_INSERT_ID() AS n');
  return `RD-${year}-${String(Number(r?.n)).padStart(3, '0')}`;
}

async function parseTreeLink(ck: number, input: Record<string, unknown>, db: Db) {
  const productId = optId(input.productId, 'productId');
  const proposedName = text(input.proposedProductName, 'proposedProductName', { max: 200, label: 'Proposed product name' });
  const proposedSub = optId(input.proposedSubfamilyId, 'proposedSubfamilyId');
  if (productId) {
    const p = await one<{ status: string }>(db, 'SELECT status FROM pdp_product WHERE company_key = ? AND product_id = ? AND deleted_at IS NULL', [ck, productId]);
    if (!p) throw new PdpError('project.treeLink', 'Pick a product from the Product Tree.', 'productId');
    return { productId, proposedName: null, proposedSub: null };
  }
  if (!proposedName || !proposedSub) throw new PdpError('project.treeLink', 'Link the project to a Product Tree product, or propose a new product with its subfamily.', 'productId');
  if (!(await one(db, 'SELECT 1 FROM pdp_product_subfamily WHERE company_key = ? AND subfamily_id = ? AND deleted_at IS NULL', [ck, proposedSub]))) {
    throw new PdpError('project.treeLink', 'Pick the subfamily for the proposed product.', 'proposedSubfamilyId');
  }
  if (await one(db, 'SELECT 1 FROM pdp_product WHERE company_key = ? AND name = ? AND deleted_at IS NULL', [ck, proposedName])) {
    throw new PdpError('project.proposalExists', `"${proposedName}" is already in the Product Tree: link the project to it.`, 'proposedProductName', 409);
  }
  return { productId: null, proposedName, proposedSub };
}

async function parseProjectFields(ck: number, input: Record<string, unknown>, db: Db) {
  const classification = oneOf(input.classification, CLASSIFICATIONS, 'classification', 'Classification');
  const innovation = classification === 'innovation' ? oneOf(input.innovationCategory, INNOVATION_CATEGORIES, 'innovationCategory', 'Innovation category') : null;
  if (classification !== 'innovation' && input.innovationCategory) throw new PdpError('project.innovationOnly', 'The innovation category is for innovation projects only.', 'innovationCategory');
  const ownerUserId = optId(input.ownerUserId, 'ownerUserId');
  if (ownerUserId && !(await one(db, 'SELECT 1 FROM app_user WHERE user_id = ? AND is_active = 1', [ownerUserId]))) throw new PdpError('field.invalid', 'Pick an active user as owner.', 'ownerUserId');
  return {
    title: reqText(input.title, 'title', 200, 'Title'),
    description: text(input.description, 'description', { max: 10000 }),
    classification,
    innovation,
    projectTypeId: await assertDropdown(ck, input.projectTypeId, 'project_type', 'projectTypeId', 'Project type', db),
    requestedBy: reqText(input.requestedBy, 'requestedBy', 150, 'Requested by'),
    requestSourceId: await assertDropdown(ck, input.requestSourceId, 'request_source', 'requestSourceId', 'Request source', db),
    fastTrack: bool(input.fastTrack),
    ownerUserId,
    targetLaunchDate: date(input.targetLaunchDate, 'targetLaunchDate', { label: 'Target launch date' }),
    objectives: text(input.objectives, 'objectives', { max: 10000 }),
  };
}

/** Rule 1: no project without a Product Tree link (an existing product, or a proposal: name + subfamily). */
export async function createProject(ck: number, input: Record<string, unknown>, actor: number) {
  return inTransaction(async (conn) => {
    const link = await parseTreeLink(ck, input, conn);
    const f = await parseProjectFields(ck, input, conn);
    // Owner defaults to the Technical Manager when exactly one is assigned.
    let owner = f.ownerUserId;
    if (!owner) {
      const tm = await rows<{ user_id: number }>(conn, `SELECT m.user_id FROM pdp_governance_member m JOIN pdp_governance_role r ON r.role_id = m.role_id
                                                       WHERE m.company_key = ? AND r.code = 'TECH_MANAGER' AND m.deleted_at IS NULL`, [ck]);
      if (tm.length === 1) owner = tm[0].user_id;
    }
    const code = await nextCode(conn, ck);
    const r = await exec(conn,
      `INSERT INTO pdp_project (company_key, code, title, description, product_id, proposed_product_name, proposed_subfamily_id, classification, project_type_id,
         innovation_category, requested_by, request_source_id, fast_track, owner_user_id, target_launch_date, objectives, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ck, code, f.title, f.description, link.productId, link.proposedName, link.proposedSub, f.classification, f.projectTypeId, f.innovation,
        f.requestedBy, f.requestSourceId, f.fastTrack, owner, f.targetLaunchDate, f.objectives, actor, actor]);
    // One checklist row per active template, so owners and dates can be set from the start.
    await exec(conn, `INSERT INTO pdp_project_checklist (company_key, project_id, template_id, created_by, updated_by)
                      SELECT company_key, ?, template_id, ?, ? FROM pdp_checklist_template WHERE company_key = ? AND is_active = 1`, [r.insertId, actor, actor, ck]);
    await history(conn, ck, r.insertId, 'created', null, 'draft', null, actor);
    return { code };
  });
}

const EDITABLE: [string, string][] = [
  ['title', 'title'], ['description', 'description'], ['classification', 'classification'], ['innovationCategory', 'innovation_category'],
  ['projectTypeId', 'project_type_id'], ['requestedBy', 'requested_by'], ['requestSourceId', 'request_source_id'], ['fastTrack', 'fast_track'],
  ['ownerUserId', 'owner_user_id'], ['targetLaunchDate', 'target_launch_date'], ['objectives', 'objectives'],
];

export async function updateProject(ck: number, code: string, input: Record<string, unknown>, actor: number, isAdmin: boolean) {
  return inTransaction(async (conn) => {
    const p = await loadProject(conn, ck, code, true);
    assertEditable(p, isAdmin);
    const merged: Record<string, unknown> = {
      title: p.title, description: p.description, classification: p.classification, innovationCategory: p.innovation_category,
      projectTypeId: p.project_type_id, requestedBy: p.requested_by, requestSourceId: p.request_source_id, fastTrack: p.fast_track,
      ownerUserId: p.owner_user_id, targetLaunchDate: p.target_launch_date, objectives: p.objectives, ...input,
    };
    const f = await parseProjectFields(ck, merged, conn);
    const started = gateIndex(p.current_gate) > 1 || p.state !== 'draft' && p.state !== 'submitted';
    if (started && f.classification !== p.classification) throw new PdpError('project.classificationLocked', 'The classification is fixed once the kick-off is approved.', 'classification', 409);
    if (p.state !== 'draft' && f.fastTrack !== p.fast_track) throw new PdpError('project.fastTrackLocked', 'Fast-track is set before the request is submitted.', 'fastTrack', 409);

    let link = { productId: p.product_id, proposedName: p.proposed_product_name, proposedSub: p.proposed_subfamily_id };
    if (input.productId !== undefined || input.proposedProductName !== undefined || input.proposedSubfamilyId !== undefined) {
      if (gateIndex(p.current_gate) > 1) throw new PdpError('project.linkLocked', 'The Product Tree link is fixed once the kick-off is approved.', 'productId', 409);
      link = await parseTreeLink(ck, { productId: p.product_id, proposedProductName: p.proposed_product_name, proposedSubfamilyId: p.proposed_subfamily_id, ...input }, conn);
    }
    const next: Record<string, unknown> = {
      title: f.title, description: f.description, classification: f.classification, innovation_category: f.innovation, project_type_id: f.projectTypeId,
      requested_by: f.requestedBy, request_source_id: f.requestSourceId, fast_track: f.fastTrack, owner_user_id: f.ownerUserId,
      target_launch_date: f.targetLaunchDate, objectives: f.objectives,
    };
    await exec(conn,
      `UPDATE pdp_project SET title = ?, description = ?, classification = ?, innovation_category = ?, project_type_id = ?, requested_by = ?, request_source_id = ?,
              fast_track = ?, owner_user_id = ?, target_launch_date = ?, objectives = ?, product_id = ?, proposed_product_name = ?, proposed_subfamily_id = ?, updated_by = ?
        WHERE project_id = ?`,
      [next.title, next.description, next.classification, next.innovation_category, next.project_type_id, next.requested_by, next.request_source_id,
        next.fast_track, next.owner_user_id, next.target_launch_date, next.objectives, link.productId, link.proposedName, link.proposedSub, actor, p.project_id]);
    const before: Record<string, unknown> = { ...p, fast_track: p.fast_track };
    for (const [, col] of EDITABLE) {
      const a = before[col] ?? null;
      const b = next[col] ?? null;
      if (String(a) !== String(b)) await history(conn, ck, p.project_id, `field:${col}`, a, b, null, actor);
    }
    if (link.productId !== p.product_id || link.proposedName !== p.proposed_product_name) {
      await history(conn, ck, p.project_id, 'field:tree_link', p.product_id ?? p.proposed_product_name, link.productId ?? link.proposedName, null, actor);
    }
    return { code };
  });
}

/** Only a draft can be deleted (soft); after submission a project is rejected or closed instead. */
export async function deleteProject(ck: number, code: string, actor: number) {
  return inTransaction(async (conn) => {
    const p = await loadProject(conn, ck, code, true);
    if (p.state !== 'draft') throw new PdpError('project.notDraft', 'Only a draft can be deleted; reject or close the project instead.', undefined, 409);
    await exec(conn, 'UPDATE pdp_project SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ? WHERE project_id = ?', [actor, p.project_id]);
    await history(conn, ck, p.project_id, 'deleted', 'draft', null, null, actor);
  });
}

// ---------------------------------------------------------------------------- team

export async function addMember(ck: number, code: string, input: Record<string, unknown>, actor: number, isAdmin: boolean) {
  return inTransaction(async (conn) => {
    const p = await loadProject(conn, ck, code, true);
    assertEditable(p, isAdmin);
    const userId = id(input.userId, 'userId', 'User');
    const roleLabel = reqText(input.roleLabel, 'roleLabel', 100, 'Role in the project');
    if (!(await one(conn, 'SELECT 1 FROM app_user WHERE user_id = ? AND is_active = 1', [userId]))) throw new PdpError('field.invalid', 'Pick an active user.', 'userId');
    if (await one(conn, 'SELECT 1 FROM pdp_project_member WHERE project_id = ? AND user_id = ? AND deleted_at IS NULL', [p.project_id, userId])) {
      throw new PdpError('team.duplicate', 'This user is already in the team.', 'userId', 409);
    }
    const r = await exec(conn, 'INSERT INTO pdp_project_member (company_key, project_id, user_id, role_label, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)', [ck, p.project_id, userId, roleLabel, actor, actor]);
    await history(conn, ck, p.project_id, 'team_added', null, `${userId}: ${roleLabel}`, null, actor);
    return { member_id: r.insertId };
  });
}

export async function removeMember(ck: number, code: string, memberId: number, actor: number, isAdmin: boolean) {
  return inTransaction(async (conn) => {
    const p = await loadProject(conn, ck, code, true);
    assertEditable(p, isAdmin);
    const m = await one<{ user_id: number; role_label: string }>(conn, 'SELECT user_id, role_label FROM pdp_project_member WHERE project_id = ? AND member_id = ? AND deleted_at IS NULL', [p.project_id, memberId]);
    if (!m) throw notFound('member');
    await exec(conn, 'UPDATE pdp_project_member SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ? WHERE member_id = ?', [actor, memberId]);
    await history(conn, ck, p.project_id, 'team_removed', `${m.user_id}: ${m.role_label}`, null, null, actor);
  });
}

// ---------------------------------------------------------------------------- submit (G0 -> G1)

export async function submitProject(ck: number, code: string, input: Record<string, unknown>, actor: number, userRoles: string[]) {
  return inTransaction(async (conn) => {
    const p = await loadProject(conn, ck, code, true);
    const s = await getSettings(ck, conn);
    const freeze = inFreeze(today(), s.freeze_from_mmdd, s.freeze_to_mmdd);
    const { freezeOverride } = checkSubmit({ state: p.state, hasTreeLink: !!p.product_id || (!!p.proposed_product_name && !!p.proposed_subfamily_id), classification: p.classification }, freeze, userRoles, input.freezeReason);
    await exec(conn, "UPDATE pdp_project SET state = 'submitted', current_gate = 'G1', gate_round = 1, submitted_at = CURRENT_TIMESTAMP, updated_by = ? WHERE project_id = ?", [actor, p.project_id]);
    await history(conn, ck, p.project_id, 'submitted', 'G0 draft', 'G1 submitted', null, actor);
    if (freezeOverride) await history(conn, ck, p.project_id, 'freeze_override', null, null, String(input.freezeReason).trim(), actor);
    return { code };
  });
}

// ---------------------------------------------------------------------------- scoring (G1)

/** A new scoring round (the latest counts). Allowed until the kick-off (G1) is approved. */
export async function addScoreRound(ck: number, code: string, input: Record<string, unknown>, actor: number, isAdmin: boolean) {
  return inTransaction(async (conn) => {
    const p = await loadProject(conn, ck, code, true);
    assertEditable(p, isAdmin);
    if (!['draft', 'submitted'].includes(p.state)) throw new PdpError('score.locked', 'Scoring is done before the kick-off (G1) is approved.', undefined, 409);
    const s = await getSettings(ck, conn);
    const criteria = await listCriteria(ck, true, conn);
    const { rows: scored, total, passed } = scoreRound(criteria, Array.isArray(input.scores) ? input.scores : [], s.min_score);
    const last = await one<{ n: number }>(conn, 'SELECT COALESCE(MAX(round_no), 0) AS n FROM pdp_score_round WHERE project_id = ?', [p.project_id]);
    const roundNo = Number(last?.n ?? 0) + 1;
    const r = await exec(conn, 'INSERT INTO pdp_score_round (company_key, project_id, round_no, total, min_score, passed, scored_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [ck, p.project_id, roundNo, total, s.min_score, passed, actor]);
    for (const x of scored) {
      await exec(conn, 'INSERT INTO pdp_project_score (company_key, round_id, criterion_id, criterion_name, weight, score, weighted, meaning, evidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [ck, r.insertId, x.criterion_id, x.criterion_name, x.weight, x.score, x.weighted, x.meaning, x.evidence]);
    }
    await history(conn, ck, p.project_id, 'scoring_round', null, `round ${roundNo}: ${total} (${passed ? 'PASS' : `BELOW ${s.min_score}`})`, null, actor);
    return { round_no: roundNo, total, passed };
  });
}

// ---------------------------------------------------------------------------- checklist

export async function updateChecklistItem(ck: number, code: string, itemId: number, input: Record<string, unknown>, actor: number, isAdmin: boolean) {
  return inTransaction(async (conn) => {
    const p = await loadProject(conn, ck, code, true);
    assertEditable(p, isAdmin);
    const cur = await one<{ status: string; done_date: unknown; owner_user_id: number | null; link_url: string | null; note: string | null; label: string }>(conn,
      'SELECT c.status, c.done_date, c.owner_user_id, c.link_url, c.note, t.label FROM pdp_project_checklist c JOIN pdp_checklist_template t ON t.template_id = c.template_id WHERE c.project_id = ? AND c.item_id = ?',
      [p.project_id, itemId]);
    if (!cur) throw notFound('item');
    const status = input.status === undefined ? cur.status : oneOf(input.status, ['open', 'done'] as const, 'status', 'Status');
    let doneDate = input.doneDate === undefined ? isoDate(cur.done_date) : date(input.doneDate, 'doneDate', { label: 'Date done' });
    if (status === 'done' && !doneDate) doneDate = today();
    if (status === 'open') doneDate = null;
    const owner = input.ownerUserId === undefined ? cur.owner_user_id : optId(input.ownerUserId, 'ownerUserId');
    const link = input.linkUrl === undefined ? cur.link_url : url(input.linkUrl, 'linkUrl');
    const note = input.note === undefined ? cur.note : text(input.note, 'note', { max: 5000 });
    await exec(conn, 'UPDATE pdp_project_checklist SET status = ?, done_date = ?, owner_user_id = ?, link_url = ?, note = ?, updated_by = ? WHERE item_id = ?', [status, doneDate, owner, link, note, actor, itemId]);
    if (status !== cur.status) await history(conn, ck, p.project_id, 'checklist', `${cur.label}: ${cur.status}`, `${cur.label}: ${status}`, null, actor);
  });
}

// ---------------------------------------------------------------------------- lab tests / field trials / pilot batches

/** Gate work is recorded from its gate on; fast-track allows G2 (lab) and G3 (field) work in parallel from G1. */
function assertWorkAllowed(p: ProjectRow, gate: 'G2' | 'G3' | 'G4') {
  const reached = gateIndex(p.current_gate) >= gateIndex(gate) && ['active', 'launched', 'on_hold'].includes(p.state);
  const parallel = p.fast_track && gate !== 'G4' && ['submitted', 'active'].includes(p.state) && gateIndex(p.current_gate) >= 1;
  if (!reached && !parallel) {
    throw new PdpError('work.tooEarly', `This is ${gate} work: it can be recorded once the project reaches ${gate}${gate !== 'G4' ? ' (or earlier when fast-tracked)' : ''}.`, undefined, 409);
  }
}

export async function saveLabTest(ck: number, code: string, testId: number | null, input: Record<string, unknown>, actor: number, isAdmin: boolean) {
  return inTransaction(async (conn) => {
    const p = await loadProject(conn, ck, code, true);
    assertEditable(p, isAdmin);
    assertWorkAllowed(p, 'G2');
    const v = {
      trialNo: int(input.trialNo, 'trialNo', { min: 1, max: 999, required: true, label: 'Trial no.' }) as number,
      testDate: date(input.testDate, 'testDate', { required: true, label: 'Test date' }),
      competitorId: input.competitorId ? await assertDropdown(ck, input.competitorId, 'competitor', 'competitorId', 'Benchmark', conn) : null,
      propertyId: await assertDropdown(ck, input.propertyId, 'lab_property', 'propertyId', 'Property', conn),
      target: reqText(input.target, 'target', 100, 'Target'),
      result: reqText(input.result, 'result', 100, 'Result'),
      unit: text(input.unit, 'unit', { max: 30 }),
      passed: input.passed === undefined || input.passed === null || input.passed === '' ? (() => { throw new PdpError('field.required', 'Say whether the test passed.', 'passed'); })() : bool(input.passed),
      notes: text(input.notes, 'notes', { max: 5000 }),
    };
    if (testId) {
      const r = await exec(conn, `UPDATE pdp_lab_test SET trial_no = ?, test_date = ?, competitor_id = ?, property_id = ?, target = ?, result = ?, unit = ?, passed = ?, notes = ?, updated_by = ?
                                   WHERE project_id = ? AND test_id = ? AND deleted_at IS NULL`,
      [v.trialNo, v.testDate, v.competitorId, v.propertyId, v.target, v.result, v.unit, v.passed, v.notes, actor, p.project_id, testId]);
      if (r.affectedRows === 0) throw notFound('test');
      await history(conn, ck, p.project_id, 'lab_test_edited', null, `trial ${v.trialNo}: ${v.passed ? 'pass' : 'fail'}`, null, actor);
      return { test_id: testId };
    }
    const r = await exec(conn, `INSERT INTO pdp_lab_test (company_key, project_id, trial_no, test_date, competitor_id, property_id, target, result, unit, passed, notes, created_by, updated_by)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [ck, p.project_id, v.trialNo, v.testDate, v.competitorId, v.propertyId, v.target, v.result, v.unit, v.passed, v.notes, actor, actor]);
    await history(conn, ck, p.project_id, 'lab_test_added', null, `trial ${v.trialNo}: ${v.passed ? 'pass' : 'fail'}`, null, actor);
    return { test_id: r.insertId };
  });
}

const SCORE_FIELDS = ['scoreSetting', 'scoreBonding', 'scoreFlexibility', 'scoreCoverage', 'scoreSatisfaction'] as const;

export async function saveFieldTrial(ck: number, code: string, trialId: number | null, input: Record<string, unknown>, actor: number, isAdmin: boolean) {
  return inTransaction(async (conn) => {
    const p = await loadProject(conn, ck, code, true);
    assertEditable(p, isAdmin);
    assertWorkAllowed(p, 'G3');
    const scores = SCORE_FIELDS.map((f) => int(input[f], f, { min: 1, max: 5, required: true, label: 'Each evaluation score (1-5)' }) as number);
    const customerKey = await assertTikaCustomer(ck, input.customerKey, conn);
    const customerName = text(input.customerName, 'customerName', { max: 200 });
    const tsLead = id(input.tsLeadUserId, 'tsLeadUserId', 'Technical Support lead');
    const ts = await one(conn, `SELECT 1 FROM pdp_governance_member m JOIN pdp_governance_role r ON r.role_id = m.role_id
                                 WHERE m.company_key = ? AND m.user_id = ? AND r.code = 'TS' AND m.deleted_at IS NULL`, [ck, tsLead]);
    if (!ts) throw new PdpError('trial.tsLead', 'Field validation is led by Technical Support: pick a Technical Support member as lead.', 'tsLeadUserId');
    const v = [date(input.trialDate, 'trialDate', { required: true, label: 'Trial date' }), reqText(input.site, 'site', 200, 'Site'), customerKey, customerName,
      ...scores, input.passed === undefined || input.passed === '' ? (() => { throw new PdpError('field.required', 'Say whether the trial passed overall.', 'passed'); })() : bool(input.passed),
      tsLead, text(input.notes, 'notes', { max: 5000 })];
    if (trialId) {
      const r = await exec(conn, `UPDATE pdp_field_trial SET trial_date = ?, site = ?, customer_key = ?, customer_name = ?, score_setting = ?, score_bonding = ?, score_flexibility = ?,
                                     score_coverage = ?, score_satisfaction = ?, passed = ?, ts_lead_user_id = ?, notes = ?, updated_by = ? WHERE project_id = ? AND trial_id = ? AND deleted_at IS NULL`,
      [...v, actor, p.project_id, trialId]);
      if (r.affectedRows === 0) throw notFound('trial');
      await history(conn, ck, p.project_id, 'field_trial_edited', null, String(v[1]), null, actor);
      return { trial_id: trialId };
    }
    const r = await exec(conn, `INSERT INTO pdp_field_trial (company_key, project_id, trial_date, site, customer_key, customer_name, score_setting, score_bonding, score_flexibility,
                                  score_coverage, score_satisfaction, passed, ts_lead_user_id, notes, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [ck, p.project_id, ...v, actor, actor]);
    await history(conn, ck, p.project_id, 'field_trial_added', null, `${v[1]}: ${v[9] ? 'pass' : 'fail'}`, null, actor);
    return { trial_id: r.insertId };
  });
}

export async function savePilotBatch(ck: number, code: string, batchId: number | null, input: Record<string, unknown>, actor: number, isAdmin: boolean) {
  return inTransaction(async (conn) => {
    const p = await loadProject(conn, ck, code, true);
    assertEditable(p, isAdmin);
    assertWorkAllowed(p, 'G4');
    const s = await getSettings(ck, conn);
    const kg = num(input.batchKg, 'batchKg', { required: true, label: 'Batch size (kg)' }) as number;
    if (kg < s.pilot_kg_min || kg > s.pilot_kg_max) throw new PdpError('batch.kgRange', `Pilot batches are ${s.pilot_kg_min}-${s.pilot_kg_max} kg.`, 'batchKg');
    const batchNo = int(input.batchNo, 'batchNo', { min: 1, max: 999, required: true, label: 'Batch no.' }) as number;
    const batchDate = date(input.batchDate, 'batchDate', { required: true, label: 'Batch date' });
    const notes = text(input.notes, 'notes', { max: 5000 });
    if (batchId) {
      // Changing the weight voids the confirmations: they were given for the old batch.
      const cur = await one<{ batch_kg: string }>(conn, 'SELECT batch_kg FROM pdp_pilot_batch WHERE project_id = ? AND batch_id = ? AND deleted_at IS NULL', [p.project_id, batchId]);
      if (!cur) throw notFound('batch');
      const reset = Number(cur.batch_kg) !== kg;
      await exec(conn, `UPDATE pdp_pilot_batch SET batch_no = ?, batch_date = ?, batch_kg = ?, notes = ?, updated_by = ?
                          ${reset ? ', qc_ok = 0, qc_by = NULL, qc_at = NULL, rnd_ok = 0, rnd_by = NULL, rnd_at = NULL, production_ok = 0, production_by = NULL, production_at = NULL' : ''}
                        WHERE batch_id = ?`, [batchNo, batchDate, kg, notes, actor, batchId]);
      await history(conn, ck, p.project_id, 'pilot_batch_edited', null, `batch ${batchNo}: ${kg} kg${reset ? ' (confirmations reset)' : ''}`, null, actor);
      return { batch_id: batchId };
    }
    const r = await exec(conn, 'INSERT INTO pdp_pilot_batch (company_key, project_id, batch_no, batch_date, batch_kg, notes, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [ck, p.project_id, batchNo, batchDate, kg, notes, actor, actor]);
    await history(conn, ck, p.project_id, 'pilot_batch_added', null, `batch ${batchNo}: ${kg} kg`, null, actor);
    return { batch_id: r.insertId };
  });
}

const CONFIRM: Record<string, { role: string; col: 'qc' | 'rnd' | 'production'; label: string }> = {
  qc: { role: 'QC_QA', col: 'qc', label: 'QC verification' },
  rnd: { role: 'RND', col: 'rnd', label: 'R&D scale approval' },
  production: { role: 'PRODUCTION', col: 'production', label: 'Production manufacturability' },
};

/** QC verifies, R&D approves the scale, Production confirms manufacturability: each by a member of that role. */
export async function confirmPilotBatch(ck: number, code: string, batchId: number, kind: string, actor: number, userRoles: string[], isAdmin: boolean) {
  const c = CONFIRM[kind];
  if (!c) throw new PdpError('batch.confirmKind', 'Unknown confirmation.', 'kind');
  if (!userRoles.includes(c.role)) throw new PdpError('batch.notMember', `${c.label} is given by a ${c.role === 'QC_QA' ? 'QC/QA' : c.role === 'RND' ? 'R&D' : 'Production'} member.`, undefined, 403);
  return inTransaction(async (conn) => {
    const p = await loadProject(conn, ck, code, true);
    assertEditable(p, isAdmin);
    const r = await exec(conn, `UPDATE pdp_pilot_batch SET ${c.col}_ok = 1, ${c.col}_by = ?, ${c.col}_at = CURRENT_TIMESTAMP, updated_by = ? WHERE project_id = ? AND batch_id = ? AND deleted_at IS NULL AND ${c.col}_ok = 0`,
      [actor, actor, p.project_id, batchId]);
    if (r.affectedRows === 0) throw new PdpError('batch.alreadyConfirmed', 'This batch is already confirmed (or does not exist).', undefined, 409);
    await history(conn, ck, p.project_id, 'pilot_confirmed', null, `batch ${batchId}: ${c.label}`, null, actor);
  });
}

/** Documentation errors are entered by QC/QA; the KPI counts the critical ones. */
export async function saveDocError(ck: number, code: string, errorId: number | null, input: Record<string, unknown>, actor: number, userRoles: string[], isAdmin: boolean) {
  if (!userRoles.includes('QC_QA')) throw new PdpError('docError.notQc', 'Documentation errors are entered by QC/QA.', undefined, 403);
  return inTransaction(async (conn) => {
    const p = await loadProject(conn, ck, code, true);
    assertEditable(p, isAdmin, 'close');
    const v = [reqText(input.document, 'document', 150, 'Document'), oneOf(input.severity, ['critical', 'minor'] as const, 'severity', 'Severity'),
      date(input.foundDate, 'foundDate', { required: true, label: 'Date found' }), reqText(input.description, 'description', 5000, 'Description'),
      date(input.fixedDate, 'fixedDate', { label: 'Date fixed' })];
    if (errorId) {
      const r = await exec(conn, 'UPDATE pdp_documentation_error SET document = ?, severity = ?, found_date = ?, description = ?, fixed_date = ?, updated_by = ? WHERE project_id = ? AND error_id = ? AND deleted_at IS NULL',
        [...v, actor, p.project_id, errorId]);
      if (r.affectedRows === 0) throw notFound('error');
      await history(conn, ck, p.project_id, 'doc_error_edited', null, `${v[0]} (${v[1]})`, null, actor);
      return { error_id: errorId };
    }
    const r = await exec(conn, 'INSERT INTO pdp_documentation_error (company_key, project_id, document, severity, found_date, description, fixed_date, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [ck, p.project_id, ...v, actor, actor]);
    await history(conn, ck, p.project_id, 'doc_error_added', null, `${v[0]} (${v[1]})`, null, actor);
    return { error_id: r.insertId };
  });
}

const CHILD_TABLES: Record<string, { table: string; idCol: string; event: string }> = {
  'lab-tests': { table: 'pdp_lab_test', idCol: 'test_id', event: 'lab_test_deleted' },
  'field-trials': { table: 'pdp_field_trial', idCol: 'trial_id', event: 'field_trial_deleted' },
  'pilot-batches': { table: 'pdp_pilot_batch', idCol: 'batch_id', event: 'pilot_batch_deleted' },
  'doc-errors': { table: 'pdp_documentation_error', idCol: 'error_id', event: 'doc_error_deleted' },
};

export async function deleteChild(ck: number, code: string, kind: string, childId: number, actor: number, isAdmin: boolean, userRoles: string[]) {
  const t = CHILD_TABLES[kind];
  if (!t) throw notFound('record');
  if (kind === 'doc-errors' && !userRoles.includes('QC_QA')) throw new PdpError('docError.notQc', 'Documentation errors are entered by QC/QA.', undefined, 403);
  return inTransaction(async (conn) => {
    const p = await loadProject(conn, ck, code, true);
    assertEditable(p, isAdmin);
    const r = await exec(conn, `UPDATE ${t.table} SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ? WHERE project_id = ? AND ${t.idCol} = ? AND deleted_at IS NULL`, [actor, p.project_id, childId]);
    if (r.affectedRows === 0) throw notFound('record');
    await history(conn, ck, p.project_id, t.event, String(childId), null, null, actor);
  });
}

// ---------------------------------------------------------------------------- gate decisions

/**
 * Approve / reject / revise the current gate. On the approval that completes the gate the project moves on:
 *   G1 -> active at G2 (kick-off: start date; a proposed product is created in the tree as `planned`; a planned
 *         product becomes under development); capacity is checked here (CEO/EXCO override with a reason).
 *   G2..G4 -> the next gate.
 *   G5 -> launched: the product goes in_market with today's actual launch date, its launch record is created or
 *         updated, and an optional Odoo product link is set.
 * reject -> rejected (read-only); revise -> same gate, next round (earlier approvals of the gate no longer count).
 */
export async function decide(ck: number, code: string, input: Record<string, unknown>, actor: number, userRoles: string[]) {
  return inTransaction(async (conn) => {
    // Serialize admission across different projects before any consistent reads.
    await rows(conn, "SELECT setting_key FROM pdp_setting WHERE company_key = ? AND setting_key = 'max_concurrent_projects' FOR UPDATE", [ck]);
    const p = await loadProject(conn, ck, code, true);
    const settings = await getSettings(ck, conn);
    const rules = await listGateRules(ck, conn);
    const prior = toDecisionRows(await decisionsOf(conn, p.project_id) as Record<string, unknown>[]).filter((d) => d.gate === p.current_gate && d.round === p.gate_round);
    const outcome = evaluateDecision({
      project: { state: p.state, currentGate: p.current_gate, gateRound: p.gate_round, classification: p.classification },
      decision: input.decision, roleCode: input.roleCode, comment: input.comment, overrideReason: input.overrideReason,
      userRoles, rules, prior, facts: await gateFacts(conn, ck, p, settings), capacity: { active: await activeCount(conn, ck), max: settings.max_concurrent_projects }, userId: actor,
    });
    const comment = typeof input.comment === 'string' && input.comment.trim() ? input.comment.trim() : null;
    const overrideReason = outcome.capacityOverride ? String(input.overrideReason).trim() : null;
    const d = await exec(conn,
      'INSERT INTO pdp_gate_decision (company_key, project_id, gate, gate_round, decision, approver_user_id, approver_role_code, comment, override_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [ck, p.project_id, outcome.gate, p.gate_round, outcome.decision, actor, outcome.roleCode, comment, overrideReason]);
    await history(conn, ck, p.project_id, 'gate_decision', `${outcome.gate} round ${p.gate_round}`, `${outcome.decision} as ${outcome.roleCode}`, comment, actor);

    if (outcome.decision === 'reject') {
      await exec(conn, "UPDATE pdp_project SET state = 'rejected', updated_by = ? WHERE project_id = ?", [actor, p.project_id]);
      await history(conn, ck, p.project_id, 'state', p.state, 'rejected', comment, actor);
      return { state: 'rejected' as ProjectState, currentGate: p.current_gate };
    }
    if (outcome.decision === 'revise') {
      await exec(conn, 'UPDATE pdp_project SET gate_round = gate_round + 1, updated_by = ? WHERE project_id = ?', [actor, p.project_id]);
      await history(conn, ck, p.project_id, 'revise', `${outcome.gate} round ${p.gate_round}`, `${outcome.gate} round ${p.gate_round + 1}`, comment, actor);
      return { state: p.state, currentGate: p.current_gate };
    }
    if (!outcome.completesGate) return { state: p.state, currentGate: p.current_gate };

    const next = afterGateApproved(outcome.gate);
    const businessToday = today();
    if (outcome.capacityOverride) await history(conn, ck, p.project_id, 'capacity_override', null, `${settings.max_concurrent_projects} max`, overrideReason, actor);

    if (outcome.gate === 'G1') {
      let productId = p.product_id;
      if (!productId && p.proposed_product_name && p.proposed_subfamily_id) {
        productId = (await createProduct(ck, { subfamilyId: p.proposed_subfamily_id, name: p.proposed_product_name, status: 'under_development', plannedLaunchDate: p.target_launch_date, reason: `Kick-off of ${p.code}` }, actor, conn, 'PROJECT')).product_id;
        await exec(conn, 'UPDATE pdp_project SET product_id = ? WHERE project_id = ?', [productId, p.project_id]);
        await history(conn, ck, p.project_id, 'product_created', p.proposed_product_name, String(productId), null, actor);
      } else if (productId) {
        const prod = await getProductRow(ck, productId, conn);
        if (prod.status === 'planned') {
          await exec(conn, "UPDATE pdp_product SET status = 'under_development', updated_by = ? WHERE product_id = ?", [actor, productId]);
          await writeProductHistory(conn, ck, productId, 'status', 'planned', 'under_development', `Kick-off of ${p.code}`, actor);
        }
      }
      await exec(conn, 'UPDATE pdp_project SET start_date = ? WHERE project_id = ?', [businessToday, p.project_id]);
    }

    if (outcome.gate === 'G5') {
      const productId = p.product_id as number;
      const prod = await getProductRow(ck, productId, conn);
      const odoo = input.dimProductKey !== undefined && input.dimProductKey !== '' && input.dimProductKey !== null ? await assertOdooProduct(ck, input.dimProductKey, conn) : prod.dim_product_key;
      await exec(conn, "UPDATE pdp_product SET status = 'in_market', actual_launch_date = ?, dim_product_key = ?, updated_by = ? WHERE product_id = ?", [businessToday, odoo, actor, productId]);
      await writeProductHistory(conn, ck, productId, 'status', prod.status, 'in_market', `G5 approval of ${p.code}`, actor);
      await writeProductHistory(conn, ck, productId, 'actual_launch_date', prod.actual_launch_date, businessToday, `G5 approval of ${p.code}`, actor);
      if (odoo !== prod.dim_product_key) await writeProductHistory(conn, ck, productId, 'dim_product_key', prod.dim_product_key, odoo, `Linked at launch (${p.code})`, actor);
      const launch = await one<{ launch_id: number }>(conn, 'SELECT launch_id FROM pdp_launch WHERE product_id = ? AND deleted_at IS NULL', [productId]);
      if (launch) {
        await exec(conn, "UPDATE pdp_launch SET project_id = ?, launch_date = ?, exco_decision_id = ?, status = 'launched', updated_by = ? WHERE launch_id = ?", [p.project_id, businessToday, d.insertId, actor, launch.launch_id]);
      } else {
        await exec(conn, "INSERT INTO pdp_launch (company_key, product_id, project_id, launch_date, exco_decision_id, status, created_by, updated_by) VALUES (?, ?, ?, ?, ?, 'launched', ?, ?)",
          [ck, productId, p.project_id, businessToday, d.insertId, actor, actor]);
      }
      await exec(conn, 'UPDATE pdp_project SET launched_at = CURRENT_TIMESTAMP WHERE project_id = ?', [p.project_id]);
    }

    await exec(conn, 'UPDATE pdp_project SET current_gate = ?, state = ?, gate_round = 1, updated_by = ? WHERE project_id = ?', [next.currentGate, next.state, actor, p.project_id]);
    await history(conn, ck, p.project_id, 'gate_passed', `${outcome.gate} (${p.state})`, `${next.currentGate} (${next.state})`, null, actor);
    return next;
  });
}

// ---------------------------------------------------------------------------- hold / resume / close

export async function holdProject(ck: number, code: string, input: Record<string, unknown>, actor: number) {
  return inTransaction(async (conn) => {
    const p = await loadProject(conn, ck, code, true);
    if (p.state !== 'active') throw new PdpError('project.notActive', 'Only an active project can be put on hold.', undefined, 409);
    const reason = reqText(input.reason, 'reason', 2000, 'Reason');
    await exec(conn, "UPDATE pdp_project SET state = 'on_hold', updated_by = ? WHERE project_id = ?", [actor, p.project_id]);
    await history(conn, ck, p.project_id, 'state', 'active', 'on_hold', reason, actor);
  });
}

/** Back to active: checked against the cap like a G1 approval (CEO/EXCO override with a reason). */
export async function resumeProject(ck: number, code: string, input: Record<string, unknown>, actor: number, userRoles: string[]) {
  return inTransaction(async (conn) => {
    await rows(conn, "SELECT setting_key FROM pdp_setting WHERE company_key = ? AND setting_key = 'max_concurrent_projects' FOR UPDATE", [ck]);
    const p = await loadProject(conn, ck, code, true);
    if (p.state !== 'on_hold') throw new PdpError('project.notOnHold', 'The project is not on hold.', undefined, 409);
    const s = await getSettings(ck, conn);
    const override = checkCapacity({ active: await activeCount(conn, ck), max: s.max_concurrent_projects }, userRoles, input.overrideReason);
    await exec(conn, "UPDATE pdp_project SET state = 'active', updated_by = ? WHERE project_id = ?", [actor, p.project_id]);
    await history(conn, ck, p.project_id, 'state', 'on_hold', 'active', text(input.comment, 'comment', { max: 2000 }), actor);
    if (override) await history(conn, ck, p.project_id, 'capacity_override', null, `${s.max_concurrent_projects} max`, String(input.overrideReason).trim(), actor);
  });
}

/** Step 7 of the deck: closure report -> closed, read-only afterwards (admins excepted). By the owner or the Technical Manager. */
export async function closeProject(ck: number, code: string, input: Record<string, unknown>, actor: number, userRoles: string[], isAdmin: boolean) {
  return inTransaction(async (conn) => {
    const p = await loadProject(conn, ck, code, true);
    if (p.state !== 'launched') throw new PdpError('project.notLaunched', 'A project is closed after its launch (G5).', undefined, 409);
    if (!isAdmin && p.owner_user_id !== actor && !userRoles.includes('TECH_MANAGER')) {
      throw new PdpError('project.closeNotAllowed', 'The project owner or the Technical Manager closes the project.', undefined, 403);
    }
    const report = reqText(input.closureReport, 'closureReport', 20000, 'Closure report');
    await exec(conn, "UPDATE pdp_project SET state = 'closed', closure_report = ?, closed_date = ?, updated_by = ? WHERE project_id = ?", [report, today(), actor, p.project_id]);
    await history(conn, ck, p.project_id, 'state', 'launched', 'closed', null, actor);
  });
}

/** The project a child record belongs to (attachments check it before writing). */
export async function projectIdForOwner(ck: number, ownerType: string, ownerId: number): Promise<{ projectId: number | null; state: string | null }> {
  const sql: Record<string, string> = {
    project: 'SELECT project_id, state FROM pdp_project WHERE company_key = ? AND project_id = ? AND deleted_at IS NULL',
    checklist: 'SELECT p.project_id, p.state FROM pdp_project_checklist c JOIN pdp_project p ON p.project_id = c.project_id WHERE p.company_key = ? AND c.item_id = ? AND p.deleted_at IS NULL',
    field_trial: 'SELECT p.project_id, p.state FROM pdp_field_trial t JOIN pdp_project p ON p.project_id = t.project_id WHERE p.company_key = ? AND t.trial_id = ? AND t.deleted_at IS NULL',
    doc_error: 'SELECT p.project_id, p.state FROM pdp_documentation_error e JOIN pdp_project p ON p.project_id = e.project_id WHERE p.company_key = ? AND e.error_id = ? AND e.deleted_at IS NULL',
  };
  if (!sql[ownerType]) return { projectId: null, state: null };
  const r = await one<{ project_id: number; state: string }>(pool, sql[ownerType], [ck, ownerId]);
  return { projectId: r ? Number(r.project_id) : null, state: r?.state ?? null };
}
