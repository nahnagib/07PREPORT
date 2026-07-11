'use client';
import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AppHeader } from './AppHeader';
import { BottomNavBar } from './BottomNavBar';
import { useAuth } from '../lib/AuthProvider';

const TABS = [
  { label: 'Users', href: '/admin/users', pageKey: 'admin_users' },
  { label: 'Roles & Permissions', href: '/admin/roles', pageKey: 'admin_roles' },
  { label: 'Login History', href: '/admin/login-history', pageKey: 'admin_login_history' },
] as const;

const ETL_TAB = { label: 'ETL Control Center', href: '/admin/etl-control' } as const;

/** Shared chrome for every admin page -- header + a small tab row switching between the
 * Administration sections, each individually gated by canView so a section a user can't reach
 * doesn't even show as a tab. The ETL Control Center tab is the one exception: it's hard-gated to
 * the Admin role directly (not canView) so it stays hidden even if the vestigial `admin_etl`
 * permission is ever granted to another role -- see backend's requireAdminRole. */
export function AdminLayout({ title, children }: { title: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, canView, logout } = useAuth();
  const visibleTabs = [
    ...TABS.filter((t) => canView(t.pageKey)),
    ...(user?.role.name === 'ADMIN' ? [ETL_TAB] : []),
  ];

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', paddingBottom: 64 }}>
      <AppHeader
        pageTitle={title}
        anchorDate=""
        onAnchorDateChange={() => {}}
        roleLabel={user?.role.label ?? user?.fullName}
        onLogout={logout}
        showDateInput={false}
      />

      <div
        style={{
          display: 'flex',
          gap: 4,
          padding: '0 var(--ps-space-4, 24px)',
          borderBottom: '1px solid var(--ps-color-border)',
          background: 'var(--ps-color-surface)',
        }}
      >
        {visibleTabs.map((tab) => {
          const active = pathname?.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              style={{
                padding: '12px 14px',
                fontSize: 13.5,
                fontWeight: 600,
                textDecoration: 'none',
                color: active ? 'var(--ps-color-accent)' : 'var(--ps-color-muted-text)',
                borderBottom: active ? '2px solid var(--ps-color-accent)' : '2px solid transparent',
              }}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>

      <main style={{ flex: 1, padding: 'var(--ps-space-4, 24px)' }}>{children}</main>

      <BottomNavBar active="Admin" />
    </div>
  );
}
