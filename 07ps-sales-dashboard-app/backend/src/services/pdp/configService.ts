import { pool } from '../../db/pool';
import { writeAuditLog } from '../auditLogService';
import { PdpError, notFound } from './errors';
import { exec, inTransaction, isoDate, one, rows, type Db } from './db';
import { assertWeightsTotal100, gatesWithoutApprovers, validFreezeValue, type Criterion, type SignoffRule } from './rules';
import { bool, date, id, int, oneOf, optId, reqText, text } from './validate';

/**
 * Product Development Plan configuration: settings, governance, scoring criteria, gate rules, checklist templates,
 * KPI targets, drop-downs, roadmap years, gap items and policy versions. Every function takes the TIKA company key
 * (services/pdp/company.ts) and only touches that company's rows. Changes are written to audit_log.
 */

async function audit(entityType: string, entityId: string | number, action: 'CREATE' | 'UPDATE' | 'DELETE', actor: number, before?: unknown, after?: unknown) {
  await writeAuditLog({ entityType, entityId: String(entityId), action, changedBy: actor, before, after });
}

// ---------------------------------------------------------------------------- settings

export interface PdpSettings {
  max_concurrent_projects: number;
  mix_target_planned: number;
  mix_target_unplanned: number;
  mix_target_innovation: number;
  min_score: number;
  fast_track_feasibility_hours: number;
  freeze_from_mmdd: string;
  freeze_to_mmdd: string;
  pilot_kg_min: number;
  pilot_kg_max: number;
}

const DEFAULTS: PdpSettings = {
  max_concurrent_projects: 6, mix_target_planned: 50, mix_target_unplanned: 30, mix_target_innovation: 20, min_score: 60,
  fast_track_feasibility_hours: 72, freeze_from_mmdd: '', freeze_to_mmdd: '', pilot_kg_min: 500, pilot_kg_max: 1500,
};

export async function getSettings(ck: number, db: Db = pool): Promise<PdpSettings> {
  const r = await rows<{ setting_key: string; setting_value: string }>(db, 'SELECT setting_key, setting_value FROM pdp_setting WHERE company_key = ?', [ck]);
  const out: Record<string, number | string> = { ...DEFAULTS };
  for (const { setting_key: k, setting_value: v } of r) {
    if (!(k in DEFAULTS)) continue;
    out[k] = typeof DEFAULTS[k as keyof PdpSettings] === 'number' ? Number(v) : v;
  }
  return out as unknown as PdpSettings;
}

export async function updateSettings(ck: number, input: Record<string, unknown>, actor: number): Promise<PdpSettings> {
  const before = await getSettings(ck);
  const next: PdpSettings = { ...before };
  const ints: [keyof PdpSettings, number, number][] = [
    ['max_concurrent_projects', 1, 100], ['mix_target_planned', 0, 100], ['mix_target_unplanned', 0, 100], ['mix_target_innovation', 0, 100],
    ['min_score', 0, 100], ['fast_track_feasibility_hours', 1, 720], ['pilot_kg_min', 1, 100000], ['pilot_kg_max', 1, 100000],
  ];
  for (const [k, min, max] of ints) {
    if (input[k] !== undefined) (next as unknown as Record<string, number>)[k] = int(input[k], k, { min, max, required: true }) as number;
  }
  for (const k of ['freeze_from_mmdd', 'freeze_to_mmdd'] as const) {
    if (input[k] === undefined) continue;
    const v = String(input[k] ?? '').trim();
    if (!validFreezeValue(v)) throw new PdpError('settings.freezeFormat', 'Freeze dates are month-day, like 06-01.', k);
    next[k] = v;
  }
  if ((next.freeze_from_mmdd === '') !== (next.freeze_to_mmdd === '')) {
    throw new PdpError('settings.freezeBoth', 'Give both freeze dates, or leave both empty for no freeze.', 'freeze_from_mmdd');
  }
  if (next.mix_target_planned + next.mix_target_unplanned + next.mix_target_innovation !== 100) {
    throw new PdpError('settings.mixTotal', 'The planned / unplanned / innovation targets must add up to 100.', 'mix_target_planned');
  }
  if (next.pilot_kg_min >= next.pilot_kg_max) throw new PdpError('settings.pilotRange', 'The pilot minimum must be below the maximum.', 'pilot_kg_min');
  for (const [k, v] of Object.entries(next)) {
    await exec(pool,
      `INSERT INTO pdp_setting (company_key, setting_key, setting_value, created_by, updated_by) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`,
      [ck, k, String(v), actor, actor]);
  }
  await audit('pdp_setting', ck, 'UPDATE', actor, before, next);
  return next;
}

