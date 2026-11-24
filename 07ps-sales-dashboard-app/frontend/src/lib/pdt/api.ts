import { apiRequest, API_BASE } from '../api';
import { download, pdp } from '../pdp/api';

/**
 * Product Development Plan dashboard + data entry & follow-up (backend routes/productDevelopmentTracker.ts, mounted at
 * /product-development/tracker). The gate module's helpers (lib/pdp/api.ts) already prefix /product-development.
 */
export const TRACKER = '/tracker';

/** Filter value for "not set" (health / priority / owner left blank in the Excel file). */
export const NOT_SET = 'NONE';

/** The brand of a product whose Excel "Brand" cell is blank. */
export const UNASSIGNED_BRAND = 'Unassigned';

export type StageCode = 'IDEA' | 'RESEARCH' | 'DEVELOPMENT' | 'TESTING' | 'LAUNCH_READY' | 'LAUNCHED';
export type HealthCode = 'ON_TRACK' | 'AT_RISK' | 'BLOCKED';
export type PriorityCode = 'HIGH' | 'MEDIUM' | 'LOW';
export type ProjectTypeCode = 'PLANNED' | 'UNPLANNED' | 'INNOVATION' | 'REFORMULATION';
export type BlockerKind = 'BLOCKER' | 'DECISION';
export type BlockerStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CANCELLED';
export type FlagCode = 'OPEN_BLOCKER' | 'TARGET_PASSED' | 'HEALTH_NOT_SET' | 'LAUNCH_SOON_LOW_READINESS';

export interface DropdownValue {
  value_id: number;
  list_key: 'stage' | 'health' | 'priority' | 'family' | 'project_type';
  code: string | null;
  label: string;
  description: string | null;
  color: string;
  sort_order: number;
  is_active: number;
  usage_count?: number;
}

export interface Settings {
  staleDays: number;
  roadmapMonths: number;
  upcomingWindowDays: number;
  followupDueSoonDays: number;
  launchSoonDays: number;
  launchSoonMinReadiness: number;
}

export interface Options {
  dropdowns: DropdownValue[];
  settings: Settings;
  users: { user_id: number; display_name: string }[];
  owners: string[];
  subfamilies: { familyId: number | null; subfamily: string }[];
  /** Brands in use ("Unassigned" last). */
  brands: string[];
  today: string;
}

export interface Product {
  productId: number;
  code: string;
  name: string;
  familyId: number | null;
  family: string | null;
  subfamily: string | null;
  brand: string;
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
  lastUpdateAt: string | null;
  stale: boolean;
  openBlockers?: number;
  flag?: FlagCode | null;
  flagLabel?: string | null;
}

export interface BlockerRow {
  blockerId: number;
  externalId: string | null;
  productId: number;
  productCode?: string;
  productName?: string;
  kind: BlockerKind;
  title: string;
  requiredAction: string;
  ownerUserId?: number | null;
  ownerName: string | null;
  raisedOn?: string | null;
  dueDate: string;
  status: BlockerStatus;
  resolutionNote?: string | null;
  resolvedAt?: string | null;
  overdue?: boolean;
  updatedAt?: string | null;
  updatedBy?: string | null;
}

export interface Kpis {
  total: number;
  inMarket: number;
  /** Not launched, target launch from today to today + 12 months. */
  active: number;
  /** Every other not-launched product: no target date, target more than 12 months away, or target already passed. */
  planned: number;
  plannedNoDate: number;
  plannedBeyond: number;
  plannedPassed: number;
  onTrack: number;
  needAttention: number;
  upcomingLaunches: number;
  healthNotSet: number;
  targetPassed: number;
}

export type KpiKey = 'total' | 'inMarket' | 'active' | 'planned' | 'onTrack' | 'needAttention' | 'upcomingLaunches' | 'healthNotSet';

export interface StageTile {
  stage: StageCode;
  label: string;
  color: string;
  count: number;
  health: { onTrack: number; atRisk: number; blocked: number; notSet: number };
  avgReadiness: number | null;
  nextTarget: string | null;
  nextTargetPassed: boolean;
  overdue: number;
  blocked: number;
  /** The first products of the stage (the pipeline tooltip). */
  top?: { code: string; name: string; date: string | null }[];
}

export interface MatrixRow {
  familyId: number | null;
  family: string;
  counts: Record<StageCode, number>;
  total: number;
}

export interface Dashboard {
  today: string;
  settings: Settings;
  /** Last confirmed Excel import (ISO instant), null before the first one. */
  lastImport: string | null;
  totalProducts: number;
  kpis: Kpis;
  /** The product codes behind each KPI card (its drill-down table). */
  kpiCodes: Record<KpiKey, string[]>;
  /** The stage tiles: the same filters as the KPIs, without the stage filter (every tile stays visible). */
  stageSummary: { stages: StageTile[]; totals: { total: number; inPipeline: number; inMarket: number } };
  pipeline:{ stage: StageCode; label: string; color: string; products: Product[] }[];
  matrix: { rows: MatrixRow[]; totals: Record<StageCode, number>; total: number };
  tracker: Product[];
  roadmap: { months: { month: string; products: { code: string; name: string; family: string | null; targetLaunch: string; health: HealthCode | null }[] }[]; outsideWindow: number; windowEnd: string };
  byYear: { year: number; launched: number; planned: number }[];
  blockers: BlockerRow[];
}

