import { API_BASE, ApiError, apiRequest } from '../api';

/** Kaizen Board API client (backend/src/routes/kaizen.ts, routes/admin/kaizenDropdowns.ts). */

export type KaizenListKey = 'department' | 'card_type' | 'card_priority';
export type KaizenStatus = 'OPEN' | 'CLOSED';

export interface KaizenDropdownValue {
  value_id: number;
  list_key: KaizenListKey;
  label: string;
  sort_order: number;
  color: string;
  is_active: boolean;
  /** Admin listing only. */
  usage_count?: number;
}

export interface KaizenCard {
  card_no: number;
  creator_name: string;
  card_date: string;
  department_id: number;
  card_name: string;
  card_type_id: number;
  issue: string;
  root_cause: string | null;
  impact: string | null;
  priority_id: number;
  proposed_solution: string | null;
  expected_date: string | null;
  closer_date: string | null;
  responsible_party: string | null;
  status: KaizenStatus;
  source: 'MANUAL' | 'IMPORT';
  is_overdue: boolean;
  created_by_name: string | null;
  created_at: string;
  updated_by_name: string | null;
  updated_at: string;
}

export interface KaizenOptions {
  dropdowns: KaizenDropdownValue[];
  responsibleParties: string[];
  creators: string[];
}

export interface KaizenCountByValue {
  value_id: number;
  count: number;
}

export interface KaizenDashboard {
  total: number;
  open: number;
  closed: number;
  overdue: number;
  avgDaysToClose: number | null;
  closedCount: number;
  topDepartment: KaizenCountByValue | null;
  topSubmitter: { name: string; count: number } | null;
  topType: KaizenCountByValue | null;
  byDepartment: KaizenCountByValue[];
  byPriority: KaizenCountByValue[];
  byType: KaizenCountByValue[];
  byResponsible: { name: string | null; count: number; open: number; closed: number }[];
}

/** Every filter the cards list understands; the dashboard uses dateFrom/dateTo/departmentIds. */
export interface KaizenFilters {
  dateFrom?: string;
  dateTo?: string;
  departmentIds?: number[];
  typeIds?: number[];
  priorityIds?: number[];
  status?: KaizenStatus | '';
  search?: string;
  overdue?: boolean;
  creator?: string;
  /** '' = "(Not assigned)"; undefined = no filter. */
  responsibleParty?: string;
}

export interface KaizenCardInput {
  creatorName: string;
  cardDate: string;
  departmentId: number | '';
  cardName: string;
  cardTypeId: number | '';
  issue: string;
  rootCause: string;
  impact: string;
  priorityId: number | '';
  proposedSolution: string;
  expectedDate: string;
  closerDate: string;
  responsibleParty: string;
  status: KaizenStatus;
}

export interface KaizenImportResult {
  fileRows: number;
  validRows: number;
  problems: { row: number; field?: string; code: string; message: string }[];
  unmatched: Record<KaizenListKey, string[]>;
  alreadyImported: boolean;
  committed: boolean;
  imported: number;
}

/** Filters <-> URL query (the dashboard links into the lists pre-filtered this way). */
export function filtersToQuery(f: KaizenFilters, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  if (f.dateFrom) p.set('dateFrom', f.dateFrom);
  if (f.dateTo) p.set('dateTo', f.dateTo);
  if (f.departmentIds?.length) p.set('departmentIds', f.departmentIds.join(','));
  if (f.typeIds?.length) p.set('typeIds', f.typeIds.join(','));
  if (f.priorityIds?.length) p.set('priorityIds', f.priorityIds.join(','));
  if (f.status) p.set('status', f.status);
  if (f.search) p.set('search', f.search);
  if (f.overdue) p.set('overdue', 'true');
  if (f.creator) p.set('creator', f.creator);
  if (f.responsibleParty !== undefined) p.set('responsibleParty', f.responsibleParty);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p.toString();
}