// ---------------------------------------------------------------------------- users + governance

export interface AppUserOption {
  user_id: number;
  display_name: string;
  email: string;
}

export async function listActiveUsers(): Promise<AppUserOption[]> {
  return rows<AppUserOption>(pool, "SELECT user_id, display_name, email FROM app_user WHERE is_active = 1 AND status <> 'INACTIVE' ORDER BY display_name");
}

export interface GovernanceRole {
  role_id: number;
  code: string;
  label: string;
  responsibility: string | null;
  members: { member_id: number; user_id: number; display_name: string; email: string }[];
}

export async function listGovernance(ck: number, db: Db = pool): Promise<GovernanceRole[]> {
  const roles = await rows<Omit<GovernanceRole, 'members'>>(db, 'SELECT role_id, code, label, responsibility FROM pdp_governance_role WHERE company_key = ? ORDER BY sort_order, label', [ck]);
  const members = await rows<{ member_id: number; role_id: number; user_id: number; display_name: string; email: string }>(
    db,
    `SELECT m.member_id, m.role_id, m.user_id, u.display_name, u.email
       FROM pdp_governance_member m JOIN app_user u ON u.user_id = m.user_id
      WHERE m.company_key = ? AND m.deleted_at IS NULL ORDER BY u.display_name`,
    [ck],
  );
  return roles.map((r) => ({ ...r, members: members.filter((m) => m.role_id === r.role_id).map((m) => ({ member_id: m.member_id, user_id: m.user_id, display_name: m.display_name, email: m.email })) }));
}

/** Governance role codes a user holds (active memberships). */
export async function userGovernanceRoles(ck: number, userId: number, db: Db = pool): Promise<string[]> {
  const r = await rows<{ code: string }>(
    db,
    `SELECT r.code FROM pdp_governance_member m JOIN pdp_governance_role r ON r.role_id = m.role_id
      WHERE m.company_key = ? AND m.user_id = ? AND m.deleted_at IS NULL`,
    [ck, userId],
  );
  return r.map((x) => x.code);
}

export async function addGovernanceMember(ck: number, input: Record<string, unknown>, actor: number) {
  const roleCode = reqText(input.roleCode, 'roleCode', 30, 'Role');
  const userId = id(input.userId, 'userId', 'User');
  const role = await one<{ role_id: number }>(pool, 'SELECT role_id FROM pdp_governance_role WHERE company_key = ? AND code = ?', [ck, roleCode]);
  if (!role) throw notFound('role');
  const user = await one<{ user_id: number }>(pool, 'SELECT user_id FROM app_user WHERE user_id = ? AND is_active = 1', [userId]);
  if (!user) throw new PdpError('governance.userInactive', 'Pick an active app user.', 'userId');
  const dup = await one(pool, 'SELECT 1 FROM pdp_governance_member WHERE role_id = ? AND user_id = ? AND deleted_at IS NULL', [role.role_id, userId]);
  if (dup) throw new PdpError('governance.duplicate', 'This user already holds this role.', 'userId', 409);
  const r = await exec(pool, 'INSERT INTO pdp_governance_member (company_key, role_id, user_id, created_by, updated_by) VALUES (?, ?, ?, ?, ?)', [ck, role.role_id, userId, actor, actor]);
  await audit('pdp_governance_member', r.insertId, 'CREATE', actor, null, { roleCode, userId });
  return { member_id: r.insertId };
}

export async function removeGovernanceMember(ck: number, memberId: number, actor: number) {
  const m = await one<{ member_id: number; role_id: number; user_id: number }>(pool, 'SELECT member_id, role_id, user_id FROM pdp_governance_member WHERE company_key = ? AND member_id = ? AND deleted_at IS NULL', [ck, memberId]);
  if (!m) throw notFound('member');
  await exec(pool, 'UPDATE pdp_governance_member SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ?, updated_by = ? WHERE member_id = ?', [actor, actor, memberId]);
  await audit('pdp_governance_member', memberId, 'DELETE', actor, m, null);
}

// ---------------------------------------------------------------------------- scoring criteria

export interface CriterionRow extends Criterion {
  code: string;
  is_active: boolean;
  sort_order: number;
}

