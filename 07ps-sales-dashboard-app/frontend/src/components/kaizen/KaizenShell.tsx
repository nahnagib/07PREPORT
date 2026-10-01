'use client';
import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, ListChecks, ClipboardList, type LucideIcon } from 'lucide-react';
import { AppHeader } from '../AppHeader';
import { BottomNavBar } from '../BottomNavBar';
import { useAuth } from '../../lib/AuthProvider';
import { kt as t, type KaizenTextKey } from '../../lib/kaizen/text';

export const KAIZEN_BASE = '/process/kaizen-board';

/** Where a click on a chart/tile should take this user: the entry list when they have it,
 * otherwise the read-only card details. */
export function useKaizenListHref() {
  const { canView } = useAuth();
  return canView('kaizen_cards') ? `${KAIZEN_BASE}/manage` : `${KAIZEN_BASE}/cards`;
}

/**
 * Chrome for every Kaizen page: header, a sub-nav between Board / Card details / Manage cards (each
 * shown only with its permission), and the department bottom nav used on phones.
 */
export function KaizenShell({ titleKey, titleVars, actions, children }: {
  titleKey: KaizenTextKey;
  titleVars?: Record<string, string | number>;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { user, logout, canView } = useAuth();
  const pathname = usePathname() ?? '';

  const tabs: { href: string; key: KaizenTextKey; icon: LucideIcon; show: boolean; active: boolean }[] = [
    { href: KAIZEN_BASE, key: 'kaizen.board', icon: LayoutDashboard, show: canView('kaizen_board'), active: pathname === KAIZEN_BASE },
    { href: `${KAIZEN_BASE}/cards`, key: 'kaizen.detailsLink', icon: ListChecks, show: canView('kaizen_board'), active: pathname.startsWith(`${KAIZEN_BASE}/cards`) },
    { href: `${KAIZEN_BASE}/manage`, key: 'kaizen.manageLink', icon: ClipboardList, show: canView('kaizen_cards'), active: pathname.startsWith(`${KAIZEN_BASE}/manage`) },
  ];
  const visible = tabs.filter((tab) => tab.show);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', paddingBottom: 72 }}>
      <AppHeader
        pageTitle={t(titleKey, titleVars)}
        anchorDate=""
        onAnchorDateChange={() => undefined}
        roleLabel={user?.role.label ?? user?.fullName}
        onLogout={logout}
        showDateInput={false}
      />
      <main style={{ flex: 1, padding: 'var(--ps-space-3, 16px)', display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
        {(visible.length > 1 || actions) && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between' }}>
            <nav className="ps-kaizen-subnav" aria-label={t('kaizen.board')}>
              {visible.length > 1 &&
                visible.map(({ href, key, icon: Icon, active }) => (
                  <Link
                    key={href}
                    href={href}
                    aria-current={active ? 'page' : undefined}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '6px 12px',
                      borderRadius: 999,
                      fontSize: 13,
                      fontWeight: 600,
                      textDecoration: 'none',
                      border: '1px solid var(--ps-color-border)',
                      background: active ? 'var(--ps-color-accent)' : 'var(--ps-color-surface)',
                      color: active ? 'var(--ps-color-on-accent)' : 'var(--ps-color-text)',
                    }}
                  >
                    <Icon size={15} />
                    {t(key)}
                  </Link>
                ))}
            </nav>
            {actions && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>{actions}</div>}
          </div>
        )}
        {children}
      </main>
      <BottomNavBar active="Kaizen Board" />
    </div>
  );
}
