import type { PoolConnection } from 'mysql2/promise';
import { pool } from '../../db/pool';
import { writeAuditLog } from '../auditLogService';
import { exec, inTransaction, isoDate, isoDateTime, one, rows, type Db } from '../pdp/db';
import { PdpError, notFound } from '../pdp/errors';
import {
  BLOCKER_KINDS,
  BLOCKER_STATUSES,
  DEFAULT_SETTINGS,
  FLAG_LABEL,
  HEALTHS,
  NOT_SET,
  PRIORITIES,
  PROJECT_TYPES,
  SETTING_KEYS,
  SETTING_RANGES,
  STAGES,
  UNASSIGNED_BRAND,
  applyFilters,
  buildFollowup,
  buildRoadmap,
  businessToday,
  computeKpis,
  familyStageMatrix,
  kpiSets,
  forcedHealth,
  isActive,
  isStale,
  isValidIsoDate,
  launchesByYear,
  nextCode,
  openBlockers,
  productFlag,
  productProblems,
  stageSummary,
  withDaysInStage,
  type Blocker,
  type BlockerKind,
  type BlockerStatus,
  type Filters,
  type FlagCode,
  type HealthCode,
  type OpenNextStep,
  type PriorityCode,
  type Product,
  type ProjectTypeCode,
  type Settings,
  type StageChange,
  type StageCode,
} from './rules';

/**
 * Product Development Plan tracker (pdt_* tables, migrations 0080 + 0081; rules in ./rules.ts; Excel import in
 * ./importService.ts; docs/product-development-standalone.md). Reads load every live product once and filter in memory
 * (the register is small); writes run in one transaction and end with an audit_log row. Errors are PdpError
 * `{ code, field }` like the gate module.
 */

export const ENTITY = { product: 'pdt_product', update: 'pdt_status_update', blocker: 'pdt_blocker', dropdown: 'pdt_dropdown', settings: 'pdt_setting', import: 'pdt_import' } as const;

type Body = Record<string, unknown>;
export const fail = (code: string, message: string, field?: string): PdpError => new PdpError(code, message, field);

// ---------------------------------------------------------------------------------------------------------------------
// Settings and drop-downs
// ---------------------------------------------------------------------------------------------------------------------

