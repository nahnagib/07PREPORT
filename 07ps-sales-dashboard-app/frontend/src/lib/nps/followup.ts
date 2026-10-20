import { API_BASE, ApiError, apiRequest, type TachometerFilters } from '../api';

/** NPS Detractor Follow-up API client and view helpers (backend routes/npsFollowup.ts; docs/nps-followup.md). */

export const STATUSES = ['HISTORICAL', 'NEW', 'CONTACTED', 'IN_PROGRESS', 'SOLVED', 'CANCELLED'] as const;
export type FollowupStatus = (typeof STATUSES)[number];
/** The board's columns, left to right (Historical cases appear only in the List view). */
export const BOARD_COLUMNS: readonly FollowupStatus[] = ['NEW', 'CONTACTED', 'IN_PROGRESS', 'SOLVED', 'CANCELLED'];
export const EDITABLE_STATUSES: readonly FollowupStatus[] = BOARD_COLUMNS;
export type TimeBand = 'green' | 'yellow' | 'red';

export const STATUS_LABEL: Record<FollowupStatus, string> = {
  HISTORICAL: 'Historical',
  NEW: 'New',
  CONTACTED: 'Contacted',
  IN_PROGRESS: 'In progress',
  SOLVED: 'Solved',
  CANCELLED: 'Cancelled',
};

export const STATUS_COLOR: Record<FollowupStatus, string> = {
  HISTORICAL: 'var(--ps-color-muted-text)',
  NEW: 'var(--ps-color-accent)',
  CONTACTED: 'var(--ps-color-watch)',
  IN_PROGRESS: 'var(--ps-color-gold)',
  SOLVED: 'var(--ps-color-success)',
  CANCELLED: 'var(--ps-color-muted-text)',
};

export const BAND_COLOR: Record<TimeBand, string> = {
  green: 'var(--ps-color-success)',
  yellow: 'var(--ps-color-watch)',
  red: 'var(--ps-color-alert)',
};

export const BAND_HINT = 'Time open, from the rating to Solved (or to now while open): green under 48 h, yellow 48 h to 5 days, red over 5 days.';

export interface FollowupCase {
  caseId: number;
  responseId: number;
  ratedAt: string | null;
  status: FollowupStatus;
  reasonId: number | null;
  reasonEn: string | null;
  reasonAr: string | null;
  ownerUserId: number | null;
  ownerName: string | null;
  contactedAt: string | null;
  solvedAt: string | null;
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
  hoursOpen: number | null;
  timeBand: TimeBand | null;
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

export interface FollowupReason {
  reasonId: number;
  nameEn: string;
  nameAr: string;
  sortOrder: number;
  isActive: boolean;
  usageCount: number;
}

export interface FollowupOptions {
  statuses: FollowupStatus[];
  reasons: FollowupReason[];
  owners: { userId: number; name: string }[];
}

export interface FollowupBoard {
  cases: FollowupCase[];
  truncated: boolean;
  kpis: { open: number; openOver5Days: number; solved30Days: number; solvedWithin48h: number; noReason: number; cancelled: number };
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
  statuses: FollowupStatus[];
  reasonIds: number[];
  /** 0 = no owner yet */
  ownerIds: number[];
  sourceChanged?: boolean;
  search?: string;
}

export const EMPTY_FILTERS: FollowupFilters = { view: 'board', statuses: [], reasonIds: [], ownerIds: [] };

export interface CaseEdit {
  version: number;
  status?: FollowupStatus;
  reasonId?: number | null;
  ownerUserId?: number | null;
  contactedAt?: string | null;
  solvedAt?: string | null;
  rootCause?: string | null;
  actionTaken?: string | null;
  notes?: string | null;
}

const ints = (v: string | null) => (v ? v.split(',').map(Number).filter((n) => Number.isInteger(n) && n >= 0) : []);

export function filtersFromSearch(search: string): FollowupFilters & { caseId: number | null } {
  const p = new URLSearchParams(search);
  const statuses = (p.get('statuses') ?? '').split(',').filter((s): s is FollowupStatus => (STATUSES as readonly string[]).includes(s));
  const sc = p.get('sourceChanged');
  const caseId = Number(p.get('case'));
  return {
    view: p.get('view') === 'list' ? 'list' : 'board',
    dateFrom: p.get('dateFrom') || undefined,
    dateTo: p.get('dateTo') || undefined,
    statuses,
    reasonIds: ints(p.get('reasonIds')).filter((n) => n > 0),
    ownerIds: ints(p.get('ownerIds')),
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
  if (f.statuses.length) p.set('statuses', f.statuses.join(','));
  if (f.reasonIds.length) p.set('reasonIds', f.reasonIds.join(','));
  if (f.ownerIds.length) p.set('ownerIds', f.ownerIds.join(','));
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
  createReason: (token: string, input: Partial<FollowupReason>) =>
    apiRequest<{ row: FollowupReason }>('/nps-followup/reasons', token, { method: 'POST', ...json(input) }),
  updateReason: (token: string, id: number, input: Partial<FollowupReason>) =>
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

/** "26 h" under two days, then "3.4 d". */
export function formatHoursOpen(hours: number | null): string {
  if (hours === null) return '—';
  if (hours < 48) return `${Math.floor(hours)} h`;
  return `${(Math.floor((hours / 24) * 10) / 10).toFixed(1)} d`;
}

/** The board's cases by column, in rating order (oldest first: the longest waiting on top). */
export function byColumn(cases: FollowupCase[]): Record<FollowupStatus, FollowupCase[]> {
  const out = Object.fromEntries(STATUSES.map((s) => [s, [] as FollowupCase[]])) as unknown as Record<FollowupStatus, FollowupCase[]>;
  for (const c of cases) out[c.status].push(c);
  return out;
}

/** "2026-10-19 09:37:42" -> "2026-10-19T09:37" for <input type="datetime-local">. */
export const toInput = (wall: string | null): string => (wall ? wall.slice(0, 16).replace(' ', 'T') : '');
/** Back from the input: "2026-10-19T09:37" -> "2026-10-19 09:37" (null when empty). */
export const fromInput = (v: string): string | null => (v ? v.replace('T', ' ') : null);

export const FIELD_LABEL: Record<string, string> = {
  status: 'Status',
  reason: 'Reason',
  owner: 'Owner',
  contacted_at: 'Contacted at',
  solved_at: 'Solved at',
  root_cause: 'Root cause',
  action_taken: 'Action taken',
  notes: 'Notes',
  source_changed: 'Source changed',
};

/** History values as people read them (statuses by their label). */
export function historyValue(field: string, value: string | null): string {
  if (value === null || value === '') return '—';
  if (field === 'status') return STATUS_LABEL[value as FollowupStatus] ?? value;
  if (field === 'contacted_at' || field === 'solved_at') return value.slice(0, 16);
  return value;
}
