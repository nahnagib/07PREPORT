import { BUSINESS_TIME_ZONE } from '../../measures/debtCollections';

/**
 * Product Development Plan tracker (docs/product-development-standalone.md): the business rules, as pure functions over
 * already-loaded rows so they can be tested without a database. Dates are 'YYYY-MM-DD' strings in the business time
 * zone (Africa/Tripoli); "today" always comes from the caller.
 *
 * Round 2 (migration 0081): the real Xtreme pipeline from Product_Development_Input.xlsx. Health, priority, owner and
 * readiness may be "not set" (null) -- the file leaves them blank until the business fills them -- and the gaps are
 * shown (KPI "Health not set", flags) rather than refused.
 */

export const STAGES = ['IDEA', 'RESEARCH', 'DEVELOPMENT', 'TESTING', 'LAUNCH_READY', 'LAUNCHED'] as const;
export type StageCode = (typeof STAGES)[number];
export const HEALTHS = ['ON_TRACK', 'AT_RISK', 'BLOCKED'] as const;
export type HealthCode = (typeof HEALTHS)[number];
export const PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type PriorityCode = (typeof PRIORITIES)[number];
export const PROJECT_TYPES = ['PLANNED', 'UNPLANNED', 'INNOVATION', 'REFORMULATION'] as const;
export type ProjectTypeCode = (typeof PROJECT_TYPES)[number];
export const BLOCKER_KINDS = ['BLOCKER', 'DECISION'] as const;
export type BlockerKind = (typeof BLOCKER_KINDS)[number];
export const BLOCKER_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CANCELLED'] as const;
export type BlockerStatus = (typeof BLOCKER_STATUSES)[number];

/** The filter value for "not set" (health / priority / owner left blank). */
export const NOT_SET = 'NONE';

/** Stages where readiness may be 100%. */
export const FULL_READINESS_STAGES: readonly StageCode[] = ['LAUNCH_READY', 'LAUNCHED'];
/** Stages that need a target launch date (an Idea may not have one yet; a launched product has its actual date). */
export const TARGET_REQUIRED_STAGES: readonly StageCode[] = ['RESEARCH', 'DEVELOPMENT', 'TESTING', 'LAUNCH_READY'];

export interface Settings {
  staleDays: number;
  roadmapMonths: number;
  upcomingWindowDays: number;
  followupDueSoonDays: number;
  launchSoonDays: number;
  launchSoonMinReadiness: number;
}

export const DEFAULT_SETTINGS: Settings = {
  staleDays: 14,
  roadmapMonths: 4,
  upcomingWindowDays: 90,
  followupDueSoonDays: 7,
  launchSoonDays: 30,
  launchSoonMinReadiness: 80,
};

/** pdt_setting.setting_key for each setting. */
export const SETTING_KEYS: Record<keyof Settings, string> = {
  staleDays: 'stale_days',
  roadmapMonths: 'roadmap_months',
  upcomingWindowDays: 'upcoming_window_days',
  followupDueSoonDays: 'followup_due_soon_days',
  launchSoonDays: 'launch_soon_days',
  launchSoonMinReadiness: 'launch_soon_min_readiness',
};

/** Allowed range of each setting (the admin screen refuses anything outside). */
export const SETTING_RANGES: Record<keyof Settings, [number, number]> = {
  staleDays: [1, 365],
  roadmapMonths: [1, 12],
  upcomingWindowDays: [1, 730],
  followupDueSoonDays: [0, 90],
  launchSoonDays: [1, 365],
  launchSoonMinReadiness: [1, 100],
};

export interface Product {
  productId: number;
  code: string;
  name: string;
  familyId: number | null;
  family: string | null;
  subfamily: string | null;
  ownerUserId: number | null;
  ownerName: string | null;
  priority: PriorityCode | null;
  stage: StageCode;
  health: HealthCode | null;
  readinessPct: number | null;
  targetLaunch: string | null;
  actualLaunch: string | null;
  projectType: ProjectTypeCode | null;
  nextStep: string | null;
  nextStepDue: string | null;
  healthReviewRequired: boolean;
  stageSince: string;
  /** Latest status update date, or null when none was posted. */
  lastUpdateAt: string | null;
  /** Creation date: the start of the stale clock when no update was ever posted. */
  createdOn: string;
}

