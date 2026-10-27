'use client';
import React from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Card } from '@07ps/ui';
import { AppHeader } from './AppHeader';
import { BottomNavBar } from './BottomNavBar';
import { PermissionGuard } from './AuthGuard';
import { ComingSoonTag } from './ComingSoonTag';
import { useAuth } from '../lib/AuthProvider';
import { getDepartment } from '../lib/departments';
import { NAV_ITEMS } from '../lib/navItems';

/**
 * Placeholder for a page announced in the navigation before it is built (navItems `comingSoon: true`): its own
 * route and permission, a "Coming soon" tag and a short note. Replace the route's page.tsx with the real report
 * (and drop `comingSoon` from navItems) when it is built.
 */
export function ComingSoonPage({ pageKey, description }: { pageKey: string; description: string }) {
  const { user, logout } = useAuth();
  const item = NAV_ITEMS.find((n) => n.pageKey === pageKey);
  const department = item ? getDepartment(item.department) : undefined;
  if (!item) return null;
  const Icon = item.icon;

  return (
    <PermissionGuard pageKey={pageKey}>
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', paddingBottom: 64 }}>
        <AppHeader pageTitle={item.label} anchorDate="" onAnchorDateChange={() => {}} roleLabel={user?.role.label ?? user?.fullName} onLogout={logout} showDateInput={false} />
        <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--ps-space-4, 24px)' }}>
          <Card
            data-testid="coming-soon-page"
            style={{ maxWidth: 520, width: '100%', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--ps-space-3, 16px)', padding: 'var(--ps-space-6, 40px) var(--ps-space-4, 24px)' }}
          >
            <div aria-hidden style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 72, height: 72, borderRadius: 20, background: 'var(--ps-color-accent-bg)', color: 'var(--ps-color-accent)' }}>
              <Icon size={34} />
            </div>
            <div>
              <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>{item.label}</h1>
              {department && <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--ps-color-muted-text)' }}>{department.pTerm} — {department.name}</p>}
            </div>
            <ComingSoonTag />
            <p style={{ margin: 0, fontSize: 14, color: 'var(--ps-color-muted-text)', lineHeight: 1.5 }}>{description}</p>
            {department && (
              <Link href={department.href} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: 'var(--ps-color-accent)', textDecoration: 'none' }}>
                <ArrowLeft size={14} aria-hidden /> Back to {department.name}
              </Link>
            )}
          </Card>
        </main>
        <BottomNavBar active={item.label} />
      </div>
    </PermissionGuard>
  );
}
