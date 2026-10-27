'use client';
import React from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { AppHeader } from './AppHeader';
import { Card } from '@07ps/ui';
import { ComingSoonTag } from './ComingSoonTag';
import { useAuth } from '../lib/AuthProvider';
import { getDepartment } from '../lib/departments';
import { departmentReports, isComingSoon, type NavDepartment } from '../lib/navItems';

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
          {items.map((item) => {
            const { label, icon: Icon, href } = item;
            const soon = isComingSoon(item);
            const live = Boolean(href) && !soon;
            const content = (
              <Card
                className={href ? 'ps-hub-card' : ''}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                  height: '100%',
                  position: 'relative',
                  opacity: href ? 1 : 0.55,
                  cursor: href ? 'pointer' : 'not-allowed',
                }}
              >
                {soon && <ComingSoonTag style={{ position: 'absolute', top: 14, right: 14 }} />}
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
                  {live ? 'Live report, wired to the validation warehouse.' : soon ? 'Planned. This page is being prepared.' : 'Not built yet.'}
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
                  {live ? 'Open report' : soon ? 'Preview' : 'Coming Soon'}
                  {href && <ArrowRight size={14} />}
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