export interface Blocker {
  blockerId: number;
  externalId: string | null;
  productId: number;
  kind: BlockerKind;
  title: string;
  requiredAction: string;
  ownerName: string | null;
  dueDate: string;
  status: BlockerStatus;
}

export interface OpenNextStep {
  updateId: number | null;
  productId: number;
  nextStep: string;
  nextStepDue: string;
  ownerName: string | null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------------------------------

/** Today in the business time zone, 'YYYY-MM-DD'. */
export function businessToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

const toUtc = (iso: string): number => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));

export function addDays(iso: string, days: number): string {
  return new Date(toUtc(iso) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / 86_400_000);
}

export function isValidIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  return new Date(toUtc(v)).toISOString().slice(0, 10) === v;
}

// ---------------------------------------------------------------------------------------------------------------------
// Status of one product / item
// ---------------------------------------------------------------------------------------------------------------------

/** Active = every stage before Launched. */
export const isActive = (p: Pick<Product, 'stage'>): boolean => p.stage !== 'LAUNCHED';

/** Unresolved = Open or In progress; the dashboard's "open" items. */
export const isUnresolved = (b: Pick<Blocker, 'status'>): boolean => b.status === 'OPEN' || b.status === 'IN_PROGRESS';

/** Overdue = due before today and still unresolved (an item due today is not overdue yet). */
export const isOverdue = (b: Pick<Blocker, 'status' | 'dueDate'>, today: string): boolean => isUnresolved(b) && b.dueDate < today;

/** Days since the last status update (or since creation when there is none). */
export function daysSinceUpdate(p: Pick<Product, 'lastUpdateAt' | 'createdOn'>, today: string): number {
  return daysBetween(p.lastUpdateAt ?? p.createdOn, today);
}

/** Stale = an active product with no status update in the last `staleDays` days ("No update" marker). */
export function isStale(p: Pick<Product, 'stage' | 'lastUpdateAt' | 'createdOn'>, today: string, staleDays: number): boolean {
  return isActive(p) && daysSinceUpdate(p, today) >= staleDays;
}

/** An active product whose target launch is already past. */
export const isTargetPassed = (p: Pick<Product, 'stage' | 'targetLaunch'>, today: string): boolean => isActive(p) && p.targetLaunch !== null && p.targetLaunch < today;

/** Health a product must have given its unresolved blockers: Blocked while a Blocker (not a decision) is open. */
export function forcedHealth(productBlockers: Pick<Blocker, 'kind' | 'status'>[]): HealthCode | null {
  return productBlockers.some((b) => b.kind === 'BLOCKER' && isUnresolved(b)) ? 'BLOCKED' : null;
}

export type FlagCode = 'OPEN_BLOCKER' | 'TARGET_PASSED' | 'HEALTH_NOT_SET' | 'LAUNCH_SOON_LOW_READINESS';

export const FLAG_LABEL: Record<FlagCode, string> = {
  OPEN_BLOCKER: 'Open blocker',
  TARGET_PASSED: 'Target date passed',
  HEALTH_NOT_SET: 'Health not set',
  LAUNCH_SOON_LOW_READINESS: 'Launch soon, low readiness',
};

/**
 * The tracker's Flag column, in the Excel file's order (Products!Flag): the first that applies, none for a launched product.
 * Open blocker -> target date passed -> health not set -> launching within `launchSoonDays` below `launchSoonMinReadiness`.
 */
