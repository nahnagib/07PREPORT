/**
 * Central permission registry: every page/module the permission system knows about, and which
 * actions apply to it. This is the single source of truth --
 *
 *   - the backend syncs it into the `pages` / `permissions` tables at startup
 *     (services/permissionService.ts's syncPermissionRegistry), so a new page needs no migration;
 *   - permission checks only honor actions listed here (a stale DB row for an action a page doesn't
 *     have is ignored);
 *   - the frontend reads it from GET /auth/me (`registry`) to build the Roles permission matrix.
 *
 * Adding a page = one entry below (plus, on the frontend, its route in lib/navItems.ts). Existing
 * roles get no access to it until an admin grants it; the Admin role gets every action implicitly.
 *
 * `navGroup` keeps the values the `pages.nav_group` column already used ('Sales' for every report,
 * product reports included, 'Administration' for the admin panel) so existing rows sync unchanged.
 */

export const PERMISSION_ACTIONS = ['view', 'create', 'edit', 'delete', 'export'] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

export type RegistryGroup = 'dashboard' | 'admin';

export interface RegistryEntry {
  key: string;
  label: string;
  group: RegistryGroup;
  actions: readonly PermissionAction[];
}

const DASHBOARD: readonly PermissionAction[] = ['view', 'export'];
const CRUD: readonly PermissionAction[] = ['view', 'create', 'edit', 'delete'];

export const PERMISSION_REGISTRY: readonly RegistryEntry[] = [
  // Dashboards (read-only reports: View + Export).
  { key: 'tachometer', label: 'Tachometer', group: 'dashboard', actions: DASHBOARD },
  { key: 'critical_number', label: 'Critical Number', group: 'dashboard', actions: DASHBOARD },
  { key: 'revenue_trend', label: 'Revenue Trend', group: 'dashboard', actions: DASHBOARD },
  { key: 'invoices_engine', label: 'Invoices Engine', group: 'dashboard', actions: DASHBOARD },
  { key: 'customer_growth', label: 'Customer Growth', group: 'dashboard', actions: DASHBOARD },
  { key: 'pipeline_health', label: 'Pipeline Health', group: 'dashboard', actions: DASHBOARD },
  { key: 'pipeline_trend', label: 'Pipeline Trend', group: 'dashboard', actions: DASHBOARD },
  { key: 'activity_momentum', label: 'Activity Momentum', group: 'dashboard', actions: DASHBOARD },
  { key: 'marcom_spending', label: 'MARCOM Spending', group: 'dashboard', actions: DASHBOARD },
  { key: 'marcom_media_campaigns', label: 'Media Campaign Performance', group: 'dashboard', actions: DASHBOARD },
  { key: 'marcom_digital', label: 'Digital Performance', group: 'dashboard', actions: DASHBOARD },
  { key: 'marcom_trade', label: 'Trade Marketing & Retail', group: 'dashboard', actions: DASHBOARD },
  { key: 'bcg_matrix', label: 'BCG Matrix', group: 'dashboard', actions: DASHBOARD },
  { key: 'stock_velocity', label: 'Stock Velocity', group: 'dashboard', actions: DASHBOARD },
  { key: 'pim_contribution', label: 'PIM Contribution', group: 'dashboard', actions: DASHBOARD },
  { key: 'product_lifecycle', label: 'Product Lifecycle', group: 'dashboard', actions: DASHBOARD },

  // Admin Panel sections. Actions mirror the endpoints each section actually has (e.g. users can't
  // be deleted, only disabled -- an edit; salespersons/sales teams are ETL-owned, edit only).
  { key: 'admin_users', label: 'Users', group: 'admin', actions: ['view', 'create', 'edit'] },
  { key: 'admin_roles', label: 'Roles & Permissions', group: 'admin', actions: CRUD },
  { key: 'admin_salespersons', label: 'Salespersons', group: 'admin', actions: ['view', 'edit'] },
  { key: 'admin_salesteams', label: 'Sales Teams', group: 'admin', actions: ['view', 'edit'] },
  { key: 'admin_customer_groups', label: 'Customer Groups', group: 'admin', actions: CRUD },
  { key: 'admin_distribution_channels', label: 'Distribution Channels', group: 'admin', actions: CRUD },
  { key: 'admin_companies', label: 'Companies', group: 'admin', actions: CRUD },
  { key: 'admin_holidays', label: 'Official Holidays', group: 'admin', actions: CRUD },
  { key: 'admin_closures', label: 'Forced Closures', group: 'admin', actions: CRUD },
  // create = validate/commit an upload, delete = roll a batch back, export = download the error
  // report / an uploaded batch's original file.
  { key: 'admin_marcom_upload', label: 'MARCOM Data Upload', group: 'admin', actions: ['view', 'create', 'delete', 'export'] },
  { key: 'admin_login_history', label: 'Login History', group: 'admin', actions: ['view'] },
  { key: 'admin_etl', label: 'ETL Runs', group: 'admin', actions: ['view'] },
];

const BY_KEY = new Map(PERMISSION_REGISTRY.map((e) => [e.key, e]));

export function getRegistryEntry(pageKey: string): RegistryEntry | undefined {
  return BY_KEY.get(pageKey);
}

export function isRegisteredAction(pageKey: string, action: string): action is PermissionAction {
  return BY_KEY.get(pageKey)?.actions.includes(action as PermissionAction) ?? false;
}

export function dashboardPageKeys(): string[] {
  return PERMISSION_REGISTRY.filter((e) => e.group === 'dashboard').map((e) => e.key);
}

/** `pages.nav_group` value for a registry group (kept identical to the pre-registry values). */
export function navGroupOf(group: RegistryGroup): 'Sales' | 'Administration' {
  return group === 'dashboard' ? 'Sales' : 'Administration';
}

/** Normalizes a requested action set for one page: drops actions the page doesn't have, and adds
 * View whenever any other action is present (every action implies being able to see the page). */
export function normalizePageActions(pageKey: string, actions: readonly string[]): PermissionAction[] {
  const entry = BY_KEY.get(pageKey);
  if (!entry) return [];
  const kept = entry.actions.filter((a) => actions.includes(a));
  if (kept.length > 0 && !kept.includes('view')) kept.unshift('view');
  return PERMISSION_ACTIONS.filter((a) => kept.includes(a));
}
