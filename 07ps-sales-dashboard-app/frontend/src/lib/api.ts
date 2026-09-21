/**
 * Backend API client. Talks to the Node/Express backend built in this session
 * (backend/src/routes/*.ts), never directly to MySQL or to Odoo.
 *
 * IMPORTANT: this page runs against the throwaway/validation MySQL warehouse
 * (data loaded directly from SalesModel_OneOutput.xlsx plus a mocked Odoo catalog -- see
 * data/ingestion/tachometer_kpi_validation.md). There is no live Odoo connection. Nothing in this
 * client or the UI should ever claim otherwise.
 */

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, token: string | null, init?: RequestInit): Promise<T> {
  const url = `${API_BASE}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    // A caller-initiated abort (superseded filter request) is not a failure -- let it through as-is.
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    // Dev-diagnosability fix (Section 3.23 gap): a network-level failure -- backend not running,
    // wrong port, CORS preflight block -- throws here as an opaque `TypeError: Failed to fetch`
    // before we ever get a Response to inspect. Log the real error + the URL we tried, so this is
    // diagnosable from the browser console alone instead of needing a fresh investigation each time.
    // eslint-disable-next-line no-console
    console.error(`[api] network failure calling ${url} -- is the backend running on ${API_BASE}? (CORS/port mismatches land here too):`, err);
    throw new ApiError(0, 'Could not reach the server. It may be offline or unreachable.');
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    let rawBody: unknown;
    try {
      rawBody = await res.json();
      if (rawBody && typeof rawBody === 'object' && 'error' in rawBody) {
        message = String((rawBody as { error?: unknown }).error);
      }
    } catch {
      // ignore -- keep generic message, never surface raw parse errors (Section 5.9)
    }
    // eslint-disable-next-line no-console
    console.error(`[api] ${url} responded ${res.status}:`, rawBody ?? '(non-JSON body)');
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}

export interface DimOption {
  [key: string]: string | number | null;
}

// Multi-select: each field holds the set of selected keys. An empty/missing array means "All"
// (no restriction on that dimension) -- same contract the single-value fields used to have for
// null/undefined.
export interface TachometerFilters {
  companyKeys?: number[];
  segmentKeys?: number[];
  channelKeys?: number[];
  salesTeamKeys?: string[];
  salespersonKeys?: number[];
  /** Sales-transaction pages only (Fact_SalesLines-grain KPIs); targets/CRM data have no customer. */
  customerKeys?: number[];
}

export type TargetStatus = 'green' | 'yellow' | 'red' | 'no_target';

export interface TachometerCard {
  actual: number;
  targetToDate: number | null;
  status: TargetStatus;
  variancePct: number | null;
  lastYearSamePeriod: number;
  fullLastPeriodActual: number;
  fullPeriodTarget: number;
}

export interface AspCard {
  actualAsp: number | null;
  targetAsp: number | null;
  /** Same-period-last-year ASP (LYTD ASP for the YTD card, LMTD ASP for the MTD card) -- powers
   * the "Variance vs LY" reference-metric tile. */
  lastYearAsp: number | null;
  status: TargetStatus;
}

export interface TachometerOverview {
  anchorDate: string;
  ytdValue: TachometerCard;
  ytdVolume: TachometerCard;
  mtdValue: TachometerCard;
  mtdVolume: TachometerCard;
  aspYtd: AspCard;
  aspMtd: AspCard;
}

function buildQuery(anchorDate: string, filters: TachometerFilters): string {
  const params = new URLSearchParams({ anchorDate });
  (filters.companyKeys ?? []).forEach((v) => params.append('companyKeys', String(v)));
  (filters.segmentKeys ?? []).forEach((v) => params.append('segmentKeys', String(v)));
  (filters.channelKeys ?? []).forEach((v) => params.append('channelKeys', String(v)));
  (filters.salesTeamKeys ?? []).forEach((v) => params.append('salesTeamKeys', v));
  (filters.salespersonKeys ?? []).forEach((v) => params.append('salespersonKeys', String(v)));
  (filters.customerKeys ?? []).forEach((v) => params.append('customerKeys', String(v)));
  return params.toString();
}

export function fetchTachometerOverview(
  token: string,
  anchorDate: string,
  filters: TachometerFilters,
): Promise<TachometerOverview> {
  return request(`/tachometer/overview?${buildQuery(anchorDate, filters)}`, token);
}

/** Response of GET /filters/options (backend/src/filters/optionsService.ts): valid options for all
 * seven filters given the current selection, plus that selection with now-invalid values removed. */
export interface FilterOptionsResponse {
  filters: Required<TachometerFilters>;
  options: {
    businessUnits: DimOption[];
    customerGroups: DimOption[];
    distributionChannels: DimOption[];
    branches: DimOption[];
    salespersons: DimOption[];
    customers: DimOption[];
  };
  hasData: boolean;
}

export function fetchFilterOptions(
  token: string,
  filters: TachometerFilters,
  window: { dateFrom?: string | null; dateTo?: string | null },
  signal?: AbortSignal,
): Promise<FilterOptionsResponse> {
  const params = new URLSearchParams(buildQuery('', filters));
  params.delete('anchorDate');
  if (window.dateFrom) params.set('dateFrom', window.dateFrom);
  if (window.dateTo) params.set('dateTo', window.dateTo);
  return request<FilterOptionsResponse>(`/filters/options?${params.toString()}`, token, { signal });
}

export function fetchBusinessUnits(token: string) {
  return request<DimOption[]>('/filters/business-units', token);
}

/** Upstream keys already selected in a cascading Filter Bar -- Company Link + Cascading Filter
 * Bar, 2026-09. Each cascading fetch* function below only accepts the subset of these its own
 * endpoint actually narrows by (e.g. fetchCustomerGroups only reads companyKeys, since Customer
 * Group is the first dimension narrowed by Company). Omitting `upstream` entirely (or passing all-
 * empty arrays) hits each endpoint's unchanged fast path -- see routes/filters.ts's module
 * docstring. */
export interface CascadeUpstream {
  companyKeys?: number[];
  segmentKeys?: number[];
  channelKeys?: number[];
  salesTeamKeys?: string[];
}

function cascadeQuery(upstream: CascadeUpstream | undefined, keys: (keyof CascadeUpstream)[]): string {
  const params = new URLSearchParams();
  for (const key of keys) {
    const values = upstream?.[key] ?? [];
    for (const v of values) params.append(key, String(v));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function fetchCustomerGroups(token: string, upstream?: Pick<CascadeUpstream, 'companyKeys'>) {
  return request<DimOption[]>(`/filters/customer-groups${cascadeQuery(upstream, ['companyKeys'])}`, token);
}
export function fetchDistributionChannels(token: string, upstream?: Pick<CascadeUpstream, 'companyKeys' | 'segmentKeys'>) {
  return request<DimOption[]>(`/filters/distribution-channels${cascadeQuery(upstream, ['companyKeys', 'segmentKeys'])}`, token);
}
export function fetchBranches(token: string, upstream?: Pick<CascadeUpstream, 'companyKeys' | 'segmentKeys' | 'channelKeys'>) {
  return request<DimOption[]>(`/filters/branches${cascadeQuery(upstream, ['companyKeys', 'segmentKeys', 'channelKeys'])}`, token);
}
export function fetchSalespersons(token: string, upstream?: CascadeUpstream) {
  return request<DimOption[]>(
    `/filters/salespersons${cascadeQuery(upstream, ['companyKeys', 'segmentKeys', 'channelKeys', 'salesTeamKeys'])}`,
    token,
  );
}

export interface RefreshStatus {
  lastUpdate: string | null;
  /** Odoo sale.order.create_date (record creation), distinct from lastUpdate (date_order --
   * the order/confirmation date). Can point at a different order than lastUpdate. */
  lastOrderCreated: string | null;
  lastRefreshTime: string | null;
  isStale: boolean;
  /** true iff refreshCheck.inconsistent -- kept for the pages that already pass it. */
  isInverted: boolean;
  refreshCheck?: RefreshCheck;
  /** IANA zone the API/ETL treat as the business zone (APP_TIMEZONE). */
  displayTimezone?: string;
}

/** Mirrors backend/src/measures/refreshStatus.ts's RefreshCheck. */
export interface RefreshCheck {
  status: 'ok' | 'no_refresh_log' | 'refresh_before_data' | 'data_ahead_of_watermark' | 'timezone_mismatch' | 'last_run_failed_after_load';
  inconsistent: boolean;
  message: string;
  action: string | null;
  timezone: string;
  toleranceMinutes: number;
  lastRefreshUtc: string | null;
  latestLoadedOrderUtc: string | null;
  watermarkOrderCreatedUtc: string | null;
  differenceMinutes: number | null;
}

export function fetchRefreshStatus(token: string) {
  return request<RefreshStatus>('/meta/refresh-status', token);
}

// ---------------------------------------------------------------------------
// Auth (backend/src/routes/auth.ts) -- real login/session module.
// ---------------------------------------------------------------------------

export type UserStatus = 'ACTIVE' | 'INACTIVE' | 'LOCKED' | 'PENDING_PASSWORD_CHANGE';

export interface PublicUser {
  id: number;
  email: string;
  fullName: string;
  status: UserStatus;
  mustChangePassword: boolean;
  role: { id: number | null; name: string | null; label: string | null };
  lastLoginAt: string | null;
  isSalesperson: boolean;
  salespersonKey: number | null;
}

export interface PagePermission {
  canView: boolean;
  canExport: boolean;
}
export type EffectivePermissions = Record<string, PagePermission>;

export interface LoginResponse {
  token: string;
  user: PublicUser;
  permissions: EffectivePermissions;
}

export function login(email: string, password: string): Promise<LoginResponse> {
  return request('/auth/login', null, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

export function logout(token: string): Promise<{ ok: boolean }> {
  return request('/auth/logout', token, { method: 'POST' });
}

export function fetchMe(token: string): Promise<{ user: PublicUser; permissions: EffectivePermissions }> {
  return request('/auth/me', token);
}

export function changePassword(
  token: string,
  currentPassword: string,
  newPassword: string,
): Promise<{ token: string }> {
  return request('/auth/change-password', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export function forgotPassword(email: string): Promise<{ ok: boolean; message: string }> {
  return request('/auth/forgot-password', null, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
}

export function resetPassword(token: string, newPassword: string): Promise<{ ok: boolean }> {
  return request('/auth/reset-password', null, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, newPassword }),
  });
}

// ---------------------------------------------------------------------------
// Admin (backend/src/routes/admin/*) -- user management, roles/permissions, import, login history.
// ---------------------------------------------------------------------------

export interface AdminUser {
  [key: string]: unknown;
  user_id: number;
  email: string;
  display_name: string;
  company_scope: 'ALL' | 'MAJAAL' | 'TIKA';
  salesperson_key: number | null;
  is_active: number;
  created_at: string;
  status: UserStatus;
  must_change_password: number;
  last_login_at: string | null;
  updated_at: string;
  failed_login_count: number;
  password_changed_at: string | null;
  password_reset_expires_at: string | null;
  sessions_revoked_at: string | null;
  role_id: number | null;
  role_name: string | null;
  role_label: string | null;
  role_tier_code: string | null;
}

export interface AdminRole {
  role_id: number;
  role_name: string;
  role_label: string;
  default_role_tier_code: string | null;
  is_system: number;
}

/**
 * Admin Salesperson Management (backend/src/routes/admin/salespersons.ts). UPDATED
 * (Reports/Dashboards Honor Admin Salesperson Overrides, 2026-09): the *_override /
 * target_override_amount fields now reclassify this salesperson's revenue/target everywhere on
 * every dashboard and report -- see backend/src/services/salespersonAdminService.ts's header
 * comment for the full mechanism. This one admin page is the deliberate exception: its own
 * ytd_sales_value/ytd_target_amount/ytd_attainment_pct columns stay real, unoverridden reads off
 * Fact_SalesLines/Fact_Targets for this one salesperson (an override never changes which
 * salesperson a row belongs to, so this page's own single-salesperson sum is unaffected by
 * segment/channel/team reclassification regardless) -- shown deliberately alongside
 * target_override_amount so the admin can compare real history against what they're about to set,
 * rather than one silently overwriting the other on this page.
 *
 * company_key_override (Company Link + Cascading Filter Bar, 2026-09) is the one field here that
 * is NOT part of the reclassification mechanism above -- deliberate, confirmed. It exists purely
 * for organizational labeling and as an input to the cascading Filter Bar's dropdown narrowing
 * (fetchCustomerGroups/fetchDistributionChannels/fetchBranches/fetchSalespersons' `upstream`
 * param above). Report totals are never affected by it.
 */
export interface SalespersonAdminRow {
  [key: string]: unknown;
  salesperson_key: number;
  salesperson_name: string;
  admin_name_override: string | null;
  ytd_sales_value: number;
  ytd_target_amount: number;
  ytd_attainment_pct: number | null;
  channel_key_override: number | null;
  channel_name_override: string | null;
  segment_key_override: number | null;
  segment_name_override: string | null;
  sales_team_key_override: string | null;
  sales_team_name_override: string | null;
  company_key_override: number | null;
  company_name_override: string | null;
  target_override_amount: number | null;
  note: string | null;
  updated_at: string | null;
  updated_by_email: string | null;
  linked_user_id: number | null;
  linked_user_email: string | null;
}

export interface SalespersonProfileHistoryRow {
  history_id: number;
  admin_name_override: string | null;
  channel_key_override: number | null;
  segment_key_override: number | null;
  sales_team_key_override: string | null;
  company_key_override: number | null;
  target_override_amount: number | null;
  note: string | null;
  changed_at: string;
  changed_by_email: string | null;
}

export interface SalespersonProfilePatch {
  adminNameOverride?: string | null;
  channelKeyOverride?: number | null;
  segmentKeyOverride?: number | null;
  salesTeamKeyOverride?: string | null;
  companyKeyOverride?: number | null;
  targetOverrideAmount?: number | null;
  note?: string | null;
}

/** Options for the Salesperson dropdown on Create/Edit User -- backend/src/services/userService.ts's
 * getSalespersonOptions(), live Dim_Salesperson data (no is_active column exists there). */
export interface SalespersonOption {
  salesperson_key: number;
  salesperson_name: string;
  sales_team_key: string | null;
  sales_team_name: string | null;
  distribution_channel: string | null;
}

/**
 * Sales Team Management (backend/src/routes/admin/salesteams.ts). Same overlay caveat as
 * SalespersonAdminRow -- sales_team_name already falls back to the live Dim_SalesTeam name when
 * no team_name_override is recorded (done server-side). segment_key_override now feeds dashboards/
 * reports too (see SalespersonAdminRow's updated comment above and
 * backend/src/services/salesTeamAdminService.ts's header). company_key_override is NOT part of
 * that reclassification -- same deliberate exception as SalespersonAdminRow's own field.
 */
export interface SalesTeamAdminRow {
  [key: string]: unknown;
  sales_team_key: string;
  sales_team_name: string;
  team_code: string | null;
  segment_key_override: number | null;
  segment_name_override: string | null;
  company_key_override: number | null;
  company_name_override: string | null;
  target_override_amount: number | null;
  note: string | null;
  updated_at: string | null;
  updated_by_email: string | null;
}

export interface SalesTeamProfileHistoryRow {
  history_id: number;
  team_name_override: string | null;
  team_code: string | null;
  segment_key_override: number | null;
  company_key_override: number | null;
  target_override_amount: number | null;
  note: string | null;
  changed_at: string;
  changed_by_email: string | null;
}

export interface SalesTeamProfilePatch {
  teamNameOverride?: string | null;
  teamCode?: string;
  segmentKeyOverride?: number | null;
  companyKeyOverride?: number | null;
  targetOverrideAmount?: number | null;
  note?: string | null;
}

/**
 * Admin-controlled reference data (backend/src/routes/admin/customerGroups.ts,
 * distributionChannels.ts, companies.ts -- see data/warehouse/migrations/0018_reference_data_admin.sql).
 * Each row optionally links to a live ETL key; usage_count tells the frontend whether
 * Deactivate/Delete are safe to offer without a second round-trip.
 */
export interface ReferenceDataRow {
  [key: string]: unknown;
  name: string;
  definition: string | null;
  display_order: number;
  is_active: boolean;
  created_at: string;
  created_by_email: string | null;
  updated_at: string;
  updated_by_email: string | null;
  usage_count: number;
}

export interface CustomerGroupRow extends ReferenceDataRow {
  customer_group_id: number;
  etl_segment_key: number | null;
  etl_segment_name: string | null;
  /** Share of the Daily Critical Number (0-100) this group contributes -- see
   * backend/src/measures/criticalNumber.ts's computeDailyCriticalNumber. */
  critical_number_pct: number;
}

export interface DistributionChannelRow extends ReferenceDataRow {
  distribution_channel_id: number;
  etl_channel_key: number | null;
  etl_channel_name: string | null;
}

export interface CompanyRow extends ReferenceDataRow {
  company_id: number;
  etl_company_key: number | null;
  etl_company_name: string | null;
  /** Share of the Daily Critical Number (0-100) this company contributes -- see
   * backend/src/measures/criticalNumber.ts's computeDailyCriticalNumber. */
  critical_number_pct: number;
}

export interface ReferenceDataPatch {
  name?: string;
  definition?: string | null;
  displayOrder?: number;
  isActive?: boolean;
}

/**
 * Admin-controlled Official Holidays / Forced Closures (backend/src/routes/admin/holidays.ts,
 * closures.ts -- see data/warehouse/migrations/0020_holidays_closures_admin.sql). Read by the
 * Critical Number page's working-day math -- edits here take effect on the page's very next load.
 */
export interface HolidayRow {
  [key: string]: unknown;
  holiday_id: number;
  holiday_name: string;
  holiday_date: string;
  recurring: boolean;
  company: string | null;
  is_active: boolean;
  created_at: string;
  created_by_email: string | null;
  updated_at: string;
  updated_by_email: string | null;
}

export interface HolidayPatch {
  holidayName?: string;
  holidayDate?: string;
  recurring?: boolean;
  company?: string | null;
  isActive?: boolean;
}

export interface ClosureRow {
  [key: string]: unknown;
  closure_id: number;
  branch_key: string;
  branch_name: string | null;
  company: string | null;
  closure_date: string;
  duration_days: number;
  reason: string | null;
  is_active: boolean;
  created_at: string;
  created_by_email: string | null;
  updated_at: string;
  updated_by_email: string | null;
}

export interface ClosurePatch {
  branchKey?: string;
  company?: string | null;
  closureDate?: string;
  durationDays?: number;
  reason?: string | null;
  isActive?: boolean;
}

export const adminApi = {
  listRoles: (token: string): Promise<AdminRole[]> => request('/admin/users/meta/roles', token),

  getSalespersonOptions: (token: string): Promise<SalespersonOption[]> =>
    request('/admin/users/meta/salespersons', token),

  listUsers: (
    token: string,
    params: { search?: string; status?: UserStatus; roleId?: number; page?: number; pageSize?: number } = {},
  ): Promise<{ rows: AdminUser[]; total: number; page: number; pageSize: number }> => {
    const qs = new URLSearchParams();
    if (params.search) qs.set('search', params.search);
    if (params.status) qs.set('status', params.status);
    if (params.roleId !== undefined) qs.set('roleId', String(params.roleId));
    qs.set('page', String(params.page ?? 1));
    qs.set('pageSize', String(params.pageSize ?? 25));
    return request(`/admin/users?${qs.toString()}`, token);
  },

  getUser: (token: string, userId: number): Promise<{ user: AdminUser; permissions: EffectivePermissions }> =>
    request(`/admin/users/${userId}`, token),

  createUser: (
    token: string,
    input: {
      fullName: string;
      email: string;
      roleId: number;
      status?: UserStatus;
      tempPassword?: string;
      salespersonKey?: number | null;
      companyScope?: 'ALL' | 'MAJAAL' | 'TIKA';
    },
  ): Promise<{ user: AdminUser; tempPassword: string }> =>
    request('/admin/users', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),

  updateUser: (
    token: string,
    userId: number,
    input: { fullName?: string; salespersonKey?: number | null; companyScope?: 'ALL' | 'MAJAAL' | 'TIKA' },
  ): Promise<{ user: AdminUser }> =>
    request(`/admin/users/${userId}`, token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),

  setStatus: (token: string, userId: number, status: UserStatus): Promise<{ user: AdminUser }> =>
    request(`/admin/users/${userId}/status`, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    }),

  resetPassword: (
    token: string,
    userId: number,
    tempPassword?: string,
  ): Promise<{ tempPassword: string }> =>
    request(`/admin/users/${userId}/reset-password`, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tempPassword }),
    }),

  forcePasswordChange: (token: string, userId: number): Promise<{ user: AdminUser }> =>
    request(`/admin/users/${userId}/force-password-change`, token, { method: 'POST' }),

  changeRole: (token: string, userId: number, roleId: number): Promise<{ user: AdminUser }> =>
    request(`/admin/users/${userId}/role`, token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roleId }),
    }),

  updatePermissions: (
    token: string,
    userId: number,
    overrides: { pageKey: string; action: 'view' | 'export'; allowed: boolean | null }[],
  ): Promise<{ permissions: EffectivePermissions }> =>
    request(`/admin/users/${userId}/permissions`, token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides }),
    }),

  revokeSessions: (token: string, userId: number): Promise<{ ok: boolean }> =>
    request(`/admin/users/${userId}/revoke-sessions`, token, { method: 'POST' }),

  userLoginHistory: (
    token: string,
    userId: number,
    page = 1,
    pageSize = 25,
  ): Promise<{ rows: LoginHistoryRow[]; total: number }> =>
    request(`/admin/users/${userId}/login-history?page=${page}&pageSize=${pageSize}`, token),

  importUsers: (token: string, file: File): Promise<ImportResult> => {
    const form = new FormData();
    form.append('file', file);
    return request('/admin/users/import', token, { method: 'POST', body: form });
  },

  downloadImportTemplateUrl: () => `${API_BASE}/admin/users/import/template`,

  getRoleMatrix: (token: string): Promise<RolePermissionMatrix> => request('/admin/roles', token),

  setRolePermission: (
    token: string,
    roleId: number,
    pageKey: string,
    action: 'view' | 'export',
    allowed: boolean,
  ): Promise<RolePermissionMatrix> =>
    request(`/admin/roles/${roleId}/permissions`, token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageKey, action, allowed }),
    }),

  addRoleDataScope: (
    token: string,
    roleId: number,
    dimension: string,
    value: string,
  ): Promise<RolePermissionMatrix> =>
    request(`/admin/roles/${roleId}/data-scope`, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dimension, value }),
    }),

  removeRoleDataScope: (token: string, roleId: number, scopeId: number): Promise<RolePermissionMatrix> =>
    request(`/admin/roles/${roleId}/data-scope/${scopeId}`, token, { method: 'DELETE' }),

  listLoginHistory: (
    token: string,
    params: { userId?: number; eventType?: string; fromDate?: string; toDate?: string; page?: number; pageSize?: number } = {},
  ): Promise<{ rows: LoginHistoryRow[]; total: number; page: number; pageSize: number }> => {
    const qs = new URLSearchParams();
    if (params.userId !== undefined) qs.set('userId', String(params.userId));
    if (params.eventType) qs.set('eventType', params.eventType);
    if (params.fromDate) qs.set('fromDate', params.fromDate);
    if (params.toDate) qs.set('toDate', params.toDate);
    qs.set('page', String(params.page ?? 1));
    qs.set('pageSize', String(params.pageSize ?? 50));
    return request(`/admin/login-history?${qs.toString()}`, token);
  },

  listEtlRunLog: (
    token: string,
    page = 1,
    pageSize = 25,
  ): Promise<{ rows: EtlRunLogRow[]; total: number; page: number; pageSize: number }> =>
    request(`/admin/etl-runs/log?page=${page}&pageSize=${pageSize}`, token),

  listEtlRunAudit: (
    token: string,
    page = 1,
    pageSize = 25,
  ): Promise<{ rows: EtlRunAuditRow[]; total: number; page: number; pageSize: number }> =>
    request(`/admin/etl-runs/audit?page=${page}&pageSize=${pageSize}`, token),

  // --- ETL Control Center (Admin-role-only, see backend/src/routes/admin/etlControl.ts) ---

  getEtlStatus: (token: string): Promise<EtlStatusResponse> => request('/admin/etl/status', token),

  getEtlHistory: (
    token: string,
    params: { status?: EtlRunStatus; mode?: EtlMode; fromDate?: string; toDate?: string; page?: number; pageSize?: number } = {},
  ): Promise<{ rows: EtlJobRun[]; total: number; page: number; pageSize: number }> => {
    const qs = new URLSearchParams();
    if (params.status) qs.set('status', params.status);
    if (params.mode) qs.set('mode', params.mode);
    if (params.fromDate) qs.set('fromDate', params.fromDate);
    if (params.toDate) qs.set('toDate', params.toDate);
    qs.set('page', String(params.page ?? 1));
    qs.set('pageSize', String(params.pageSize ?? 25));
    return request(`/admin/etl/history?${qs.toString()}`, token);
  },

  getEtlSchedulerConfig: (token: string): Promise<EtlSchedulerConfigResponse> =>
    request('/admin/etl/scheduler-config', token),

  startEtlRun: (token: string, mode: EtlMode): Promise<{ ok: boolean; runId: number; jobId: string }> =>
    request(`/admin/etl/start/${mode}`, token, { method: 'POST' }),

  getEtlPreflight: (token: string): Promise<EtlPreflightResponse> => request('/admin/etl/preflight', token),

  /** Re-runs the last failed/cancelled run (or `runId`) with the same mode. */
  retryEtlRun: (token: string, runId?: number): Promise<{ ok: boolean; runId: number; retriedRunId: number }> =>
    request('/admin/etl/retry', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(runId === undefined ? {} : { runId }),
    }),

  cancelEtlRun: (token: string): Promise<{ ok: boolean; message: string }> =>
    request('/admin/etl/cancel', token, { method: 'POST' }),

  forceResetEtlLock: (token: string): Promise<{ ok: boolean; rowsReset: number }> =>
    request('/admin/etl/force-reset', token, { method: 'POST' }),

  getEtlRunLogLines: (token: string, runId: number): Promise<{ lines: string[] }> =>
    request(`/admin/etl/runs/${runId}/log`, token),

  // --- Salesperson Management (backend/src/routes/admin/salespersons.ts) ---

  listSalespersons: (
    token: string,
    params: { search?: string; channelKey?: number; segmentKey?: number; salesTeamKey?: string; page?: number; pageSize?: number } = {},
  ): Promise<{ rows: SalespersonAdminRow[]; total: number; page: number; pageSize: number }> => {
    const qs = new URLSearchParams();
    if (params.search) qs.set('search', params.search);
    if (params.channelKey !== undefined) qs.set('channelKey', String(params.channelKey));
    if (params.segmentKey !== undefined) qs.set('segmentKey', String(params.segmentKey));
    if (params.salesTeamKey) qs.set('salesTeamKey', params.salesTeamKey);
    qs.set('page', String(params.page ?? 1));
    qs.set('pageSize', String(params.pageSize ?? 25));
    return request(`/admin/salespersons?${qs.toString()}`, token);
  },

  updateSalespersonProfile: (
    token: string,
    salespersonKey: number,
    input: SalespersonProfilePatch,
  ): Promise<{ row: SalespersonAdminRow }> =>
    request(`/admin/salespersons/${salespersonKey}`, token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),

  bulkUpdateSalespersonProfiles: (
    token: string,
    salespersonKeys: number[],
    patch: SalespersonProfilePatch,
  ): Promise<{ results: Array<{ salespersonKey: number; ok: boolean; error?: string }> }> =>
    request('/admin/salespersons/bulk', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ salespersonKeys, patch }),
    }),

  getSalespersonHistory: (
    token: string,
    salespersonKey: number,
    page = 1,
    pageSize = 25,
  ): Promise<{ rows: SalespersonProfileHistoryRow[]; total: number }> =>
    request(`/admin/salespersons/${salespersonKey}/history?page=${page}&pageSize=${pageSize}`, token),

  // --- Sales Team Management (backend/src/routes/admin/salesteams.ts) ---

  listSalesTeams: (
    token: string,
    params: { search?: string; segmentKey?: number; page?: number; pageSize?: number } = {},
  ): Promise<{ rows: SalesTeamAdminRow[]; total: number; page: number; pageSize: number }> => {
    const qs = new URLSearchParams();
    if (params.search) qs.set('search', params.search);
    if (params.segmentKey !== undefined) qs.set('segmentKey', String(params.segmentKey));
    qs.set('page', String(params.page ?? 1));
    qs.set('pageSize', String(params.pageSize ?? 25));
    return request(`/admin/salesteams?${qs.toString()}`, token);
  },

  updateSalesTeamProfile: (
    token: string,
    salesTeamKey: string,
    input: SalesTeamProfilePatch,
  ): Promise<{ row: SalesTeamAdminRow }> =>
    request(`/admin/salesteams/${encodeURIComponent(salesTeamKey)}`, token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),

  /** Server-side restricted to segmentKeyOverride only -- "No bulk Name/Code edit (too risky)". */
  bulkUpdateSalesTeamSegment: (
    token: string,
    salesTeamKeys: string[],
    segmentKeyOverride: number | null,
  ): Promise<{ results: Array<{ salesTeamKey: string; ok: boolean; error?: string }> }> =>
    request('/admin/salesteams/bulk', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ salesTeamKeys, patch: { segmentKeyOverride } }),
    }),

  /** Company Link + Cascading Filter Bar, 2026-09 -- a separate endpoint from bulkUpdateSalesTeamSegment
   * (backend/src/routes/admin/salesteams.ts's POST /bulk-company), so that route's existing
   * "segment only" restriction stays untouched for its existing callers. */
  bulkUpdateSalesTeamCompany: (
    token: string,
    salesTeamKeys: string[],
    companyKeyOverride: number | null,
  ): Promise<{ results: Array<{ salesTeamKey: string; ok: boolean; error?: string }> }> =>
    request('/admin/salesteams/bulk-company', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ salesTeamKeys, patch: { companyKeyOverride } }),
    }),

  getSalesTeamHistory: (
    token: string,
    salesTeamKey: string,
    page = 1,
    pageSize = 25,
  ): Promise<{ rows: SalesTeamProfileHistoryRow[]; total: number }> =>
    request(`/admin/salesteams/${encodeURIComponent(salesTeamKey)}/history?page=${page}&pageSize=${pageSize}`, token),

  // --- Reference Data: Customer Groups / Distribution Channels / Companies
  // (backend/src/routes/admin/customerGroups.ts, distributionChannels.ts, companies.ts) ---

  listCustomerGroups: (
    token: string,
    params: { isActive?: boolean; search?: string; page?: number; pageSize?: number } = {},
  ): Promise<{ rows: CustomerGroupRow[]; total: number }> => {
    const qs = new URLSearchParams();
    if (params.isActive !== undefined) qs.set('isActive', String(params.isActive));
    if (params.search) qs.set('search', params.search);
    qs.set('page', String(params.page ?? 1));
    qs.set('pageSize', String(params.pageSize ?? 100));
    return request(`/admin/customer-groups?${qs.toString()}`, token);
  },
  getCustomerGroupEtlOptions: (token: string): Promise<{ segment_key: number; segment_name: string }[]> =>
    request('/admin/customer-groups/etl-options', token),
  createCustomerGroup: (
    token: string,
    input: ReferenceDataPatch & { name: string; etlSegmentKey?: number | null; criticalNumberPct?: number },
  ): Promise<{ row: CustomerGroupRow }> =>
    request('/admin/customer-groups', token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }),
  updateCustomerGroup: (
    token: string,
    id: number,
    input: ReferenceDataPatch & { etlSegmentKey?: number | null; criticalNumberPct?: number },
  ): Promise<{ row: CustomerGroupRow }> =>
    request(`/admin/customer-groups/${id}`, token, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }),
  deleteCustomerGroup: (token: string, id: number): Promise<{ success: boolean }> =>
    request(`/admin/customer-groups/${id}`, token, { method: 'DELETE' }),

  listDistributionChannels: (
    token: string,
    params: { isActive?: boolean; search?: string; page?: number; pageSize?: number } = {},
  ): Promise<{ rows: DistributionChannelRow[]; total: number }> => {
    const qs = new URLSearchParams();
    if (params.isActive !== undefined) qs.set('isActive', String(params.isActive));
    if (params.search) qs.set('search', params.search);
    qs.set('page', String(params.page ?? 1));
    qs.set('pageSize', String(params.pageSize ?? 100));
    return request(`/admin/distribution-channels?${qs.toString()}`, token);
  },
  getDistributionChannelEtlOptions: (token: string): Promise<{ channel_key: number; channel_name: string }[]> =>
    request('/admin/distribution-channels/etl-options', token),
  createDistributionChannel: (
    token: string,
    input: ReferenceDataPatch & { name: string; etlChannelKey?: number | null },
  ): Promise<{ row: DistributionChannelRow }> =>
    request('/admin/distribution-channels', token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }),
  updateDistributionChannel: (
    token: string,
    id: number,
    input: ReferenceDataPatch & { etlChannelKey?: number | null },
  ): Promise<{ row: DistributionChannelRow }> =>
    request(`/admin/distribution-channels/${id}`, token, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }),
  deleteDistributionChannel: (token: string, id: number): Promise<{ success: boolean }> =>
    request(`/admin/distribution-channels/${id}`, token, { method: 'DELETE' }),

  listCompanies: (
    token: string,
    params: { isActive?: boolean; search?: string; page?: number; pageSize?: number } = {},
  ): Promise<{ rows: CompanyRow[]; total: number }> => {
    const qs = new URLSearchParams();
    if (params.isActive !== undefined) qs.set('isActive', String(params.isActive));
    if (params.search) qs.set('search', params.search);
    qs.set('page', String(params.page ?? 1));
    qs.set('pageSize', String(params.pageSize ?? 100));
    return request(`/admin/companies?${qs.toString()}`, token);
  },
  getCompanyEtlOptions: (token: string): Promise<{ company_key: number; company_name: string }[]> =>
    request('/admin/companies/etl-options', token),
  createCompany: (
    token: string,
    input: ReferenceDataPatch & { name: string; etlCompanyKey?: number | null; criticalNumberPct?: number },
  ): Promise<{ row: CompanyRow }> =>
    request('/admin/companies', token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }),
  updateCompany: (
    token: string,
    id: number,
    input: ReferenceDataPatch & { etlCompanyKey?: number | null; criticalNumberPct?: number },
  ): Promise<{ row: CompanyRow }> =>
    request(`/admin/companies/${id}`, token, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }),
  deleteCompany: (token: string, id: number): Promise<{ success: boolean }> =>
    request(`/admin/companies/${id}`, token, { method: 'DELETE' }),

  listHolidays: (
    token: string,
    params: { isActive?: boolean; search?: string; page?: number; pageSize?: number } = {},
  ): Promise<{ rows: HolidayRow[]; total: number }> => {
    const qs = new URLSearchParams();
    if (params.isActive !== undefined) qs.set('isActive', String(params.isActive));
    if (params.search) qs.set('search', params.search);
    qs.set('page', String(params.page ?? 1));
    qs.set('pageSize', String(params.pageSize ?? 100));
    return request(`/admin/holidays?${qs.toString()}`, token);
  },
  createHoliday: (
    token: string,
    input: HolidayPatch & { holidayName: string; holidayDate: string },
  ): Promise<{ row: HolidayRow }> =>
    request('/admin/holidays', token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }),
  updateHoliday: (token: string, id: number, input: HolidayPatch): Promise<{ row: HolidayRow }> =>
    request(`/admin/holidays/${id}`, token, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }),
  deleteHoliday: (token: string, id: number): Promise<{ success: boolean }> =>
    request(`/admin/holidays/${id}`, token, { method: 'DELETE' }),

  listClosures: (
    token: string,
    params: { isActive?: boolean; branchKey?: string; search?: string; page?: number; pageSize?: number } = {},
  ): Promise<{ rows: ClosureRow[]; total: number }> => {
    const qs = new URLSearchParams();
    if (params.isActive !== undefined) qs.set('isActive', String(params.isActive));
    if (params.branchKey) qs.set('branchKey', params.branchKey);
    if (params.search) qs.set('search', params.search);
    qs.set('page', String(params.page ?? 1));
    qs.set('pageSize', String(params.pageSize ?? 100));
    return request(`/admin/closures?${qs.toString()}`, token);
  },
  getClosureBranchOptions: (token: string): Promise<{ branch_key: string; branch_name: string }[]> =>
    request('/admin/closures/branch-options', token),
  createClosure: (
    token: string,
    input: ClosurePatch & { branchKey: string; closureDate: string },
  ): Promise<{ row: ClosureRow }> =>
    request('/admin/closures', token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }),
  updateClosure: (token: string, id: number, input: ClosurePatch): Promise<{ row: ClosureRow }> =>
    request(`/admin/closures/${id}`, token, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }),
  deleteClosure: (token: string, id: number): Promise<{ success: boolean }> =>
    request(`/admin/closures/${id}`, token, { method: 'DELETE' }),
};

// --- ETL Control Center types ---

export type EtlRunStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled';
export type EtlMode = 'incremental' | 'full' | 'sql' | 'excel';
export type EtlTriggerSource = 'scheduled' | 'manual' | 'api' | 'development';

export interface EtlJobRun {
  [key: string]: unknown;
  id: number;
  job_id: string | null;
  job_type: string;
  mode: EtlMode;
  load_mode: string;
  output_mode: string;
  trigger_source: EtlTriggerSource;
  triggered_by_user_id: number | null;
  triggered_by_user_name: string | null;
  status: EtlRunStatus;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_seconds: number | null;
  exit_code: number | null;
  error_message: string | null;
  odoo_extract_count: number | null;
  db_loaded_count: number | null;
  qa_issues_count: number | null;
  pipeline_run_log_id: number | null;
}

export interface EtlProgress {
  stage?: string;
  stageStatus?: 'started' | 'completed' | 'failed';
}

/** GET /admin/etl/preflight: are the ETL's manual input workbooks reachable/valid from the ETL
 * service itself? `available: false` = the check couldn't run (ETL API unreachable). */
export interface EtlPreflightResponse {
  available: boolean;
  error?: string;
  ok?: boolean;
  input_dir?: string;
  source_var?: string;
  configured_value?: string;
  dir_exists?: boolean;
  platform?: string;
  files?: {
    name: string;
    path: string;
    required: boolean;
    status: 'ok' | 'missing' | 'unreadable' | 'invalid_xlsx';
    size_bytes: number | null;
    modified: string | null;
    near_matches: string[];
    detail: string;
  }[];
  listing?: string[];
  listing_truncated?: boolean;
  hint?: string;
  config_error?: string | null;
  output?: { dir: string | null; writable: boolean; detail: string };
}

export interface EtlStatusResponse {
  run: EtlJobRun | null;
  /** The most recent run that actually finished -- unlike `run`, never the in-flight one. */
  lastRun: EtlJobRun | null;
  progress: EtlProgress | null;
  recentLog: string[];
  /** false means the queue backend (Redis) is unreachable right now -- distinct from a genuine
   * "a run is active" lock, which used to be indistinguishable from this on the frontend. */
  queueAvailable: boolean;
  /** false means the queue is reachable but no etl:worker process is currently connected to
   * consume it -- starting a run in this state would just queue it with nothing to ever pick it
   * up (the "Queued 34 minutes, 0 log lines" failure mode). Only meaningful when queueAvailable
   * is true; the backend reports false here too when the queue itself can't be reached. */
  workerAvailable: boolean;
  elapsedMs: number | null;
  nextIncrementalRun: string | null;
  nextFullRun: string | null;
}

export interface EtlScheduleInfo {
  cron: string;
  enabled: boolean;
  nextRun: string | null;
}

export interface EtlSchedulerConfigResponse {
  incremental: EtlScheduleInfo;
  full: EtlScheduleInfo;
}

/** Mirrors pipeline_run_log (data/etl's own run history table -- see backend/src/routes/admin/etlRuns.ts). */
export interface EtlRunLogRow {
  [key: string]: unknown;
  run_id: number;
  scheduled_refresh_time: string | null;
  pipeline_start_time: string | null;
  pipeline_end_time: string | null;
  total_duration_minutes: number | null;
  status: string;
  error_message: string | null;
  odoo_extract_count: number | null;
  db_loaded_count: number | null;
  qa_issues_count: number | null;
  created_at: string;
}

/** Mirrors pipeline_run_audit (per-table row_counts_json + before/after order cursor). */
export interface EtlRunAuditRow {
  [key: string]: unknown;
  run_id: number;
  started_at: string | null;
  finished_at: string | null;
  load_mode: string;
  output_mode: string;
  status: string;
  error_message: string | null;
  row_counts_json: string | null;
  created_at: string;
}

export interface LoginHistoryRow {
  [key: string]: unknown;
  id: number;
  user_id: number | null;
  email_attempted: string;
  event_type: string;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  display_name: string | null;
}

export interface ImportRowError {
  [key: string]: unknown;
  rowNumber: number;
  email: string;
  errors: string[];
}
export interface ImportRowSuccess {
  [key: string]: unknown;
  rowNumber: number;
  email: string;
  fullName: string;
  role: string;
}
export interface ImportResult {
  totalRows: number;
  createdCount: number;
  errorCount: number;
  errors: ImportRowError[];
  created: ImportRowSuccess[];
}

export interface RoleMatrixRow {
  role_id: number;
  role_name: string;
  role_label: string;
}
export interface DataScopeDimension {
  key: string;
  label: string;
}
export interface DataScopeRule {
  scopeId: number;
  dimension: string;
  value: string;
  label: string;
}
export interface RolePermissionMatrix {
  roles: RoleMatrixRow[];
  pages: { page_id: number; page_key: string; page_label: string; nav_group: string | null }[];
  matrix: Record<number, EffectivePermissions>;
  /** roleId -> its row-level data-scope rules. No entry (or an empty array) means unrestricted. */
  dataScope: Record<number, DataScopeRule[]>;
  /** The 5 dimensions a rule can target, for the "Add rule" dimension picker. */
  dimensions: DataScopeDimension[];
}

// ---------------------------------------------------------------------------
// Tachometer drill-down (breakdown by filter dimension) -- powers the detail page reached by
// clicking a gauge card on the Tachometer summary page.
// ---------------------------------------------------------------------------

/** Matches the 4 clickable gauge cards on the Tachometer page 1:1. */
export type TachometerMetricKey = 'ytdValue' | 'ytdVolume' | 'mtdValue' | 'mtdVolume';

export type BreakdownGroupBy = 'salesperson' | 'salesTeam' | 'segment';

export interface BreakdownRow {
  groupKey: string | number | null;
  groupLabel: string;
  actual: number;
  targetToDate: number | null;
  status: TargetStatus;
  variancePct: number | null;
}

export interface TachometerBreakdown {
  anchorDate: string;
  metric: TachometerMetricKey;
  groupBy: BreakdownGroupBy;
  rows: BreakdownRow[];
}

/**
 * Fetches the grouped breakdown for one metric card (e.g. "YTD Value by Salesperson"). Carries
 * forward the exact same filters/anchorDate as the summary page's /overview call, so the
 * drill-down is always scoped identically to whatever the user was looking at when they clicked
 * through.
 */
export function fetchTachometerBreakdown(
  token: string,
  anchorDate: string,
  filters: TachometerFilters,
  metric: TachometerMetricKey,
  groupBy: BreakdownGroupBy,
): Promise<TachometerBreakdown> {
  const params = new URLSearchParams(buildQuery(anchorDate, filters));
  params.set('metric', metric);
  params.set('groupBy', groupBy);
  return request(`/tachometer/breakdown?${params.toString()}`, token);
}

// ---------------------------------------------------------------------------
// Monthly trend series (Revenue/Volume/ASP/Monthly Achievement charts).
// ---------------------------------------------------------------------------

export interface MonthlyPoint {
  month: number;
  year: number;
  label: string;
  value: number;
  volume: number;
  targetValue: number;
  targetVolume: number;
  valueStatus: TargetStatus;
  volumeStatus: TargetStatus;
  asp: number | null;
  targetAsp: number | null;
  aspStatus: TargetStatus;
}

export interface TachometerTrend {
  anchorDate: string;
  points: MonthlyPoint[];
}

export function fetchTachometerTrend(
  token: string,
  anchorDate: string,
  filters: TachometerFilters,
): Promise<TachometerTrend> {
  return request(`/tachometer/trend?${buildQuery(anchorDate, filters)}`, token);
}

// ---------------------------------------------------------------------------
// Critical Number (backend/src/routes/criticalNumber.ts) -- same throwaway/validation warehouse,
// same 5-dimension filter shape as Tachometer (reuses TachometerFilters/buildQuery rather than
// forking a parallel type).
// ---------------------------------------------------------------------------

export interface CriticalNumberDailyCounter {
  actual: number;
  target: number | null;
  status: TargetStatus;
  variancePct: number | null;
}

export interface CriticalNumberPeriodCounter {
  workingDaysElapsed: number;
  workingDaysTotal: number;
  achievementPct: number | null;
  status: TargetStatus;
  actualValue: number;
  expectedValue: number;
  gapValue: number;
  /** workingDaysTotal * dailyCriticalNumber -- the FULL month/year target, for the donut chart's
   * Achieved-vs-Remaining split (distinct from expectedValue, which stays elapsed-to-date). */
  periodTarget: number;
}

export interface CriticalNumberWorkingDaysCard {
  value: number;
  lastYear: number;
  variancePct: number | null;
}

export interface OffDayItem {
  date: string;
  company: string | null;
  branch: string | null;
  /** HR-maintained holiday name (e.g. "عيد الفطر") from Fact_OffDays.HolidayName -- null when not
   * filled in, in which case the UI falls back to generic label text. */
  holidayName: string | null;
}

export interface CriticalNumberHolidaysCard {
  value: number;
  items: OffDayItem[];
}

/** One individual closure day for a branch -- shown in the row's hover/tap detail. */
export interface ForcedClosureOccurrence {
  date: string;
  /** HR-maintained closure reason (e.g. "عاصفة") from Fact_OffDays.Reason -- null when not filled in. */
  reason: string | null;
}

export interface ForcedClosureBranchSummary {
  branch: string;
  branchName: string;
  company: string | null;
  days: number;
  /** Every individual closure day for this branch, most recent first. */
  occurrences: ForcedClosureOccurrence[];
}

export interface CriticalNumberForcedClosuresCard {
  value: number;
  branches: ForcedClosureBranchSummary[];
}

export interface CriticalNumberTrendCard {
  value: number;
  trendValues: number[];
  trendPct: number | null;
  /** Pace-adjusted "expected as of today" figure this row's gap is measured against (Working Days
   * YTD x Daily Critical Number for Missing Value, Working Days YTD itself for Missing Days) --
   * see backend/src/measures/criticalNumber.ts's MissingValueCard/MissingDaysCard docstrings. */
  expectedValue: number;
}

export interface CriticalNumberOverview {
  anchorDate: string;
  /** True when today's ETL data hasn't landed yet and the figures below are the most recent
   * available day's instead -- see backend/src/routes/criticalNumber.ts's fallback logic. */
  isFallback: boolean;
  /** How many days before `requestedDate` the shown `anchorDate` is; 0 when isFallback is false. */
  fallbackDaysAgo: number;
  /** The date actually requested (normally "today") before any fallback was applied. */
  requestedDate: string;
  dailyCriticalNumber: number;
  dailyCounter: CriticalNumberDailyCounter;
  monthlyCounter: CriticalNumberPeriodCounter;
  yearlyCounter: CriticalNumberPeriodCounter;
  workingDaysYtd: CriticalNumberWorkingDaysCard;
  officialHolidaysYtd: CriticalNumberHolidaysCard;
  forcedClosuresYtd: CriticalNumberForcedClosuresCard;
  weeklyRestDaysYtd: { value: number };
  missingDaysYtd: CriticalNumberTrendCard;
  missingValueYtd: CriticalNumberTrendCard;
}

export function fetchCriticalNumberOverview(
  token: string,
  anchorDate: string,
  filters: TachometerFilters,
): Promise<CriticalNumberOverview> {
  return request(`/critical-number/overview?${buildQuery(anchorDate, filters)}`, token);
}

// ---------------------------------------------------------------------------
// Revenue Trend (backend/src/routes/revenueTrend.ts) -- same throwaway/validation warehouse,
// same 5-dimension filter shape as Tachometer/Critical Number (reuses TachometerFilters/
// buildQuery rather than forking a parallel type).
// ---------------------------------------------------------------------------

export interface RevenueTrendMonthPoint {
  month: number;
  year: number;
  label: string;
  value: number;
  lastYearValue: number;
  targetValue: number;
  volume: number;
  lastYearVolume: number;
  targetVolume: number;
  asp: number | null;
  lastYearAsp: number | null;
  targetAsp: number | null;
}

export interface RevenueTrendVarianceCard {
  variancePct: number | null;
  flag: 0 | 1;
  status: TargetStatus;
}

export interface RevenueTrendKpis {
  valueVarianceYtd: RevenueTrendVarianceCard;
  volumeVarianceYtd: RevenueTrendVarianceCard;
  aspVarianceYtd: RevenueTrendVarianceCard;
  valueVarianceMtd: RevenueTrendVarianceCard;
  volumeVarianceMtd: RevenueTrendVarianceCard;
  aspVarianceMtd: RevenueTrendVarianceCard;
}

/** One Performance Details row: `last` is LYTD for a YTD row, LMTD for an MTD row (both are the
 * same window shifted back one year -- see backend filters.ts). */
export interface RevenueTrendPerformanceRow {
  key: string;
  metric: 'value' | 'volume' | 'asp';
  period: 'ytd' | 'mtd';
  actual: number | null;
  target: number | null;
  last: number | null;
  variancePct: number | null;
  varianceLastPct: number | null;
  status: TargetStatus;
}

export interface RevenueTrendOverview {
  anchorDate: string;
  series: RevenueTrendMonthPoint[];
  kpis: RevenueTrendKpis;
  performanceDetails: RevenueTrendPerformanceRow[];
}

export function fetchRevenueTrendOverview(
  token: string,
  anchorDate: string,
  filters: TachometerFilters,
): Promise<RevenueTrendOverview> {
  return request(`/revenue-trend/overview?${buildQuery(anchorDate, filters)}`, token);
}

// ---------------------------------------------------------------------------
// Invoices Engine (backend/src/routes/invoicesEngine.ts) -- same throwaway/validation warehouse,
// same 5-dimension filter shape as Tachometer/Critical Number/Revenue Trend (reuses
// TachometerFilters/buildQuery rather than forking a parallel type).
// ---------------------------------------------------------------------------

export interface InvoiceStats {
  invoiceCount: number;
  avgLinesPerInvoice: number | null;
  avgSalesPerInvoice: number | null;
  avgVolumePerInvoice: number | null;
}

export interface InvoicesEngineKpis {
  ytd: InvoiceStats;
  lytd: InvoiceStats;
  mtd: InvoiceStats;
  lmtd: InvoiceStats;
}

export interface InvoiceYearPoint {
  year: number;
  label: string;
  invoiceSalesValue: number;
  invoiceCount: number;
}

export interface InvoiceYearClassSlice {
  invoiceClass: string;
  invoiceSalesValue: number;
  invoiceCount: number;
}

export interface InvoiceYearClassBreakdown {
  year: number;
  label: string;
  classes: InvoiceYearClassSlice[];
}

export interface InvoiceYearEfficiencyPoint {
  year: number;
  label: string;
  invoiceCount: number;
  avgSalesPerInvoice: number | null;
  avgLinesPerInvoice: number | null;
  avgVolumePerInvoice: number | null;
}

export interface InvoiceClassificationSlice {
  invoiceClass: string;
  value: number;
  invoiceCount: number;
}

export interface InvoicesEngineOverview {
  anchorDate: string;
  selectedYear: number | null;
  selectedInvoiceClass: string | null;
  kpis: InvoicesEngineKpis;
  salesTrend: { byYear: InvoiceYearPoint[]; byYearClass: InvoiceYearClassBreakdown[] };
  invoicesTrend: InvoiceYearEfficiencyPoint[];
  classification: InvoiceClassificationSlice[];
}

/** Page-filter scope for the Sales Trend "click a year" / Invoices Classification "click a class"
 * interactions -- see backend/src/routes/invoicesEngine.ts's header comment for how each chart's
 * own query honors or ignores these two fields. */
export interface InvoicesEngineScope {
  selectedYear?: number | null;
  selectedInvoiceClass?: string | null;
}

export function fetchInvoicesEngineOverview(
  token: string,
  anchorDate: string,
  filters: TachometerFilters,
  scope: InvoicesEngineScope = {},
): Promise<InvoicesEngineOverview> {
  const params = new URLSearchParams(buildQuery(anchorDate, filters));
  if (scope.selectedYear != null) params.set('selectedYear', String(scope.selectedYear));
  if (scope.selectedInvoiceClass) params.set('selectedInvoiceClass', scope.selectedInvoiceClass);
  return request(`/invoices-engine/overview?${params.toString()}`, token);
}

// ---------------------------------------------------------------------------
// Customer Growth (backend/src/routes/customerGrowth.ts) -- same throwaway/validation warehouse,
// same 5-dimension filter shape as every other page (reuses TachometerFilters/buildQuery rather
// than forking a parallel type).
// ---------------------------------------------------------------------------

export interface CustomerGrowthPeriodCounts {
  ytd: number;
  lytd: number;
  mtd: number;
  lmtd: number;
}

export interface CustomerStatusCounts {
  activeRetained: number;
  nonActive: number;
  blocked: number;
  reactivated: number;
}

export interface CustomerGrowthKpis {
  newCustomers: CustomerGrowthPeriodCounts;
  totalCustomers: CustomerGrowthPeriodCounts;
  customerStatus: CustomerStatusCounts;
}

export interface CustomerGrowthRates {
  customerAcquisitionPct: number | null;
  customerGrowthPct: number | null;
  retentionRatePct: number | null;
  churnRatePct: number | null;
}

export interface CustomerYearPoint {
  year: number;
  label: string;
  totalSalesValue: number;
  customerCount: number;
}

export interface CustomerContributionRow {
  customerKey: number;
  name: string;
  value: number;
}

export interface CustomersContribution {
  customers: CustomerContributionRow[];
  remainderValue: number;
  remainderCount: number;
}

export interface CategoryCustomer {
  customerKey: number;
  name: string;
  salesLytm: number;
  salesYtm: number;
}

export interface CategoryPerformanceRow {
  category: string;
  salesLytm: number;
  salesYtm: number;
  customers: CategoryCustomer[];
}

export type CustomerStatusLabel = 'Active Retained' | 'Non Active' | 'Reactivated' | 'New' | 'Other' | 'Blocked';

export interface CustomerTableRow {
  customerKey: number;
  name: string;
  ytdValue: number;
  firstPurchaseDate: string | null;
  lastPurchaseDate: string | null;
  customerSegment: string | null;
  customerClass: string | null;
  status: CustomerStatusLabel;
}

export interface CustomerGrowthOverview {
  anchorDate: string;
  selectedYear: number | null;
  selectedCategory: string | null;
  kpis: CustomerGrowthKpis;
  rates: CustomerGrowthRates;
  customersTrend: CustomerYearPoint[];
  customersContribution: CustomersContribution;
  categoryPerformance: CategoryPerformanceRow[];
  customersTable: CustomerTableRow[];
}

/** Page-filter scope for the Customers Trend "click a year" and Customers Category Performance
 * "click a category" (when its own drill-down mode is off) interactions -- see
 * backend/src/routes/customerGrowth.ts's header comment for which query honors each. */
export interface CustomerGrowthScope {
  selectedYear?: number | null;
  selectedCategory?: string | null;
}

export function fetchCustomerGrowthOverview(
  token: string,
  anchorDate: string,
  filters: TachometerFilters,
  scope: CustomerGrowthScope = {},
): Promise<CustomerGrowthOverview> {
  const params = new URLSearchParams(buildQuery(anchorDate, filters));
  if (scope.selectedYear != null) params.set('selectedYear', String(scope.selectedYear));
  if (scope.selectedCategory) params.set('selectedCategory', scope.selectedCategory);
  return request(`/customer-growth/overview?${params.toString()}`, token);
}

// ---------------------------------------------------------------------------
// Pipeline Health (backend/src/routes/pipelineHealth.ts) -- same 5-dimension filter shape as every
// other page, but NO anchorDate: this page's figures are all-time (the funnel/benchmark represent
// the pipeline's overall conversion structure, not a period snapshot), see that route's header
// comment.
// ---------------------------------------------------------------------------

/** Same filter-param building as buildQuery, minus anchorDate (this page has none). */
function buildFilterQuery(filters: TachometerFilters): string {
  const params = new URLSearchParams();
  (filters.companyKeys ?? []).forEach((v) => params.append('companyKeys', String(v)));
  (filters.segmentKeys ?? []).forEach((v) => params.append('segmentKeys', String(v)));
  (filters.channelKeys ?? []).forEach((v) => params.append('channelKeys', String(v)));
  (filters.salesTeamKeys ?? []).forEach((v) => params.append('salesTeamKeys', v));
  (filters.salespersonKeys ?? []).forEach((v) => params.append('salespersonKeys', String(v)));
  return params.toString();
}

export interface FunnelCounts {
  leads: number;
  opportunities: number;
  quotations: number;
  salesOrders: number;
  deliveries: number;
}

/** Total monetary value per funnel stage, alongside FunnelCounts -- powers the Full Pipeline
 * funnel's "count + value" hover/legend. No `leads` figure since Leads isn't plotted on the funnel. */
export interface FunnelValues {
  opportunities: number;
  quotations: number;
  salesOrders: number;
  deliveries: number;
}

export interface FunnelOpportunityIds {
  leads: string[];
  opportunities: string[];
}

export interface FunnelSalesRecord {
  orderNumber: string;
  customer: string | null;
  company: string | null;
  salesperson: string | null;
  documentDate: string | null;
  value: number;
  orderDate: string | null;
  orderState: string | null;
  documentType: string | null;
  /** null = no linked Opportunity ("Tracking > Opportunity" empty on the Odoo form). */
  opportunityId: string | null;
}

export interface FunnelDeliveryRecord {
  orderNumber: string | null;
  customer: string | null;
  company: string | null;
  salesperson: string | null;
  orderDate: string | null;
  deliveryStatus: string | null;
  deliveryReference: string | null;
  deliveryDate: string | null;
  opportunityId: string | null;
}

export interface FunnelStageRecords {
  quotations: FunnelSalesRecord[];
  salesOrders: FunnelSalesRecord[];
  deliveries: FunnelDeliveryRecord[];
}

export type ChainStage = 'opportunity' | 'quotation' | 'salesOrder' | 'delivery';

export interface ChainDocument {
  number: string;
  date: string | null;
  value: number;
  status: string | null;
}

export interface OpportunityChainRow {
  opportunityId: string;
  name: string;
  customer: string | null;
  salesperson: string | null;
  stage: string | null;
  createdDate: string | null;
  isWon: boolean;
  opportunity: ChainDocument;
  quotations: ChainDocument[];
  salesOrders: ChainDocument[];
  deliveries: ChainDocument[];
  reachedStage: ChainStage;
}

export interface ChainStageTotal {
  opportunities: number;
  documents: number;
  value: number;
}

export interface OpportunityChains {
  rows: OpportunityChainRow[];
  totals: Record<'opportunities' | 'quotations' | 'salesOrders' | 'deliveries', ChainStageTotal>;
}

export interface StageBenchmarkRow {
  transition: string;
  actualPct: number | null;
  targetPct: number;
  status: TargetStatus;
  variancePct: number | null;
}

export interface ExpectedClosureMonthPoint {
  year: number;
  month: number;
  label: string;
  expectedCount: number;
  expectedValue: number;
}

export interface StageValueSlice {
  stage: string;
  value: number;
}

export interface ProbabilityBucketSlice {
  bucket: string;
  count: number;
}

export interface OpportunityDetailRow {
  opportunityId: string;
  name: string;
  customer: string | null;
  company: string | null;
  expectedRevenue: number;
  salesperson: string | null;
  stage: string | null;
  createdDate: string | null;
  expectedCloseDate: string | null;
  expectedCloseMonth: string | null;
  probabilityBucket: string | null;
  /** Neither Won nor Lost. Unfiltered at the API level -- see pipeline-health/page.tsx's
   * matchesFilter for how each drill-down path applies (or deliberately skips) this. */
  isOpen: boolean;
}

export interface DataQualityIssue {
  key: string;
  label: string;
  count: number;
}

export interface DataQualityOverview {
  totalRecords: number;
  dirtyRecords: number;
  dirtyPct: number | null;
  status: TargetStatus;
  issues: DataQualityIssue[];
}

export interface PipelineHealthOverview {
  funnel: FunnelCounts;
  funnelValues: FunnelValues;
  funnelOpportunityIds: FunnelOpportunityIds;
  funnelStageRecords: FunnelStageRecords;
  opportunityChains: OpportunityChains;
  stageBenchmark: StageBenchmarkRow[];
  expectedClosureByMonth: ExpectedClosureMonthPoint[];
  opportunityByStage: StageValueSlice[];
  probabilityDistribution: ProbabilityBucketSlice[];
  opportunities: OpportunityDetailRow[];
  /** Admin-only: the backend omits it for every other role. */
  dataQuality?: DataQualityOverview;
}

export function fetchPipelineHealthOverview(token: string, filters: TachometerFilters): Promise<PipelineHealthOverview> {
  return request(`/pipeline-health/overview?${buildFilterQuery(filters)}`, token);
}

// ---------------------------------------------------------------------------
// Pipeline Trend (backend/src/routes/pipelineTrend.ts) -- same 5-dimension filter shape + anchorDate
// as most other pages. Read-only page, no scope param.
// ---------------------------------------------------------------------------

export interface QuotationRates {
  totalQuotations: number;
  wonQuotations: number;
  winRatePct: number | null;
  openQuotations: number;
  lostQuotations: number;
  wonLostRatio: number | null;
}

export interface MonthComparisonPoint {
  month: number;
  label: string;
  countYtd: number;
  valueYtd: number;
}

export interface AgingBuckets {
  b0to30: number;
  b30to60: number;
  b60to90: number;
  b90plus: number;
}

export interface AgingDistribution {
  opportunities: AgingBuckets;
  quotations: AgingBuckets;
}

export interface PipelineTrendOverview {
  anchorDate: string;
  quotationRates: QuotationRates;
  opportunitiesByMonth: MonthComparisonPoint[];
  quotationsByMonth: MonthComparisonPoint[];
  salesOrdersByMonth: MonthComparisonPoint[];
  aging: AgingDistribution;
}

export function fetchPipelineTrendOverview(
  token: string,
  anchorDate: string,
  filters: TachometerFilters,
): Promise<PipelineTrendOverview> {
  return request(`/pipeline-trend/overview?${buildQuery(anchorDate, filters)}`, token);
}

// ---------------------------------------------------------------------------
// Activity Momentum (backend/src/routes/activityMomentum.ts) -- same 5-dimension filter shape +
// anchorDate as most other pages.
// ---------------------------------------------------------------------------

export interface OpportunityActivityCounts {
  totalYtd: number;
  won: number;
  withoutActivity: number | null;
  active: number;
  lost: number;
  withoutNextStep: number | null;
}

export interface ActivityRates {
  inactiveDealsRatio: number | null;
  lostDealsRatio: number | null;
}

export interface LostReasonSlice {
  reason: string;
  count: number;
}

export interface NewOpportunitiesMonthPoint {
  month: number;
  label: string;
  countYtd: number;
}

export interface ActivityOpportunityRow {
  opportunityId: string;
  name: string;
  customer: string | null;
  company: string | null;
  expectedRevenue: number;
  salesperson: string | null;
  stage: string | null;
  createdDate: string | null;
  isOpen: boolean;
  isWon: boolean;
  isLost: boolean;
  isActive: boolean;
  isInactive: boolean | null;
  isWithoutNextStep: boolean | null;
  isYtd: boolean;
}

export interface ActivityMomentumOverview {
  anchorDate: string;
  activityColumnsAvailable: boolean;
  counts: OpportunityActivityCounts;
  rates: ActivityRates;
  lostByReason: LostReasonSlice[];
  newOpportunitiesByMonth: NewOpportunitiesMonthPoint[];
  opportunities: ActivityOpportunityRow[];
}

export function fetchActivityMomentumOverview(
  token: string,
  anchorDate: string,
  filters: TachometerFilters,
): Promise<ActivityMomentumOverview> {
  return request(`/activity-momentum/overview?${buildQuery(anchorDate, filters)}`, token);
}

// ---------------------------------------------------------------------------
// BCG Matrix (backend/src/routes/bcgMatrix.ts) -- live product-classification snapshot
// (fact_bcgmatrix, refreshed by the same 3-hour/nightly ETL as every other page). No
// anchorDate/filters: the YTD/LYTD figures are already computed server-side and don't get
// recomputed per request.
// ---------------------------------------------------------------------------

export interface BcgFact {
  ProductKey: string;
  ProductName: string;
  Company: string;
  Category: string | null;
  Brand: string | null;
  /** Null only on a `discontinuedFacts` row (see BcgMatrixOverview) -- real LYTD sales, zero YTD
   * activity, nothing to classify into a quadrant this year. */
  bcg_class_YTD: 'Stars' | 'Cash Cows' | 'Strategic' | 'Dogs' | null;
  bcg_class_LYTD: string | null;
  volume_class_YTD: string | null;
  profit_class_YTD: string | null;
  bcg_code_YTD: string | null;
  bcg_movement: 'New' | 'Stable' | 'Improved' | 'Declined' | 'Lost' | null;
  total_value_YTD: number;
  total_value_LYTD: number;
  total_quantity_YTD: number;
  total_quantity_LYTD: number;
  /** Percentage points (35 means 35%), not a raw fraction. Null means "no LYTD baseline to
   * compare against" (a new product, not 0% growth) -- see
   * backend/src/measures/materialsAnalogyBcg.ts's header note. Render distinctly, never as 0%. */
  quantity_growth_pct: number | null;
  avg_unit_price_YTD: number;
  avg_unit_price_LYTD: number;
  /** Percentage points (35 means 35%), not a raw fraction -- see quantity_growth_pct's note. */
  perc_gross_profit_YTD: number;
  perc_gross_profit_LYTD: number;
}

export interface BcgMatrixOverview {
  facts: BcgFact[];
  /** Real LYTD sales, zero YTD activity (`bcg_movement === 'Lost'` on every row) -- excluded from
   * `facts` (and therefore from the quadrant KPI cards / matrix cells, which have nothing to
   * classify these into) but a real, non-hidden part of the Portfolio Movement picture and the
   * Product Detail table. */
  discontinuedFacts: BcgFact[];
  unclassifiedCount: number;
}

/** Customer Group/Distribution Channel/Branch/Salesperson + a date range -- narrows WHICH
 * already-classified products come back (Fact_SalesLines product-set membership), never a
 * reclassification against the filtered subset's own volume, and never a recomputed YTD/LYTD
 * window -- see backend/src/measures/materialsAnalogyBcg.ts's BcgProductScope header for why.
 * `companyKeys` is deliberately never sent -- this page keeps its own Tika/Majaal pill toggle. */
export interface BcgMatrixScopeFilters {
  segmentKeys?: number[];
  channelKeys?: number[];
  salesTeamKeys?: string[];
  salespersonKeys?: number[];
  fromDate?: string;
  toDate?: string;
}

function buildBcgMatrixQuery(scope: BcgMatrixScopeFilters): string {
  const params = new URLSearchParams();
  (scope.segmentKeys ?? []).forEach((v) => params.append('segmentKeys', String(v)));
  (scope.channelKeys ?? []).forEach((v) => params.append('channelKeys', String(v)));
  (scope.salesTeamKeys ?? []).forEach((v) => params.append('salesTeamKeys', v));
  (scope.salespersonKeys ?? []).forEach((v) => params.append('salespersonKeys', String(v)));
  if (scope.fromDate) params.set('fromDate', scope.fromDate);
  if (scope.toDate) params.set('toDate', scope.toDate);
  return params.toString();
}

export function fetchBcgMatrixOverview(token: string, scope: BcgMatrixScopeFilters = {}): Promise<BcgMatrixOverview> {
  const qs = buildBcgMatrixQuery(scope);
  return request(`/bcg-matrix/overview${qs ? `?${qs}` : ''}`, token);
}

// ---------------------------------------------------------------------------
// PIM Contribution Brand Performance (backend/src/routes/materialsAnalogyBrandPerformance.ts) --
// live per-product catalog + sales stats replacing materialsAnalogy/data.json (a ~32% offline
// sample confirmed as the root cause of undercounted SKU Count/revenue/volume for every partner
// brand card on this page). Same shape/field set as BcgFact -- deliberately structurally
// compatible with MaterialsAnalogyFact so computeBrandStats (materialsAnalogy/shared.ts) needs no
// logic changes, only a widened input type (see BrandStatsRow there).
// ---------------------------------------------------------------------------

export interface BrandPerformanceFact {
  ProductKey: string;
  ProductName: string;
  Company: string;
  Category: string | null;
  Brand: string | null;
  bcg_class_YTD: 'Stars' | 'Cash Cows' | 'Strategic' | 'Dogs' | null;
  bcg_movement: 'New' | 'Stable' | 'Improved' | 'Declined' | 'Lost' | null;
  total_value_YTD: number;
  total_value_LYTD: number;
  total_quantity_YTD: number;
  total_quantity_LYTD: number;
  /** Null for a product with no matching sales activity (no baseline ratio to compute), not 0. */
  avg_unit_price_YTD: number | null;
  avg_unit_price_LYTD: number | null;
  perc_gross_profit_YTD: number | null;
  perc_gross_profit_LYTD: number | null;
  quantity_growth_pct: number | null;
}

export interface BrandPerformanceOverview {
  facts: BrandPerformanceFact[];
}

/** No scope/filter params -- like useBcgMatrixOverview's own unscoped default, Company/Category/
 * BCG Class filtering for this page stays a client-side concern (filterFacts). A SALESPERSON-tier
 * or role-restricted caller's RBAC lock is still enforced server-side regardless (see the route's
 * own header) -- there is no client-side equivalent to request or bypass. */
export function fetchBrandPerformanceOverview(token: string): Promise<BrandPerformanceOverview> {
  return request('/pim-contribution/brand-performance', token);
}