export async function listCriteria(ck: number, activeOnly: boolean, db: Db = pool): Promise<CriterionRow[]> {
  const r = await rows<Record<string, unknown>>(
    db,
    `SELECT * FROM pdp_scoring_criterion WHERE company_key = ? ${activeOnly ? 'AND is_active = 1' : ''} ORDER BY sort_order, criterion_id`,
    [ck],
  );
  return r.map((c) => ({
    criterion_id: Number(c.criterion_id), code: String(c.code), name: String(c.name), weight: Number(c.weight),
    meanings: [0, 1, 2, 3, 4, 5].map((i) => String(c[`meaning_${i}`] ?? '')), is_active: Boolean(c.is_active), sort_order: Number(c.sort_order),
  }));
}

/** Saves the whole matrix at once, so the "active weights total 100" check covers every row. */
export async function saveCriteria(ck: number, input: unknown, actor: number): Promise<CriterionRow[]> {
  if (!Array.isArray(input) || input.length === 0) throw new PdpError('criteria.empty', 'Send the full list of criteria.', 'criteria');
  const before = await listCriteria(ck, false);
  const parsed = input.map((raw, i) => {
    const c = (raw ?? {}) as Record<string, unknown>;
    const meanings = Array.isArray(c.meanings) ? c.meanings : [];
    if (meanings.length !== 6) throw new PdpError('criteria.meanings', 'Each criterion needs the six meaning texts (scores 0 to 5).', `meanings.${i}`);
    return {
      criterion_id: optId(c.criterion_id, 'criterion_id'),
      name: reqText(c.name, `name.${i}`, 100, 'Criterion name'),
      weight: int(c.weight, `weight.${i}`, { min: 0, max: 100, required: true, label: 'Weight' }) as number,
      meanings: meanings.map((m, j) => reqText(m, `meaning.${i}.${j}`, 200, `Meaning for score ${j}`)),
      is_active: c.is_active === undefined ? true : bool(c.is_active),
      sort_order: i + 1,
    };
  });
  assertWeightsTotal100(parsed.filter((c) => c.is_active).map((c) => c.weight));
  await inTransaction(async (conn) => {
    for (const c of parsed) {
      if (c.criterion_id) {
        const r = await exec(conn,
          `UPDATE pdp_scoring_criterion SET name = ?, weight = ?, meaning_0 = ?, meaning_1 = ?, meaning_2 = ?, meaning_3 = ?, meaning_4 = ?, meaning_5 = ?,
                  is_active = ?, sort_order = ?, updated_by = ? WHERE company_key = ? AND criterion_id = ?`,
          [c.name, c.weight, ...c.meanings, c.is_active, c.sort_order, actor, ck, c.criterion_id]);
        if (r.affectedRows === 0) throw notFound('criterion');
      } else {
        const code = c.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || `CRITERION_${Date.now()}`;
        await exec(conn,
          `INSERT INTO pdp_scoring_criterion (company_key, code, name, weight, meaning_0, meaning_1, meaning_2, meaning_3, meaning_4, meaning_5, is_active, sort_order, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [ck, code, c.name, c.weight, ...c.meanings, c.is_active, c.sort_order, actor, actor]);
      }
    }
  });
  const after = await listCriteria(ck, false);
  await audit('pdp_scoring_criterion', ck, 'UPDATE', actor, before, after);
  return after;
}

// ---------------------------------------------------------------------------- gate rules + checklist templates

export async function listGateRules(ck: number, db: Db = pool): Promise<(SignoffRule & { rule_id: number })[]> {
  const r = await rows<Record<string, unknown>>(db, 'SELECT * FROM pdp_gate_rule WHERE company_key = ? ORDER BY gate, sort_order', [ck]);
  return r.map((x) => ({
    rule_id: Number(x.rule_id), code: String(x.signoff_code), gate: x.gate as SignoffRule['gate'], label: String(x.label),
    roles: (typeof x.roles_json === 'string' ? JSON.parse(x.roles_json) : x.roles_json) as string[],
    mode: x.mode as 'ALL' | 'ANY', appliesTo: x.applies_to as 'ALL' | 'UNPLANNED', active: Boolean(x.is_active),
  }));
}

export async function updateGateRule(ck: number, ruleId: number, input: Record<string, unknown>, actor: number) {
  const before = (await listGateRules(ck)).find((r) => r.rule_id === ruleId);
  if (!before) throw notFound('rule');
  const known = (await rows<{ code: string }>(pool, 'SELECT code FROM pdp_governance_role WHERE company_key = ?', [ck])).map((r) => r.code);
  const roles = input.roles === undefined ? before.roles : Array.isArray(input.roles) ? input.roles.map(String) : [];
  if (roles.length === 0) throw new PdpError('rule.rolesRequired', 'A sign-off needs at least one governance role.', 'roles');
  if (roles.some((r) => !known.includes(r))) throw new PdpError('rule.unknownRole', 'Unknown governance role.', 'roles');
  const mode = input.mode === undefined ? before.mode : oneOf(input.mode, ['ALL', 'ANY'] as const, 'mode');
  const active = input.active === undefined ? before.active : bool(input.active);
  const label = input.label === undefined ? before.label : reqText(input.label, 'label', 150, 'Label');
  await exec(pool, 'UPDATE pdp_gate_rule SET roles_json = CAST(? AS JSON), mode = ?, is_active = ?, label = ?, updated_by = ? WHERE company_key = ? AND rule_id = ?',
    [JSON.stringify([...new Set(roles)]), mode, active, label, actor, ck, ruleId]);
  await audit('pdp_gate_rule', ruleId, 'UPDATE', actor, before, { roles, mode, active, label });
}

export interface ChecklistTemplate {
  template_id: number;
  list_code: string;
  item_code: string;
  label: string;
  hint: string | null;
  gate: string;
  required: boolean;
  needs_evidence: boolean;
  owner_role_code: string | null;
  is_active: boolean;
  sort_order: number;
}

export async function listChecklistTemplates(ck: number, db: Db = pool): Promise<ChecklistTemplate[]> {
  const r = await rows<ChecklistTemplate>(db, 'SELECT template_id, list_code, item_code, label, hint, gate, required, needs_evidence, owner_role_code, is_active, sort_order FROM pdp_checklist_template WHERE company_key = ? ORDER BY sort_order', [ck]);
  return r.map((t) => ({ ...t, required: Boolean(t.required), needs_evidence: Boolean(t.needs_evidence), is_active: Boolean(t.is_active) }));
}

/** The "required" switch is the gate rule for that item (e.g. Packaging at G5, optional until made required here). */
export async function updateChecklistTemplate(ck: number, templateId: number, input: Record<string, unknown>, actor: number) {
  const before = (await listChecklistTemplates(ck)).find((t) => t.template_id === templateId);
  if (!before) throw notFound('item');
  const next = {
    label: input.label === undefined ? before.label : reqText(input.label, 'label', 200, 'Label'),
    hint: input.hint === undefined ? before.hint : text(input.hint, 'hint', { max: 300 }),
    required: input.required === undefined ? before.required : bool(input.required),
    needs_evidence: input.needs_evidence === undefined ? before.needs_evidence : bool(input.needs_evidence),
    owner_role_code: input.owner_role_code === undefined ? before.owner_role_code : text(input.owner_role_code, 'owner_role_code', { max: 30 }),
    is_active: input.is_active === undefined ? before.is_active : bool(input.is_active),
  };
  await exec(pool, 'UPDATE pdp_checklist_template SET label = ?, hint = ?, required = ?, needs_evidence = ?, owner_role_code = ?, is_active = ?, updated_by = ? WHERE company_key = ? AND template_id = ?',
    [next.label, next.hint, next.required, next.needs_evidence, next.owner_role_code, next.is_active, actor, ck, templateId]);
  await audit('pdp_checklist_template', templateId, 'UPDATE', actor, before, next);
}

/** Gates whose sign-offs can't be given because a role has nobody assigned ("No approver assigned for G_"). */
export async function approverWarnings(ck: number, db: Db = pool): Promise<string[]> {
  const rules = await listGateRules(ck, db);
  const counts = await rows<{ code: string; n: number }>(
    db,
    `SELECT r.code, COUNT(m.member_id) AS n FROM pdp_governance_role r
       LEFT JOIN pdp_governance_member m ON m.role_id = r.role_id AND m.deleted_at IS NULL
      WHERE r.company_key = ? GROUP BY r.code`,
    [ck],
  );
  return gatesWithoutApprovers(rules, Object.fromEntries(counts.map((c) => [c.code, Number(c.n)])));
}

// ---------------------------------------------------------------------------- KPI targets

export async function listKpiTargets(ck: number, db: Db = pool) {
  const r = await rows<{ kpi_code: string; label: string; target: string; comparator: 'gte' | 'lte' | 'eq'; unit: 'count' | 'pct' | 'days' }>(
    db, 'SELECT kpi_code, label, target, comparator, unit FROM pdp_kpi_target WHERE company_key = ? ORDER BY sort_order', [ck]);
  return r.map((k) => ({ ...k, target: Number(k.target) }));
}

export async function updateKpiTarget(ck: number, code: string, input: Record<string, unknown>, actor: number) {
  const before = (await listKpiTargets(ck)).find((k) => k.kpi_code === code);
  if (!before) throw notFound('kpi');
  const target = Number(input.target);
  if (!Number.isFinite(target) || target < 0 || (before.unit === 'pct' && target > 100)) throw new PdpError('kpi.target', 'Enter a valid target.', 'target');
  await exec(pool, 'UPDATE pdp_kpi_target SET target = ?, updated_by = ? WHERE company_key = ? AND kpi_code = ?', [target, actor, ck, code]);
  await audit('pdp_kpi_target', code, 'UPDATE', actor, before, { ...before, target });
}

// ---------------------------------------------------------------------------- drop-downs

export const DROPDOWN_LISTS = ['project_type', 'request_source', 'competitor', 'lab_property', 'feedback_channel', 'feedback_category'] as const;
export type DropdownList = (typeof DROPDOWN_LISTS)[number];

export async function listDropdowns(ck: number, db: Db = pool) {
  const r = await rows<{ value_id: number; list_key: DropdownList; label: string; sort_order: number; is_active: number }>(
    db, 'SELECT value_id, list_key, label, sort_order, is_active FROM pdp_dropdown_value WHERE company_key = ? ORDER BY list_key, sort_order, label', [ck]);
  return r.map((d) => ({ ...d, is_active: Boolean(d.is_active) }));
}

/** A value must exist in the list (and be active, for new records). */
export async function assertDropdown(ck: number, valueId: unknown, list: DropdownList, field: string, label: string, db: Db = pool, mustBeActive = true): Promise<number> {
  const vid = id(valueId, field, label);
  const v = await one<{ is_active: number }>(db, 'SELECT is_active FROM pdp_dropdown_value WHERE company_key = ? AND value_id = ? AND list_key = ?', [ck, vid, list]);
  if (!v || (mustBeActive && !v.is_active)) throw new PdpError('field.invalid', `${label} is not a valid choice.`, field);
  return vid;
}

export async function createDropdown(ck: number, input: Record<string, unknown>, actor: number) {
  const list = oneOf(input.listKey, DROPDOWN_LISTS, 'listKey', 'List');
  const label = reqText(input.label, 'label', 100, 'Label');
  const dup = await one(pool, 'SELECT 1 FROM pdp_dropdown_value WHERE company_key = ? AND list_key = ? AND label = ?', [ck, list, label]);
  if (dup) throw new PdpError('dropdown.duplicate', `"${label}" already exists in this list.`, 'label', 409);
  const next = await one<{ n: number }>(pool, 'SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM pdp_dropdown_value WHERE company_key = ? AND list_key = ?', [ck, list]);
  const r = await exec(pool, 'INSERT INTO pdp_dropdown_value (company_key, list_key, label, sort_order, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)', [ck, list, label, Number(next?.n ?? 1), actor, actor]);
  await audit('pdp_dropdown_value', r.insertId, 'CREATE', actor, null, { list, label });
  return { value_id: r.insertId };
}

/** Rename, reorder or (de)activate. Values are never deleted: records keep pointing at them. */
export async function updateDropdown(ck: number, valueId: number, input: Record<string, unknown>, actor: number) {
  const before = await one<{ list_key: string; label: string; sort_order: number; is_active: number }>(pool, 'SELECT list_key, label, sort_order, is_active FROM pdp_dropdown_value WHERE company_key = ? AND value_id = ?', [ck, valueId]);
  if (!before) throw notFound('value');
  const label = input.label === undefined ? before.label : reqText(input.label, 'label', 100, 'Label');
  if (label !== before.label) {
    const dup = await one(pool, 'SELECT 1 FROM pdp_dropdown_value WHERE company_key = ? AND list_key = ? AND label = ? AND value_id <> ?', [ck, before.list_key, label, valueId]);
    if (dup) throw new PdpError('dropdown.duplicate', `"${label}" already exists in this list.`, 'label', 409);
  }
  const sortOrder = input.sortOrder === undefined ? before.sort_order : (int(input.sortOrder, 'sortOrder', { min: 0, required: true }) as number);
  const active = input.isActive === undefined ? Boolean(before.is_active) : bool(input.isActive);
  await exec(pool, 'UPDATE pdp_dropdown_value SET label = ?, sort_order = ?, is_active = ?, updated_by = ? WHERE company_key = ? AND value_id = ?', [label, sortOrder, active, actor, ck, valueId]);
  await audit('pdp_dropdown_value', valueId, 'UPDATE', actor, before, { label, sortOrder, active });
}

// ---------------------------------------------------------------------------- roadmap years

export async function listRoadmapYears(ck: number, db: Db = pool) {
  return rows<{ roadmap_year_id: number; year: number; theme: string; notes: string | null }>(
    db, 'SELECT roadmap_year_id, year, theme, notes FROM pdp_roadmap_year WHERE company_key = ? AND deleted_at IS NULL ORDER BY year', [ck]);
}

export async function saveRoadmapYear(ck: number, yearId: number | null, input: Record<string, unknown>, actor: number) {
  const year = int(input.year, 'year', { min: 2000, max: 2100, required: true, label: 'Year' }) as number;
  const theme = reqText(input.theme, 'theme', 150, 'Theme');
  const notes = text(input.notes, 'notes', { max: 5000 });
  const dup = await one(pool, 'SELECT 1 FROM pdp_roadmap_year WHERE company_key = ? AND year = ? AND deleted_at IS NULL AND roadmap_year_id <> ?', [ck, year, yearId ?? -1]);
  if (dup) throw new PdpError('roadmap.duplicate', `${year} is already on the roadmap.`, 'year', 409);
  if (yearId) {
    const r = await exec(pool, 'UPDATE pdp_roadmap_year SET year = ?, theme = ?, notes = ?, updated_by = ? WHERE company_key = ? AND roadmap_year_id = ? AND deleted_at IS NULL', [year, theme, notes, actor, ck, yearId]);
    if (r.affectedRows === 0) throw notFound('year');
    await audit('pdp_roadmap_year', yearId, 'UPDATE', actor, null, { year, theme, notes });
    return { roadmap_year_id: yearId };
  }
  const r = await exec(pool, 'INSERT INTO pdp_roadmap_year (company_key, year, theme, notes, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)', [ck, year, theme, notes, actor, actor]);
  await audit('pdp_roadmap_year', r.insertId, 'CREATE', actor, null, { year, theme, notes });
  return { roadmap_year_id: r.insertId };
}

export async function deleteRoadmapYear(ck: number, yearId: number, actor: number) {
  const r = await exec(pool, 'UPDATE pdp_roadmap_year SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ? WHERE company_key = ? AND roadmap_year_id = ? AND deleted_at IS NULL', [actor, ck, yearId]);
  if (r.affectedRows === 0) throw notFound('year');
  await audit('pdp_roadmap_year', yearId, 'DELETE', actor);
}

// ---------------------------------------------------------------------------- gap analysis (5M)

export const GAP_CATEGORIES = ['MANPOWER', 'MACHINE', 'MATERIALS', 'METHODS', 'MEASUREMENTS'] as const;
export const GAP_STATUSES = ['open', 'in_progress', 'done'] as const;

export async function listGapItems(ck: number, db: Db = pool) {
  const r = await rows<Record<string, unknown>>(
    db,
    `SELECT g.gap_id, g.category, g.item, g.owner_user_id, u.display_name AS owner_name, g.status, g.due_date, g.notes, g.sort_order
       FROM pdp_gap_item g LEFT JOIN app_user u ON u.user_id = g.owner_user_id
      WHERE g.company_key = ? AND g.deleted_at IS NULL ORDER BY FIELD(g.category, 'MANPOWER','MACHINE','MATERIALS','METHODS','MEASUREMENTS'), g.sort_order`,
    [ck],
  );
  return r.map((g) => ({ ...g, due_date: isoDate(g.due_date) }));
}

export async function saveGapItem(ck: number, gapId: number | null, input: Record<string, unknown>, actor: number) {
  const v = {
    category: oneOf(input.category, GAP_CATEGORIES, 'category', 'Category'),
    item: reqText(input.item, 'item', 300, 'Item'),
    owner: optId(input.ownerUserId, 'ownerUserId'),
    status: oneOf(input.status ?? 'open', GAP_STATUSES, 'status', 'Status'),
    due: date(input.dueDate, 'dueDate', { label: 'Due date' }),
    notes: text(input.notes, 'notes', { max: 5000 }),
  };
  if (gapId) {
    const r = await exec(pool, 'UPDATE pdp_gap_item SET category = ?, item = ?, owner_user_id = ?, status = ?, due_date = ?, notes = ?, updated_by = ? WHERE company_key = ? AND gap_id = ? AND deleted_at IS NULL',
      [v.category, v.item, v.owner, v.status, v.due, v.notes, actor, ck, gapId]);
    if (r.affectedRows === 0) throw notFound('item');
    await audit('pdp_gap_item', gapId, 'UPDATE', actor, null, v);
    return { gap_id: gapId };
  }
  const r = await exec(pool, 'INSERT INTO pdp_gap_item (company_key, category, item, owner_user_id, status, due_date, notes, sort_order, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, 99, ?, ?)',
    [ck, v.category, v.item, v.owner, v.status, v.due, v.notes, actor, actor]);
  await audit('pdp_gap_item', r.insertId, 'CREATE', actor, null, v);
  return { gap_id: r.insertId };
}

export async function deleteGapItem(ck: number, gapId: number, actor: number) {
  const r = await exec(pool, 'UPDATE pdp_gap_item SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ? WHERE company_key = ? AND gap_id = ? AND deleted_at IS NULL', [actor, ck, gapId]);
  if (r.affectedRows === 0) throw notFound('item');
  await audit('pdp_gap_item', gapId, 'DELETE', actor);
}

// ---------------------------------------------------------------------------- policy versions

export interface PolicyVersion {
  version_id: number;
  version_label: string;
  status: 'draft' | 'published';
  title: string;
  notes: string | null;
  source: 'IMPORT' | 'APP';
  published_at: string | null;
}

export async function listPolicyVersions(ck: number, db: Db = pool): Promise<PolicyVersion[]> {
  const r = await rows<PolicyVersion>(db, `SELECT version_id, version_label, status, title, notes, source, published_at FROM pdp_policy_version
     WHERE company_key = ? AND deleted_at IS NULL ORDER BY (status = 'draft') DESC, published_at DESC, version_id DESC`, [ck]);
  return r.map((v) => ({ ...v, published_at: v.published_at ? new Date(v.published_at).toISOString() : null }));
}

/** One version with its sections; without an id, the latest published one. */
export async function getPolicy(ck: number, versionId: number | null) {
  const versions = await listPolicyVersions(ck);
  const v = versionId ? versions.find((x) => x.version_id === versionId) : versions.find((x) => x.status === 'published');
  if (!v) return { versions, version: null, sections: [] };
  const sections = await rows<{ section_id: number; section_no: number; title: string; body: string }>(
    pool, 'SELECT section_id, section_no, title, body FROM pdp_policy_section WHERE version_id = ? AND deleted_at IS NULL ORDER BY section_no', [v.version_id]);
  return { versions, version: v, sections };
}

async function draftOf(ck: number, versionId: number, db: Db = pool) {
  const v = await one<{ status: string }>(db, `SELECT status FROM pdp_policy_version WHERE company_key = ? AND version_id = ? AND deleted_at IS NULL${db === pool ? '' : ' FOR UPDATE'}`, [ck, versionId]);
  if (!v) throw notFound('version');
  if (v.status !== 'draft') throw new PdpError('policy.published', 'A published version is read-only: start a new draft.', undefined, 409);
}

/** New draft = a copy of the latest published version's sections. One draft at a time. */
export async function createPolicyDraft(ck: number, input: Record<string, unknown>, actor: number) {
  const label = reqText(input.versionLabel, 'versionLabel', 20, 'Version');
  return inTransaction(async (conn) => {
    if (await one(conn, "SELECT 1 FROM pdp_policy_version WHERE company_key = ? AND status = 'draft' AND deleted_at IS NULL", [ck])) {
      throw new PdpError('policy.draftExists', 'There is already a draft: publish or discard it first.', undefined, 409);
    }
    if (await one(conn, 'SELECT 1 FROM pdp_policy_version WHERE company_key = ? AND version_label = ? AND deleted_at IS NULL', [ck, label])) {
      throw new PdpError('policy.labelTaken', `Version ${label} already exists.`, 'versionLabel', 409);
    }
    const base = await one<{ version_id: number; title: string }>(conn, "SELECT version_id, title FROM pdp_policy_version WHERE company_key = ? AND status = 'published' AND deleted_at IS NULL ORDER BY published_at DESC LIMIT 1", [ck]);
    const r = await exec(conn, "INSERT INTO pdp_policy_version (company_key, version_label, status, title, notes, source, created_by, updated_by) VALUES (?, ?, 'draft', ?, ?, 'APP', ?, ?)",
      [ck, label, base?.title ?? 'TIKA R&D Policy', text(input.notes, 'notes', { max: 5000 }), actor, actor]);
    if (base) {
      await exec(conn, `INSERT INTO pdp_policy_section (company_key, version_id, section_no, title, body, created_by, updated_by)
                        SELECT company_key, ?, section_no, title, body, ?, ? FROM pdp_policy_section WHERE version_id = ? AND deleted_at IS NULL`,
      [r.insertId, actor, actor, base.version_id]);
    }
    await audit('pdp_policy_version', r.insertId, 'CREATE', actor, null, { label, copiedFrom: base?.version_id ?? null });
    return { version_id: r.insertId };
  });
}

export async function saveSection(ck: number, versionId: number, sectionId: number | null, input: Record<string, unknown>, actor: number) {
  return inTransaction(async (conn) => {
  await draftOf(ck, versionId, conn);
  const no = int(input.sectionNo, 'sectionNo', { min: 1, max: 999, required: true, label: 'Section number' }) as number;
  const title = reqText(input.title, 'title', 200, 'Title');
  const body = reqText(input.body, 'body', 60000, 'Text');
  const dup = await one(conn, 'SELECT 1 FROM pdp_policy_section WHERE version_id = ? AND section_no = ? AND deleted_at IS NULL AND section_id <> ?', [versionId, no, sectionId ?? -1]);
  if (dup) throw new PdpError('policy.sectionNoTaken', `Section ${no} already exists in this version.`, 'sectionNo', 409);
  if (sectionId) {
    const r = await exec(conn, 'UPDATE pdp_policy_section SET section_no = ?, title = ?, body = ?, updated_by = ? WHERE company_key = ? AND version_id = ? AND section_id = ? AND deleted_at IS NULL', [no, title, body, actor, ck, versionId, sectionId]);
    if (r.affectedRows === 0) throw notFound('section');
    return { section_id: sectionId };
  }
  const r = await exec(conn, 'INSERT INTO pdp_policy_section (company_key, version_id, section_no, title, body, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)', [ck, versionId, no, title, body, actor, actor]);
  return { section_id: r.insertId };
  });
}

export async function deleteSection(ck: number, versionId: number, sectionId: number, actor: number) {
  return inTransaction(async (conn) => {
  await draftOf(ck, versionId, conn);
  const r = await exec(conn, 'UPDATE pdp_policy_section SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ? WHERE company_key = ? AND version_id = ? AND section_id = ? AND deleted_at IS NULL', [actor, ck, versionId, sectionId]);
  if (r.affectedRows === 0) throw notFound('section');
  });
}

export async function publishPolicyDraft(ck: number, versionId: number, actor: number) {
  return inTransaction(async (conn) => {
  await draftOf(ck, versionId, conn);
  const n = await one<{ n: number }>(conn, 'SELECT COUNT(*) AS n FROM pdp_policy_section WHERE version_id = ? AND deleted_at IS NULL', [versionId]);
  if (!Number(n?.n)) throw new PdpError('policy.empty', 'A version needs at least one section.', undefined, 409);
  await exec(conn, "UPDATE pdp_policy_version SET status = 'published', published_at = CURRENT_TIMESTAMP, published_by = ?, updated_by = ? WHERE version_id = ?", [actor, actor, versionId]);
  await audit('pdp_policy_version', versionId, 'UPDATE', actor, { status: 'draft' }, { status: 'published' });
  });
}

export async function discardPolicyDraft(ck: number, versionId: number, actor: number) {
  return inTransaction(async (conn) => {
  await draftOf(ck, versionId, conn);
  await exec(conn, 'UPDATE pdp_policy_version SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ? WHERE version_id = ?', [actor, versionId]);
  await audit('pdp_policy_version', versionId, 'DELETE', actor);
  });
}
