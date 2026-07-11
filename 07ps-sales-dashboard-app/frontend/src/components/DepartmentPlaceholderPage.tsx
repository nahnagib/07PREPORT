'use client';
import React from 'react';
import { AppHeader } from './AppHeader';
import { DepartmentPlaceholder } from './DepartmentPlaceholder';
import { useAuth } from '../lib/AuthProvider';
import { getDepartment } from '../lib/departments';

/** Shared body for every not-yet-built department's page.tsx (Product, Place, People, Physical
 * Evidence, Process, Price) -- keeps those 6 route files to a 3-line wrapper each instead of
 * duplicating the same header/placeholder wiring six times. */
export function DepartmentPlaceholderPage({ departmentKey }: { departmentKey: string }) {
  const { user, logout } = useAuth();
  const department = getDepartment(departmentKey);
  if (!department) return null;
  const roleLabel = user?.role.label ?? user?.fullName;

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <AppHeader
        pageTitle={`${department.pTerm} — ${department.name}`}
        anchorDate=""
        onAnchorDateChange={() => {}}
        roleLabel={roleLabel}
        onLogout={logout}
        showDateInput={false}
      />
      <DepartmentPlaceholder department={department} />
    </div>
  );
}
