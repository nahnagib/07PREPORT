'use client';
import React from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Bell, User, LogOut, Sun, Moon, Languages } from 'lucide-react';
import { DateInput } from '@07ps/ui';
import { useBusinessUnit } from './BusinessUnitProvider';
import { useTheme } from './ThemeProvider';
import { BASE_PATH } from '../lib/basePath';
import { useLanguage } from '../lib/i18n/LanguageProvider';

/**
 * Logo asset note: the source BMH files ("BenMussa Black.png" / "BenMussa White.png") are named
 * for their intended background, but their pixel content is swapped relative to that name
 * ("...White.png" actually contains black ink; "...Black.png" actually contains white ink).
 * Re-copied here under content-accurate names (bmh-mark-dark = dark ink for light backgrounds,
 * bmh-mark-light = light ink for dark backgrounds) so this component never has to guess.
 */
const bmhMark = {
  light: `${BASE_PATH}/logos/bmh/bmh-mark-dark.png`,
  dark: `${BASE_PATH}/logos/bmh/bmh-mark-light.png`,
};

const buLogo: Record<string, { light: string; dark: string; alt: string } | null> = {
  all: null,
  majaal: {
    light: `${BASE_PATH}/logos/majaal/majaal-mark-dark.png`,
    dark: `${BASE_PATH}/logos/majaal/majaal-mark-light.png`,
    alt: 'Majaal',
  },
  // Tika mark (assets/brand/Tika/logo Tika-01.png): white on the dark theme, black on the light theme.
  tika: {
    light: `${BASE_PATH}/logos/tika/tika-mark-dark.png`,
    dark: `${BASE_PATH}/logos/tika/tika-mark-light.png`,
    alt: 'Tika',
  },
};

export interface AppHeaderProps {
  pageTitle: string;
  anchorDate: string;
  onAnchorDateChange: (date: string) => void;
  /** Back button (browser history), shown next to the theme toggle. Pass false where there is
   * nothing to go back to (the Dashboard Hub). */
  showBack?: boolean;
  /** Signed-in user's display label (role or full name), shown in the profile chip. */
  roleLabel?: string;
  notificationCount?: number;
  /** Present once a real session exists -- renders a Log out action next to the profile chip. */
  onLogout?: () => void;
  /** Tachometer rebuild (dark-theme pass): hides the inline date selector when a FilterBar below
   * the header already owns the As-Of Date control, so the date isn't editable from two places. */
  showDateInput?: boolean;
  /** Optional min/max clamp on the inline date selector (native <input type="date"> min/max) --
   * additive, undefined preserves the previous no-clamp behavior. Unused while every page passes
   * showDateInput={false} (Critical Number moved its single date field into FilterBar's
   * showSingleDate instead, so all filters -- date included -- live in one place); kept for
   * whichever page next wants the header's own inline date control. */
  dateInputMin?: string;
  dateInputMax?: string;
}