export interface StageHistoryRow {
  historyId: number;
  fromStage: StageCode | null;
  toStage: StageCode;
  changedOn: string;
  changedAt: string | null;
  changedBy: string | null;
  comment: string;
  days: number;
  current: boolean;
}

export interface StatusUpdateRow {
  updateId: number;
  updateDate: string;
  health: HealthCode | null;
  readinessPct: number | null;
  summary: string;
  nextStep: string | null;
  nextStepDue: string | null;
  nextStepDoneAt: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface ProductDetail {
  product: Product & { description: string | null; notes: string | null; comment: string | null };
  history: StageHistoryRow[];
  updates: StatusUpdateRow[];
  blockers: BlockerRow[];
  audit: { updatedAt: string | null; updatedBy: string | null; createdAt: string | null; createdBy: string | null; excelUpdatedOn: string | null; excelUpdatedBy: string | null };
}

export type FollowupKind = 'BLOCKER_OVERDUE' | 'BLOCKER_DUE_SOON' | 'NEXT_STEP_OVERDUE' | 'STALE' | 'LAUNCH_AT_RISK';

export interface FollowupItem {
  kind: FollowupKind;
  productId: number;
  productCode: string;
  productName: string;
  ownerName: string | null;
  title: string;
  date: string | null;
  days: number;
  refId: number | null;
}

/** Blocker writes answer with the health rule's notices. */
export interface HealthNotice {
  healthForced?: boolean;
  healthReviewRequired?: boolean;
}

export interface ImportError {
  sheet: string;
  row: number;
  field: string;
  code: string;
  message: string;
}

export interface ImportPreview {
  importId?: number;
  fileName: string;
  sha256: string;
  today: string;
  counts: {
    products: { rows: number; new: number; changed: number; unchanged: number; errors: number; stageChanges: number };
    updates: { rows: number; new: number; duplicates: number; errors: number };
    blockers: { rows: number; new: number; changed: number; unchanged: number; errors: number };
    families: { inFile: number; new: number; changed: number };
  };
  errors: ImportError[];
  products: { code: string; name: string; action: 'new' | 'changed' | 'unchanged'; fields: string[]; stageFrom: StageCode | null; stageTo: StageCode }[];
  missingFromFile: { code: string; name: string }[];
  healthForced: string[];
  whereWeStand: { family: string; counts: Record<StageCode, number>; total: number }[];
  canConfirm: boolean;
}

export interface ImportLog {
  importId: number;
  fileName: string;
  importedAt: string | null;
  importedBy: string | null;
  counts: ImportPreview['counts'] & { healthForced?: number };
  missingCodes: string[];
}

export interface Filters {
  familyIds: string[];
  brands: string[];
  subfamilies: string[];
  stages: string[];
  health: string[];
  owners: string[];
  priorities: string[];
  launchFrom: string;
  launchTo: string;
  search: string;
}

export const EMPTY_FILTERS: Filters = { familyIds: [], brands: [], subfamilies: [], stages: [], health: [], owners: [], priorities: [], launchFrom: '', launchTo: '', search: '' };

const LIST_KEYS = ['familyIds', 'brands', 'subfamilies', 'stages', 'health', 'owners', 'priorities'] as const;

export function filterQuery(f: Filters): string {
  const q = new URLSearchParams();
  for (const k of LIST_KEYS) if (f[k].length) q.set(k, f[k].join(','));
  if (f.launchFrom) q.set('launchFrom', f.launchFrom);
  if (f.launchTo) q.set('launchTo', f.launchTo);
  if (f.search.trim()) q.set('search', f.search.trim());
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const countActiveFilters = (f: Filters): number =>
  LIST_KEYS.reduce((n, k) => n + (f[k].length ? 1 : 0), 0) + (f.launchFrom || f.launchTo ? 1 : 0) + (f.search.trim() ? 1 : 0);

export const trackerCall = <T = unknown>(path: string, token: string | null, method = 'GET', body?: unknown): Promise<T> =>
  pdp(TRACKER + path, token, method, body) as Promise<T>;

export const trackerDownload = (path: string, token: string | null, name: string) => download(TRACKER + path, token, name);

/** Upload the Excel file: preview (nothing written) or confirm (with the preview's sha256). */
export function trackerUpload<T>(path: string, token: string | null, file: File, extra: Record<string, string> = {}): Promise<T> {
  const body = new FormData();
  body.append('file', file);
  for (const [k, v] of Object.entries(extra)) body.append(k, v);
  return apiRequest(`/product-development${TRACKER}${path}`, token, { method: 'POST', body }) as Promise<T>;
}

export { API_BASE };
