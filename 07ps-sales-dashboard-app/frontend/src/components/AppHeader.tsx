'use client';
import React, { useState } from 'react';
import Image from 'next/image';
import { RefreshCw, Download, Bell, User, LogOut } from 'lucide-react';
import { DateInput } from '@07ps/ui';
import { useBusinessUnit } from './BusinessUnitProvider';
import { useTheme } from './ThemeProvider';

/**
 * Logo asset note: the source BMH files ("BenMussa Black.png" / "BenMussa White.png") are named
 * for their intended background, but their pixel content is swapped relative to that name
 * ("...White.png" actually contains black ink; "...Black.png" actually contains white ink).
 * Re-copied here under content-accurate names (bmh-mark-dark = dark ink for light backgrounds,
 * bmh-mark-light = light ink for dark backgrounds) so this component never has to guess.
 */
const bmhMark = {
  light: '/logos/bmh/bmh-mark-dark.png',
  dark: '/logos/bmh/bmh-mark-light.png',
};

const buLogo: Record<string, { light: string; dark: string; alt: string } | null> = {
  all: null,
  majaal: {
    light: '/logos/majaal/majaal-mark-dark.png',
    dark: '/logos/majaal/majaal-mark-light.jpg',
    alt: 'Majaal',
  },
  tika: { light: '/logos/tika/tikalogo.png', dark: '/logos/tika/tikalogo.png', alt: 'Tika' },
};

export interface AppHeaderProps {
  pageTitle: string;
  anchorDate: string;
  onAnchorDateChange: (date: string) => void;
  onRefresh?: () => void;
  /** Formatted "Last Refresh Time" string, shown as the refresh button's tooltip. */
  lastRefreshTime?: string | null;
  /** Signed-in user's display label (role or full name), shown in the profile chip. */
  roleLabel?: string;
  notificationCount?: number;
  onExport?: () => void;
  /** Present once a real session exists -- renders a Log out action next to the profile chip. */
  onLogout?: () => void;
  /** Tachometer rebuild (dark-theme pass): hides the inline date selector when a FilterBar below
   * the header already owns the As-Of Date control, so the date isn't editable from two places. */
  showDateInput?: boolean;
}

/**
 * Complete UI Redesign pass: modernized replacement for Header.tsx. Same brand-logo lockup and
 * dark-mode toggle as before (Standards Section 3.2, Section 3.12 business-unit logo swap) --
 * what's new is the rest of the "global action cluster," per the redesign brief's explicit "title,
 * date selector, refresh, notifications, export, user profile" spec:
 *   - An inline compact Specific-Date selector, so the anchor date driving every KPI on the page is
 *     visible and changeable from the header itself, not only inside the sidebar
 *   - A Refresh button that spins while `onRefresh` is running and shows the last-refresh time as
 *     its tooltip
 *   - A notification bell with an unread-count badge (still a visual affordance -- no notification
 *     backend exists in this build, same honest-stub convention as Header.tsx's Export button)
 *   - A profile chip showing the current dev sign-in role, standing in for a real user identity
 *
 * Header.tsx is left in place, unused, per this session's convention of not deleting superseded
 * components.
 */
