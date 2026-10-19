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
  /** The parsed JSON error body, when there was one (e.g. `problems` from an upload validation). */
  body?: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
    this.body = body;
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
    throw new ApiError(res.status, message, rawBody);
  }
  return res.json() as Promise<T>;
}

/** The shared request helper, for feature modules with their own API file (e.g. lib/kaizen/api.ts). */
export { request as apiRequest };

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
  /** Dates behind lastYearSamePeriod (LYTD / LMTD) and fullLastPeriodActual (LFY / LFM), YYYY-MM-DD, ends included. */
  lastYearRange: { start: string; end: string };
  fullLastPeriodRange: { start: string; end: string };
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
  /** Primary role: supplies the data-scope tier and data-scope rules. */
  role: { id: number | null; name: string | null; label: string | null };
  /** Every role the user holds; permissions are their union. */
  roles: { id: number; name: string; label: string }[];
  /** Holds the built-in Admin (super administrator) role. */
  isAdmin: boolean;
  lastLoginAt: string | null;
  isSalesperson: boolean;
  salespersonKey: number | null;
}

export type PermissionAction = 'view' | 'create' | 'edit' | 'delete' | 'export';
export const PERMISSION_ACTIONS: PermissionAction[] = ['view', 'create', 'edit', 'delete', 'export'];

export interface PagePermission {
  canView: boolean;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canExport: boolean;
}
export type EffectivePermissions = Record<string, PagePermission>;

/** One entry of the backend's central permission registry (backend/src/config/permissionRegistry.ts):
 * a page/module and the actions that apply to it. */
export interface PermissionRegistryEntry {
  key: string;
  label: string;
  group: 'dashboard' | 'data_entry' | 'admin';
  actions: PermissionAction[];
}

export interface LoginResponse {
  token: string;
  user: PublicUser;
  permissions: EffectivePermissions;
  registry: PermissionRegistryEntry[];
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

export function fetchMe(
  token: string,
): Promise<{ user: PublicUser; permissions: EffectivePermissions; registry: PermissionRegistryEntry[] }> {
  return request('/auth/me', token);
}

/** Server-side Export check (backend/src/routes/exports.ts): resolves when allowed, rejects with a
 * 403 ApiError when the user has no Export permission on the page. */
export function authorizeExport(token: string, pageKey: string, format: 'image' | 'pdf' | 'xlsx' | 'csv'): Promise<{ ok: boolean }> {
  return request('/exports/authorize', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pageKey, format }),
  });
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
  /** Every role the user holds (the list endpoint fills role_id/role_label/role_name). */
  roles?: { role_id?: number; id?: number; role_label?: string; label?: string; role_name?: string; name?: string }[];
}

export interface AdminRole {
  role_id: number;
  role_name: string;
  role_label: string;
  default_role_tier_code: string | null;
  is_system: number;
}

/** Admin Panel > Roles list row (backend roleService.RoleSummary). */
export interface RoleSummary {
  role_id: number;
  role_name: string;
  role_label: string;
  description: string | null;
  is_system: boolean;
  is_admin: boolean;
  default_role_tier_code: string | null;
  user_count: number;
  created_at: string;
  updated_at: string;
  created_by: number | null;
  created_by_name: string | null;
}

/** pageKey -> allowed actions. */
export type RolePermissionSet = Record<string, PermissionAction[]>;

export interface RoleDetail extends RoleSummary {
  permissions: RolePermissionSet;
}

export interface RoleTier {
  role_code: string;
  role_label: string;
  scope_description: string;
}

export interface RolesAdminView {
  roles: RoleSummary[];
  registry: PermissionRegistryEntry[];
  tiers: RoleTier[];
  dataScope: Record<number, DataScopeRule[]>;
  dimensions: DataScopeDimension[];
}

export interface RoleInput {
  name: string;
  description: string | null;
  tierCode: string;
  permissions: RolePermissionSet;
}

