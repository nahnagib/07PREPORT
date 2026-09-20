import { DepartmentHubPage } from '../../../components/DepartmentHubPage';

/**
 * Product department mini-hub -- was a full `DepartmentPlaceholderPage` ("Coming Soon" only) until
 * BCG Matrix / Stock Velocity / PIM Contribution / Product Lifecycle moved here from Promotion
 * (see lib/navItems.ts's `department` field). Lists every report NAV_ITEMS tags with
 * `department: 'product'`, via the shared `DepartmentHubPage`. The rest of Product (Production
 * Department) still has no other built reports.
 */
export default function ProductPage() {
  return <DepartmentHubPage departmentKey="product" />;
}