export function AppHeader({
  pageTitle,
  anchorDate,
  onAnchorDateChange,
  onRefresh,
  lastRefreshTime,
  roleLabel,
  notificationCount = 0,
  onExport,
  onLogout,
  showDateInput = true,
}: AppHeaderProps) {
  const { businessUnit } = useBusinessUnit();
  const { theme, toggle } = useTheme();
  const secondary = buLogo[businessUnit];
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = () => {
    if (!onRefresh) return;
    setRefreshing(true);
    onRefresh();
    setTimeout(() => setRefreshing(false), 700);
  };

  const initials = (roleLabel ?? 'U')
    .split(' ')
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <header
      className="flex items-center justify-between border-b"
      style={{
        height: 64,
        padding: '0 var(--ps-space-3, 16px)',
        background: 'var(--ps-color-surface)',
        borderColor: 'var(--ps-color-border)',
        position: 'sticky',
        top: 0,
        zIndex: 10,
        gap: 'var(--ps-space-3, 16px)',
      }}
    >
      <div className="flex items-center gap-3" style={{ minWidth: 0, flexShrink: 0 }}>
        <Image
          src={theme === 'dark' ? bmhMark.dark : bmhMark.light}
          alt="Ben Moussa Holding"
          width={120}
          height={28}
          style={{ objectFit: 'contain', height: 28, width: 'auto' }}
          priority
        />
        {secondary && (
          <>
            <span aria-hidden style={{ color: 'var(--ps-color-border)' }}>
              |
            </span>
            <Image
              src={theme === 'dark' ? secondary.dark : secondary.light}
              alt={secondary.alt}
              width={80}
              height={24}
              style={{ objectFit: 'contain', height: 24, width: 'auto' }}
            />
          </>
        )}
        <h1 style={{ fontSize: 20, fontWeight: 700, marginLeft: 12, whiteSpace: 'nowrap' }}>{pageTitle}</h1>
      </div>

      <div className="flex items-center gap-3" style={{ flex: 1, minWidth: 0, justifyContent: 'flex-end' }}>
        {/* Inline date selector - drives MTD/YTD for every KPI on the page (see SidebarFilters'
            equivalent, more-explained control; this is the same value, just reachable from the
            header too). Hidden when a FilterBar below already owns this control (Tachometer
            rebuild, dark-theme pass) to avoid two editable copies of the same value. */}
        {showDateInput && (
          <div className="hidden md:block" style={{ width: 168 }}>
            <DateInput label="Date" value={anchorDate} onChange={onAnchorDateChange} />
          </div>
        )}

        <div className="hidden md:flex items-center gap-2" aria-label="Partner logos" style={{ opacity: 0.7 }}>
          <span style={{ fontSize: 11, color: 'var(--ps-color-muted-text)' }}>ATHENS</span>
          <span style={{ fontSize: 11, color: 'var(--ps-color-muted-text)' }}>SMG</span>
        </div>

        <button
          onClick={toggle}
          aria-label="Toggle dark mode"
          style={{
            border: '1px solid var(--ps-color-border)',
            borderRadius: 6,
            padding: '4px 10px',
            background: 'transparent',
            color: 'var(--ps-color-text)',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          {theme === 'light' ? 'Dark mode' : 'Light mode'}
        </button>

        <button
          onClick={handleRefresh}
          aria-label="Refresh"
          title={lastRefreshTime ? `Last refresh: ${lastRefreshTime}` : 'Refresh'}
          style={{
            display: 'flex',
            background: 'none',
            border: 'none',
            color: 'var(--ps-color-muted-text)',
            cursor: onRefresh ? 'pointer' : 'default',
          }}
        >
          <RefreshCw size={18} style={refreshing ? { animation: 'ps-spin 0.7s linear' } : undefined} />
        </button>

        <button
          aria-label={notificationCount > 0 ? `Notifications (${notificationCount} unread)` : 'Notifications'}
          title="Notifications"
          style={{
            position: 'relative',
            display: 'flex',
            background: 'none',
            border: 'none',
            color: 'var(--ps-color-muted-text)',
            cursor: 'pointer',
          }}
        >
          <Bell size={18} />
          {notificationCount > 0 && (
            <span
              aria-hidden
              style={{
                position: 'absolute',
                top: -3,
                right: -3,
                minWidth: 14,
                height: 14,
                padding: '0 3px',
                borderRadius: 999,
                background: 'var(--ps-color-alert)',
                color: '#ffffff',
                fontSize: 9,
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {notificationCount > 9 ? '9+' : notificationCount}
            </span>
          )}
        </button>

        <button
          onClick={onExport}
          aria-label="Export"
          title="Export (PDF / Excel / CSV)"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 14px',
            borderRadius: 999,
            border: 'none',
            background: 'var(--ps-color-nav-rail-bg)',
            color: '#ffffff',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          <Download size={14} />
          Export
        </button>

        <span aria-hidden style={{ color: 'var(--ps-color-border)' }}>
          |
        </span>

        {/* Profile chip -- real signed-in user (AuthProvider), not a dev stand-in. */}
        <div
          title={roleLabel ? `Signed in as: ${roleLabel}` : 'Signed in'}
          style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}
        >
          <div
            aria-hidden
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 30,
              height: 30,
              borderRadius: '50%',
              background: 'var(--ps-color-accent-bg)',
              color: 'var(--ps-color-accent)',
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            {initials || <User size={15} />}
          </div>
          <span className="hidden lg:inline" style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ps-color-text)' }}>
            {roleLabel ?? 'Signed in'}
          </span>
        </div>

        {onLogout && (
          <button
            onClick={onLogout}
            aria-label="Log out"
            title="Log out"
            style={{
              display: 'flex',
              alignItems: 'center',
              background: 'none',
              border: 'none',
              color: 'var(--ps-color-muted-text)',
              cursor: 'pointer',
            }}
          >
            <LogOut size={17} />
          </button>
        )}
      </div>
    </header>
  );
}