export function productFlag(p: Product, openBlockerCount: number, today: string, s: Pick<Settings, 'launchSoonDays' | 'launchSoonMinReadiness'>): FlagCode | null {
  if (!isActive(p)) return null;
  if (openBlockerCount > 0) return 'OPEN_BLOCKER';
  if (isTargetPassed(p, today)) return 'TARGET_PASSED';
  if (p.health === null) return 'HEALTH_NOT_SET';
  if (p.targetLaunch && daysBetween(today, p.targetLaunch) <= s.launchSoonDays && (p.readinessPct ?? 0) < s.launchSoonMinReadiness) return 'LAUNCH_SOON_LOW_READINESS';
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Validation of a product (the API turns each problem into a { code, field } error)
// ---------------------------------------------------------------------------------------------------------------------

export interface ProductProblem {
  code: string;
  field: string;
  message: string;
}

export function productProblems(p: { name: string; stage: StageCode; readinessPct: number | null; targetLaunch: string | null; actualLaunch: string | null }): ProductProblem[] {
  const out: ProductProblem[] = [];
  if (!p.name.trim()) out.push({ code: 'product.nameRequired', field: 'name', message: 'Enter the product name.' });
  if (p.name.length > 150) out.push({ code: 'product.nameTooLong', field: 'name', message: 'The name can be at most 150 characters.' });
  if (p.readinessPct !== null) {
    if (!Number.isInteger(p.readinessPct) || p.readinessPct < 0 || p.readinessPct > 100) {
      out.push({ code: 'product.readinessRange', field: 'readinessPct', message: 'Readiness must be a whole number from 0 to 100.' });
    } else if (p.readinessPct === 100 && !FULL_READINESS_STAGES.includes(p.stage)) {
      out.push({ code: 'product.readinessFull', field: 'readinessPct', message: 'Readiness can be 100% only in Launch ready or Launched.' });
    }
  }
  if (TARGET_REQUIRED_STAGES.includes(p.stage) && !p.targetLaunch) {
    out.push({ code: 'product.targetRequired', field: 'targetLaunch', message: 'Enter the target launch date (required from Research to Launch ready).' });
  }
  if (p.stage === 'LAUNCHED' && !p.actualLaunch) {
    out.push({ code: 'product.actualRequired', field: 'actualLaunch', message: 'Enter the actual launch date for a launched product.' });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Filters (every dashboard section uses the same filtered set)
// ---------------------------------------------------------------------------------------------------------------------

export interface Filters {
  familyIds: number[];
  subfamilies: string[];
  stages: StageCode[];
  /** Health codes and/or NOT_SET. */
  health: string[];
  /** Owner names and/or NOT_SET. */
  owners: string[];
  /** Priority codes and/or NOT_SET. */
  priorities: string[];
  launchFrom?: string;
  launchTo?: string;
  search?: string;
}

export const NO_FILTERS: Filters = { familyIds: [], subfamilies: [], stages: [], health: [], owners: [], priorities: [] };

const matches = (list: string[], v: string | null): boolean => list.length === 0 || list.includes(v ?? NOT_SET);

export function applyFilters(products: Product[], f: Filters): Product[] {
  const q = f.search?.trim().toLowerCase();
  const owners = f.owners.map((o) => (o === NOT_SET ? o : o.toLowerCase()));
  const subs = f.subfamilies.map((x) => x.toLowerCase());
  return products.filter(
    (p) =>
      (f.familyIds.length === 0 || (p.familyId !== null && f.familyIds.includes(p.familyId))) &&
      (subs.length === 0 || (p.subfamily !== null && subs.includes(p.subfamily.toLowerCase()))) &&
      (f.stages.length === 0 || f.stages.includes(p.stage)) &&
      matches(f.health, p.health) &&
      matches(owners, p.ownerName ? p.ownerName.toLowerCase() : null) &&
      matches(f.priorities, p.priority) &&
      // A date range keeps only products whose target launch falls inside it.
      (!f.launchFrom || (p.targetLaunch !== null && p.targetLaunch >= f.launchFrom)) &&
      (!f.launchTo || (p.targetLaunch !== null && p.targetLaunch <= f.launchTo)) &&
      (!q || p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q)),
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------------------------------------------------

export interface Kpis {
  total: number;
  inMarket: number;
  active: number;
  onTrack: number;
  needAttention: number;
  upcomingLaunches: number;
  targetPassed: number;
  healthNotSet: number;
}

/**
 * The six KPI cards plus the two gap lines -- the same rules as the Excel "Where we stand" key numbers.
 * Upcoming = active with target launch from today to today + window (both days included).
 */
export function computeKpis(products: Product[], today: string, s: Pick<Settings, 'upcomingWindowDays'>): Kpis {
  const active = products.filter(isActive);
  const windowEnd = addDays(today, s.upcomingWindowDays);
  return {
    total: products.length,
    inMarket: products.length - active.length,
    active: active.length,
    onTrack: active.filter((p) => p.health === 'ON_TRACK').length,
    needAttention: active.filter((p) => p.health === 'AT_RISK' || p.health === 'BLOCKED').length,
    upcomingLaunches: active.filter((p) => p.targetLaunch !== null && p.targetLaunch >= today && p.targetLaunch <= windowEnd).length,
    targetPassed: active.filter((p) => isTargetPassed(p, today)).length,
    healthNotSet: active.filter((p) => p.health === null).length,
  };
}

export interface FamilyStageRow {
  familyId: number | null;
  family: string;
  counts: Record<StageCode, number>;
  total: number;
}

const zeroCounts = (): Record<StageCode, number> => Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<StageCode, number>;

/** "Where we stand": families (in list order, then any other family a product uses) x stages, with totals. */
export function familyStageMatrix(products: Product[], families: { familyId: number; family: string }[]): { rows: FamilyStageRow[]; totals: Record<StageCode, number>; total: number } {
  const rows = new Map<string, FamilyStageRow>();
  for (const f of families) rows.set(String(f.familyId), { familyId: f.familyId, family: f.family, counts: zeroCounts(), total: 0 });
  for (const p of products) {
    const key = p.familyId === null ? 'none' : String(p.familyId);
    if (!rows.has(key)) rows.set(key, { familyId: p.familyId, family: p.family ?? 'Family not set', counts: zeroCounts(), total: 0 });
    const r = rows.get(key)!;
    r.counts[p.stage] += 1;
    r.total += 1;
  }
  const totals = zeroCounts();
  for (const r of rows.values()) for (const st of STAGES) totals[st] += r.counts[st];
  return { rows: [...rows.values()], totals, total: products.length };
}

export interface StageSummary {
  stage: StageCode;
  count: number;
  health: { onTrack: number; atRisk: number; blocked: number; notSet: number };
  /** Average of the readiness values that are set; null when none is. */
  avgReadiness: number | null;
  /** Earliest target launch in the stage (none for Launched). */
  nextTarget: string | null;
  nextTargetPassed: boolean;
  /** Products whose target date has passed. */
  overdue: number;
  blocked: number;
}

/**
 * The landing page's stage tiles: one per stage, in pipeline order, for the products given (the dashboard passes the
 * filtered set WITHOUT its stage filter, so every tile stays visible while one stage is open).
 */
export function stageSummary(products: Product[], today: string): StageSummary[] {
  return STAGES.map((stage) => {
    const ps = products.filter((p) => p.stage === stage);
    const ready = ps.map((p) => p.readinessPct).filter((r): r is number => r !== null);
    const targets = stage === 'LAUNCHED' ? [] : ps.map((p) => p.targetLaunch).filter((t): t is string => t !== null).sort();
    return {
      stage,
      count: ps.length,
      health: {
        onTrack: ps.filter((p) => p.health === 'ON_TRACK').length,
        atRisk: ps.filter((p) => p.health === 'AT_RISK').length,
        blocked: ps.filter((p) => p.health === 'BLOCKED').length,
        notSet: ps.filter((p) => p.health === null).length,
      },
      avgReadiness: ready.length ? Math.round(ready.reduce((a, b) => a + b, 0) / ready.length) : null,
      nextTarget: targets[0] ?? null,
      nextTargetPassed: targets.length > 0 && targets[0] < today,
      overdue: ps.filter((p) => isTargetPassed(p, today)).length,
      blocked: ps.filter((p) => p.health === 'BLOCKED').length,
    };
  });
}

/** Launched (actual launch year) vs planned (target year, not launched yet) per year; covers at least 2023-2028. */
export function launchesByYear(products: Product[], minYear = 2023, maxYear = 2028): { year: number; launched: number; planned: number }[] {
  const years = new Map<number, { launched: number; planned: number }>();
  const bump = (y: number, k: 'launched' | 'planned') => {
    if (!years.has(y)) years.set(y, { launched: 0, planned: 0 });
    years.get(y)![k] += 1;
  };
  for (const p of products) {
    if (!isActive(p) && p.actualLaunch) bump(Number(p.actualLaunch.slice(0, 4)), 'launched');
    else if (isActive(p) && p.targetLaunch) bump(Number(p.targetLaunch.slice(0, 4)), 'planned');
  }
  const lo = Math.min(minYear, ...years.keys());
  const hi = Math.max(maxYear, ...years.keys());
  const out: { year: number; launched: number; planned: number }[] = [];
  for (let y = lo; y <= hi; y += 1) out.push({ year: y, launched: years.get(y)?.launched ?? 0, planned: years.get(y)?.planned ?? 0 });
  return out;
}

export interface RoadmapMonth {
  month: string; // 'YYYY-MM'
  products: Product[];
}

/** `months` calendar months from the current one; active products grouped by target-launch month, earliest first. */
export function buildRoadmap(products: Product[], today: string, months: number): { months: RoadmapMonth[]; outsideWindow: number } {
  const keys: string[] = [];
  let y = Number(today.slice(0, 4));
  let m = Number(today.slice(5, 7));
  for (let i = 0; i < months; i += 1) {
    keys.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  const byMonth = new Map<string, Product[]>(keys.map((k) => [k, []]));
  let outsideWindow = 0;
  for (const p of products.filter(isActive)) {
    if (!p.targetLaunch) continue;
    const bucket = byMonth.get(p.targetLaunch.slice(0, 7));
    if (bucket) bucket.push(p);
    else outsideWindow += 1;
  }
  return {
    months: keys.map((k) => ({ month: k, products: (byMonth.get(k) ?? []).sort((a, b) => (a.targetLaunch ?? '').localeCompare(b.targetLaunch ?? '')) })),
    outsideWindow,
  };
}

/** Open (unresolved) items, overdue first, then by due date. */
export function openBlockers<T extends Blocker>(blockers: T[], today: string): (T & { overdue: boolean })[] {
  return blockers
    .filter(isUnresolved)
    .map((b) => ({ ...b, overdue: isOverdue(b, today) }))
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.dueDate.localeCompare(b.dueDate) || a.blockerId - b.blockerId);
}

// ---------------------------------------------------------------------------------------------------------------------
// Follow-up board
// ---------------------------------------------------------------------------------------------------------------------

export type FollowupKind = 'BLOCKER_OVERDUE' | 'BLOCKER_DUE_SOON' | 'NEXT_STEP_OVERDUE' | 'STALE' | 'LAUNCH_AT_RISK';

export interface FollowupItem {
  kind: FollowupKind;
  productId: number;
  productCode: string;
  productName: string;
  ownerName: string | null;
  title: string;
  /** The date the item is about (due date, next-step due, last update, target launch). */
  date: string | null;
  /** Positive = days late; negative = days left. */
  days: number;
  refId: number | null;
}

const KIND_ORDER: FollowupKind[] = ['BLOCKER_OVERDUE', 'NEXT_STEP_OVERDUE', 'BLOCKER_DUE_SOON', 'LAUNCH_AT_RISK', 'STALE'];

/**
 * Everything a manager has to act on, for the products given (already filtered):
 *   blockers/decisions overdue or due within `followupDueSoonDays`; next steps overdue and not done; stale products;
 *   active products launching within `launchSoonDays` with readiness below `launchSoonMinReadiness` (or not set).
 */
export function buildFollowup(products: Product[], blockers: Blocker[], nextSteps: OpenNextStep[], today: string, s: Settings): FollowupItem[] {
  const byId = new Map(products.map((p) => [p.productId, p]));
  const out: FollowupItem[] = [];
  const base = (p: Product) => ({ productId: p.productId, productCode: p.code, productName: p.name });
  const soon = addDays(today, s.followupDueSoonDays);
  for (const b of blockers) {
    const p = byId.get(b.productId);
    if (!p || !isUnresolved(b) || b.dueDate > soon) continue;
    const overdue = b.dueDate < today;
    out.push({ ...base(p), kind: overdue ? 'BLOCKER_OVERDUE' : 'BLOCKER_DUE_SOON', ownerName: b.ownerName, title: b.title, date: b.dueDate, days: daysBetween(b.dueDate, today), refId: b.blockerId });
  }
  for (const n of nextSteps) {
    const p = byId.get(n.productId);
    if (!p || !isActive(p) || n.nextStepDue >= today) continue;
    out.push({ ...base(p), kind: 'NEXT_STEP_OVERDUE', ownerName: n.ownerName, title: n.nextStep, date: n.nextStepDue, days: daysBetween(n.nextStepDue, today), refId: n.updateId });
  }
  const launchEnd = addDays(today, s.launchSoonDays);
  for (const p of products) {
    if (isStale(p, today, s.staleDays)) {
      out.push({ ...base(p), kind: 'STALE', ownerName: p.ownerName, title: 'No status update', date: p.lastUpdateAt, days: daysSinceUpdate(p, today), refId: null });
    }
    if (isActive(p) && p.targetLaunch && p.targetLaunch >= today && p.targetLaunch <= launchEnd && (p.readinessPct ?? 0) < s.launchSoonMinReadiness) {
      const ready = p.readinessPct === null ? 'readiness not set' : `${p.readinessPct}% readiness`;
      out.push({ ...base(p), kind: 'LAUNCH_AT_RISK', ownerName: p.ownerName, title: `Launch in ${daysBetween(today, p.targetLaunch)} days at ${ready}`, date: p.targetLaunch, days: daysBetween(p.targetLaunch, today), refId: null });
    }
  }
  return out.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.days - a.days || a.productCode.localeCompare(b.productCode));
}

// ---------------------------------------------------------------------------------------------------------------------
// Stage timeline
// ---------------------------------------------------------------------------------------------------------------------

export interface StageChange {
  historyId: number;
  fromStage: StageCode | null;
  toStage: StageCode;
  changedOn: string;
  changedAt: string | null;
  changedBy: string | null;
  comment: string;
}

/** History oldest first, each row with the days spent in its `toStage` (until the next change, or today). */
export function withDaysInStage(history: StageChange[], today: string): (StageChange & { days: number; current: boolean })[] {
  const sorted = [...history].sort((a, b) => a.changedOn.localeCompare(b.changedOn) || a.historyId - b.historyId);
  return sorted.map((h, i) => {
    const next = sorted[i + 1];
    return { ...h, days: Math.max(0, daysBetween(h.changedOn, next ? next.changedOn : today)), current: !next };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------------------------------------------------

/** The next code after the highest `PREFIX-###` in use: XT-055 -> XT-056 (3 digits, more when needed). */
export function nextCode(prefix: string, used: (string | null)[]): string {
  const re = new RegExp(`^${prefix}-(\\d+)$`, 'i');
  const max = used.reduce((m, c) => {
    const hit = c ? re.exec(c.trim()) : null;
    return hit ? Math.max(m, Number(hit[1])) : m;
  }, 0);
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

/** Excel readiness: 0-1 (a % cell) or 0-100 -> a whole 0-100, or null when blank. NaN when it is not a number. */
export function normaliseReadiness(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace('%', '').trim());
  if (!Number.isFinite(n)) return NaN;
  const pct = typeof v === 'string' && v.includes('%') ? n : n <= 1 ? n * 100 : n;
  return Math.round(pct);
}