export type UserPermissionOverrides = Record<string, Partial<Record<PermissionAction, boolean>>>;

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

  getUser: (
    token: string,
    userId: number,
  ): Promise<{ user: AdminUser & { roles: { role_id: number; role_name: string; role_label: string }[] }; permissions: EffectivePermissions; overrides: UserPermissionOverrides }> =>
    request(`/admin/users/${userId}`, token),

  createUser: (
    token: string,
    input: {
      fullName: string;
      email: string;
      /** Primary role (data-scope tier). */
      roleId: number;
      /** Every role to assign, primary included. */
      roleIds?: number[];
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

  setUserRoles: (
    token: string,
    userId: number,
    roleIds: number[],
    primaryRoleId?: number | null,
  ): Promise<{ user: AdminUser }> =>
    request(`/admin/users/${userId}/roles`, token, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roleIds, primaryRoleId }),
    }),

  updatePermissions: (
    token: string,
    userId: number,
    overrides: { pageKey: string; action: PermissionAction; allowed: boolean | null }[],
  ): Promise<{ permissions: EffectivePermissions; overrides: UserPermissionOverrides }> =>
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

  getRolesAdmin: (token: string): Promise<RolesAdminView> => request('/admin/roles', token),

  getRole: (token: string, roleId: number): Promise<{ role: RoleDetail }> => request(`/admin/roles/${roleId}`, token),

  createRole: (token: string, input: RoleInput): Promise<{ role: RoleDetail }> =>
    request('/admin/roles', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),

  updateRole: (token: string, roleId: number, input: Partial<RoleInput>): Promise<{ role: RoleDetail }> =>
    request(`/admin/roles/${roleId}`, token, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),

  duplicateRole: (token: string, roleId: number): Promise<{ role: RoleDetail }> =>
    request(`/admin/roles/${roleId}/duplicate`, token, { method: 'POST' }),

  deleteRole: (token: string, roleId: number, replacementRoleId?: number | null): Promise<{ ok: boolean }> =>
    request(`/admin/roles/${roleId}`, token, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replacementRoleId: replacementRoleId ?? null }),
    }),

  /** Saves the role's rule on one dimension (replaces that dimension's previous rule). */
  saveRoleDataScope: (
    token: string,
    roleId: number,
    dimension: string,
    operator: DataScopeOperator,
    values: string[],
  ): Promise<{ dataScope: Record<number, DataScopeRule[]> }> =>
    request(`/admin/roles/${roleId}/data-scope/${encodeURIComponent(dimension)}`, token, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operator, values }),
    }),

  /** Every value of one data-scope dimension for the value picker (all data, never the admin's own scope). The raw
   * list -- use lib/useDimensionValues.ts, which normalises it to { value, label }. */
  getDimensionValues: (token: string, dimension: string): Promise<{ dimension: string; values: unknown[] }> =>
    request(`/admin/roles/dimension-values/${encodeURIComponent(dimension)}`, token),

  /** Removes the role's rule on one dimension (= no restriction on it). */
  removeRoleDataScope: (token: string, roleId: number, dimension: string): Promise<{ dataScope: Record<number, DataScopeRule[]> }> =>
    request(`/admin/roles/${roleId}/data-scope/${encodeURIComponent(dimension)}`, token, { method: 'DELETE' }),

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

  startEtlRun: (token: string, mode: EtlStartMode): Promise<{ ok: boolean; runId: number; jobId: string }> =>
    request(`/admin/etl/start/${mode}`, token, { method: 'POST' }),

  getEtlPreflight: (token: string): Promise<EtlPreflightResponse> => request('/admin/etl/preflight', token),

  /** The ETL's manual input workbooks, as the ETL service sees them, plus the last upload of each. */
  getEtlInputFiles: (token: string): Promise<EtlInputFilesResponse> => request('/admin/etl/input-files', token),

  /** Replaces one input workbook in place (validated + backed up by the ETL service). Never starts a run. */
  replaceEtlInputFile: (token: string, name: string, file: File): Promise<EtlInputFileReplaced> => {
    const form = new FormData();
    form.append('file', file);
    return request(`/admin/etl/input-files/${encodeURIComponent(name)}`, token, { method: 'PUT', body: form });
  },

  listAuditLog: (
    token: string,
    params: { entityType?: string; page?: number; pageSize?: number },
  ): Promise<{ rows: AuditLogRow[]; total: number; page: number; pageSize: number }> => {
    const qs = new URLSearchParams();
    if (params.entityType) qs.set('entityType', params.entityType);
    qs.set('page', String(params.page ?? 1));
    qs.set('pageSize', String(params.pageSize ?? 25));
    return request(`/admin/audit-log?${qs.toString()}`, token);
  },

  listAuditEntityTypes: (token: string): Promise<{ entityTypes: string[] }> => request('/admin/audit-log/entity-types', token),

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

/** partial = the run loaded but a step failed (the receivables snapshot); skipped = refused, another run held the lock. */
export type EtlRunStatus = 'queued' | 'running' | 'success' | 'partial' | 'failed' | 'cancelled' | 'skipped';
/** What an admin can start. 'sql'/'excel' only appear on runs recorded before the 2026-10 ETL platform. */
export type EtlStartMode = 'incremental' | 'full' | 'finance' | 'nps';
export type EtlMode = EtlStartMode | 'sql' | 'excel';
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
  /** History rows: the ETL steps of this run (core_dims, finance_receivables, sales_* under main / full_all). */
  steps?: EtlRunStep[];
}