export async function getSettings(db: Db = pool): Promise<Settings> {
  const r = await rows<{ setting_key: string; setting_value: number }>(db, 'SELECT setting_key, setting_value FROM pdt_setting');
  const byKey = new Map(r.map((x) => [x.setting_key, Number(x.setting_value)]));
  const out = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(SETTING_KEYS) as (keyof Settings)[]) {
    const v = byKey.get(SETTING_KEYS[k]);
    if (v !== undefined && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

export async function updateSettings(input: Body, uid: number): Promise<Settings> {
  const before = await getSettings();
  const changes: [string, number][] = [];
  for (const k of Object.keys(SETTING_KEYS) as (keyof Settings)[]) {
    if (input[k] === undefined) continue;
    const v = Number(input[k]);
    const [min, max] = SETTING_RANGES[k];
    if (!Number.isInteger(v) || v < min || v > max) throw fail('settings.range', `Enter a whole number from ${min} to ${max}.`, k);
    changes.push([SETTING_KEYS[k], v]);
  }
  for (const [key, v] of changes) {
    await exec(pool, 'INSERT INTO pdt_setting (setting_key, setting_value, updated_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)', [key, v, uid]);
  }
  const after = await getSettings();
  await writeAuditLog({ entityType: ENTITY.settings, entityId: 'settings', action: 'UPDATE', changedBy: uid, before, after });
  return after;
}

export type ListKey = 'stage' | 'health' | 'priority' | 'category' | 'family' | 'project_type';

export interface DropdownValue {
  value_id: number;
  list_key: ListKey;
  code: string | null;
  label: string;
  description: string | null;
  color: string;
  sort_order: number;
  is_active: number;
  usage_count?: number;
}

export async function listDropdowns(db: Db = pool, withUsage = false): Promise<DropdownValue[]> {
  const usage = withUsage
    ? `, (SELECT COUNT(*) FROM pdt_product p WHERE p.deleted_at IS NULL AND d.value_id IN (p.family_id, p.priority_id, p.stage_id, p.health_id, p.project_type_id)) AS usage_count`
    : '';
  return rows<DropdownValue>(
    db,
    `SELECT d.value_id, d.list_key, d.code, d.label, d.description, d.color, d.sort_order, d.is_active${usage}
       FROM pdt_dropdown_value d
      WHERE d.list_key <> 'category'
      ORDER BY FIELD(d.list_key, 'stage', 'health', 'priority', 'family', 'project_type'), d.sort_order, d.label`,
  );
}

function colorOf(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(v)) throw fail('dropdown.color', 'Pick a colour like #8a6fdf.', 'color');
  return v;
}

function labelOf(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw fail('dropdown.labelRequired', 'Enter a label.', 'label');
  if (s.length > 100) throw fail('dropdown.labelTooLong', 'The label can be at most 100 characters.', 'label');
  return s;
}

async function assertLabelFree(db: Db, listKey: string, label: string, exceptId?: number): Promise<void> {
  const dup = await one<{ value_id: number }>(db, 'SELECT value_id FROM pdt_dropdown_value WHERE list_key = ? AND label = ? AND value_id <> ?', [listKey, label, exceptId ?? 0]);
  if (dup) throw fail('dropdown.duplicate', 'This list already has that label.', 'label');
}

/** Only families can be added: stages, health, priority and project type are fixed lists the rules / the file use. */
export async function createDropdown(input: Body, uid: number, db: Db = pool): Promise<DropdownValue> {
  if (input.listKey !== 'family') throw fail('dropdown.fixedList', 'Only families can be added; the other lists are fixed (edit their labels and colours).', 'listKey');
  const label = labelOf(input.label);
  await assertLabelFree(db, 'family', label);
  const max = await one<{ m: number | null }>(db, "SELECT MAX(sort_order) AS m FROM pdt_dropdown_value WHERE list_key = 'family'");
  const description = typeof input.description === 'string' && input.description.trim() ? input.description.trim().slice(0, 500) : null;
  const { insertId } = await exec(db, "INSERT INTO pdt_dropdown_value (list_key, label, description, color, sort_order, created_by, updated_by) VALUES ('family', ?, ?, ?, ?, ?, ?)", [
    label, description, colorOf(input.color) ?? '#8a94a6', Number(max?.m ?? 0) + 1, uid, uid,
  ]);
  const row = (await one<DropdownValue>(db, 'SELECT * FROM pdt_dropdown_value WHERE value_id = ?', [insertId]))!;
  await writeAuditLog({ entityType: ENTITY.dropdown, entityId: String(insertId), action: 'CREATE', changedBy: uid, after: row });
  return row;
}

export async function updateDropdown(id: number, input: Body, uid: number): Promise<DropdownValue> {
  const existing = await one<DropdownValue>(pool, 'SELECT * FROM pdt_dropdown_value WHERE value_id = ?', [id]);
  if (!existing) throw notFound('dropdown');
  const label = input.label === undefined ? existing.label : labelOf(input.label);
  if (label !== existing.label) await assertLabelFree(pool, existing.list_key, label, id);
  const color = colorOf(input.color) ?? existing.color;
  const sort = input.sortOrder === undefined ? existing.sort_order : Number(input.sortOrder);
  if (!Number.isInteger(sort)) throw fail('dropdown.sortOrder', 'The order must be a whole number.', 'sortOrder');
  const description = input.description === undefined ? existing.description : typeof input.description === 'string' && input.description.trim() ? input.description.trim().slice(0, 500) : null;
  let active = existing.is_active ? 1 : 0;
  if (input.isActive !== undefined) {
    // A fixed value (stage / health / priority / project type) is always needed by the rules and the file.
    if (existing.code && !input.isActive) throw fail('dropdown.fixedValue', 'Stage, health, priority and project type values cannot be deactivated.', 'isActive');
    active = input.isActive ? 1 : 0;
  }
  await exec(pool, 'UPDATE pdt_dropdown_value SET label = ?, description = ?, color = ?, sort_order = ?, is_active = ?, updated_by = ? WHERE value_id = ?', [label, description, color, sort, active, uid, id]);
  const row = (await one<DropdownValue>(pool, 'SELECT * FROM pdt_dropdown_value WHERE value_id = ?', [id]))!;
  await writeAuditLog({ entityType: ENTITY.dropdown, entityId: String(id), action: 'UPDATE', changedBy: uid, before: existing, after: row });
  return row;
}

export async function deleteDropdown(id: number, uid: number): Promise<void> {
  const existing = await one<DropdownValue>(pool, 'SELECT * FROM pdt_dropdown_value WHERE value_id = ?', [id]);
  if (!existing) throw notFound('dropdown');
  if (existing.code) throw fail('dropdown.fixedValue', 'Stage, health, priority and project type values cannot be deleted.');
  const used = await one<{ n: number }>(pool, 'SELECT COUNT(*) AS n FROM pdt_product WHERE family_id = ? OR category_id = ?', [id, id]);
  if (Number(used?.n ?? 0) > 0) throw fail('dropdown.inUse', 'Products use this family (deleted ones included). Deactivate it instead.');
  await exec(pool, 'DELETE FROM pdt_dropdown_value WHERE value_id = ?', [id]);
  await writeAuditLog({ entityType: ENTITY.dropdown, entityId: String(id), action: 'DELETE', changedBy: uid, before: existing });
}

/** value_id of a fixed code (stage / health / priority / project type). */
export async function codeId(db: Db, listKey: 'stage' | 'health' | 'priority' | 'project_type', code: string): Promise<number> {
  const r = await one<{ value_id: number }>(db, 'SELECT value_id FROM pdt_dropdown_value WHERE list_key = ? AND code = ?', [listKey, code]);
  if (!r) throw new Error(`pdt_dropdown_value ${listKey}/${code} is missing (migrations 0080 / 0081)`);
  return r.value_id;
}

const codeIdOrNull = async (db: Db, listKey: 'health' | 'priority' | 'project_type', code: string | null): Promise<number | null> => (code ? codeId(db, listKey, code) : null);

export interface OwnerOption {
  user_id: number;
  display_name: string;
}

export async function listOwnerUsers(): Promise<OwnerOption[]> {
  return rows<OwnerOption>(pool, "SELECT user_id, display_name FROM app_user WHERE is_active = 1 AND status <> 'INACTIVE' ORDER BY display_name");
}

export async function getOptions() {
  const [dropdowns, settings, users, owners, subfamilies, brands] = await Promise.all([
    listDropdowns(),
    getSettings(),
    listOwnerUsers(),
    rows<{ owner_name: string }>(pool, 'SELECT DISTINCT owner_name FROM pdt_product WHERE deleted_at IS NULL AND owner_name IS NOT NULL UNION SELECT DISTINCT owner_name FROM pdt_blocker WHERE deleted_at IS NULL AND owner_name IS NOT NULL ORDER BY owner_name'),
    rows<{ family_id: number; subfamily: string }>(pool, 'SELECT DISTINCT family_id, subfamily FROM pdt_product WHERE deleted_at IS NULL AND subfamily IS NOT NULL ORDER BY subfamily'),
    rows<{ brand: string }>(pool, 'SELECT DISTINCT brand FROM pdt_product WHERE deleted_at IS NULL ORDER BY brand'),
  ]);
  return {
    dropdowns, settings, users, today: businessToday(),
    owners: owners.map((o) => o.owner_name),
    subfamilies: subfamilies.map((s) => ({ familyId: s.family_id, subfamily: s.subfamily })),
    // "Unassigned" (blank in the file) last.
    brands: brands.map((b) => b.brand).sort((a, b) => Number(a === UNASSIGNED_BRAND) - Number(b === UNASSIGNED_BRAND) || a.localeCompare(b)),
    stages: STAGES, healths: HEALTHS, priorities: PRIORITIES, projectTypes: PROJECT_TYPES, blockerKinds: BLOCKER_KINDS, blockerStatuses: BLOCKER_STATUSES,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------------------------------

interface ProductDbRow {
  product_id: number;
  code: string;
  name: string;
  family_id: number | null;
  family: string | null;
  subfamily: string | null;
  brand: string | null;
  owner_user_id: number | null;
  owner_name: string | null;
  priority: PriorityCode | null;
  stage: StageCode;
  health: HealthCode | null;
  readiness_pct: number | null;
  target_launch: unknown;
  actual_launch: unknown;
  project_type: ProjectTypeCode | null;
  next_step: string | null;
  next_step_due: unknown;
  health_review_required: number;
  stage_since: unknown;
  last_update_at: unknown;
  created_at: unknown;
}

const PRODUCT_SELECT = `
  SELECT p.product_id, p.code, p.name, p.family_id, f.label AS family, p.subfamily, p.brand, p.owner_user_id, p.owner_name,
         pr.code AS priority, st.code AS stage, h.code AS health, p.readiness_pct, p.target_launch, p.actual_launch,
         pt.code AS project_type, p.next_step, p.next_step_due, p.health_review_required, p.stage_since, p.last_update_at, p.created_at
    FROM pdt_product p
    JOIN pdt_dropdown_value st ON st.value_id = p.stage_id
    LEFT JOIN pdt_dropdown_value f ON f.value_id = p.family_id
    LEFT JOIN pdt_dropdown_value pr ON pr.value_id = p.priority_id
    LEFT JOIN pdt_dropdown_value h ON h.value_id = p.health_id
    LEFT JOIN pdt_dropdown_value pt ON pt.value_id = p.project_type_id
   WHERE p.deleted_at IS NULL`;

/** created_at is a UTC instant; its business-zone date starts the stale clock. */
const createdOnOf = (v: unknown): string => {
  const iso = isoDateTime(v);
  return iso ? businessToday(new Date(iso)) : businessToday();
};

function toProduct(r: ProductDbRow): Product {
  return {
    productId: r.product_id,
    code: r.code,
    name: r.name,
    familyId: r.family_id,
    family: r.family,
    subfamily: r.subfamily,
    brand: r.brand?.trim() || UNASSIGNED_BRAND,
    ownerUserId: r.owner_user_id,
    ownerName: r.owner_name,
    priority: r.priority,
    stage: r.stage,
    health: r.health,
    readinessPct: r.readiness_pct === null ? null : Number(r.readiness_pct),
    targetLaunch: isoDate(r.target_launch),
    actualLaunch: isoDate(r.actual_launch),
    projectType: r.project_type,
    nextStep: r.next_step,
    nextStepDue: isoDate(r.next_step_due),
    healthReviewRequired: Boolean(r.health_review_required),
    stageSince: isoDate(r.stage_since)!,
    lastUpdateAt: isoDate(r.last_update_at),
    createdOn: createdOnOf(r.created_at),
  };
}

/** Code order: XT-002 before XT-010 (numeric part). */
const byCode = (a: { code: string }, b: { code: string }) => a.code.localeCompare(b.code, undefined, { numeric: true });

export async function loadProducts(db: Db = pool): Promise<Product[]> {
  const r = await rows<ProductDbRow>(db, PRODUCT_SELECT);
  return r.map(toProduct).sort(byCode);
}

interface BlockerDbRow {
  blocker_id: number;
  external_id: string | null;
  product_id: number;
  kind: BlockerKind;
  title: string;
  required_action: string;
  owner_user_id: number | null;
  owner_name: string | null;
  raised_on: unknown;
  due_date: unknown;
  status: BlockerStatus;
  resolution_note: string | null;
  resolved_at: unknown;
  updated_at: unknown;
  updated_by_name: string | null;
}

export interface BlockerView extends Blocker {
  ownerUserId: number | null;
  raisedOn: string | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

function toBlocker(r: BlockerDbRow): BlockerView {
  return {
    blockerId: r.blocker_id,
    externalId: r.external_id,
    productId: r.product_id,
    kind: r.kind,
    title: r.title,
    requiredAction: r.required_action,
    ownerUserId: r.owner_user_id,
    ownerName: r.owner_name,
    raisedOn: isoDate(r.raised_on),
    dueDate: isoDate(r.due_date)!,
    status: r.status,
    resolutionNote: r.resolution_note,
    resolvedAt: isoDate(r.resolved_at),
    updatedAt: isoDateTime(r.updated_at),
    updatedBy: r.updated_by_name,
  };
}

export async function loadBlockers(db: Db = pool, productId?: number): Promise<BlockerView[]> {
  const r = await rows<BlockerDbRow>(
    db,
    `SELECT b.*, u.display_name AS updated_by_name FROM pdt_blocker b
       JOIN pdt_product p ON p.product_id = b.product_id AND p.deleted_at IS NULL
       LEFT JOIN app_user u ON u.user_id = b.updated_by
      WHERE b.deleted_at IS NULL ${productId ? 'AND b.product_id = ?' : ''}
      ORDER BY b.due_date, b.blocker_id`,
    productId ? [productId] : [],
  );
  return r.map(toBlocker);
}

/**
 * The current next step of each product: the one on its latest status update when not done yet, otherwise the
 * product's own Next step (the Excel Products sheet's column).
 */
async function loadOpenNextSteps(products: Product[], db: Db = pool): Promise<OpenNextStep[]> {
  const r = await rows<{ update_id: number; product_id: number; next_step: string | null; next_step_due: unknown; next_step_done_at: unknown }>(
    db,
    `SELECT u.update_id, u.product_id, u.next_step, u.next_step_due, u.next_step_done_at
       FROM pdt_status_update u
      WHERE u.deleted_at IS NULL
        AND u.update_id = (SELECT u2.update_id FROM pdt_status_update u2 WHERE u2.product_id = u.product_id AND u2.deleted_at IS NULL
                            ORDER BY u2.update_date DESC, u2.update_id DESC LIMIT 1)`,
  );
  const latest = new Map(r.map((x) => [x.product_id, x]));
  const out: OpenNextStep[] = [];
  for (const p of products) {
    const u = latest.get(p.productId);
    if (u && u.next_step && u.next_step_due) {
      if (!u.next_step_done_at) out.push({ updateId: u.update_id, productId: p.productId, nextStep: u.next_step, nextStepDue: isoDate(u.next_step_due)!, ownerName: p.ownerName });
    } else if (p.nextStep && p.nextStepDue) {
      out.push({ updateId: null, productId: p.productId, nextStep: p.nextStep, nextStepDue: p.nextStepDue, ownerName: p.ownerName });
    }
  }
  return out;
}

async function familyList(db: Db = pool): Promise<{ familyId: number; family: string; description: string | null; color: string }[]> {
  const r = await rows<{ value_id: number; label: string; description: string | null; color: string }>(
    db, "SELECT value_id, label, description, color FROM pdt_dropdown_value WHERE list_key = 'family' AND is_active = 1 ORDER BY sort_order, label",
  );
  return r.map((x) => ({ familyId: x.value_id, family: x.label, description: x.description, color: x.color }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Dashboard and follow-up
// ---------------------------------------------------------------------------------------------------------------------

export interface ProductCard extends Product {
  stale: boolean;
  openBlockers: number;
  flag: FlagCode | null;
  flagLabel: string | null;
}

function cards(products: Product[], blockers: Blocker[], today: string, s: Settings): ProductCard[] {
  const open = new Map<number, number>();
  for (const b of blockers) if (b.status === 'OPEN' || b.status === 'IN_PROGRESS') open.set(b.productId, (open.get(b.productId) ?? 0) + 1);
  return products.map((p) => {
    const flag = productFlag(p, open.get(p.productId) ?? 0, today, s);
    return { ...p, stale: isStale(p, today, s.staleDays), openBlockers: open.get(p.productId) ?? 0, flag, flagLabel: flag ? FLAG_LABEL[flag] : null };
  });
}

/** When the Excel file was last imported (the dashboard's "last refresh"); null before the first import. */
async function lastImportAt(): Promise<string | null> {
  const r = await one<{ at: unknown }>(pool, 'SELECT MAX(imported_at) AS at FROM pdt_import_log');
  return isoDateTime(r?.at);
}

export async function getDashboard(filters: Filters, today = businessToday()) {
  const [all, blockers, settings, dropdowns, families, lastImport] = await Promise.all([loadProducts(), loadBlockers(), getSettings(), listDropdowns(), familyList(), lastImportAt()]);
  const products = applyFilters(all, filters);
  const ids = new Set(products.map((p) => p.productId));
  const inView = blockers.filter((b) => ids.has(b.productId));
  const byId = new Map(products.map((p) => [p.productId, p]));
  const productCards = cards(products, inView, today, settings);
  const stageList = dropdowns.filter((d) => d.list_key === 'stage');
  // The roadmap shows exactly the "Launches in next N days" products (same window, same rule).
  const roadmap = buildRoadmap(products, today, settings.upcomingWindowDays);
  // The stage tiles keep every stage visible while one is selected: the same filters without the stage filter.
  const summarySet = filters.stages.length ? applyFilters(all, { ...filters, stages: [] }) : products;
  const summaryKpis = computeKpis(summarySet, today, settings);
  return {
    today,
    settings,
    lastImport,
    totalProducts: all.length,
    kpis: computeKpis(products, today, settings),
    /** The product codes behind each KPI card (the drill-down tables), same filtered set as the cards. */
    kpiCodes: kpiSets(products, today, settings),
    stageSummary: {
      stages: stageSummary(summarySet, today).map((st) => ({
        ...st,
        label: stageList.find((x) => x.code === st.stage)?.label ?? st.stage,
        color: stageList.find((x) => x.code === st.stage)?.color ?? '#8a94a6',
        // The pipeline tooltip: the first products of the stage (nearest target first; launched: latest launch first).
        top: summarySet
          .filter((p) => p.stage === st.stage)
          .sort((x, y) => (st.stage === 'LAUNCHED' ? (y.actualLaunch ?? '').localeCompare(x.actualLaunch ?? '') : (x.targetLaunch ?? '9999').localeCompare(y.targetLaunch ?? '9999')))
          .slice(0, 5)
          .map((p) => ({ code: p.code, name: p.name, date: st.stage === 'LAUNCHED' ? p.actualLaunch : p.targetLaunch })),
      })),
      // In pipeline = every product not launched yet (Active + Planned), so total = in pipeline + in market.
      totals: { total: summaryKpis.total, inPipeline: summaryKpis.total - summaryKpis.inMarket, inMarket: summaryKpis.inMarket },
    },
    pipeline: stageList.map((st) => ({ stage: st.code as StageCode, label: st.label, color: st.color, products: productCards.filter((p) => p.stage === st.code) })),
    // The matrix lists every family even under a family filter, so the selected row stays in context.
    matrix: familyStageMatrix(products, families),
    tracker: productCards,
    roadmap: {
      months: roadmap.months.map((m) => ({ month: m.month, products: m.products.map((p) => ({ code: p.code, name: p.name, family: p.family, targetLaunch: p.targetLaunch, health: p.health })) })),
      outsideWindow: roadmap.outsideWindow,
      windowEnd: roadmap.windowEnd,
    },
    byYear: launchesByYear(products),
    blockers: openBlockers(inView, today).map((b) => ({ ...b, productCode: byId.get(b.productId)!.code, productName: byId.get(b.productId)!.name })),
  };
}

export async function getFollowup(filters: Filters, today = businessToday()) {
  const [all, blockers, settings] = await Promise.all([loadProducts(), loadBlockers(), getSettings()]);
  // The owner filter applies to the item's owner (a blocker can belong to someone else than the product owner).
  const owners = filters.owners.map((o) => o.toLowerCase());
  const products = applyFilters(all, { ...filters, owners: [] });
  const nextSteps = await loadOpenNextSteps(products);
  const items = buildFollowup(products, blockers, nextSteps, today, settings);
  return { today, settings, items: owners.length ? items.filter((i) => owners.includes((i.ownerName ?? NOT_SET).toLowerCase())) : items };
}

// ---------------------------------------------------------------------------------------------------------------------
// One product
// ---------------------------------------------------------------------------------------------------------------------

async function productRowByCode(db: Db, code: string, lock = false): Promise<(ProductDbRow & { stage_id: number }) | undefined> {
  return one(db, `${PRODUCT_SELECT.replace('SELECT p.product_id', 'SELECT p.stage_id, p.product_id')} AND p.code = ?${lock ? ' FOR UPDATE' : ''}`, [code]);
}

async function requireProduct(db: Db, code: string, lock = false) {
  const r = await productRowByCode(db, code, lock);
  if (!r) throw notFound('product');
  return r;
}

export async function getProduct(code: string, today = businessToday()) {
  const r = await requireProduct(pool, code);
  const product = toProduct(r);
  const [history, updates, blockers, extra, settings] = await Promise.all([
    rows<{ history_id: number; from_stage: StageCode | null; to_stage: StageCode; changed_on: unknown; changed_at: unknown; changed_by: string | null; comment: string }>(
      pool,
      `SELECT h.history_id, f.code AS from_stage, t.code AS to_stage, h.changed_on, h.changed_at, u.display_name AS changed_by, h.comment
         FROM pdt_stage_history h
         LEFT JOIN pdt_dropdown_value f ON f.value_id = h.from_stage_id
         JOIN pdt_dropdown_value t ON t.value_id = h.to_stage_id
         LEFT JOIN app_user u ON u.user_id = h.changed_by
        WHERE h.product_id = ?`,
      [product.productId],
    ),
    rows<Record<string, unknown>>(
      pool,
      `SELECT su.update_id, su.update_date, h.code AS health, su.readiness_pct, su.summary, su.next_step, su.next_step_due, su.next_step_done_at,
              su.updated_at, COALESCE(su.updated_by_name, u.display_name) AS updated_by
         FROM pdt_status_update su
         LEFT JOIN pdt_dropdown_value h ON h.value_id = su.health_id
         LEFT JOIN app_user u ON u.user_id = su.updated_by
        WHERE su.product_id = ? AND su.deleted_at IS NULL
        ORDER BY su.update_date DESC, su.update_id DESC`,
      [product.productId],
    ),
    loadBlockers(pool, product.productId),
    one<{ description: string | null; notes: string | null; comment: string | null; updated_at: unknown; updated_by: string | null; created_at: unknown; created_by: string | null; updated_by_name: string | null; last_edited_on: unknown }>(
      pool,
      `SELECT p.description, p.notes, p.comment, p.updated_at, uu.display_name AS updated_by, p.created_at, cu.display_name AS created_by, p.updated_by_name, p.last_edited_on
         FROM pdt_product p LEFT JOIN app_user uu ON uu.user_id = p.updated_by LEFT JOIN app_user cu ON cu.user_id = p.created_by
        WHERE p.product_id = ?`,
      [product.productId],
    ),
    getSettings(),
  ]);
  const timeline: StageChange[] = history.map((h) => ({
    historyId: h.history_id, fromStage: h.from_stage, toStage: h.to_stage, changedOn: isoDate(h.changed_on)!, changedAt: isoDateTime(h.changed_at), changedBy: h.changed_by, comment: h.comment,
  }));
  const open = blockers.filter((b) => b.status === 'OPEN' || b.status === 'IN_PROGRESS').length;
  const flag = productFlag(product, open, today, settings);
  return {
    product: {
      ...product, description: extra?.description ?? null, notes: extra?.notes ?? null, comment: extra?.comment ?? null,
      stale: isStale(product, today, settings.staleDays), flag, flagLabel: flag ? FLAG_LABEL[flag] : null,
    },
    history: withDaysInStage(timeline, today),
    updates: updates.map((u) => ({
      updateId: u.update_id, updateDate: isoDate(u.update_date), health: u.health, readinessPct: u.readiness_pct === null ? null : Number(u.readiness_pct), summary: u.summary,
      nextStep: u.next_step, nextStepDue: isoDate(u.next_step_due), nextStepDoneAt: isoDate(u.next_step_done_at), updatedAt: isoDateTime(u.updated_at), updatedBy: u.updated_by,
    })),
    blockers,
    audit: {
      updatedAt: isoDateTime(extra?.updated_at), updatedBy: extra?.updated_by ?? null, createdAt: isoDateTime(extra?.created_at), createdBy: extra?.created_by ?? null,
      // The Excel "Last updated" / "Updated by" columns, as the business filled them.
      excelUpdatedOn: isoDate(extra?.last_edited_on), excelUpdatedBy: extra?.updated_by_name ?? null,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------------------------------------------------

export const text = (v: unknown, max: number, field: string, required = false): string | null => {
  const s = typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim();
  if (!s) {
    if (required) throw fail(`${field}.required`, 'This field is required.', field);
    return null;
  }
  if (s.length > max) throw fail(`${field}.tooLong`, `At most ${max} characters.`, field);
  return s;
};

const dateOrNull = (v: unknown, field: string): string | null => {
  if (v === undefined || v === null || v === '') return null;
  if (!isValidIsoDate(v)) throw fail('date.invalid', 'Enter a valid date.', field);
  return v;
};

function enumOf<T extends string>(v: unknown, list: readonly T[], field: string): T {
  if (typeof v === 'string' && (list as readonly string[]).includes(v)) return v as T;
  throw fail(`${field}.invalid`, 'Pick a value from the list.', field);
}

/** An optional list value: '' / null / 'NONE' = not set. */
function optionalEnum<T extends string>(v: unknown, list: readonly T[], field: string): T | null {
  if (v === undefined || v === null || v === '' || v === NOT_SET) return null;
  return enumOf(v, list, field);
}

async function familyIdOf(v: unknown): Promise<number | null> {
  if (v === undefined || v === null || v === '') return null;
  const id = Number(v);
  const r = Number.isInteger(id) ? await one<{ value_id: number }>(pool, "SELECT value_id FROM pdt_dropdown_value WHERE list_key = 'family' AND value_id = ?", [id]) : undefined;
  if (!r) throw fail('family.invalid', 'Pick a family.', 'familyId');
  return r.value_id;
}

/** ownerUserId (an app user) wins; otherwise ownerName as typed; nothing = owner not set. */
async function ownerOf(input: Body, field = 'owner'): Promise<{ userId: number | null; name: string | null }> {
  if (input.ownerUserId !== undefined && input.ownerUserId !== null && input.ownerUserId !== '') {
    const u = await one<{ user_id: number; display_name: string }>(pool, 'SELECT user_id, display_name FROM app_user WHERE user_id = ?', [Number(input.ownerUserId)]);
    if (!u) throw fail('owner.invalid', 'Pick an owner from the list.', field);
    return { userId: u.user_id, name: u.display_name };
  }
  return { userId: null, name: text(input.ownerName, 150, field) };
}

const readinessOf = (v: unknown): number | null => (v === undefined || v === null || v === '' ? null : Number(v));

function throwFirst(problems: { code: string; field: string; message: string }[]): void {
  if (problems.length) throw fail(problems[0].code, problems[0].message, problems[0].field);
}

export async function assertNameFree(db: Db, name: string, exceptId = 0): Promise<void> {
  // utf8mb4_unicode_ci: the comparison ignores case and trailing spaces.
  const dup = await one<{ code: string }>(db, 'SELECT code FROM pdt_product WHERE deleted_at IS NULL AND name = ? AND product_id <> ?', [name, exceptId]);
  if (dup) throw fail('product.nameTaken', `An active product (${dup.code}) already has this name.`, 'name');
}

export async function unresolvedBlockers(db: Db, productId: number): Promise<{ kind: BlockerKind; status: BlockerStatus }[]> {
  return rows(db, "SELECT kind, status FROM pdt_blocker WHERE product_id = ? AND deleted_at IS NULL AND status IN ('OPEN', 'IN_PROGRESS')", [productId]);
}

export async function nextProductCode(db: Db): Promise<string> {
  const used = await rows<{ code: string }>(db, "SELECT code FROM pdt_product WHERE code LIKE 'XT-%'");
  return nextCode('XT', used.map((u) => u.code));
}

export async function nextBlockerId(db: Db): Promise<string> {
  const used = await rows<{ external_id: string }>(db, "SELECT external_id FROM pdt_blocker WHERE external_id LIKE 'BL-%'");
  return nextCode('BL', used.map((u) => u.external_id));
}

export interface HealthNotice {
  /** The product was set to Blocked because a Blocker is open. */
  healthForced: boolean;
  /** The last Blocker was resolved: the owner must choose the new health. */
  healthReviewRequired: boolean;
}

/**
 * Applies the blocker rule after any change to a product's blockers:
 *   unresolved Blocker -> health Blocked (healthForced when it changed);
 *   none left while health is Blocked and was forced -> health_review_required (health stays Blocked until set).
 */
export async function syncBlockerHealth(conn: PoolConnection, productId: number, uid: number | null, hadForced: boolean): Promise<HealthNotice> {
  const p = await one<{ health: HealthCode | null; health_review_required: number }>(
    conn, 'SELECT h.code AS health, p.health_review_required FROM pdt_product p LEFT JOIN pdt_dropdown_value h ON h.value_id = p.health_id WHERE p.product_id = ? FOR UPDATE', [productId],
  );
  if (!p) return { healthForced: false, healthReviewRequired: false };
  const forced = forcedHealth(await unresolvedBlockers(conn, productId));
  if (forced) {
    if (p.health !== 'BLOCKED' || p.health_review_required) {
      await exec(conn, 'UPDATE pdt_product SET health_id = ?, health_review_required = 0, updated_by = ? WHERE product_id = ?', [await codeId(conn, 'health', 'BLOCKED'), uid, productId]);
    }
    return { healthForced: p.health !== 'BLOCKED', healthReviewRequired: false };
  }
  if (hadForced && p.health === 'BLOCKED') {
    await exec(conn, 'UPDATE pdt_product SET health_review_required = 1, updated_by = ? WHERE product_id = ?', [uid, productId]);
    return { healthForced: false, healthReviewRequired: true };
  }
  return { healthForced: false, healthReviewRequired: Boolean(p.health_review_required) };
}

async function auditProduct(code: string, action: 'CREATE' | 'UPDATE' | 'DELETE', uid: number, before?: unknown, after?: unknown): Promise<void> {
  await writeAuditLog({ entityType: ENTITY.product, entityId: code, action, changedBy: uid, before, after });
}

// ---------------------------------------------------------------------------------------------------------------------
// Product writes
// ---------------------------------------------------------------------------------------------------------------------

export async function createProduct(input: Body, uid: number, today = businessToday()) {
  const name = text(input.name, 150, 'name', true)!;
  const stage = input.stage === undefined ? 'IDEA' : enumOf(input.stage, STAGES, 'stage');
  const health = optionalEnum(input.health, HEALTHS, 'health');
  const priority = optionalEnum(input.priority, PRIORITIES, 'priority');
  const projectType = optionalEnum(input.projectType, PROJECT_TYPES, 'projectType');
  const readinessPct = readinessOf(input.readinessPct);
  const targetLaunch = dateOrNull(input.targetLaunch, 'targetLaunch');
  const actualLaunch = dateOrNull(input.actualLaunch, 'actualLaunch');
  throwFirst(productProblems({ name, stage, readinessPct, targetLaunch, actualLaunch }));
  // A new product has no blockers yet, so Blocked would never be explained: refuse it.
  if (health === 'BLOCKED') throw fail('health.blockedNeedsBlocker', 'Add a Blocker to set a product to Blocked.', 'health');
  const familyId = await familyIdOf(input.familyId);
  const owner = await ownerOf(input);
  const fields = {
    subfamily: text(input.subfamily, 100, 'subfamily'),
    description: text(input.description, 5000, 'description'),
    notes: text(input.notes, 5000, 'notes'),
    nextStep: text(input.nextStep, 300, 'nextStep'),
    nextStepDue: dateOrNull(input.nextStepDue, 'nextStepDue'),
    comment: text(input.comment, 5000, 'comment'),
  };
  const historyComment = text(input.stageComment, 500, 'stageComment') ?? 'Product created';
  const created = await inTransaction(async (conn) => {
    await assertNameFree(conn, name);
    const code = await nextProductCode(conn);
    const stageId = await codeId(conn, 'stage', stage);
    const { insertId } = await exec(
      conn,
      `INSERT INTO pdt_product (code, name, family_id, subfamily, owner_user_id, owner_name, priority_id, stage_id, health_id, readiness_pct, target_launch, actual_launch,
                                project_type_id, description, notes, next_step, next_step_due, comment, stage_since, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [code, name, familyId, fields.subfamily, owner.userId, owner.name, await codeIdOrNull(conn, 'priority', priority), stageId, await codeIdOrNull(conn, 'health', health), readinessPct,
        targetLaunch, actualLaunch, await codeIdOrNull(conn, 'project_type', projectType), fields.description, fields.notes, fields.nextStep, fields.nextStepDue, fields.comment, today, uid, uid],
    );
    await exec(conn, 'INSERT INTO pdt_stage_history (product_id, from_stage_id, to_stage_id, changed_on, changed_by, comment) VALUES (?, NULL, ?, ?, ?, ?)', [insertId, stageId, today, uid, historyComment]);
    return code;
  });
  const out = await getProduct(created, today);
  await auditProduct(created, 'CREATE', uid, undefined, out.product);
  return out;
}

/** Edits everything but the stage (that is POST /stage, with a comment). Setting health clears the health review. */
export async function updateProduct(code: string, input: Body, uid: number, today = businessToday()) {
  const before = await getProduct(code, today);
  const p = before.product;
  if (input.stage !== undefined && input.stage !== p.stage) throw fail('product.stageViaAction', 'Use "Change stage" to move a product to another stage.', 'stage');
  const has = (k: string) => input[k] !== undefined;
  const name = has('name') ? text(input.name, 150, 'name', true)! : p.name;
  const health = has('health') ? optionalEnum(input.health, HEALTHS, 'health') : p.health;
  const priority = has('priority') ? optionalEnum(input.priority, PRIORITIES, 'priority') : p.priority;
  const projectType = has('projectType') ? optionalEnum(input.projectType, PROJECT_TYPES, 'projectType') : p.projectType;
  const readinessPct = has('readinessPct') ? readinessOf(input.readinessPct) : p.readinessPct;
  const targetLaunch = has('targetLaunch') ? dateOrNull(input.targetLaunch, 'targetLaunch') : p.targetLaunch;
  const actualLaunch = has('actualLaunch') ? dateOrNull(input.actualLaunch, 'actualLaunch') : p.actualLaunch;
  throwFirst(productProblems({ name, stage: p.stage, readinessPct, targetLaunch, actualLaunch }));
  const familyId = has('familyId') ? await familyIdOf(input.familyId) : p.familyId;
  const owner = has('ownerUserId') || has('ownerName') ? await ownerOf(input) : { userId: p.ownerUserId, name: p.ownerName };
  const f = {
    subfamily: has('subfamily') ? text(input.subfamily, 100, 'subfamily') : p.subfamily,
    description: has('description') ? text(input.description, 5000, 'description') : p.description,
    notes: has('notes') ? text(input.notes, 5000, 'notes') : p.notes,
    nextStep: has('nextStep') ? text(input.nextStep, 300, 'nextStep') : p.nextStep,
    nextStepDue: has('nextStepDue') ? dateOrNull(input.nextStepDue, 'nextStepDue') : p.nextStepDue,
    comment: has('comment') ? text(input.comment, 5000, 'comment') : p.comment,
  };
  await inTransaction(async (conn) => {
    await requireProduct(conn, code, true);
    await assertNameFree(conn, name, p.productId);
    const forced = forcedHealth(await unresolvedBlockers(conn, p.productId));
    if (forced && health !== 'BLOCKED') throw fail('health.blockedByBlocker', 'This product has an open Blocker, so its health stays Blocked until the Blocker is resolved.', 'health');
    // Only when the request sets health: other fields stay editable while the owner still has to pick the new health.
    if (!forced && has('health') && health === 'BLOCKED') throw fail('health.blockedNeedsBlocker', 'Add a Blocker to set a product to Blocked.', 'health');
    await exec(
      conn,
      `UPDATE pdt_product SET name = ?, family_id = ?, subfamily = ?, owner_user_id = ?, owner_name = ?, priority_id = ?, health_id = ?, readiness_pct = ?,
              target_launch = ?, actual_launch = ?, project_type_id = ?, description = ?, notes = ?, next_step = ?, next_step_due = ?, comment = ?,
              health_review_required = IF(?, 0, health_review_required), updated_by = ?
        WHERE product_id = ?`,
      [name, familyId, f.subfamily, owner.userId, owner.name, await codeIdOrNull(conn, 'priority', priority), await codeIdOrNull(conn, 'health', health), readinessPct,
        targetLaunch, actualLaunch, await codeIdOrNull(conn, 'project_type', projectType), f.description, f.notes, f.nextStep, f.nextStepDue, f.comment, has('health') ? 1 : 0, uid, p.productId],
    );
  });
  const after = await getProduct(code, today);
  await auditProduct(code, 'UPDATE', uid, p, after.product);
  return after;
}

export async function changeStage(code: string, input: Body, uid: number, today = businessToday()) {
  const before = await getProduct(code, today);
  const p = before.product;
  const to = enumOf(input.toStage, STAGES, 'toStage');
  if (to === p.stage) throw fail('stage.same', 'The product is already in this stage.', 'toStage');
  const comment = text(input.comment, 500, 'comment', true)!;
  // Moving to Launched needs the launch date; it may come with the request. A target may come too (leaving Idea).
  const actualLaunch = input.actualLaunch === undefined ? p.actualLaunch : dateOrNull(input.actualLaunch, 'actualLaunch');
  const targetLaunch = input.targetLaunch === undefined ? p.targetLaunch : dateOrNull(input.targetLaunch, 'targetLaunch');
  // Leaving Launch ready / Launched at 100% would break the readiness rule: cap it at 99.
  const readinessPct = p.readinessPct === 100 && !['LAUNCH_READY', 'LAUNCHED'].includes(to) ? 99 : p.readinessPct;
  throwFirst(productProblems({ name: p.name, stage: to, readinessPct, targetLaunch, actualLaunch }));
  await inTransaction(async (conn) => {
    const cur = await requireProduct(conn, code, true);
    const toId = await codeId(conn, 'stage', to);
    await exec(conn, 'UPDATE pdt_product SET stage_id = ?, stage_since = ?, actual_launch = ?, target_launch = ?, readiness_pct = ?, updated_by = ? WHERE product_id = ?', [toId, today, actualLaunch, targetLaunch, readinessPct, uid, p.productId]);
    await exec(conn, 'INSERT INTO pdt_stage_history (product_id, from_stage_id, to_stage_id, changed_on, changed_by, comment) VALUES (?, ?, ?, ?, ?, ?)', [p.productId, cur.stage_id, toId, today, uid, comment]);
  });
  const after = await getProduct(code, today);
  await auditProduct(code, 'UPDATE', uid, { stage: p.stage }, { stage: to, comment });
  return after;
}

export async function deleteProduct(code: string, uid: number): Promise<void> {
  const r = await requireProduct(pool, code);
  await exec(pool, 'UPDATE pdt_product SET deleted_at = UTC_TIMESTAMP(), deleted_by = ? WHERE product_id = ?', [uid, r.product_id]);
  await auditProduct(code, 'DELETE', uid, toProduct(r));
}

// ---------------------------------------------------------------------------------------------------------------------
// Status updates
// ---------------------------------------------------------------------------------------------------------------------

/** Copies the latest update's date (and its health / readiness when set) onto the product. */
export async function syncLatestUpdate(conn: PoolConnection, productId: number, uid: number | null, copyValues = true): Promise<void> {
  const latest = await one<{ update_date: unknown; health_id: number | null; readiness_pct: number | null }>(
    conn, 'SELECT update_date, health_id, readiness_pct FROM pdt_status_update WHERE product_id = ? AND deleted_at IS NULL ORDER BY update_date DESC, update_id DESC LIMIT 1', [productId],
  );
  if (!latest) {
    await exec(conn, 'UPDATE pdt_product SET last_update_at = NULL, updated_by = ? WHERE product_id = ?', [uid, productId]);
    return;
  }
  if (!copyValues) {
    await exec(conn, 'UPDATE pdt_product SET last_update_at = ?, updated_by = ? WHERE product_id = ?', [isoDate(latest.update_date), uid, productId]);
    return;
  }
  await exec(
    conn,
    `UPDATE pdt_product SET last_update_at = ?, health_id = COALESCE(?, health_id), readiness_pct = COALESCE(?, readiness_pct),
            health_review_required = IF(? IS NULL, health_review_required, 0), updated_by = ? WHERE product_id = ?`,
    [isoDate(latest.update_date), latest.health_id, latest.readiness_pct, latest.health_id, uid, productId],
  );
}

async function parseUpdate(input: Body, p: { stage: StageCode; name: string; targetLaunch: string | null; actualLaunch: string | null; health: HealthCode | null; readinessPct: number | null }, today: string, current?: Record<string, unknown>) {
  const has = (k: string) => input[k] !== undefined;
  const updateDate = has('updateDate') ? dateOrNull(input.updateDate, 'updateDate') : ((current?.updateDate as string) ?? today);
  if (!updateDate) throw fail('updateDate.required', 'Enter the update date.', 'updateDate');
  if (updateDate > today) throw fail('updateDate.future', 'The update date cannot be in the future.', 'updateDate');
  const health = has('health') ? optionalEnum(input.health, HEALTHS, 'health') : current ? ((current.health as HealthCode | null) ?? null) : p.health;
  const readinessPct = has('readinessPct') ? readinessOf(input.readinessPct) : current ? ((current.readinessPct as number | null) ?? null) : p.readinessPct;
  throwFirst(productProblems({ name: p.name, stage: p.stage, readinessPct, targetLaunch: p.targetLaunch, actualLaunch: p.actualLaunch }).filter((x) => x.field === 'readinessPct'));
  const summary = has('summary') ? text(input.summary, 5000, 'summary', true) : (current?.summary as string);
  if (!summary) throw fail('summary.required', 'Describe the progress.', 'summary');
  const nextStep = has('nextStep') ? text(input.nextStep, 300, 'nextStep') : ((current?.nextStep as string | null) ?? null);
  const nextStepDue = has('nextStepDue') ? dateOrNull(input.nextStepDue, 'nextStepDue') : ((current?.nextStepDue as string | null) ?? null);
  if (nextStep && !nextStepDue) throw fail('nextStepDue.required', 'Enter when the next step is due.', 'nextStepDue');
  if (nextStepDue && !nextStep) throw fail('nextStep.required', 'Describe the next step.', 'nextStep');
  return { updateDate, health, readinessPct, summary, nextStep, nextStepDue };
}

export async function postUpdate(code: string, input: Body, uid: number, today = businessToday()) {
  const { product: p } = await getProduct(code, today);
  const u = await parseUpdate(input, p, today);
  const id = await inTransaction(async (conn) => {
    await requireProduct(conn, code, true);
    const forced = forcedHealth(await unresolvedBlockers(conn, p.productId));
    if (forced && u.health !== 'BLOCKED') throw fail('health.blockedByBlocker', 'This product has an open Blocker, so its health stays Blocked until the Blocker is resolved.', 'health');
    if (!forced && u.health === 'BLOCKED') throw fail('health.blockedNeedsBlocker', 'Add a Blocker to set a product to Blocked.', 'health');
    const { insertId } = await exec(
      conn,
      `INSERT INTO pdt_status_update (product_id, update_date, health_id, readiness_pct, summary, next_step, next_step_due, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.productId, u.updateDate, await codeIdOrNull(conn, 'health', u.health), u.readinessPct, u.summary, u.nextStep, u.nextStepDue, uid, uid],
    );
    await syncLatestUpdate(conn, p.productId, uid);
    return insertId;
  });
  await writeAuditLog({ entityType: ENTITY.update, entityId: String(id), action: 'CREATE', changedBy: uid, after: { product: code, ...u } });
  return getProduct(code, today);
}

async function requireUpdate(id: number) {
  const r = await one<{ update_id: number; product_id: number; code: string; update_date: unknown; health: HealthCode | null; readiness_pct: number | null; summary: string; next_step: string | null; next_step_due: unknown; next_step_done_at: unknown }>(
    pool,
    `SELECT su.update_id, su.product_id, p.code, su.update_date, h.code AS health, su.readiness_pct, su.summary, su.next_step, su.next_step_due, su.next_step_done_at
       FROM pdt_status_update su JOIN pdt_product p ON p.product_id = su.product_id AND p.deleted_at IS NULL
       LEFT JOIN pdt_dropdown_value h ON h.value_id = su.health_id
      WHERE su.update_id = ? AND su.deleted_at IS NULL`,
    [id],
  );
  if (!r) throw notFound('update');
  return r;
}

/** Edit an update, or mark its next step done ({ nextStepDone: true | false }). */
export async function editUpdate(id: number, input: Body, uid: number, today = businessToday()) {
  const cur = await requireUpdate(id);
  const { product: p } = await getProduct(cur.code, today);
  const current = { updateDate: isoDate(cur.update_date), health: cur.health, readinessPct: cur.readiness_pct === null ? null : Number(cur.readiness_pct), summary: cur.summary, nextStep: cur.next_step, nextStepDue: isoDate(cur.next_step_due) };
  const u = await parseUpdate(input, p, today, current);
  const doneAt = input.nextStepDone === undefined ? isoDate(cur.next_step_done_at) : input.nextStepDone ? today : null;
  await inTransaction(async (conn) => {
    const forced = forcedHealth(await unresolvedBlockers(conn, p.productId));
    if (input.health !== undefined && forced && u.health !== 'BLOCKED') throw fail('health.blockedByBlocker', 'This product has an open Blocker, so its health stays Blocked until the Blocker is resolved.', 'health');
    await exec(
      conn,
      'UPDATE pdt_status_update SET update_date = ?, health_id = ?, readiness_pct = ?, summary = ?, next_step = ?, next_step_due = ?, next_step_done_at = ?, updated_by = ? WHERE update_id = ?',
      [u.updateDate, await codeIdOrNull(conn, 'health', u.health), u.readinessPct, u.summary, u.nextStep, u.nextStepDue, u.nextStep ? doneAt : null, uid, id],
    );
    // Only health/readiness edits move the product; marking a step done does not.
    if (input.health !== undefined || input.readinessPct !== undefined || input.updateDate !== undefined) await syncLatestUpdate(conn, p.productId, uid);
    await syncBlockerHealth(conn, p.productId, uid, false);
  });
  await writeAuditLog({ entityType: ENTITY.update, entityId: String(id), action: 'UPDATE', changedBy: uid, before: current, after: { ...u, nextStepDoneAt: doneAt } });
  return getProduct(cur.code, today);
}

export async function deleteUpdate(id: number, uid: number, today = businessToday()) {
  const cur = await requireUpdate(id);
  await inTransaction(async (conn) => {
    await exec(conn, 'UPDATE pdt_status_update SET deleted_at = UTC_TIMESTAMP(), deleted_by = ? WHERE update_id = ?', [uid, id]);
    await syncLatestUpdate(conn, cur.product_id, uid);
    await syncBlockerHealth(conn, cur.product_id, uid, false);
  });
  await writeAuditLog({ entityType: ENTITY.update, entityId: String(id), action: 'DELETE', changedBy: uid, before: cur });
  return getProduct(cur.code, today);
}

// ---------------------------------------------------------------------------------------------------------------------
// Blockers & decisions
// ---------------------------------------------------------------------------------------------------------------------

async function requireBlocker(db: Db, id: number) {
  const r = await one<BlockerDbRow & { code: string }>(
    db,
    `SELECT b.*, p.code, NULL AS updated_by_name FROM pdt_blocker b JOIN pdt_product p ON p.product_id = b.product_id AND p.deleted_at IS NULL
      WHERE b.blocker_id = ? AND b.deleted_at IS NULL`,
    [id],
  );
  if (!r) throw notFound('blocker');
  return r;
}

export async function listBlockers(filters: Filters, opts: { status?: BlockerStatus[]; kind?: BlockerKind[] } = {}, today = businessToday()) {
  const [all, blockers] = await Promise.all([loadProducts(), loadBlockers()]);
  const products = applyFilters(all, { ...filters, owners: [] });
  const byId = new Map(products.map((p) => [p.productId, p]));
  const owners = filters.owners.map((o) => o.toLowerCase());
  return blockers
    .filter((b) => byId.has(b.productId))
    .filter((b) => !opts.status?.length || opts.status.includes(b.status))
    .filter((b) => !opts.kind?.length || opts.kind.includes(b.kind))
    .filter((b) => !owners.length || owners.includes((b.ownerName ?? NOT_SET).toLowerCase()))
    .map((b) => ({ ...b, productCode: byId.get(b.productId)!.code, productName: byId.get(b.productId)!.name, overdue: (b.status === 'OPEN' || b.status === 'IN_PROGRESS') && b.dueDate < today }));
}

export async function createBlocker(input: Body, uid: number, today = businessToday()) {
  const code = text(input.productCode, 20, 'productCode', true)!;
  const { product: p } = await getProduct(code, today);
  const kind = enumOf(input.kind, BLOCKER_KINDS, 'kind');
  const title = text(input.title, 200, 'title', true)!;
  const requiredAction = text(input.requiredAction, 500, 'requiredAction', true)!;
  const owner = await ownerOf(input);
  const dueDate = dateOrNull(input.dueDate, 'dueDate');
  if (!dueDate) throw fail('dueDate.required', 'Enter the due date.', 'dueDate');
  const raisedOn = dateOrNull(input.raisedOn, 'raisedOn') ?? today;
  const status = input.status === undefined ? 'OPEN' : enumOf(input.status, ['OPEN', 'IN_PROGRESS'] as const, 'status');
  const { id, notice } = await inTransaction(async (conn) => {
    await requireProduct(conn, code, true);
    const externalId = await nextBlockerId(conn);
    const { insertId } = await exec(
      conn,
      'INSERT INTO pdt_blocker (external_id, product_id, kind, title, required_action, owner_user_id, owner_name, raised_on, due_date, status, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [externalId, p.productId, kind, title, requiredAction, owner.userId, owner.name, raisedOn, dueDate, status, uid, uid],
    );
    return { id: insertId, notice: await syncBlockerHealth(conn, p.productId, uid, false) };
  });
  const blocker = (await loadBlockers(pool, p.productId)).find((b) => b.blockerId === id)!;
  await writeAuditLog({ entityType: ENTITY.blocker, entityId: String(id), action: 'CREATE', changedBy: uid, after: { product: code, ...blocker } });
  return { blocker, ...notice };
}

export async function updateBlocker(id: number, input: Body, uid: number) {
  const cur = await requireBlocker(pool, id);
  if (cur.status === 'RESOLVED' || cur.status === 'CANCELLED') {
    // Reopening is the only change allowed on a closed item.
    if (input.status !== 'OPEN' && input.status !== 'IN_PROGRESS') throw fail('blocker.closed', 'This item is closed. Reopen it to change it.', 'status');
  }
  const kind = input.kind === undefined ? cur.kind : enumOf(input.kind, BLOCKER_KINDS, 'kind');
  const title = input.title === undefined ? cur.title : text(input.title, 200, 'title', true)!;
  const requiredAction = input.requiredAction === undefined ? cur.required_action : text(input.requiredAction, 500, 'requiredAction', true)!;
  const owner = input.ownerUserId === undefined && input.ownerName === undefined ? { userId: cur.owner_user_id, name: cur.owner_name } : await ownerOf(input);
  const dueDate = input.dueDate === undefined ? isoDate(cur.due_date) : dateOrNull(input.dueDate, 'dueDate');
  if (!dueDate) throw fail('dueDate.required', 'Enter the due date.', 'dueDate');
  // RESOLVED / CANCELLED go through /resolve (they need the note).
  const status = input.status === undefined ? cur.status : enumOf(input.status, ['OPEN', 'IN_PROGRESS'] as const, 'status');
  const reopened = status !== cur.status && (cur.status === 'RESOLVED' || cur.status === 'CANCELLED');
  const notice = await inTransaction(async (conn) => {
    const hadForced = forcedHealth(await unresolvedBlockers(conn, cur.product_id)) === 'BLOCKED';
    await exec(
      conn,
      `UPDATE pdt_blocker SET kind = ?, title = ?, required_action = ?, owner_user_id = ?, owner_name = ?, due_date = ?, status = ?,
              resolution_note = IF(?, NULL, resolution_note), resolved_at = IF(?, NULL, resolved_at), updated_by = ? WHERE blocker_id = ?`,
      [kind, title, requiredAction, owner.userId, owner.name, dueDate, status, reopened ? 1 : 0, reopened ? 1 : 0, uid, id],
    );
    return syncBlockerHealth(conn, cur.product_id, uid, hadForced);
  });
  const blocker = (await loadBlockers(pool, cur.product_id)).find((b) => b.blockerId === id)!;
  await writeAuditLog({ entityType: ENTITY.blocker, entityId: String(id), action: 'UPDATE', changedBy: uid, before: toBlocker({ ...cur, updated_by_name: null }), after: blocker });
  return { blocker, ...notice };
}

/** Resolve (note required) or cancel an item. */
export async function resolveBlocker(id: number, input: Body, uid: number, today = businessToday()) {
  const cur = await requireBlocker(pool, id);
  if (cur.status === 'RESOLVED' || cur.status === 'CANCELLED') throw fail('blocker.closed', 'This item is already closed.', 'status');
  const status = enumOf(input.status ?? 'RESOLVED', ['RESOLVED', 'CANCELLED'] as const, 'status');
  const note = text(input.resolutionNote, 1000, 'resolutionNote', status === 'RESOLVED');
  const resolvedAt = input.resolvedAt === undefined ? today : dateOrNull(input.resolvedAt, 'resolvedAt');
  if (!resolvedAt) throw fail('resolvedAt.required', 'Enter the resolution date.', 'resolvedAt');
  if (resolvedAt > today) throw fail('resolvedAt.future', 'The resolution date cannot be in the future.', 'resolvedAt');
  const notice = await inTransaction(async (conn) => {
    const hadForced = forcedHealth(await unresolvedBlockers(conn, cur.product_id)) === 'BLOCKED';
    await exec(conn, 'UPDATE pdt_blocker SET status = ?, resolution_note = ?, resolved_at = ?, updated_by = ? WHERE blocker_id = ?', [status, note, resolvedAt, uid, id]);
    return syncBlockerHealth(conn, cur.product_id, uid, hadForced);
  });
  const blocker = (await loadBlockers(pool, cur.product_id)).find((b) => b.blockerId === id)!;
  await writeAuditLog({ entityType: ENTITY.blocker, entityId: String(id), action: 'UPDATE', changedBy: uid, before: { status: cur.status }, after: { status, resolutionNote: note, resolvedAt } });
  return { blocker, ...notice };
}

export async function deleteBlocker(id: number, uid: number) {
  const cur = await requireBlocker(pool, id);
  const notice = await inTransaction(async (conn) => {
    const hadForced = forcedHealth(await unresolvedBlockers(conn, cur.product_id)) === 'BLOCKED';
    await exec(conn, 'UPDATE pdt_blocker SET deleted_at = UTC_TIMESTAMP(), deleted_by = ? WHERE blocker_id = ?', [uid, id]);
    return syncBlockerHealth(conn, cur.product_id, uid, hadForced);
  });
  await writeAuditLog({ entityType: ENTITY.blocker, entityId: String(id), action: 'DELETE', changedBy: uid, before: toBlocker({ ...cur, updated_by_name: null }) });
  return notice;
}

/** Products for the entry screen's register list (same filters as the dashboard). */
export async function listProducts(filters: Filters, today = businessToday()) {
  const [all, blockers, settings] = await Promise.all([loadProducts(), loadBlockers(), getSettings()]);
  return cards(applyFilters(all, filters), blockers, today, settings).map((p) => ({ ...p, active: isActive(p) }));
}

export { familyList };
