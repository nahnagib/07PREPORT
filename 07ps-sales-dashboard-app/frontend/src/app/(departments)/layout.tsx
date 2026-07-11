import { DepartmentSidebar } from '../../components/DepartmentSidebar';

/**
 * Shared shell for every department route (Promotion, Product, Place, ...). A route group
 * (`(departments)`) so it never adds a URL segment -- `/promotion` stays `/promotion` -- and so a
 * future department only needs a new folder here to inherit the sidebar, not a copy-pasted layout.
 * The Dashboard Hub (`app/page.tsx`) lives outside this group and has no sidebar, per spec ("once a
 * user enters any department, display a permanent left sidebar").
 *
 * Each page still renders its own AppHeader (as the Tachometer page already did) rather than this
 * layout hoisting a shared one -- avoids a double header on pages that need page-specific header
 * controls (date/refresh) and keeps the working Tachometer page's header wiring untouched.
 */
export default function DepartmentsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <DepartmentSidebar />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>{children}</div>
    </div>
  );
}
