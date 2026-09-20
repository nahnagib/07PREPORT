import { DepartmentHubPage } from '../../../components/DepartmentHubPage';

/**
 * Promotion department mini-hub -- the "Promotion Dashboard" landing page
 * (bmh.com.ly/Dashboard/promotion), one level below the 7Ps Dashboard Hub and one level above the
 * actual Tachometer report (bmh.com.ly/Dashboard/promotion/tachometer). Lists every report
 * `NAV_ITEMS` (lib/navItems.ts) tags with `department: 'promotion'`, via the shared
 * `DepartmentHubPage` (also used by Product -- see app/(departments)/product/page.tsx).
 */
export default function PromotionHubPage() {
  return <DepartmentHubPage departmentKey="promotion" />;
}
