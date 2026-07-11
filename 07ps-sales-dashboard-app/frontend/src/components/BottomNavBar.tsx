'use client';
import React from 'react';
import Link from 'next/link';
import { useAuth } from '../lib/AuthProvider';
import { ADMIN_NAV_ITEM, NAV_ITEMS } from '../lib/navItems';

/**
 * Tachometer rebuild (dark-theme pass): fixed bottom navigator, per the mockup's "modern bottom
 * page navigator... low-profile, dark-tinted translucent container" spec. Distinct from
 * TopTabBar.tsx (12 items, all pages) -- this bar only lists the 5 items the mockup explicitly
 * named. Same "only Tachometer is real" convention as the rest of this codebase's nav components.
 *
 * Permission-gated (Standards: "if a user does not have View permission for a page, hide it from
 * the sidebar/navigation"): each item is filtered through canView(pageKey) before rendering, so a
 * page without View permission never appears here at all, not merely disabled. The Admin entry
 * only appears for users who can view at least one Administration page.
 *
 * IconNavRail.tsx (the previous left-rail nav) is left in place, unused, per this session's
 * convention of not deleting superseded components -- this page now uses TopTabBar + BottomNavBar
 * instead.
 */
export function BottomNavBar({ active = 'Tachometer' }: { active?: string }) {
  const { canView } = useAuth();
  const items = NAV_ITEMS.filter((item) => canView(item.pageKey));
  const showAdmin =
    canView('admin_users') || canView('admin_roles') || canView('admin_login_history') || canView('admin_etl');

  return (
    <nav
      aria-label="Primary navigation"
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 40,
        display: 'flex',
        justifyContent: 'center',
        gap: 'var(--ps-space-6, 40px)',
        padding: '10px var(--ps-space-4, 24px)',
        background: 'var(--ps-color-translucent-bg)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        borderTop: '1px solid var(--ps-color-border)',
      }}
    >
      {items.map(({ label, icon: Icon, href }) => {
        const isActive = label === active;
        const content = (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 3,
              padding: '2px 6px 6px',
              borderBottom: isActive ? '2px solid var(--ps-color-gold)' : '2px solid transparent',
              color: isActive ? '#ffffff' : 'var(--ps-color-muted-text)',
              opacity: href ? 1 : 0.55,
            }}
          >
            <Icon size={18} fill={isActive ? 'currentColor' : 'none'} strokeWidth={isActive ? 1.5 : 1.75} />
            <span style={{ fontSize: 10.5, fontWeight: isActive ? 700 : 600, whiteSpace: 'nowrap' }}>{label}</span>
          </div>
        );

        if (href) {
          return (
            <Link key={label} href={href} aria-label={label} style={{ textDecoration: 'none' }}>
              {content}
            </Link>
          );
        }
        return (
          <button
            key={label}
            disabled
            aria-label={label}
            title={`${label} - not built yet`}
            style={{ border: 'none', background: 'none', cursor: 'not-allowed', padding: 0 }}
            className="ps-bottomnav-inactive"
          >
            {content}
          </button>
        );
      })}

      {showAdmin && (
        <Link href={ADMIN_NAV_ITEM.href} aria-label={ADMIN_NAV_ITEM.label} style={{ textDecoration: 'none' }}>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 3,
              padding: '2px 6px 6px',
              borderBottom: active === 'Admin' ? '2px solid var(--ps-color-gold)' : '2px solid transparent',
              color: active === 'Admin' ? '#ffffff' : 'var(--ps-color-muted-text)',
            }}
          >
            <ADMIN_NAV_ITEM.icon size={18} />
            <span style={{ fontSize: 10.5, fontWeight: active === 'Admin' ? 700 : 600 }}>Admin</span>
          </div>
        </Link>
      )}
    </nav>
  );
}
