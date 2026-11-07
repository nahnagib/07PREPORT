import { API_BASE, ApiError, apiRequest, type TachometerFilters } from '../api';
import { HOURS_PER_DAY, type CaseSla } from './sla';

/**
 * NPS Detractor Follow-up API client and view helpers (backend routes/npsFollowup.ts; docs/nps-followup.md).
 *
 * STAGE and STATUS are two separate things and are never mixed:
 *   stage   the workflow step (editable): the board columns, the Stage filter, the history.
 *   status  OPEN / CLOSE / DISPUTED, worked out from the stage by the database (read-only): the badge, the Status
 *           filter, the Open / Close / Disputed KPIs. Two cards in the same column always have the same badge.
 */

/** The workflow steps. */
export const STAGES = ['HISTORICAL', 'NEW', 'CONTACTED', 'IN_PROGRESS', 'RESOLVED', 'REJECTED'] as const;
export type FollowupStage = (typeof STAGES)[number];
/** The board's columns (stages), left to right (Historical cases appear only in the List view). */
export const BOARD_COLUMNS: readonly FollowupStage[] = ['NEW', 'CONTACTED', 'IN_PROGRESS', 'RESOLVED', 'REJECTED'];
export const EDITABLE_STAGES: readonly FollowupStage[] = BOARD_COLUMNS;

/** The outcome groups. */
export const STATUSES = ['OPEN', 'CLOSE', 'DISPUTED'] as const;
export type FollowupStatus = (typeof STATUSES)[number];

export const STAGE_LABEL: Record<FollowupStage, string> = {
  HISTORICAL: 'Historical',
  NEW: 'New',
  CONTACTED: 'Contacted',
  IN_PROGRESS: 'In progress',
  RESOLVED: 'Resolved',
  REJECTED: 'Rejected',
};

export const STAGE_COLOR: Record<FollowupStage, string> = {
  HISTORICAL: 'var(--ps-color-muted-text)',
  NEW: 'var(--ps-color-accent)',
  CONTACTED: 'var(--ps-color-watch)',
  IN_PROGRESS: 'var(--ps-color-gold)',
  RESOLVED: 'var(--ps-color-success)',
  REJECTED: 'var(--ps-color-muted-text)',
};

export const STATUS_LABEL: Record<FollowupStatus, string> = {
  OPEN: 'Open',
  CLOSE: 'Close',
  DISPUTED: 'Disputed',
};

export const STATUS_COLOR: Record<FollowupStatus, string> = {
  OPEN: 'var(--ps-color-accent)',
  CLOSE: 'var(--ps-color-success)',
  DISPUTED: 'var(--ps-color-alert)',
};

/** The same rule as the database's generated column (migration 0066), for the form's preview only. */
export function statusOfStage(stage: FollowupStage): FollowupStatus | null {
  if (stage === 'NEW' || stage === 'CONTACTED' || stage === 'IN_PROGRESS') return 'OPEN';
  if (stage === 'RESOLVED') return 'CLOSE';
  if (stage === 'HISTORICAL') return null;
  return 'DISPUTED';
}


export interface FollowupCase {
  caseId: number;
  responseId: number;
  ratedAt: string | null;
  /** the workflow step (editable) */
  stage: FollowupStage;
  /** worked out from the stage (read-only); null for Historical */
  status: FollowupStatus | null;
  reasonId: number | null;
  categoryKey: string | null;
  categoryEn: string | null;
  categoryAr: string | null;
  /** null = the category's "Not specified" row (or Other) */
  subReasonEn: string | null;
  subReasonAr: string | null;
  /** "Category › Sub-reason" (or "… › Not specified", or "Other"); null = not classified */
  reasonLabelEn: string | null;
  reasonLabelAr: string | null;
  /** the note an "Other" reason requires */
  reasonNote: string | null;
  ownerUserId: number | null;
  ownerName: string | null;
  contactedAt: string | null;
  resolvedAt: string | null;
  /** when the stage became Rejected (read-only) */
  rejectedAt: string | null;
  rootCause: string | null;
  actionTaken: string | null;
  notes: string | null;
  sourceChanged: boolean;
  sourceChangedAt: string | null;
  sourceChangeReason: string | null;
  version: number;
  updatedAt: string | null;
  updatedByName: string | null;
  company: string | null;
  customer: string | null;
  orderRef: string | null;
  deliveryCode: string | null;
  salesTeam: string | null;
  salesperson: string | null;
  teamBranch: string | null;
  hasComment: boolean;
  /** Odoo form links of the sale order / the matched picking; null without an id */
  orderUrl: string | null;
  deliveryUrl: string | null;
  /** when process_nps created the case (Tripoli time): the start of both SLAs */
  createdAt: string | null;
  /** hours from created_at to resolved / now; null for Rejected and Historical */
  hoursOpen: number | null;
  /** the SLA state (lib/nps/sla.ts) */
  sla: CaseSla;
}

