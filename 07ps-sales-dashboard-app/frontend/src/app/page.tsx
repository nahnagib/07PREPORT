'use client';
import React from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { AppHeader } from '../components/AppHeader';
import { Card } from '@07ps/ui';
import { useAuth } from '../lib/AuthProvider';
import { DEPARTMENTS } from '../lib/departments';

/**
 * 7Ps Dashboard Hub -- the new landing page (bmh.com.ly/Dashboard). Replaces what used to be the
 * Tachometer page at this route; the real Tachometer dashboard now lives one level under Promotion
 * (`/promotion/tachometer`, see app/(departments)/promotion/tachometer/page.tsx). This page has no
 * DepartmentSidebar (it's outside the `(departments)` route group) -- the sidebar only appears once
 * a user is inside a department, per spec.
 *
 * Each of the 7 cards is sourced from `lib/departments.ts`, the single source of truth also used by
 * DepartmentSidebar and the placeholder pages, so a future 8th department only needs an entry there.
 */
export default function DashboardHubPage() {
  const { user, canView, logout } = useAuth();
  const roleLabel = user?.role.label ?? user?.fullName;

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <AppHeader
        pageTitle="7Ps Dashboard Hub"
        anchorDate=""
        onAnchorDateChange={() => {}}
        roleLabel={roleLabel}
        onLogout={logout}
        showDateInput={false}
      />

      <main style={{ flex: 1, padding: 'var(--ps-space-6, 40px) var(--ps-space-4, 24px)' }}>
        <div style={{ maxWidth: 1160, margin: '0 auto' }}>
          <div style={{ marginBottom: 'var(--ps-space-5, 32px)', textAlign: 'center' }}>
            <h1 style={{ margin: 0, fontSize: 28, fontWeight: 800 }}>7Ps Dashboard Hub</h1>
            <p style={{ margin: '8px 0 0', fontSize: 14, color: 'var(--ps-color-muted-text)' }}>
              Select a department to view its performance dashboard.
            </p>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: 'var(--ps-space-4, 24px)',
            }}
          >
            {DEPARTMENTS.filter((d) => d.status !== 'live' || canView('tachometer')).map((dept) => {
              const Icon = dept.icon;
              const isLive = dept.status === 'live';
              return (
                <Link key={dept.key} href={dept.href} style={{ textDecoration: 'none', color: 'inherit' }}>
                  <Card
                    className="ps-hub-card"
                    aria-label={`${dept.pTerm} — ${dept.name}`}
                    style={{
                      height: '100%',
                      minHeight: 220,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 'var(--ps-space-3, 16px)',
                      borderTop: `3px solid ${dept.accent}`,
                    }}
                  >
                    <div
                      aria-hidden
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 52,
                        height: 52,
                        borderRadius: 14,
                        background: `color-mix(in srgb, ${dept.accent} 18%, transparent)`,
                        color: dept.accent,
                      }}
                    >
                      <Icon size={26} />
                    </div>

                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 20, fontWeight: 800 }}>{dept.pTerm}</div>
                      <div style={{ fontSize: 12.5, color: 'var(--ps-color-muted-text)', marginTop: 2 }}>{dept.name}</div>
                      <p style={{ fontSize: 13, color: 'var(--ps-color-muted-text)', marginTop: 10, marginBottom: 0 }}>
                        {dept.tagline}
                      </p>
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        fontSize: 13,
                        fontWeight: 700,
                        color: isLive ? dept.accent : 'var(--ps-color-muted-text)',
                      }}
                    >
                      {isLive ? 'View KPIs' : 'Coming Soon'}
                      <ArrowRight size={14} />
                    </div>
                  </Card>
                </Link>
              );
            })}
          </div>
        </div>
      </main>
    </div>
  );
}
