import { Gauge as GaugeIcon, AlertTriangle, TrendingUp, FileText, Users, ShieldCheck } from 'lucide-react';

/** Single source of truth for primary nav entries, each tied to a `pages.page_key` from the
 * permissions model (0009_auth_identity.sql). Every nav component (BottomNavBar today,
 * IconNavRail if it's ever revived) filters this list through `canView`, so a page without View
 * permission is hidden from navigation entirely -- not just disabled -- per spec. `href: null`
 * still means "not built yet" (Phase P3), independent of permission. */
export const NAV_ITEMS = [
  { label: 'Tachometer', icon: GaugeIcon, href: '/promotion/tachometer', pageKey: 'tachometer' },
  { label: 'Critical Number', icon: AlertTriangle, href: '/promotion/critical-number', pageKey: 'critical_number' },
  { label: 'Revenue Trend', icon: TrendingUp, href: '/promotion/revenue-trend', pageKey: 'revenue_trend' },
  { label: 'Invoices Engine', icon: FileText, href: '/promotion/invoices-engine', pageKey: 'invoices_engine' },
  { label: 'Customer Growth', icon: Users, href: '/promotion/customer-growth', pageKey: 'customer_growth' },
] as const;

/** Administration lands on User Management; the admin section itself has its own internal nav. */
export const ADMIN_NAV_ITEM = { label: 'Admin', icon: ShieldCheck, href: '/admin/users', pageKey: 'admin_users' } as const;
