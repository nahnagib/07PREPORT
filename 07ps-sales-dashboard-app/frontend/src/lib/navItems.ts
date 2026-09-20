import { Gauge as GaugeIcon, AlertTriangle, TrendingUp, FileText, Users, ShieldCheck, Filter, LineChart, Activity, Boxes, PieChart, RefreshCw, Grid2x2, Wallet, Megaphone, Globe, Store } from 'lucide-react';

/** Which department hub (PromotionHubPage/ProductHubPage via DepartmentHubPage) lists a given
 * report card, and which sidebar tab it's grouped under. Normally matches the `href`'s route
 * segment -- see the BCG Matrix/Stock Velocity/PIM Contribution/Product Lifecycle entries below,
 * whose Next.js routes were moved from app/(departments)/promotion/* to
 * app/(departments)/product/* to match `department: 'product'` (a card's "Open report" link and
 * its actual route must agree). */
export type NavDepartment = 'promotion' | 'product';

/** Single source of truth for primary nav entries, each tied to a `pages.page_key` from the
 * permissions model (0009_auth_identity.sql). Every nav component (BottomNavBar, DepartmentHubPage,
 * IconNavRail if it's ever revived) filters this list through `canView`, so a page without View
 * permission is hidden from navigation entirely -- not just disabled -- per spec. `href: null`
 * still means "not built yet" (Phase P3), independent of permission. */
export const NAV_ITEMS = [
  { label: 'Tachometer', icon: GaugeIcon, href: '/promotion/tachometer', pageKey: 'tachometer', department: 'promotion' },
  { label: 'Critical Number', icon: AlertTriangle, href: '/promotion/critical-number', pageKey: 'critical_number', department: 'promotion' },
  { label: 'Revenue Trend', icon: TrendingUp, href: '/promotion/revenue-trend', pageKey: 'revenue_trend', department: 'promotion' },
  { label: 'Invoices Engine', icon: FileText, href: '/promotion/invoices-engine', pageKey: 'invoices_engine', department: 'promotion' },
  { label: 'Customer Growth', icon: Users, href: '/promotion/customer-growth', pageKey: 'customer_growth', department: 'promotion' },
  { label: 'Pipeline Health', icon: Filter, href: '/promotion/pipeline-health', pageKey: 'pipeline_health', department: 'promotion' },
  { label: 'Pipeline Trend', icon: LineChart, href: '/promotion/pipeline-trend', pageKey: 'pipeline_trend', department: 'promotion' },
  { label: 'Activity Momentum', icon: Activity, href: '/promotion/activity-momentum', pageKey: 'activity_momentum', department: 'promotion' },
  // MARCOM Contribution pages (data uploaded by the Marketing Director as Excel; see docs/marcom-kpi.md).
  { label: 'MARCOM Spending', icon: Wallet, href: '/promotion/marcom-spending', pageKey: 'marcom_spending', department: 'promotion' },
  { label: 'Media Campaign Performance', icon: Megaphone, href: '/promotion/marcom-campaigns', pageKey: 'marcom_media_campaigns', department: 'promotion' },
  { label: 'Digital Performance', icon: Globe, href: '/promotion/marcom-digital', pageKey: 'marcom_digital', department: 'promotion' },
  { label: 'Trade Marketing & Retail', icon: Store, href: '/promotion/marcom-trade', pageKey: 'marcom_trade', department: 'promotion' },
  // Materials Analogy module (product/inventory reports). Real Next.js routes as of the
  // theme-integration rebuild -- rendering against local synthetic data
  // (lib/materialsAnalogy/shared.ts) via the same @07ps/ui components/tokens every other report
  // uses, not standalone HTML anymore (those lived at public/reports/*.html and have been
  // removed). BCG Matrix is the module's product-classification page and deliberately listed
  // first among the 4 (matches how the other 3 pages already treat bcg_class_YTD as a given
  // input) -- order here is render order (BottomNavBar/DepartmentHubPage both just .map() this
  // array), not a separate weight field. Moved from Promotion to Product, routes and all (now
  // under app/(departments)/product/*), per explicit request -- Sales/'nav_group' in
  // 0014_materials_analogy_pages.sql / 0015_bcg_matrix_page.sql is a separate RBAC grouping and is
  // unaffected by this move.
  { label: 'BCG Matrix', icon: Grid2x2, href: '/product/bcg-matrix', pageKey: 'bcg_matrix', department: 'product' },
  { label: 'Stock Velocity', icon: Boxes, href: '/product/stock-velocity', pageKey: 'stock_velocity', department: 'product' },
  { label: 'PIM Contribution', icon: PieChart, href: '/product/pim-contribution', pageKey: 'pim_contribution', department: 'product' },
  { label: 'Product Lifecycle', icon: RefreshCw, href: '/product/product-lifecycle', pageKey: 'product_lifecycle', department: 'product' },
] as const;

/** Administration lands on User Management; the admin section itself has its own internal nav. */
export const ADMIN_NAV_ITEM = { label: 'Admin', icon: ShieldCheck, href: '/admin/users', pageKey: 'admin_users' } as const;

/** Every NAV_ITEMS entry registered to `departmentKey`, gated by the caller's `canView` -- the one
 * place "which reports does this department have" is answered from, so BottomNavBar,
 * DepartmentHubPage, and the 7Ps Hub page (lib/departments.ts consumers) can't drift out of sync
 * with each other or need their own hardcoded per-department lists. */
export function departmentReports(departmentKey: string, canView: (pageKey: string) => boolean) {
  return NAV_ITEMS.filter((item) => item.department === departmentKey && canView(item.pageKey));
}

/** Whether `departmentKey` has any report registered at all, independent of permissions --
 * distinguishes "nothing built yet" (Hub page always shows "Coming Soon") from "built, but this
 * viewer can't see any of it" (Hub page hides the card entirely), the same split the Hub page
 * already applied to Promotion alone before Product gained real reports too. */
export function departmentIsBuilt(departmentKey: string): boolean {
  return NAV_ITEMS.some((item) => item.department === departmentKey);
}
