import { DepartmentHubPage } from '../../../components/DepartmentHubPage';

/** Process (Excellence Department) mini-hub -- was a "Coming Soon" placeholder until the Kaizen
 * Board; lists every NAV_ITEMS report tagged `department: 'process'`, like the Product hub. */
export default function ProcessPage() {
  return <DepartmentHubPage departmentKey="process" />;
}