/**
 * Complete UI Redesign pass: modernized replacement for Header.tsx. Same brand-logo lockup and
 * dark-mode toggle as before (Standards Section 3.2, Section 3.12 business-unit logo swap) --
 * what's new is the rest of the "global action cluster," per the redesign brief's explicit "title,
 * date selector, refresh, notifications, export, user profile" spec:
 *   - An inline compact Specific-Date selector, so the anchor date driving every KPI on the page is
 *     visible and changeable from the header itself, not only inside the sidebar
 *   - A Back button (moved here from FilterBar) next to the theme toggle
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
  showBack = true,
  roleLabel,
  notificationCount = 0,
  onLogout,
  showDateInput = true,
  dateInputMin,
  dateInputMax,
}: AppHeaderProps) {
  const { businessUnit } = useBusinessUnit();
  const { theme, toggle } = useTheme();
  const { t, toggle: toggleLanguage } = useLanguage();
  const secondary = buLogo[businessUnit];
  const router = useRouter();

  React.useEffect(() => {
    document.title = pageTitle ? `${pageTitle} | BMH - 7Ps Dashboard` : 'BMH - 7Ps Dashboard';
  }, [pageTitle]);

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
      {/* The logo/title group gives way (title ellipsizes) so it never slides under the controls. */}
      <div className="flex items-center gap-3" style={{ minWidth: 0, flex: '0 1 auto' }}>
        <Image
          src={theme === 'dark' ? bmhMark.dark : bmhMark.light}
          alt="Ben Moussa Holding"
          width={160}
          height={32}
          style={{ objectFit: 'contain', height: 32, width: 'auto', flexShrink: 0 }}
          priority
        />
        {secondary && (
          <>
            <span aria-hidden style={{ color: 'var(--ps-color-border)' }}>
              |
            </span>
            {/* Same fixed height as the BMH mark above, not a smaller one -- both logos in this
                lockup must read as equally important brand marks, not primary+decoration. */}
            <Image
              src={theme === 'dark' ? secondary.dark : secondary.light}
              alt={secondary.alt}
              width={96}
              height={32}
              style={{ objectFit: 'contain', height: 32, width: 'auto', flexShrink: 0 }}
            />
          </>
        )}
        <h1 style={{ fontSize: 20, fontWeight: 700, marginInlineStart: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{pageTitle}</h1>
      </div>

      <div className="flex items-center gap-3" style={{ flex: '1 0 auto', justifyContent: 'flex-end' }}>
        {/* Inline date selector - drives MTD/YTD for every KPI on the page (see SidebarFilters'
            equivalent, more-explained control; this is the same value, just reachable from the
            header too). Hidden when a FilterBar below already owns this control (Tachometer
            rebuild, dark-theme pass) to avoid two editable copies of the same value. */}
        {showDateInput && (
          <div className="hidden md:block" style={{ width: 168 }}>
            <DateInput label="Date" value={anchorDate} onChange={onAnchorDateChange} min={dateInputMin} max={dateInputMax} />
          </div>
        )}

        {showBack && (
          <button
            onClick={() => router.back()}
            aria-label={t('shell.back')}
            title={t('shell.back')}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: '1px solid var(--ps-color-border)',
              borderRadius: 6,
              width: 30,
              height: 30,
              background: 'transparent',
              color: 'var(--ps-color-text)',
              cursor: 'pointer',
            }}
          >
            <ArrowLeft size={16} className="ps-rtl-flip" />
          </button>
        )}

        {/* Platform-level EN/AR switch (lib/i18n/LanguageProvider.tsx); shows the language it switches TO. */}
        <button
          onClick={toggleLanguage}
          aria-label={t('shell.languageAria')}
          title={t('shell.languageAria')}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 5,
            border: '1px solid var(--ps-color-border)',
            borderRadius: 6,
            height: 30,
            padding: '0 8px',
            background: 'transparent',
            color: 'var(--ps-color-text)',
            cursor: 'pointer',
            fontSize: 12.5,
            fontWeight: 700,
            whiteSpace: 'nowrap',
          }}
        >
          <Languages size={15} />
          <span className="hidden sm:inline">{t('shell.language')}</span>
        </button>

        <button
          onClick={toggle}
          aria-label={theme === 'light' ? t('shell.darkMode') : t('shell.lightMode')}
          title={theme === 'light' ? t('shell.darkMode') : t('shell.lightMode')}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '1px solid var(--ps-color-border)',
            borderRadius: 6,
            width: 30,
            height: 30,
            background: 'transparent',
            color: 'var(--ps-color-text)',
            cursor: 'pointer',
          }}
        >
          {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
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

        <span aria-hidden style={{ color: 'var(--ps-color-border)' }}>
          |
        </span>

        {/* Profile chip -- real signed-in user (AuthProvider), not a dev stand-in. */}
        <div
          title={roleLabel ?? t('shell.signedIn')}
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
            {roleLabel ?? t('shell.signedIn')}
          </span>
        </div>

        {onLogout && (
          <button
            onClick={onLogout}
            aria-label={t('shell.logout')}
            title={t('shell.logout')}
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