export function filtersFromQuery(search: string): KaizenFilters {
  const p = new URLSearchParams(search);
  const ids = (k: string) => (p.get(k) ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const status = p.get('status');
  return {
    dateFrom: p.get('dateFrom') ?? undefined,
    dateTo: p.get('dateTo') ?? undefined,
    departmentIds: ids('departmentIds'),
    typeIds: ids('typeIds'),
    priorityIds: ids('priorityIds'),
    status: status === 'OPEN' || status === 'CLOSED' ? status : '',
    search: p.get('search') ?? undefined,
    overdue: p.get('overdue') === 'true',
    creator: p.get('creator') ?? undefined,
    responsibleParty: p.has('responsibleParty') ? (p.get('responsibleParty') ?? '') : undefined,
  };
}

const json = (body: unknown): RequestInit => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const kaizenApi = {
  options: (token: string) => apiRequest<KaizenOptions>('/kaizen/options', token),
  dashboard: (token: string, f: KaizenFilters) => apiRequest<KaizenDashboard>(`/kaizen/dashboard?${filtersToQuery(f)}`, token),
  qr: (token: string) => apiRequest<{ url: string; dataUrl: string }>('/kaizen/qr', token),
  listCards: (token: string, f: KaizenFilters, sort?: { by: string; dir: 'asc' | 'desc' }) =>
    apiRequest<{ rows: KaizenCard[]; total: number }>(
      `/kaizen/cards?${filtersToQuery(f, sort ? { sortBy: sort.by, sortDir: sort.dir } : {})}`,
      token,
    ),
  getCard: (token: string, no: number) => apiRequest<{ card: KaizenCard }>(`/kaizen/cards/${no}`, token),
  createCard: (token: string, input: KaizenCardInput) =>
    apiRequest<{ card: KaizenCard }>('/kaizen/cards', token, { method: 'POST', ...json(input) }),
  updateCard: (token: string, no: number, input: Partial<KaizenCardInput>) =>
    apiRequest<{ card: KaizenCard }>(`/kaizen/cards/${no}`, token, { method: 'PATCH', ...json(input) }),
  closeCard: (token: string, no: number, closerDate: string) =>
    apiRequest<{ card: KaizenCard }>(`/kaizen/cards/${no}/close`, token, { method: 'POST', ...json({ closerDate }) }),
  deleteCard: (token: string, no: number) => apiRequest<{ success: boolean }>(`/kaizen/cards/${no}`, token, { method: 'DELETE' }),

  /** Downloads the filtered list as .xlsx (a Bearer-authenticated fetch, then a local blob link). */
  exportCards: async (token: string, f: KaizenFilters, sort: { by: string; dir: 'asc' | 'desc' }) => {
    const res = await fetch(`${API_BASE}/kaizen/cards/export?${filtersToQuery(f, { sortBy: sort.by, sortDir: sort.dir })}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
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
    a.download = `kaizen-cards-${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  importCards: (token: string, file: File, commit: boolean) => {
    const form = new FormData();
    form.append('file', file);
    return apiRequest<KaizenImportResult>(`/kaizen/import${commit ? '?commit=1' : ''}`, token, { method: 'POST', body: form });
  },

  // Admin: dropdown values
  adminListDropdowns: (token: string) => apiRequest<{ rows: KaizenDropdownValue[] }>('/admin/kaizen-dropdowns', token),
  adminCreateDropdown: (token: string, input: { listKey: KaizenListKey; label: string; color: string }) =>
    apiRequest<{ row: KaizenDropdownValue }>('/admin/kaizen-dropdowns', token, { method: 'POST', ...json(input) }),
  adminUpdateDropdown: (token: string, id: number, input: Partial<{ label: string; color: string; isActive: boolean }>) =>
    apiRequest<{ row: KaizenDropdownValue }>(`/admin/kaizen-dropdowns/${id}`, token, { method: 'PATCH', ...json(input) }),
  adminReorderDropdowns: (token: string, listKey: KaizenListKey, orderedIds: number[]) =>
    apiRequest<{ rows: KaizenDropdownValue[] }>('/admin/kaizen-dropdowns/reorder', token, { method: 'POST', ...json({ listKey, orderedIds }) }),
  adminDeleteDropdown: (token: string, id: number) =>
    apiRequest<{ success: boolean }>(`/admin/kaizen-dropdowns/${id}`, token, { method: 'DELETE' }),
};

/** The backend's validation code (translated by the caller), when the error carries one. */
export function errorCode(err: unknown): string | null {
  if (err instanceof ApiError && err.body && typeof err.body === 'object' && 'code' in err.body) {
    return String((err.body as { code: unknown }).code);
  }
  return null;
}

/** Today in the business timezone (Africa/Tripoli), as YYYY-MM-DD -- the default card Date. */
export function todayIso(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.NEXT_PUBLIC_APP_TIMEZONE || 'Africa/Tripoli',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