export interface FollowupHistoryRow {
  changedAt: string;
  changedBy: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

export interface FollowupDetail extends FollowupCase {
  comment: string | null;
  history: FollowupHistoryRow[];
}

/**
 * One row of the two-level reason list (dim_nps_reason). subReasonEn null = the category's own row: "Not specified"
 * (never offered), or Other (requiresNote: offered, with a required note).
 */
export interface FollowupReason {
  reasonId: number;
  reasonKey: string;
  categoryKey: string;
  categoryEn: string;
  categoryAr: string;
  subReasonEn: string | null;
  subReasonAr: string | null;
  categorySort: number;
  sortOrder: number;
  requiresNote: boolean;
  isActive: boolean;
  categoryActive: boolean;
  pickable: boolean;
  labelEn: string;
  labelAr: string;
  usageCount: number;
}

export interface ReasonCategory {
  categoryKey: string;
  categoryEn: string;
  categoryAr: string;
  /** the category's own row ("Not specified", or Other) */
  row: FollowupReason;
  subReasons: FollowupReason[];
}

/** The flat list as categories with their sub-reasons, in the list's order. */
export function groupReasons(rows: FollowupReason[]): ReasonCategory[] {
  const out = new Map<string, ReasonCategory>();
  for (const r of rows) {
    if (r.subReasonEn === null) out.set(r.categoryKey, { categoryKey: r.categoryKey, categoryEn: r.categoryEn, categoryAr: r.categoryAr, row: r, subReasons: [] });
  }
  for (const r of rows) if (r.subReasonEn !== null) out.get(r.categoryKey)?.subReasons.push(r);
  return [...out.values()];
}

/** POST / PATCH /nps-followup/reasons: a sub-reason (categoryKey + subReason*), a category (category*), or a change. */
export interface ReasonInput {
  categoryKey?: string;
  categoryEn?: string;
  categoryAr?: string;
  subReasonEn?: string;
  subReasonAr?: string;
  sortOrder?: number;
  isActive?: boolean;
}

export interface FollowupOptions {
  stages: FollowupStage[];
  statuses: FollowupStatus[];
  reasons: FollowupReason[];
  /** Owner names already used on cases plus active users' names (suggestions for the free-text Owner). */
  owners: string[];
}

export interface FollowupKpis {
  /** by status (every case of the filters, Historical has none) */
  open: number;
  close: number;
  disputed: number;
  total: number;
  openShare: number | null;
  closeShare: number | null;
  disputedShare: number | null;
  /** by stage and the SLA (the board's cases) */
  closeSlaMissed: number;
  contactSlaMissed: number;
  resolved30Days: number;
  resolvedInSla: number;
  noReason: number;
}

export interface FollowupBoard {
  cases: FollowupCase[];
  truncated: boolean;
  kpis: FollowupKpis;
  now: string;
}

export interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** The follow-up's own filters (kept in the URL); the global filters come from the FilterBar. */
export interface FollowupFilters {
  view: 'board' | 'list';
  dateFrom?: string;
  dateTo?: string;
  stages: FollowupStage[];
  statuses: FollowupStatus[];
  /** reason category keys */
  categories: string[];
  /** exact reasons (sub-reasons) */
  reasonIds: number[];
  /** owner names (the Owner is free text); NO_OWNER = no owner yet */
  owners: string[];
  sourceChanged?: boolean;
  search?: string;
}

export const EMPTY_FILTERS: FollowupFilters = { view: 'board', stages: [], statuses: [], categories: [], reasonIds: [], owners: [] };

/** `owners` filter value meaning "no owner yet" (same token as the API). */
export const NO_OWNER = '__none__';

export interface CaseEdit {
  version: number;
  stage?: FollowupStage;
  reasonId?: number | null;
  reasonNote?: string | null;
  /** free text; '' clears it */
  owner?: string | null;
  contactedAt?: string | null;
  resolvedAt?: string | null;
  rootCause?: string | null;
  actionTaken?: string | null;
  notes?: string | null;
}

const ints = (v: string | null) => (v ? v.split(',').map(Number).filter((n) => Number.isInteger(n) && n >= 0) : []);
const oneOf = <T extends string>(v: string | null, allowed: readonly T[]): T[] => (v ?? '').split(',').filter((s): s is T => (allowed as readonly string[]).includes(s));

export function filtersFromSearch(search: string): FollowupFilters & { caseId: number | null } {
  const p = new URLSearchParams(search);
  const sc = p.get('sourceChanged');
  const caseId = Number(p.get('case'));
  return {
    view: p.get('view') === 'list' ? 'list' : 'board',
    dateFrom: p.get('dateFrom') || undefined,
    dateTo: p.get('dateTo') || undefined,
    stages: oneOf(p.get('stages'), STAGES),
    statuses: oneOf(p.get('statuses'), STATUSES),
    categories: (p.get('categories') ?? '').split(',').map((c) => c.trim()).filter((c) => /^[a-z0-9_]{1,40}$/.test(c)),
    reasonIds: ints(p.get('reasonIds')).filter((n) => n > 0),
    owners: (p.get('owners') ?? '').split(',').map((o) => o.trim()).filter(Boolean),
    sourceChanged: sc === 'true' ? true : sc === 'false' ? false : undefined,
    search: p.get('search') || undefined,
    caseId: Number.isInteger(caseId) && caseId > 0 ? caseId : null,
  };
}

/** URL query of the follow-up filters (the page's own state; default values are left out). */
export function filtersToSearch(f: FollowupFilters, caseId: number | null = null): string {
  const p = new URLSearchParams();
  if (f.view === 'list') p.set('view', 'list');
  if (f.dateFrom) p.set('dateFrom', f.dateFrom);
  if (f.dateTo) p.set('dateTo', f.dateTo);
  if (f.stages.length) p.set('stages', f.stages.join(','));
  if (f.statuses.length) p.set('statuses', f.statuses.join(','));
  if (f.categories.length) p.set('categories', f.categories.join(','));
  if (f.reasonIds.length) p.set('reasonIds', f.reasonIds.join(','));
  if (f.owners.length) p.set('owners', f.owners.join(','));
  if (f.sourceChanged !== undefined) p.set('sourceChanged', String(f.sourceChanged));
  if (f.search) p.set('search', f.search);
  if (caseId) p.set('case', String(caseId));
  return p.toString();
}

/** API query: the global filters + the follow-up filters (+ paging). */
export function apiQuery(global: TachometerFilters, f: FollowupFilters, extra: Record<string, string | number> = {}): string {
  const p = new URLSearchParams();
  (global.companyKeys ?? []).forEach((v) => p.append('companyKeys', String(v)));
  (global.segmentKeys ?? []).forEach((v) => p.append('segmentKeys', String(v)));
  (global.channelKeys ?? []).forEach((v) => p.append('channelKeys', String(v)));
  (global.salesTeamKeys ?? []).forEach((v) => p.append('salesTeamKeys', v));
  (global.salespersonKeys ?? []).forEach((v) => p.append('salespersonKeys', String(v)));
  (global.customerKeys ?? []).forEach((v) => p.append('customerKeys', String(v)));
  const own = new URLSearchParams(filtersToSearch({ ...f, view: 'board' }));
  own.forEach((v, k) => p.set(k, v));
  for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
  return p.toString();
}

const json = (body: unknown): RequestInit => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const followupApi = {
  options: (token: string) => apiRequest<FollowupOptions>('/nps-followup/options', token),
  board: (token: string, q: string) => apiRequest<FollowupBoard>(`/nps-followup/board?${q}`, token),
  cases: (token: string, q: string) => apiRequest<Paged<FollowupCase>>(`/nps-followup/cases?${q}`, token),
  getCase: (token: string, id: number) => apiRequest<{ case: FollowupDetail }>(`/nps-followup/cases/${id}`, token),
  updateCase: (token: string, id: number, edit: CaseEdit) =>
    apiRequest<{ case: FollowupCase }>(`/nps-followup/cases/${id}`, token, { method: 'PATCH', ...json(edit) }),
  reasons: (token: string) => apiRequest<{ rows: FollowupReason[] }>('/nps-followup/reasons', token),
  createReason: (token: string, input: ReasonInput) =>
    apiRequest<{ row: FollowupReason }>('/nps-followup/reasons', token, { method: 'POST', ...json(input) }),
  updateReason: (token: string, id: number, input: ReasonInput) =>
    apiRequest<{ row: FollowupReason }>(`/nps-followup/reasons/${id}`, token, { method: 'PATCH', ...json(input) }),
  deleteReason: (token: string, id: number) => apiRequest<{ success: boolean }>(`/nps-followup/reasons/${id}`, token, { method: 'DELETE' }),

  /** The filtered List view as .xlsx (a Bearer-authenticated fetch, then a local blob link). */
  exportCases: async (token: string, q: string) => {
    const res = await fetch(`${API_BASE}/nps-followup/cases/export?${q}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      try {
        message = (await res.json()).error ?? message;
      } catch {
        // keep generic
      }
      throw new ApiError(res.status, message);
    }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `nps-detractor-followup-${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
};

/** Calendar hours under two days, then days (formatting only; SLA comparisons use exact hours). */
export function formatHoursOpen(hours: number | null): string {
  if (hours === null) return '—';
  if (hours < 2 * HOURS_PER_DAY) return `${Math.floor(hours)} h`;
  return `${(Math.floor((hours / HOURS_PER_DAY) * 10) / 10).toFixed(1)} d`;
}

/** The board's cases by column (= by STAGE), in rating order (oldest first: the longest waiting on top). */
export function byColumn(cases: FollowupCase[]): Record<FollowupStage, FollowupCase[]> {
  const out = Object.fromEntries(STAGES.map((s) => [s, [] as FollowupCase[]])) as unknown as Record<FollowupStage, FollowupCase[]>;
  for (const c of cases) out[c.stage].push(c);
  return out;
}

/** "2026-10-19 09:37:42" -> "2026-10-19T09:37" for <input type="datetime-local">. */
export const toInput = (wall: string | null): string => (wall ? wall.slice(0, 16).replace(' ', 'T') : '');
/** Back from the input: "2026-10-19T09:37" -> "2026-10-19 09:37" (null when empty). */
export const fromInput = (v: string): string | null => (v ? v.replace('T', ' ') : null);

/** The history's fields. The workflow step is `stage`; the status is never in the history (it follows the stage). */
export const FIELD_LABEL: Record<string, string> = {
  stage: 'Stage',
  reason: 'Reason',
  reason_note: 'Reason note',
  owner: 'Owner',
  contacted_at: 'Contacted at',
  resolved_at: 'Resolved at',
  root_cause: 'Root cause',
  action_taken: 'Action taken',
  notes: 'Notes',
  source_changed: 'Source changed',
};

/** History values as people read them (stages by their label). */
export function historyValue(field: string, value: string | null): string {
  if (value === null || value === '') return '—';
  if (field === 'stage') return STAGE_LABEL[value as FollowupStage] ?? value;
  if (field === 'contacted_at' || field === 'resolved_at') return value.slice(0, 16);
  return value;
}
