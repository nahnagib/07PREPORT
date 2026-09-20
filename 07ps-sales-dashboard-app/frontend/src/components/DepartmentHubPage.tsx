'use client';
import React from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { AppHeader } from './AppHeader';
import { Card } from '@07ps/ui';
import { useAuth } from '../lib/AuthProvider';
import { getDepartment } from '../lib/departments';
import { departmentReports, type NavDepartment } from '../lib/navItems';

/**
 * Shared body for a department's report-card hub (grid of report cards, each linking to its live
 * route or showing "Coming Soon" if unbuilt). Extracted from what was a Promotion-only page so the
 * same grid/permission-filtering logic isn't duplicated per department as more departments gain
 * real reports (Product's BCG Matrix / Stock Velocity / PIM Contribution / Product Lifecycle
 * being the first move off Promotion -- see navItems.ts's `department` field).
 */
export function DepartmentHubPage({ departmentKey }: { departmentKey: NavDepartment }) {
  const { user, canView, logout } = useAuth();
  const department = getDepartment(departmentKey);
  if (!department) return null;
  const roleLabel = user?.role.label ?? user?.fullName;
  const items = departmentReports(departmentKey, canView);

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

      <main style={{ flex: 1, padding: 'var(--ps-space-4, 24px)' }}>
        <p style={{ margin: '0 0 var(--ps-space-4, 24px)', fontSize: 14, color: 'var(--ps-color-muted-text)' }}>
          Reports available in the {department.pTerm} ({department.name}) department.
        </p>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: 'var(--ps-space-3, 16px)',
          }}
        >
          {items.map(({ label, icon: Icon, href }) => {
            const live = Boolean(href);
            const content = (
              <Card
                className={live ? 'ps-hub-card' : ''}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                  height: '100%',
                  opacity: live ? 1 : 0.55,
                  cursor: live ? 'pointer' : 'not-allowed',
                }}
              >
                <div
                  aria-hidden
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 44,
                    height: 44,
                    borderRadius: 12,
                    background: 'var(--ps-color-accent-bg)',
                    color: 'var(--ps-color-accent)',
                  }}
                >
                  <Icon size={22} />
                </div>
                <div style={{ fontSize: 16, fontWeight: 700 }}>{label}</div>
                <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', flex: 1 }}>
                  {live ? 'Live report, wired to the validation warehouse.' : 'Not built yet.'}
                </div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 13,
                    fontWeight: 600,
                    color: live ? 'var(--ps-color-accent)' : 'var(--ps-color-muted-text)',
                  }}
                >
                  {live ? 'Open report' : 'Coming Soon'}
                  {live && <ArrowRight size={14} />}
                </div>
              </Card>
            );

            return href ? (
              <Link key={label} href={href} style={{ textDecoration: 'none', color: 'inherit' }}>
                {content}
              </Link>
            ) : (
              <div key={label} aria-disabled title={`${label} — not built yet`}>
                {content}
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}
