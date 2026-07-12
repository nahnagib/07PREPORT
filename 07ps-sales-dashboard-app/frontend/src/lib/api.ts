/**
 * Backend API client. Talks to the Node/Express backend built in this session
 * (backend/src/routes/*.ts), never directly to MySQL or to Odoo.
 *
 * IMPORTANT: this page runs against the throwaway/validation MySQL warehouse
 * (data loaded directly from SalesModel_OneOutput.xlsx plus a mocked Odoo catalog -- see
 * data/ingestion/tachometer_kpi_validation.md). There is no live Odoo connection. Nothing in this
 * client or the UI should ever claim otherwise.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

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
  return params.toString();
}

export function fetchTachometerOverview(
  token: string,
  anchorDate: string,
  filters: TachometerFilters,
): Promise<TachometerOverview> {
  return request(`/tachometer/overview?${buildQuery(anchorDate, filters)}`, token);
}

export function fetchBusinessUnits(token: string) {
  return request<DimOption[]>('/filters/business-units', token);
}
export function fetchCustomerGroups(token: string) {
  return request<DimOption[]>('/filters/customer-groups', token);
}
export function fetchDistributionChannels(token: string) {
  return request<DimOption[]>('/filters/distribution-channels', token);
}
export function fetchBranches(token: string) {
  return request<DimOption[]>('/filters/branches', token);
}
export function fetchSalespersons(token: string) {
  return request<DimOption[]>('/filters/salespersons', token);
}

export interface RefreshStatus {
  lastUpdate: string | null;
  lastRefreshTime: string | null;
  isStale: boolean;
  isInverted: boolean;
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

export const adminApi = {
  listRoles: (token: string): Promise<AdminRole[]> => request('/admin/users/meta/roles', token),

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

  cancelEtlRun: (token: string): Promise<{ ok: boolean; message: string }> =>
    request('/admin/etl/cancel', token, { method: 'POST' }),
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

export interface EtlStatusResponse {
  run: EtlJobRun | null;
  progress: EtlProgress | null;
  recentLog: string[];
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
export interface RolePermissionMatrix {
  roles: RoleMatrixRow[];
  pages: { page_id: number; page_key: string; page_label: string; nav_group: string | null }[];
  matrix: Record<number, EffectivePermissions>;
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
}

export interface CriticalNumberHolidaysCard {
  value: number;
  items: OffDayItem[];
}

export interface ForcedClosureBranchSummary {
  branch: string;
  branchName: string;
  company: string | null;
  days: number;
}

export interface CriticalNumberForcedClosuresCard {
  value: number;
  branches: ForcedClosureBranchSummary[];
}

export interface CriticalNumberTrendCard {
  value: number;
  trendValues: number[];
  trendPct: number | null;
}

export interface CriticalNumberOverview {
  anchorDate: string;
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

export interface RevenueTrendOverview {
  anchorDate: string;
  series: RevenueTrendMonthPoint[];
  kpis: RevenueTrendKpis;
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
  avgSalesPerInvoice: number | null;
  avgLinesPerInvoice: number | null;
  avgVolumePerInvoice: number | null;
}

export interface InvoiceClassificationSlice {
  invoiceClass: string;
  value: number;
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
  kpis: CustomerGrowthKpis;
  rates: CustomerGrowthRates;
  customersTrend: CustomerYearPoint[];
  customersContribution: CustomersContribution;
  categoryPerformance: CategoryPerformanceRow[];
  customersTable: CustomerTableRow[];
}

/** Page-filter scope for the Customers Trend "click a year" interaction -- see
 * backend/src/routes/customerGrowth.ts's header comment for which query honors it. */
export interface CustomerGrowthScope {
  selectedYear?: number | null;
}

export function fetchCustomerGrowthOverview(
  token: string,
  anchorDate: string,
  filters: TachometerFilters,
  scope: CustomerGrowthScope = {},
): Promise<CustomerGrowthOverview> {
  const params = new URLSearchParams(buildQuery(anchorDate, filters));
  if (scope.selectedYear != null) params.set('selectedYear', String(scope.selectedYear));
  return request(`/customer-growth/overview?${params.toString()}`, token);
}