/** One etl_run_log row under a run's top-level row (backend etlRunTracker.fetchRunSteps). Times are UTC wall clock. */
export interface EtlRunStep {
  runId: number;
  job: string;
  department: string | null;
  status: string;
  startedAtUtc: string | null;
  finishedAtUtc: string | null;
  durationSeconds: number | null;
  rowsLoaded: number | null;
  errorMessage: string | null;
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

/** GET /admin/etl/input-files: one entry per manual input workbook the ETL reads. */
export interface EtlInputFileSlot {
  name: string;
  required: boolean;
  feeds: string;
  exists: boolean;
  size_bytes: number | null;
  /** ISO-8601 UTC. */
  modified: string | null;
  sheets: { label: string; sheet_names: string[] | null; required: string[]; optional: string[] }[];
  recent_backups: { name: string; size_bytes: number; modified: string }[];
  lastUpload: { at: string; byUserId: number | null; byName: string | null } | null;
}

export interface EtlInputFilesResponse {
  input_dir: string;
  backup_dir: string;
  max_bytes: number;
  /** true = the ETL input folder is read-only on this server: uploads are checked, never saved. */
  read_only?: boolean;
  files: EtlInputFileSlot[];
}

export interface EtlInputFileReplaced {
  name: string;
  /** false = valid, but the input folder is read-only, so the file was checked and not replaced. */
  replaced?: boolean;
  read_only?: boolean;
  message?: string;
  input_dir: string;
  previous: { path: string; size_bytes: number; modified: string; sha256: string } | null;
  current: { path: string; size_bytes: number; modified: string; sha256: string };
  backup: { path: string; size_bytes: number } | null;
  validation: { sheets: Record<string, string>; counts: Record<string, number> };
  /** false = the file WAS replaced, but its audit_log entry could not be written. */
  auditLogged: boolean;
}

/** GET /admin/audit-log row. before/after are free-form JSON snapshots. */
export interface AuditLogRow {
  [key: string]: unknown;
  audit_id: number;
  entity_type: string;
  entity_id: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  changed_by: number | null;
  changed_by_name: string | null;
  changed_by_email: string | null;
  changed_at: string;
  before_value: unknown;
  after_value: unknown;
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
  /** The daily receivables snapshot (finance_receivables alone, 15:00 by default). */
  nextFinanceRun?: string | null;
  /** The NPS Score refresh (process_nps alone, every 3 h at :30; off unless enabled). */
  nextNpsRun?: string | null;
}

export interface EtlScheduleInfo {
  cron: string;
  enabled: boolean;
  nextRun: string | null;
}

export interface EtlSchedulerConfigResponse {
  incremental: EtlScheduleInfo;
  full: EtlScheduleInfo;
  finance: EtlScheduleInfo;
  nps?: EtlScheduleInfo;
  /** IANA zone the crons are read in (ETL_SCHEDULE_TIMEZONE, else APP_TIMEZONE). */
  timezone?: string;
}

/** One etl_run_log row (ETL platform run history), with the legacy pipeline_run_log field names kept as aliases -- see backend/src/routes/admin/etlRuns.ts. */
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

/** Per-run task detail from etl_task_log (rows loaded per task as row_counts_json) -- see backend/src/routes/admin/etlRuns.ts. */
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

export interface DataScopeDimension {
  key: string;
  label: string;
}
/** "in" = is any of (only these values); "not_in" = is none of (every value except these, new values included). */
export type DataScopeOperator = 'in' | 'not_in';
export interface DataScopeValue {
  value: string;
  label: string;
}
/** One rule per role + dimension (2026-10-15); rules on different dimensions combine with AND. */
export interface DataScopeRule {
  dimension: string;
  operator: DataScopeOperator;
  values: DataScopeValue[];
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
  /** The anchor date when it is the current, still-trading business day (its actual is partial,
   * so it's left out of the trend series above), else null. */
  inProgressDate: string | null;
}

export function fetchCriticalNumberOverview(
  token: string,
  anchorDate: string,
  filters: TachometerFilters,
): Promise<CriticalNumberOverview> {
  return request(`/critical-number/overview?${buildQuery(anchorDate, filters)}`, token);
}

export type MissingTrendGranularity = 'daily' | 'weekly' | 'monthly';

/** One period of the expanded Missing Value / Missing Days view -- see
 * backend/src/measures/criticalNumber.ts's MissingTrendPeriod. Gaps are Actual - Target
 * (negative = behind pace), the same sign the cards display. */
export interface MissingTrendPeriod {
  key: string;
  start: string;
  end: string;
  workingDays: number;
  target: number;
  actual: number;
  gapValue: number;
  gapDays: number;
  cumulativeTarget: number;
  cumulativeActual: number;
  cumulativeGap: number;
  cumulativeGapDays: number;
  inProgress: boolean;
}

export interface CriticalNumberMissingTrend {
  anchorDate: string;
  inProgressDate: string | null;
  dailyCriticalNumber: number;
  daily: MissingTrendPeriod[];
  weekly: MissingTrendPeriod[];
  monthly: MissingTrendPeriod[];
}

export function fetchCriticalNumberMissingTrend(
  token: string,
  anchorDate: string,
  filters: TachometerFilters,
): Promise<CriticalNumberMissingTrend> {
  return request(`/critical-number/missing-trend?${buildQuery(anchorDate, filters)}`, token);
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
  /** All recorded sales value within the authorized filters, independent of the selected year. */
  lifetimeValue: number;
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

/** Mirrors backend/src/measures/pipelineTrend.ts's aging drill-down types. */
export type AgingCategory = 'opportunities' | 'quotations';
export type AgingBucketKey = 'b0to30' | 'b30to60' | 'b60to90' | 'b90plus';

export interface AgingDetailRow {
  /** Opportunity ID, or the quotation's order number. */
  id: string;
  /** Opportunity name, or the quotation's order number. */
  name: string;
  customer: string | null;
  salesperson: string | null;
  date: string | null;
  ageDays: number;
  /** Expected revenue (opportunity) or order value (quotation). */
  value: number;
  /** CRM stage (opportunity) or Odoo order state (quotation). */
  status: string | null;
}

export interface AgingDetails {
  anchorDate: string;
  category: AgingCategory;
  bucket: AgingBucketKey;
  rows: AgingDetailRow[];
}

export function fetchPipelineTrendAgingDetails(
  token: string,
  anchorDate: string,
  filters: TachometerFilters,
  category: AgingCategory,
  bucket: AgingBucketKey,
): Promise<AgingDetails> {
  return request(`/pipeline-trend/aging-details?${buildQuery(anchorDate, filters)}&category=${category}&bucket=${bucket}`, token);
}

// ---------------------------------------------------------------------------
// Activity Momentum (backend/src/routes/activityMomentum.ts) -- same 5-dimension filter shape +
// anchorDate as most other pages.
// ---------------------------------------------------------------------------

/** Mutually exclusive: totalYtd = active + won + lost + withoutActivity + withoutNextStep +
 * unclassified (see backend/src/measures/activityMomentum.ts, "MUTUALLY EXCLUSIVE STATUSES"). */
export interface OpportunityActivityCounts {
  totalYtd: number;
  won: number;
  withoutActivity: number | null;
  active: number;
  lost: number;
  withoutNextStep: number | null;
  /** Neither open, won nor lost -- part of #YTD only (0 in the live data). */
  unclassified: number;
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
// Product pages (BCG Matrix, Stock Velocity, PIM Contribution, Product Lifecycle) --
// backend/src/routes/productDashboard.ts over the ETL's pre-aggregated product tables
// (data/etl/src/sales_pipeline/product_dashboard.py). Period metrics follow fromDate/toDate
// (default calendar YTD); stock / lifecycle / BCG are as of the last ETL run.
// ---------------------------------------------------------------------------

export type ProductDashboardPage = 'bcg-matrix' | 'stock-velocity' | 'pim-contribution' | 'product-lifecycle';

export interface UomQty {
  uom: string;
  qty: number;
}

export type StockBand = 'Overstock' | 'Normal' | 'StockOutRisk' | 'NoMovement' | 'NoStockNoSales';
export type LifecycleSegment = 'New' | 'Growing' | 'Mature' | 'Declining' | 'Discontinued' | 'Never sold';
export type BcgMovement = 'New' | 'Stable' | 'Improved' | 'Declined' | 'Lost';

/** Per-company split of a row's period sales (BMH view: one entry per company selling the product). */
export interface ProductCompanyPart {
  company: string;
  productMatchKey: string;
  value: number;
  lines: number;
  volumeByUom: UomQty[];
}

export interface ProductDashboardRow {
  productMatchKey: string;
  productKey: string | null;
  company: string;
  productName: string;
  odooProductName: string | null;
  category: string | null;
  brand: string | null;
  subBrand: string | null;
  family: string | null;
  size: string | null;
  sku: string | null;
  isActive: number | null;
  isMapped: boolean;
  value: number;
  /** Null when the product was sold in more than one unit of measure in the period (see volumeByUom). */
  volume: number | null;
  volumeByUom: UomQty[];
  uom: string | null;
  lines: number;
  velocity: number | null;
  valuePrior: number;
  volumePrior: number | null;
  avgUnitPrice: number | null;
  grossProfitPct: number | null;
  stockQty: number;
  stockValue: number;
  inTransitQty: number;
  inTransitValue: number;
  avgDailySales: number;
  daysOfInventory: number | null;
  stockBand: StockBand;
  lifecycleSegment: LifecycleSegment;
  /** Companies in this row: one in a company view; both for a shared product in the BMH view. */
  companies: string[];
  parts: ProductCompanyPart[];
  firstSaleDate: string | null;
  lastSaleDate: string | null;
  bcgClassYTD: string | null;
  bcgClassLYTD: string | null;
  bcgMovement: BcgMovement | null;
  bcgExcludedCategory: boolean;
  valueYTD: number;
  volumeYTD: number;
  valueLYTD: number;
  volumeLYTD: number;
  grossProfitPctYTD: number | null;
  grossProfitPctLYTD: number | null;
  negativeStockRows: number;
}

export interface ProductDashboardOverview {
  /** 'BMH' = no company filter (a product both companies sell is one combined row); else one company. */
  view: 'BMH' | 'Majaal' | 'Tika';
  asOfDate: string | null;
  builtAtUtc: string | null;
  period: { from: string; to: string; days: number; priorFrom: string; priorTo: string };
  lookbackDays: number;
  thresholds: {
    days_of_inventory?: { lookback_days?: number; overstock_days?: Record<string, number>; stockout_risk_days?: Record<string, number> };
    bcg?: { volume_threshold?: Record<string, number>; profit_threshold_pct?: number; excluded_categories?: string[] };
    lifecycle?: { new_first_sale_within_days?: number; trend_window_days?: number; growth_threshold_pct?: number; discontinued_no_sales_days?: number };
    [key: string]: unknown;
  };
  products: ProductDashboardRow[];
  unmapped: { value: number; lines: number; volumeByUom: UomQty[]; products: number };
  totals: { value: number; lines: number; volumeByUom: UomQty[] };
  intercompanyValue: number;
}

export interface ProductDashboardScope {
  /** 'Majaal' / 'Tika' = that company's view; absent = BMH view. */
  company?: string;
  segmentKeys?: number[];
  channelKeys?: number[];
  salesTeamKeys?: string[];
  salespersonKeys?: number[];
  fromDate?: string;
  toDate?: string;
}

function buildProductDashboardQuery(scope: ProductDashboardScope): string {
  const params = new URLSearchParams();
  for (const key of ['segmentKeys', 'channelKeys', 'salesTeamKeys', 'salespersonKeys'] as const) {
    const values = scope[key];
    if (values && values.length) params.set(key, values.join(','));
  }
  if (scope.fromDate) params.set('fromDate', scope.fromDate);
  if (scope.toDate) params.set('toDate', scope.toDate);
  if (scope.company && scope.company !== 'All') params.set('company', scope.company);
  return params.toString();
}

export function fetchProductDashboard(token: string, page: ProductDashboardPage, scope: ProductDashboardScope = {}): Promise<ProductDashboardOverview> {
  const qs = buildProductDashboardQuery(scope);
  return request(`/product-dashboard/${page}/overview${qs ? `?${qs}` : ''}`, token);
}

// ---- Debt Report (Price / Finance department; backend routes/debtReport.ts) -----------------------------------------
export type DebtSizeTier = 'large' | 'medium' | 'small';
export type DebtOverdueStatus = 'all' | 'overdue' | 'not_due';

/** Every Receivables and Collections parameter (API /debt-report/*). Company / salesperson / team / customer go through
 * the server's scoped filters (role data scope + salesperson lock); the rest are the page's own. */
export interface DebtReportScope {
  snapshotDate?: string | null;
  includeOther?: boolean;
  includeIntercompany?: boolean;
  companyKeys?: number[];
  segmentKeys?: number[];
  channelKeys?: number[];
  salespersonKeys?: number[];
  salesTeamKeys?: string[];
  customerKeys?: number[];
  overdueStatus?: DebtOverdueStatus;
  agingBucketKeys?: number[];
  deliveryStatuses?: string[];
  paymentTermKeys?: number[];
  invoiceTiers?: DebtSizeTier[];
  /** Customer Category (the Customer Growth categories): 'A'..'D' or 'none' */
  customerCategories?: string[];
}

export interface DebtOption {
  value: string;
  labelEn: string;
  labelAr: string | null;
}

export interface DebtFreshness {
  department: string;
  lastSuccessUtc: string | null;
  lastSuccessJob: string | null;
  lastFailureUtc: string | null;
  lastFailureJob: string | null;
  dataAsOf: string | null;
}

/** What the whole report leaves out (warehouse table cfg_finance_report_exclusion, migration 0036). */
export interface DebtExclusions {
  segments: string[];
  salesTeams: string[];
  /** teams whose customer invoices only are left out (0039: Unknown = no Odoo sales team) */
  invoiceTeams?: string[];
  teams: { salesTeamKey: string; salesTeam: string; segment: string | null; bySegment: boolean; byTeam: boolean; invoicesOnly?: boolean }[];
}

export interface DebtMeta {
  snapshots: { date: string; lineCount: number }[];
  snapshotDate: string | null;
  filters: Record<'companyKeys' | 'segmentKeys' | 'channelKeys' | 'salesTeamKeys' | 'salespersonKeys' | 'customerKeys', string[]>;
  options: {
    companies: DebtOption[];
    customerGroups: DebtOption[];
    distributionChannels: DebtOption[];
    salespersons: DebtOption[];
    salesTeams: DebtOption[];
    currencies: DebtOption[];
    agingBuckets: (DebtOption & { isOverdue: boolean })[];
    deliveryStatuses: DebtOption[];
    paymentTerms: DebtOption[];
    /** customers with a line in the snapshot; label "name (Odoo id)" */
    customers: DebtOption[];
    /** Category A..D, No category */
    customerCategories: DebtOption[];
    scopes: (DebtOption & { isDefault: boolean; description: string | null })[];
    sizeTiers: (DebtOption & { min: number | null; max: number | null })[];
  };
  exclusions: DebtExclusions;
  odooBaseUrl: string;
  topCustomers: number;
  /** the credit policy (backend config/creditPolicy.ts): zones of the escalation chart and the table's Aging bucket */
  creditPolicy: { zones: CreditPolicyZone[]; notYetDue: { key: 'NOT_YET_DUE'; label: string } };
  freshness: DebtFreshness;
}

export interface DebtGroupPoint {
  key: string;
  label: string;
  detail?: string | null;
  overdue: number;
  open: number;
  pctOfOverdue: number | null;
}

/** Every amount of a Debt Report response is in its own currency (`currency`); currencies are never added together. */
export interface DebtCurrencyOverview {
  currency: string;
  /** Total debt (openAmount) / overdue / not due / customers: customer invoices only (Odoo's Amount Due), in the
   * invoice currency; the *Company fields are the same in LYD (Odoo's own amount_residual, never a rate of ours).
   * Credit notes and unreconciled payments are Unapplied credits; every line is the Net balance. */
  kpis: {
    openAmount: number;
    openDocuments: number;
    customers: number;
    overdueAmount: number;
    overduePctOfOpen: number | null;
    notDueAmount: number;
    notDuePctOfOpen: number | null;
    openAmountCompany: number;
    overdueAmountCompany: number;
    notDueAmountCompany: number;
    unappliedCredits: number;
    creditNotes: number;
    creditNoteDocuments: number;
    payments: number;
    paymentDocuments: number;
    otherEntries: number;
    otherDocuments: number;
    intercompany: number;
    intercompanyDocuments: number;
    netBalance: number;
    creditOnlyCustomers: number;
    lineCount: number;
  };
  aging: { agingBucketKey: number; label: string; isOverdue: boolean; amount: number; lineCount: number }[];
  topCustomers: DebtGroupPoint[];
  bySalesperson: DebtGroupPoint[];
  byTeam: DebtGroupPoint[];
}

/** "All currencies (in LYD)": every currency's open invoices in the company currency; each customer counted once. */
export interface DebtAllCurrencies {
  currency: string;
  openAmount: number;
  openDocuments: number;
  customers: number;
  overdueAmount: number;
  overduePctOfOpen: number | null;
  notDueAmount: number;
  notDuePctOfOpen: number | null;
}

export interface DebtOverview {
  snapshotDate: string | null;
  lineCount: number;
  currencies: DebtCurrencyOverview[];
  /** every currency together, every amount in LYD (Odoo's Amount Due): the charts of the "All currencies (≈ LYD)" view */
  all: DebtCurrencyOverview;
  allCurrencies: DebtAllCurrencies;
}

export interface DebtTrend {
  /** null amounts = the snapshot has no line for the filters (e.g. a company not extracted yet then): a gap, not 0 */
  points: { snapshotDate: string; currency: string; open: number | null; overdue: number | null; notDue: number | null; net: number | null }[];
  /** every currency together in LYD, one point per snapshot (the "All currencies (≈ LYD)" trend) */
  all: { snapshotDate: string; currency: string; open: number | null; overdue: number | null; notDue: number | null; net: number | null }[];
  currencies: string[];
  snapshotCount: number;
}

export interface DebtCustomerRow {
  companyKey: number;
  company: string;
  customerKey: number;
  customer: string;
  /** "Category A" ... "No category" (the Customer Growth category) */
  customerCategory: string;
  currency: string;
  /** open invoices (count, original amount, open amount) */
  openDocuments: number;
  invoiceAmount: number;
  open: number;
  overdue: number;
  notDue: number;
  /** credit notes + unreconciled payments (zero or negative) */
  credits: number;
  /** other receivable entries + inter-company lines (only with their toggles) */
  otherEntries: number;
  /** every line */
  net: number;
  /** the same amounts in LYD (Odoo's own amount_total_signed / amount_residual): the "All currencies (≈ LYD)" view */
  lyd: { invoiceAmount: number; open: number; overdue: number; notDue: number; credits: number; otherEntries: number; net: number };
  /** its customer's credit-policy zone, exactly as the escalation chart places it: in the row's currency, and over every
   * currency (the all-currencies view); null when the customer has no unpaid invoice (credits only) */
  creditZone: { currency: RowCreditZone | null; all: RowCreditZone | null };
  salespersons: string[];
  salesTeams: string[];
  segments: string[];
  lineCount: number;
}

export interface DebtCustomers {
  snapshotDate: string | null;
  currencies: string[];
  rows: DebtCustomerRow[];
}

/** customer_open = every open invoice of one customer (the escalation chart's dot) */
export type DebtDrillKind = 'customer' | 'aging' | 'salesperson' | 'team' | 'account' | 'customer_open';

export interface DebtDrillRow {
  lineId: number;
  moveId: number;
  company: string;
  document: string | null;
  documentTypeKey: string;
  lineKind: 'invoice' | 'credit_note' | 'payment' | 'other' | 'intercompany';
  invoiceDate: string | null;
  dueDate: string | null;
  daysOverdue: number;
  customerKey: number;
  customer: string;
  currency: string;
  invoiceAmount: number;
  openBalance: number;
  overdueAmount: number;
  /** the same three in LYD (Odoo's own amounts) */
  invoiceAmountCompany: number;
  openBalanceCompany: number;
  overdueAmountCompany: number;
  salesperson: string;
  salesTeamKey: string;
  salesTeam: string;
  segment: string | null;
  odooUrl: string;
}

export interface DebtDrilldown {
  snapshotDate: string | null;
  /** currency null = every currency; the totals are then in LYD */
  drill: { kind: DebtDrillKind; key: string; currency: string | null };
  rows: DebtDrillRow[];
  totals: { lines: number; openDocuments: number; invoiceAmount: number; openBalance: number; overdueAmount: number };
}

/** GET /debt-report/aging (backend measures/debtAging.ts): Credit Policy Escalation. Every zone, day count and
 * placement comes from the server (zones: backend config/creditPolicy.ts); the page only draws them. */
export type CreditZoneKey = 'GREEN' | 'YELLOW' | 'RED' | 'BLOCK' | 'NOT_YET_DUE';

export interface CreditPolicyActionArea {
  minDays: number;
  maxDays: number | null;
  action: string;
  details?: string;
  edgeLabel: string | null;
}

export interface CreditPolicyZone {
  key: Exclude<CreditZoneKey, 'NOT_YET_DUE'>;
  label: string;
  minDays: number;
  /** null = no upper bound (the last zone) */
  maxDays: number | null;
  /** colour token: tokens.css --ps-credit-<tone> */
  tone: 'green' | 'amber' | 'red' | 'block';
  owner: string;
  action: string;
  /** the axis label of the zone's right-hand boundary; null for the last zone */
  edgeLabel: string | null;
  actionAreas?: CreditPolicyActionArea[];
}

export interface RowCreditZone {
  zone: CreditZoneKey;
  daysPastDue: number;
  daysUntilDue: number;
}

export interface CreditCustomer {
  customerKey: number;
  customerCode: string;
  customer: string;
  companyKey: number;
  company: string;
  paymentTermKey: number;
  paymentTerm: string;
  /** every unpaid invoice, in the view's currency (LYD for all currencies) */
  totalOutstanding: number;
  totalOutstandingCompany: number;
  unpaidInvoiceCount: number;
  oldestInvoiceMoveId: number;
  oldestInvoiceNumber: string | null;
  oldestInvoiceDate: string | null;
  oldestDueDate: string;
  dueDateSource: 'instalment' | 'invoice' | 'payment_term' | 'invoice_date';
  daysPastDue: number;
  notYetDue: boolean;
  daysUntilDue: number;
  zone: CreditZoneKey;
  responsibleRole: string;
  requiredAction: string;
  actionDetails?: string;
  nextZone: CreditPolicyZone['key'] | null;
  daysToNextZone: number | null;
  approachingNextZone: boolean;
  odooUrl: string;
}

export interface CreditZoneSummary {
  key: CreditZoneKey;
  customers: number;
  amount: number;
  amountCompany: number;
}

export interface DebtAging {
  snapshotDate: string | null;
  asOf: string | null;
  currency: string | null;
  /** true = every currency together, amounts in LYD (≈) */
  allCurrencies: boolean;
  currencies: string[];
  zones: CreditPolicyZone[];
  escalationWindowDays: number;
  terms: { key: string; label: string; customers: number }[];
  summary: { zones: CreditZoneSummary[]; total: { customers: number; amount: number } };
  customers: CreditCustomer[];
}

/** Query string of a Debt Report request. Lists go as repeated keys (the server's scoped filters read arrays). */
export function buildDebtReportQuery(scope: DebtReportScope, extra: Record<string, string | number> = {}): string {
  const params = new URLSearchParams();
  const list = (key: keyof DebtReportScope) => {
    const values = scope[key];
    if (Array.isArray(values)) for (const v of values) params.append(key, String(v));
  };
  if (scope.snapshotDate) params.set('snapshotDate', scope.snapshotDate);
  if (scope.includeOther) params.set('includeOther', 'true');
  if (scope.includeIntercompany) params.set('includeIntercompany', 'true');
  if (scope.overdueStatus && scope.overdueStatus !== 'all') params.set('overdueStatus', scope.overdueStatus);
  for (const key of ['companyKeys', 'segmentKeys', 'channelKeys', 'salespersonKeys', 'salesTeamKeys', 'customerKeys', 'agingBucketKeys', 'deliveryStatuses', 'paymentTermKeys', 'invoiceTiers', 'customerCategories'] as const) list(key);
  for (const [k, v] of Object.entries(extra)) params.set(k, String(v));
  return params.toString();
}

export type DebtReportEndpoint = 'meta' | 'overview' | 'trend' | 'customers' | 'drilldown' | 'aging' | 'collections-trend' | 'collections-drilldown';

/** GET /debt-report/collections-trend (backend measures/debtCollections.ts) */
export type CollectionGrain = 'day' | 'week' | 'month';
export interface CollectionPoint {
  periodStart: string;
  periodEnd: string;
  /** Payment portions applied to invoices issued before payment day = overdue + not due. */
  collected: number;
  appliedOverdue: number;
  appliedNotDue: number;
  appliedOther: number;
  unapplied: number;
  payments: number;
  startOverdue: number | null;
  collectedOnStartOverdue: number | null;
  collectionRate: number | null;
}
export interface CollectionsTrend {
  currency: string | null;
  /** true = every currency together, amounts in LYD (≈) */
  allCurrencies: boolean;
  currencies: string[];
  grain: CollectionGrain;
  from: string;
  to: string;
  points: CollectionPoint[];
  firstPaymentDate: string | null;
  loadedAt: string | null;
}
export interface CollectionPaymentRow {
  paymentId: number;
  payment: string;
  paymentDate: string;
  company: string;
  /** the payment currency (the amounts below are in it) */
  currency: string;
  /** the payment's amount in LYD (Odoo's own): what an all-currencies bar adds up */
  amountCompany: number;
  customer: string;
  salesperson: string;
  salesTeam: string;
  attribution: string;
  amount: number;
  appliedOverdue: number;
  appliedNotDue: number;
  appliedOther: number;
  unapplied: number;
  invoices: string;
  odooUrl: string;
}
export interface CollectionsDrilldown {
  currency: string | null;
  allCurrencies: boolean;
  period: { start: string; end: string };
  truncated: boolean;
  rows: CollectionPaymentRow[];
}

export function fetchDebtReport<T>(token: string, endpoint: DebtReportEndpoint, scope: DebtReportScope, extra: Record<string, string | number> = {}, signal?: AbortSignal): Promise<T> {
  const qs = buildDebtReportQuery(scope, extra);
  return request<T>(`/debt-report/${endpoint}${qs ? `?${qs}` : ''}`, token, { signal });
}

// -- NPS Score (Process; backend routes/npsScore.ts, measures/npsScore.ts, config/npsThresholds.ts) -----------------
export type NpsEndpoint = 'meta' | 'overview' | 'trend' | 'detractors' | 'reach';
export type NpsBand = 'red' | 'yellow' | 'green';
export type NpsGrain = 'day' | 'month' | 'year';
/** A visual's bands: yellow from `yellowFrom`, green from `greenFrom` (both inclusive), the target, the drawn scale. */
export interface NpsBandScale {
  yellowFrom: number;
  greenFrom: number;
  target: number;
  min: number;
  max: number;
}
/** Every figure of a filtered set; percentages 0..100 unrounded; null without responders. */
export interface NpsCounts {
  responders: number;
  promoters: number;
  passives: number;
  detractors: number;
  promotersPct: number | null;
  passivesPct: number | null;
  detractorsPct: number | null;
  nps: number | null;
  csat: number | null;
  npsBand: NpsBand | null;
  csatBand: NpsBand | null;
  /** fewer responders than the minimum: show greyed with "n = x" */
  belowMinimum: boolean;
}
export interface NpsMeta {
  levels: { level: number; key: string; labelEn: string; labelAr: string; sourceText: string; stars: number }[];
  firstRatingDate: string | null;
  lastRatingDate: string | null;
  lastRatingAt: string | null;
  sourceLastSync: string | null;
  minResponders: number;
  thresholds: { nps: NpsBandScale; csat: NpsBandScale };
  canSeeDetractors: boolean;
  /** the "process" department refresh (the same per-department shape as the finance one) */
  freshness: DebtFreshness;
}
export interface NpsOverview {
  dateFrom: string;
  dateTo: string;
  totals: NpsCounts & { withComment: number };
  minResponders: number;
}
export interface NpsTrend {
  grain: NpsGrain;
  target: number;
  minResponders: number;
  points: ({ period: string } & NpsCounts)[];
}
export interface NpsReach {
  status: 'waiting' | 'restricted' | 'ready';
  dateFrom: string;
  dateTo: string;
  companyAndDateOnly: boolean;
  loadedAt: string | null;
  /** first message date counted (the ETL's NPS_REACH_START), null = all history */
  reachStart: string | null;
  totals: { totalReach: number; delivered: number; notDelivered: number; read: number; error: number; otherState: number } | null;
  errors: { key: string; label: string; fixable: boolean; hint: string; count: number }[];
}
export interface NpsPage<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}
export interface NpsDetractor {
  responseId: number;
  ratedAt: string | null;
  ratingDate: string | null;
  company: string | null;
  customerKey: number;
  customer: string | null;
  orderRef: string | null;
  deliveryCode: string | null;
  salesTeam: string | null;
  salesperson: string | null;
  teamBranch: string | null;
  /** the follow-up status / reason: no source yet (null) */
  status: string | null;
  reason: string | null;
  comment: string | null;
}
/** The global filters + the page's date range. */
export interface NpsScope extends TachometerFilters {
  dateFrom: string;
  dateTo: string;
}

export function buildNpsQuery(scope: NpsScope, extra: Record<string, string | number> = {}): string {
  const params = new URLSearchParams(buildQuery('', scope));
  params.delete('anchorDate');
  params.set('dateFrom', scope.dateFrom);
  params.set('dateTo', scope.dateTo);
  for (const [k, v] of Object.entries(extra)) if (v !== '' && v !== undefined) params.set(k, String(v));
  return params.toString();
}

export function fetchNpsScore<T>(token: string, endpoint: NpsEndpoint, scope: NpsScope, extra: Record<string, string | number> = {}, signal?: AbortSignal): Promise<T> {
  return request<T>(`/nps-score/${endpoint}?${buildNpsQuery(scope, extra)}`, token, { signal });
}
