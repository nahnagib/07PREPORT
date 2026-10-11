import { DepartmentHubPage } from '../../../components/DepartmentHubPage';

/**
 * Price (Finance Department) mini-hub -- was a "Coming Soon" placeholder until Receivables and Collections. Lists every report
 * NAV_ITEMS tags with `department: 'price'`, via the shared DepartmentHubPage, like the Product and Process hubs.
 */
export default function PricePage() {
  return <DepartmentHubPage departmentKey="price" />;
}
